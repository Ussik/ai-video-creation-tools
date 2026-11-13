import { createHash } from 'node:crypto'
import { z } from 'zod'

export const storyboardRepairFields = ['prompt', 'start_state', 'end_state', 'cut_note', 'image_prompt', 'video_prompt', 'duration',
  'directing.purpose', 'directing.camera', 'directing.cut', 'scene_direction.anchors', 'scene_direction.blocking',
  'scene_direction.axis', 'scene_direction.dramatic_progression'] as const
export const storyboardEvidenceReferenceSchema = z.object({
  scene_id: z.string().min(1).max(120), shot_index: z.number().int().min(0).max(29).nullable(),
  field: z.enum(storyboardRepairFields), quote: z.string().trim().min(1).max(2000),
}).strict()
export const storyboardRepairScopeSchema = z.object({
  scene_id: z.string().min(1).max(120), shot_index: z.number().int().min(0).max(29).nullable(),
  operation: z.literal('replace'), fields: z.array(z.enum(storyboardRepairFields)).min(1).max(12),
}).strict()
type Evidence = z.infer<typeof storyboardEvidenceReferenceSchema>
type Scope = z.infer<typeof storyboardRepairScopeSchema>
export type ScopedReviewIssue = { code: string; scene_id: string; shot_index: number; related_scene_id: string | null;
  related_shot_index: number | null; severity: string; evidence: string; repair: string; evidence_refs?: Evidence[]; repair_scope?: Scope[] }
export type ReviewSequence = Array<{ scene_id: string; scene_direction?: unknown; shots: Array<Record<string, unknown>> }>
const problem = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 422, code: 'storyboard_review_invalid' }) }
export const storyboardValueSignature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function storyboardField(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object'
    && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value)
}
function texts(value: unknown): string[] {
  return typeof value === 'string' || typeof value === 'number' ? [String(value)] : value && typeof value === 'object' ? Object.values(value).flatMap(texts) : []
}
/** Evidence locates existing content; it never grants free paths or deletion. */
export function validateStoryboardRepairEvidence(issue: ScopedReviewIssue, scenes: ReviewSequence, sourceTexts: string[] = [], strict = false) {
  const deleteField = /(?:删除|移除|去掉|清空|delete|remove|omit)\s*(?:整个|全部|the\s+)?(?:必填字段|字段|(?:required\s+)?field|(?:directing(?:\.[a-z_]+)?|camera|cut\.carry_over|start_state|end_state|cut_note|audio_plan|scene_direction|image_prompt|video_prompt)(?=\s*(?:字段|[、，,。；;\s]|与|和|即可|$)))/gi
  for (const match of issue.repair.matchAll(deleteField)) {
    const before = issue.repair.slice(0, match.index)
    if (!/(?:不要|不能|不得|禁止|勿|do not|never)[^，。；;\n]{0,12}$/i.test(before)) problem('复核建议不能删除或清空契约必填字段；请给出保留字段的有效替换方案')
  }
  if (strict && issue.severity === 'error' && (!issue.evidence_refs?.length || !issue.repair_scope?.length)) problem('已核实错误必须提供精确字段原文证据和替换范围；请重新独立复查当前草稿')
  const allowed = (sceneId: string, index: number | null) => sceneId === issue.scene_id && (index === null || index === issue.shot_index)
    || sceneId === issue.related_scene_id && (index === null || index === issue.related_shot_index)
  for (const reference of issue.evidence_refs || []) {
    if (!allowed(reference.scene_id, reference.shot_index)) problem('复核证据只能引用问题镜头、直接关联镜头或其场面调度')
    const scene = scenes.find(scene => scene.scene_id === reference.scene_id)
    const root = reference.shot_index === null ? scene : scene?.shots[reference.shot_index]
    const value = storyboardField(root, reference.field)
    if (!texts(value).some(value => value.includes(reference.quote))) problem('复核证据不是所引用字段中的原文，不能授权修复')
  }
  for (const scope of issue.repair_scope || []) {
    if (!allowed(scope.scene_id, scope.shot_index)) problem('修复范围超出了有证据的问题及其直接关联镜头')
    if (scope.fields.some(field => field.startsWith('scene_direction.') !== (scope.shot_index === null))) problem('场面调度与镜头字段的修复范围不一致')
    if (!scope.fields.every(field => issue.evidence_refs?.some(reference => reference.scene_id === scope.scene_id && reference.shot_index === scope.shot_index && reference.field === field))) problem('每个修复字段必须有同位置的原文证据')
  }
  if (strict && !issue.evidence_refs?.length) {
    const relevant = scenes.flatMap(scene => scene.shots.flatMap((shot, index) => allowed(scene.scene_id, index) ? texts(shot) : []))
    const quotes = issue.evidence.split(/[；;。\n]/).map(value => value.replace(/^(?:前镜|后镜|本镜|来源)[:：]/, '').trim()).filter(Boolean)
    if (!quotes.length || !quotes.every(quote => [...relevant, ...sourceTexts].some(text => text.includes(quote)))) problem('复核缺少可核实的当前镜头或来源原文证据，不能授权修复')
  }
}
export function storyboardIssueFingerprint(issues: ScopedReviewIssue[]) {
  return storyboardValueSignature(issues.filter(issue => issue.severity === 'error').map(issue => ({ code: issue.code,
    scene_id: issue.scene_id, shot_index: issue.shot_index, related_scene_id: issue.related_scene_id,
    related_shot_index: issue.related_shot_index, scope: (issue.repair_scope || []).map(scope => ({ ...scope, fields: [...scope.fields].sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}

export function storyboardRepairEffect(before: ScopedReviewIssue[], after: ScopedReviewIssue[]): 'improved' | 'unchanged' | 'regressed' {
  if (storyboardIssueFingerprint(before) === storyboardIssueFingerprint(after)) return 'unchanged'
  const count = (issues: ScopedReviewIssue[]) => issues.filter(issue => issue.severity === 'error').length
  return count(after) < count(before) ? 'improved' : count(after) > count(before) ? 'regressed' : 'unchanged'
}
