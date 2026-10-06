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

// Only explicit production requests enter the document workflow; discussion
// about a document continues through the normal conversational endpoint.
export function workflowFromMessage(text: string, targetDuration?: number): WorkflowRequest | undefined {
  const source = text.trim()
  const episode = source.match(/^(?:请|帮我|现在)?\s*(?:开始写|继续写|生成|撰写|重写|写|重新生成)\s*第\s*(\d+)\s*集(?:的)?(?:分场正文|剧本|正文|草稿)?[。！!]?$/)
  if (episode) {
    const number = Number(episode[1])
    return number >= 1 && number <= 200 ? { stage: 'episode', episode_number: number, target_duration: targetDuration } : undefined
  }
  const stageMatch = source.match(/^(?:请|帮我)?\s*(?:先整理|整理|生成|补充|完善|重写)\s*(故事大纲|人物设定|人物关系|场景设计|道具设计)[。！!]?$/)
  const stages: Record<string, WorkflowStage> = { 故事大纲: 'outline', 人物设定: 'characters', 人物关系: 'characters', 场景设计: 'locations', 道具设计: 'props' }
  return stageMatch ? { stage: stages[stageMatch[1]]!, episode_number: 1 } : undefined
}

export function explicitSeriesSpecs(text: string): { episode_count?: number; target_duration?: number } {
  const count = text.match(/(?:总共|一共|总计|共|总集数[为是：:]?)\s*(\d+)\s*集/)
  const duration = text.match(/每集(?:约|大约|时长约|时长)?\s*(\d+)\s*秒/)
  const episode_count = Number(count?.[1])
  const target_duration = Number(duration?.[1])
  return {
    ...(episode_count >= 1 && episode_count <= 200 ? { episode_count } : {}),
    ...(target_duration >= 5 && target_duration <= 600 ? { target_duration } : {}),
  }
}

export function artifactKey(artifact: { artifact_type: string; episode_number?: number }): string {
  return `${artifact.artifact_type}:${artifact.episode_number || 0}`
}
