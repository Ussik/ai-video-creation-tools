export type SkillRecommendationStage = 'script' | 'visual_assets' | 'image_prompt' | 'storyboard' | 'video_prompt'

export const skillTaskDefinitions = [
  { kind: 'story_develop', stage: 'script', label: '故事与大纲设计', primary_name: 'short-drama-develop' },
  { kind: 'source_analysis', stage: 'script', label: '原著分析', primary_name: 'short-drama-novel-analyze' },
  { kind: 'script_write', stage: 'script', label: '分集正文写作', primary_name: 'short-drama-write' },
  { kind: 'dialogue_revision', stage: 'script', label: '台词专项修订', primary_name: 'sw-dialogue' },
  { kind: 'visual_assets', stage: 'visual_assets', label: '视觉设定整理', primary_name: 'short-drama-assets' },
  { kind: 'image_prompt', stage: 'image_prompt', label: '图片提示词整理', primary_name: 'short-drama-image-prompts' },
  { kind: 'storyboard', stage: 'storyboard', label: '分镜规划', primary_name: 'short-drama-storyboard' },
  { kind: 'video_prompt', stage: 'video_prompt', label: '视频提示词整理', primary_name: 'short-drama-video-prompts' },
  { kind: 'review', stage: 'script', label: '剧本文档审稿', primary_name: 'short-drama-review' },
] as const

export type SkillTaskKind = typeof skillTaskDefinitions[number]['kind']

export type VideoPromptDialect = 'seedance-2.0' | 'seedance-2.5' | 'minimax-h3' | 'wan-3.0'
export type SkillIntegrationScope = { mode: 'rules_only'; tool_requirements: string[]; note: string }
export type SkillCatalogEntry = {
  id: string; name: string; description: string; revision: string;
  /** Optional for compatibility with older servers and saved policy fixtures. */
  integration?: SkillIntegrationScope
}

/** Explicit operation context; free discussion need not select a fixed task. */
export type SkillTaskContext = {
  /** Server-owned discussion context; focus alone does not authorize a fixed operation. */
  selection_mode?: 'model'
  task_kind?: SkillTaskKind
  text?: string
  workflow_stage?: 'outline' | 'characters' | 'locations' | 'props' | 'episode'
  operation?: 'review' | 'revise'
  focus?: 'character' | 'location' | 'prop'
  purpose?: 'create' | 'refine'
  target_model?: string
  /** Resolved from the configured generation model, never from creative task prose. */
  target_dialect?: VideoPromptDialect
  profile_kind?: 'character' | 'location' | 'prop'
}

export function fixedSkillTask(stage: SkillRecommendationStage, context: SkillTaskContext = {}): SkillTaskKind | undefined {
  if (context.selection_mode === 'model') return undefined
  if (context.task_kind) return skillTaskDefinitions.find(task => task.kind === context.task_kind && task.stage === stage)?.kind
  if (stage !== 'script') return stage
  if (context.operation === 'review') return 'review'
  if (context.workflow_stage === 'episode') return 'script_write'
  if (context.workflow_stage) return 'story_develop'
  return undefined
}
