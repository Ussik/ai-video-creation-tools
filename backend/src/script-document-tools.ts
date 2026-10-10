import { createHash } from 'node:crypto'
import { z } from 'zod'
import { all, one, run, db, newId, now, type Project, type ScriptArtifact, type ScriptScene, type Shot } from './db.js'
import { workflowDraftInput, workflowDraftSchema, workflowScene, workflowProgress, directorStageContext, type DirectorStageContext, type WorkflowDraft, type WorkflowStage } from './script-workflow.js'
import { replyClassification, replyClassificationVersion, inputFields, interactionQuestions } from './script-reply-classification.js'
import { scriptSettingsSchema, visualStyleDetailsSchema, mergeConfirmedScriptSettings } from './script-intent.js'
import { assertStyleVersion, projectVisualStyle } from './project-visual-style.js'
import { textToolSession, type TextTool, type ToolOutput } from './text-tools.js'
import type { GenerationModel, GenerationProvider } from './providers.js'
import { activityRecorder, activityPreview } from './script-activity.js'
import type { CreationNextStep, ScriptCreationState } from './script-creation-state-types.js'
import { restoreOptionalNulls } from './model-output.js'
import { documentHealth, documentReviewInput, saveDocumentReview, projectReferences, documentDraftImpacts } from './script-document-review.js'
import type { DocumentReview, DraftImpact } from './script-review-types.js'
import { resourceTools, resourceSchemas, resourceDescriptions, resourceValueEdit, editResourceValues, validateResourceChanges, applyResourceChanges, resourceDraftImpacts } from './script-resource-tools.js'
import type { ResourceChange } from './script-resource-types.js'
import { skillContext, skillStages, type SkillStage } from './skills.js'
import { revisionSchemas, revisionLimit, revisionHash, revisionProblem, toolDiagnostic, documentParagraphs, resolvePassageEdits, applyResolvedEdits, type RevisionTask, type ToolDiagnostic } from './script-revision.js'

