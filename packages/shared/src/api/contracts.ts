import type { VisualReferenceAsset, VisualReferencePurpose, VisualReferenceSnapshot, VisualReferenceStatus, VisualReferenceView } from '../visuals/visual-reference-types.js'
import type { StageArtifactType } from '../script/script-stage-content.js'
import type { GenerationRecoveryAction, GenerationRecoveryModality } from '../jobs/generation-recovery.js'
export type { VisualReferenceAsset, VisualReferencePurpose, VisualReferenceSnapshot, VisualReferenceStatus, VisualReferenceView } from '../visuals/visual-reference-types.js'

export type Modality = 'text' | 'image' | 'video'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type Protocol = 'responses' | 'chat_completions' | 'image_generations' | 'async_video'

export interface Project {
  id: string
  name: string
  brief: string
  ratio: '16:9' | '9:16'
  music_asset_id: string | null
  created_at: string
  updated_at: string
}
export interface ProductionRange {
  start_shot_id: string | null
  end_shot_id: string | null
}
export interface Shot {
  id: string
  project_id: string
  design_id?: string | null
  superseded_by?: string | null
  position: number
  title: string
  prompt: string
  image_prompt?: string
  video_prompt?: string
  storyboard_revision?: number
  duration: number
  selected_asset_id: string | null
  archived_candidate_asset_ids?: string[]
  source_scene_id: string | null
  start_state: string
  end_state: string
  cut_note: string
}
export interface TimelineClip {
  id: string
  project_id: string
  shot_id: string
  asset_id: string
  in_ms: number
  out_ms: number
  source_duration_ms: number | null
  source_audio_gain: number
  source_audio_fade_ms: number
}
export interface ScriptScene {
  id: string
  project_id: string
  position: number
  episode_number?: number
  heading: string
  location: string
  time_of_day: string
  characters: string
  action: string
  dialogue: string
  narration: string
  duration: number
  created_at: string
  updated_at: string
}
export type Scene = ScriptScene
export interface ScriptSceneInput {
  id?: string
  episode_number?: number
  heading: string
  location?: string
  time_of_day?: string
  characters?: string
  action?: string
  dialogue?: string
  narration?: string
  duration?: number
}
export type ScriptArtifactType = StageArtifactType
export interface ScriptArtifact {
  id: string
  project_id: string
  artifact_type: ScriptArtifactType
  episode_number?: number
  title: string
  content: string
  position: number
  status: 'draft' | 'ready' | 'edited'
  created_at: string
  updated_at: string
}
export interface Script {
  outline: string
  characters: string
  generation_options: ScriptGenerationOptions
  scenes: ScriptScene[]
  artifacts?: ScriptArtifact[]
}
export interface ScriptGenerationOptions {
  genre?: string
  genre_fusion?: string
  audience?: string
  era?: string
  core_hook?: string
  visual_style?: string
  visual_style_details?: import('../visuals/visual-style.js').VisualStyleDetails
  story_structure?: string
  character_notes?: string
  /** Target number of episodes for a generated series. */
  episode_count?: number
  episode_duration?: number
}
export interface ScriptDraft {
  outline: string
  characters: string
  scenes: ScriptSceneInput[]
  artifacts?: Array<{
    artifact_type: ScriptArtifactType
    title?: string
    content: string
  }>
}
export interface ScriptInput {
  brief?: string
  outline: string
  characters: string
  generation_options?: ScriptGenerationOptions
  scenes?: ScriptSceneInput[]
}
export interface ScriptGenerationInput {
  model_id: string
  idea?: string
  target_duration?: number
  generation_options?: ScriptGenerationOptions
}
export interface ScriptConversionResult {
  shots: Shot[]
  skipped_scene_ids: string[]
}
export interface PlannedShot {
  title: string
  prompt: string
  image_prompt?: string
  video_prompt?: string
  duration: number
  start_state?: string
  end_state?: string
  cut_note?: string
}
export interface PlannedScene {
  scene_id: string
  scene_heading: string
  scene_duration: number
  shots: PlannedShot[]
}
export interface ShotPlanResult {
  scenes: PlannedScene[]
}
export interface PlannedShotCreationResult {
  shots: Shot[]
  replayed?: boolean
  payload_changed?: boolean
}
export interface Asset {
  id: string
  project_id: string
  shot_id: string | null
  kind: Modality | 'audio'
  filename: string
  source: 'upload' | 'generated' | 'export'
  model_id: string | null
  prompt: string | null
  remote_url: string | null
  saved: boolean
  created_at: string
  url: string
  text?: string
}
export interface AssetReview {
  shot_id: string
  asset_id: string
  status: 'pending' | 'approved' | 'rejected'
  note: string
  updated_at: string
}
export type AssetTaskFocus = 'character' | 'location' | 'prop'
export type AssetTaskStatus = 'awaiting_confirmation' | 'generating' | 'ready' | 'failed'
export interface AssetTaskEvent {
  id: string
  task_id: string
  stage: string
  message: string
  created_at: string
}
export interface AssetTask {
  id: string
  project_id: string
  focus_artifact: AssetTaskFocus
  status: AssetTaskStatus
  source_artifact_ids: string[]
  source_scene_ids: string[]
  prompt: string
  generation_job_id: string | null
  result_asset_id: string | null
  error: string | null
  created_at: string
  updated_at: string
  result_asset: Asset | null
  generation_job: Job | null
  events: AssetTaskEvent[]
}
export interface Job {
  id: string
  project_id: string
  shot_id: string | null
  model_id: string | null
  job_type: 'generation' | 'export'
  request: string
  status: JobStatus
  external_id: string | null
  result_asset_id: string | null
  recovery_available: boolean
  task_resume_available?: boolean
  recovery_action?: GenerationRecoveryAction
  recovery_modality?: GenerationRecoveryModality
  error: string | null
  created_at: string
}
export interface Provider {
  id: string
  name: string
  adapter: 'http' | 'demo'
  base_url: string
  auth_header: string
  auth_prefix: string
  model_catalog: {
    path: string
    list_path: string
    id_path: string
    name_path?: string
    modality_path?: string
  }
  has_key: boolean
  enabled: boolean
}
export interface Model {
  id: string
  provider_id: string
  name: string
  remote_id: string
  modality: Modality
  protocol: Protocol
  settings: Record<string, unknown>
  enabled: boolean
  is_default?: boolean
}
export interface ProjectDetail extends Project {
  final_cut_canvas_id?: string
  speech?: import('../media/speech-timeline.js').SpeechData
  audio_settings?: import('../media/speech-timeline.js').AudioMixSettings
  project_visual_style?: import('../visuals/visual-style.js').ProjectVisualStyle
  production_range: ProductionRange
  script: Script
  shots: Shot[]
  historical_shots?: Shot[]
  timeline_clips: TimelineClip[]
  asset_reviews: AssetReview[]
  assets: Asset[]
  jobs: Job[]
  asset_tasks: AssetTask[]
  visual_profiles?: VisualProfile[]
  scene_visual_bindings?: SceneVisualBinding[]
  shot_visual_bindings?: ShotVisualBinding[]
}

