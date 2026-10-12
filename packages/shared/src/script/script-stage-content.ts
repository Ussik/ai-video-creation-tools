export type ScriptStage = 'outline' | 'characters' | 'locations' | 'props' | 'episode'

/** The same deliverables are used by stage prompts, model validation and the UI. */
export const scriptStageArtifacts = {
  outline: ['outline', 'synopsis', 'world', 'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints', 'episode_outline'],
  characters: ['characters', 'relationships'],
  locations: ['locations', 'location_layouts', 'location_atmosphere', 'location_continuity'],
  props: ['props', 'prop_visuals', 'prop_functions', 'prop_continuity'],
  episode: ['episode_script'],
} as const satisfies Record<ScriptStage, readonly string[]>

export const scriptArtifactLabels = {
  outline: '概要设计', synopsis: '故事简述', world: '背景设定', structure: '全剧分段',
  hooks: '钩子预设', foreshadowing: '伏笔与回收', reversals: '反转预设', constraints: '创作禁区',
  episode_outline: '分集大纲', characters: '人物小传', relationships: '人物关系',
  locations: '场景清单', location_layouts: '空间与动线', location_atmosphere: '视觉与氛围', location_continuity: '场景连续性',
  props: '道具清单', prop_visuals: '外观与辨识', prop_functions: '剧情功能与使用规则', prop_continuity: '归属与状态流转',
  episode_script: '分集正文',
} as const

export type StageArtifactType = keyof typeof scriptArtifactLabels
/** Shared enum for generation, persistence and reference validation. */
export const scriptArtifactTypes = Object.keys(scriptArtifactLabels) as [StageArtifactType, ...StageArtifactType[]]
export const scriptStageOrder: ScriptStage[] = ['outline', 'characters', 'locations', 'props', 'episode']

export function scriptStageForArtifact(type: string): ScriptStage | undefined {
  return scriptStageOrder.find(stage => (scriptStageArtifacts[stage] as readonly string[]).includes(type))
}

export const maxStageArtifacts = Math.max(...Object.values(scriptStageArtifacts).map(types => types.length))

export function scriptStageDeliverables(stage: ScriptStage): string {
  return scriptStageArtifacts[stage].map(type => scriptArtifactLabels[type]).join('、')
}

export function missingStageArtifacts(stage: ScriptStage, artifacts: ReadonlyArray<{ artifact_type: string; content: string }>): StageArtifactType[] {
  const present = new Set(artifacts.filter(artifact => artifact.content.trim()).map(artifact => artifact.artifact_type))
  return scriptStageArtifacts[stage].filter(type => !present.has(type))
}
