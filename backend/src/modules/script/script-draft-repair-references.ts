import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createFrozenPassageRegistry, frozenPassageReplacementFields, frozenPassageVersion, type FrozenPassageCurrent } from './script-frozen-locators.js'
import { documentParagraphs, revisionProblem, type PassageEdit } from './script-revision.js'

export type DraftRepairReferenceSource = { key: string; title?: string; content: string }
export type DraftRepairReferenceIdentity = { candidate_id: string; candidate_version: string; source_version: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Keep the historical schema independent of current draft output changes:
// exact old successes may only replay under their exact old prompt/schema hash.
const legacyEdit = z.object({ source_key: z.string().min(1).max(160), find: z.string().min(1).max(100000),
  ...frozenPassageReplacementFields }).strict()

/** References identify immutable positions, including repeated paragraphs.
 * Legacy mode exists only to reconstruct and revalidate exact old caches. */
export function createDraftRepairReferences(input: readonly DraftRepairReferenceSource[], identity?: DraftRepairReferenceIdentity, options: { legacy?: boolean } = {}) {
  const sources = structuredClone(input)
  if (new Set(sources.map(source => source.key)).size !== sources.length) throw new Error('候选引用来源不能重复')
  const registry = new Map<string, { source_key: string; paragraph_id: string; find: string }>()
  const versions = new Map(sources.map(source => [source.key, frozenPassageVersion(identity, source.key, source.content)]))
  const passages = createFrozenPassageRegistry(sources.map(source => ({ id: source.key, title: source.title,
    version: versions.get(source.key)!, content: source.content, read_ranges: [[0, source.content.length]] })))
  const documents = sources.map(source => {
    let offset = 0
    const parts: Array<string | [string, string]> = []
    for (const paragraph of documentParagraphs(source.content, options.legacy ? hash([source.key, source.content]) : versions.get(source.key)!)) {
      if (paragraph.start > offset) parts.push(source.content.slice(offset, paragraph.start))
      // Only historical find-based references omitted repeated paragraphs.
      const referenceable = !options.legacy || source.content.indexOf(paragraph.text) === source.content.lastIndexOf(paragraph.text)
      const ref_id = referenceable ? `r:${hash([identity, source.key, source.content, paragraph.id]).slice(0, 24)}` : undefined
      if (ref_id) {
        if (registry.has(ref_id)) throw new Error('候选段落引用身份冲突，未发起模型请求')
        registry.set(ref_id, { source_key: source.key, paragraph_id: paragraph.id, find: paragraph.text })
      }
      parts.push(ref_id ? [ref_id, paragraph.text] : paragraph.text)
      offset = paragraph.end
    }
    if (offset < source.content.length) parts.push(source.content.slice(offset))
    return { source_key: source.key, title: source.title, parts }
  })
  const referenced = z.object({ operation: z.literal('replace_ref'), source_key: z.string().min(1).max(160),
    ref_id: z.string().regex(/^r:[a-f0-9]{24}$/), ...frozenPassageReplacementFields }).strict()
  const legacySchema = z.union([referenced, legacyEdit]).transform((edit, context) => {
    if (!('ref_id' in edit)) return edit
    const reference = registry.get(edit.ref_id)
    if (!reference || reference.source_key !== edit.source_key) {
      context.addIssue({ code: 'custom', message: '段落引用不属于当前候选版本及source_key；请仅使用本次冻结引用，不猜测或沿用旧引用' })
      return z.NEVER
    }
    return { source_key: reference.source_key, find: reference.find, replace: edit.replace, reason: edit.reason }
  })
  const paragraphOwners = new Map(passages.documents.flatMap(document => document.blocks.map(block => [block.paragraph_id, document.id] as const)))
  const positioned = z.object({ source_key: z.string().min(1).max(160), paragraph_id: z.string().min(1).max(160), ...frozenPassageReplacementFields }).strict()
  const positionSchema = z.union([referenced, positioned, legacyEdit]).transform((edit, context) => {
    if (!('ref_id' in edit) && !('paragraph_id' in edit)) return edit
    const reference = 'ref_id' in edit ? registry.get(edit.ref_id) : undefined
    const paragraph_id = 'paragraph_id' in edit ? edit.paragraph_id : reference?.paragraph_id
    if (!paragraph_id || 'ref_id' in edit && reference?.source_key !== edit.source_key ||
      paragraphOwners.get(paragraph_id) !== edit.source_key) {
      context.addIssue({ code: 'custom', message: '段落引用不属于当前候选版本及source_key；请仅使用本次冻结引用，不猜测或沿用旧引用' })
      return z.NEVER
    }
    return { source_key: edit.source_key, paragraph_id, replace: edit.replace, reason: edit.reason }
  })
  const editSchema = options.legacy ? legacySchema : positionSchema
  return {
    editSchema,
    documents: structuredClone(documents),
    referenceForParagraph(sourceKey: string, paragraphId: string) { return [...registry.entries()].find(([, value]) => value.source_key === sourceKey && value.paragraph_id === paragraphId)?.[0] },
    locatorVersion(sourceKey: string) { const version = versions.get(sourceKey); if (!version) throw new Error('段落来源不属于当前候选工作集'); return version },
    resolveEdits(sourceKey: string, edits: readonly (PassageEdit & { source_key?: string })[], current?: FrozenPassageCurrent, readRanges?: readonly (readonly [number, number])[]) {
      const source = sources.find(source => source.key === sourceKey)
      if (!source) throw new Error('段落来源不属于当前候选工作集')
      if (edits.some(edit => edit.source_key !== undefined && edit.source_key !== sourceKey)) revisionProblem('source_mismatch', '编辑声明的来源与当前冻结来源不一致', '保持本次段落ID与source_key的原始归属，不跨来源替换。', { document_id: sourceKey })
      return passages.resolve(sourceKey, current || { version: versions.get(sourceKey)!, content: source.content }, edits, readRanges)
    },
    introduction: '\n【当前候选冻结段落引用】\n' +
      '本次候选短目录：' + JSON.stringify(sources.map(source => ({ source_key: source.key, title: source.title, length: source.content.length }))) + '\n' +
      (options.legacy ? '下方parts按原顺序保留全部正文及空白；字符串项是无引用原文，[ref_id,原文]元组是唯一完整原段。拼接字符串或元组第二项可还原全文；ref_id只标识当前source_key中该原段，不代表事实正确。整段修订优先返回operation=replace_ref、source_key、ref_id、replace、reason，不输出find；replace保留该段无关内容。短片段仍可用原find精确替换，不能同时混用ref_id与find。不要猜ref、改引用归属或对照前批修改后正文定位；重复原段没有ref，应使用包含上下文的唯一find。所有操作仍按不可变原文校验唯一定位、禁止重叠，完整通过后才采用整份补丁；不会逐批改正文。\n'
        : '下方parts按原顺序保留全部正文及空白；字符串项是段间空白，[ref_id,原文]元组标识当前来源及版本内这一处完整原段。相同原文在不同位置各有独立ref_id，不得按文字猜位置。' +
          '拼接字符串或元组第二项可还原全文；ref_id绑定来源、版本、实际范围及文本摘要，不代表事实正确。整段修改返回operation=replace_ref、source_key、ref_id、replace、reason，不输出find；replace保留该段无关内容。' +
          '短片段仍可用当前唯一find精确替换，不能同时混用ref_id与find。不要猜ref、改引用归属或对照替换后正文定位；引用不会转为模型复制长原文。' +
          '全部操作同时定位本次不可变原文，后台校验版本、来源、读取权限、范围、文本摘要、Unicode边界及禁止重叠，完整通过后才原子采用；不会逐条改正文。\n'),
    prompt(original: string, placement: 'tail' | 'front' = 'tail') {
      const suffix = `\n可替换来源：${JSON.stringify(sources)}`
      // Strip only the caller's exact code-owned trailing JSON, never prose.
      const base = original.endsWith(suffix) ? original.slice(0, -suffix.length) : original
      const frozen = `\n可替换来源（冻结段落原文）：${JSON.stringify(documents)}`
      return placement === 'front' ? frozen + '\n【完整原任务与资料（含技能和历史，全文保留）】\n' + base : base + frozen
    },
  }
}
