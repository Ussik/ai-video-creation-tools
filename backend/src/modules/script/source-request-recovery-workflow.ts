import { sourceRecoverySummary } from './source-request-recovery-summary.js'
import { createHash } from 'node:crypto'
import type { SourceRequestLocalRecoveryDecision, SourceRequestRecoveryProgress } from '@video-studio/shared/script/script-source-request-recovery'
import type { ScriptSourceControlledRecoveryScope } from '@video-studio/shared/script/script-source-document'
import { db, newId, now } from '../../infrastructure/database/db.js'
import { explicitModelWorkflowBudgetResume, modelWorkflowBudgetKey } from '../generation/model-workflow-budget.js'
import { hasUsableSourceQuality } from './script-source-quality.js'
import { controlledSourceRecoveryScope, remainingControlledSourceRecoveryScope, prepareControlledSourceRecovery } from './source-controlled-runtime.js'
import { reconcileSourceRequestRecovery, sourceRequestRecoveryBinding, sourceRequestRecoveryDetails,
  type SourceRecoveryAnalysis, type SourceRecoveryContext } from './source-request-recovery-admission.js'
import { sourceRecoveryConflict, sourceRecoveryDigest } from './source-request-recovery.js'
import { sourceRepairRequestCheckpoint } from './source-repair-request-identity.js'
import { sourceQualityInputHash } from './script-source-quality.js'

type Workflow = {
  id: string; project_id: string; client_action_id: string; request_digest: string; analysis_binding: string
  analysis_id: string; target_run_id: string | null; phase: 'inspect' | 'reconcile' | 'local_replay' | 'awaiting_risk' | 'queued' | 'completed' | 'stopped'
  before_snapshot: string; local_action_id: string | null; local_snapshot: string | null; scope: string | null
  scope_token: string | null; authorization_id: string | null; authorization_snapshot: string | null
  result: string | null; created_at: string; updated_at: string
}
type Dependencies = { extractionOnly?: boolean; load(): SourceRecoveryContext
  revalidate(input: { analysisId: string; sourceUpdatedAt: string }): Promise<SourceRecoveryAnalysis> }
export type SourceRequestRecoveryWorkflowResult = {
  action_id: string; reused: boolean; analysis: SourceRecoveryAnalysis
  reconciliation: ReturnType<typeof sourceRequestRecoveryDetails>['reconciliation']; recovery: SourceRequestRecoveryProgress
}
const inFlight = new Map<string, Promise<SourceRequestRecoveryWorkflowResult>>()
const row = (projectId: string, clientActionId: string) => db.prepare('SELECT * FROM source_request_recovery_workflows WHERE project_id=? AND client_action_id=?')
  .get(projectId, clientActionId) as Workflow | undefined
const byId = (id: string) => db.prepare('SELECT * FROM source_request_recovery_workflows WHERE id=?').get(id) as Workflow
const requestDigest = (input: SourceRequestLocalRecoveryDecision) => sourceRecoveryDigest({ analysis_id: input.analysis_id, decision: input.decision })
const snapshot = (projectId: string) => (db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(projectId) as { snapshot: string } | undefined)?.snapshot

