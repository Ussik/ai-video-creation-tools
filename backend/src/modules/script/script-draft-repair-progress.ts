import { createHash } from 'node:crypto'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import { findingIdentity, type FindingResolutionRecord } from './script-finding-state.js'
import type { WorkflowDraft } from './script-workflow.js'

type RepairReviewState = { fingerprint: string; finding_ids: string[] }
export type ScriptDraftRepairStrategy = 'targeted_patch' | 'decision_reconciliation'
export type ScriptDraftRepairHistory = {
  states: string[]; diagnostic?: 'unchanged' | 'repeated'
  /** Completed semantic reviews, not transport retries or patch proposals. */
  reviews?: RepairReviewState[]
  strategy?: ScriptDraftRepairStrategy
  strategy_issue_ids?: string[]
}

export type ScriptDraftRepairProgress = {
  history: ScriptDraftRepairHistory
  action: 'complete' | 'continue' | 'change_strategy' | 'needs_decision'
  reason?: 'unchanged' | 'cycle' | 'new_decision' | 'decision_conflict'
  message: string
  /** Only these exact, already-authorized issues may be repaired automatically. */
  retry_findings: ScriptDraftFinding[]
  stalled_findings: ScriptDraftFinding[]
  decision_findings: ScriptDraftFinding[]
  instruction?: string
}

export const scriptDraftDecisionReconciliationInstruction = '先批量读取仍有问题的原文和直接关联文档，逐项对照已保留的具体决定、当前正文和复核证据，明确哪一条决定尚未落实及其对应位置，再提交新的最小修订。不得重新选择已有决定，不得重放相同补丁；若原决定已落实而复核仍提出相反要求，说明具体分歧并保留候选稿，不编造新决定。'

/** Hash only actual candidate text and the effective manuscript. Runtime IDs,
 * summaries and review wording cannot make a no-op look like progress. */
export function scriptDraftRepairFingerprint(draft: WorkflowDraft, manuscript?: string): string {
  return createHash('sha256').update(JSON.stringify({
    artifacts: draft.artifacts.map(({ artifact_type, title, content }) => ({ artifact_type, title, content }))
      .sort((left, right) => left.artifact_type.localeCompare(right.artifact_type)),
    scenes: draft.scenes, manuscript: manuscript || '',
  })).digest('hex')
}

export function advanceScriptDraftRepair(before: WorkflowDraft, after: WorkflowDraft,
  beforeSource?: string, afterSource?: string, history?: ScriptDraftRepairHistory): ScriptDraftRepairHistory {
  const previous = scriptDraftRepairFingerprint(before, beforeSource)
  const next = scriptDraftRepairFingerprint(after, afterSource)
  const diagnostic = previous === next ? 'unchanged' : history?.states.includes(next) ? 'repeated' : undefined
  return { ...history, states: [...new Set([...(history?.states || []), previous, next])], diagnostic }
}

const ids = (findings: ScriptDraftFinding[]) => [...new Set(findings.map(findingIdentity))].sort()
const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index])
const sameReview = (left: RepairReviewState, right: RepairReviewState) => left.fingerprint === right.fingerprint && sameIds(left.finding_ids, right.finding_ids)

/** Decide only after the independent review has completed. A patch no-op can
 * still pass review; a changed manuscript or fewer open issues is progress.
 * Exact issue identities retain the existing authorization boundary: this
 * function never matches by fuzzy topic, quote similarity or a batch decision.
 *
 * Changing strategy is driven by repeated work, not a round/token quota. The
 * alternate method is retained with the candidate so a restart does not reset
 * it. Unrelated authorized findings remain separately schedulable. */
