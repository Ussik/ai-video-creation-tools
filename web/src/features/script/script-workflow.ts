import { workflowProgress, type WorkflowProgressInput, type StageOperation } from '@video-studio/shared/script/script-stage-access'
import type { ScriptArtifactType } from '../../shared/api/api'
import { scriptStageDeliverables } from '@video-studio/shared/script/script-stage-content'
import { scriptCreativeAuthorityGuidance } from '@video-studio/shared/script/script-setting-completeness'
import type { CreationNextStep } from '@video-studio/shared/script/script-creation-state-types'

export type WorkflowStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export type WorkflowRequest = { operation?: StageOperation; stage: WorkflowStage; scope?: 'project' | 'episode'; episode_number: number; target_duration?: number }
export type WorkflowScene = {
  source_scene_id?: string;
  heading: string; location: string; time_of_day: string; characters: string;
  action: string; dialogue: string; narration: string; duration: number; episode_number?: number
}
export type WorkflowArtifact = { artifact_type: ScriptArtifactType; title: string; content: string; episode_number?: number }
export type WorkflowDraft = WorkflowRequest & { source_version?: string | null; artifacts: WorkflowArtifact[]; scenes: WorkflowScene[] }
export const workflowLabels: Record<WorkflowStage, string> = {
  outline: '全剧故事大纲', characters: '全剧人物设定', locations: '全剧场景设计', props: '全剧道具设计', episode: '指定集正文',
}
export const workflowStages: WorkflowStage[] = ['outline', 'characters', 'locations', 'props', 'episode']

export const exploreStoryDirectionMessage = '基于当前对话，给我几个故事方向供选择。保留已经确认的设定，说明各方向的区别。'
export const outlineGenerationPrerequisite = '先输入故事创意，或在对话中选定故事方向，再生成故事大纲。'

/** A request for alternatives is not a story brief. Use supplied source text,
 * saved story facts or the current proposal instead of any chat message. */
export function outlineGenerationIssue(script: WorkflowProgressInput, context: {
  input?: string; brief?: string; referenceContents?: string[];
  nextStep?: Pick<CreationNextStep, 'stage' | 'purpose'> | null;
} = {}): string | null {
  const sourceText = (value?: string) => !!value?.trim() && value.trim() !== exploreStoryDirectionMessage
  if (sourceText(context.input) || sourceText(context.brief) || context.referenceContents?.some(sourceText) ||
    context.nextStep?.stage === 'outline' && context.nextStep.purpose === 'generate' ||
    script.outline?.trim() || script.characters?.trim() || script.scenes?.length ||
    script.artifacts?.some(artifact => artifact.status !== 'draft' && artifact.content.trim()) ||
    [script.generation_options?.core_hook, script.generation_options?.story_structure, script.generation_options?.character_notes].some(sourceText)) return null
  return outlineGenerationPrerequisite
}

export function workflowRequestForStage(stage: WorkflowStage, episodeNumber: number, duration?: number, operation?: StageOperation): WorkflowRequest {
  return stage === 'episode' ? { ...(operation ? { operation } : {}), stage, scope: 'episode', episode_number: episodeNumber, ...(duration !== undefined ? { target_duration: duration } : {}) }
    : { ...(operation ? { operation } : {}), stage, scope: 'project', episode_number: 0 }
}

