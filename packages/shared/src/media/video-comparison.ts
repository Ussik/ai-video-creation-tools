/** A single controlled pair is evidence for a shot, not a statistical model ranking. */
export interface VideoComparison {
  id: string
  project_id: string
  shot_id: string
  shot_title: string
  label: string
  baseline_job_id: string
  baseline_asset_id: string
  baseline_url: string
  baseline_prompt: string
  candidate_prompt: string
  candidate_job_id: string | null
  candidate_asset_id: string | null
  candidate_url: string | null
  candidate_asset: import('../api/contracts.js').Asset | null
  status: 'prepared' | 'starting' | 'queued' | 'running' | 'succeeded' | 'failed'
  error: string | null
  model_id: string
  model_name: string
  parameters: Record<string, unknown>
  generation_duration_ms: number
  edit_duration_ms: number
  /** The duration target is independent of the generated clip; no timeline is changed. */
  trim_target_ms: number
  seed_locked: boolean
  changed_fields: ['prompt']
  stale: boolean
  stale_reasons: string[]
  created_at: string
  started_at: string | null
}

export interface PrepareVideoComparisonInput {
  baseline_asset_id: string
  candidate_prompt: string
  label?: string
}

export function videoDurationPlan(generationSeconds: number, editSeconds: number): {
  generation_ms: number; edit_ms: number; trim_target_ms: number; needs_trim: boolean; shortfall_ms: number
} {
  const valid = (value: number) => Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0
  const generation_ms = valid(generationSeconds), edit_ms = valid(editSeconds)
  return { generation_ms, edit_ms, trim_target_ms: Math.min(generation_ms, edit_ms),
    needs_trim: generation_ms > edit_ms && edit_ms > 0, shortfall_ms: Math.max(0, edit_ms - generation_ms) }
}
