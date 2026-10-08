import type { ScriptArtifactType } from './api'

export type WorkflowStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export type WorkflowRequest = { stage: WorkflowStage; scope?: 'project' | 'episode'; episode_number: number; target_duration?: number }
export type WorkflowScene = {
  heading: string; location: string; time_of_day: string; characters: string;
  action: string; dialogue: string; narration: string; duration: number; episode_number?: number
}
export type WorkflowArtifact = { artifact_type: ScriptArtifactType; title: string; content: string; episode_number?: number }
export type WorkflowDraft = WorkflowRequest & { artifacts: WorkflowArtifact[]; scenes: WorkflowScene[] }
export const workflowLabels: Record<WorkflowStage, string> = {
  outline: '全剧故事大纲', characters: '全剧人物设定', locations: '全剧场景设计', props: '全剧道具设计', episode: '指定集正文',
}
export const workflowStages: WorkflowStage[] = ['outline', 'characters', 'locations', 'props', 'episode']

export function workflowRequestForStage(stage: WorkflowStage, episodeNumber: number, duration?: number): WorkflowRequest {
  return stage === 'episode' ? { stage, scope: 'episode', episode_number: episodeNumber, ...(duration !== undefined ? { target_duration: duration } : {}) }
    : { stage, scope: 'project', episode_number: 0 }
}

export function workflowInstruction(request: WorkflowRequest, label?: string): string {
  const action = label || (request.stage === 'episode' ? `开始写第 ${request.episode_number} 集完整正文` : `生成${workflowLabels[request.stage]}`)
  return `${action}。${request.stage === 'episode' ? `仅处理第 ${request.episode_number} 集正文，承接全剧设定和前集，不改动其他集。` : '范围是整个故事的全剧资料，不是当前集或下一集；保留已确认各集内容，不生成或改写分集正文。'}基于当前对话已确认的信息整理，沿用我明确交给模型决定后已经作出的具体设定，不再将这些设定标为待定；其他尚未确定且未授权模型决定的设定标为待定，生成草稿供我确认。`
}

export function artifactKey(artifact: { artifact_type: string; episode_number?: number }): string {
  return `${artifact.artifact_type}:${artifact.episode_number || 0}`
}

export type WorkflowProgressInput = {
  outline?: string; characters?: string;
  artifacts?: Array<{ artifact_type: string; content: string; episode_number?: number; status?: string }>;
  scenes?: Array<{ episode_number?: number }>;
  generation_options?: { episode_count?: number };
}

/** Recommendations use saved project documents, never a last-clicked stage or a pending draft. */
export function workflowProgress(script: WorkflowProgressInput) {
  const artifacts = script.artifacts || []
  const ready = artifacts.filter(item => item.status !== 'draft' && item.content.trim())
  const has = (type: string) => ready.some(item => item.artifact_type === type && !item.episode_number)
  const legacy = (type: string, content?: string) => !artifacts.some(item => item.artifact_type === type && !item.episode_number) && !!content?.trim()
  const episodes = [...new Set([
    ...ready.filter(item => item.artifact_type === 'episode_script').map(item => item.episode_number || 0),
    ...(script.scenes || []).map(item => item.episode_number || 0),
  ].filter(number => Number.isInteger(number) && number > 0 && number <= 200))].sort((a, b) => a - b)
  const count = Math.min(200, Math.max(1, script.generation_options?.episode_count || 200))
  const nextEpisode = Array.from({ length: count }, (_, index) => index + 1).find(number => !episodes.includes(number)) || null
  const completed: Record<WorkflowStage, boolean> = {
    outline: has('outline') || legacy('outline', script.outline),
    characters: has('characters') || legacy('characters', script.characters),
    locations: has('locations'), props: has('props'), episode: nextEpisode === null,
  }
  const missing = workflowStages.filter(stage => !completed[stage])
  return { completed, missing, next_stage: missing[0] || null, next_episode: nextEpisode, episodes }
}


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
