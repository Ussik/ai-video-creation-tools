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
