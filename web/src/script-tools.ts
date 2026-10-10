import type { ScriptArtifactType } from './api'
import type { WorkflowDraft, WorkflowScene, WorkflowArtifact, WorkflowRequest } from './script-workflow'
import { artifactKey } from './script-workflow'
import type { DraftImpact } from '../../backend/src/script-review-types'
import type { ResourceChange } from '../../backend/src/script-resource-types'
import type { RevisionTask } from '../../backend/src/script-revision-types'
import type { ScriptExecution } from '../../backend/src/script-activity-types'

export type DocumentAction = { operation: 'review' | 'revise'; document_ids: string[] }
export type ScriptToolDraft = {
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
  const stage = document.artifact_type === 'episode_script' ? 'episode' : ['characters', 'relationships'].includes(document.artifact_type) ? 'characters' : document.artifact_type === 'locations' ? 'locations' : document.artifact_type === 'props' ? 'props' : 'outline'
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

export function editedToolDraft(draft: ScriptToolDraft, artifacts: WorkflowArtifact[], scenes: WorkflowScene[], resources = draft.resource_changes) {
  if (draft.kind === 'resource') return { changed: JSON.stringify(resources) !== JSON.stringify(draft.resource_changes), input: {
    version: draft.version, documents: [], resource_values: (resources || []).map((change, index) => ({ index, value: change.value })),
  } }
  const documents = draft.documents.map(doc => ({ id: doc.id, content: artifacts.find(item => artifactKey(item) === artifactKey(doc))?.content ?? doc.content }))
  const hasScenes = draft.workflow?.stage === 'episode' || Boolean(draft.scene_changes?.length)
  const changed = documents.some((doc, index) => doc.content !== draft.documents[index].content)
    || hasScenes && JSON.stringify(scenes) !== JSON.stringify(toolDraftScenes(draft))
  return { changed, input: { version: draft.version, documents, ...(hasScenes ? { scenes: scenes.map(({ episode_number: _episode, ...scene }) => scene) } : {}) } }
}

export function documentTaskPrompt(title: string, operation: DocumentAction['operation']) {
  return operation === 'review' ? `请读取「${title}」全文，结合已有大纲、相关文档和已确认决定进行评审。指出待定或缺失设定、矛盾、人物动机与剧情作用方面的问题，引用原文证据并给出建议。只分析，先不要修改或保存。`
    : `请读取「${title}」原文。我希望修改：`
}
