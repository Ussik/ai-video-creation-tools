import { workflowProgress, missingSavedStageArtifacts, type StageTarget, type WorkflowProgressInput } from '@video-studio/shared/script/script-stage-access'

type DirectorFailureMessage = {
  role: 'assistant' | 'user'
  failed?: boolean
  execution?: {
    title?: string
    targets?: string[]
    outcome?: { kind?: string }
    workflow?: StageTarget
  }
  activity?: Array<{ label?: string; summary?: string; scope?: string }>
}

type DirectorWorkflow = NonNullable<DirectorFailureMessage['execution']>['workflow']

const stageTerms: Record<Exclude<DirectorWorkflow, undefined>['stage'], string[]> = {
  outline: ['大纲', '故事总纲', '分集梗概', '主线'],
  characters: ['人物', '角色', '人物设定', '人物小传'],
  locations: ['场景', '地点', '空间设定'],
  props: ['道具', '物件', '道具清单'],
  episode: ['正文', '分场', '分集剧本', '剧本正文', '第1集', '第2集', '第3集', '第4集', '第5集'],
}

function inferLegacyWorkflow(message: DirectorFailureMessage): DirectorWorkflow | undefined {
  const execution = message.execution
  if (execution?.workflow) return execution.workflow
  const text = [execution?.title, ...(execution?.targets || []), ...(message.activity || []).flatMap(item => [item.label, item.summary])]
    .filter(Boolean).join(' ')
  if (!text) return undefined
  const matches = (Object.entries(stageTerms) as Array<[Exclude<DirectorWorkflow, undefined>['stage'], string[]]>)
    .filter(([, terms]) => terms.some(term => text.includes(term)))
    .map(([stage]) => stage)
  if (/第\s*\d{1,3}\s*集/.test(text) && !matches.includes('episode')) matches.push('episode')
  if (matches.length !== 1) return undefined
  const stage = matches[0]
  if (stage !== 'episode') return { stage, episode_number: 0 }
  const episode = text.match(/第\s*(\d{1,3})\s*集/)
  if (!episode) return undefined
  return { stage, episode_number: Number(episode[1]) }
}

export function isSavedDirectorWorkflow(workflow: DirectorWorkflow | undefined, script: WorkflowProgressInput) {
  if (!workflow) return false
  const progress = workflowProgress(script)
  if (workflow.stage === 'episode') return progress.episodes.includes(workflow.episode_number)
  if (!workflow.artifact_types?.length) return progress.started[workflow.stage]
  const missing = missingSavedStageArtifacts(script, workflow)
  return workflow.artifact_types.every(type => !missing.includes(type))
}

/** A failed workflow attempt remains auditable, but stops being current once its
 * target stage has a later saved result in the project. */
export function isSupersededDirectorFailure(message: DirectorFailureMessage, script: WorkflowProgressInput) {
  if (message.role !== 'assistant' || (!message.failed && !['failed', 'cancelled'].includes(message.execution?.outcome?.kind || ''))) return false
  return isSavedDirectorWorkflow(inferLegacyWorkflow(message), script)
}

export function isSupersededDirectorDraft(message: DirectorFailureMessage, script: WorkflowProgressInput) {
  if (message.role !== 'assistant' || message.execution?.outcome?.kind !== 'draft') return false
  return isSavedDirectorWorkflow(inferLegacyWorkflow(message), script)
}
