import { sourceRecoverySummary } from './source-request-recovery-summary.js'
import { sourceFeedbackIdentity } from './script-source-feedback-review.js'
import { sourceQualityRepairUpgradeBinding } from './script-source-quality-repair.js'
import { db, newId, now } from '../../infrastructure/database/db.js'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { explicitModelWorkflowBudgetResume, modelWorkflowBudgetKey } from '../generation/model-workflow-budget.js'
import { sourceRequestBlockers, sourceRecoveryConflict, sourceRecoveryDigest } from './source-request-recovery.js'
import { sourceCheckpointResponseFact, type SourceRequestReconciliation, type SourceRequestRecoveryProgress,
  type SourceRequestRecoveryWorkflowSummary } from '@video-studio/shared/script/script-source-request-recovery'
export type { SourceRequestLocalRecoveryDecision } from '@video-studio/shared/script/script-source-request-recovery'
import type { SourceRequestLocalRecoveryDecision } from '@video-studio/shared/script/script-source-request-recovery'
import { sourceAnalysisRecoveryCheckpoint, sourceAnalysisRecoveryCheckpoints, sourceAnalysisResume } from './script-source-checkpoints.js'
import { sourceModelAdmissionFact, applyTrustedNotSentToCheckpoint } from './source-model-recovery.js'
import { prepareSourceQualityNextRound } from './script-source-ordinary-dispatch.js'
import { hasUsableSourceQuality } from './script-source-quality.js'

export type SourceRecoveryAnalysis = ScriptSourceAnalysis & { budget_steps?: Record<string, unknown> }
export type SourceRecoveryContext = { document: Omit<ScriptSourceDocument, 'analysis'>; state: SourceRecoveryAnalysis; configuration_hash: string; local_active: boolean }
type Analysis = SourceRecoveryAnalysis
type Context = SourceRecoveryContext
export type SourceRequestRecoveryDecision = { analysis_id: string; cas_token: string; client_action_id: string
  decision: 'abandon_and_resume'; acknowledged_duplicate_risk: true; workflow_id?: string }
type Action = { id: string; request_digest: string; analysis_binding: string; target_run_id: string }

