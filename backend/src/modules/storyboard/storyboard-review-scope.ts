import { createHash } from 'node:crypto'
import { z } from 'zod'

export const storyboardRepairFields = ['prompt', 'start_state', 'end_state', 'cut_note', 'image_prompt', 'video_prompt', 'duration',
  'directing.purpose', 'directing.camera', 'directing.cut', 'scene_direction.anchors', 'scene_direction.blocking',
  'scene_direction.axis', 'scene_direction.dramatic_progression'] as const
export const storyboardEvidenceReferenceSchema = z.object({
  scene_id: z.string().min(1).max(120), shot_index: z.number().int().min(0).max(29).nullable(),
  field: z.enum(storyboardRepairFields), ref_id: z.string().regex(/^evidence_[a-f0-9]{16}$/).optional(), quote: z.string().trim().min(1).max(2000).optional(),
}).strict()
export const storyboardRepairScopeSchema = z.object({
  scene_id: z.string().min(1).max(120), shot_index: z.number().int().min(0).max(29).nullable(),
  operation: z.literal('replace'), fields: z.array(z.enum(storyboardRepairFields)).min(1).max(12),
}).strict()
type Evidence = z.infer<typeof storyboardEvidenceReferenceSchema>
type Scope = z.infer<typeof storyboardRepairScopeSchema>
export type ScopedReviewIssue = { code: string; scene_id: string; shot_index: number; related_scene_id: string | null;
  related_shot_index: number | null; timing_change?: boolean; severity: string; message: string; evidence: string; repair: string; evidence_refs?: Evidence[]; repair_scope?: Scope[] }
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

export type StoryboardEvidenceCatalogEntry = Evidence & { ref_id: string; quote: string }
export type StoryboardEvidenceReferenceDiagnostic = Pick<Evidence, 'scene_id' | 'shot_index' | 'field'> & { ref_id?: string; field_path?: string }
export type StoryboardEvidenceIssueDiagnostic = {
  issue_index: number; issue_path: string; code: string; attempted_refs: StoryboardEvidenceReferenceDiagnostic[]
  rejected_refs: StoryboardEvidenceReferenceDiagnostic[]; allowed_refs: StoryboardEvidenceReferenceDiagnostic[]
  rejected_reason: 'reference_outside_issue_scope'
}

/** Stable, application-owned references for the current outline fields. */
export function storyboardEvidenceCatalog(scenes: ReviewSequence): StoryboardEvidenceCatalogEntry[] {
  const entries: StoryboardEvidenceCatalogEntry[] = []
  const add = (scene_id: string, shot_index: number | null, field: Evidence['field'], value: unknown) => {
    for (const quote of texts(value).filter(value => value.trim()).slice(0, 8)) {
      const ref_id = `evidence_${storyboardValueSignature({ scene_id, shot_index, field, quote }).slice(0, 16)}`
      entries.push({ ref_id, scene_id, shot_index, field, quote })
    }
  }
  for (const scene of scenes) {
    for (const field of storyboardRepairFields.filter(field => field.startsWith('scene_direction.'))) add(scene.scene_id, null, field, storyboardField(scene.scene_direction, field.replace(/^scene_direction\./, '')))
    for (const [shot_index, shot] of scene.shots.entries()) for (const field of storyboardRepairFields.filter(field => !field.startsWith('scene_direction.'))) add(scene.scene_id, shot_index, field, storyboardField(shot, field))
  }
  return entries
}

