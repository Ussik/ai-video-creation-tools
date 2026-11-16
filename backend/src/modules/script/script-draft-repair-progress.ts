import { createHash } from 'node:crypto'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import { findingIdentity, type FindingResolutionRecord } from './script-finding-state.js'
import type { WorkflowDraft } from './script-workflow.js'

type FindingEvidenceState = { id: string; fingerprint: string; bound: boolean }
type RepairReviewState = { fingerprint: string; finding_ids: string[]; issue_evidence?: FindingEvidenceState[] }
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
  /** Independent review removed an issue; changed evidence alone never proves this. */
  resolved_issue_ids: string[]
  /** Actual bytes changed within verified cited evidence, not review wording. */
  evidence_changed_issue_ids: string[]
  reduced_evidence_issue_ids: string[]
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
const sameReview = (left: RepairReviewState, right: RepairReviewState) => sameIds(left.finding_ids, right.finding_ids) &&
  (left.issue_evidence && right.issue_evidence
    ? JSON.stringify(left.issue_evidence) === JSON.stringify(right.issue_evidence) : left.fingerprint === right.fingerprint)

// Keep this projection pure: completeness review's orchestration imports the
// database. Findings name candidate artifact keys or exact scene:N:field keys;
// uploaded text is comparison material and cannot manufacture issue progress.
function candidateText(draft: WorkflowDraft, key: string): string | undefined {
  const scene = /^scene:(0|[1-9]\d*):(heading|location|time_of_day|characters|action|dialogue|narration|duration)$/.exec(key)
  if (scene) {
    if (draft.stage !== 'episode') return
    const value = draft.scenes[Number(scene[1])]?.[scene[2] as keyof WorkflowDraft['scenes'][number]]
    return value === undefined || value === '' ? undefined : String(value)
  }
  return draft.artifacts.find(artifact => artifact.artifact_type === key)?.content
}
type FindingEvidence = { source_key: string; quote: string; key: string; bound: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function findingEvidence(finding: ScriptDraftFinding, draft: WorkflowDraft): FindingEvidence[] {
  const entries = [finding, ...(finding.related_findings || []).map(item => ({ ...item, source_key: item.source_key || finding.source_key }))]
  return [...new Map(entries.map(({ source_key, quote }) => {
    const content = candidateText(draft, source_key), start = content?.indexOf(quote) ?? -1
    const bound = !!quote.trim() && start >= 0 && content!.indexOf(quote, start + 1) < 0
    const key = digest([source_key, quote])
    return [key, { source_key, quote, key, bound }] as const
  })).values()].sort((left, right) => left.key.localeCompare(right.key))
}
function evidenceState(finding: ScriptDraftFinding, draft: WorkflowDraft): FindingEvidenceState {
  const evidence = findingEvidence(finding, draft)
  // Formatting-only changes cannot create a new attempt state. Raw quotes
  // remain exact and unique for binding; this normalization never locates edits.
  return { id: findingIdentity(finding), fingerprint: digest([...new Set(evidence.map(item =>
    digest([item.source_key, item.bound ? item.quote.replace(/\s+/gu, '') : 'unbound'])))].sort()),
    bound: evidence.length > 0 && evidence.every(item => item.bound) }
}
function reviewedState(draft: WorkflowDraft, source: string | undefined, findings: ScriptDraftFinding[]): RepairReviewState {
  return { fingerprint: scriptDraftRepairFingerprint(draft, source), finding_ids: ids(findings),
    issue_evidence: findings.map(finding => evidenceState(finding, draft)).sort((left, right) => left.id.localeCompare(right.id)) }
}
function issueProgress(before: ScriptDraftFinding | undefined, after: ScriptDraftFinding, previous: WorkflowDraft, current: WorkflowDraft) {
  const old = before ? findingEvidence(before, previous) : [], next = findingEvidence(after, current)
  const bound = old.length > 0 && old.every(item => item.bound) && next.length > 0 && next.every(item => item.bound)
  const reduced = bound && next.length < old.length && next.every(item => old.some(other => other.key === item.key))
  // A reviewer choosing a different quote from unchanged text is not an edit.
  // Compare only verified ranges, never a broad whole-document diff envelope
  // that might enclose an unchanged issue between two unrelated changes.
  const changed = bound && (old.some(item => {
    const content = candidateText(current, item.source_key)
    return content !== undefined && !content.includes(item.quote)
  }) || next.some(item => {
    const content = candidateText(previous, item.source_key)
    return content !== undefined && !content.includes(item.quote)
  }))
  return { bound, changed, reduced }
}

/** Decide only after the independent review has completed. A patch no-op can
 * still pass review. Fewer open issues/sites are independently confirmed
 * progress; changed cited evidence is only a new attempt, not resolution.
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
  const previous = reviewedState(input.before, input.beforeSource, input.beforeFindings)
  const current = reviewedState(input.after, input.afterSource, input.findings)
  const priorReviews = input.history?.reviews || []
  const reviews = [...priorReviews]
  if (!reviews.some(state => sameReview(state, previous))) reviews.push(previous)
  const previouslyReviewed = [...reviews]
  if (!reviews.some(state => sameReview(state, current))) reviews.push(current)
  const history = { ...advanceScriptDraftRepair(input.before, input.after, input.beforeSource, input.afterSource, input.history), reviews }
  const authorized = new Set(input.resolutions.map(record => record.id))
  const decisionFindings = input.findings.filter(finding => !authorized.has(findingIdentity(finding)))
  const known = input.findings.filter(finding => authorized.has(findingIdentity(finding)))
  const resolved = previous.finding_ids.filter(id => !current.finding_ids.includes(id))
  const details = new Map(known.map(finding => [findingIdentity(finding), issueProgress(
    input.beforeFindings.find(before => findingIdentity(before) === findingIdentity(finding)), finding, input.before, input.after)]))
  const progressFacts = { resolved_issue_ids: resolved,
    evidence_changed_issue_ids: known.filter(finding => details.get(findingIdentity(finding))!.changed).map(findingIdentity),
    reduced_evidence_issue_ids: known.filter(finding => details.get(findingIdentity(finding))!.reduced).map(findingIdentity) }
  const stalled = known.filter(finding => {
    const id = findingIdentity(finding), detail = details.get(id)!, currentEvidence = current.issue_evidence!.find(item => item.id === id)!
    if (!currentEvidence.bound) return true
    // Real independently verified partial progress may schedule the remaining
    // authorized issues; unrelated text changes never provide this allowance.
    if (resolved.length || detail.reduced) return false
    const repeated = previouslyReviewed.some(state => state.issue_evidence?.some(item =>
      item.id === id && item.bound && item.fingerprint === currentEvidence.fingerprint) || !state.issue_evidence && sameReview(state, current)) ||
      previous.issue_evidence!.some(item => item.id === id && item.fingerprint === currentEvidence.fingerprint)
    return repeated || !detail.bound || !detail.changed
  })
  const cycle = stalled.some(finding => {
    const id = findingIdentity(finding), detail = details.get(id)!, now = current.issue_evidence!.find(item => item.id === id)!
    return detail.changed && previous.issue_evidence!.some(item => item.id === id && item.fingerprint !== now.fingerprint)
  })
  const reason = stalled.length ? cycle ? 'cycle' as const : 'unchanged' as const : undefined
  const strategyIssues = new Set(input.history?.strategy_issue_ids || [])
  const previousMethod = input.method || input.history?.strategy || 'targeted_patch'
  // A strategy change belongs only to the exact issues for which it was made.
  const reconciled = previousMethod === 'decision_reconciliation'
    ? known.filter(finding => input.method === 'decision_reconciliation' || strategyIssues.has(findingIdentity(finding))) : []
  const stalledIds = new Set(stalled.map(findingIdentity))
  const conflicts = reconciled.filter(finding => stalledIds.has(findingIdentity(finding)))
  const conflictIds = new Set(conflicts.map(findingIdentity))
  const needsDecision = conflicts.length > 0
  const retry = known.filter(finding => !conflictIds.has(findingIdentity(finding)))

  if (!input.findings.length) return { history, ...progressFacts, action: 'complete', message: '当前成果已通过复核，可以确认保存。',
    retry_findings: [], stalled_findings: [], decision_findings: [] }

  const changeStrategy = stalled.filter(finding => !conflictIds.has(findingIdentity(finding)))
  if (changeStrategy.length) {
    history.strategy = 'decision_reconciliation'
    history.strategy_issue_ids = [...new Set([...(history.strategy_issue_ids || []), ...changeStrategy.map(findingIdentity)])]
  }
  if (decisionFindings.length || needsDecision) {
    const decisions = [...decisionFindings, ...conflicts]
    return { history, ...progressFacts, action: 'needs_decision', reason: decisionFindings.length ? 'new_decision' : 'decision_conflict',
      message: needsDecision
        ? '已对照具体决定和相关证据，正文与复核问题仍重复出现。候选稿和已有决定已保留，请查看具体分歧后选择处理方向；其他可执行事项可以继续。'
        : '复核发现新的独立事项，需要明确处理方向。候选稿和已有决定已保留，原有授权仅用于对应事项。',
      retry_findings: retry, stalled_findings: stalled, decision_findings: decisions,
      ...(changeStrategy.length ? { instruction: scriptDraftDecisionReconciliationInstruction } : {}) }
  }
  if (stalled.length) return { history, ...progressFacts, action: 'change_strategy', reason,
    message: reason === 'cycle' ? '当前事项的证据回到了已复核状态，正在改为逐项对照决定与证据，保留当前候选稿。'
      : '当前事项尚无可核实的证据进展，正在改为逐项对照决定与证据，保留当前候选稿。',
    retry_findings: retry, stalled_findings: stalled, decision_findings: [], instruction: scriptDraftDecisionReconciliationInstruction }
  return { history, ...progressFacts, action: 'continue', message: '复核已减少未解决事项或证据位置，或相关证据正文发生了实际变化，继续落实剩余已授权事项；证据变化不代表问题已解决。',
    retry_findings: known, stalled_findings: [], decision_findings: [] }
}
