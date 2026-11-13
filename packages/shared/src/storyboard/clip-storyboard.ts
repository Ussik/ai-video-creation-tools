import type { StoryboardPlanningContext, StoryboardShotDraft } from './storyboard-planning-types.js'

export type ClipStoryboardShotDraft = Omit<StoryboardShotDraft, 'shot_id'>
export interface ClipStoryboardContext {
  signature: string
  project: StoryboardPlanningContext['project']
  skills: StoryboardPlanningContext['skills']
  default_skill_ids: string[]
  skill_policy: NonNullable<StoryboardPlanningContext['skill_policy']>
}
export interface ClipStoryboardPlanInput {
  signature: string
  source_text: string
  total_duration: number
  instructions: string
  shots_count?: number
  model_id: string
  skill_ids?: string[]
  target_video_model_id?: string
}
export interface ClipStoryboardCommitInput {
  request_id: string
  review_id?: string
  signature: string
  source_text: string
  total_duration: number
  instructions: string
  shots: ClipStoryboardShotDraft[]
  target_video_model_id?: string
}
export interface ClipStoryboardResult {
  signature: string
  source_text: string
  total_duration: number
  instructions: string
  target_video_model_id?: string
  shots: ClipStoryboardShotDraft[]
  used_skills: Array<{ id: string; name: string; revision: string; files: string[]; role?: 'primary' | 'auxiliary' }>
  skill_assignment: { ids: string[]; source: 'manual' | 'automatic' | 'default' | 'fixed'; reason: string }
  motion_skills?: ClipStoryboardResult['used_skills']
  directing_review?: import('./storyboard-planning-types.js').StoryboardPlanningResult['directing_review']
}
export interface ClipStoryboardCanvasInput { design_id: string; shot_ids: string[] }
