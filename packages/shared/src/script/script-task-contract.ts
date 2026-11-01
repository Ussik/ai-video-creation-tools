import { scriptArtifactLabels, scriptStageArtifacts, type ScriptStage, type StageArtifactType } from './script-stage-content.js'

export type ScriptTaskIntent = 'source_outline' | 'stage_design'
export type ScriptTaskContract = {
  stage: ScriptStage; operation?: 'generate' | 'revise' | 'supplement' | 'regenerate';
  intent?: ScriptTaskIntent; artifact_types?: StageArtifactType[]
}

/** An absent contract keeps historical whole-stage drafts readable. New runs
 * declare their deliverables before any model call. */
export function scriptTaskArtifactTypes(request: ScriptTaskContract): StageArtifactType[] {
  return [...(request.artifact_types || scriptStageArtifacts[request.stage])]
}

export function scriptTaskDeliverables(request: ScriptTaskContract): string {
  return scriptTaskArtifactTypes(request).map(type => scriptArtifactLabels[type]).join('、')
}

export function scriptTaskAcceptance(request: ScriptTaskContract): string[] {
  const scope = scriptTaskDeliverables(request)
  return request.intent === 'source_outline' ? [
    `仅交付本次约定的${scope}，忠实整理完整原稿中的人物、事件、因果、顺序和已有结局。`,
    '原稿未说明的谜底、规则、结局或制作信息如实保留未知，不补造，也不因此阻断大纲交付。',
    '只将有证据的原稿失真、关键事件遗漏或文本自身矛盾作为必须修正的问题；文风建议和后续深化不阻断。',
  ] : [
    `仅验收本次约定的${scope}；其他栏目及后续阶段不属于本任务的缺失项。`,
    '交付完整可读的正文，落实创作者要求及已确认决定，保持人物、事件、规则与时间线一致。',
    '仅有证据且影响本次交付的事实冲突、必要内容缺失或明确要求未落实才阻断；可选深化和文风建议单独呈现。',
  ]
}

/** Ordinary outline generation has one useful first deliverable. A complete
 * design package remains available through an explicit contract or supplement. */
export function initialScriptTaskContract<T extends ScriptTaskContract>(request: T, hasSource: boolean): T {
  if (request.stage !== 'outline' || request.artifact_types || request.operation && request.operation !== 'generate') return request
  const explicitCompleteDesign = request.intent === 'stage_design'
  const intent = request.intent || (hasSource ? 'source_outline' : 'stage_design')
  return { ...request, intent, artifact_types: explicitCompleteDesign ? [...scriptStageArtifacts.outline] : ['outline'] }
}
