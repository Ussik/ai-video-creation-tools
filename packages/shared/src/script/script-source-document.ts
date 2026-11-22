import type { ScriptSourceKnowledge, ScriptSourceKnowledgePending } from './script-source-knowledge.js'
import type { SourcePositionIndex } from './script-source-position-index.js'
import type { TextGenerationOptions } from '../models/task-reasoning.js'
export type ScriptSourceQuote = { offset: number; quote: string }
/** Primary fact support; characters may cite earlier identity facts only with
 * separate chapter-local occurrence. Supporting quotes retain the full chain. */
export type ScriptSourceEvidence = ScriptSourceQuote & { occurrence?: ScriptSourceQuote; supporting?: ScriptSourceQuote[] }
export type ScriptSourceSection = {
  offset: number; length: number; title: string; episode_number: number | null; summary: string
  characters: Array<{ name: string; description: string; evidence: ScriptSourceEvidence }>
  events: Array<{ summary: string; evidence: ScriptSourceEvidence }>
  continues_previous?: boolean
  unit_id?: number
  open_threads?: string[]
  knowledge?: ScriptSourceKnowledge[]
  knowledge_pending?: ScriptSourceKnowledgePending[]
}
export type ScriptSourceStory = {
  summary: string
  /** Source-backed world rules/settings; absent in older saved analyses. */
  settings?: Array<{ description: string; section_ids: number[] }>
  characters: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }>
  timeline: Array<{ summary: string; section_ids: number[]; primary_section_id?: number }>
  threads: Array<{ setup: string; payoff: string | null; section_ids: number[] }>
  ending: { summary: string; section_ids: number[] }
  uncertainties: Array<{ description: string; section_ids: number[] }>
}
export type ScriptSourceCharacterEvidenceIssue = {
  task_key: string; character_name: string; name: string
  section_ids: number[]; evidence_section_ids: number[]
}
export type ScriptSourcePartOutputCheckpoint = {
  automatic_next?: ScriptSourcePartOutputCheckpoint
  input_hash?: string; raw?: string; original_raw?: string; correction?: { input_hash: string; raw: string }
  initial_started?: { input_hash: string; intent_id?: string }; correction_started?: { input_hash: string; intent_id?: string }
  syntax_repair?: { policy: 'quoted-lines-v1' | 'quoted-lines-v2-deterministic' | 'quoted-lines-v3-local' | 'stage-content-v1-insertion-only'; original_hash: string; repaired_hash: string; escape_offsets: number[] }
  correction_request?: { base_input_hash: string; input_hash: string; prompt: string;
    contract: { name: string; schema: Record<string, unknown>; wrapped?: boolean; request_policy?: 'script_review' | 'script_review_answer' | 'script_evidence' } }
  local_repair?: { input_hash: string; correction_hash: string; candidate_hash: string; candidate: unknown;
    remaining_target_keys: string[]; retained_target_keys: string[]; diagnostics: string }
}
export type ScriptSourceQualityFinding = {
  kind: 'omission' | 'unsupported' | 'causality'; explanation: string; unit_ids: number[]
  assessment?: { issue_type: 'fact_error' | 'event_order' | 'unsupported_fact' | 'material_omission' | 'open_question' | 'optional_detail';
    analysis_paths: string[]; proposition: string;
    impact: { level: 'blocking' | 'scoped' | 'advisory'; section_ids: number[]; reason: string } }
}
export type ScriptSourceQualityDecisionKind = 'modify_analysis' | 'retain_analysis' | 'uncertain' | 'requires_full_rebuild'
/** A program-validated disposition, still provisional until an independent
 * current-analysis review. References bind actual saved values, not claims. */
