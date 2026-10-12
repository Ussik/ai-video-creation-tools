import { missingStageArtifacts, scriptStageOrder, type ScriptStage } from './script-stage-content.js'

export const stageOperations = ['generate', 'revise', 'supplement', 'regenerate'] as const
export type StageOperation = typeof stageOperations[number]
export type StageTarget = { stage: ScriptStage; episode_number: number; operation?: StageOperation }
export type WorkflowProgressInput = {
  outline?: string; characters?: string;
  artifacts?: Array<{ artifact_type: string; content: string; episode_number?: number; status?: string }>;
  scenes?: Array<{ episode_number?: number }>;
  generation_options?: { episode_count?: number; core_hook?: string; story_structure?: string; character_notes?: string };
}
export const stageLabels: Record<ScriptStage, string> = {
  outline: '故事大纲', characters: '人物设定', locations: '场景设计', props: '道具设计', episode: '分集剧本',
}

/** Compatibility is based on saved primary documents; missing new sections are
 * reported separately so historical projects keep their saved progress. */
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
  const completed: Record<ScriptStage, boolean> = {
    outline: has('outline') || legacy('outline', script.outline),
    characters: has('characters') || legacy('characters', script.characters),
    locations: has('locations'), props: has('props'), episode: nextEpisode === null,
  }
  const missing = scriptStageOrder.filter(stage => !completed[stage])
  return { completed, missing, next_stage: missing[0] || null, next_episode: nextEpisode, episodes }
}

export function savedStageArtifacts(script: WorkflowProgressInput, target: StageTarget) {
  const artifacts = (script.artifacts || []).filter(item => item.status !== 'draft' && item.content.trim()
    && (item.episode_number || 0) === (target.stage === 'episode' ? target.episode_number : 0))
  for (const type of ['outline', 'characters'] as const) if (script[type]?.trim()
    && !(script.artifacts || []).some(item => item.artifact_type === type && !item.episode_number)) {
    artifacts.push({ artifact_type: type, content: script[type]! })
  }
  return artifacts
}

export function missingSavedStageArtifacts(script: WorkflowProgressInput, target: StageTarget) {
  return missingStageArtifacts(target.stage, savedStageArtifacts(script, target))
}

/** Both the API and UI use the same first-generation boundary. Revisit actions
 * never roll back progress or grant permission to rewrite other stages. */
export function stageOperationError(script: WorkflowProgressInput, target: StageTarget): string | null {
  const progress = workflowProgress(script)
  const saved = target.stage === 'episode' ? progress.episodes.includes(target.episode_number) : progress.completed[target.stage]
  const operation = target.operation || 'generate'
  if (!saved && (target.stage !== progress.next_stage || target.stage === 'episode' && target.episode_number !== progress.next_episode)) {
    return progress.next_stage ? `请先完成并保存${progress.next_stage === 'episode' ? `第 ${progress.next_episode} 集正文` : stageLabels[progress.next_stage]}，再生成后续阶段`
      : '已设定阶段均已保存，请选择已有成果进行修改'
  }
  if (!saved && operation !== 'generate') return '此阶段尚未保存，请先生成当前阶段草稿'
  if (saved && operation === 'generate') return '此阶段已保存，请选择局部修改、补齐栏目或重新设计'
  if (saved && operation === 'supplement' && !missingSavedStageArtifacts(script, target).length) return '此阶段栏目已齐全，无需补齐'
  return null
}