function assertIdentity(workflow: Workflow, input: SourceRequestLocalRecoveryDecision, context: SourceRecoveryContext) {
  if (workflow.request_digest !== requestDigest(input) || workflow.analysis_binding !== sourceRequestRecoveryBinding(context) ||
    ![workflow.analysis_id, workflow.target_run_id].includes(context.state.id)) {
    sourceRecoveryConflict('该恢复操作对应的原稿、分析或模型配置已变化，请刷新最新状态。')
  }
}
function progress(outcome: SourceRequestRecoveryProgress['outcome'], phase: SourceRequestRecoveryProgress['phase'], message: string): SourceRequestRecoveryProgress {
  return { outcome, phase, message, model_requests_started: false }
}
function result(projectId: string, workflow: Workflow, context: SourceRecoveryContext, reused: boolean,
  recovery: SourceRequestRecoveryProgress): SourceRequestRecoveryWorkflowResult {
  const details = sourceRequestRecoveryDetails(projectId, () => context)
  return { action_id: workflow.id, reused, analysis: context.state, reconciliation: details.reconciliation,
    recovery: { ...recovery, summary: sourceRecoverySummary(context.state, recovery, details.blockers.length) } }
}
function storedProgress(workflow: Workflow): SourceRequestRecoveryProgress | undefined {
  try { return workflow.result ? JSON.parse(workflow.result) as SourceRequestRecoveryProgress : undefined } catch { return }
}
function writeProgress(workflow: Workflow, value: SourceRequestRecoveryProgress, expectedPhase = workflow.phase) {
  const changed = db.prepare('UPDATE source_request_recovery_workflows SET phase=?,result=?,updated_at=? WHERE id=? AND phase=?')
    .run(value.phase === 'queued' ? 'queued' : value.phase, JSON.stringify(value), now(), workflow.id, expectedPhase)
  if (changed.changes !== 1) sourceRecoveryConflict('恢复步骤已被其他操作更新，请刷新最新状态。')
}
function riskToken(projectId: string, workflow: Workflow, context: SourceRecoveryContext, scope: unknown) {
  return sourceRecoveryDigest({ policy: 'source-controlled-risk-choice-v1', action_id: workflow.id,
    analysis_binding: workflow.analysis_binding, scope, cas_token: sourceRequestRecoveryDetails(projectId, () => context).cas_token })
}
/** This is evidence for offering a NEW remaining-work choice, never authority
 * to reopen the old run. A missing ledger or a counter alone proves nothing. */
