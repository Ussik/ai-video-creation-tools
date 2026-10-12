import { createHash } from 'node:crypto'
import { z } from 'zod'
export type { RevisionTask } from '@video-studio/shared/script/script-revision-types'

export const revisionLimit = 220
export const revisionIds = z.array(z.string().min(1).max(160)).min(1).max(revisionLimit)
  .refine(ids => new Set(ids).size === ids.length, '文档不能重复')
const decision = z.object({ topic: z.string().trim().min(1).max(200), choice: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(2000) }).strict()
const finding = z.object({ category: z.enum(['pending', 'missing', 'contradiction', 'intentional_suspense']),
  quote: z.string().min(1).max(4000), explanation: z.string().trim().min(1).max(3000) }).strict()
export const revisionSchemas = {
  manage_revision_task: z.object({ operation: z.enum(['start', 'read', 'update']), task_id: z.string().optional(), version: z.string().optional(),
    document_ids: revisionIds.optional(), scope: z.enum(['selected', 'all_documents']).default('selected'), summary: z.string().trim().min(1).max(3000).optional(), source_message_index: z.number().int().min(0).max(31).optional(),
    decisions: z.array(decision).max(100).refine(items => new Set(items.map(item => item.topic)).size === items.length, '同一事项的决定应合并').optional(), reference_offset: z.number().int().min(0).default(0), reference_limit: z.number().int().min(1).max(10).default(5),
  }).strict(),
  review_revision_batch: z.object({ task_id: z.string().min(1), version: z.string().min(1),
    documents: z.array(z.object({ document_id: z.string().min(1), version: z.string().min(1), conclusion: z.enum(['resolved', 'unchanged', 'needs_change']),
      explanation: z.string().trim().min(1).max(3000), findings: z.array(finding).max(40).default([]) }).strict()).max(8).default([]),
    references: z.array(z.object({ kind: z.enum(['document', 'scene', 'shot', 'visual_profile']), id: z.string().min(1), version: z.string().min(1),
      conclusion: z.enum(['consistent', 'needs_change']), explanation: z.string().trim().min(1).max(3000) }).strict()).max(10).default([]),
  }).strict().refine(data => data.documents.length + data.references.length > 0, '需要核对文档或关联内容'),
}
export function revisionHash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export type ToolDiagnostic = { code: string; message: string; retryable: boolean; repair: string; document_id?: string; title?: string; item_index?: number; path?: string; limit?: number; actual?: number }
export class ScriptToolProblem extends Error {
  statusCode = 422
  constructor(public diagnostic: ToolDiagnostic) { super(diagnostic.message) }
}
export function revisionProblem(code: string, message: string, repair: string, details: Partial<ToolDiagnostic> = {}): never {
  throw new ScriptToolProblem({ code, message, retryable: true, repair, ...details })
}
export function toolDiagnostic(error: unknown, input?: unknown): ToolDiagnostic {
  if (error instanceof ScriptToolProblem) return error.diagnostic
  if (error instanceof z.ZodError) {
    const issue = error.issues[0], size = issue as typeof issue & { maximum?: number }
    let value = input
    for (const key of issue?.path || []) value = value && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined
    return { code: issue?.code === 'too_big' ? 'limit_exceeded' : 'invalid_arguments', message: issue?.code === 'too_big' ? `提交项数或长度超过限制（最多 ${size.maximum}）` : `函数参数不符合要求：${issue?.message || '格式无效'}`,
      retryable: true, repair: '根据path和limit修正参数；同一文档合并修改，分批提交；不要重复原参数。', path: issue?.path.join('.'), ...(size.maximum !== undefined ? { limit: Number(size.maximum) } : {}), ...(Array.isArray(value) || typeof value === 'string' ? { actual: value.length } : {}) }
  }
  if (error instanceof SyntaxError) return { code: 'invalid_json', message: '函数参数不是有效的 JSON', retryable: true, repair: '修正JSON格式后重新提交。' }
  return { code: 'operation_rejected', message: error instanceof Error ? error.message : String(error), retryable: false, repair: '查看具体原因和当前状态；不要宣称操作成功或重复相同请求。' }
}

/** Anchors bind offsets and exact text to the read version. Never fuzzy-match. */
export function documentParagraphs(content: string, documentVersion: string) {
  const result: Array<{ id: string; start: number; end: number; text: string }> = []
  for (const match of content.matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/g)) {
    const start = match.index, end = start + match[0].length
    result.push({ id: `p:${start}:${end}:${revisionHash([documentVersion, start, end, match[0]]).slice(0, 20)}`, start, end, text: match[0] })
  }
  return result
}
export type PassageEdit = { find?: string; paragraph_id?: string; replace: string; reason: string }
export function resolvePassageEdits(content: string, documentVersion: string, edits: PassageEdit[], ranges: Array<[number, number]>, document: { id: string; title: string }) {
  const paragraphs = documentParagraphs(content, documentVersion)
  return edits.map((edit, item_index) => {
    const details = { document_id: document.id, title: document.title, item_index }
    const anchor = edit.paragraph_id ? paragraphs.find(p => p.id === edit.paragraph_id) : undefined
    if (edit.paragraph_id && !anchor) revisionProblem('anchor_stale', `「${document.title}」的段落定位已失效`, '重新读取该文档当前版本，使用返回的paragraph_id。', details)
    const find = edit.find || anchor?.text
    if (!find) revisionProblem('missing_locator', '需要原文或段落定位', '填写find或paragraph_id。', details)
    const start = anchor ? content.indexOf(find, anchor.start) : content.indexOf(find)
    if (start < 0 || anchor && start + find.length > anchor.end) revisionProblem('passage_not_found', `「${document.title}」找不到修改片段`, '重新read_documents读取原文，逐字复制find或使用paragraph_id；不能使用摘要或改写后的原文。', details)
    const next = content.indexOf(find, start + 1)
    if (next >= 0 && (!anchor || next + find.length <= anchor.end)) revisionProblem('ambiguous_passage', `「${document.title}」原文片段出现多次`, '使用paragraph_id限定段落，并提供段内唯一的原文；不要猜测替换位置。', details)
    if (!ranges.some(([from, to]) => start >= from && start + find.length <= to)) revisionProblem('unread_passage', `「${document.title}」修改片段尚未读取`, 'read_documents读取完整目标段落后重试。', details)
    return { find, replace: edit.replace, reason: edit.reason, start, end: start + find.length }
  })
}
export function applyResolvedEdits(content: string, edits: ReturnType<typeof resolvePassageEdits>) {
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) revisionProblem('overlapping_passages', '修改片段相互重叠', '将重叠修改合并为同一个段落替换后重新提交。')
  let result = content
  for (const edit of sorted.reverse()) result = result.slice(0, edit.start) + edit.replace + result.slice(edit.end)
  if (!result.trim() || result.length > 100000) revisionProblem('invalid_document_length', '修改后的文档不能为空或超过 100000 字', '减少单份文档长度并保留完整正文。')
  return result
}
