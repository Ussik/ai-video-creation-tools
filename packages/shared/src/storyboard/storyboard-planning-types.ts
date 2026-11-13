import type { VideoAudioPlan } from '../media/video-prompt-audio.js'
import type { StoryboardContinuityPlan } from './storyboard-continuity.js'

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
  /** Missing only for saved legacy plans that have not been analyzed yet. */
  audio_plan?: VideoAudioPlan | null
  continuity_plan?: StoryboardContinuityPlan | null
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
  /** Durable task endpoints are available when this capability is present. */
  planning_task_version?: 1
  signature: string
  reference_budget?: StoryboardReferenceBudget
  scenes: Array<{ id: string; heading: string; duration: number; episode_number: number; planned: boolean; needs_replan?: boolean; replan_reason?: string;
    shot_count: number; canvas_shot_count?: number; material_count: number; has_previous_plan?: boolean; requires_redesign?: boolean }>
  existing_shots: Array<StoryboardShotDraft & { shot_id: string; scene_id: string }>
  documents: Array<{ id: string; title: string; artifact_type: string; episode_number: number; characters: number }>
  default_document_ids?: string[]
  skills: Array<{ id: string; name: string; description: string; revision: string }>
  default_skill_ids?: string[]
  skill_policy?: { stage: 'script' | 'visual_assets' | 'image_prompt' | 'storyboard' | 'video_prompt'; label: string; primary_id: string | null;
    auxiliary_ids: string[]; source: 'builtin' | 'global' | 'project'; warning: string; skills: Array<{ id: string; name: string; description: string; revision: string }> }
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
  /** Omitted for legacy previews and plans preserving the source estimate. */
  duration_mode?: 'preserve' | 'reestimate'
  instructions?: string
  target_video_model_id?: string
  scenes: StoryboardSceneDraft[]
  used_skills: Array<{ id: string; name: string; revision: string; files: string[] }>
  motion_skills?: StoryboardPlanningResult['used_skills']
  skill_assignment?: unknown
  motion_skill_assignment?: unknown
  /** Text design review only; manual preview edits invalidate this snapshot. */
  directing_review?: {
    status: 'passed' | 'warnings' | 'edited' | 'needs_work' | 'pending_review' | 'inconclusive'
    review_id?: string
    source_signature?: string
    reviewed_at?: string
    error?: { code: string; message: string; retryable?: boolean }
    repaired: boolean
    content_signature?: string
    issues: Array<{ code: string; scene_id: string; shot_index: number; related_scene_id: string | null;
      related_shot_index: number | null; timing_change?: boolean; severity: 'error' | 'warning'; message: string; evidence: string; repair: string }>
  }
  source_documents: Array<{ id: string; title: string }>
}

export type StoryboardPlanningStage = 'preparing' | 'generating' | 'reviewing' | 'repairing' | 'rechecking' | 'completed'
export interface StoryboardPlanningProgress {
  phase: 'outline' | 'shots'
  completed_shots: number
  total_shots: number
}
export interface StoryboardPlanningTask {
  id: string
  project_id: string
  input_key: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  stage: StoryboardPlanningStage
  started_at: number
  updated_at: number
  active_duration_ms: number
  stage_duration_ms: number
  timings: Partial<Record<StoryboardPlanningStage, number>>
  can_resume: boolean
  /** Complete validated generation batches; not a saveable candidate. */
  progress?: StoryboardPlanningProgress
  /** Complete retained text awaiting review; editable after execution stops, but not ready to save. */
  candidate?: StoryboardPlanningResult
  result?: StoryboardPlanningResult
  error?: { message: string; stage: StoryboardPlanningStage; code?: string; retryable?: boolean;
    diagnostics?: string; raw_output?: string; status_code?: number }
}