export function assessScriptDraftRepairProgress(input: {
  before: WorkflowDraft; after: WorkflowDraft
  beforeSource?: string; afterSource?: string
  beforeFindings: ScriptDraftFinding[]; findings: ScriptDraftFinding[]
  resolutions: FindingResolutionRecord[]; history?: ScriptDraftRepairHistory
  method?: ScriptDraftRepairStrategy
}): ScriptDraftRepairProgress {
  const previous: RepairReviewState = { fingerprint: scriptDraftRepairFingerprint(input.before, input.beforeSource), finding_ids: ids(input.beforeFindings) }
  const current: RepairReviewState = { fingerprint: scriptDraftRepairFingerprint(input.after, input.afterSource), finding_ids: ids(input.findings) }
  const priorReviews = input.history?.reviews || []
  const reviews = [...priorReviews]
  if (!reviews.some(state => sameReview(state, previous))) reviews.push(previous)
  const repeated = reviews.some(state => sameReview(state, current))
  if (!reviews.some(state => sameReview(state, current))) reviews.push(current)
  const history = { ...advanceScriptDraftRepair(input.before, input.after, input.beforeSource, input.afterSource, input.history), reviews }
  const authorized = new Set(input.resolutions.map(record => record.id))
  const decisionFindings = input.findings.filter(finding => !authorized.has(findingIdentity(finding)))
  const known = input.findings.filter(finding => authorized.has(findingIdentity(finding)))
  const resolved = previous.finding_ids.some(id => !current.finding_ids.includes(id))
  const stagnant = !resolved && repeated
  const reason = stagnant ? current.fingerprint === previous.fingerprint ? 'unchanged' as const : 'cycle' as const : undefined
  const strategyIssues = new Set(input.history?.strategy_issue_ids || [])
  const previousMethod = input.method || input.history?.strategy || 'targeted_patch'
  // A strategy change belongs only to the exact issues for which it was made.
  const reconciled = previousMethod === 'decision_reconciliation'
    ? known.filter(finding => input.method === 'decision_reconciliation' || strategyIssues.has(findingIdentity(finding))) : []
  const stalled = stagnant ? known : []
  const conflicts = stagnant ? reconciled : []
  const conflictIds = new Set(conflicts.map(findingIdentity))
  const needsDecision = conflicts.length > 0
  const retry = known.filter(finding => !conflictIds.has(findingIdentity(finding)))

  if (!input.findings.length) return { history, action: 'complete', message: '当前成果已通过复核，可以确认保存。',
    retry_findings: [], stalled_findings: [], decision_findings: [] }

  const changeStrategy = stalled.filter(finding => !conflictIds.has(findingIdentity(finding)))
  if (changeStrategy.length) {
    history.strategy = 'decision_reconciliation'
    history.strategy_issue_ids = [...new Set([...(history.strategy_issue_ids || []), ...changeStrategy.map(findingIdentity)])]
  }
  if (decisionFindings.length || needsDecision) {
    const decisions = [...decisionFindings, ...conflicts]
    return { history, action: 'needs_decision', reason: decisionFindings.length ? 'new_decision' : 'decision_conflict',
      message: needsDecision
        ? '已对照具体决定和相关证据，正文与复核问题仍重复出现。候选稿和已有决定已保留，请查看具体分歧后选择处理方向；其他可执行事项可以继续。'
        : '复核发现新的独立事项，需要明确处理方向。候选稿和已有决定已保留，原有授权仅用于对应事项。',
      retry_findings: retry, stalled_findings: stalled, decision_findings: decisions,
      ...(changeStrategy.length ? { instruction: scriptDraftDecisionReconciliationInstruction } : {}) }
  }
  if (stalled.length) return { history, action: 'change_strategy', reason,
    message: reason === 'cycle' ? '修订回到了已复核过的正文和问题，正在改为逐项对照决定与证据，保留当前候选稿。'
      : '正文和复核问题均未变化，正在改为逐项对照决定与证据，保留当前候选稿。',
    retry_findings: retry, stalled_findings: stalled, decision_findings: [], instruction: scriptDraftDecisionReconciliationInstruction }
  return { history, action: 'continue', message: '候选稿或已解决事项已有进展，继续落实剩余已授权事项。',
    retry_findings: known, stalled_findings: [], decision_findings: [] }
}
