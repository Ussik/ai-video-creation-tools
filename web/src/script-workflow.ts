import type { ScriptArtifactType } from './api'

export type WorkflowStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'
export type WorkflowRequest = { stage: WorkflowStage; episode_number: number; target_duration?: number }
export type WorkflowScene = {
  heading: string; location: string; time_of_day: string; characters: string;
  action: string; dialogue: string; narration: string; duration: number; episode_number?: number
}
export type WorkflowArtifact = { artifact_type: ScriptArtifactType; title: string; content: string; episode_number?: number }
export type WorkflowDraft = WorkflowRequest & { artifacts: WorkflowArtifact[]; scenes: WorkflowScene[] }
export const workflowLabels: Record<WorkflowStage, string> = {
  outline: '故事大纲', characters: '人物设定', locations: '场景设计', props: '道具设计', episode: '分集正文',
}
export const workflowStages: WorkflowStage[] = ['outline', 'characters', 'locations', 'props', 'episode']

export function artifactKey(artifact: { artifact_type: string; episode_number?: number }): string {
  return `${artifact.artifact_type}:${artifact.episode_number || 0}`
}
