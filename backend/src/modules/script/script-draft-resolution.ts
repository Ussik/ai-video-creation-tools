import { z } from 'zod'
import type { ScriptDraftResolution, ScriptDraftFinding, ScriptDraftRepairRun } from '@video-studio/shared/script/script-draft-resolution'
import { newId, now, one, run } from '../../infrastructure/database/db.js'
import { workflowGenerationDraftSchema, type WorkflowDraft } from './script-workflow.js'
import { draftCompletenessSources } from './script-draft-completeness.js'
import { applyResolvedEdits, resolvePassageEdits } from './script-revision.js'
import type { ScriptSourceDocument, ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import { scriptDocumentVersion } from './script-source-versions.js'
import { consolidateFindings, findingsWithHistory, scriptDraftFindingLimit, type FindingResolutionRecord } from './script-finding-state.js'

export const draftResolutionInput = z.object({ id: z.string().min(1).max(160), version: z.string().min(1).max(160),
  strategy: z.enum(['manual', 'ai', 'continue']), answers: z.array(z.string().trim().max(4000)).max(scriptDraftFindingLimit).optional() }).strict()

export type PendingScriptDraft = {
  id: string; version: string; draft: WorkflowDraft; findings: ScriptDraftFinding[];
  request: Record<string, unknown>; source_version: string;
  source_update?: ScriptSourceUpdate
  resolutions?: FindingResolutionRecord[]
  run?: ScriptDraftRepairRun & { answers: string[] }
}
const active = new Set<string>()
const conflict = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 409 }) }

export function pendingScriptDraft(projectId: string): PendingScriptDraft | null {
  const row = one<{ payload: string }>('SELECT payload FROM script_draft_resolutions WHERE project_id=?', projectId)
  if (!row) return null
  const pending = JSON.parse(row.payload) as PendingScriptDraft
  return { ...pending, findings: consolidateFindings(pending.findings) }
}
export function publicDraftResolution(pending: PendingScriptDraft | null): ScriptDraftResolution | null {
  const { answers: _answers, ...progress } = pending?.run || { answers: [] }
  return pending && { id: pending.id, version: pending.version, stage: pending.draft.stage, episode_number: pending.draft.episode_number,
    findings: findingsWithHistory(pending.findings, pending.resolutions || []).map((finding, index) => ({ ...finding,
      ...(pending.run?.strategy === 'manual' ? { previous_answer: pending.run.answers[index] } : {}) })), document_count: pending.draft.artifacts.length,
    ...(pending.run ? { run: progress as ScriptDraftRepairRun } : {}) }
}

/** Authorization and progress belong to this candidate version. Updating them
 * must not invalidate the exact text checkpoint or modify formal documents. */
export function updateScriptDraftRun(projectId: string, pending: PendingScriptDraft, value: NonNullable<PendingScriptDraft['run']>) {
  const current = pendingScriptDraft(projectId)
  if (!current || current.id !== pending.id || current.version !== pending.version) conflict('待补齐草稿已变化，请重新打开当前版本')
  run('UPDATE script_draft_resolutions SET payload=?, updated_at=? WHERE project_id=?', JSON.stringify({ ...current, run: value }), now(), projectId)
}
export function retainScriptDraft(projectId: string, value: Omit<PendingScriptDraft, 'id' | 'version'>, previous?: PendingScriptDraft) {
  const current = pendingScriptDraft(projectId)
  if (previous ? current?.id !== previous.id || current.version !== previous.version : !!current) conflict('已有待补齐草稿，请继续处理当前版本')
  const pending = { ...value, findings: consolidateFindings(value.findings), id: previous?.id || newId(), version: newId() }
  run(`INSERT INTO script_draft_resolutions (project_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`, projectId, JSON.stringify(pending), now())
  return pending
}
export function clearScriptDraft(projectId: string, id: string, version: string) {
  const current = pendingScriptDraft(projectId)
  if (!current || current.id !== id || current.version !== version) conflict('待补齐草稿已变化，请重新打开当前版本')
  run('DELETE FROM script_draft_resolutions WHERE project_id=?', projectId)
}
export function claimScriptDraft(projectId: string, input: z.infer<typeof draftResolutionInput>, sourceVersion: string) {
  if (active.has(projectId)) conflict('正在补齐当前草稿，请等待本轮完成')
  const pending = pendingScriptDraft(projectId)
  if (!pending || pending.id !== input.id || pending.version !== input.version) return conflict('待补齐草稿已变化，请重新打开当前版本')
  if (pending.source_version !== sourceVersion) conflict('项目资料或原剧本已变化，旧候选稿仍保留；请放弃旧候选稿后重新生成')
  if (input.strategy === 'continue' && (!pending.run || pending.run.answers.length !== pending.findings.length)) conflict('当前草稿尚无可继续的处理方案，请先填写方案或交给 AI 决定')
  if (input.strategy === 'manual' && (input.answers?.length !== pending.findings.length || input.answers.some(answer => !answer.trim()))) {
    throw Object.assign(new Error('请填写每项处理方案，或选择全部交给 AI 决定'), { statusCode: 422 })
  }
  active.add(projectId)
  return { pending, release: () => active.delete(projectId) }
}
export function discardScriptDraft(projectId: string, id: string, version: string) {
  if (active.has(projectId) || one("SELECT id FROM script_director_tasks WHERE project_id=? AND status='running'", projectId)) conflict('正在处理创作任务，请先等待或停止任务')
  clearScriptDraft(projectId, id, version)
}