export type VisualKind = 'character' | 'location' | 'prop'
export type VisualReferenceMode = 'profiles' | 'keyframe' | 'text_only'
export interface VisualProfileDraft {
  design_id?: string | null
  kind: VisualKind
  name: string
  variant: string
  definition: string
  view_requirements: string
  /** Temporary keys resolve relations inside one reviewed creation batch. */
  draft_key?: string
  base_profile_id?: string | null
  base_draft_key?: string | null
  state_delta?: string
  scene_ids: string[]
  shot_usage?: Array<{ shot_id: string; usage: import('../visuals/visual-binding-usage.js').VisualBindingUsage }>
}
export interface VisualProfile extends Omit<VisualProfileDraft, 'scene_ids' | 'shot_usage' | 'draft_key' | 'base_draft_key'> {
  id: string
  project_id: string
  design_id?: string | null
  revision: number
  definition_status?: 'draft' | 'ready'
  board_asset_id: string | null
  asset_task_id: string | null
  board_prompt: string
  board_style_version?: string | null
  board_style_status?: 'missing' | 'unrecorded' | 'current' | 'needs_review'
  identity_profile_id?: string
  base_reference_status?: 'none' | 'waiting' | 'ready' | 'needs_review'
  base_reference_signature?: string | null
  /** Readable derived prose; original fields remain the editable source. */
  display_definition?: string
  display_view_requirements?: string
  display_state_delta?: string
  source_draft_key?: string | null
  text_reference_issues?: Array<{ field: 'definition' | 'view_requirements' | 'state_delta'; token: string; reason: 'unresolved' | 'ambiguous' }>
  candidate_asset_ids?: string[]
  archived_candidate_asset_ids?: string[]
  reference_assets?: VisualReferenceAsset[]
}
export interface SceneVisualBinding { scene_id: string; profile_id: string; required: boolean }
export interface ShotVisualBinding extends Omit<VisualProfile, 'id' | 'project_id' | 'asset_task_id' | 'board_prompt' | 'reference_assets'> {
  shot_id: string
  profile_id: string
  required: boolean
  reference_assets?: VisualReferenceSnapshot[]
  usage?: import('../visuals/visual-binding-usage.js').VisualBindingUsage
  /** Follow confirmed updates by default; locked preserves this working snapshot. */
  sync_mode?: 'follow' | 'locked'
  /** Explicit selections retain their assets and ordering during automatic updates. */
  reference_selection?: 'auto' | 'manual'
  sync_status?: 'current' | 'waiting_confirmation' | 'manual_review'
}
export interface VisualReferenceContext {
  expected_revision: number
  expected_style_version: string
}
export interface VisualReferenceAssetInput extends VisualReferenceContext {
  asset_id: string
  view: VisualReferenceView
  purpose: VisualReferencePurpose
  label?: string
  status?: 'candidate' | 'confirmed'
  is_default?: boolean
}
export interface VisualReferenceAssetPatch extends VisualReferenceContext {
  status?: VisualReferenceStatus
  is_default?: boolean
  label?: string
}
export interface VisualReferenceCrop { x: number; y: number; width: number; height: number }
export interface VisualReferenceCropInput extends Omit<VisualReferenceAssetInput, 'status' | 'is_default'> {
  crop: VisualReferenceCrop
}
export interface VisualReferencePreviewInput extends VisualReferenceContext {
  view: VisualReferenceView
  purpose: VisualReferencePurpose
  label?: string
  model_id: string
  reference_asset_ids?: string[]
  prompt_append?: string
}
export interface VisualReferencePreview {
  prompt: string
  reference_asset_ids: string[]
  reference_signature: string
  project_style_version: string
  mode: 'text' | 'reference'
  style_warnings?: string[]
}
export interface VisualReferenceGenerationInput extends VisualReferencePreviewInput {
  reference_signature: string
  prompt: string
  ratio: string
  resolution?: string | null
  quality?: string | null
  clarity?: string | null
  background?: string | null
  candidate_count?: 1 | 2 | 4
}
export interface VisualReferenceGenerationResult { job: Job; jobs: Job[] }
export interface VisualProjectData {
  created_profile_ids?: string[]
  project_visual_style?: import('../visuals/visual-style.js').ProjectVisualStyle
  visual_profiles: VisualProfile[]
  scene_visual_bindings: SceneVisualBinding[]
  shot_visual_bindings: ShotVisualBinding[]
}
export interface ScriptCanvasCheck { signature: string; scene_ids: string[]; needs_analysis: string[] }
export interface ScriptCanvasPlan {
  signature: string; scene_ids: string[]; profiles: VisualProfileDraft[]
  reference_usage_version?: 1
  used_skills?: Array<{ id: string; name: string; revision: string; files: string[]; role?: 'primary' | 'auxiliary' }>
  loaded_files?: string[]
}
export interface ScriptCanvasResult {
  design_id?: string | null
  target_canvas_id?: string | null
  scene_ids: string[]
  shots: Shot[]
  visual_profiles: VisualProfile[]
  shot_visual_bindings: ShotVisualBinding[]
  created_profiles: number
  created_shots: number
  updated_shot_ids?: string[]
}
export interface VisualBoardPreview {
  prompt_document?: boolean
  project_style_version?: string
  project_visual_style?: import('../visuals/visual-style.js').ProjectVisualStyle
  style_warnings?: string[]
  prompt: string
  mode: 'text' | 'reference'
  reference_asset_ids: string[]
  reference_names: string[]
  reference_signature: string
  base_profile_id?: string | null
  base_reference_signature?: string
  reference_sources?: Array<{ asset_id: string; profile_id?: string; revision?: number; role: 'base' | 'manual' }>
}