export function sourceRequestRecoveryBinding(context: Context) {
  return sourceRecoveryDigest(binding(context))
}
function binding(context: Context) {
  return { source_version: context.state.source_version, source_updated_at: context.document.updated_at,
    model_id: context.state.model_id, configuration_hash: context.configuration_hash,
    source_digest: sourceRecoveryDigest(context.document.content), feedback_digest: sourceRecoveryDigest(sourceFeedbackIdentity(context.state) ?? null) }
}
function reconciliation(projectId: string, context: Context, blockers: ReturnType<typeof sourceRequestBlockers>) {
  const selected = sourceAnalysisRecoveryCheckpoint(context.state), checkpoint = selected.checkpoint
  const responses = sourceAnalysisRecoveryCheckpoints(context.state).map(item => sourceCheckpointResponseFact(item.checkpoint))
  const saved = responses.some(item => item.saved), safeSaved = responses.some(item => item.response === 'saved_response')
  const marker = selected.phase === 'correction' ? checkpoint?.correction_started : checkpoint?.initial_started
  const admission = marker ? sourceModelAdmissionFact(projectId, { run_ids: [context.state.id, ...(context.state.story_response_run_ids || [])],
    input_hash: marker.input_hash, phase: selected.phase, ...('intent_id' in marker ? { intent_id: marker.intent_id as string } : {}),
    ...(selected.binding ? { checkpoint_binding: selected.binding } : {}) }) : undefined
  const unknown = responses.some(item => item.initial_unknown || item.correction_unknown) ||
    !saved && sourceAnalysisResume(context.state).action === 'reconcile_request'
  const base = { version: 1 as const, saved_response: saved, checkpoint_unknown: unknown, ledger_unknown: blockers.length,
    can_reconcile: !context.local_active && ['failed', 'paused'].includes(context.state.status) &&
      context.state.configuration_hash === context.configuration_hash }
  let facts: SourceRequestReconciliation
  if (unknown && admission?.verdict === 'trusted_not_sent') facts = { ...base, status: 'trusted_not_sent',
    next: saved ? 'local_revalidate' : 'explicit_continue',
    message: '有精确绑定本次尝试的派发前拒绝证据，可在本地纠正未发送标记；本次操作不会调用模型或授予新的生成许可。' }
  else if (safeSaved) facts = { ...base, status: 'saved_response', next: 'local_revalidate',
    message: unknown || blockers.length
      ? '部分任务有完整回答，可先在本地校验这些保存字节。其他任务仍有未确认请求；未知标记与防重复保护继续保留，不会因本地复用而重新发送。'
      : '当前步骤有完整回答，可按当前绑定在本地重新校验；不会调用模型，也不会重置纠正额度。' }
  else if (unknown && (admission?.verdict === 'accepted' || admission?.verdict === 'dispatched')) facts = { ...base,
    status: 'unknown_response', next: 'provider_reconcile',
    message: '精确记录表明本次请求已经派发或受理，但完整回答尚未进入当前检查点。它仍沿原请求身份核对，不能当作未发送，也不会自动重新生成。' }
  else if (unknown) facts = { ...base, status: blockers.length ? 'unknown_response' : 'inconsistent',
    next: blockers.length ? 'provider_reconcile' : 'inspect_conflict',
    message: blockers.length ? '检查点仍记录未取回回答的请求，远端结果尚未确认；原回答及请求保护继续保留，不会自动重发。'
      : '当前步骤有未取回回答的标记，但当前台账没有对应的未知请求。两者不一致，不能仅凭空列表认定未发送；标记、已有分析和旧记录均保留，需核对具体请求证据。' }
  else if (blockers.length) facts = { ...base, status: 'unknown_response', next: 'provider_reconcile',
    message: '台账仍有远端结果未确认的请求。当前步骤没有完整回答可复用，须先核对提供商记录；不会自动重新发送。' }
  else facts = { ...base, status: 'no_pending_request', next: sourceAnalysisResume(context.state).next?.model_required ? 'explicit_continue' : 'none',
    message: '当前步骤没有待取回回答的标记。没有台账阻断不表示分析已经完成；下一步按已保存分析状态处理，生成新内容仍须单独确认。' }
  return { facts, admission, selected }
}
function view(projectId: string, context: Context) {
  const { state, document } = context
  const runs = [state.id, ...(state.story_response_run_ids || [])]
  const blockers = sourceRequestBlockers(projectId, runs)
  const assessed = reconciliation(projectId, context, blockers)
  const stored = db.prepare('SELECT id,source_version,status,snapshot,updated_at FROM script_source_analyses WHERE project_id=?').get(projectId)
  const cas = sourceRecoveryDigest({ projectId, document, stored, configuration_hash: context.configuration_hash, blockers,
    reconciliation: assessed.facts, admission: assessed.admission })
  const workflow = db.prepare(`SELECT id,client_action_id,analysis_id,target_run_id,analysis_binding,phase,local_snapshot,scope,scope_token,result
    FROM source_request_recovery_workflows WHERE project_id=? AND (analysis_id=? OR target_run_id=?) ORDER BY rowid DESC LIMIT 1`)
    .get(projectId, state.id, state.id) as { id: string; client_action_id: string; analysis_id: string; target_run_id: string | null;
      analysis_binding: string; phase: string; local_snapshot: string | null; scope: string | null; scope_token: string | null; result: string | null } | undefined
  let recoveryWorkflow: SourceRequestRecoveryWorkflowSummary | undefined
  if (workflow && workflow.analysis_binding === sourceRequestRecoveryBinding(context)) {
    let recovery: SourceRequestRecoveryProgress | undefined
    try { recovery = workflow.result ? JSON.parse(workflow.result) as SourceRequestRecoveryProgress : undefined } catch { /* Invalid internal state is never a grant. */ }
    if (['inspect', 'reconcile', 'local_replay'].includes(workflow.phase)) recovery = { outcome: 'running', phase: 'local_recovery',
      message: context.local_active ? '正在复用保存回答并校验，完成后自动给出结果。' : '上次本地恢复已中断，可从同一操作继续；不会新建模型请求。', model_requests_started: false }
    if (workflow.phase === 'queued') {
      const started = !!state.controlled_recovery?.dispatched.length
      recovery = state.status === 'ready' && (state.analysis_mode === 'extract' || hasUsableSourceQuality(state))
        ? { outcome: 'completed', phase: 'completed', message: state.analysis_mode === 'extract' ? '原稿分析已完成，可复用已保存资料。' : '当前范围的修补和独立复核已完成，可使用已保存分析。', model_requests_started: started }
        : ['queued', 'running'].includes(state.status)
          ? { outcome: 'running', phase: 'queued', message: '正在按已确认的有界范围继续，进度会自动更新。', model_requests_started: started }
          : { outcome: 'stopped', phase: 'stopped', message: state.error || '本次受控恢复已停止，已有结果已保留。', model_requests_started: started }
    }
    if (workflow.phase === 'awaiting_risk') {
      let token: string | undefined
      try { token = workflow.scope ? sourceRecoveryDigest({ policy: 'source-controlled-risk-choice-v1', action_id: workflow.id,
        analysis_binding: workflow.analysis_binding, scope: JSON.parse(workflow.scope), cas_token: cas }) : undefined } catch { /* Fail closed. */ }
      if (workflow.local_snapshot !== (stored as { snapshot?: string } | undefined)?.snapshot || token !== workflow.scope_token) recovery = {
        outcome: 'stopped', phase: 'stopped', message: '恢复所依据的分析或请求状态已变化，请刷新当前分析；未创建新请求。', model_requests_started: false }
    }
    // A terminal result describes its saved snapshot, not arbitrary future
    // raw bytes or edits. Do not let an old terminal summary suppress a new
    // explicit local recovery on the now-current state.
    if (['completed', 'stopped'].includes(workflow.phase) && workflow.local_snapshot !== (stored as { snapshot?: string } | undefined)?.snapshot) recovery = undefined
    if (recovery) recoveryWorkflow = { action_id: workflow.id, client_action_id: workflow.client_action_id, analysis_id: state.id, recovery: { ...recovery, summary: sourceRecoverySummary(state, recovery, blockers.length) } }
  }
  let canResume = true, reason: string | undefined
  try { explicitModelWorkflowBudgetResume(state.budget_steps?.[modelWorkflowBudgetKey], 'source_analysis') }
  catch (issue) { canResume = false; reason = issue instanceof Error ? issue.message : '当前累计额度不能继续，请检查保留结果。' }
  const saved = state.budget_steps?.[modelWorkflowBudgetKey] as { grants?: number; exhausted?: string } | undefined
  if (context.local_active || ['running', 'queued'].includes(state.status)) reason = '分析仍在本地处理，请等待当前执行结束。'
  else if (!['failed', 'paused'].includes(state.status)) reason = '当前分析不处于可恢复的中断状态。'
  else if (!state.configuration_hash || state.configuration_hash !== context.configuration_hash) reason = '模型或提供商配置已变化，请重新核对当前分析。'
  else if (blockers.length !== 1) reason = blockers.length ? '当前有多条未知请求，暂不能一次重新生成。' : '当前没有需要人工处理的未知请求。'
  return { analysis_id: state.id, source_updated_at: document.updated_at, model_id: state.model_id, cas_token: cas,
    local_active: context.local_active, budget: { can_resume: canResume, grants: saved?.grants ?? 0, max_grants: 3,
      ...(saved?.exhausted ? { exhausted: saved.exhausted } : {}) }, ...(reason ? { blocked_reason: reason } : {}),
    summary: sourceRecoverySummary(state, undefined, blockers.length),
    reconciliation: assessed.facts,
    ...(recoveryWorkflow ? { recovery_workflow: recoveryWorkflow } : {}),
    blockers: blockers.map(({ id, scope, request_key, run_id, updated_at, state: requestState, delivery,
      local_request_id, upstream_request_id, identity_binding }) => ({ id, scope, request_key, run_id, updated_at,
      state: requestState as 'dispatched', delivery, local_request_id, upstream_request_id, identity_binding })) }
}

