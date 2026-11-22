import { generationScopeVersion, assertGenerationScope } from '../generation/generation-scope-lifecycle.js'
import { reportModelResult } from '../generation/model-result-observation.js'
import type { CanvasPreparationRecovery, ScriptCanvasPlan } from '@video-studio/shared/api/contracts'
import { isDeepStrictEqual } from 'node:util'
import { all, db, one } from '../../infrastructure/database/db.js'
import { createScriptRequestUsage, scriptRequestUsageTokens, withTextRequestUsage, type ScriptRequestUsage } from '../../infrastructure/providers/text-request-usage.js'
import { generationUnitStore } from '../generation/generation-unit-store.js'
import { modelWorkflowBudgetKey } from '../generation/model-workflow-budget.js'
import { creativeInputHash, creativeModelIdentity } from '../skills/creative-model-state.js'
import { bindTaskReasoningById } from '../../infrastructure/providers/task-reasoning.js'
import type { TextGenerationOptions } from '@video-studio/shared/models/task-reasoning'
import { canvasExecution, canvasExternalExecutor, type CanvasExecution } from './canvas-preparation-execution.js'
import { coverageRecoveryState, coverageRecoveryToken, coverageRecoveryPolicy } from '../visuals/visual-coverage-recovery.js'
import { coverageUnitKey } from '../visuals/visual-coverage-workflow.js'
import { latestVisualRetry } from '../visuals/visual-profile-retry.js'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'

/** Independent ceilings: changing run ids never replenishes the task ledger. */
export const canvasPreparationLimits = { max_runs: 3, max_source_updates: 3, run_requests: 256, task_requests: 512, run_tokens: 24_000_000, task_tokens: 48_000_000 } as const
type State = CanvasPreparationRecovery['state']
type Run = { id: string; signature: string; model_id?: string; model_signature?: string; text_generation_options?: TextGenerationOptions; full_scope: boolean; state: State; owner?: string; execution?: CanvasExecution; plan?: ScriptCanvasPlan; usage: ScriptRequestUsage; abandoned_at?: string; discarded_at?: string; source_update_from_run_id?: string; terminal_transport?: boolean }
type Receipt = { fingerprint: string; run_id: string; plan?: ScriptCanvasPlan; error?: { code: string; message: string; statusCode: number; resumable?: boolean } }
type Manifest = { version: 1; active: string; runs: Run[]; usage: ScriptRequestUsage; receipts: Record<string, Receipt> }
export type CanvasPreparationAction = { model_id?: string; run_id?: string; request_id?: string; restart_from_run_id?: string; prepare_current_from_run_id?: string; abandon_unknown?: true;
  text_generation_options?: TextGenerationOptions;
  unit_keys?: string[]; retry_unit?: { unit_key: string; token: string }; retry_units?: Array<{ unit_key: string; token: string }>; skip_unit_keys?: string[] }
type FailedUnit = NonNullable<ScriptCanvasPlan['failed_units']>[number]
type CoverageCheckpoint = { steps: Record<string, { input_hash: string; value: any }> }
type Scope = { projectId: string; sceneIds: string[]; designId?: string | null; signature: string; namespaces: string[]; shotIds?: string[]; prepared?: boolean; scopeProfiles?: (profiles: ScriptCanvasPlan['profiles']) => ScriptCanvasPlan['profiles']; coverageContext?: (unit: FailedUnit, profiles: ScriptCanvasPlan['profiles'], checkpoint: CoverageCheckpoint, stepId: string) => { stepId: string; context_hash: string; locallyValid?: (raw: string) => boolean; replay?: FailedUnit['recovery'] } | undefined }
const active = new Map<string, { id: string; runId: string; fingerprint: string; promise: Promise<ScriptCanvasPlan>; controller: AbortController }>()
const failure = (code: string, message: string, statusCode = 409) => Object.assign(new Error(message), { code, statusCode, retryable: false })
const strip = (plan: ScriptCanvasPlan): ScriptCanvasPlan => { const { preparation: _recovery, ...value } = plan; return structuredClone(value) }

