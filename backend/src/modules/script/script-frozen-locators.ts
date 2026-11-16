import { createHash } from 'node:crypto'
import { z } from 'zod'
import { documentParagraphs, resolvePassageEdits, revisionProblem, ScriptToolProblem, type PassageEdit } from './script-revision.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const frozenPassageReplacementFields = { replace: z.string().max(100000), reason: z.string().trim().min(1).max(2000) }
export const frozenPassageEditSchema = z.union([
  z.object({ find: z.string().min(1).max(100000), ...frozenPassageReplacementFields }).strict(),
  z.object({ paragraph_id: z.string().min(1).max(160), ...frozenPassageReplacementFields }).strict(),
])
export type FrozenPassageEdit = z.infer<typeof frozenPassageEditSchema>
export type FrozenPassageInput = { id: string; title?: string; version: string; content: string; read_ranges?: readonly (readonly [number, number])[] }
export type FrozenPassageCurrent = { version: string; content: string }
export type FrozenPassageBlock = { paragraph_id: string; start: number; end: number; text_sha256: string; text: string }

/** This exact version formula is shared by worksets and their final adoption. */
export const frozenPassageVersion = (identity: unknown, sourceKey: string, content: string) => hash([identity, sourceKey, content])
const unicodeBoundary = (content: string, offset: number) => offset === 0 || offset === content.length ||
  !(content.charCodeAt(offset - 1) >= 0xd800 && content.charCodeAt(offset - 1) <= 0xdbff && content.charCodeAt(offset) >= 0xdc00 && content.charCodeAt(offset) <= 0xdfff)
const validUnicode = (text: string) => [...text].every(character => character.length !== 1 || character.charCodeAt(0) < 0xd800 || character.charCodeAt(0) > 0xdfff)
const covered = (ranges: readonly (readonly [number, number])[], start: number, end: number) => ranges.some(([from, to]) => start >= from && end <= to)
function checkedRanges(content: string, ranges: readonly (readonly [number, number])[]) {
  if (ranges.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > content.length ||
    !unicodeBoundary(content, start) || !unicodeBoundary(content, end))) throw new Error('冻结读取范围须为有效UTF-16边界内的完整范围')
  return ranges.map(([start, end]) => [start, end] as [number, number])
}

/** A registry owns immutable text and offsets; model-supplied IDs never supply
 * offsets or quotes. Paragraph versions must include their source identity. */
export function createFrozenPassageRegistry(input: readonly FrozenPassageInput[]) {
  const documents = new Map<string, { input: FrozenPassageInput; digest: string; ranges: Array<[number, number]>; blocks: Map<string, FrozenPassageBlock> }>()
  const owners = new Map<string, string>()
  for (const source of structuredClone(input)) {
    if (!source.id || !source.version || documents.has(source.id)) throw new Error('冻结文档必须具有唯一来源及版本')
    if (!validUnicode(source.content)) throw new Error('冻结原文包含无配对Unicode代理字符')
    const ranges = checkedRanges(source.content, source.read_ranges || [])
    const blocks = new Map<string, FrozenPassageBlock>()
    for (const paragraph of documentParagraphs(source.content, source.version)) {
      const owner = owners.get(paragraph.id)
      if (owner !== undefined && owner !== source.id) throw new Error('段落版本未绑定来源；请使用frozenPassageVersion生成来源专属版本')
      owners.set(paragraph.id, source.id)
      blocks.set(paragraph.id, { paragraph_id: paragraph.id, start: paragraph.start, end: paragraph.end, text_sha256: textHash(paragraph.text), text: paragraph.text })
    }
    documents.set(source.id, { input: source, digest: textHash(source.content), ranges, blocks })
  }
  const publicDocuments = [...documents.values()].map(({ input: source, digest, ranges, blocks }) => ({
    id: source.id, title: source.title, version: source.version, text_sha256: digest,
    blocks: [...blocks.values()].filter(block => covered(ranges, block.start, block.end)),
  }))
  return {
    // Public data is detached from the trusted internal ranges and registry.
    documents: structuredClone(publicDocuments),
    resolve(id: string, current: FrozenPassageCurrent, edits: readonly PassageEdit[], readRanges?: readonly (readonly [number, number])[]) {
      const document = documents.get(id)
      if (!document) revisionProblem('document_not_registered', '修改来源未登记在本次冻结工作集中', '仅使用本次读取并登记的来源及段落ID。', { document_id: id })
      const { input: source, blocks, ranges } = document
      if (current.version !== source.version || current.content !== source.content || textHash(current.content) !== document.digest) {
        throw Object.assign(new Error('冻结文档的来源版本或正文已变化，不能采用旧段落定位'), { statusCode: 409, code: 'frozen_document_changed', document_id: id })
      }
      const currentRanges = readRanges === undefined ? ranges : checkedRanges(current.content, readRanges)
      const resolved = edits.map((edit, item_index) => {
        const details = { document_id: id, title: source.title || id, item_index }
        if (edit.paragraph_id !== undefined && edit.find !== undefined) revisionProblem('mixed_locator', '段落ID与find不能同时提交', '每条编辑只使用一个本次段落ID或一段唯一原文。', details)
        if (!validUnicode(edit.replace)) revisionProblem('invalid_unicode_replacement', '替换正文包含无配对Unicode代理字符', '保留完整Unicode字符，不提交单独代理字符。', details)
        let change: ReturnType<typeof resolvePassageEdits>[number]
        if (edit.paragraph_id !== undefined) {
          const block = blocks.get(edit.paragraph_id)
          if (!block) revisionProblem('anchor_stale', '段落ID不属于本次来源及冻结版本', '仅使用本次当前来源返回的paragraph_id，不猜测或沿用旧ID。', details)
          const find = current.content.slice(block.start, block.end)
          if (find !== block.text || textHash(find) !== block.text_sha256) revisionProblem('anchor_stale', '冻结段落范围与文本摘要不一致', '重新读取当前版本；不能自行提交或更改范围。', details)
          change = { start: block.start, end: block.end, find, replace: edit.replace, reason: edit.reason }
        } else {
          // Legacy quotations retain exact uniqueness; no similarity fallback.
          try { change = resolvePassageEdits(current.content, source.version, [edit], [[0, current.content.length]], { id, title: source.title || id })[0]! }
          catch (error) {
            if (error instanceof ScriptToolProblem) throw new ScriptToolProblem({ ...error.diagnostic, ...details,
              ...(error.diagnostic.code === 'invalid_passage_boundary' ? { code: 'invalid_unicode_boundary' } : {}) })
            throw error
          }
        }
        if (!unicodeBoundary(current.content, change.start) || !unicodeBoundary(current.content, change.end)) revisionProblem('invalid_unicode_boundary', '编辑范围切断了Unicode字符', '使用完整段落ID或完整字符边界的唯一原文。', details)
        if (!covered(ranges, change.start, change.end) || !covered(currentRanges, change.start, change.end)) revisionProblem('unread_passage', '编辑段落尚未完整读取', '先读取并登记该来源的完整目标段落，不能扩大已读取范围。', details)
        return change
      })
      const ordered = resolved.map((edit, item_index) => ({ ...edit, item_index })).sort((left, right) => left.start - right.start)
      for (let index = 1; index < ordered.length; index++) if (ordered[index]!.start < ordered[index - 1]!.end) {
        revisionProblem('overlapping_passages', '修改段落范围相互重叠', '将同一段落或交叠片段的修改合并为一条编辑；整批校验通过前不采用任何编辑。', { document_id: id, item_index: ordered[index]!.item_index })
      }
      return resolved
    },
  }
}