function remainingEvidence(projectId: string, context: SourceRecoveryContext): string | undefined {
  const { state } = context, control = state.controlled_recovery
  if (!control?.closed_at || control.outcome !== 'stopped' || control.run_id !== state.id || !control.dispatched.length ||
    control.usage.uncertain_requests !== 0 || control.usage.pending_requests?.length ||
    control.usage.requests < control.dispatched.length) return
  try {
    const original = db.prepare(`SELECT * FROM source_request_recovery_workflows
      WHERE project_id=? AND authorization_id=? AND target_run_id=? AND authorization_snapshot IS NOT NULL`)
      .all(projectId, control.authorization_id, state.id) as Workflow[]
    if (original.length !== 1) return
    const authorization = original[0]!, auth = JSON.parse(authorization.authorization_snapshot!)
    const before = JSON.parse(auth.before_snapshot) as SourceRecoveryAnalysis, scope = control.scope
    if (!['queued', 'stopped'].includes(authorization.phase) || auth.policy !== 'source-controlled-risk-choice-v1' ||
      auth.acknowledged_duplicate_risk !== true || auth.scope_token !== authorization.scope_token ||
      auth.analysis_id !== authorization.analysis_id || before.id !== authorization.analysis_id ||
      auth.source_updated_at !== context.document.updated_at ||
      sourceRecoveryDigest(auth.scope) !== sourceRecoveryDigest(scope) || !authorization.scope ||
      sourceRecoveryDigest(JSON.parse(authorization.scope)) !== sourceRecoveryDigest(scope) ||
      authorization.analysis_binding !== sourceRequestRecoveryBinding(context) ||
      sourceRequestRecoveryBinding({ ...context, state: before }) !== authorization.analysis_binding ||
      before.quality?.input_hash !== scope.review_hash || before.quality?.findings.length !== scope.total_findings ||
      sourceRecoveryDigest(before.quality.findings) !== sourceRecoveryDigest(state.quality?.findings) ||
      scope.policy !== 'source-controlled-quality-workflow-v1' || !Number.isSafeInteger(scope.first_finding) ||
      !Number.isSafeInteger(scope.total_findings) || scope.first_finding < 0 || scope.total_findings <= scope.first_finding ||
      scope.max_requests !== 2 * (scope.total_findings - scope.first_finding + 1) || scope.max_requests > 6 ||
      scope.max_total_requests !== 64 || scope.max_active_ms !== 20 * 60_000) return
    const requestScope = sourceRecoveryDigest({ identity: { source: state.source_version, model: state.model_id,
      configuration: context.configuration_hash }, controlled_recovery: control.authorization_id })
    const requests = db.prepare(`SELECT scope,request_key,state,delivery,result FROM source_model_requests
      WHERE project_id=? AND run_id=? ORDER BY request_key`).all(projectId, state.id) as Array<{
        scope: string; request_key: string; state: string; delivery: string; result: string | null }>
    if (requests.length !== control.dispatched.length || !requests.length ||
      new Set(control.dispatched.map(item => item.step)).size !== control.dispatched.length ||
      new Set(control.dispatched.map(item => item.request_key)).size !== control.dispatched.length) return
    const progress = state.quality_repair?.completed_findings ?? -1
    // This narrow path covers one newly validated original finding, not an
    // inferred multi-finding replay or a changed independent review.
    if (progress !== scope.first_finding + 1) return
    const decision = state.quality_repair?.decisions?.find(item => item.finding_index === scope.first_finding)
    if (!decision || decision.before_hash !== sourceQualityInputHash(before)) return
    const binding = createHash('sha256').update(JSON.stringify([
      sourceRepairRequestCheckpoint(context.document, before, scope.first_finding), state.model_id, state.configuration_hash,
    ])).digest('hex')
    const outputs = (state.quality_repair_outputs || []).filter(output => output.binding === binding)
    if (outputs.length !== 1) return
    for (const dispatched of control.dispatched) {
      const step = /^repair:(\d+):(initial|correction)$/.exec(dispatched.step)
      if (!step || Number(step[1]) < scope.first_finding || Number(step[1]) >= progress) return
      const request = requests.find(item => item.request_key === dispatched.request_key)
      if (!request || request.scope !== requestScope || request.state !== 'completed' || request.delivery !== 'completed' ||
        typeof request.result !== 'string' || !request.result.length) return
      const link = db.prepare(`SELECT 1 FROM source_request_dispatch_links
        WHERE project_id=? AND scope=? AND request_key=? AND run_id=? AND local_request_id=?`)
        .get(projectId, requestScope, dispatched.request_key, state.id, dispatched.local_request_id)
      const admissions = db.prepare(`SELECT input_hash,initial_input_hash,phase FROM source_model_admission_events
        WHERE project_id=? AND scope=? AND request_key=? AND run_id=? AND intent_id=? AND outcome='dispatched'`)
        .all(projectId, requestScope, dispatched.request_key, state.id, dispatched.intent_id) as Array<{
          input_hash: string; initial_input_hash: string; phase: string }>
      const admission = admissions[0], output = outputs[0]!
      if (!link || admissions.length !== 1 || !admission || admission.phase !== step[2] ||
        admission.initial_input_hash !== output.checkpoint.input_hash ||
        (step[2] === 'initial' ? admission.input_hash !== output.checkpoint.input_hash || output.checkpoint.original_raw !== request.result
          : admission.input_hash !== output.checkpoint.correction?.input_hash || output.checkpoint.correction.raw !== request.result)) return
    }
    if (db.prepare('SELECT 1 FROM source_request_recovery_epochs WHERE project_id=? AND run_id=?').get(projectId, state.id)) return
    const backgrounds = db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=?')
      .all(projectId, requestScope) as Array<{ payload: string }>
    if (backgrounds.some(item => ['creating', 'accepted'].includes(JSON.parse(item.payload).state))) return
    return sourceRecoveryDigest({ authorization: { id: authorization.id, snapshot: authorization.authorization_snapshot,
      scope: authorization.scope, binding: authorization.analysis_binding }, dispatched: control.dispatched,
      requests: requests.map(({ result, ...request }) => ({ ...request, response_hash: sourceRecoveryDigest(result) })) })
  } catch { return }
}
function recoveryScope(projectId: string, context: SourceRecoveryContext) {
  // Extraction recovery never authorizes the retired quality repair/review loop.
  if (context.state.analysis_mode === 'extract') return
  if (!context.state.controlled_recovery) return controlledSourceRecoveryScope(context)
  const evidence = remainingEvidence(projectId, context)
  return evidence ? remainingControlledSourceRecoveryScope(context, evidence) : undefined
}
function existingRequestRisk(projectId: string, workflow: Workflow, context: SourceRecoveryContext,
  current: ReturnType<typeof sourceRequestRecoveryDetails>) {
  // A closed controlled authorization cannot be transferred to an ordinary
  // successor. Its separate budget and exact request namespace stay closed.
  if (context.state.controlled_recovery) return
  if (current.blockers.length !== 1 || current.blocked_reason || !current.budget.can_resume) return
  try { assertExistingBudget(context) } catch { return }
  const budget = explicitModelWorkflowBudgetResume(context.state.budget_steps?.[modelWorkflowBudgetKey], 'source_analysis')
  const remaining = Math.min(budget.allowance.max_requests * budget.grants - budget.usage.requests,
    budget.allowance.max_total_requests * budget.grants - budget.usage.requests - budget.usage.transport_requests)
  if (remaining < 1) return
  const scope = { policy: 'source-single-ledger-resume-v1', analysis_id: context.state.id,
    blocker_id: current.blockers[0]!.id, budget_hash: sourceRecoveryDigest(context.state.budget_steps?.[modelWorkflowBudgetKey]) }
  const recovery: SourceRequestRecoveryProgress = { ...progress('risk_required', 'awaiting_risk',
    '已完成本地恢复；有一笔已记录请求的最终结果尚未确认，继续前需要一次明确选择。'),
    legacy_resume: { analysis_id: context.state.id, cas_token: current.cas_token, client_action_id: 'ledger-' + workflow.id,
      workflow_id: workflow.id, max_model_requests: remaining,
      saved_count: sourceRecoverySummary(context.state).saved_count, pending_items: sourceRecoverySummary(context.state).pending_items,
      warning: '旧请求可能已受理或计费。继续将沿正式请求恢复流程建立新的请求身份，可能重复计费；不会取消旧请求或将其标成未发送。仅使用原有累计用量上限，不增加额度，已保存回答和请求历史继续保留。' } }
  return { scope, recovery }
}
function publicRisk(scope: ScriptSourceControlledRecoveryScope, scopeToken: string): SourceRequestRecoveryProgress {
  const repairs = scope.total_findings - scope.first_finding
  if (scope.predecessor) return { ...progress('risk_required', 'awaiting_risk',
    `已使用保存回答完成本地修补；剩余 ${repairs} 项修补和 1 次独立复核需要新的模型用量确认。`),
    risk: { scope_token: scopeToken, confirmation_kind: 'remaining_model_usage',
      scope: { kind: 'quality_repair_and_recheck', repair_count: repairs, review_count: 1,
        max_format_corrections_per_step: 1, max_model_requests: scope.max_requests },
      warning: `上一轮已派发的请求均已完整保存，本地校验已保留完成的修补。本次是独立的新用量授权，只处理剩余 ${repairs} 项修补和 1 次复核，每步最多 1 次格式纠正，最多 ${scope.max_requests} 次模型请求；不会重新处理已完成意见，也不会增加原有累计额度。未确认前不发起模型请求；断连、新问题或没有进展即停止。` } }
  return { ...progress('risk_required', 'awaiting_risk', '已完成本地恢复；旧请求的最终结果仍无法确认，需要一次明确选择后才能继续当前剩余工作。'),
    risk: { scope_token: scopeToken, scope: { kind: 'quality_repair_and_recheck', repair_count: repairs, review_count: 1,
      max_format_corrections_per_step: 1, max_model_requests: scope.max_requests },
      warning: `旧请求可能已受理或计费，无法确认其最终结果。继续会建立独立的新尝试，可能重复计费；仅处理当前 ${repairs} 项修补和 1 次独立复核，每步最多 1 次格式纠正，最多 ${scope.max_requests} 次模型请求。断连、发现新问题或没有进展即停止，原回答、旧请求和已有结果继续保留。` } }
}
/** Validate the existing cumulative ledger, without renewing or clearing it. */
function assertExistingBudget(context: SourceRecoveryContext) {
  const saved = context.state.budget_steps?.[modelWorkflowBudgetKey] as { grants?: number } | undefined
  const validated = explicitModelWorkflowBudgetResume(saved, 'source_analysis')
  if (validated.grants !== saved?.grants) sourceRecoveryConflict('当前累计用量已到上限，受控恢复不会自动增加额度；已有分析继续保留。')
}