export function canvasPreparationRuns(scope: Scope) {
  const namespace = 'canvas-preparation-runs:' + creativeInputHash([scope.designId || null, [...scope.sceneIds].sort()])
  const scopeVersion=generationScopeVersion(scope.projectId,namespace)
  const assertCurrent=()=>assertGenerationScope(scope.projectId,namespace,scopeVersion)
  const key = scope.projectId + ':' + namespace
  // One registry owns the scene/design family across source revisions. Old
  // version-one rows remain intact; the first actual execution copies forward.
  const store = () => { assertCurrent(); return generationUnitStore(scope.projectId, namespace, { version: 2, scope: 'canvas-preparation' }) }
  const rows = () => !one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_unit_checkpoints'") ? []
    : !scope.namespaces.length ? [] : all<{ namespace: string; payload: string }>(
      'SELECT namespace,payload FROM model_unit_checkpoints WHERE project_id=? AND (' + scope.namespaces.map(() => '(namespace=? OR substr(namespace,1,?)=?)').join(' OR ') + ')',
      scope.projectId, ...scope.namespaces.flatMap(base => [base, (base + ':run:').length, base + ':run:']))
  const checkpoints = (runId?: string) => rows().filter(row => runId === undefined || scope.namespaces.some(base => row.namespace === (runId === 'legacy' ? base : base + ':run:' + runId))).map(row => {
    try { return JSON.parse(row.payload) as CoverageCheckpoint }
    catch { throw failure('canvas_preparation_history_invalid', '保留的参考准备记录无法读取，请核对记录；未开始新请求。') }
  })
  const terminalTransport = (run?: Run) => {
    const task = run?.execution?.task_id
    if (!task) return false
    const attempt = one<{ metrics: string }>('SELECT metrics FROM model_request_attempts WHERE task_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1', task)
    if (!attempt) return false
    try {
      const metrics = JSON.parse(attempt.metrics)
      if (metrics.task_id !== task || metrics.response_terminated !== true || metrics.request_has_tools !== false
        || !['disconnected', 'upstream_error'].includes(metrics.failure_reason)) return false
      return checkpoints(run!.id).some(checkpoint => Object.entries(checkpoint.steps).some(([id, entry]) => id.startsWith('response:') && !!entry.value?.correction_started && !entry.value?.correction))
    } catch { return false }
  }
  const pendingCount = (runId: string, run?: Run) => checkpoints(runId).flatMap(state => Object.entries(state.steps || {}).filter(([id, entry]) => {
    if (!id.startsWith('response:')) return false
    const value = entry.value
    return !value || value.initial_started && (typeof value.raw !== 'string' || value.initial_started.input_hash !== value.input_hash)
      || value.correction_started && (!value.correction || value.correction_started.input_hash !== value.correction.input_hash)
  })).filter(([, entry]) => !(terminalTransport(run) && entry.value?.correction_started && !entry.value?.correction)).length
  const pending = (runId: string, run?: Run) => pendingCount(runId, run) > 0
  const preparedPlan = (): ScriptCanvasPlan => ({ signature: scope.signature, scene_ids: scope.sceneIds, profiles: [], status: 'complete',
    reference_usage_version: 1, coverage_version: 1, visual_coverage: [], used_skills: [], loaded_files: [] })
  const read = (): Manifest | undefined => {
    assertCurrent()
    if (!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_unit_checkpoints'")) return
    const saved = all<{ payload: string }>('SELECT payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=? ORDER BY updated_at DESC,rowid DESC', scope.projectId, namespace)
      .map(row => JSON.parse(row.payload)?.steps?.manifest?.value).find(Boolean) as Manifest | undefined
    if (!saved) return
    if (saved.version !== 1 || !Array.isArray(saved.runs) || !saved.runs.some(run => run.id === saved.active) || !saved.receipts) throw failure('canvas_preparation_history_invalid', '参考准备运行记录无效，未自动重置历史额度。')
    withTextRequestUsage({ usage: saved.usage }, () => {})
    for (const run of saved.runs) withTextRequestUsage({ usage: run.usage }, () => {})
    return saved
  }
  const save = (manifest: Manifest) => {
    const state = store().read()
    state.steps.manifest = { input_hash: creativeInputHash({ version: 1 }), value: structuredClone(manifest) }
    store().save(state)
  }
  const live = (run: Run) => active.get(key)?.id === run.owner && active.get(key)?.runId === run.id
  const external = (run: Run) => run.state === 'running' && !live(run) && canvasExternalExecutor(run.execution)
  const reconcile = (manifest: Manifest) => {
    const run = manifest.runs.find(run => run.id === manifest.active)!
    // A later coverage exception must not hide profiles saved after the last
    // partial receipt. Reconstruct only exact catalog-owned validated units;
    // this read-only projection does not adopt or rewrite business data.
    if (!live(run) && !external(run) && run.signature === scope.signature && !pending(run.id, run)) {
      for (const checkpoint of checkpoints(run.id)) {
        const catalog = checkpoint.steps['object-catalog']?.value?.profiles
        if (!Array.isArray(catalog)) continue
        const completed = catalog.flatMap((item: any) => {
          const values = Object.entries(checkpoint.steps).filter(([key, entry]) => key.startsWith('unit:') && entry.value?.draft_key === item.draft_key && key.endsWith(':' + item.draft_key))
          return values.length === 1 ? [values[0]![1].value] : []
        })
        const oldCoverage = Object.entries(checkpoint.steps).find(([key]) => key.startsWith('response:visual-coverage:'))?.[1].value
        if (!completed.length || !oldCoverage || !run.plan || completed.length <= run.plan.profiles.length) continue
        const completedKeys = new Set(completed.map((profile: any) => profile.draft_key))
        run.plan.profiles = scope.scopeProfiles ? scope.scopeProfiles(structuredClone(completed)) : structuredClone(completed)
        run.plan.failed_units = (run.plan.failed_units || []).filter(unit => !completedKeys.has(unit.unit_key))
        if (!run.plan.visual_coverage?.length && completed.length === catalog.length && !run.plan.failed_units.some(unit => unit.stage === 'coverage')) {
          run.plan.failed_units.push({ unit_key: '@visual-coverage', stage: 'coverage', name: '逐镜覆盖检查', code: 'visual_coverage_conflict',
            message: '全部档案已完成，覆盖检查尚未通过。继续时复用原答，仅仲裁逐镜用途冲突，不重新生成档案。', retryable: false,
            recovery_type: 'blocked', checkpoint_source: oldCoverage.correction ? 'correction' : 'original_raw', is_new_model_call: false, attempt: 1,
            recovery: { action: 'continue', model_call: 'possible' }, scene_ids: scope.sceneIds })
        }
        run.plan.status = 'partial'; run.state = 'partial'
      }
    }
    if (run.plan?.failed_units) for (const unit of run.plan.failed_units) {
      for (const checkpoint of checkpoints(run.id)) {
        const failureKey = Object.keys(checkpoint.steps || {}).find(key => key.startsWith('visual-unit-failure:') && key.endsWith(':' + unit.unit_key))
        if (!failureKey) continue
        const stepId = 'unit:' + failureKey.slice('visual-unit-failure:'.length)
        if (unit.stage === 'coverage') {
          const next = coverageRecoveryState(checkpoint, stepId)
          const context = run.signature === scope.signature ? scope.coverageContext?.(unit, run.plan.profiles, checkpoint, stepId) : undefined
          unit.model_request_count = next.model_request_count; unit.local_validation_count = next.local_validation_count
          unit.recovery_version = coverageRecoveryPolicy; unit.attempt = next.model_request_count; unit.is_new_model_call = false
          unit.recovery = { ...next.recovery }
          if (unit.unit_key === coverageUnitKey) {
            if (!next.blocked) unit.recovery = context?.replay || { action: 'inspect', model_call: 'none', reason: '保留的覆盖回答无法匹配当前范围。请核对分镜和档案版本。' }
          } else if (terminalTransport(run) && context?.stepId === stepId) {
            const attempt = Object.entries(checkpoint.steps).map(([, entry]) => entry.value).find((value: any) => value?.policy === coverageRecoveryPolicy && value?.id?.startsWith('coverage-v2:' + stepId + ':')) as any
            if (attempt?.parent_hash && attempt.context_hash) unit.recovery = { action: 'retry', model_call: 'required', token: coverageRecoveryToken(stepId, attempt.parent_hash, attempt.context_hash), reason: '模型连接已明确结束，已有结果保留；可继续本镜用途检查。' }
          } else if (!next.blocked && context?.stepId === stepId && next.source && context.locallyValid?.(next.source.response.raw)) {
            unit.recovery = { action: 'continue', model_call: 'none', reason: '已有完整用途回答可通过本地结构规范化及完整校验，不需新模型调用。' }
          } else if (unit.code === 'visual_coverage_local_target_unavailable') {
            unit.recovery = { action: 'inspect', model_call: 'none', reason: unit.message }
          } else if (next.recovery.action === 'retry') {
            if (!context || context.stepId !== stepId || next.context_hash && next.context_hash !== context.context_hash) {
              unit.recovery = { action: 'inspect', model_call: 'none', reason: '当前镜头与保留仲裁输入无法精确绑定，未开启新请求。' }
            } else unit.recovery.token = coverageRecoveryToken(stepId, next.parent_hash, context.context_hash)
          }
          continue
        }
        const next = latestVisualRetry(checkpoint, stepId)
        if (next) { unit.recovery = next.recovery; unit.attempt = next.attempt }
        else if (Object.keys(checkpoint.steps).some(key => key.startsWith('retry-failed:' + stepId + ':'))) {
          unit.recovery = { action: 'inspect', model_call: 'unknown', reason: '尝试历史未能完整核对，保留现场，不能发送新请求。' }
        }
      }
    }
    if ((run.state !== 'running' && run.state !== 'unknown') || live(run) || external(run)) return manifest
    if (pending(run.id, run) || run.usage.pending_requests.length) { run.state = 'unknown'; return manifest }
    const receipt = run.owner && manifest.receipts[run.owner]
    const plan = receipt && receipt.run_id === run.id && receipt.plan || run.plan
    if (plan?.signature === run.signature) { run.plan = strip(plan); run.state = plan.status === 'partial' || plan.failed_units?.length ? 'partial' : 'complete' }
    else run.state = 'cancelled'
    return manifest
  }
  const make = (): Manifest => {
    const usage = createScriptRequestUsage()
    // Adoption is additive. Legacy paid work remains charged to this family.
    for (const checkpoint of checkpoints()) {
      const old = checkpoint.steps[modelWorkflowBudgetKey]?.value?.[modelWorkflowBudgetKey]?.usage as ScriptRequestUsage | undefined
      if (!old) continue
      withTextRequestUsage({ usage: old }, () => {})
      for (const field of Object.keys(usage) as Array<keyof ScriptRequestUsage>) {
        if (field === 'pending_requests') continue
        ;(usage[field] as number) += old[field] as number
      }
      usage.pending_requests.push(...structuredClone(old.pending_requests).filter(item => !usage.pending_requests.some(previous => previous.id === item.id)))
    }
    return { version: 1, active: 'legacy', runs: [{ id: 'legacy', signature: scope.signature, full_scope: false, state: 'idle', usage: structuredClone(usage) }], usage, receipts: {} }
  }
  const interrupted = (manifest: Manifest, run: Run) => {
    if (run.state !== 'failed' || run.plan || pending(run.id) || run.usage.pending_requests.length) return false
    const receipt = run.owner && manifest.receipts[run.owner]
    if (!receipt || receipt.run_id !== run.id || !receipt.error) return false
    if (receipt.error.resumable !== undefined) return receipt.error.resumable
    // Read-only compatibility for receipts written before delivery facts were
    // retained. Require the exact owning task, terminal provider metrics and
    // its failed transport operation; an HTTP 502 or empty slot alone proves nothing.
    const task = run.execution?.task_id
    if (!task || !one("SELECT 1 FROM sqlite_master WHERE name='ai_operations'")) return false
    const operations = all<{ result: string }>("SELECT result FROM ai_operations WHERE project_id=? AND model_task_id=? AND state='failed' AND route=? AND status_code=?", scope.projectId, task,
      '/api/projects/' + scope.projectId + '/script/canvas/prepare', receipt.error.statusCode)
    if (operations.length !== 1) return false
    try {
      const issue = JSON.parse(operations[0]!.result)
      if (issue.category !== 'transport' || issue.retryable !== true) return false
      const attempt = one<{ state: string; metrics: string }>('SELECT state,metrics FROM model_request_attempts WHERE task_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1', task)
      if (attempt?.state !== 'settled') return false
      const metrics = JSON.parse(attempt.metrics)
      if (metrics.task_id !== task || metrics.response_terminated !== true || metrics.request_has_tools !== false
        || !['disconnected', 'upstream_error'].includes(metrics.failure_reason) || metrics.raw_reason !== issue.upstream_code
        || !['stream_read_error', 'stream_disconnected', 'connection_error', 'server_error', 'rate_limit_exceeded', 'service_unavailable', 'overloaded_error'].includes(issue.upstream_code)
        || typeof metrics.step_id !== 'string') return false
      const slots = checkpoints(run.id).flatMap(checkpoint => Object.entries(checkpoint.steps).filter(([id]) => id.startsWith('response:' + metrics.step_id + ':')))
      return slots.length === 1 && /^[a-f0-9]{64}$/.test(slots[0]![1].value?.input_hash || '')
        && slots[0]![0].endsWith(':' + slots[0]![1].input_hash)
        && slots[0]![1].value.raw === undefined && !slots[0]![1].value.initial_started && !slots[0]![1].value.correction_started
    } catch { return false }
  }
  const recovery = (manifest: Manifest, modelId?: string): CanvasPreparationRecovery => {
    const run = manifest.runs.find(run => run.id === manifest.active)!
    const running = run.state === 'running' && (live(run) || external(run))
    const terminal = terminalTransport(run)
    const unresolved = pendingCount(run.id, run)
    const unknown = !running && run.state !== 'complete' && (unresolved > 0 || run.state === 'unknown' || run.usage.pending_requests.length > 0)
    // Business fingerprints prove adoption, even though saving profiles and
    // bindings changes the pre-adoption signature. Never turn this cache hit
    // into a fresh full-scope generation or bypass a live/unknown owner.
    const prepared = !!scope.prepared && !running && !unknown && (!run.full_scope || run.signature !== scope.signature)
    const taskLimited = manifest.usage.requests >= canvasPreparationLimits.task_requests || manifest.usage.requests + manifest.usage.transport_requests >= canvasPreparationLimits.task_requests * 4
      || scriptRequestUsageTokens(manifest.usage) >= canvasPreparationLimits.task_tokens
    const runLimited = run.usage.requests >= canvasPreparationLimits.run_requests || run.usage.requests + run.usage.transport_requests >= canvasPreparationLimits.run_requests * 4
      || scriptRequestUsageTokens(run.usage) >= canvasPreparationLimits.run_tokens
    const sourceMatches = run.signature === scope.signature
    const missingShotIds = scope.shotIds ? [...new Set((run.plan?.profiles || []).flatMap(profile => (profile.shot_usage || []).map(usage => usage.shot_id)))]
      .filter(id => !scope.shotIds!.includes(id)) : []
    const sourceReason = missingShotIds.length
      ? `已完成的参考对应旧版镜头，其中 ${missingShotIds.length} 个镜头已不在当前范围。旧成果已保留，请核对分镜版本；未重新调用模型。`
      : '分镜或参考来源已变化，旧成果已保留，暂不能用于当前版本。请核对来源；未重新调用模型。'
    const same = prepared || sourceMatches && (!modelId || !run.model_id || modelId === run.model_id)
    const common = unknown ? '上次请求结果尚未确认。请核对状态；确认放弃等待后可重新整理，原请求不会因此取消，可能重复产生用量。'
      : running ? '当前参考准备正在进行，可核对进度或停止本地处理；停止不代表上游已取消。'
        : taskLimited && !prepared ? '本次所选场次的参考准备累计预算已用尽；新运行不会重置该预算。' : ''
    const sourceUpdates = manifest.runs.filter(item => item.source_update_from_run_id).length
    const canPrepareCurrent = !prepared && !sourceMatches && !common && !taskLimited
      && sourceUpdates < canvasPreparationLimits.max_source_updates
      && !manifest.runs.some(item => item.source_update_from_run_id && item.signature === scope.signature)
    const prepareReason = common || (taskLimited ? '本次任务累计预算已用尽，不能继续整理。'
      : sourceMatches || prepared ? '当前来源未变化，请复用现有结果或使用重新整理全部参考。'
        : sourceUpdates >= canvasPreparationLimits.max_source_updates ? '本次任务已达到三次范围更新上限，请先核对已有结果。'
          : !canPrepareCurrent ? '当前范围已有一次独立整理记录，请先核对该记录，不能重复创建。' : '')
    const reason = common || (!same ? !sourceMatches ? sourceReason : '所选模型与本次运行不同，请使用原模型继续，或明确重新整理全部参考。' : runLimited && !prepared ? '本运行预算已用尽，可在任务总限额内全部重新开始。' : '')
    const failures = prepared ? [] : run.plan?.failed_units || []
    const retryable = failures.filter(unit => unit.recovery?.action === 'retry' && unit.recovery.token).map(unit => unit.unit_key)
    const coverageFailures = failures.filter(unit => unit.stage === 'coverage')
    const coverageBlocked = coverageFailures.length > 0 && coverageFailures.length === failures.length && !retryable.length
      && coverageFailures.every(unit => !['retry', 'continue'].includes(unit.recovery?.action || ''))
    const coverageReason = coverageBlocked ? [...new Set(coverageFailures.map(unit => unit.recovery?.reason || '本镜用途证据需人工核对，请查看该项详情；已完成档案保留。'))].join('；') : ''
    const pendingKeys = [...new Set([...failures.filter(unit => unit.recovery?.action === 'continue').map(unit => unit.unit_key), ...(terminal ? failures.filter(unit => unit.stage === 'coverage').map(unit => unit.unit_key) : [])])]
    const resumable = interrupted(manifest, run)
    const task = run.execution?.task_id && one<{ progress: string; updated_at: string }>('SELECT progress,updated_at FROM model_request_tasks WHERE id=? AND project_id=?', run.execution.task_id, scope.projectId)
    const steps = task ? JSON.parse(task.progress || '[]') : []
    const progress = steps.at(-1)
    return { run_id: run.id, state: unknown ? 'unknown' : running ? 'running' : prepared ? 'complete' : run.state, model_id: run.model_id, full_scope: run.full_scope && !prepared,
      ...(run.text_generation_options?.reasoning ? { text_generation_options: run.text_generation_options } : {}),
      can_retry_failed: !reason && retryable.length > 0, retryable_unit_keys: retryable,
      retry_reason: reason || (retryable.length ? '仅为失败对象创建一次新尝试，已成功对象和技能选择复用。' : '本轮没有可直接重试的失败项；可查看详情或全部重新开始。'),
      can_continue: !reason && (resumable || prepared || pendingKeys.length > 0 || run.state === 'cancelled' || run.state === 'complete'), pending_unit_keys: pendingKeys,
      continue_reason: reason || coverageReason || coverageFailures.find(unit => unit.recovery?.action === 'continue' && unit.unit_key === coverageUnitKey)?.recovery?.reason || (resumable || terminal ? '模型连接中断，已有结果已保留，可重试继续。' : pendingKeys.length || run.state === 'cancelled' ? '继续未完成对象并复用现有记录。' : run.state === 'complete' ? '现有结果已完整验证，可直接采用，不重新调用模型。' : '本运行没有可直接继续的对象；请查看原回答或明确全部重新开始视觉参考准备。'),
      can_restart_all: !common && !taskLimited && manifest.runs.length < canvasPreparationLimits.max_runs,
      restart_reason: common || (taskLimited ? '本次所选场次的参考准备累计预算已用尽；新运行不会重置该预算。' : manifest.runs.length >= canvasPreparationLimits.max_runs ? '全量重做版本已达上限；分镜已更新时可按当前范围单独整理，旧成果继续保留。'
        : '仅重新整理本次所选场次的人物、场景与道具参考。会产生新的模型用量，旧成果保留，新结果需确认采用。'),
      requires_confirmation: run.full_scope && !prepared,
      adoption: { can_adopt: !prepared && run.full_scope && !run.discarded_at && sourceMatches && run.state === 'complete' && !!run.plan
          && run.plan.status !== 'partial' && !run.plan.failed_units?.length,
        source_matches: prepared || sourceMatches, reason: prepared || sourceMatches ? '' : sourceReason,
        completed_profiles: run.plan?.profiles.length || 0, missing_shot_ids: missingShotIds,
        can_prepare_current: canPrepareCurrent, prepare_reason: prepareReason,
        can_discard: !prepared && !sourceMatches && !running && !unknown && !!run.plan && !run.discarded_at,
        discarded: !!run.discarded_at, source_updates: sourceUpdates, max_source_updates: canvasPreparationLimits.max_source_updates },
      inspection: { executor: live(run) ? 'active' : external(run) ? 'external' : run.owner ? 'retired' : 'none', owner_request_id: run.owner,
        task_id: run.execution?.task_id, started_at: run.execution?.started_at, heartbeat_at: run.execution?.heartbeat_at,
        cancel_requested: !!run.execution?.cancel_requested, can_cancel: running && !run.execution?.cancel_requested,
        can_abandon: unknown && !live(run) && !external(run) && !taskLimited && manifest.runs.length < canvasPreparationLimits.max_runs,
        unresolved_responses: unresolved, pending_requests: run.usage.pending_requests.length,
        ...(progress ? { progress: { label: progress.label, completed_units: progress.completed_units, total_units: progress.total_units }, steps } : {}),
        message: common || (!prepared && !sourceMatches ? sourceReason : '') || (run.state === 'complete' ? '已完成，可复用现有结果加入画布。' : run.state === 'partial' ? '本轮已结束，保留了完成部分，可继续未完成项。' : '没有活跃执行者，可继续未完成项。') },
      budget: { task_requests: manifest.usage.requests, task_max_requests: canvasPreparationLimits.task_requests, run_requests: run.usage.requests,
        run_max_requests: canvasPreparationLimits.run_requests, runs: manifest.runs.length, max_runs: canvasPreparationLimits.max_runs } }
  }
  const snapshot = (modelId?: string) => {
    const saved = read()
    if (!saved && !pending('legacy')) return undefined
    const manifest = reconcile(saved || make())
    const run = manifest.runs.find(run => run.id === manifest.active)!
    const caps = recovery(manifest, modelId)
    return { preparation: caps,
      retained_results: manifest.runs.filter(item => item.plan && (item.id !== run.id || !caps.adoption?.source_matches))
        .map(item => ({ run_id: item.id, discarded: !!item.discarded_at, plan: strip(item.plan!) })),
      ...(!caps.adoption?.source_matches && run.plan ? { retained_plan: strip(run.plan) } : {}), ...(scope.prepared && caps.state === 'complete' && !caps.full_scope ? { plan: { ...preparedPlan(), preparation: caps } }
      : run.signature === scope.signature && run.plan ? { plan: { ...strip(run.plan), preparation: caps } } : {}) }
  }
  const decorate = (plan: ScriptCanvasPlan, manifest: Manifest, modelId?: string) => ({ ...strip(plan), preparation: recovery(manifest, modelId) })
  return {
    snapshot,
    discard(runId: string) {
      const saved = read(), manifest = saved && reconcile(saved), run = manifest?.runs.find(item => item.id === runId)
      if (manifest?.active === runId && run?.discarded_at) return snapshot()
      if (!manifest || manifest.active !== runId || !run || !recovery(manifest).adoption?.can_discard) {
        throw failure('canvas_preparation_discard_blocked', '只能放弃当前范围已过期且没有未确认请求的旧结果，请刷新状态。')
      }
      // Keep raw responses, plans, receipts and usage; this only records intent not to adopt.
      run.discarded_at = new Date().toISOString(); save(manifest)
      return snapshot()
    },
    cancel(runId: string, ownerRequestId: string) {
      const manifest = read(), run = manifest?.runs.find(run => run.id === runId), execution = active.get(key)
      if (!manifest || manifest.active !== runId || !run || run.owner !== ownerRequestId) throw failure('canvas_preparation_run_changed', '当前运行已变化，请重新核对状态；未停止其他运行。')
      if (live(run) || external(run)) {
        if (run.execution) run.execution.cancel_requested = true
        save(manifest)
        if (live(run) && execution) execution.controller.abort(new DOMException('已请求停止本地参考整理，上游结果需继续核对', 'AbortError'))
      }
      return snapshot()
    },
    assertAdoptable(runId: string, plan: Pick<ScriptCanvasPlan, 'signature' | 'profiles' | 'visual_coverage'>) {
      const saved = read(), manifest = saved && reconcile(saved), run = manifest?.runs.find(run => run.id === runId)
      if (!manifest || manifest.active !== runId || run?.state !== 'complete' || run.discarded_at || run.signature !== scope.signature || !run.plan
        || !isDeepStrictEqual([plan.signature, plan.profiles, plan.visual_coverage], [run.plan.signature, run.plan.profiles, run.plan.visual_coverage])) {
        throw failure('canvas_preparation_adoption_blocked', '只能采用当前运行已完整验证的参考准备结果；已有档案和画布未变更。')
      }
      return run.full_scope
    },
    async execute(input: CanvasPreparationAction, signal: AbortSignal, work: (run: { id: string; full_scope: boolean; signal: AbortSignal; terminal_transport?: boolean; text_generation_options?: TextGenerationOptions }) => Promise<ScriptCanvasPlan>): Promise<ScriptCanvasPlan> {
      const fingerprint = creativeInputHash(input), id = input.request_id || 'legacy-' + fingerprint
      const existing = active.get(key)
      if (existing) {
        if (existing.id === id && existing.fingerprint === fingerprint) return structuredClone(await existing.promise)
        throw failure('canvas_preparation_running', '当前参考准备正在执行，不能并发启动其他重试或新运行。')
      }
      const prior = read(), expected = prior && creativeInputHash(prior)
      const manifest = reconcile(prior ? structuredClone(prior) : make())
      const receipt = input.request_id ? manifest.receipts[id] : undefined
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw failure('canvas_preparation_intent_conflict', '同一请求标识不能用于不同的参考准备动作。')
        if (receipt.error) throw failure(receipt.error.code, receipt.error.message, receipt.error.statusCode)
        if (receipt.plan) return decorate(receipt.plan, manifest, input.model_id)
      }
      let run = manifest.runs.find(run => run.id === manifest.active)!
      const caps = recovery(manifest, input.model_id)
      const terminal = terminalTransport(run)
      const abandon = input.abandon_unknown === true && input.restart_from_run_id === run.id && caps.inspection?.can_abandon === true
      if (caps.state === 'running' || caps.state === 'unknown' && !abandon) throw failure('canvas_preparation_unknown', caps.restart_reason)
      if (input.abandon_unknown && !abandon) throw failure('canvas_preparation_abandon_blocked', '必须先核对当前未知运行且确认没有活跃执行者；未开始新请求。')
      if (scope.prepared && caps.state === 'complete' && !caps.full_scope && !input.restart_from_run_id && !input.prepare_current_from_run_id && !input.unit_keys && !input.retry_unit && !input.retry_units && !input.skip_unit_keys) {
        reportModelResult({ stage: 'visual_organization', phase: 'structure', status: 'valid', task_id: 'canvas_reference_reuse',
          cache_hit: true, local_reuse: true, is_new_model_call: false, model_request_count: 0, repair_strategy: 'canvas_prepared_source_match_v1' })
        return decorate(preparedPlan(), manifest, input.model_id)
      }
      if (input.prepare_current_from_run_id !== undefined) {
        if (!input.request_id || input.prepare_current_from_run_id !== run.id || !caps.adoption?.can_prepare_current
          || input.restart_from_run_id || input.abandon_unknown || input.unit_keys || input.retry_unit || input.retry_units || input.skip_unit_keys) {
          throw failure('canvas_preparation_current_scope_blocked', caps.adoption?.prepare_reason || '当前范围不能创建新的参考整理，请刷新状态。')
        }
        const previous = run.id
        run = { id: input.request_id, signature: scope.signature, model_id: input.model_id, full_scope: true,
          state: 'idle', usage: createScriptRequestUsage(), source_update_from_run_id: previous }
        manifest.runs.push(run); manifest.active = run.id
      } else if (input.restart_from_run_id !== undefined) {
        if (!input.request_id || input.restart_from_run_id !== run.id || !caps.can_restart_all && !abandon || input.unit_keys || input.retry_unit || input.retry_units || input.skip_unit_keys) {
          throw failure('canvas_preparation_restart_blocked', caps.restart_reason || '请核对当前运行后重新开始。')
        }
        if (abandon) run.abandoned_at = new Date().toISOString()
        run = { id: input.request_id, signature: scope.signature, model_id: input.model_id, full_scope: true, state: 'idle', usage: createScriptRequestUsage() }
        manifest.runs.push(run); manifest.active = run.id
      } else {
        if (input.run_id && input.run_id !== run.id) throw failure('canvas_preparation_run_changed', '当前运行已经变化，请刷新参考准备状态。')
        if (run.signature !== scope.signature || (input.request_id || input.run_id) && run.model_id && input.model_id && run.model_id !== input.model_id) throw failure('canvas_preparation_source_changed', '资料或模型已变化，请明确全部重新开始参考准备。')
        if (run.state === 'failed' && !run.plan && !caps.can_continue) throw failure('canvas_preparation_continue_blocked', caps.continue_reason)
        const fullCoverage = run.plan?.failed_units?.find(unit => unit.unit_key === coverageUnitKey && unit.recovery?.action === 'inspect')
        if (input.unit_keys?.includes(coverageUnitKey) && fullCoverage) {
          throw failure('canvas_preparation_continue_blocked', fullCoverage.recovery?.reason || caps.continue_reason)
        }
        if (input.request_id && run.plan && !input.unit_keys && !input.retry_unit && !input.retry_units && !input.skip_unit_keys) return decorate(run.plan, manifest, input.model_id)
      }
      if (manifest.usage.requests >= canvasPreparationLimits.task_requests || run.usage.requests >= canvasPreparationLimits.run_requests) throw failure('canvas_preparation_budget_exceeded', '参考准备预算已用尽；不会通过重新开始清空历史用量。', 422)
      const retries = input.retry_units || (input.retry_unit ? [input.retry_unit] : [])
      if ((input.request_id || input.run_id) && retries.length && run.plan) for (const retry of retries) {
        const unit = run.plan.failed_units?.find(unit => unit.unit_key === retry.unit_key)
        if (!unit || unit.recovery?.action !== 'retry' || unit.recovery.token !== retry.token) throw failure('canvas_preparation_retry_unavailable', '指定对象当前不可重试，请刷新状态或全部重新开始。')
      }
      run.model_id = input.model_id || run.model_id
      if (run.model_id) {
        const modelSignature = creativeModelIdentity(run.model_id)
        if (!run.model_signature && run.state === 'idle' && !run.owner) run.text_generation_options = input.text_generation_options
        if (run.model_signature && run.model_signature !== modelSignature) throw failure('canvas_preparation_source_changed', '文本模型配置已变化，请重新开始参考准备。')
        run.model_signature = modelSignature
      }
      const withReasoning = run.model_id ? bindTaskReasoningById(run.model_id, run.text_generation_options) : <Result>(execute: () => Result) => execute()
      // Claim synchronously before the first await; persistent running state is
      // deliberately unknown after a process restart until its request is checked.
      store() // Initialize the lazily created checkpoint table only on execution.
      db.transaction(() => {
        const latest = read()
        if ((latest && creativeInputHash(latest)) !== expected) throw failure('canvas_preparation_owner_changed', '参考准备状态已变化，请刷新恢复状态；未启动新请求。')
        // Compare the single family registry, not obsolete source snapshots.
        if (latest?.runs.some(item => item.state === 'running' && (live(item) || external(item))) || !abandon && pending(run.id, run) && run.state !== 'complete') throw failure('canvas_preparation_unknown', '已有参考准备请求尚未确认，不能启动另一个运行；请先核对原请求。')
        run.state = 'running'; run.owner = id; run.execution = canvasExecution(); run.terminal_transport = terminal && !!input.unit_keys?.some(key => key.startsWith('@appearance:')); save(manifest)
      })()
      const controller = new AbortController(), abort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      const workSignal = controller.signal
      workSignal.addEventListener('abort', () => { if (run.execution) run.execution.cancel_requested = true }, { once: true })
      const persistUsage = () => {
        const current = read()
        if (!current || current.active !== run.id || current.runs.find(item => item.id === run.id)?.owner !== id) throw failure('canvas_preparation_owner_changed', '参考准备执行归属已变化，停止新的模型请求。')
        if (run.execution) run.execution.heartbeat_at = new Date().toISOString()
        if (current.runs.find(item => item.id === run.id)?.execution?.cancel_requested && run.execution) {
          run.execution.cancel_requested = true
          if (!workSignal.aborted) controller.abort(new DOMException('已请求停止本地参考整理，上游结果需继续核对', 'AbortError'))
        }
        save(manifest)
      }
      const heartbeat = setInterval(() => { try { persistUsage() } catch (issue) { controller.abort(issue) } }, 5000); heartbeat.unref()
      const promise = (async () => {
        try {
          const value = await withTextRequestUsage({ usage: manifest.usage, limits: { max_requests: canvasPreparationLimits.task_requests, max_total_requests: canvasPreparationLimits.task_requests * 4, max_tokens: canvasPreparationLimits.task_tokens },
            budgetLabel: '本次所选场次参考准备累计任务', signal: workSignal, onUpdate: persistUsage }, () =>
            withTextRequestUsage({ usage: run.usage, limits: { max_requests: canvasPreparationLimits.run_requests, max_total_requests: canvasPreparationLimits.run_requests * 4, max_tokens: canvasPreparationLimits.run_tokens },
              budgetLabel: '本运行参考准备', signal: workSignal, onUpdate: persistUsage }, () => withReasoning(() => work({ id: run.id, full_scope: run.full_scope, signal: workSignal, terminal_transport: run.terminal_transport, text_generation_options: run.text_generation_options }))))
          workSignal.throwIfAborted()
          run.plan = strip(value); run.state = value.status === 'partial' || value.failed_units?.length ? 'partial' : 'complete'
          manifest.receipts[id] = { fingerprint, run_id: run.id, plan: strip(value) }; save(manifest)
          return decorate(value, manifest, input.model_id)
        } catch (error) {
          run.state = pending(run.id) || run.usage.pending_requests.length ? 'unknown' : workSignal.aborted ? 'cancelled' : 'failed'
          const issue = error as { code?: string; message?: string; statusCode?: number }
          const resumable = error instanceof TextProviderError && error.retryable
            && (error.responseTerminated || ['not_sent', 'rejected', 'completed'].includes(error.delivery))
          manifest.receipts[id] = { fingerprint, run_id: run.id, error: { code: issue.code || 'canvas_preparation_failed', message: issue.message || '参考准备未完成', statusCode: issue.statusCode || 500, resumable } }
          save(manifest); throw error
        } finally { clearInterval(heartbeat); signal.removeEventListener('abort', abort); if (active.get(key)?.id === id) active.delete(key) }
      })()
      active.set(key, { id, runId: run.id, fingerprint, promise, controller })
      return promise
    },
  }
}
