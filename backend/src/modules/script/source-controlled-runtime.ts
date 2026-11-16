import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'
import type { ScriptSourceAnalysis, ScriptSourceDocument, ScriptSourceControlledRecoveryScope } from '@video-studio/shared/script/script-source-document'
import { sourceQualityInputHash } from './script-source-quality.js'
import { sourceQualityRepairProgress } from './script-source-quality-progress.js'
import { sourceRepairRequestCheckpoint } from './source-repair-request-identity.js'
import { createSourceStoryDispatchGrant, confirmSourceQualityRound, sourceQualityRoundConfirmation } from './script-source-ordinary-dispatch.js'
import type { StructuredDispatchIntent } from '../generation/model-request-admission.js'
import { withTextRequestUsage } from '../../infrastructure/providers/text-request-usage.js'

export type ControlledSourceRecoveryContext = { document: Omit<ScriptSourceDocument, 'analysis'>; state: ScriptSourceAnalysis;
  configuration_hash: string; local_active: boolean }
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function blocked(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409, code: 'source_controlled_recovery_scope',
    failure_stage: 'recovery', sourceOutputRecoveryBlocked: true, retryable: false })
}
/** Read-only eligibility for the concrete legacy orphan. Saved complete bytes
 * and correction unknowns must follow their existing local/provider path. */
export function controlledSourceRecoveryScope(context: ControlledSourceRecoveryContext): ScriptSourceControlledRecoveryScope | undefined {
  const { state, document } = context, cp = state.quality_repair_output?.checkpoint, review = state.quality
  if (state.controlled_recovery || context.local_active || !['failed', 'paused'].includes(state.status) || state.configuration_hash !== context.configuration_hash ||
    !state.story || review?.status !== 'issues' || !review.findings.length || state.quality_rebuild_for === review.input_hash ||
    state.quality_repair_batch || !cp?.initial_started || cp.raw !== undefined || cp.original_raw !== undefined ||
    cp.correction || cp.correction_started || cp.correction_request || cp.local_repair || !cp.input_hash ||
    cp.initial_started.input_hash !== cp.input_hash || state.quality_repair?.stop_reason || state.quality_repair?.withdrawals?.length) return
  const candidate = structuredClone(state)
  let progress = sourceQualityRepairProgress(candidate)
  if (progress === null && !candidate.quality_repair && review.input_hash === sourceQualityInputHash(candidate)) {
    candidate.quality_repair = { review_hash: review.input_hash, findings_hash: fingerprint(review.findings),
      current_hash: sourceQualityInputHash(candidate), completed_findings: 0 }
    progress = 0
  }
  if (progress === null || progress >= review.findings.length || review.findings.length - progress > 2) return
  const expected = fingerprint([sourceRepairRequestCheckpoint(document, candidate, progress), state.model_id, state.configuration_hash])
  if (state.quality_repair_output!.binding !== expected) return
  const value = { policy: 'source-controlled-quality-workflow-v1' as const, review_hash: review.input_hash,
    findings_hash: fingerprint(review.findings), first_finding: progress, total_findings: review.findings.length,
    max_requests: 2 * (review.findings.length - progress + 1), max_total_requests: 64, max_active_ms: 20 * 60_000 }
  return { ...value, binding: digest({ value, analysis_id: state.id, source_version: state.source_version,
    source_updated_at: document.updated_at, source_content: digest(document.content), model_id: state.model_id,
    configuration_hash: context.configuration_hash, checkpoint: state.quality_repair_output, grant: state.ordinary_story_dispatch ?? null,
    feedback: state.review_feedback ?? null }) }
}

/** The workflow supplies a nonempty, exact DB evidence hash only after
 * checking the prior authorization and every dispatched completed response.
 * Local progress alone never opens or renews a closed authorization. */
