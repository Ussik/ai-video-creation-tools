export interface VideoPromptIssue {
  code: string
  severity: 'warning' | 'error'
  message: string
  suggestion: string
}
export interface VideoPromptContentReview {
  primary_action: string
  secondary_actions: string[]
  start_state: string
  end_state: string
  visible_result: string
  facts: Array<{ fact: string; status: 'preserved' | 'changed' | 'missing' | 'uncertain'; evidence: string }>
  issues: VideoPromptIssue[]
  reference_findings: Array<{ image_number: number; observation: string; suggestion: string }>
}
export interface VideoPromptDiagnostics {
  generation_duration: number | null
  edit_duration: number | null
  dialogue: { source: string[]; missing: string[]; explicit_change: boolean }
  references: { mode: 'pixels' | 'text_only'; inspected_asset_ids: string[]; omitted_asset_ids: string[] }
  content_review: VideoPromptContentReview | null
  issues: VideoPromptIssue[]
}