/** A queued permit remains bound when the worker starts or dispatches later. */
export function assertSourceRequestRecoveryBinding(projectId: string, context: Context) {
  const action = db.prepare('SELECT analysis_binding FROM source_request_recovery_actions WHERE project_id=? AND target_run_id=?')
    .get(projectId, context.state.id) as { analysis_binding: string } | undefined
  if (action && action.analysis_binding !== sourceRequestRecoveryBinding(context)) {
    sourceRecoveryConflict('恢复许可对应的原稿、反馈、模型或配置已变化；已保存分析保留，请重新核对。')
  }
}

/** load() must validate effective source/version and read current model config.
 * It is called again inside the write transaction, never captured from GET. */
export function sourceRequestRecoveryDetails(projectId: string, load: () => Context) {
  return view(projectId, load())
}

/** A separately audited local operation. It never creates a run, renews a
 * budget, queues work, or treats an absent ledger row as proof of not_sent. */
export function reconcileSourceRequestRecovery(projectId: string, input: SourceRequestLocalRecoveryDecision, load: () => Context) {
  return db.transaction(() => {
    const context = load(), digest = sourceRecoveryDigest(input)
    const previous = db.prepare('SELECT id,request_digest,analysis_binding,analysis_id,facts FROM source_request_local_recoveries WHERE project_id=? AND client_action_id=?')
      .get(projectId, input.client_action_id) as { id: string; request_digest: string; analysis_binding: string; analysis_id: string; facts: string } | undefined
    if (previous) {
      if (previous.request_digest !== digest || previous.analysis_binding !== sourceRequestRecoveryBinding(context) || previous.analysis_id !== context.state.id) {
        sourceRecoveryConflict('该本地恢复操作对应的原稿、分析或配置已变化，请重新核对。')
      }
      return { action_id: previous.id, analysis: context.state, reused: true,
        reconciliation: view(projectId, context).reconciliation, local_revalidate: false }
    }
    const current = view(projectId, context)
    if (input.analysis_id !== context.state.id || input.cas_token !== current.cas_token) sourceRecoveryConflict('上次展示的请求或分析状态已变化，请重新核对。')
    if (!current.reconciliation.can_reconcile) sourceRecoveryConflict('分析正在处理、已完成或配置已变化，当前不能进行本地恢复。')
    const original = db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=? AND id=?')
      .get(projectId, context.state.id) as { snapshot: string } | undefined
    if (!original) sourceRecoveryConflict('分析已变化，本地恢复未保存。')
    const next = structuredClone(context.state)
    const assessed = reconciliation(projectId, { ...context, state: next }, sourceRequestBlockers(projectId, [next.id, ...(next.story_response_run_ids || [])]))
    if (assessed.facts.status === 'trusted_not_sent' && assessed.selected.checkpoint && assessed.admission) {
      if (!applyTrustedNotSentToCheckpoint(assessed.selected.checkpoint, assessed.admission)) sourceRecoveryConflict('本次派发前拒绝证据已变化，未清除任何请求标记。')
    }
    prepareSourceQualityNextRound(next)
    const nextContext = { ...context, state: next }
    const after = reconciliation(projectId, nextContext, sourceRequestBlockers(projectId, [next.id, ...(next.story_response_run_ids || [])])).facts
    const actionId = newId(), stamp = now(), changedByValue = sourceRecoveryDigest(next) !== sourceRecoveryDigest(context.state)
    if (changedByValue) next.updated_at = stamp
    const afterSnapshot = changedByValue ? JSON.stringify(next) : original.snapshot
    db.prepare(`INSERT INTO source_request_local_recoveries
      (id,project_id,client_action_id,request_digest,analysis_binding,analysis_id,before_snapshot,after_snapshot,facts,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(actionId, projectId, input.client_action_id, digest, sourceRequestRecoveryBinding(context), context.state.id,
        original.snapshot, afterSnapshot, JSON.stringify({ before: assessed.facts, admission: assessed.admission, after }), stamp)
    if (afterSnapshot !== original.snapshot) {
      const changed = db.prepare('UPDATE script_source_analyses SET snapshot=?,updated_at=? WHERE project_id=? AND id=? AND snapshot=?')
        .run(afterSnapshot, stamp, projectId, context.state.id, original.snapshot)
      if (changed.changes !== 1) sourceRecoveryConflict('分析在本地恢复期间已变化，操作未保存。')
    }
    return { action_id: actionId, analysis: next, reused: false, reconciliation: after,
      local_revalidate: after.next === 'local_revalidate' }
  }).immediate()
}
export function admitSourceRequestRecovery(projectId: string, input: SourceRequestRecoveryDecision, load: () => Context,
  options: { preserveBudget?: boolean } = {}) {
  return db.transaction(() => {
    const context = load(), digest = sourceRecoveryDigest(input)
    const previous = db.prepare('SELECT id,request_digest,analysis_binding,target_run_id FROM source_request_recovery_actions WHERE project_id=? AND client_action_id=?')
      .get(projectId, input.client_action_id) as Action | undefined
    if (previous) {
      if (previous.request_digest !== digest || previous.analysis_binding !== sourceRequestRecoveryBinding(context) || context.state.id !== previous.target_run_id) {
        sourceRecoveryConflict('该决定对应的分析或原稿已变化，请重新核对。')
      }
      return { action_id: previous.id, analysis: context.state, reused: true }
    }
    const current = view(projectId, context)
    if (input.analysis_id !== context.state.id || input.cas_token !== current.cas_token) sourceRecoveryConflict('上次展示的请求或分析状态已变化，请重新核对。')
    if (context.state.controlled_recovery) sourceRecoveryConflict('本次有界恢复的专属授权不能转移给普通请求恢复；已有回答和未知请求继续保留，未创建新尝试。')
    if (!current.budget.can_resume) {
      // Preserve the structured budget error and perform no partial writes.
      explicitModelWorkflowBudgetResume(context.state.budget_steps?.[modelWorkflowBudgetKey], 'source_analysis')
    }
    if (current.blocked_reason || current.blockers.length !== 1) sourceRecoveryConflict(current.blocked_reason || '当前不能恢复此请求。')
    const budget = explicitModelWorkflowBudgetResume(context.state.budget_steps?.[modelWorkflowBudgetKey], 'source_analysis')
    const savedBudget = context.state.budget_steps?.[modelWorkflowBudgetKey] as { grants?: number } | undefined
    if ((options.preserveBudget || input.workflow_id) && budget.grants !== savedBudget?.grants) {
      sourceRecoveryConflict('当前累计用量已到上限，本恢复入口不会自动增加额度；已有分析继续保留。')
    }
    if (input.workflow_id) {
      const workflow = db.prepare('SELECT * FROM source_request_recovery_workflows WHERE id=? AND project_id=?')
        .get(input.workflow_id, projectId) as { phase: string; analysis_binding: string; analysis_id: string; local_snapshot: string;
          scope: string; scope_token: string; result: string } | undefined
      let resume: SourceRequestRecoveryProgress['legacy_resume']
      try { resume = workflow ? (JSON.parse(workflow.result) as SourceRequestRecoveryProgress).legacy_resume : undefined } catch { /* Fail closed. */ }
      if (!workflow || workflow.phase !== 'awaiting_risk' || workflow.analysis_id !== context.state.id ||
        workflow.analysis_binding !== sourceRequestRecoveryBinding(context) || !resume || resume.workflow_id !== input.workflow_id ||
        resume.analysis_id !== input.analysis_id || resume.cas_token !== input.cas_token || resume.client_action_id !== input.client_action_id ||
        workflow.local_snapshot !== (db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(projectId) as { snapshot: string } | undefined)?.snapshot ||
        workflow.scope_token !== sourceRecoveryDigest({ policy: 'source-controlled-risk-choice-v1', action_id: input.workflow_id,
          analysis_binding: workflow.analysis_binding, scope: JSON.parse(workflow.scope), cas_token: current.cas_token })) {
        sourceRecoveryConflict('本次请求恢复对应的旧请求、分析或风险选择已变化，未创建新请求。')
      }
    }
    const blocker = sourceRequestBlockers(projectId, [context.state.id, ...(context.state.story_response_run_ids || [])])[0]!
    const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, blocker.scope, blocker.request_key)
    const originalEpoch = blocker.epoch_id ? db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=? AND project_id=?').get(blocker.epoch_id, projectId) : undefined
    const actionId = newId(), targetId = newId(), stamp = now()
    const next: Analysis = structuredClone(context.state)
    next.budget_steps ??= {}
    if (!options.preserveBudget && !input.workflow_id) next.budget_steps[modelWorkflowBudgetKey] = budget
    next.id = targetId; next.status = 'queued'; next.error = null; next.updated_at = stamp
    delete next.ordinary_story_dispatch
    delete next.started_at; delete next.queue_position; delete next.resume
    next.story_response_run_ids = [...new Set([...(next.story_response_run_ids || []), context.state.id])]
    db.prepare(`INSERT INTO source_request_recovery_actions
      (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(actionId, projectId, input.client_action_id, digest, blocker.id,
        JSON.stringify({ original, blocker, original_epoch: originalEpoch, repair_contract_upgrade: sourceQualityRepairUpgradeBinding(context.document, context.state) }), sourceRequestRecoveryBinding(context), targetId, input.decision, stamp)
    db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
      VALUES (?,?,?,?,?,?,'prepared','not_sent',NULL,NULL,?)`).run(newId(), actionId, projectId, blocker.scope, blocker.request_key, targetId, stamp)
    db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(targetId, projectId)
    const changed = db.prepare('UPDATE script_source_analyses SET id=?,status=?,snapshot=?,updated_at=? WHERE project_id=? AND id=?')
      .run(targetId, next.status, JSON.stringify(next), stamp, projectId, context.state.id)
    if (changed.changes !== 1) sourceRecoveryConflict('分析已变化，恢复操作未保存。')
    if (input.workflow_id) {
      const recovery: SourceRequestRecoveryProgress = { outcome: 'running', phase: 'queued', model_requests_started: false,
        message: '已按原请求身份继续未完成分析，累计用量上限保持不变；进度会自动更新。' }
      const linked = db.prepare(`UPDATE source_request_recovery_workflows SET phase='queued',target_run_id=?,authorization_snapshot=?,result=?,updated_at=?
        WHERE id=? AND project_id=? AND phase='awaiting_risk'`)
        .run(targetId, JSON.stringify({ decision: input, action_id: actionId, budget_policy: 'preserve_existing', confirmed_at: stamp }),
          JSON.stringify(recovery), stamp, input.workflow_id, projectId)
      if (linked.changes !== 1) sourceRecoveryConflict('此请求恢复已经处理，未重复创建新请求。')
    }
    return { action_id: actionId, analysis: next, reused: false }
  }).immediate()
}