export function remainingControlledSourceRecoveryScope(context: ControlledSourceRecoveryContext,
  evidenceHash: string): ScriptSourceControlledRecoveryScope | undefined {
  const { state, document } = context, control = state.controlled_recovery, review = state.quality
  const progress = sourceQualityRepairProgress(state), cp = state.quality_repair_output?.checkpoint
  if (!/^[a-f0-9]{64}$/.test(evidenceHash) || !control?.closed_at || control.outcome !== 'stopped' || control.run_id !== state.id ||
    control.runtime_owner || context.local_active || !['failed', 'paused'].includes(state.status) ||
    state.configuration_hash !== context.configuration_hash || !state.story || review?.status !== 'issues' ||
    progress === null || progress <= control.scope.first_finding || progress >= control.scope.total_findings ||
    review.input_hash !== control.scope.review_hash || fingerprint(review.findings) !== control.scope.findings_hash ||
    review.findings.length !== control.scope.total_findings || state.quality_repair?.stop_reason || state.quality_repair?.withdrawals?.length ||
    state.quality_loop_guard || state.quality_repair_batch || state.quality_rebuild_for === review.input_hash ||
    state.quality_work || !cp || cp.initial_started || cp.correction_started || cp.raw !== undefined || cp.original_raw !== undefined ||
    cp.correction || cp.correction_request || cp.local_repair || control.scope.total_findings - progress > 2 ||
    state.quality_repair?.decisions?.some(item => !['modify_analysis', 'retain_analysis'].includes(item.decision))) return
  const expected = fingerprint([sourceRepairRequestCheckpoint(document, state, progress), state.model_id, state.configuration_hash])
  if (state.quality_repair_output!.binding !== expected) return
  const decisions = state.quality_repair!.decisions || []
  for (let index = control.scope.first_finding; index < progress; index++) {
    if (!decisions.some(item => item.finding_index === index && ['modify_analysis', 'retain_analysis'].includes(item.decision))) return
  }
  const value = { policy: 'source-controlled-quality-workflow-v1' as const, review_hash: review.input_hash,
    findings_hash: fingerprint(review.findings), first_finding: progress, total_findings: review.findings.length,
    max_requests: 2 * (review.findings.length - progress + 1), max_total_requests: 64, max_active_ms: 20 * 60_000,
    predecessor: { run_id: state.id, authorization_id: control.authorization_id, evidence_hash: evidenceHash } }
  return { ...value, binding: digest({ value, source_version: state.source_version, source_updated_at: document.updated_at,
    source_content: digest(document.content), model_id: state.model_id, configuration_hash: context.configuration_hash,
    control, quality_repair: state.quality_repair, outputs: state.quality_repair_outputs,
    checkpoint: state.quality_repair_output, grant: state.ordinary_story_dispatch ?? null, feedback: state.review_feedback ?? null }) }
}

/** Pure state preparation, called only inside the formal authorization CAS.
 * Detaching an archived marker is not a claim that its request was not sent. */
export function prepareControlledSourceRecovery(context: ControlledSourceRecoveryContext,
  authorization: { authorization_id: string; new_run_id: string; scope: ScriptSourceControlledRecoveryScope }): ScriptSourceAnalysis {
  const scope = authorization.scope.predecessor
    ? remainingControlledSourceRecoveryScope(context, authorization.scope.predecessor.evidence_hash)
    : controlledSourceRecoveryScope(context)
  if (!scope || canonicalAiValue(scope) !== canonicalAiValue(authorization.scope) || !authorization.authorization_id ||
    !authorization.new_run_id || authorization.new_run_id === context.state.id) blocked('当前受控恢复范围已变化，未创建新的模型尝试。')
  const next = structuredClone(context.state), stamp = new Date().toISOString()
  ;(next.controlled_recovery_archive ||= []).push({ authorization_id: authorization.authorization_id,
    original_run_id: next.id, archived_at: stamp, output: structuredClone(next.quality_repair_output!),
    ...(next.quality_repair_outputs ? { outputs: structuredClone(next.quality_repair_outputs) } : {}),
    ...(next.ordinary_story_dispatch ? { grant: structuredClone(next.ordinary_story_dispatch) } : {}),
    ...(next.controlled_recovery ? { previous: structuredClone(next.controlled_recovery) } : {}) })
  const pendingRound = sourceQualityRoundConfirmation(next)
  next.id = authorization.new_run_id
  if (pendingRound) confirmSourceQualityRound(next, pendingRound)
  delete next.quality_repair_output
  delete next.ordinary_story_dispatch; delete next.started_at; delete next.queue_position; delete next.resume; delete next.local_validation
  next.status = 'queued'; next.error = null; delete next.failure; next.updated_at = stamp
  // The old lineage is retained only for completed local bytes. The new
  // namespace prevents any late old reply from becoming this attempt's reply.
  next.story_response_run_ids = [...new Set([...(next.story_response_run_ids || []), context.state.id])]
  next.ordinary_story_dispatch = createSourceStoryDispatchGrant({ ...context, state: next, local_active: false })
  if (!next.ordinary_story_dispatch?.quality_workflow || next.ordinary_story_dispatch.quality_workflow.phase !== 'repair' ||
    next.ordinary_story_dispatch.quality_workflow.finding_index !== scope.first_finding) blocked('无法为当前意见建立独立的有界恢复授权。')
  next.ordinary_story_dispatch.bounded_quality = true
  next.controlled_recovery = { authorization_id: authorization.authorization_id, run_id: next.id, scope,
    authorized_at: stamp, active_ms: 0, usage: createScriptRequestUsage(), dispatched: [] }
  return next
}

