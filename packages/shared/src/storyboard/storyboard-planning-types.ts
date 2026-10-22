export interface StoryboardReferenceBudget {
  max_images: number
  storyboard_images: number
  max_setting_images: number
}
export interface StoryboardShotDraft {
  shot_id?: string | null
  title: string
  prompt: string
  image_prompt: string
  video_prompt: string
  duration: number
  start_state: string
  end_state: string
  cut_note: string
}
export interface StoryboardSceneDraft {
  scene_id: string
  scene_heading: string
  scene_duration: number
  shots: StoryboardShotDraft[]
}
export interface StoryboardPlanningContext {
  signature: string
  reference_budget?: StoryboardReferenceBudget
  scenes: Array<{ id: string; heading: string; duration: number; episode_number: number; planned: boolean; needs_replan?: boolean; replan_reason?: string;
    shot_count: number; canvas_shot_count?: number; material_count: number }>
  existing_shots: Array<StoryboardShotDraft & { shot_id: string; scene_id: string }>
  documents: Array<{ id: string; title: string; artifact_type: string; episode_number: number; characters: number }>
  default_document_ids?: string[]
  skills: Array<{ id: string; name: string; description: string; revision: string }>
  default_skill_ids?: string[]
  skill_policy?: { stage: 'script' | 'visual_assets' | 'image_prompt' | 'storyboard' | 'video_prompt'; label: string; primary_id: string | null;
    auxiliary_ids: string[]; source: 'global' | 'project'; warning: string; skills: Array<{ id: string; name: string; description: string; revision: string }> }
  reference_preparation?: {
    signature: string
    scene_ids: string[]
    needs_analysis: string[]
    default_skill_ids: string[]
    skill_policy?: StoryboardPlanningContext['skill_policy']
  }
  project: { name: string; brief: string; ratio: string; style: string }
}
export interface StoryboardPlanningResult {
  signature: string
  mode?: 'redesign' | 'update'
  instructions?: string
  scenes: StoryboardSceneDraft[]
  used_skills: Array<{ id: string; name: string; revision: string; files: string[] }>
  source_documents: Array<{ id: string; title: string }>
}