/** The local audit and durable replay phase commit together. A legacy audit
 * nonce is linked as evidence; it is never mistaken for a completed workflow. */
function begin(projectId: string, input: SourceRequestLocalRecoveryDecision, deps: Dependencies) {
  return db.transaction(() => {
    const context = deps.load(), previous = row(projectId, input.client_action_id)
    if (previous) { assertIdentity(previous, input, context); return { workflow: previous, reused: true } }
    const current = sourceRequestRecoveryDetails(projectId, () => context)
    if (input.analysis_id !== context.state.id || input.cas_token !== current.cas_token) sourceRecoveryConflict('上次展示的请求或分析状态已变化，请刷新最新状态。')
    if (input.risk_confirmation) sourceRecoveryConflict('风险确认没有对应的本地恢复范围，未创建新请求。')
    if (!current.reconciliation.can_reconcile) sourceRecoveryConflict('分析正在处理、已完成或配置已变化，当前不能恢复。')
    const active = db.prepare("SELECT * FROM source_request_recovery_workflows WHERE project_id=? AND analysis_id=? AND phase IN ('inspect','reconcile','local_replay','awaiting_risk','queued')")
      .get(projectId, context.state.id) as Workflow | undefined
    if (active) {
      let stillExact = true
      try { stillExact = active.analysis_binding === sourceRequestRecoveryBinding(context) && active.local_snapshot === snapshot(projectId) &&
        !!active.scope && active.scope_token === riskToken(projectId, active, context, JSON.parse(active.scope)) } catch { stillExact = false }
      // A fresh explicit local action may retire a stale, unconfirmed choice.
      // It cannot retire an active replay or a paid authorization, and never
      // treats an old risk acknowledgment as permission for changed work.
      if (active.phase === 'awaiting_risk' && !stillExact) writeProgress(active,
        progress('stopped', 'stopped', '原风险选择所依据的状态已变化，已结束该选择；新操作会重新执行本地恢复。'))
      else sourceRecoveryConflict('这份分析已有恢复操作，请等待当前操作或继续其已有选择。')
    }
    const original = snapshot(projectId)
    if (!original) sourceRecoveryConflict('分析已变化，恢复未保存。')
    const id = newId(), stamp = now()
    db.prepare(`INSERT INTO source_request_recovery_workflows
      (id,project_id,client_action_id,request_digest,analysis_binding,analysis_id,phase,before_snapshot,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'inspect',?,?,?)`).run(id, projectId, input.client_action_id, requestDigest(input),
      sourceRequestRecoveryBinding(context), context.state.id, original, stamp, stamp)
    db.prepare("UPDATE source_request_recovery_workflows SET phase='reconcile' WHERE id=?").run(id)
    const legacy = db.prepare('SELECT id,analysis_binding,analysis_id FROM source_request_local_recoveries WHERE project_id=? AND client_action_id=?')
      .get(projectId, input.client_action_id) as { id: string; analysis_binding: string; analysis_id: string } | undefined
    let auditId: string
    if (legacy) {
      if (legacy.analysis_binding !== sourceRequestRecoveryBinding(context) || legacy.analysis_id !== context.state.id) {
        sourceRecoveryConflict('已有本地记录对应的原稿或分析已变化，恢复未继续。')
      }
      auditId = legacy.id
    } else auditId = reconcileSourceRequestRecovery(projectId, input, deps.load).action_id
    db.prepare("UPDATE source_request_recovery_workflows SET phase='local_replay',local_action_id=?,local_snapshot=?,updated_at=? WHERE id=? AND phase='reconcile'")
      .run(auditId, snapshot(projectId), now(), id)
    return { workflow: byId(id), reused: false }
  }).immediate()
}