/** Enumerate the exact evidence locations an issue may cite, without quotes. */
export function storyboardEvidenceScopeDiagnostics(issues: ScopedReviewIssue[], scenes: ReviewSequence): StoryboardEvidenceIssueDiagnostic[] {
  const ordered = scenes.flatMap(scene => scene.shots.map((_shot, shot_index) => `${scene.scene_id}:${shot_index}`))
  const catalog = storyboardEvidenceCatalog(scenes)
  const descriptor = ({ scene_id, shot_index, field, ref_id }: Evidence): StoryboardEvidenceReferenceDiagnostic => ({ scene_id, shot_index, field, ...(ref_id ? { ref_id } : {}) })
  return issues.flatMap((issue, issue_index) => {
    const current = ordered.indexOf(`${issue.scene_id}:${issue.shot_index}`)
    const related = issue.related_scene_id !== null && issue.related_shot_index !== null
      ? ordered.indexOf(`${issue.related_scene_id}:${issue.related_shot_index}`) : -1
    const hasAdjacentRelated = current >= 0 && related >= 0 && Math.abs(current - related) === 1
    const locations = new Set([`${issue.scene_id}:${issue.shot_index}`,
      ...(hasAdjacentRelated ? [`${issue.related_scene_id}:${issue.related_shot_index}`] : [])])
    const sceneIds = new Set([issue.scene_id, ...(hasAdjacentRelated ? [issue.related_scene_id!] : [])])
    const allowed = (reference: Pick<Evidence, 'scene_id' | 'shot_index' | 'field'>) => reference.shot_index === null
      ? reference.field.startsWith('scene_direction.') && sceneIds.has(reference.scene_id)
      : locations.has(`${reference.scene_id}:${reference.shot_index}`)
    const attempted = issue.evidence_refs || []
    const rejected = attempted.flatMap((reference, index) => !allowed(reference) ? [{ ...descriptor(reference), field_path: `issues[${issue_index}].evidence_refs[${index}]` }] : [])
    if (!rejected.length) return []
    return [{ issue_index, issue_path: `issues[${issue_index}]`, code: issue.code, attempted_refs: attempted.slice(0, 24).map(descriptor), rejected_refs: rejected.slice(0, 24),
      allowed_refs: catalog.filter(allowed).slice(0, 64).map(descriptor), rejected_reason: 'reference_outside_issue_scope' as const }]
  })
}

/** Resolve model references to canonical source text before business validation. */
export function normalizeStoryboardEvidenceReferences(report: ScopedReviewIssue & { evidence_refs?: Evidence[] }, scenes: ReviewSequence, strict = false): ScopedReviewIssue & { evidence_refs?: Evidence[] } {
  const catalog = storyboardEvidenceCatalog(scenes)
  const byId = new Map(catalog.map(entry => [entry.ref_id, entry]))
  const refs = report.evidence_refs || []
  if (strict && report.severity === 'error' && !refs.length) problem('已核实错误必须提供程序生成的证据引用 ID和替换范围；请重新独立复查当前草稿')
  const normalized = refs.map(reference => {
    const entry = reference.ref_id ? byId.get(reference.ref_id) : catalog.find(item => item.scene_id === reference.scene_id && item.shot_index === reference.shot_index && item.field === reference.field && !!reference.quote && item.quote.includes(reference.quote))
    if (!entry) return problem(reference.ref_id ? '复核证据引用 ID 无效或已不属于当前字段' : '复核证据缺少有效引用 ID，且文本不是当前字段原文')
    if (entry.scene_id !== reference.scene_id || entry.shot_index !== reference.shot_index || entry.field !== reference.field) problem('复核证据引用 ID 与字段路径不一致')
    return { ...reference, ref_id: entry.ref_id, quote: entry.quote }
  })
  return { ...report, ...(normalized.length ? { evidence_refs: normalized, evidence: normalized.map(reference => reference.quote).join('；') } : {}) }
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
    const quote = reference.quote
    if (!quote || !texts(value).some(value => value.includes(quote))) problem('复核证据不是所引用字段中的原文，不能授权修复')
  }
  for (const scope of issue.repair_scope || []) {
    if (!allowed(scope.scene_id, scope.shot_index)) problem('修复范围超出了有证据的问题及其直接关联镜头')
    if (scope.fields.some(field => field.startsWith('scene_direction.') !== (scope.shot_index === null))) problem('场面调度与镜头字段的修复范围不一致')
    const uncovered = scope.fields.filter(field => !issue.evidence_refs?.some(reference => reference.scene_id === scope.scene_id && reference.shot_index === scope.shot_index && reference.field === field))
    if (uncovered.length) problem(`repair_scope中scene_id=${scope.scene_id},shot_index=${scope.shot_index}的字段${uncovered.join('、')}缺少同位置evidence_refs；请逐个补充该field当前原文quote，或从repair_scope移除没有证据的字段，不能改用其他字段或来源的引用。`)
  }
  if (strict && issue.severity === 'error' && !issue.evidence_refs?.length) {
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