export function workflowInstruction(request: WorkflowRequest, label?: string): string {
  const action = label || (request.stage === 'episode' ? `开始写第 ${request.episode_number} 集完整正文` : `生成${workflowLabels[request.stage]}`)
  const behavior = request.operation === 'regenerate' ? request.stage === 'episode'
    ? '先读完本集已保存正文和全部分场，结合最新要求重新设计本集完整正文及对应分场草稿；保留文档ID，每个已有场次通过source_scene_id保留原ID和镜头关联，可调整顺序和补充新场次，不删除已有场次。全剧资料及其他集只作承接参考。'
    : '先读取所选阶段全部已保存文档，结合最新要求重新设计整阶段，输出所有栏目完整的新草稿；保留文档ID，其他阶段及分集只作参考。'
    : request.operation === 'supplement' ? '先读完所选阶段已有文档，原样保留其标题和正文，只补齐缺失栏目。'
    : request.operation === 'revise' ? '读取所选阶段原文，仅按本次要求提出局部修订草稿，保留未涉及内容和场次ID。' : ''
  return `${action}。${behavior}本阶段完整包含：${scriptStageDeliverables(request.stage)}，各项提供具体完整的正文。${request.stage === 'episode' ? `仅处理第 ${request.episode_number} 集正文，承接全剧设定和前集，不改动其他集。` : '范围是整个故事的全剧资料，不是当前集或下一集；保留已确认各集内容，不生成或改写分集正文。'}基于当前对话已确认的信息整理，沿用我明确交给模型决定后已经作出的具体设定，不再将这些设定标为待定，生成草稿供我确认。\n${scriptCreativeAuthorityGuidance}`
}

export function artifactKey(artifact: { artifact_type: string; episode_number?: number }): string {
  return `${artifact.artifact_type}:${artifact.episode_number || 0}`
}

export { workflowProgress } from '@video-studio/shared/script/script-stage-access'
export type { WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'


export type DirectorStageContext = {
  stage: WorkflowStage | null; episode_number: number | null;
  mode: 'default' | 'explicit' | 'review' | 'complete'; progress_key: string;
}
export type DirectorInteraction = {
  stage: WorkflowStage; purpose: 'setting' | 'generate' | 'revise'; episode_number?: number;
}

export function workflowProgressKey(script: WorkflowProgressInput): string {
  const progress = workflowProgress(script)
  return JSON.stringify([progress.completed, progress.episodes, progress.next_episode])
}

export function directorStageContext(script: WorkflowProgressInput, options: {
  pending?: { stage: WorkflowStage; episode_number: number };
  explicit?: { stage: WorkflowStage; episode_number: number };
  previous?: DirectorStageContext;
} = {}): DirectorStageContext {
  const progress = workflowProgress(script), progress_key = workflowProgressKey(script)
  const selected = options.pending || options.explicit
  if (selected) return { stage: selected.stage, episode_number: selected.stage === 'episode' ? selected.episode_number : null,
    mode: options.pending ? 'review' : 'explicit', progress_key }
  if (options.previous?.mode === 'explicit' && options.previous.progress_key === progress_key) return options.previous
  return { stage: progress.next_stage, episode_number: progress.next_stage === 'episode' ? progress.next_episode : null,
    mode: progress.next_stage ? 'default' : 'complete', progress_key }
}

/** Topic is not stage: a protagonist question can serve the outline. Document
 * transitions must match the current stage and wait for confirmed saving. */
export function allowsDirectorInteraction(interaction: DirectorInteraction | undefined, context: DirectorStageContext): boolean {
  if (!interaction || !context.stage || interaction.stage !== context.stage) return false
  if (interaction.stage === 'episode' && interaction.episode_number !== context.episode_number) return false
  if (interaction.purpose === 'setting') return true
  if (context.mode === 'review' || context.mode === 'complete') return false
  return interaction.purpose !== 'revise' || context.mode === 'explicit'
}


export function readDirectorInteraction(value: unknown): DirectorInteraction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as DirectorInteraction
  if (!workflowStages.includes(item.stage) || !['setting', 'generate', 'revise'].includes(item.purpose)) return undefined
  if (item.episode_number !== undefined && (!Number.isInteger(item.episode_number) || item.episode_number < 1 || item.episode_number > 200)) return undefined
  if (item.stage === 'episode' && item.episode_number === undefined) return undefined
  return { stage: item.stage, purpose: item.purpose, ...(item.episode_number !== undefined ? { episode_number: item.episode_number } : {}) }
}