function queuedResult(projectId: string, workflow: Workflow, context: SourceRecoveryContext, reused: boolean) {
  const started = !!context.state.controlled_recovery?.dispatched.length
  let recovery = context.state.status === 'ready' && (context.state.analysis_mode === 'extract' || hasUsableSourceQuality(context.state))
    ? progress('completed', 'completed', context.state.analysis_mode === 'extract' ? '原稿分析已完成，可复用已保存资料。' : '当前范围的修补和独立复核已完成，可使用已保存分析。')
    : ['queued', 'running'].includes(context.state.status)
      ? progress('running', 'queued', '已按确认范围继续当前修补和独立复核，进度会自动更新。')
      : progress('stopped', 'stopped', context.state.error || context.state.local_validation?.summary || '本次受控恢复已停止；已有结果已保留，请查看当前具体原因。')
  recovery = { ...recovery, model_requests_started: started }
  // Keep queued while the worker is active: its dispatch gate reads this phase.
  if (recovery.phase !== 'queued') {
    db.prepare("UPDATE source_request_recovery_workflows SET local_snapshot=? WHERE id=? AND phase='queued'").run(snapshot(projectId), workflow.id)
    writeProgress(workflow, recovery, 'queued')
  }
  return result(projectId, workflow, context, reused, recovery)
}
function confirmRisk(projectId: string, input: SourceRequestLocalRecoveryDecision, deps: Dependencies) {
  return db.transaction(() => {
    const context = deps.load(), workflow = row(projectId, input.client_action_id)!
    assertIdentity(workflow, input, context)
    if (workflow.phase === 'queued') return queuedResult(projectId, workflow, context, true)
    if (workflow.phase !== 'awaiting_risk' || !input.risk_confirmation) sourceRecoveryConflict('当前恢复不处于需要确认的范围。')
    const current = sourceRequestRecoveryDetails(projectId, () => context)
    const scope = deps.extractionOnly ? undefined : recoveryScope(projectId, context)
    if (input.cas_token !== current.cas_token || context.local_active || !scope || !workflow.scope || !workflow.scope_token ||
      input.risk_confirmation.acknowledged_duplicate_risk !== true || input.risk_confirmation.scope_token !== workflow.scope_token ||
      sourceRecoveryDigest(scope) !== sourceRecoveryDigest(JSON.parse(workflow.scope)) ||
      riskToken(projectId, workflow, context, scope) !== workflow.scope_token || snapshot(projectId) !== workflow.local_snapshot ||
      (!scope.predecessor && current.reconciliation.status !== 'inconsistent') || current.blockers.length !== 0) {
      sourceRecoveryConflict('本次确认对应的分析、旧请求或有界范围已变化，未创建新请求。')
    }
    assertExistingBudget(context)
    const authorizationId = newId(), targetId = newId(), stamp = now()
    const next = prepareControlledSourceRecovery(context, { authorization_id: authorizationId, new_run_id: targetId, scope }) as SourceRecoveryAnalysis
    // This path never calls explicit budget resume or reuses an old permit.
    if (sourceRecoveryDigest(next.budget_steps) !== sourceRecoveryDigest(context.state.budget_steps)) sourceRecoveryConflict('受控恢复不能改变已有累计用量。')
    const recovery = progress('running', 'queued', '已按确认范围继续当前修补和独立复核，进度会自动更新。')
    const changed = db.prepare(`UPDATE source_request_recovery_workflows SET phase='queued',target_run_id=?,authorization_id=?,
      authorization_snapshot=?,result=?,updated_at=? WHERE id=? AND phase='awaiting_risk' AND scope_token=?`)
      .run(targetId, authorizationId, JSON.stringify({ policy: 'source-controlled-risk-choice-v1',
        acknowledged_duplicate_risk: true, scope_token: workflow.scope_token, scope, analysis_id: context.state.id,
        before_snapshot: snapshot(projectId), source_updated_at: context.document.updated_at, confirmed_at: stamp }),
        JSON.stringify(recovery), stamp, workflow.id, input.risk_confirmation.scope_token)
    if (changed.changes !== 1) sourceRecoveryConflict('此恢复范围已确认或状态已变化，未重复创建新请求。')
    db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(targetId, projectId)
    const updated = db.prepare('UPDATE script_source_analyses SET id=?,status=?,snapshot=?,updated_at=? WHERE project_id=? AND id=? AND snapshot=?')
      .run(targetId, next.status, JSON.stringify(next), next.updated_at, projectId, context.state.id, workflow.local_snapshot)
    if (updated.changes !== 1) sourceRecoveryConflict('分析在确认期间已变化，未创建新请求。')
    return result(projectId, byId(workflow.id), { ...context, state: next }, false, recovery)
  }).immediate()
}

