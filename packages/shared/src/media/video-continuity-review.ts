export interface VideoContinuityFinding {
  category: 'opening_state' | 'action_handoff' | 'prop_handoff' | 'audio_continuity' | 'dialogue_change' | 'camera_conflict' | 'duration'
  severity: 'error' | 'warning'
  basis: 'text' | 'pixels'
  observation: string
  quotes: string[]
  image_index: number | null
  suggestion: string
}

/** A generation-before-review snapshot. It never certifies the output video's sound or motion. */
export interface VideoContinuityReview {
  source_signature: string
  context_signature: string
  summary: string
  findings: VideoContinuityFinding[]
  uncertainties: string[]
  images: Array<{ role: 'previous_tail' | 'current_storyboard'; asset_id: string; time_ms: number | null }>
}
