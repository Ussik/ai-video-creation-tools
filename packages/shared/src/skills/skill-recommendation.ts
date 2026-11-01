export type SkillRecommendationStage = 'script' | 'visual_assets' | 'image_prompt' | 'storyboard' | 'video_prompt'

/** Structured context supplied to the model together with the current task. */
export type SkillTaskContext = {
  text?: string
  workflow_stage?: 'outline' | 'characters' | 'locations' | 'props' | 'episode'
  operation?: 'review' | 'revise'
  focus?: 'character' | 'location' | 'prop'
  purpose?: 'create' | 'refine'
  target_model?: string
  profile_kind?: 'character' | 'location' | 'prop'
}
