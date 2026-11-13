import type { CandidateQuality } from '../api/ai-candidate-quality.js'
import type { VideoPromptDiagnostics } from '../media/video-prompt-checks.js'
export interface PromptRefinementResult {
  operation_id: string
  prompt: string
  prompt_body: string
  prompt_document?: boolean
  reference_asset_ids: string[]
  skills: Array<{ name: string; [key: string]: unknown }>
  loaded_files?: string[]
  skill_assignment?: unknown
  diagnostics?: VideoPromptDiagnostics
  quality: CandidateQuality
  semantic_review?: unknown
}
