import type { ScriptArtifactType } from '../../shared/api/api'
import type { WorkflowDraft, WorkflowScene, WorkflowArtifact, WorkflowRequest } from './script-workflow'
import { artifactKey } from './script-workflow'
import type { DraftImpact } from '@video-studio/shared/script/script-review-types'
import type { ResourceChange } from '@video-studio/shared/script/script-resource-types'
import type { RevisionTask } from '@video-studio/shared/script/script-revision-types'
import type { ScriptExecution } from '@video-studio/shared/script/script-activity-types'
import type { ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import { scriptStageForArtifact } from '@video-studio/shared/script/script-stage-content'
import { scriptReviewGuidance } from '@video-studio/shared/script/script-quality'
import type { SkillTaskContext } from '@video-studio/shared/skills/skill-recommendation'

export type DocumentAction = { operation: 'review' | 'revise'; document_ids: string[]; revision_kind?: 'dialogue' }
/** Match the operation scope the server uses before it loads fixed skills. */
export function scriptOperationSkillTask(action: DocumentAction | null, workflow: WorkflowRequest | null | undefined,
  documents: ReadonlyArray<{ id: string; artifact_type: ScriptArtifactType }>): SkillTaskContext | undefined {
  if (action?.operation === 'review') return { task_kind: 'review' }
  if (action?.revision_kind === 'dialogue') return { task_kind: 'dialogue_revision' }
  if (action) {
    const id = action.document_ids[0]
    const type = documents.find(document => document.id === id)?.artifact_type || (id?.startsWith('legacy:') ? id.slice(7) : undefined)
    const stage = type ? scriptStageForArtifact(type) || 'outline' : undefined
    return { operation: action.operation, ...(stage ? { workflow_stage: stage } : {}) }
  }
  if (workflow) return { workflow_stage: workflow.stage, ...(workflow.intent === 'source_outline' ? { task_kind: 'source_analysis' } : {}) }
  return undefined
}
export type ScriptToolDraft = {
  source_update?: ScriptSourceUpdate;
  source_version?: string | null;
  id: string; version: string; kind: 'create' | 'patch' | 'resource'; summary: string; status: 'pending' | 'saved' | 'discarded';
  workflow?: WorkflowDraft;
  impacts?: DraftImpact[];
  resource_changes?: ResourceChange[];
  revision_task?: RevisionTask;
  scene_changes?: Array<{ id: string; version: string; episode_number: number; original: Omit<WorkflowScene, 'episode_number'>; scene: Omit<WorkflowScene, 'episode_number'> }>;
  documents: Array<{ id: string; artifact_type: ScriptArtifactType; episode_number: number; title: string; content: string; version: string;
    original_content: string; replacements: Array<{ find: string; replace: string; reason: string }> }>
}
export type StoryDecision = { id: string; topic: string; content: string; basis: string; source_text: string; updated_at: string }

export function toolDraftArtifacts(draft: ScriptToolDraft) {
  return draft.documents.map(({ artifact_type, episode_number, title, content }) => ({ artifact_type, episode_number, title, content }))
}

export function toolDraftScenes(draft: ScriptToolDraft): WorkflowScene[] {
  return draft.workflow?.scenes.map(scene => ({ ...scene, episode_number: draft.workflow!.episode_number }))
    || draft.scene_changes?.map(change => ({ ...change.scene, episode_number: change.episode_number })) || []
}

export function toolDraftStage(draft?: ScriptToolDraft): WorkflowRequest | undefined {
  if (draft?.revision_task) return undefined
  if (!draft?.documents.length) return undefined
  if (draft.workflow) return draft.workflow
  const document = draft.documents[0]
  const stage = scriptStageForArtifact(document.artifact_type) || 'outline'
  return { stage, episode_number: stage === 'episode' ? document.episode_number : 0 }
}

export function toolDraftOutcome(draft: ScriptToolDraft): NonNullable<ScriptExecution['outcome']> {
  const task = draft.revision_task, partial = draft.status === 'pending' && task && task.status !== 'ready'
  return { kind: draft.status === 'saved' ? 'saved' : draft.status === 'discarded' ? 'discarded' : partial ? 'partial' : 'draft',
    summary: draft.status === 'saved' ? '当前草稿已写入项目，可以查看保存结果。' : draft.status === 'discarded' ? '草稿已放弃，正式资料保持原状。'
      : partial ? `统一修订尚未完成：已核对 ${task.documents.filter(doc => ['verified', 'unchanged'].includes(doc.status)).length}/${task.documents.length} 份文档，${task.references.filter(ref => ref.status !== 'verified').length} 项关联内容待处理。进度已保留，可继续原任务。`
      : '草稿已准备，尚未写入项目。请预览、编辑后确认保存。', draft_id: draft.id, draft_version: draft.version }
}

/** Show the actual current difference, including manual edits, without relying
 * on an old model replacement list. Common prefix/suffix keep the preview short. */
export function documentChangePreview(before: string, after: string) {
  const oldLines = before.split('\n'), newLines = after.split('\n')
  let start = 0, tail = 0
  while (start < Math.min(oldLines.length, newLines.length) && oldLines[start] === newLines[start]) start++
  while (tail < Math.min(oldLines.length, newLines.length) - start && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  return { changed: before !== after, before: oldLines.slice(start, oldLines.length - tail).join('\n'), after: newLines.slice(start, newLines.length - tail).join('\n') }
}

export function editedToolDraft(draft: ScriptToolDraft, artifacts: WorkflowArtifact[], scenes: WorkflowScene[], resources = draft.resource_changes, sourceUpdate = draft.source_update) {
  if (draft.kind === 'resource') return { changed: JSON.stringify(resources) !== JSON.stringify(draft.resource_changes), input: {
    version: draft.version, documents: [], resource_values: (resources || []).map((change, index) => ({ index, value: change.value })),
  } }
  const documents = draft.documents.map(doc => ({ id: doc.id, content: artifacts.find(item => artifactKey(item) === artifactKey(doc))?.content ?? doc.content }))
  const hasScenes = draft.workflow?.stage === 'episode' || Boolean(draft.scene_changes?.length)
  const sourceChanged = !!draft.source_update && !!sourceUpdate && sourceUpdate.content !== draft.source_update.content
  const changed = documents.some((doc, index) => doc.content !== draft.documents[index].content)
    || hasScenes && JSON.stringify(scenes) !== JSON.stringify(toolDraftScenes(draft))
    || sourceChanged
  return { changed, input: { version: draft.version, documents, ...(sourceChanged ? { source_content: sourceUpdate!.content } : {}), ...(hasScenes ? { scenes: scenes.map(({ episode_number: _episode, ...scene }) => scene) } : {}) } }
}

export function documentTaskPrompt(title: string, operation: DocumentAction['operation'] | 'dialogue') {
  if (operation === 'dialogue') return `请读取「${title}」全文和相关人物设定，进行台词专项修订。保留剧情事件、角色关系、知情范围、关键线索、时长与题材语言风格，逐字保留动作、旁白及其他非台词内容。先明确每场人物的交流目标、阻力和不愿直说的内容，再修订说明书式解释、空泛宣言、同质口吻及重复对白。结合已有动作、反应或沉默理解潜台词，只修改人物说出口的台词，不机械删长句、口头语或金句，不添加无依据的情节。对应分场仅同步dialogue字段，提交可预览的修订草稿，等待我确认保存。`
  return operation === 'review' ? `请读取「${title}」全文，结合已有大纲、相关文档和已确认决定进行评审。指出待定或缺失设定、矛盾及有证据的创作质量问题，引用原文证据并给出建议。只分析，先不要修改或保存。\n${scriptReviewGuidance}`
    : `请读取「${title}」原文。我希望修改：`
}