async function execute(projectId: string, input: SourceRequestLocalRecoveryDecision, deps: Dependencies): Promise<SourceRequestRecoveryWorkflowResult> {
  let { workflow, reused } = begin(projectId, input, deps)
  let context = deps.load()
  if (workflow.phase === 'queued') return queuedResult(projectId, workflow, context, true)
  if (workflow.phase === 'completed' || workflow.phase === 'stopped') {
    const recovery = storedProgress(workflow) || progress('stopped', 'stopped', '本次恢复已结束，请查看当前分析结果。')
    return result(projectId, workflow, context, true, recovery)
  }
  if (workflow.phase === 'awaiting_risk') {
    if (input.risk_confirmation) return confirmRisk(projectId, input, deps)
    if (snapshot(projectId) !== workflow.local_snapshot || !workflow.scope ||
      riskToken(projectId, workflow, context, JSON.parse(workflow.scope)) !== workflow.scope_token) {
      sourceRecoveryConflict('恢复所依据的分析或请求状态已变化，请刷新最新状态。')
    }
    return result(projectId, workflow, context, true, storedProgress(workflow)!)
  }
  if (input.risk_confirmation) sourceRecoveryConflict('本地恢复尚未完成，未接受风险决定。')
  if (context.local_active) return result(projectId, workflow, context, true, progress('running', 'local_recovery', '正在复用保存回答并校验，完成后自动给出结果。'))
  // A restart may leave this local-only phase behind. Its worker never has a
  // dispatch grant; the analyzer restart guard pauses it instead of queueing.
  if (['running', 'queued'].includes(context.state.status)) sourceRecoveryConflict('本地恢复尚未安全暂停，请稍后刷新；未创建新模型请求。')
  try { await deps.revalidate({ analysisId: workflow.analysis_id, sourceUpdatedAt: context.document.updated_at }) }
  catch (issue) {
    db.transaction(() => {
      const latest = byId(workflow.id)
      if (latest.phase === 'local_replay') writeProgress(latest, progress('stopped', 'stopped', issue instanceof Error ? issue.message : '本地恢复已停止，请刷新当前分析。'))
    }).immediate()
    throw issue
  }
  return db.transaction(() => {
    workflow = byId(workflow.id); context = deps.load(); assertIdentity(workflow, input, context)
    if (workflow.phase !== 'local_replay') sourceRecoveryConflict('本地恢复已由其他操作完成，请刷新当前状态。')
    let recovery: SourceRequestRecoveryProgress
    const current = sourceRequestRecoveryDetails(projectId, () => context)
    if (context.state.status === 'ready' && (context.state.analysis_mode === 'extract' || hasUsableSourceQuality(context.state))) recovery = progress('completed', 'completed', '已复用保存回答完成本地校验，可使用已保存分析。')
    else {
      const scope = deps.extractionOnly ? undefined : recoveryScope(projectId, context)
      if (scope && (scope.predecessor || current.reconciliation.status === 'inconsistent') && current.blockers.length === 0) {
        try { assertExistingBudget(context) }
        catch (issue) {
          recovery = progress('stopped', 'stopped', issue instanceof Error ? issue.message : '当前累计额度不能继续，已有结果已保留。')
          db.prepare("UPDATE source_request_recovery_workflows SET local_snapshot=? WHERE id=? AND phase='local_replay'").run(snapshot(projectId), workflow.id)
          writeProgress(workflow, recovery)
          return result(projectId, workflow, context, reused, recovery)
        }
        const token = riskToken(projectId, workflow, context, scope)
        recovery = publicRisk(scope, token)
        const changed = db.prepare("UPDATE source_request_recovery_workflows SET phase='awaiting_risk',scope=?,scope_token=?,local_snapshot=?,result=?,updated_at=? WHERE id=? AND phase='local_replay'")
          .run(JSON.stringify(scope), token, snapshot(projectId), JSON.stringify(recovery), now(), workflow.id)
        if (changed.changes !== 1) sourceRecoveryConflict('本地恢复范围已变化，请刷新当前状态。')
        return result(projectId, byId(workflow.id), context, reused, recovery)
      }
      const legacy = deps.extractionOnly && context.state.analysis_mode !== 'extract' ? undefined : existingRequestRisk(projectId, workflow, context, current)
      if (legacy) {
        const token = riskToken(projectId, workflow, context, legacy.scope)
        const changed = db.prepare("UPDATE source_request_recovery_workflows SET phase='awaiting_risk',scope=?,scope_token=?,local_snapshot=?,result=?,updated_at=? WHERE id=? AND phase='local_replay'")
          .run(JSON.stringify(legacy.scope), token, snapshot(projectId), JSON.stringify(legacy.recovery), now(), workflow.id)
        if (changed.changes !== 1) sourceRecoveryConflict('本地恢复范围已变化，请刷新当前状态。')
        return result(projectId, byId(workflow.id), context, reused, legacy.recovery)
      }
      recovery = progress('stopped', 'stopped', context.state.controlled_recovery
        ? '本次有界恢复授权已停止；已保存回答和未知请求保护继续保留，不会转移旧许可或再次自动计费。后续若取得完整回答，仍可进行本地校验。'
        : context.state.local_validation?.summary || context.state.error || current.reconciliation.message)
    }
    db.prepare('UPDATE source_request_recovery_workflows SET local_snapshot=? WHERE id=? AND phase=?')
      .run(snapshot(projectId), workflow.id, workflow.phase)
    writeProgress(workflow, recovery)
    return result(projectId, workflow, context, reused, recovery)
  }).immediate()
}

/** One explicit action runs all safe local stages. Only its exact, future risk
 * choice may atomically create one independently identified bounded run. GET
 * never invokes this function. Same-action concurrent calls share local work. */
export async function recoverSourceRequestWorkflow(projectId: string, input: SourceRequestLocalRecoveryDecision, deps: Dependencies): Promise<SourceRequestRecoveryWorkflowResult> {
  const key = projectId + ':' + input.client_action_id, existing = inFlight.get(key)
  if (existing) { await existing; return recoverSourceRequestWorkflow(projectId, input, deps) }
  const work = execute(projectId, input, deps).finally(() => { if (inFlight.get(key) === work) inFlight.delete(key) })
  inFlight.set(key, work)
  return work
}