/** Called in the source dispatch transaction against the latest state. Each
 * exact finding/review phase owns at most one POST across workers/restarts. */
export function controlledSourceDispatchStep(state: ScriptSourceAnalysis, contractName: string | undefined,
  intent: StructuredDispatchIntent | undefined): string {
  const control = state.controlled_recovery, grant = state.ordinary_story_dispatch, workflow = grant?.quality_workflow
  if (!control || control.closed_at || control.run_id !== state.id || state.status !== 'running' ||
    grant?.run_id !== state.id || !grant.bounded_quality || !workflow || !intent) blocked('本次受控恢复已结束或缺少精确请求身份，未派发新请求。')
  const scope = control.scope
  if (scope.policy !== 'source-controlled-quality-workflow-v1' || workflow.review_hash !== scope.review_hash ||
    workflow.findings_hash !== scope.findings_hash || scope.max_requests !== 2 * (scope.total_findings - scope.first_finding + 1) ||
    scope.max_requests > 6 || scope.max_total_requests !== 64 || scope.max_active_ms !== 20 * 60_000) blocked('受控恢复的意见或累计范围已变化，未扩展到新问题。')
  const phase = intent.phase
  let step: string
  if (/^script_source_quality_repair(?:_local_repair|_structure_repair)?$/.test(contractName || '') && workflow.phase === 'repair' &&
    workflow.finding_index >= scope.first_finding && workflow.finding_index < scope.total_findings &&
    state.quality?.input_hash === scope.review_hash && fingerprint(state.quality.findings) === scope.findings_hash) {
    step = 'repair:' + workflow.finding_index + ':' + phase
  } else if (contractName === 'script_source_quality' && workflow.phase === 'review' && workflow.finding_index === scope.total_findings) {
    step = 'review:' + phase
  } else blocked('本次授权只涵盖当前意见及一次独立复核，未派发范围外请求。')
  if (control.dispatched.some(item => item.step === step) || control.dispatched.length >= scope.max_requests) blocked('本步骤的受控请求已经使用，不能因断连或重启重新计费。')
  if (phase === 'correction' && !control.dispatched.some(item => item.step === step.replace(/:correction$/, ':initial'))) blocked('本次格式纠正没有属于同一新授权的初始请求。')
  return step
}

/** A durable child budget narrows, and never renews, the existing cumulative
 * workflow budget. Polls, reservations and interrupted attempts remain spent. */
export async function withControlledSourceWorkflow<T>(state: ScriptSourceAnalysis, persist: () => void,
  signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = state.controlled_recovery
  if (!control) return work(signal)
  if (control.run_id !== state.id || control.closed_at || !Number.isSafeInteger(control.active_ms) || control.active_ms < 0) {
    blocked('受控恢复已结束或用量身份损坏，未续接模型请求。')
  }
  const previous = control.active_ms, started = Date.now(), remaining = control.scope.max_active_ms - previous
  if (remaining <= 0) blocked('本次受控恢复已达到活跃执行时长上限，已有结果已保留。')
  const checkpointFailure = new AbortController()
  const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining), checkpointFailure.signal])
  const charge = () => { control.active_ms = previous + Math.max(0, Date.now() - started) }
  // Persist active time even while a request is waiting or validating. A
  // process restart must not restore the full child duration allowance.
  const timer = setInterval(() => {
    charge()
    try { persist() } catch (issue) { checkpointFailure.abort(issue) }
  }, 5000)
  timer.unref()
  try {
    return await withTextRequestUsage({ usage: control.usage, limits: { max_requests: control.scope.max_requests,
      max_total_requests: control.scope.max_total_requests }, budgetLabel: '本次受控恢复', signal: activeSignal,
      beforeAdmission: () => { charge(); if (control.active_ms >= control.scope.max_active_ms) blocked('本次受控恢复已达到活跃执行时长上限。') },
      onUpdate: () => { charge(); persist() },
    }, () => work(activeSignal))
  } finally { clearInterval(timer); charge(); persist() }
}