export const draftRepairOutput = z.object({
  decisions: z.array(z.string().trim().min(1).max(2000)).min(1).max(scriptDraftFindingLimit), summary: z.string().trim().min(1).max(3000),
  source_edits: z.array(z.object({ find: z.string().min(1).max(100000), replace: z.string().max(100000), reason: z.string().trim().min(1).max(2000) }).strict()).max(200),
  edits: z.array(z.object({ source_key: z.string().min(1).max(160), find: z.string().min(1).max(100000),
    replace: z.string().max(100000), reason: z.string().trim().min(1).max(2000) }).strict()).max(200) }).strict()
  .refine(value => value.edits.length > 0 || value.source_edits.length > 0, '至少提交一处候选草稿或文稿修订')

export type DraftPassageChanges = Array<{ source_key: string; changes: ReturnType<typeof resolvePassageEdits> }>

/** Exact replacements retain every byte outside the affected passages. */
export function repairScriptSource(pending: PendingScriptDraft, source: ScriptSourceDocument | null, edits: z.infer<typeof draftRepairOutput>['source_edits']): ScriptSourceUpdate | undefined {
  if (!source) {
    if (edits.length) throw new Error('当前项目没有文稿来源，不能提交文稿修订')
    return undefined
  }
  if (!edits.length) return pending.source_update
  const content = pending.source_update?.content || source.content
  const changes = resolvePassageEdits(content, pending.version, edits, [[0, content.length]], { id: 'script-source', title: '当前有效稿' })
  return applyScriptSourceChanges(pending, source, changes)
}

/** Numbered evidence already binds the exact text and offsets to this snapshot. */
export function applyScriptSourceChanges(pending: PendingScriptDraft, source: ScriptSourceDocument, changes: ReturnType<typeof resolvePassageEdits>): ScriptSourceUpdate | undefined {
  if (!changes.length) return pending.source_update
  const content = pending.source_update?.content || source.content
  if (changes.some(edit => content.slice(edit.start, edit.end) !== edit.find)) throw new Error('文稿修订定位已失效')
  const repaired = applyResolvedEdits(content, changes)
  if (!repaired.trim() || repaired.length > 100000) throw new Error('文稿修订须保留有效正文，且不能超过10万字')
  if ((pending.source_update?.replacements.length || 0) + changes.length > 2000) throw new Error('累计文稿修订超过2000处，请先处理当前草稿')
  return { id: pending.source_update?.id || pending.id, base_version: pending.source_update?.base_version || scriptDocumentVersion(source),
    original_content: pending.source_update?.original_content || source.content, content: repaired,
    replacements: [...(pending.source_update?.replacements || []), ...changes.map(({ find, replace, reason }) => ({ find, replace, reason }))] }
}

/** Exact replacements retain every byte outside the affected passages. */
export function repairScriptDraft(pending: PendingScriptDraft, edits: z.infer<typeof draftRepairOutput>['edits']): WorkflowDraft {
  const sources = draftCompletenessSources(pending.draft)
  return applyScriptDraftChanges(pending.draft, [...new Set(edits.map(edit => edit.source_key))].map(key => {
    const source = sources.find(item => item.key === key)
    if (!source) throw new Error('补齐位置不属于当前候选草稿')
    const changes = resolvePassageEdits(source.content, pending.version, edits.filter(edit => edit.source_key === key), [[0, source.content.length]], { id: key, title: key })
    return { source_key: key, changes }
  }))
}

export function applyScriptDraftChanges(input: WorkflowDraft, edits: DraftPassageChanges): WorkflowDraft {
  const draft = structuredClone(input), sources = draftCompletenessSources(draft)
  for (const { source_key: key, changes } of edits) {
    const source = sources.find(item => item.key === key)
    if (!source) throw new Error('补齐位置不属于当前候选草稿')
    if (changes.some(edit => source.content.slice(edit.start, edit.end) !== edit.find)) throw new Error('候选稿修订定位已失效')
    const content = applyResolvedEdits(source.content, changes)
    if (key.startsWith('scene:')) {
      const [, index, field] = key.split(':')
      const scene = draft.scenes[Number(index)]!
      Object.assign(scene, { [field!]: content })
    } else draft.artifacts.find(item => item.artifact_type === key)!.content = content
  }
  return workflowGenerationDraftSchema.parse(draft)
}