const ids = z.array(z.string().min(1).max(160)).min(1).max(8).refine(items => new Set(items).size === items.length, '文档不能重复')
export const documentAction = z.object({ operation: z.enum(['review', 'revise']), document_ids: ids }).strict()
const replacement = z.object({ find: z.string().min(1).max(100_000).optional(), paragraph_id: z.string().min(1).max(160).optional(), replace: z.string().max(100_000), reason: z.string().trim().min(1).max(2000) }).strict().refine(edit => !!edit.find || !!edit.paragraph_id, '需要find或paragraph_id')
// Partial workflowScene keeps field defaults in Zod 4, which would clear
// omitted scene fields. Patch fields intentionally have no defaults.
const sceneUpdates = z.object({
  heading: z.string().trim().min(1).max(120).optional(), location: z.string().max(500).optional(), time_of_day: z.string().max(120).optional(),
  characters: z.string().max(2000).optional(), action: z.string().max(10000).optional(), dialogue: z.string().max(10000).optional(), narration: z.string().max(10000).optional(), duration: z.number().int().min(1).max(30).optional(),
}).strict().refine(value => Object.keys(value).length > 0, '需要修改字段')
const sceneChange = z.object({ scene_id: z.string().min(1), base_version: z.string().min(1), changes: sceneUpdates }).strict()
const patchSchema = z.object({ summary: z.string().trim().min(1).max(3000), task_id: z.string().optional(), draft_version: z.string().optional(), changes: z.array(z.object({ document_id: z.string().min(1), base_version: z.string().min(1), rebase: z.boolean().optional(), replacements: z.array(replacement).min(1).max(40) }).strict()).min(1).max(revisionLimit), scene_changes: z.array(sceneChange).max(100).default([]) }).strict()
const creatorQuestion = { status: z.literal('pending'), question: z.string().trim().min(1).max(1000) }
const creatorRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('confirmation_request'), ...creatorQuestion }).strict(),
  z.object({ type: z.literal('input_request'), ...creatorQuestion, fields: inputFields }).strict(),
  z.object({ type: z.literal('question_set'), ...creatorQuestion, questions: interactionQuestions }).strict(),
  z.object({ type: z.literal('choice_request'), ...creatorQuestion, options: z.array(z.object({ id: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(2000), requires_details: z.boolean().optional() }).strict()).min(2).max(8).refine(options => new Set(options.map(option => option.id)).size === options.length, '选项 ID 不可重复') }).strict(),
])
type Replacement = { find: string; replace: string; reason: string }
export type ToolDocument = { id: string; artifact_type: ScriptArtifact['artifact_type']; episode_number: number; title: string; content: string; version: string; status: string }
export type ToolDraftDocument = Omit<ToolDocument, 'status'> & { original_content: string; replacements: Replacement[] }
export type ScriptToolDraft = {
  id: string; version: string; kind: 'create' | 'patch' | 'resource'; summary: string; documents: ToolDraftDocument[];
  workflow?: WorkflowDraft; scene_version?: string; status: 'pending' | 'saved' | 'discarded'
  scene_changes?: Array<{ id: string; version: string; episode_number: number; original: z.infer<typeof workflowScene>; scene: z.infer<typeof workflowScene> }>
  impacts?: DraftImpact[]
  resource_changes?: ResourceChange[]
  revision_task?: RevisionTask
}
type DraftRow = { id: string; project_id: string; version: string; status: ScriptToolDraft['status']; payload: string }
type Decision = { id: string; topic: string; content: string; basis: string; source_text: string; updated_at: string }
export type ScriptSnapshot = { outline: string; characters: string; artifacts?: ScriptArtifact[]; scenes: ScriptScene[]; generation_options: Record<string, unknown> }
type ToolsContext = {
  skillRules?: Partial<Record<SkillStage, ReturnType<typeof skillContext>>>;
  project: Project; script: () => ScriptSnapshot; stage: DirectorStageContext;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>; workflow?: WorkflowDraft['stage'];
  action?: z.infer<typeof documentAction>; discussionOnly?: boolean; legacyPending?: boolean;
  currentSettings?: z.infer<typeof scriptSettingsSchema>;
  authorizeCreation?: (draft: WorkflowDraft, explicitStage: boolean) => Promise<boolean>;
  authorizeResource?: (summary: string, changes: ResourceChange[]) => Promise<boolean>;
  checkApproval: (draft: ScriptToolDraft) => Promise<boolean>;
  onEvent: (event: Record<string, unknown>) => void; signal?: AbortSignal
}
function problem(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
function version(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function projectDocuments(projectId: string, script: ScriptSnapshot): ToolDocument[] {
  const documents = (script.artifacts || []).map(item => ({ id: item.id, artifact_type: item.artifact_type,
    episode_number: item.episode_number || 0, title: item.title, content: item.content,
    version: version([item.id, item.title, item.content, item.updated_at]), status: item.status }))
  for (const type of ['outline', 'characters'] as const) if (script[type].trim() && !documents.some(item => item.artifact_type === type && !item.episode_number)) {
    documents.unshift({ id: `legacy:${type}`, artifact_type: type, episode_number: 0, title: type === 'outline' ? '故事大纲' : '人物设定', content: script[type], version: version([projectId, type, script[type]]), status: 'ready' })
  }
  return documents
}
export function getToolDraft(projectId: string, id?: string): ScriptToolDraft | null {
  const row = id ? one<DraftRow>('SELECT * FROM script_tool_drafts WHERE id=? AND project_id=?', id, projectId)
    : one<DraftRow>("SELECT * FROM script_tool_drafts WHERE project_id=? AND status='pending'", projectId)
  if (!row) return null
  const draft = { ...JSON.parse(row.payload), id: row.id, version: row.version, status: row.status } as ScriptToolDraft
  if (draft.status === 'pending' && draft.revision_task) {
    refreshRevisionTask(projectId, draft, savedToolDocuments(projectId))
  }
  return draft
}
function savedToolDocuments(projectId: string) {
  const saved = one<{ outline: string; characters: string }>('SELECT outline, characters FROM scripts WHERE project_id=?', projectId)
  return projectDocuments(projectId, { outline: saved?.outline || '', characters: saved?.characters || '', generation_options: {}, scenes: [], artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', projectId) })
}
export function storyDecisions(projectId: string) { return all<Decision>('SELECT id, topic, content, basis, source_text, updated_at FROM script_story_decisions WHERE project_id=? ORDER BY updated_at', projectId) }
export function clearCreationProposal(projectId: string) { run('DELETE FROM script_workflow_proposals WHERE project_id=?', projectId) }

export function creationState(projectId: string, script: ScriptSnapshot): ScriptCreationState {
  const progress = workflowProgress(script), pending = getToolDraft(projectId)
  const stage_context = directorStageContext(script, pending?.documents[0] ? { pending: documentStage(pending.documents[0]) } : {})
  const stateVersion = version([projectDocuments(projectId, script).map(doc => [doc.id, doc.version, doc.status]), script.scenes,
    script.generation_options, storyDecisions(projectId), pending?.version || null,
    one<{ brief: string; ratio: string }>('SELECT brief, ratio FROM projects WHERE id=?', projectId)])
  const row = one<{ state_version: string; payload: string }>('SELECT state_version, payload FROM script_workflow_proposals WHERE project_id=?', projectId)
  const proposed = row?.state_version === stateVersion ? JSON.parse(row.payload) as CreationNextStep : null
  const next = !pending && (proposed || (progress.next_stage && progress.next_stage !== 'outline' ? {
    id: stateVersion, stage: progress.next_stage, episode_number: progress.next_stage === 'episode' ? progress.next_episode! : 0,
    purpose: 'generate' as const, summary: '上一阶段成果已保存，可以继续下一阶段。', basis: '', document_ids: [], source: 'progress' as const,
  } : null))
  return { version: stateVersion, stage_context, saved_episodes: progress.episodes, next_step: next || null,
    status: pending ? 'review' : next ? 'ready' : progress.next_stage ? 'direction' : 'complete' }
}

export function acceptCreationStep(projectId: string, script: ScriptSnapshot, id: string) {
  const next = creationState(projectId, script).next_step
  if (!next || next.id !== id) problem('创作进度或设定已变化，请查看当前步骤后重新操作', 409)
  return next
}
export function replacePassages(content: string, edits: Replacement[]) {
  const ranges = edits.map(edit => {
    const start = content.indexOf(edit.find)
    if (!edit.find || start < 0) problem('找不到修改片段，请重新读取原文')
    if (content.indexOf(edit.find, start + 1) >= 0) problem('原文片段出现多次，请包含更多上下文定位')
    return { start, end: start + edit.find.length, text: edit.replace }
  }).sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) problem('修改片段相互重叠，请合并')
  let output = content
  for (const range of ranges.reverse()) output = output.slice(0, range.start) + range.text + output.slice(range.end)
  if (!output.trim() || output.length > 100_000) problem('修改后的文档不能为空或超过 100000 字')
  return output
}
function effectiveScene(draft: ScriptToolDraft, scene: ScriptScene) {
  return { ...scene, ...draft.scene_changes?.find(change => change.id === scene.id)?.scene }
}
function revisionDocument(draft: ScriptToolDraft, source: ToolDocument) {
  const proposed = draft.documents.find(doc => doc.id === source.id)
  const content = proposed?.content ?? source.content
  return { ...source, content, source_version: source.version,
    version: version([draft.id, source.id, source.version, content, revisionSnapshot(draft)]) }
}
function revisionSnapshot(draft: ScriptToolDraft) { return version([draft.documents.map(doc => [doc.id, doc.content]), draft.scene_changes || [], draft.revision_task?.decisions || [], draft.revision_task?.documents.map(doc => [doc.id, doc.source_version]) || [], draft.revision_task?.context_version || '']) }
function revisionContext(projectId: string) {
  const settings = one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', projectId)
  return { project: one<{ brief: string; ratio: string }>('SELECT brief, ratio FROM projects WHERE id=?', projectId), saved_settings: JSON.parse(settings?.generation_options || '{}'), decisions: storyDecisions(projectId), project_visual_style: projectVisualStyle(projectId) }
}
function revisionReference(projectId: string, draft: ScriptToolDraft, documents: ToolDocument[], ref: { kind: string; id: string }) {
  let value: unknown
  if (ref.kind === 'document') value = documents.find(doc => doc.id === ref.id)
  if (ref.kind === 'scene') {
    const scene = one<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? AND id=?', projectId, ref.id)
    value = scene && effectiveScene(draft, scene)
  }
  if (ref.kind === 'shot') value = one<Shot>('SELECT * FROM shots WHERE project_id=? AND id=?', projectId, ref.id)
  if (ref.kind === 'visual_profile') value = one<Record<string, unknown>>('SELECT * FROM visual_profiles WHERE project_id=? AND id=?', projectId, ref.id)
  return value ? { kind: ref.kind, id: ref.id, title: draft.revision_task?.references.find(item => item.kind === ref.kind && item.id === ref.id)?.title || ref.id, version: version(value), content: JSON.stringify(value) } : null
}
function refreshRevisionTask(projectId: string, draft: ScriptToolDraft, documents: ToolDocument[]) {
  const task = draft.revision_task
  if (!task) return
  task.context_version = version(revisionContext(projectId))
  for (const item of task.documents) {
    const source = documents.find(doc => doc.id === item.id), proposed = draft.documents.find(doc => doc.id === item.id)
    if (!source || source.version !== item.source_version) { item.status = 'blocked'; item.note = '正式原文已变化，请重新读取并整理修订；不会覆盖新版本'; continue }
    if (draft.scene_changes?.some(change => change.episode_number === source.episode_number && version(one<ScriptScene>('SELECT * FROM script_scenes WHERE id=? AND project_id=?', change.id, projectId)) !== change.version)) { item.status = 'blocked'; item.note = '正式分场已变化，请重新读取正文与分场后整理'; continue }
    const assessment = item.assessment
    if (assessment?.version === revisionDocument(draft, source).version) {
      item.status = assessment.conclusion === 'needs_change' || assessment.findings.some(finding => finding.category !== 'intentional_suspense') ? 'blocked' : assessment.conclusion === 'unchanged' ? 'unchanged' : 'verified'
      item.note = assessment.explanation
    } else { item.status = proposed ? 'revised' : 'pending'; item.note = assessment ? '内容或统一设定已变化，需重新核对' : undefined }
  }
  const impacts = documentDraftImpacts(projectId, documents, draft.documents, draft.scene_changes?.map(scene => scene.id) || [], Number.MAX_SAFE_INTEGER)
  draft.impacts = impacts
  const snapshot = revisionSnapshot(draft)
  const previous = new Map(task.references.map(ref => [`${ref.kind}:${ref.id}`, ref]))
  task.references = impacts.filter(ref => ref.kind !== 'document' || !task.documents.some(doc => doc.id === ref.id)).map(ref => {
    const old = previous.get(`${ref.kind}:${ref.id}`), current = revisionReference(projectId, draft, documents, ref), review = old?.review
    const valid = review?.draft_snapshot === snapshot && review.version === current?.version
    return { kind: ref.kind, id: ref.id, title: ref.title, status: valid ? review!.conclusion === 'consistent' ? 'verified' : 'blocked' : 'pending', note: valid ? review!.explanation : undefined, ...(review ? { review } : {}) }
  })
  task.status = task.documents.some(doc => doc.status === 'blocked') || task.references.some(ref => ref.status === 'blocked') ? 'needs_attention'
    : task.documents.every(doc => ['verified', 'unchanged'].includes(doc.status)) && task.references.every(ref => ref.status === 'verified') ? 'ready' : 'in_progress'
}
function revisionSummary(draft: ScriptToolDraft) {
  const task = draft.revision_task!
  const complete = task.documents.filter(doc => ['verified', 'unchanged'].includes(doc.status)).length
  const pendingRefs = task.references.filter(ref => ref.status !== 'verified').length
  return `已核对 ${complete}/${task.documents.length} 份文档，${draft.documents.length} 份修订已累积到草稿${pendingRefs ? `，${pendingRefs} 项关联内容待核对` : ''}。${task.status === 'ready' ? '整组草稿核对完成，可统一预览确认；正式文档尚未保存。' : '任务尚未完成，可继续当前任务；正式文档尚未保存。'}`
}
function persistDraft(projectId: string, draft: ScriptToolDraft, expected?: string) {
  db.transaction(() => {
    const pending = getToolDraft(projectId)
    if (expected) {
      if (!pending || pending.id !== draft.id || pending.version !== expected) problem('草稿已变化，请重新读取', 409)
      draft.version = newId()
      refreshRevisionTask(projectId, draft, savedToolDocuments(projectId))
      run('UPDATE script_tool_drafts SET version=?, payload=?, updated_at=? WHERE id=? AND project_id=?', draft.version, JSON.stringify(draft), now(), draft.id, projectId)
    } else {
      if (pending) problem('已有待确认草稿，请修改、保存或放弃它')
      run('INSERT INTO script_tool_drafts (id, project_id, version, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', draft.id, projectId, draft.version, JSON.stringify(draft), now(), now())
    }
  })()
  return draft
}
export const toolDraftEdit = z.object({ version: z.string().min(1), documents: z.array(z.object({ id: z.string().min(1), content: z.string().trim().min(1).max(100000) }).strict()).max(revisionLimit), scenes: z.array(workflowScene).max(20000).optional(), resource_values: z.array(resourceValueEdit).max(300).optional() }).strict()
export function editToolDraft(projectId: string, id: string, input: z.infer<typeof toolDraftEdit>) {
  const draft = getToolDraft(projectId, id)
  if (!draft || draft.status !== 'pending') problem('找不到待确认草稿', 404)
  if (input.version !== draft.version) problem('草稿已变化，请刷新', 409)
  if (draft.kind === 'resource') {
    if (input.documents.length || input.scenes) problem('此草稿只包含视觉设定或分镜对象')
    if (input.resource_values?.some(edit => edit.index >= (draft.resource_changes?.length || 0))) problem('只能编辑当前草稿对象')
    draft.resource_changes = editResourceValues(draft.resource_changes || [], input.resource_values || [])
    validateResourceChanges(projectId, draft.resource_changes)
    draft.impacts = resourceDraftImpacts(projectId, draft.resource_changes)
    return persistDraft(projectId, draft, input.version)
  }
  if (!input.documents.length || input.resource_values) problem('文档草稿需要正文，不能混入视觉或分镜对象')
  if (new Set(input.documents.map(item => item.id)).size !== input.documents.length || input.documents.some(item => !draft.documents.some(doc => doc.id === item.id))) problem('只能编辑当前草稿中的文档')
  draft.documents = draft.documents.map(doc => ({ ...doc, content: input.documents.find(item => item.id === doc.id)?.content || doc.content }))
  if (draft.workflow) draft.workflow = workflowDraftSchema.parse({ ...draft.workflow,
    artifacts: draft.documents.map(doc => ({ artifact_type: doc.artifact_type, title: doc.title, content: doc.content })), scenes: input.scenes ?? draft.workflow.scenes })
  else if (input.scenes) {
    if (input.scenes.length !== (draft.scene_changes?.length || 0)) problem('只能编辑本次修订涉及的场次，不能新增或删除场次')
    draft.scene_changes = draft.scene_changes?.map((change, index) => ({ ...change, scene: workflowScene.parse(input.scenes![index]) }))
  }
  return persistDraft(projectId, draft, input.version)
}
export function discardToolDraft(projectId: string, id: string, expected: string) {
  return db.transaction(() => {
    const draft = getToolDraft(projectId, id)
    if (!draft || draft.status !== 'pending' || draft.version !== expected) problem('草稿已变化，请刷新', 409)
    run("UPDATE script_tool_drafts SET status='discarded', updated_at=? WHERE id=? AND project_id=? AND version=?", now(), id, projectId, expected)
    return { ...draft, status: 'discarded' as const }
  })()
}
function episodeSceneVersion(script: ScriptSnapshot, episode: number) { return version(script.scenes.filter(scene => scene.episode_number === episode)) }
function sceneFields(scene: ScriptScene) { return workflowScene.parse(scene) }
export function documentStage(document: Pick<ToolDocument, 'artifact_type' | 'episode_number'>): { stage: WorkflowStage; episode_number: number } {
  const stage = document.artifact_type === 'episode_script' ? 'episode' : ['characters', 'relationships'].includes(document.artifact_type) ? 'characters' : document.artifact_type === 'locations' ? 'locations' : document.artifact_type === 'props' ? 'props' : 'outline'
  return { stage, episode_number: stage === 'episode' ? document.episode_number : 0 }
}
export function toolConversationStage(projectId: string, script: ScriptSnapshot, previous: DirectorStageContext, action?: z.infer<typeof documentAction>) {
  const documents = projectDocuments(projectId, script), draft = getToolDraft(projectId)
  if (action && action.document_ids.some(id => !documents.some(doc => doc.id === id))) problem('文档不存在或不属于当前项目', 404)
  const target = action ? documents.find(doc => doc.id === action.document_ids[0]) : draft?.documents[0]
  // A pending patch retains its target stage even when that stage was already saved.
  return target ? directorStageContext(script, draft && !action ? { pending: documentStage(target) } : { explicit: documentStage(target) })
    : previous.stage ? previous : directorStageContext(script, { explicit: { stage: 'outline', episode_number: 0 } })
}
export function commitToolDraft(projectId: string, id: string, expected: string, script: () => ScriptSnapshot): ScriptToolDraft {
  return db.transaction(() => {
    const draft = getToolDraft(projectId, id)
    if (!draft || draft.status !== 'pending' || draft.version !== expected) problem('草稿已变化，请重新确认', 409)
    const current = script(), documents = projectDocuments(projectId, current), timestamp = now()
    if (draft.revision_task && draft.revision_task.status !== 'ready') revisionProblem('revision_incomplete', revisionSummary(draft), '继续当前任务，读完有效草稿和关联对象，提交review_revision_batch；不能将部分草稿标记为全部完成。', { retryable: false })
    if (draft.kind === 'resource') {
      if (!draft.resource_changes?.length) problem('草稿缺少视觉或分镜修改')
      validateResourceChanges(projectId, draft.resource_changes)
      applyResourceChanges(projectId, draft.resource_changes)
      run("UPDATE script_tool_drafts SET status='saved', updated_at=? WHERE id=? AND project_id=?", timestamp, id, projectId)
      run('UPDATE projects SET updated_at=? WHERE id=?', timestamp, projectId)
      return { ...draft, status: 'saved' as const }
    }
    for (const doc of draft.documents) {
      const original = documents.find(item => item.id === doc.id || item.artifact_type === doc.artifact_type && item.episode_number === doc.episode_number)
      if (doc.version ? original?.version !== doc.version : Boolean(original)) problem(`「${doc.title}」已被修改，请重新读取后修订`, 409)
    }
    if (draft.workflow?.stage === 'episode' && episodeSceneVersion(current, draft.workflow.episode_number) !== draft.scene_version) problem('本集场次已被修改，请重新生成草稿', 409)
    for (const change of draft.scene_changes || []) {
      const scene = current.scenes.find(item => item.id === change.id)
      if (!scene || version(scene) !== change.version) problem('本次修订涉及的场次已变化，请重新读取后修订', 409)
    }
    for (const decision of draft.revision_task?.decisions || []) {
      run(`INSERT INTO script_story_decisions (id, project_id, topic, content, basis, source_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, topic) DO UPDATE SET content=excluded.content, basis=excluded.basis, source_text=excluded.source_text, updated_at=excluded.updated_at`,
      newId(), projectId, decision.topic, decision.choice, 'delegated_model', draft.revision_task!.source_text, timestamp, timestamp)
    }
    for (const doc of draft.documents) {
      const existing = (current.artifacts || []).find(item => item.artifact_type === doc.artifact_type && (item.episode_number || 0) === doc.episode_number)
      if (existing) run("UPDATE script_artifacts SET content=?, title=?, status='ready', updated_at=? WHERE id=? AND project_id=?", doc.content, doc.title, timestamp, existing.id, projectId)
      else run("INSERT INTO script_artifacts (id, project_id, artifact_type, episode_number, title, content, position, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)", newId(), projectId, doc.artifact_type, doc.episode_number, doc.title, doc.content, (current.artifacts?.length || 0) + draft.documents.indexOf(doc), timestamp, timestamp)
      if (!doc.episode_number && ['outline', 'characters'].includes(doc.artifact_type)) {
        run(`INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET ${doc.artifact_type}=excluded.${doc.artifact_type}, updated_at=excluded.updated_at`, projectId,
        doc.artifact_type === 'outline' ? doc.content : current.outline, doc.artifact_type === 'characters' ? doc.content : current.characters, JSON.stringify(current.generation_options), timestamp)
      }
    }
    if (draft.workflow?.stage === 'episode') {
      const episode = draft.workflow.episode_number
      // Creation only: saved episodes must use a patch instead of replacing
      // scene IDs already used by storyboard and visual reference bindings.
      for (const [index, scene] of draft.workflow.scenes.entries()) run(`INSERT INTO script_scenes
        (id, project_id, episode_number, position, heading, location, time_of_day, characters, action, dialogue, narration, duration, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), projectId, episode, current.scenes.length + index, scene.heading, scene.location, scene.time_of_day, scene.characters, scene.action, scene.dialogue, scene.narration, scene.duration, timestamp, timestamp)
    }
    for (const change of draft.scene_changes || []) {
      const scene = change.scene
      run(`UPDATE script_scenes SET heading=?, location=?, time_of_day=?, characters=?, action=?, dialogue=?, narration=?, duration=?, updated_at=? WHERE id=? AND project_id=?`,
        scene.heading, scene.location, scene.time_of_day, scene.characters, scene.action, scene.dialogue, scene.narration, scene.duration, timestamp, change.id, projectId)
    }
    if (draft.revision_task) {
      const savedDocuments = savedToolDocuments(projectId)
      const reviewed = draft.revision_task.documents.map(item => {
        const source = documents.find(doc => doc.id === item.id)!
        return { item, saved: savedDocuments.find(doc => doc.id === item.id || doc.artifact_type === source.artifact_type && doc.episode_number === source.episode_number)! }
      })
      for (let offset = 0; offset < reviewed.length; offset += 8) {
        const batch = reviewed.slice(offset, offset + 8)
        saveDocumentReview(projectId, savedDocuments, { documents: batch.map(({ saved }) => ({ id: saved.id, version: saved.version })), findings: [],
          summary: ('统一修订已核对并由创作者确认保存。' + batch.map(({ item }) => `「${item.title}」${item.assessment?.explanation || ''}${item.assessment?.findings.map(finding => `；${finding.explanation}`).join('') || ''}`).join('\n')).slice(0, 3000) })
      }
    }
    run("UPDATE script_tool_drafts SET status='saved', updated_at=? WHERE id=?", timestamp, id)
    run('UPDATE projects SET updated_at=? WHERE id=?', timestamp, projectId)
    return { ...draft, status: 'saved' as const }
  })()
}

const schemas = {
  load_creation_skills: z.object({ stage: z.enum(skillStages) }).strict(),
  ...resourceSchemas,
  ...revisionSchemas,
  get_creation_state: z.object({}).strict(),
  get_project_visual_style: z.object({}).strict(),
  set_project_visual_style: z.object({
    expected_version: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(1000),
    details: visualStyleDetailsSchema.optional(), source_message_index: z.number().int().min(0).max(31).optional(),
    source_decision_id: z.string().min(1).max(160).optional(),
    basis: z.enum(['creator_confirmed', 'delegated_model']),
  }).strict(),
  search_project_content: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(30).default(12) }).strict(),
  read_documents: z.object({ document_ids: ids, source: z.enum(['saved', 'draft']).default('saved'), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(20000).default(20000), scene_offset: z.number().int().min(0).default(0), scene_limit: z.number().int().min(1).max(10).default(3) }).strict(),
  record_story_decision: z.object({ topic: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(4000), basis: z.enum(['creator_confirmed', 'delegated_model']), source_message_index: z.number().int().min(0).max(31), settings_patch: scriptSettingsSchema.optional() }).strict(),
  ask_creator: z.object({ intro: z.string().max(8000).default(''), trailing: z.string().max(3000).default(''), request: creatorRequest }).strict(),
  propose_next_step: z.object({ stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']), episode_number: z.number().int().min(0).max(200).default(0),
    purpose: z.enum(['generate', 'revise']).default('generate'), summary: z.string().trim().min(1).max(1000), basis: z.string().trim().min(1).max(3000),
    source_message_indexes: z.array(z.number().int().min(0).max(31)).min(1).max(32), document_ids: z.array(z.string().min(1)).max(8).default([]) }).strict(),
  create_document_draft: workflowDraftInput,
  propose_document_patch: patchSchema,
  find_related_content: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(30).default(15) }).strict(),
  get_document_review_context: z.object({ document_ids: ids.optional() }).strict(),
  submit_document_review: documentReviewInput,
  manage_document_draft: z.object({ operation: z.enum(['read', 'update', 'discard']), draft_id: z.string().optional(), version: z.string().optional(), changes: patchSchema.shape.changes.optional(), scene_changes: z.array(sceneChange).max(100).optional(), scenes: z.array(workflowScene).max(100).optional(), summary: z.string().max(3000).optional(), resource_values: z.array(resourceValueEdit).max(300).optional() }).strict(),
  commit_document_draft: z.object({ draft_id: z.string().min(1), version: z.string().min(1) }).strict(),
}
const descriptions: Record<keyof typeof schemas, string> = {
  load_creation_skills: '准备对应创作任务前读取本轮由创作者选定的主技能和辅助技能规则；stage为script、visual_assets、image_prompt、storyboard或video_prompt。仅加载已配置的选择，不能自行指定或切换技能。读取项目资料无需调用此函数。',
  ...resourceDescriptions,
  manage_revision_task: '管理跨文档统一修订任务。start在创作者明确要求补齐/统一时，全部已有文档用scope:all_documents（程序取得完整目录）；选定范围用document_ids，填写summary和真实user来源索引，保存任务范围；不写正式文档。read返回持久进度、拟定决定、草稿version及分页关联对象原文/版本，使用reference_next_offset读完。update携带task_id/version记录decisions（topic、choice、reason），决定仅留在草稿，保存后才采用。继续已有任务不再次start或重复授权，不擅自扩大范围。',
  review_revision_batch: '对统一修订任务最终有效草稿进行专业核对。先read_documents(source:draft)分段读完文档与所有分场，用返回的文档version；检查待定、缺失、跨文档一致性和正文/分场同步，结论resolved/unchanged/needs_change。仍有问题必须findings逐字引用证据；刻意保留悬念标intentional_suspense并说明理由。references先通过manage_revision_task(read)读到当前对象，核对与整组草稿/拟定决定一致性；needs_change阻止整组完成。分批至多8份文档/10项引用累积报告，不靠关键词或模型一句已完成判定成功。',
  get_creation_state: '读取本项目创作设置、文档目录、已确认决定、当前阶段及待确认草稿。开始操作前调用。目录不是正文。',
  get_project_visual_style: '读取项目统一画风、版本、结构化表现要求及旧项目的已确认来源。没有专用画风字段时，按语义从明确确认的来源整理，不能把题材、作品借鉴、默认值或否定项当成画风。',
  set_project_visual_style: '将创作者明确给出/接受或明确授权决定的画风规范化为项目统一设置，并记录真实来源。先读取当前version作为expected_version。新决定引用source_message_index；仅规范化已有确认决定时引用get_project_visual_style返回的source_decision_id。两种来源只能选一种。name写画风，details仅填写已确认的媒介/渲染/线条/配色/排除表现，不补造细节；替换旧规范而非混用。仅修改画风，不改文档或付费生成。',
  search_project_content: '在本项目文档、已确认决定和已保存对话中按词搜索，返回原文片段及来源。可分词多次检索。',
  read_documents: '读取指定文档原文及版本和带版本的paragraphs段落定位。source默认saved；统一修订任务中检查最新有效草稿用draft（包含范围内尚未修改文档），不可把已改草稿覆盖回正式原文。offset/length按字符分段读完；仅完全读到的段落返回定位。分集正文分页返回场次及版本，用scene_next_offset继续读完。',
  record_story_decision: '记录创作者明确确认的设定或其明确授权你决定后作出的具体选择。topic稳定标识同一事项，更新它会替代旧决定；必须引用一条真实创作者消息，不能记录未经接受的建议。若决定涉及集数、单集秒数、题材、视觉画风等配置，用settings_patch同步；画风写visual_style，不能只塞进genre，或使用set_project_visual_style记录画风及细节。不要写默认值或未接受的建议。记录不会保存文档正文。',
  ask_creator: '直接显示选择、填写或确认界面，等待创作者回答。request使用choice_request/input_request/confirmation_request/question_set和status:pending。一次一个关键决定；只问未确定且未委托你决定的事项。',
  propose_next_step: '信息足以创作当前阶段时提出明确下一步，程序核验后显示生成或修订按钮。故事方向在首次对话中自然确定；引用真实创作者消息说明依据，不要求填写固定字段，不反复追问普通细节。generate只推荐最早缺失阶段；revise只针对创作者明确要求修改的已有文档并填写document_ids。不得将其他阶段操作放进ask_creator的设定选项。此函数不生成、不保存，等待创作者点击或明确要求生成。',
  create_document_draft: '将你写出的当前阶段完整内容建立为待确认草稿。只用于尚不存在的文档，已有文档用propose_document_patch。非分集scenes为空，分集正文须含完整场次。不会保存。',
  propose_document_patch: '对已读取文档提出局部修改草稿。同一文档会合并，程序按8份一组处理；每份最多40处修改。find逐字匹配且唯一；可用paragraph_id整段替换，或限定find在指定段内，禁止模糊匹配。统一任务携带task_id和draft_version累积同一草稿：首次修改用saved读取版本，已修改文档用source:draft版本继续修订。修订分集正文必须scene_changes同步相关分场，保留ID和其他字段。原文在其他窗口变化时，分别读完新saved原文和已有draft，保留双方有效修改后rebase:true及新saved版本重新整理；不能直接覆盖。错误包含diagnostic和repair，先修正重试，不能把失败当完成。不会保存。',
  find_related_content: '查找人物、场景或道具在其他文档、结构化场次、分镜和视觉档案中的引用，辅助判断修改影响。结果是文本匹配线索，需读取相关文档判断语义。',
  get_document_review_context: '读取文档待定标记、当前版本的专业评审状态和真实关联对象目录。待定标记仅为文字线索，不代表完整性结论，不自动重做已存在阶段。',
  submit_document_review: '阅读完整目标原文后提交专业评审报告：指出待定、缺失、矛盾和下游影响，quote逐字引用当前原文，相关ID使用真实目录。没有问题时findings为空。只记录评审，不修改或保存正文；评审结果随原文版本变化失效。',
  manage_document_draft: '读取、继续修改或放弃当前草稿。update用changes定位草稿中的片段，base_version传草稿version；discard仅在创作者要求放弃时使用。',
  commit_document_draft: '保存本轮开始前已存在、且创作者明确批准保存的指定版本草稿。只说继续、接受设定或要求生成并非批准保存。程序会验证批准和原文版本；不能同轮创建后自行保存。',
}
export const scriptFunctions: TextTool[] = (Object.keys(schemas) as Array<keyof typeof schemas>).map(name => ({ name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { io: 'input', unrepresentable: 'any' }) }))

export function documentTools(context: ToolsContext) {
  const projectId = context.project.id
  const initialDraft = getToolDraft(projectId)
  const resources = resourceTools(projectId)
  const loadedSkillStages = new Set<SkillStage>(['script'])
  function requireSkills(stage: SkillStage) {
    if (context.skillRules?.[stage]?.skills.length && !loadedSkillStages.has(stage)) {
      problem(`请先调用load_creation_skills(stage:"${stage}")，读取创作者为本轮选定的主技能与辅助技能`)
    }
  }
  const readVersions = new Map<string, { version: string; ranges: Array<[number, number]> }>()
  const readScenes = new Map<string, string>()
  const readDraftDocuments = new Map<string, { version: string; ranges: Array<[number, number]> }>()
  const readDraftScenes = new Map<string, string>()
  const readReferences = new Map<string, string>()
  let readDraftVersion = ''
  let resultDraft: ScriptToolDraft | null | undefined
  let interaction: z.infer<typeof replyClassification> | undefined
  let interactionText = ''
  let resultReview: DocumentReview | undefined
  let mutated = false
  let settingsChanged = false
  let revisionWorked = false
  function saveDecision(data: z.infer<typeof schemas.record_story_decision>, sourceText: string) {
    if (context.action?.operation === 'review') problem('本轮只评审文档，不改动已确认设定')
    const existing = one<Decision>('SELECT * FROM script_story_decisions WHERE project_id=? AND topic=?', projectId, data.topic)
    const id = existing?.id || newId()
    db.transaction(() => {
      run(`INSERT INTO script_story_decisions (id, project_id, topic, content, basis, source_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, topic) DO UPDATE SET content=excluded.content, basis=excluded.basis, source_text=excluded.source_text, updated_at=excluded.updated_at`, id, projectId, data.topic, data.content, data.basis, sourceText, now(), now())
      if (data.settings_patch && Object.keys(data.settings_patch).length) {
        const current = context.script(), settings = mergeConfirmedScriptSettings(current.generation_options, context.currentSettings, data.settings_patch)
        run(`INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET generation_options=excluded.generation_options, updated_at=excluded.updated_at`, projectId, current.outline, current.characters, JSON.stringify(settings), now())
        run('UPDATE projects SET updated_at=? WHERE id=?', now(), projectId)
        context.currentSettings = settings; settingsChanged = true; mutated = true
      }
    })()
    return { id, recorded: true, document_saved: false }
  }
  const docs = () => projectDocuments(projectId, context.script())
  const checkScope = (id: string) => {
    if (context.action && !context.action.document_ids.includes(id)) problem('本次只处理创作者选择的文档，其他文档可读取评审但不能修改')
    if (context.workflow) {
      const doc = docs().find(item => item.id === id), target = doc && documentStage(doc)
      if (!target || target.stage !== context.workflow || target.episode_number !== (context.stage.episode_number || 0)) problem('本次只能修改明确指定的阶段与集数')
    }
  }
  const canDraft = () => {
    if (context.discussionOnly || context.action?.operation === 'review') problem('本轮只讨论或评审，不创建或保存文档草稿')
    if (context.legacyPending) problem('当前有阶段草稿待确认，请先处理它')
  }
  function currentTask(taskId?: string, expected?: string) {
    const draft = getToolDraft(projectId)
    if (!draft?.revision_task || taskId && taskId !== draft.revision_task.id) revisionProblem('task_not_found', '找不到当前统一修订任务', '先get_creation_state确认当前任务，不要猜测ID。', { retryable: false })
    if (expected && draft.version !== expected) revisionProblem('draft_version_changed', '草稿版本已变化，请重新读取', 'manage_revision_task(read)读取当前version后继续；不得覆盖并行修改。')
    draft.revision_task.documents.forEach(doc => checkScope(doc.id))
    return draft
  }
  function saveTask(draft: ScriptToolDraft, expected: string) {
    refreshRevisionTask(projectId, draft, docs())
    draft.revision_task!.updated_at = now()
    resultDraft = persistDraft(projectId, draft, expected)
    revisionWorked = true
    context.onEvent({ type: 'revision_progress', draft_id: draft.id, version: draft.version, task: draft.revision_task })
    return { task: draft.revision_task, draft_id: draft.id, version: draft.version, saved: false, summary: revisionSummary(draft) }
  }
  function search(query: string, limit: number, related: boolean) {
    const matches: Array<Record<string, unknown>> = []
    const add = (source: string, id: string, title: string, content: string) => {
      const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      if (index >= 0) matches.push({ source, id, title, offset: Math.max(0, index - 180), excerpt: content.slice(Math.max(0, index - 180), index + query.length + 420) })
    }
    for (const doc of docs()) add('document', doc.id, doc.title, doc.content)
    for (const item of storyDecisions(projectId)) add('decision', item.id, item.topic, item.content)
    if (related) {
      for (const scene of context.script().scenes) add('scene', scene.id, scene.heading, JSON.stringify(scene))
      for (const shot of all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', projectId)) add('shot', shot.id, shot.title, JSON.stringify(shot))
      for (const profile of all<{ id: string; name: string; definition: string; variant: string }>('SELECT id, name, definition, variant FROM visual_profiles WHERE project_id=?', projectId)) add('visual_profile', profile.id, profile.name, profile.variant + '\n' + profile.definition)
    } else {
      for (const [index, message] of context.messages.entries()) add('current_conversation', String(index), message.role, message.text)
      for (const message of all<{ id: string; text: string; role: string }>(`SELECT m.id, m.text, m.role FROM script_messages m JOIN script_conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND instr(lower(m.text), lower(?))>0 ORDER BY c.updated_at DESC, m.position DESC LIMIT ?`, projectId, query, limit)) add('conversation', message.id, message.role, message.text)
    }
    return { matches: matches.slice(0, limit), total: matches.length, has_more: matches.length > limit }
  }
  return {
    result: () => ({ tool_draft: resultDraft?.revision_task && resultDraft.status === 'pending' ? getToolDraft(projectId, resultDraft.id) : resultDraft, revision_worked: revisionWorked, review: resultReview, classification: interaction, reply: interactionText, project_changed: mutated,
      ...(settingsChanged ? { generation_options: context.script().generation_options } : {}) }),
    async execute(name: string, args: unknown): Promise<unknown> {
      context.signal?.throwIfAborted()
      const schema = schemas[name as keyof typeof schemas]
      if (schema) args = restoreOptionalNulls(args, z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))
      if (name in resourceSchemas) {
        if (!name.startsWith('propose_')) return resources.execute(name, args)
        canDraft()
        if (context.action || context.workflow) problem('本轮只处理明确指定的文档范围，视觉设定或分镜请另行提出')
        if (getToolDraft(projectId)) problem('已有待确认草稿，请读取并修改、保存或放弃它')
        if (name === 'propose_visual_profile_draft') requireSkills('visual_assets')
        if (name === 'propose_shot_plan') requireSkills('storyboard')
        if (name === 'propose_shot_patch') {
          const patch = resourceSchemas.propose_shot_patch.parse(args)
          if (patch.shots.some(item => item.changes.image_prompt !== undefined)) requireSkills('image_prompt')
          if (patch.shots.some(item => item.changes.video_prompt !== undefined)) requireSkills('video_prompt')
          if (patch.shots.some(item => Object.keys(item.changes).some(key => key !== 'image_prompt' && key !== 'video_prompt'))) requireSkills('storyboard')
        }
        const proposal = resources.execute(name, args) as { summary: string; changes: ResourceChange[] }
        if (!context.authorizeResource || !await context.authorizeResource(proposal.summary, proposal.changes)) problem('本轮尚未明确要求创建或修改这些视觉设定或分镜，请先讨论方案')
        context.signal?.throwIfAborted()
        validateResourceChanges(projectId, proposal.changes)
        resultDraft = persistDraft(projectId, { id: newId(), version: newId(), kind: 'resource', summary: proposal.summary,
          documents: [], resource_changes: proposal.changes, impacts: resourceDraftImpacts(projectId, proposal.changes), status: 'pending' })
        return { draft_id: resultDraft.id, version: resultDraft.version, summary: resultDraft.summary, changes: proposal.changes, impacts: resultDraft.impacts, saved: false }
      }
      switch (name) {
        case 'load_creation_skills': {
          const { stage } = schemas.load_creation_skills.parse(args)
          const rules = context.skillRules?.[stage] || skillContext(stage, context.messages.map(message => message.text).join('\n'), undefined, projectId)
          loadedSkillStages.add(stage)
          return { stage, ...rules }
        }
        case 'get_creation_state': schemas.get_creation_state.parse(args); return { project: context.project, settings: mergeConfirmedScriptSettings(context.script().generation_options, context.currentSettings), saved_settings: context.script().generation_options, project_visual_style: projectVisualStyle(projectId),
          selected_skills: Object.entries(context.skillRules || {}).map(([stage, rules]) => ({ stage, skills: rules.skills.map(({ id, name, role }) => ({ id, name, role })) })),
          stage: context.stage, progress: workflowProgress(context.script()), documents: docs().map(({ content, ...doc }) => ({ ...doc, length: content.length })),
          creation: creationState(projectId, context.script()), document_health: documentHealth(projectId, docs()), decisions: storyDecisions(projectId), pending_draft: getToolDraft(projectId) ? { id: getToolDraft(projectId)!.id, version: getToolDraft(projectId)!.version, summary: getToolDraft(projectId)!.summary, revision_task: getToolDraft(projectId)!.revision_task } : null }
        case 'manage_revision_task': {
          const data = schemas.manage_revision_task.parse(args)
          if (data.operation === 'start') {
            canDraft()
            if (getToolDraft(projectId)) revisionProblem('pending_draft_exists', '已有待确认草稿，请继续当前草稿或任务', '通过manage_revision_task(read)或manage_document_draft(read)读取；不能覆盖或自动放弃已有草稿。', { retryable: false })
            const source = data.source_message_index === undefined ? undefined : context.messages[data.source_message_index]
            if (!source || source.role !== 'user' || data.scope === 'selected' && !data.document_ids || !data.summary) revisionProblem('task_scope_required', '统一修订任务需要明确范围、说明和真实创作者来源', '全部已有文档用scope:all_documents；选定文档用document_ids。填写summary及真实user消息索引。')
            const targetIds = data.scope === 'all_documents' ? docs().map(doc => doc.id) : data.document_ids!
            if (!targetIds.length || targetIds.length > revisionLimit) revisionProblem('task_scope_limit', '统一修订需要1至220份已有文档', '先读取文档目录，按明确范围分任务。', { retryable: false })
            const documents = targetIds.map(id => {
              checkScope(id)
              const doc = docs().find(doc => doc.id === id)
              if (!doc) problem('文档不存在或不属于当前项目', 404)
              return { id, title: doc.title, source_version: doc.version, status: 'pending' as const }
            })
            const draft: ScriptToolDraft = { id: newId(), version: newId(), kind: 'patch', summary: data.summary, documents: [], scene_changes: [], status: 'pending',
              revision_task: { id: newId(), summary: data.summary, scope: data.scope, source_text: source.text, created_at: now(), updated_at: now(), context_version: version(revisionContext(projectId)), status: 'in_progress', documents, decisions: data.decisions || [], references: [], batches: 0 } }
            resultDraft = persistDraft(projectId, draft)
            revisionWorked = true
            context.onEvent({ type: 'revision_progress', draft_id: draft.id, version: draft.version, task: draft.revision_task })
            return { task: draft.revision_task, draft_id: draft.id, version: draft.version, saved: false, summary: revisionSummary(draft) }
          }
          const draft = currentTask(data.task_id, data.version)
          if (data.operation === 'read') {
            resultDraft = draft
            const references = draft.revision_task!.references.slice(data.reference_offset, data.reference_offset + data.reference_limit).map(ref => revisionReference(projectId, draft, docs(), ref)).filter(ref => !!ref)
            if (Buffer.byteLength(JSON.stringify(references), 'utf8') > 500000) revisionProblem('read_too_large', '关联读取过大', '减少reference_limit后继续分页。')
            for (const ref of references) readReferences.set(`${ref.kind}:${ref.id}`, ref.version)
            return { task: draft.revision_task, context: revisionContext(projectId), draft_id: draft.id, version: draft.version, references, reference_next_offset: data.reference_offset + Math.min(data.reference_limit, Math.max(0, draft.revision_task!.references.length - data.reference_offset)), references_complete: data.reference_offset + data.reference_limit >= draft.revision_task!.references.length, summary: revisionSummary(draft) }
          }
          // Answering a task's question can update its proposed choices, while
          // discussionOnly still prohibits document edits, reviews and saves.
          if (context.action?.operation === 'review' || context.legacyPending) canDraft()
          if (!data.version || !data.decisions?.length) revisionProblem('task_update_required', '更新任务需要当前version及拟定决定', '先读取任务，将具体选择与理由填入decisions。')
          for (const choice of data.decisions) {
            const index = draft.revision_task!.decisions.findIndex(item => item.topic === choice.topic)
            if (index < 0) draft.revision_task!.decisions.push(choice); else draft.revision_task!.decisions[index] = choice
          }
          if (draft.revision_task!.decisions.length > 100) revisionProblem('limit_exceeded', '统一设定最多100项', '合并同一事项的决定。', { limit: 100, actual: draft.revision_task!.decisions.length })
          return saveTask(draft, data.version)
        }
        case 'review_revision_batch': {
          canDraft()
          const data = schemas.review_revision_batch.parse(args), draft = currentTask(data.task_id, data.version), task = draft.revision_task!
          if (new Set(data.documents.map(doc => doc.document_id)).size !== data.documents.length || new Set(data.references.map(ref => `${ref.kind}:${ref.id}`)).size !== data.references.length) problem('核对项不能重复')
          for (const assessment of data.documents) {
            const item = task.documents.find(doc => doc.id === assessment.document_id), source = docs().find(doc => doc.id === assessment.document_id)
            if (!item || !source) problem('只能核对当前任务范围的文档')
            const effective = revisionDocument(draft, source), read = readDraftDocuments.get(source.id)
            if (item.source_version !== source.version) revisionProblem('source_version_changed', `「${source.title}」正式原文已变化`, '重新读取原文并修订，不能覆盖新版本。', { document_id: source.id, title: source.title, retryable: false })
            if (assessment.version !== effective.version || read?.version !== effective.version || !read.ranges.some(([start, end]) => start === 0 && end === effective.content.length)) revisionProblem('review_requires_full_read', `核对「${source.title}」前请读完有效草稿`, 'read_documents(source:draft)分段读完目标文档，使用返回的文档version。', { document_id: source.id, title: source.title })
            if (source.artifact_type === 'episode_script' && context.script().scenes.filter(scene => scene.episode_number === source.episode_number).some(scene => readDraftScenes.get(scene.id) !== version(effectiveScene(draft, scene)))) revisionProblem('review_requires_scenes', '核对分集正文前请读完全部有效分场', '继续read_documents(source:draft)的scene_offset分页，检查正文与分场一致。', { document_id: source.id, title: source.title })
            if (assessment.findings.some(finding => !effective.content.includes(finding.quote))) revisionProblem('review_evidence_mismatch', '核对证据必须逐字引用当前有效草稿', '重新读取有效草稿，精确复制quote。', { document_id: source.id, title: source.title })
            if (assessment.conclusion === 'unchanged' && effective.content !== source.content) problem('已修改文档不能标记为无需修改')
            item.assessment = assessment
          }
          for (const review of data.references) {
            const item = task.references.find(ref => ref.id === review.id && ref.kind === review.kind), current = revisionReference(projectId, draft, docs(), review)
            if (!item || !current || review.version !== current.version || readReferences.get(`${review.kind}:${review.id}`) !== current.version) revisionProblem('reference_review_requires_read', '关联对象未读取或版本已变化', 'manage_revision_task(read)分页读取当前关联对象后核对。')
            item.review = { ...review, draft_snapshot: revisionSnapshot(draft) }
          }
          return saveTask(draft, data.version)
        }
        case 'get_project_visual_style': schemas.get_project_visual_style.parse(args); return { ...projectVisualStyle(projectId), confirmed_sources: storyDecisions(projectId) }
        case 'set_project_visual_style': {
          const data = schemas.set_project_visual_style.parse(args)
          const currentStyle = projectVisualStyle(projectId)
          assertStyleVersion(currentStyle, data.expected_version)
          if ((data.source_message_index !== undefined) === !!data.source_decision_id) problem('画风更新必须引用一个真实创作者消息或一个已有确认决定，不能混用来源')
          if (data.source_decision_id && currentStyle.source === 'settings') problem('已有明确的项目画风，不能用历史决定覆盖；修改需引用本次创作者确认或授权消息')
          const source = data.source_decision_id ? storyDecisions(projectId).find(item => item.id === data.source_decision_id) : undefined
          const message = data.source_message_index !== undefined ? context.messages[data.source_message_index] : undefined
          if (data.source_decision_id ? !source : !message || message.role !== 'user') problem('画风来源不存在或不属于当前项目')
          saveDecision({ topic: '视觉风格', content: JSON.stringify({ name: data.name, ...data.details }), basis: source?.basis as 'creator_confirmed' | 'delegated_model' || data.basis,
            source_message_index: data.source_message_index || 0, settings_patch: { visual_style: data.name, visual_style_details: data.details || {} } }, source?.source_text || message!.text)
          return { saved: true, project_visual_style: projectVisualStyle(projectId), document_saved: false,
            note: '后续生成统一使用此画风；已有图片、视频和设定正文保留，需要核对旧参考图。' }
        }
        case 'search_project_content': { const data = schemas.search_project_content.parse(args); return search(data.query, data.limit, false) }
        case 'find_related_content': { const data = schemas.find_related_content.parse(args); return search(data.query, data.limit, true) }
        case 'get_document_review_context': {
          const data = schemas.get_document_review_context.parse(args), documents = docs()
          if (data.document_ids?.some(id => !documents.some(doc => doc.id === id))) problem('文档不存在或不属于当前项目')
          return { document_health: documentHealth(projectId, documents).filter(item => !data.document_ids || data.document_ids.includes(item.document_id)),
            references: projectReferences(projectId, documents), note: '文字标记及上游依赖是核查线索；请读原文并由专业判断形成评审。文档存在不代表内容完整，评审不会倒退阶段。' }
        }
        case 'submit_document_review': {
          const data = schemas.submit_document_review.parse(args), documents = docs()
          for (const target of data.documents) {
            const doc = documents.find(item => item.id === target.id), read = readVersions.get(target.id)
            if (!doc || read?.version !== target.version || doc.version !== target.version || !read.ranges.some(([start, end]) => start === 0 && end === doc.content.length)) problem('专业评审前请分段读完目标文档当前原文')
            if (context.action?.operation === 'review' && !context.action.document_ids.includes(target.id)) problem('本轮只评审选定文档，相关文档可读取作为依据')
          }
          resultReview = saveDocumentReview(projectId, documents, data)
          return { review: resultReview, document_saved: false, summary: data.summary }
        }
        case 'read_documents': {
          const data = schemas.read_documents.parse(args)
          const draft = data.source === 'draft' ? currentTask() : undefined
          const documents = data.document_ids.map(id => {
            const source = docs().find(item => item.id === id)
            if (!source) problem('文档不存在或不属于当前项目', 404)
            if (draft && !draft.revision_task!.documents.some(doc => doc.id === id)) problem('有效草稿读取仅适用于当前统一修订任务范围')
            const doc = draft ? revisionDocument(draft, source) : source
            const end = Math.min(doc.content.length, data.offset + data.length)
            if (data.offset > doc.content.length) problem('读取位置超过文档长度')
            const allScenes = doc.artifact_type === 'episode_script' ? context.script().scenes.filter(scene => scene.episode_number === doc.episode_number) : undefined
            if (allScenes && data.scene_offset > allScenes.length) problem('场次读取位置超过本集场次数')
            const scenes = allScenes?.slice(data.scene_offset, data.scene_offset + data.scene_limit).map(original => { const scene = draft ? effectiveScene(draft, original) : original; return { id: scene.id, version: version(scene), ...sceneFields(scene) } })
            return { ...doc, source: data.source, paragraphs: documentParagraphs(doc.content, doc.version).filter(p => p.start >= data.offset && p.end <= end), content: doc.content.slice(data.offset, end), offset: data.offset, next_offset: end, complete: end === doc.content.length, total_length: doc.content.length,
              ...(scenes ? { scenes, scene_offset: data.scene_offset, scene_next_offset: data.scene_offset + scenes.length, scenes_complete: data.scene_offset + scenes.length === allScenes!.length, total_scenes: allScenes!.length } : {}) }
          })
          if (Buffer.byteLength(JSON.stringify(documents), 'utf8') > 500_000) problem('本次读取过大，请减少文档数量')
          for (const doc of documents) {
            const reads = draft ? readDraftDocuments : readVersions
            const previous = reads.get(doc.id), ranges: Array<[number, number]> = previous?.version === doc.version ? [...previous.ranges] : []
            ranges.push([doc.offset, doc.next_offset]); ranges.sort(([a], [b]) => a - b)
            const merged: Array<[number, number]> = []
            for (const range of ranges) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]) }
            reads.set(doc.id, { version: doc.version, ranges: merged })
            for (const scene of doc.scenes || []) (draft ? readDraftScenes : readScenes).set(scene.id, scene.version)
          }
          return { documents }
        }
        case 'record_story_decision': {
          if (getToolDraft(projectId)?.revision_task) revisionProblem('decision_requires_draft', '当前统一修订的拟定设定应保留在草稿中', '使用manage_revision_task(update)记录choice与reason，确认保存后才正式采用。', { retryable: false })
          const data = schemas.record_story_decision.parse(args), source = context.messages[data.source_message_index]
          if (!source || source.role !== 'user') problem('决定来源必须是本轮上下文中的创作者消息')
          return saveDecision(data, source.text)
        }
        case 'ask_creator': {
          clearCreationProposal(projectId)
          const data = schemas.ask_creator.parse(args)
          if (!['choice_request', 'input_request', 'confirmation_request', 'question_set'].includes(data.request.type) || !('status' in data.request) || data.request.status !== 'pending') problem('ask_creator必须是待回答的问题')
          const stage = toolConversationStage(projectId, context.script(), directorStageContext(context.script(), { previous: context.stage }), context.action)
          const metadata = { stage: stage.stage || 'outline', purpose: 'setting' as const, ...(stage.episode_number ? { episode_number: stage.episode_number } : {}) }
          interaction = data.request.type === 'question_set' ? { ...data.request, interaction: metadata, questions: data.request.questions.map(question => ({ ...question, interaction: metadata })) } : { ...data.request, interaction: metadata }
          const request = interaction
          const kind = request.type === 'choice_request' ? 'choices' : request.type === 'confirmation_request' ? 'confirmation' : request.type
          const { type: _type, status: _status, ...fields } = request as typeof request & { status: string }
          interactionText = JSON.stringify({ kind, ...fields, intro: data.intro, trailing: data.trailing })
          return { displayed: true, waiting_for_creator: true }
        }
        case 'propose_next_step': {
          if (context.action?.operation === 'review') problem('本轮只评审文档，不提出生成或修订操作')
          if (getToolDraft(projectId) || context.legacyPending) problem('请先检查并保存或放弃当前草稿')
          const data = schemas.propose_next_step.parse(args), progress = workflowProgress(context.script())
          if (data.source_message_indexes.some(index => context.messages[index]?.role !== 'user')) problem('下一步依据必须引用真实创作者消息')
          const episode = data.stage === 'episode' ? data.episode_number : 0
          if (data.stage === 'episode' && episode < 1) problem('分集正文必须指定集数')
          if (data.purpose === 'generate') {
            if (context.action || data.stage !== progress.next_stage || data.stage === 'episode' && episode !== progress.next_episode) problem('下一步必须是最早缺失的创作阶段；明确跳转请由创作者指定')
            if (data.document_ids.length) problem('新文档生成不能指定已有文档')
          } else {
            if (!data.document_ids.length) problem('修订操作需要指定已有文档')
            for (const id of data.document_ids) {
              checkScope(id)
              const doc = docs().find(item => item.id === id), target = doc && documentStage(doc)
              if (!target || target.stage !== data.stage || target.episode_number !== episode) problem('修订目标不存在或与阶段不一致')
            }
            if (context.stage.mode !== 'explicit' || context.stage.stage !== data.stage || (context.stage.episode_number || 0) !== episode) problem('修订提议必须对应创作者明确指定的目标')
          }
          const next: CreationNextStep = { id: newId(), stage: data.stage, episode_number: episode, purpose: data.purpose,
            summary: data.summary, basis: data.basis, document_ids: data.document_ids, source: 'model' }
          const state = creationState(projectId, context.script())
          run(`INSERT INTO script_workflow_proposals (project_id, state_version, payload, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET state_version=excluded.state_version, payload=excluded.payload, updated_at=excluded.updated_at`, projectId, state.version, JSON.stringify(next), now())
          interaction = { type: 'other' }; interactionText = data.summary
          return { proposed: true, next_step: next, generated: false, saved: false }
        }
        case 'create_document_draft': {
          canDraft()
          if (context.action) problem('本轮是已有文档修订，请提出局部修改，不能创建其他文档')
          const data = workflowDraftSchema.parse(args), progress = workflowProgress(context.script())
          const differentStage = data.stage !== progress.next_stage || data.stage === 'episode' && data.episode_number !== progress.next_episode
          if (!context.workflow && context.authorizeCreation && !await context.authorizeCreation(data, differentStage)) problem('本轮尚未明确授权生成这个阶段，请先提出下一步供创作者选择')
          context.signal?.throwIfAborted()
          if (!context.workflow && differentStage && !context.authorizeCreation) problem('请先完成当前阶段；明确指定跳转时请使用对应阶段入口')
          if (context.workflow && (data.stage !== context.workflow || data.stage === 'episode' && data.episode_number !== context.stage.episode_number)) problem('只能创作明确指定的阶段与集数')
          const existing = docs()
          if (data.artifacts.some(item => existing.some(doc => doc.artifact_type === item.artifact_type && doc.episode_number === data.episode_number))) problem('文档已存在，请读取原文并用propose_document_patch修订')
          if (data.stage === 'episode' && context.script().scenes.some(scene => scene.episode_number === data.episode_number)) problem('本集已有场次，请使用现有分集修订入口，避免破坏分镜关联')
          resultDraft = persistDraft(projectId, { id: newId(), version: newId(), kind: 'create', summary: `${data.stage === 'episode' ? `第 ${data.episode_number} 集` : data.artifacts[0]!.title}草稿`, status: 'pending', workflow: data,
            ...(data.stage === 'episode' ? { scene_version: episodeSceneVersion(context.script(), data.episode_number) } : {}),
            documents: data.artifacts.map(doc => ({ ...doc, id: `${doc.artifact_type}:${data.episode_number}`, episode_number: data.episode_number, version: '', original_content: '', replacements: [] })) })
          return { draft_id: resultDraft.id, version: resultDraft.version, status: 'pending', saved: false }
        }
        case 'propose_document_patch': {
          canDraft(); const data = schemas.propose_document_patch.parse(args)
          const pending = getToolDraft(projectId)
          if (pending && !pending.revision_task) revisionProblem('pending_draft_exists', '已有待确认草稿，请读取并继续修改它', '使用manage_document_draft(read/update)修改同一草稿，不新建或覆盖。')
          const draft = pending ? currentTask(data.task_id, data.draft_version) : undefined
          if (draft && (!data.task_id || !data.draft_version)) revisionProblem('task_version_required', '继续统一修订需要task_id和当前draft_version', 'manage_revision_task(read)读取当前任务与草稿版本后追加批次。')
          if (!draft && (data.task_id || data.draft_version)) revisionProblem('task_not_found', '统一任务已不存在', '读取当前创作状态，不能复用已保存或放弃的任务。', { retryable: false })
          // Normalize repeated entries, then process groups of eight. All validation
          // happens before the single versioned write, so a bad item cannot half-save.
          const grouped = new Map<string, typeof data.changes[number]>()
          for (const change of data.changes) {
            const previous = grouped.get(change.document_id)
            if (previous && (previous.base_version !== change.base_version || !!previous.rebase !== !!change.rebase)) revisionProblem('conflicting_versions', '同一文档的修改版本不一致', '重新读取当前版本并合并同一文档的修改。', { document_id: change.document_id })
            grouped.set(change.document_id, previous ? { ...previous, replacements: [...previous.replacements, ...change.replacements] } : change)
          }
          const changes = [...grouped.values()].map(change => ({ ...change, replacements: [...new Map(change.replacements.map(edit => [version([edit.find, edit.paragraph_id, edit.replace]), edit])).values()] })), documents: ToolDraftDocument[] = []
          for (let offset = 0; offset < changes.length; offset += 8) for (const change of changes.slice(offset, offset + 8)) {
            checkScope(change.document_id)
            const source = docs().find(doc => doc.id === change.document_id)
            if (!source) problem('文档不存在或不属于当前项目', 404)
            const taskDoc = draft?.revision_task!.documents.find(doc => doc.id === source.id)
            if (draft && !taskDoc) problem('修改超出统一修订任务范围，不能擅自扩大范围')
            if (taskDoc && taskDoc.source_version !== source.version && !change.rebase) revisionProblem('source_version_changed', `「${source.title}」正式原文已变化`, '读完最新saved原文及已有draft，重新整理保留双方有效修改；用rebase:true及最新saved base_version重提该文档，不覆盖新原文。', { document_id: source.id, title: source.title })
            if (change.replacements.length > 40) revisionProblem('limit_exceeded', `「${source.title}」合并后有${change.replacements.length}处修改，最多40处`, '同段修改合并；其余在读取更新后的草稿后分批追加。', { document_id: source.id, title: source.title, limit: 40, actual: change.replacements.length })
            const previous = draft?.documents.find(doc => doc.id === source.id)
            if (change.rebase) {
              if (!draft || !taskDoc) problem('只有统一修订任务可重新整理原文版本')
              const savedRead = readVersions.get(source.id), proposedRead = readDraftDocuments.get(source.id)
              if (savedRead?.version !== source.version || !savedRead.ranges.some(([start, end]) => start === 0 && end === source.content.length) || previous && (proposedRead?.version !== revisionDocument(draft, source).version || !proposedRead.ranges.some(([start, end]) => start === 0 && end === previous.content.length))) revisionProblem('rebase_requires_full_read', '重新整理前请读完新原文与已有草稿', '分别read_documents(source:saved/draft)读完，比较并保留双方有效设定后重提。', { document_id: source.id, title: source.title })
              taskDoc.source_version = source.version
            }
            const effective = !change.rebase && draft && (previous || change.base_version !== source.version) ? revisionDocument(draft, source) : source
            const read = effective === source ? readVersions.get(source.id) : readDraftDocuments.get(source.id)
            if (effective.version !== change.base_version || read?.version !== effective.version) revisionProblem('document_version_unread', '修改前请先读取目标文档的当前版本', previous ? 'read_documents(source:draft)读取已修改文档，使用返回的version。' : 'read_documents读取目标原文，使用返回的version。', { document_id: source.id, title: source.title })
            const edits = resolvePassageEdits(effective.content, effective.version, change.replacements, read.ranges, source)
            documents.push({ ...source, original_content: change.rebase ? source.content : previous?.original_content ?? source.content, content: applyResolvedEdits(effective.content, edits),
              replacements: [...!change.rebase && previous?.replacements || [], ...edits.map(({ find, replace, reason }) => ({ find, replace, reason }))] })
          }
          const sceneGroups = new Map<string, typeof data.scene_changes[number]>()
          for (const change of data.scene_changes) {
            const previous = sceneGroups.get(change.scene_id)
            if (previous && (previous.base_version !== change.base_version || Object.keys(change.changes).some(key => key in previous.changes && previous.changes[key as keyof typeof previous.changes] !== change.changes[key as keyof typeof change.changes]))) revisionProblem('conflicting_scene_changes', '同一场次的修改相互冲突', '重新读取场次并合并为一个明确修改。')
            sceneGroups.set(change.scene_id, previous ? { ...previous, changes: { ...previous.changes, ...change.changes } } : change)
          }
          const scene_changes = [...sceneGroups.values()].map(change => {
            const source = context.script().scenes.find(item => item.id === change.scene_id)
            if (!source) problem('请先读取当前分集文档与场次版本')
            const rebaseScene = changes.some(change => change.rebase && documents.some(doc => doc.id === change.document_id && doc.artifact_type === 'episode_script' && doc.episode_number === source.episode_number))
            const effective = draft && !rebaseScene ? effectiveScene(draft, source) : source
            const read = draft && !rebaseScene ? readDraftScenes.get(source.id) || readScenes.get(source.id) : readScenes.get(source.id)
            if (version(effective) !== change.base_version || read !== change.base_version) revisionProblem('scene_version_unread', '请先读取当前分集文档与场次版本', 'read_documents读取分集与有效场次分页，使用返回的场次version。')
            if (!documents.some(doc => doc.artifact_type === 'episode_script' && doc.episode_number === source.episode_number)) problem('场次必须属于本次修改的分集文档')
            const previous = draft?.scene_changes?.find(scene => scene.id === source.id)
            return { id: source.id, version: !rebaseScene && previous?.version || version(source), episode_number: source.episode_number, original: !rebaseScene && previous?.original || sceneFields(source), scene: workflowScene.parse({ ...sceneFields(effective), ...change.changes }) }
          })
          if (documents.some(doc => doc.artifact_type === 'episode_script' && context.script().scenes.some(scene => scene.episode_number === doc.episode_number) && !scene_changes.some(change => change.episode_number === doc.episode_number))) revisionProblem('scene_sync_required', '修订分集正文时必须同步对应分场，提供scene_changes', '读取并核对关联场次，提交对应字段的scene_changes；保留场次ID和无关字段。')
          if (draft) {
            for (const document of documents) { const index = draft.documents.findIndex(doc => doc.id === document.id); if (index < 0) draft.documents.push(document); else draft.documents[index] = document }
            draft.scene_changes ||= []
            for (const scene of scene_changes) { const index = draft.scene_changes.findIndex(item => item.id === scene.id); if (index < 0) draft.scene_changes.push(scene); else draft.scene_changes[index] = scene }
            draft.revision_task!.batches += Math.ceil(changes.length / 8)
            return { ...saveTask(draft, data.draft_version!), batches: Math.ceil(changes.length / 8) }
          }
          const impacts = documentDraftImpacts(projectId, docs(), documents, scene_changes.map(change => change.id))
          resultDraft = persistDraft(projectId, { id: newId(), version: newId(), kind: 'patch', summary: data.summary, documents, scene_changes, impacts, status: 'pending' })
          return { draft_id: resultDraft.id, version: resultDraft.version, summary: resultDraft.summary, impacts, batches: Math.ceil(changes.length / 8), saved: false }
        }
        case 'manage_document_draft': {
          const data = schemas.manage_document_draft.parse(args), draft = getToolDraft(projectId, data.draft_id)
          if (!draft || draft.status !== 'pending') problem('没有待确认草稿')
          if (data.operation === 'read') { readDraftVersion = draft.version; resultDraft = draft; return draft }
          canDraft()
          if (data.version !== draft.version) revisionProblem('draft_version_changed', '草稿版本已变化，请重新读取', 'manage_document_draft(read)取得当前version再提交修改；不覆盖并行更改。')
          if (data.operation === 'discard') {
            draft.documents.forEach(doc => checkScope(doc.id))
            if (draft.kind === 'resource' && (context.action || context.workflow)) problem('本轮指定的文档范围与视觉或分镜草稿不一致')
            resultDraft = discardToolDraft(projectId, draft.id, draft.version); return { discarded: true }
          }
          if (readDraftVersion !== draft.version) revisionProblem('draft_requires_read', '修改草稿前请先读取它的当前版本', 'manage_document_draft(read)读取草稿后继续。')
          if (draft.kind === 'resource') {
            if (context.action || context.workflow || data.changes || data.scenes || data.scene_changes) problem('视觉或分镜草稿仅使用resource_values修改当前对象')
            if (!data.resource_values?.length) problem('请提供resource_values')
            const updated = editResourceValues(draft.resource_changes || [], data.resource_values)
            updated.forEach((change, index) => {
              const previous = draft.resource_changes![index]!
              if (change.type === 'visual_profile' && JSON.stringify(change.value) !== JSON.stringify(previous.value)) requireSkills('visual_assets')
              if ((change.type === 'shot' || change.type === 'new_shot') && (previous.type === 'shot' || previous.type === 'new_shot')) {
                if (change.value.image_prompt !== previous.value.image_prompt) requireSkills('image_prompt')
                if (change.value.video_prompt !== previous.value.video_prompt) requireSkills('video_prompt')
                if (Object.keys(change.value).some(key => key !== 'image_prompt' && key !== 'video_prompt' && change.value[key as keyof typeof change.value] !== previous.value[key as keyof typeof previous.value])) requireSkills('storyboard')
              }
            })
            resultDraft = editToolDraft(projectId, draft.id, { version: data.version!, documents: [], resource_values: data.resource_values })
            readDraftVersion = resultDraft.version
            return { draft_id: resultDraft.id, version: resultDraft.version, summary: resultDraft.summary, saved: false }
          }
          if (data.resource_values) problem('文档草稿不能混入视觉或分镜对象')
          if (!data.changes?.length && !data.scene_changes?.length && !data.scenes?.length) problem('请提供草稿修改片段或分场修改')
          if (new Set(data.changes?.map(change => change.document_id)).size !== (data.changes?.length || 0)) problem('同一草稿文档的修改应合并')
          for (const change of data.changes || []) {
            const doc = draft.documents.find(item => item.id === change.document_id)
            if (!doc || change.base_version !== draft.version) problem('草稿文档或版本不一致')
            checkScope(doc.id)
            const edits = resolvePassageEdits(doc.content, draft.version, change.replacements, [[0, doc.content.length]], doc)
            doc.content = applyResolvedEdits(doc.content, edits)
            doc.replacements.push(...edits.map(({ find, replace, reason }) => ({ find, replace, reason })))
          }
          for (const change of data.scene_changes || []) {
            if (change.base_version !== draft.version) problem('草稿场次版本不一致')
            const item = draft.scene_changes?.find(scene => scene.id === change.scene_id)
            if (!item) problem('只能继续修改当前草稿涉及的场次')
            const document = draft.documents.find(doc => doc.artifact_type === 'episode_script' && doc.episode_number === item.episode_number)
            if (!document) problem('草稿缺少对应分集文档')
            checkScope(document.id)
            item.scene = workflowScene.parse({ ...item.scene, ...change.changes })
          }
          if (data.scenes && draft.workflow?.stage !== 'episode') problem('只有新分集草稿可重新整理完整分场；已有分集修订用scene_changes保留ID')
          if (data.summary) draft.summary = data.summary
          draft.impacts = documentDraftImpacts(projectId, docs(), draft.documents, draft.scene_changes?.map(change => change.id) || [])
          if (draft.workflow) draft.workflow = workflowDraftSchema.parse({ ...draft.workflow, artifacts: draft.documents.map(doc => ({ artifact_type: doc.artifact_type, title: doc.title, content: doc.content })), scenes: data.scenes ?? draft.workflow.scenes })
          if (draft.revision_task) return saveTask(draft, data.version!)
          resultDraft = persistDraft(projectId, draft, data.version)
          readDraftVersion = resultDraft.version
          return { draft_id: draft.id, version: draft.version, saved: false }
        }
        case 'commit_document_draft': {
          canDraft(); const data = schemas.commit_document_draft.parse(args), draft = getToolDraft(projectId, data.draft_id)
          if (!initialDraft || !draft || draft.id !== initialDraft.id || draft.version !== initialDraft.version || data.version !== draft.version) problem('只能保存本轮开始前已存在并确认的草稿版本，修改后需重新确认')
          draft.documents.forEach(doc => checkScope(doc.id))
          if (draft.kind === 'resource' && (context.action || context.workflow)) problem('本轮指定的文档范围与视觉或分镜草稿不一致')
          if (!await context.checkApproval(draft)) problem('创作者尚未明确批准保存当前草稿，请展示预览供确认')
          context.signal?.throwIfAborted()
          resultDraft = commitToolDraft(projectId, draft.id, draft.version, context.script); mutated = true
          return { saved: true, draft_id: draft.id, documents: [...draft.documents.map(doc => doc.title), ...draft.resource_changes?.map(change => change.title) || []] }
        }
        default: problem('未知工具，不能执行')
      }
    },
  }
}

const operationLabels: Record<string, string> = {
  load_creation_skills: '加载本次创作技能',
  manage_revision_task: '管理统一修订任务', review_revision_batch: '核对修订结果与关联内容',
  get_project_visual_style: '读取项目画风', set_project_visual_style: '更新已确认画风',
  get_creation_state: '读取创作进度', search_project_content: '查找相关设定', read_documents: '阅读项目文档', record_story_decision: '记录已确认设定', ask_creator: '整理待确认问题',
  create_document_draft: '整理文档草稿', propose_document_patch: '准备局部修改', find_related_content: '检查关联内容', manage_document_draft: '处理已有草稿', commit_document_draft: '确认并保存文档',
  propose_next_step: '确认下一步创作',
  get_document_review_context: '检查文档完整性线索', submit_document_review: '整理专业评审报告',
  read_visual_profiles: '读取视觉设定与参考状态', get_storyboard_context: '读取场次与分镜', propose_visual_profile_draft: '准备视觉设定草稿',
  propose_visual_binding_patch: '准备参考绑定修改', propose_shot_plan: '准备分镜方案', propose_shot_patch: '准备分镜修改',
}
function operationSummary(name: string, result: unknown) {
  const value = result as Record<string, unknown>
  if (name === 'get_project_visual_style') return `已读取项目画风：${value.label}${value.source === 'confirmed_context' ? '；可从已确认来源规范化' : ''}`
  if (name === 'set_project_visual_style') return `项目画风已保存：${(value.project_visual_style as { label: string }).label}；已有素材保留，旧参考图需核对`
  if (name === 'propose_next_step') return '已核验下一步创作，等待创作者选择；尚未生成或保存'
  if (name === 'get_creation_state') return `已读取 ${(value.documents as unknown[]).length} 份文档目录、${(value.decisions as unknown[]).length} 项已确认设定${value.pending_draft ? '，存在待确认草稿' : ''}`
  if (name === 'read_documents') return (value.documents as Array<{ title: string; offset: number; next_offset: number; total_length: number }>).map(doc => `「${doc.title}」已读 ${doc.offset + 1}–${doc.next_offset} / ${doc.total_length} 字`).join('；')
  if (value.saved === false) return `${typeof value.summary === 'string' ? value.summary : '草稿已准备'}；等待确认，尚未写入正式文档`
  if (value.discarded) return '待确认草稿已放弃，正式文档保留'
  if (typeof value.summary === 'string') return value.summary
  if (name === 'commit_document_draft') return `已保存：${(value.documents as string[]).join('、')}`
  if (Array.isArray(value.matches)) return `找到 ${value.matches.length} 条相关线索`
  if (value.recorded) return '已记录创作决定，文档正文尚未同步保存'
  if (value.displayed) return '等待你确认设定'
  return `已完成${operationLabels[name] || '资料处理'}`
}
function activityTargets(name: string, result: unknown) {
  const value = result as Record<string, unknown>
  type Target = { kind: 'document' | 'scene' | 'shot' | 'visual_profile'; id: string; title: string }
  let targets: Target[] = []
  if (name === 'read_documents') targets = (value.documents as ToolDocument[]).map(doc => ({ kind: 'document', id: doc.id, title: doc.title }))
  if (name === 'manage_revision_task' && Array.isArray(value.references)) targets = value.references as Target[]
  if (name === 'read_visual_profiles') targets = (value.profiles as Array<{ id: string; name: string; variant: string }>).map(profile => ({ kind: 'visual_profile', id: profile.id, title: `${profile.name} · ${profile.variant}` }))
  if (name === 'get_storyboard_context') targets = (value.objects as Array<{ type: 'scene' | 'shot'; id: string; heading?: string; title?: string }>).map(item => ({ kind: item.type, id: item.id, title: item.heading || item.title || '未命名' }))
  return targets.slice(0, 100).map(target => ({ ...target, title: target.title.slice(0, 200) }))
}
export async function runScriptTools(context: ToolsContext & {
  model: GenerationModel & { name?: string }; provider: GenerationProvider; prompt: string; resolveKey: (provider: GenerationProvider) => string;
  activity?: ReturnType<typeof activityRecorder>
}) {
  const activity = context.activity || activityRecorder(context.onEvent)
  const registry = activity.start({ kind: 'context', label: 'Function Calling', summary: `本轮已向模型提供 ${scriptFunctions.length} 项函数，由模型按需选择调用`,
    ...activityPreview(scriptFunctions.map(({ name, description }) => ({ name, description })), 'output') })
  activity.finish(registry, 'succeeded')
  const tools = documentTools(context), turn = textToolSession(context.model, context.provider, context.prompt, scriptFunctions, context.resolveKey, context.signal,
    text => context.onEvent({ type: 'progress', text }))
  let outputs: ToolOutput[] = [], finalText = '', calls = 0, forcedRepairs = 0, successes = 0
  let continuation: string | undefined, lastFailure: ToolDiagnostic | undefined, transportFailure: string | undefined
  const failures = new Map<string, { attempts: number; successes: number }>()
  const unresolved = new Map<string, ToolDiagnostic>()
  for (let round = 0; round < 16; round++) {
    context.signal?.throwIfAborted()
    const modelStep = activity.start({ kind: 'model', label: round ? '模型继续处理' : '模型处理请求', name: context.model.name || context.model.remote_id,
      round: round + 1, summary: round ? '根据工具返回的真实结果继续处理' : '正在根据项目资料、对话与已加载的规则处理请求' })
    let response: Awaited<ReturnType<typeof turn>>
    try {
      response = await turn(outputs, continuation)
      continuation = undefined
      activity.finish(modelStep, 'succeeded', { summary: response.calls.length ? `模型提出 ${response.calls.length} 项函数调用` : '模型已返回本轮回复',
        ...(response.text ? activityPreview(response.text, 'output') : {}) })
    } catch (issue) {
      const cancelled = context.signal?.aborted && context.signal.reason?.name === 'AbortError'
      activity.finish(modelStep, cancelled ? 'cancelled' : 'failed', { summary: cancelled ? '已停止模型请求' : `模型请求失败：${issue instanceof Error ? issue.message : String(issue)}`.slice(0, 3000) })
      if (!context.signal?.aborted && tools.result().tool_draft) { transportFailure = issue instanceof Error ? issue.message : String(issue); break }
      throw issue
    }
    if (!response.calls.length) {
      finalText = response.text
      const current = tools.result(), task = current.tool_draft?.revision_task
      if (forcedRepairs < 2 && (lastFailure?.retryable || current.revision_worked && task && task.status !== 'ready' && task.status !== 'needs_attention')) {
        forcedRepairs++
        continuation = '程序执行检查（不是新的创作者授权）：' + (lastFailure ? JSON.stringify(lastFailure) : revisionSummary(current.tool_draft!)) +
          '。本轮尚未完成；请按真实错误的repair重新读取/修正并继续已授权范围内的任务，累积同一草稿并提交最终核对。不要重复原参数、伪造工具成功或只写将来计划；不扩大范围，不自动保存。无法修复则准确说明未完成项。'
        outputs = [] // The previous response already consumed each real call's output.
        const repair = activity.start({ kind: 'context', label: '继续修复未完成项', summary: `第 ${forcedRepairs}/2 次继续处理；沿用真实工具结果和当前任务` })
        activity.finish(repair, 'succeeded')
        continue
      }
      break
    }
    outputs = []
    for (const call of response.calls) {
      calls++
      const label = operationLabels[call.name] || '处理创作资料'
      context.onEvent({ type: 'progress', text: `正在${label}…` })
      let args: unknown
      try { args = JSON.parse(call.arguments) } catch { args = call.arguments }
      const operation = activity.start({ kind: 'tool', name: call.name, label, round: round + 1, summary: `正在${label}`, ...activityPreview(args, 'input') })
      try {
        if (calls > 64) revisionProblem('call_budget_exhausted', '本轮已达到64次函数操作上限，已保留当前进度', '从统一任务继续处理，不需要重建草稿或重复保存。', { retryable: false })
        const signature = revisionHash([call.name, call.arguments]), previous = failures.get(signature)
        if (previous && (previous.attempts >= 3 || previous.successes === successes)) revisionProblem('repeated_failed_call', '相同参数已失败，且没有新的读取或修正，已停止重复执行', '按照前一次diagnostic先读取或修正参数，不能原样重试。', { retryable: false })
        let result = await tools.execute(call.name, JSON.parse(call.arguments))
        successes++
        unresolved.delete(call.name)
        if (call.name === 'manage_document_draft' && (args as { operation?: string })?.operation === 'update') {
          const failure = unresolved.get('propose_document_patch'), changes = (args as { changes?: Array<{ document_id: string }> }).changes
          if (failure?.code === 'pending_draft_exists' || failure?.document_id && changes?.some(change => change.document_id === failure.document_id)) unresolved.delete('propose_document_patch')
        }
        lastFailure = [...unresolved.values()].at(-1)
        if (call.name === 'load_creation_skills') activity.skills((result as { stage: SkillStage }).stage, result as ReturnType<typeof skillContext>)
        context.onEvent({ type: 'process', label, summary: operationSummary(call.name, result) })
        activity.finish(operation, 'succeeded', { summary: operationSummary(call.name, result).slice(0, 3000), targets: activityTargets(call.name, result), ...activityPreview(result, 'output') })
        outputs.push({ id: call.id, output: JSON.stringify({ ok: true, result }) })
      } catch (issue) {
        const diagnostic = toolDiagnostic(issue, args)
        const signature = revisionHash([call.name, call.arguments]), previous = failures.get(signature)
        failures.set(signature, { attempts: (previous?.attempts || 0) + 1, successes })
        lastFailure = diagnostic
        unresolved.set(call.name, diagnostic)
        const error = diagnostic.message
        const cancelled = context.signal?.aborted && context.signal.reason?.name === 'AbortError'
        activity.finish(operation, cancelled ? 'cancelled' : 'failed', { summary: (cancelled ? '已停止此项操作' : `操作未执行：${error}`).slice(0, 3000), ...activityPreview({ error, diagnostic }, 'output') })
        if (context.signal?.aborted) throw issue
        outputs.push({ id: call.id, output: JSON.stringify({ ok: false, error, diagnostic }) })
        context.onEvent({ type: 'process', label, summary: `操作未执行：${error}` })
      }
      if (tools.result().classification) break
    }
    if (tools.result().classification) break
    if (round === 15 || calls >= 64) { finalText = '本轮已达到处理上限，已保留当前进度，可继续原任务。'; break }
  }
  const result = tools.result()
  const incomplete = result.tool_draft?.status === 'pending' && result.tool_draft.revision_task?.status !== 'ready' && !!result.tool_draft.revision_task
  const execution_outcome = incomplete ? { kind: 'partial' as const, summary: revisionSummary(result.tool_draft!), draft_id: result.tool_draft!.id, draft_version: result.tool_draft!.version }
    : transportFailure || lastFailure ? { kind: result.tool_draft ? 'partial' as const : 'failed' as const, summary: `本轮未完整完成：${transportFailure || lastFailure!.message}。${result.tool_draft ? '已保留草稿，请检查后继续。' : '没有成功提交草稿。'}` }
    : undefined
  if (execution_outcome) finalText = execution_outcome.summary + (lastFailure ? `\n处理建议：${lastFailure.repair}` : '')
  return { ...result, ...(execution_outcome ? { execution_outcome } : {}), creation: creationState(context.project.id, context.script()), activity: activity.entries, reply: result.reply || finalText || (result.tool_draft ? '草稿已准备，请检查后确认保存。' : '未获得有效回复，请重试。'),
    stage_context: result.tool_draft?.status === 'saved' || result.tool_draft?.status === 'discarded' ? directorStageContext(context.script()) : toolConversationStage(context.project.id, context.script(), directorStageContext(context.script(), { previous: context.stage }), result.tool_draft?.status === 'pending' ? undefined : context.action),
    // Ordinary text is deliberately unclassified: missed ask_creator calls
    // remain eligible for the existing bounded, cached recognition path.
    ...(result.classification ? { classification_version: replyClassificationVersion, classification_source: 'function_call' as const } :
      result.tool_draft ? { classification: { type: 'other' as const }, classification_version: replyClassificationVersion, classification_source: 'application' as const } : {}),
    completion_kind: result.classification && 'status' in result.classification ? 'creator_interaction' as const : result.tool_draft?.status === 'pending' ? 'draft_review' as const : creationState(context.project.id, context.script()).next_step ? 'next_step' as const : 'explanation' as const }
}
