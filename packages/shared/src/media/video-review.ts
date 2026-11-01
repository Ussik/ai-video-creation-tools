export type VideoReviewCategory = 'action' | 'continuity' | 'composition' | 'style' | 'dialogue_audio'
export type VideoReviewVerdict = 'usable' | 'needs_work' | 'uncertain'
export interface VideoReviewFinding {
  id: string
  category: VideoReviewCategory
  severity: 'error' | 'warning' | 'info'
  start_ms: number
  end_ms: number
  observation: string
  expected: string
  suggestion: string
  evidence_times_ms: number[]
}
export interface VideoReviewCheck {
  category: VideoReviewCategory
  status: 'pass' | 'issue' | 'uncertain'
  detail: string
}
export interface VideoReviewRange { start_ms: number; end_ms: number; reason: string }
export interface VideoReviewReport {
  id: string
  project_id: string
  asset_id: string
  shot_id: string | null
  model_id: string
  model_name: string
  created_at: string
  input_mode: 'native_video' | 'sampled_frames'
  duration_ms: number
  target_duration_ms: number | null
  stale: boolean
  summary: string
  verdict: VideoReviewVerdict
  findings: VideoReviewFinding[]
  checks: VideoReviewCheck[]
  usable_ranges: VideoReviewRange[]
  limitations: string[]
  evidence_frames: Array<{ time_ms: number; url: string }>
  sample_times_ms: number[]
}
