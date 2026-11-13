export type ScriptSourceEvidence = { offset: number; quote: string }
export type ScriptSourceSection = {
  offset: number; length: number; title: string; episode_number: number | null; summary: string
  characters: Array<{ name: string; description: string; evidence: ScriptSourceEvidence }>
  events: Array<{ summary: string; evidence: ScriptSourceEvidence }>
  continues_previous?: boolean
  unit_id?: number
  open_threads?: string[]
}
export type ScriptSourceStory = {
  summary: string
  characters: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }>
  timeline: Array<{ summary: string; section_ids: number[] }>
  threads: Array<{ setup: string; payoff: string | null; section_ids: number[] }>
  ending: { summary: string; section_ids: number[] }
  uncertainties: Array<{ description: string; section_ids: number[] }>
}
export type ScriptSourceCharacterEvidenceIssue = {
  task_key: string; character_name: string; name: string
  section_ids: number[]; evidence_section_ids: number[]
}
export type ScriptSourceAnalysis = {
  id: string; source_version: string; model_id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'paused'
  completed_chunks: number; total_chunks: number; sections: ScriptSourceSection[]; error: string | null; updated_at: string
  /** Server start of the current execution, absent while queued or reusing a cached result. */
  started_at?: string
  phase?: 'reading' | 'synthesis' | 'ready'
  story?: ScriptSourceStory
  synthesis?: { level: number; cursor: number; inputs: unknown[]; outputs: unknown[] }
  /** Private durable synthesis tasks; omitted from public responses. */
  story_work?: { input_hash: string; tasks: Array<{ key: string; result?: unknown;
    output_checkpoint?: { steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> }
    recovery?: 'character-coverage-v1'
    context?: { strategy: 'whole-source-v1' | 'character-evidence-v1'; input_hash: string; fallback_from_hash?: string; reason?: string }
    failure?: { message: string; evidence?: ScriptSourceCharacterEvidenceIssue } }> }
  /** Public description of results that an explicit retry can actually reuse. */
  resume?: { available: boolean; message: string }
  pipeline_version?: number
  /** Private execution configuration and revision reuse provenance. */
  configuration_hash?: string
  revision_reuse?: { input_hash: string; base_source_version: string; source_version: string;
    status: 'pending' | 'verified' | 'discarded'; planned_pages: number[]; reused_pages: number[];
    reused_section_ids: number[]; reused_characters: number }
  completed_characters?: number
  queue_position?: number
  /** Private validated output pages; input identity includes the full source and analysis. */
  quality_work?: { input_hash: string; checkpoint: { steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> } }
  quality?: { input_hash: string; status: 'passed' | 'issues'; findings: Array<{ kind: 'omission' | 'unsupported' | 'causality'; explanation: string; unit_ids: number[] }> }
  /** Private marker: review feedback has already started one corrective run. */
  quality_rebuild_for?: string
  /** Private durable progress for guarded repairs to one independent review. */
  quality_repair?: { review_hash: string; findings_hash: string; current_hash: string; completed_findings: number }
  progress?: { stage: 'reading' | 'repairing' | 'splitting' | 'synthesis' | 'validating'; message: string }
  work?: Array<{ offset: number; length: number; depth: number; result?: unknown }>
}
export type ScriptSourceDocument = {
  project_id: string; filename: string; content: string; updated_at: string; analysis?: ScriptSourceAnalysis | null
  revision?: number
}
export type ScriptSourceUpdate = {
  id: string; base_version: string; original_content: string; content: string
  replacements: Array<{ find: string; replace: string; reason: string }>
}
export const scriptSourceExtensions = ['.txt', '.md', '.markdown', '.docx', '.pdf'] as const
export const scriptSourceFileLimit = 10 * 1024 * 1024
export const scriptSourceCharacterLimit = 100_000