export type ScriptSourceQualityDecision = {
  finding_index: number; finding_hash: string; before_hash: string; after_hash: string
  decision: ScriptSourceQualityDecisionKind; reason: string
  analysis_refs: Array<{ path: string; value_hash: string }>
  source_refs: Array<{ unit_id: number; text_hash: string }>
}
export type ScriptSourceQualitySummary = {
  handled: number; total: number; modified: number; retained: number; uncertain: number
  review: 'pending' | 'passed' | 'issues'; access: 'blocked' | 'scoped' | 'usable'
  blocking: number; advisory: number; section_ids: number[]
  stop_reason?: 'no_progress' | 'uncertain' | 'decision_mismatch' | 'legacy_decision'; message?: string
  confirmation_required?: true
  confirmation_scope?: { analysis_id: string; review_hash: string; findings_hash: string }
}
export type ScriptSourceQualityRoundConfirmation = {
  source_version: string; review_hash: string; findings_hash: string; current_hash: string
  completed_run_id: string; previous_review_hash: string; previous_findings_hash: string; created_at: string
}
export type ScriptSourceQualityRepairBatchBinding = {
  policy: 'source-quality-repair-batch-v1'; batch_hash: string; review_hash: string; findings_hash: string; before_hash: string
  anchor: { policy: 'source-quality-repair-ref-v1'; checkpoint_hash: string; finding_index: number; finding_hash: string;
    review_hash: string; findings_hash: string; current_hash: string }
  members: Array<{ finding_index: number; finding_hash: string; analysis_paths: string[] }>
}
export type ScriptSourceQualityRepairBatch = {
  binding: ScriptSourceQualityRepairBatchBinding; checkpoint: ScriptSourcePartOutputCheckpoint; committed_indices: number[]
  /** Frozen editable baseline for local replay after a partial prefix commit. */
  baseline?: { sections: ScriptSourceSection[]; story: ScriptSourceStory;
    quality_repair: NonNullable<ScriptSourceAnalysis['quality_repair']> }
  validated_indices?: number[]
  /** Local validation errors are not a license to resend completed batch bytes. */
  invalid_indices?: number[]; validation_message?: string
}
export type ScriptSourceControlledRecoveryScope = {
  policy: 'source-controlled-quality-workflow-v1'; binding: string
  review_hash: string; findings_hash: string; first_finding: number; total_findings: number
  max_requests: number; max_total_requests: number; max_active_ms: number
  /** Private evidence binding for a separately confirmed remaining-work run. */
  predecessor?: { run_id: string; authorization_id: string; evidence_hash: string }
}
export type ScriptSourceAnalysis = {
  text_generation_options?: TextGenerationOptions
  /** Extraction ends after indexing and synthesis, without semantic quality loops. */
  /** Private syntax-only audit; does not certify source facts or references. */
  syntax_repairs?: Array<{ page: number; input_hash: string; correction_input_hash?: string; correction_raw?: string;
    syntax: NonNullable<ScriptSourcePartOutputCheckpoint['syntax_repair']> }>
  /** Private format recovery evidence retained after a synthesis task completes. */
  story_syntax_repairs?: Array<{ task_key: string; input_hash: string; syntax: NonNullable<ScriptSourcePartOutputCheckpoint['syntax_repair']> }>
  map_output_policy?: 'dense-v1'
  map_input_policy?: 'adjacent-evidence-v1'
  automatic_recovery?: { version: 1; max_requests: number; max_task_requests: number; max_reserved_chars: number;
    requests: Array<{ key: string; task: string; error_type: 'format' | 'reference'; input_chars: number;
      reserved_chars: number; output_chars?: number; status: 'reserved' | 'completed' | 'failed' }> }
  runtime_events?: Array<{ id: string; stage: string; label: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; started_at: number; ended_at?: number }>
  runtime_events_omitted?: number
  recovery_progress?: { attempts: number; completed_responses: number; max_requests: number }
  map_page_transfers?: Array<{ page: number; from_offset: number; original_boundary: number; boundary: number; next_end: number; candidate: unknown }>
  analysis_mode?: 'extract'
  position_index?: SourcePositionIndex
  id: string; source_version: string; model_id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'paused'
  pause_reason?: 'user' | 'service_restart' | 'local_validation'
  completed_chunks: number; total_chunks: number; sections: ScriptSourceSection[]; error: string | null; updated_at: string
  failure?: { stage: 'format' | 'evidence' | 'content' | 'recovery'; message: string; historical_diagnostics?: string }
  /** Server start of the current execution, absent while queued or reusing a cached result. */
  started_at?: string
  phase?: 'reading' | 'synthesis' | 'ready'
  story?: ScriptSourceStory
  synthesis?: { level: number; cursor: number; inputs: unknown[]; outputs: unknown[] }
  /** Private durable synthesis tasks; omitted from public responses. */
  story_scope_transfers?: Array<{ id: string; from: string; to: string; field: string; item: unknown }>
  story_work?: { policy?: 'source-story-v5' | 'source-story-v6' | 'source-story-v7'; input_hash: string; tasks: Array<{ key: string; result?: unknown; execution?: { status: 'running' | 'completed' | 'failed' | 'blocked'; depends_on?: string[]; message?: string; started_at?: number; ended_at?: number };
    evidence_expansion?: { section_ids: number[]; reason: string; checkpoint: ScriptSourcePartOutputCheckpoint };
    output_candidate?: { context_hash: string; replay_version?: number;
      previous_failure?: { message: string; evidence?: ScriptSourceCharacterEvidenceIssue };
      checkpoint: ScriptSourcePartOutputCheckpoint }
    output_checkpoint?: { steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> }
    recovery?: 'character-coverage-v1'
    context?: { strategy: 'whole-source-v1' | 'character-evidence-v1'; input_hash: string; fallback_from_hash?: string; reason?: string }
    failure?: { message: string; code?: string; evidence?: ScriptSourceCharacterEvidenceIssue } }> }
  /** Private short-source candidate and bounded character repair; never published as story. */
  story_candidate?: { input_hash: string; result?: { covered_section_ids: number[]; story: ScriptSourceStory };
    output_checkpoint?: ScriptSourcePartOutputCheckpoint;
    character_repair?: { candidate_hash: string; diagnosis_hash: string; status: 'prepared' | 'completed' | 'failed';
      patch?: { add_characters: ScriptSourceStory['characters']; add_aliases: Array<{ character_index: number; aliases: string[];
        section_ids: number[]; identity_evidence: { section_id: number; quote: string } }> }; diagnostics?: string } }
  /** Prior compatible execution whose exact completed short-story response may be adopted once. */
  story_response_run_ids?: string[]
  /** Public description of results that an explicit retry can actually reuse. */
  resume?: { available: boolean; message: string; blocked?: boolean; action?: 'continue' | 'revalidate' | 'reconcile_request' | 'blocked';
    next?: { phase: 'quality_repair' | 'quality_review'; response: 'not_started' | 'saved_response' | 'unknown_response'; model_required: boolean } }
  story_progress?: { completed: number; total: number; protected_keys?: string[]; pending: Array<{ key: string; label: string;
    status: 'saved_response' | 'unknown_response' | 'correction_exhausted' | 'pending'; scope_label?: string; message?: string }> }
  local_validation?: { checked_at: string; reused_tasks: number; model_required: boolean; summary: string }
  pipeline_version?: number
  /** Private execution configuration and revision reuse provenance. */
  configuration_hash?: string
  /** Private ordinary continuation decision; never substitutes for a request's
   * dedicated recovery permit and never appears in public source snapshots. */
  ordinary_story_dispatch?: { run_id: string; binding: string; work_hash?: string; protected_task_keys: string[]; authorized_at: string;
    closed_at?: string; closed_reason?: 'independent_recheck_complete';
    bounded_quality?: true;
    quality_pending_story?: boolean; quality_input_hash?: string; quality_initial_run_id?: string;
    quality_workflow?: { phase: 'repair' | 'review'; review_hash: string; findings_hash: string; finding_index: number;
      current_hash: string; checkpoint_hash: string; protected_repair_bindings: string[]; review_input_hash?: string; protected_review?: boolean; repair_initial_run_id?: string;
      repair_correction?: { checkpoint_hash: string; base_input_hash: string; initial_run_id: string; initial_response_hash: string } };
    correction_tasks?: Array<{ task_key: string; candidate_hash: string; base_input_hash: string; initial_run_id: string; initial_response_hash: string }> }
  /** Private next-round admission bound to the newly saved independent review. */
  quality_round_confirmation?: ScriptSourceQualityRoundConfirmation
  /** Private closed allowances are retained as audit data, never reused as permits. */
  quality_dispatch_history?: Array<{ round_key: string; closed_at: string; result: 'passed' | 'new_findings';
    next_review_hash: string; next_findings_hash: string; grant: NonNullable<ScriptSourceAnalysis['ordinary_story_dispatch']>;
    confirmation?: { authorized_at: string; authorized_run_id: string } }>
  /** Private creator review request; evidence must be checked against the source. */
  review_feedback?: { id: string; text: string; source_version: string; source_updated_at: string; model_id: string; configuration_hash: string }
  revision_reuse?: { input_hash: string; base_source_version: string; source_version: string;
    status: 'pending' | 'verified' | 'discarded'; planned_pages: number[]; reused_pages: number[];
    reused_section_ids: number[]; reused_characters: number }
  completed_characters?: number
  queue_position?: number
  /** Private validated output pages; input identity includes the full source and analysis. */
  quality_work?: { input_hash: string; output_checkpoint?: ScriptSourcePartOutputCheckpoint;
    checkpoint: { steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> } }
  quality?: { input_hash: string; status: 'passed' | 'issues'; findings: ScriptSourceQualityFinding[] }
  quality_summary?: ScriptSourceQualitySummary
  /** Private marker: review feedback has already started one corrective run. */
  quality_rebuild_for?: string
  /** Private durable progress for guarded repairs to one independent review. */
  quality_repair?: { review_hash: string; findings_hash: string; current_hash: string; completed_findings: number
    decisions?: ScriptSourceQualityDecision[]
    stop_reason?: 'uncertain' | 'decision_mismatch' | 'legacy_decision'; stop_message?: string
    /** Private evidence for findings withdrawn without changing the analysis. */
    withdrawals?: Array<{ finding_index: number; finding_hash: string; analysis_hash: string; reason: string; unit_ids: number[] }> }
  /** Private immutable review snapshots and accepted decision evidence. */
  quality_review_audit?: Array<{ review_hash: string; analysis_hash: string; source_version: string;
    findings: Array<{ kind: ScriptSourceQualityFinding['kind']; assessment?: ScriptSourceQualityFinding['assessment'];
      targets: Array<{ path: string; value_hash: string }>; evidence_hashes: string[] }>;
    handled: number; modified: number; retained: number; uncertain: number; decisions?: ScriptSourceQualityDecision[] }>
  quality_loop_guard?: { analysis_hash: string; source_version: string; reason: 'unchanged_analysis' | 'unchanged_target';
    finding_indices: number[]; message: string }
  /** Private exact proposal journal; never a committed analysis or a new request allowance. */
  quality_repair_output?: { binding: string; checkpoint: ScriptSourcePartOutputCheckpoint }
  quality_repair_outputs?: Array<{ binding: string; checkpoint: ScriptSourcePartOutputCheckpoint }>
  quality_repair_batch?: ScriptSourceQualityRepairBatch
  quality_repair_batches?: ScriptSourceQualityRepairBatch[]
  /** A separately acknowledged duplicate-cost workflow. It is never inferred
   * from an old unknown marker or an unrelated recovery permit. */
  controlled_recovery?: { authorization_id: string; run_id: string; scope: ScriptSourceControlledRecoveryScope;
    authorized_at: string; active_ms: number; usage: import('./script-request-usage.js').ScriptRequestUsage;
    dispatched: Array<{ step: string; request_key: string; local_request_id: string; intent_id: string }>;
    /** Private worker claim; a live owner alone may update this run. */
    runtime_owner?: string; runtime_pid?: number;
    closed_at?: string; outcome?: 'completed' | 'stopped' }
  /** Original unknown bytes and the original grant remain immutable private
   * history; the formal authorization also keeps the full before snapshot. */
  controlled_recovery_archive?: Array<{ authorization_id: string; original_run_id: string; archived_at: string;
    output: NonNullable<ScriptSourceAnalysis['quality_repair_output']>;
    outputs?: NonNullable<ScriptSourceAnalysis['quality_repair_outputs']>;
    grant?: NonNullable<ScriptSourceAnalysis['ordinary_story_dispatch']>;
    previous?: NonNullable<ScriptSourceAnalysis['controlled_recovery']> }>
  progress?: { stage: 'reading' | 'repairing' | 'splitting' | 'synthesis' | 'validating'; message: string }
  work?: Array<{ offset: number; length: number; depth: number; result?: unknown
    output_checkpoint?: { automatic_next?: ScriptSourcePartOutputCheckpoint; input_hash?: string; raw?: string; correction?: { input_hash: string; raw: string }
      syntax_repair?: ScriptSourcePartOutputCheckpoint['syntax_repair']
      /** A proven adjacent-page prefix is bound to its exact future prompt. */
      seed?: { input_hash: string; sections: unknown[] }
      /** Closed directory items stay private until this entire output window completes. */
      pages?: { steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> } }
    /** Complete original candidate retained until the current page is validated and appended. */
    scope_recovery?: { candidate: unknown; next_page: number; next_input_hash: string }
    boundary_repair?: { candidate_hash: string; diagnosis_hash: string; status: 'prepared' | 'completed' | 'failed';
      patch?: { prefix_sections: Array<{ start_unit: number; title: string; episode_number: number | null; summary: string;
        characters: Array<{ name: string; description: string; evidence: { unit_id: number } }>;
        events: Array<{ summary: string; evidence: { unit_id: number } }>; continues_previous: boolean; open_threads: string[] }>;
        starts: Array<{ section_index: number; start_unit: number }> }; diagnostics?: string }
  }>
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
