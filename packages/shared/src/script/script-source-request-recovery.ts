import type { ScriptSourcePartOutputCheckpoint } from './script-source-document.js'

/** Saved response presence and pending delivery are independent facts. */
export function sourceCheckpointLeaf(checkpoint?: ScriptSourcePartOutputCheckpoint): ScriptSourcePartOutputCheckpoint | undefined {
  const seen = new Set<ScriptSourcePartOutputCheckpoint>()
  while (checkpoint?.automatic_next) {
    if (seen.has(checkpoint) || seen.size >= 12) throw new Error('自动纠正断点链无效，不能重新派发')
    seen.add(checkpoint); checkpoint = checkpoint.automatic_next
  }
  return checkpoint
}
export function sourceCheckpointResponseFact(checkpoint?: ScriptSourcePartOutputCheckpoint) {
  checkpoint = sourceCheckpointLeaf(checkpoint)
  const initialUnknown = !!checkpoint?.initial_started && typeof checkpoint.raw !== 'string'
  const correctionUnknown = !!checkpoint?.correction_started && typeof checkpoint.correction?.raw !== 'string'
  const saved = typeof checkpoint?.raw === 'string' || typeof checkpoint?.correction?.raw === 'string'
  return { saved, initial_unknown: initialUnknown, correction_unknown: correctionUnknown,
    response: initialUnknown || correctionUnknown ? 'unknown_response' as const : saved ? 'saved_response' as const : 'not_started' as const }
}

export type SourceRequestReconciliation = {
  version: 1
  status: 'saved_response' | 'trusted_not_sent' | 'unknown_response' | 'no_pending_request' | 'inconsistent'
  next: 'local_revalidate' | 'explicit_continue' | 'provider_reconcile' | 'inspect_conflict' | 'none'
  message: string
  saved_response: boolean
  checkpoint_unknown: boolean
  ledger_unknown: number
  can_reconcile: boolean
}

export type SourceRequestLocalRecoveryDecision = {
  analysis_id: string
  cas_token: string
  client_action_id: string
  decision: 'reconcile_local'
  /** Acknowledges only the exact server-issued bounded successor scope. */
  risk_confirmation?: {
    scope_token: string
    acknowledged_duplicate_risk: true
  }
}

export type SourceRecoverySummary = { saved_count: number; pending_items: Array<{ label: string; scope_label?: string; status: string }>; reason: string }

export type SourceRequestRecoveryOutcome = 'completed' | 'risk_required' | 'running' | 'stopped'
export type SourceRequestRecoveryProgress = {
  summary?: SourceRecoverySummary
  outcome: SourceRequestRecoveryOutcome
  phase: 'local_recovery' | 'awaiting_risk' | 'queued' | 'completed' | 'stopped'
  message: string
  /** True only for a persisted controlled run whose dispatch actually began. */
  model_requests_started: boolean
  risk?: {
    scope_token: string
    /** Absence keeps the original unknown-request duplicate-cost wording. */
    confirmation_kind?: 'remaining_model_usage'
    scope: {
      kind: 'quality_repair_and_recheck'
      repair_count: number
      review_count: 1
      max_format_corrections_per_step: 1
      max_model_requests: number
    }
    warning: string
  }
  /** Existing ledger-backed recovery uses its original formal endpoint and
   * identity checks. Its remaining cumulative allowance is never renewed. */
  legacy_resume?: {
    analysis_id: string
    cas_token: string
    client_action_id: string
    workflow_id: string
    max_model_requests: number
    /** Frozen when the exact request-set confirmation is prepared. */
    saved_count?: number
    pending_items?: SourceRecoverySummary['pending_items']
    warning: string
  }
}

/** Read-only continuation identity for refreshes and interrupted HTTP calls. */
export type SourceRequestRecoveryWorkflowSummary = {
  action_id: string
  client_action_id: string
  analysis_id: string
  recovery: SourceRequestRecoveryProgress
}