export type ContinuitySeverity = 'error' | 'warning'
export interface ContinuityCheck {
  code: string
  severity: ContinuitySeverity
  message: string
  shot_id?: string
  related_shot_id?: string
  field?: string
  category?: string
  previous_value?: string
  current_value?: string
}
export interface ContinuityShotReport {
  shot_id: string
  title: string
  position: number
  expected_duration_ms: number
  actual_duration_ms: number | null
  selected_asset_id: string | null
  timeline_clip_id: string | null
  review_status: AssetReview['status'] | null
  has_material: boolean
  material_ready: boolean
  issues: ContinuityCheck[]
}
export interface ContinuityReport {
  semantic_review: { status: 'not_checked' | 'checked' | 'stale'; model_id: string | null; checked_at: string | null }
  production_range: ProductionRange
  shots: ContinuityShotReport[]
  issues: ContinuityCheck[]
  summary: {
    total_shots: number
    checked_shots: number
    pass_count: number
    error_count: number
    warning_count: number
    expected_duration_ms: number
    actual_duration_ms: number
    status: 'blocked' | 'warning' | 'ready'
  }
}

export type CutReviewStatus = 'pending' | 'approved' | 'needs_work'
export interface CutReviewSide {
  shot_id: string
  title: string
  asset_id: string | null
  asset_kind: 'image' | 'video' | null
  clip_id: string | null
  in_ms: number | null
  out_ms: number | null
  frame_url: string | null
}
export interface CutReview {
  from_shot_id: string
  to_shot_id: string
  from: CutReviewSide
  to: CutReviewSide
  status: CutReviewStatus
  saved_status: CutReviewStatus | null
  note: string
  stale: boolean
  signature: string
  reviewed_at: string | null
  ready: boolean
}
export interface CutReviewReport {
  production_range: ProductionRange
  cuts: CutReview[]
}
