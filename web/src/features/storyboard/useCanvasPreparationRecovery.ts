import { useEffect, useRef, useState } from 'react'
import { api, json, type CanvasPreparationSnapshot, type ScriptCanvasPlan } from '../../shared/api/api'
import { referenceFailureView, uncertainReferenceUnits, type ReferenceRetry } from './reference-failure'

export type ReferenceAction = 'continue' | 'restart' | 'abandon' | 'adopt' | 'prepare-current' | ReferenceRetry
type Scope = { projectId: string; sceneIds: string[]; designId?: string | null; active?: boolean; refreshKey?: string; paused?: boolean; watching?: boolean }

/** Reading this state never dispatches a model request. The server owns all
 * recovery capabilities; browser intent IDs survive a reload before receipt. */
export function useCanvasPreparationRecovery({ projectId, sceneIds, designId, active = true, refreshKey, paused = false, watching = false }: Scope) {
  const scope = JSON.stringify([projectId, [...sceneIds].sort(), designId || null])
  const [snapshot, setSnapshot] = useState<CanvasPreparationSnapshot>()
  const [loading, setLoading] = useState(active), [restoreError, setRestoreError] = useState('')
  const current = useRef<CanvasPreparationSnapshot | undefined>(undefined), revision = useRef(0)
  const discardLock = useRef(false)
  const inFlight = useRef<{ revision: number; promise: Promise<CanvasPreparationSnapshot | undefined> } | null>(null)
  const automaticReads = useRef(0), readFailed = useRef(false)
  const pausedRef = useRef(paused); pausedRef.current = paused
  const watchingRef = useRef(watching); watchingRef.current = watching
  const scopeRef = useRef(scope); scopeRef.current = scope
  const scopeBody = { scene_ids: sceneIds, ...(designId ? { design_id: designId } : {}) }
  function reload(signal?: AbortSignal): Promise<CanvasPreparationSnapshot | undefined> {
    if (inFlight.current?.revision === revision.current) return inFlight.current.promise
    const promise = read(signal)
    const entry = { revision: revision.current, promise }; inFlight.current = entry
    void promise.finally(() => { if (inFlight.current === entry) inFlight.current = null })
    return promise
  }
  async function read(signal?: AbortSignal): Promise<CanvasPreparationSnapshot | undefined> {
    const turn = ++revision.current, expectedScope = scope
    setLoading(true); setRestoreError(''); readFailed.current = false
    try {
      const value = await api<CanvasPreparationSnapshot>(`/projects/${projectId}/script/canvas/recovery`, { ...json('POST', scopeBody), signal })
      if (turn !== revision.current || scopeRef.current !== expectedScope || signal?.aborted) return undefined
      current.current = value; setSnapshot(value); return value
    } catch (issue) {
      if (turn === revision.current && scopeRef.current === expectedScope && !signal?.aborted) { readFailed.current = true; setRestoreError('无法确认上次参考准备状态，请重试后继续：' + (issue instanceof Error ? issue.message : String(issue))) }
      return undefined
    } finally { if (turn === revision.current && !signal?.aborted) setLoading(false) }
  }
  useEffect(() => {
    revision.current++; current.current = undefined; setSnapshot(undefined); setRestoreError(''); setLoading(active)
    if (!active || !sceneIds.length) { setLoading(false); return }
    automaticReads.current = 0; readFailed.current = false
    const controller = new AbortController(); void reload(controller.signal)
    const inspect = () => { if (!pausedRef.current && !readFailed.current && !inFlight.current && (current.current?.preparation?.state === 'running' || automaticReads.current < 12 && (watchingRef.current || current.current?.preparation?.state === 'unknown'))) { automaticReads.current++; void reload(controller.signal) } }
    const timer = window.setInterval(inspect, 5000)
    let lastFocus = 0
    const focus = () => { if (!controller.signal.aborted && !pausedRef.current && !readFailed.current && !inFlight.current && Date.now() - lastFocus > 5000) { lastFocus = Date.now(); void reload(controller.signal) } }
    window.addEventListener('focus', focus)
    return () => { revision.current++; controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [scope, active, refreshKey])
  async function adoptionPlan(signature: string, signal: AbortSignal) {
    const expectedRun = current.current?.preparation?.run_id
    const value = await reload(signal)
    signal.throwIfAborted()
    if (!value) throw new Error('无法确认待采用结果，请核对状态后继续；未重新调用模型。')
    const plan = value.plan, caps = value.preparation
    if (expectedRun && caps?.run_id !== expectedRun) throw new Error('待采用运行已变化，状态已刷新。请核对新结果后再采用；未重新调用模型。')
    const sameScenes = (ids: string[]) => JSON.stringify([...ids].sort()) === JSON.stringify([...sceneIds].sort())
    if (value.signature !== signature || !plan || plan.signature !== signature || !sameScenes(value.scene_ids) || !sameScenes(plan.scene_ids)
      || !caps?.full_scope || caps.state !== 'complete' || caps.adoption?.can_adopt === false
      || !caps.run_id || plan.preparation?.run_id !== caps.run_id || plan.status === 'partial' || plan.failed_units?.length) {
      throw new Error(caps?.adoption?.reason || '待采用结果与当前来源不一致，请核对状态与分镜版本；旧成果已保留，未重新调用模型。')
    }
    return plan
  }
  function accept(plan: ScriptCanvasPlan) {
    revision.current++; setLoading(false); setRestoreError('')
    const value = { signature: plan.signature, scene_ids: plan.scene_ids, plan, preparation: plan.preparation }
    current.current = value; setSnapshot(value)
  }
  function actionBody(action: ReferenceAction, signature: string, modelId: string, extra: Record<string, unknown> = {}) {
    const saved = current.current, caps = saved?.preparation, failures = saved?.plan?.failed_units || []
    const view = referenceRecoveryView(saved?.plan, caps, modelId)
    if (loading || restoreError) throw new Error(restoreError || '正在读取参考准备状态，请稍候。')
    let selection: Record<string, unknown> = {}
    if (action === 'prepare-current') {
      if (!caps?.adoption?.can_prepare_current || saved?.signature !== signature) throw new Error(caps?.adoption?.prepare_reason || '当前范围已变化，请刷新状态后继续。')
      selection = { prepare_current_from_run_id: caps.run_id }
    } else if (action === 'restart' || action === 'abandon') {
      if (action === 'abandon' ? !caps?.inspection?.can_abandon : !caps?.can_restart_all) throw new Error(caps?.restart_reason || '请先读取当前运行状态。')
      selection = { restart_from_run_id: caps!.run_id, ...(action === 'abandon' ? { abandon_unknown: true } : {}) }
    } else {
      if (view.blocked) throw new Error(view.reason)
      if (typeof action === 'object') {
        if (!view.retries.some(retry => retry.unit_key === action.unit_key && retry.token === action.token)) throw new Error(caps?.retry_reason || '这个对象当前不可重试，请刷新状态。')
        selection = { unit_keys: [action.unit_key], retry_unit: action }
      } else if (view.retries.length) selection = { unit_keys: view.retries.map(retry => retry.unit_key), retry_units: view.retries }
      else if (failures.length) {
        if (!view.pending.length) throw new Error(caps?.continue_reason || '当前没有可继续的对象。')
        selection = { unit_keys: view.pending }
      }
      if (caps) selection.run_id = caps.run_id
    }
    const body = { ...scopeBody, signature, model_id: modelId, ...extra, ...selection }
    const fingerprint = JSON.stringify(body), storageKey = 'canvas-preparation-intent:v1:' + scope
    let requestId: string | undefined
    try { const saved = JSON.parse(window.localStorage.getItem(storageKey) || 'null'); if (saved?.fingerprint === fingerprint) requestId = saved.request_id } catch { /* Server receipts remain authoritative. */ }
    requestId ||= crypto.randomUUID()
    try { window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, request_id: requestId })) } catch { /* In-memory click guard still applies. */ }
    return { ...body, request_id: requestId }
  }
  async function currentScopeBody(signature: string, modelId: string, signal: AbortSignal, extra: Record<string, unknown> = {}) {
    const expectedRun = current.current?.preparation?.run_id
    const value = await reload(signal)
    signal.throwIfAborted()
    if (!value || value.signature !== signature || value.preparation?.run_id !== expectedRun) throw new Error('当前范围或运行已更新，请核对刷新后的状态再开始整理。')
    return actionBody('prepare-current', signature, modelId, extra)
  }
  function received(requestId: string) {
    const key = 'canvas-preparation-intent:v1:' + scope
    try { if (JSON.parse(window.localStorage.getItem(key) || 'null')?.request_id === requestId) window.localStorage.removeItem(key) } catch { /* Optional browser persistence. */ }
  }
  function markUnknown(keys: string[]) {
    const saved = current.current
    if (!saved) { void reload(); return }
    const reason = '上次请求的结果尚未确认，请先核对原请求；不能并发重试或全部重新开始。'
    const value: CanvasPreparationSnapshot = { ...saved,
      ...(saved.plan ? { plan: { ...saved.plan, failed_units: uncertainReferenceUnits(saved.plan.failed_units || [], keys) } } : {}),
      ...(saved.preparation ? { preparation: { ...saved.preparation, state: 'unknown', can_retry_failed: false, can_continue: false, can_restart_all: false,
        retry_reason: reason, continue_reason: reason, restart_reason: reason } } : {}) }
    revision.current++; current.current = value; setSnapshot(value); setLoading(false)
    // A browser disconnect is not authoritative evidence that server work is
    // unknown. Reconcile immediately without re-sending the generation intent.
    void reload()
  }
  async function discard() {
    const saved = current.current
    if (discardLock.current || !saved?.preparation?.adoption?.can_discard) return
    discardLock.current = true
    const expectedScope = scope, turn = ++revision.current
    setLoading(true); setRestoreError('')
    try {
      const value = await api<CanvasPreparationSnapshot>(`/projects/${projectId}/script/canvas/discard`, {
        ...json('POST', { ...scopeBody, signature: saved.signature, run_id: saved.preparation.run_id }),
      })
      if (scopeRef.current !== expectedScope || revision.current !== turn) return
      current.current = value; setSnapshot(value)
    } catch (issue) {
      if (scopeRef.current === expectedScope && revision.current === turn) setRestoreError('放弃尚未确认，请刷新状态：' + (issue instanceof Error ? issue.message : String(issue)))
    } finally { discardLock.current = false; if (scopeRef.current === expectedScope && revision.current === turn) setLoading(false) }
  }
  async function cancel() {
    const caps = current.current?.preparation
    if (!caps?.inspection?.can_cancel || !caps.inspection.owner_request_id) return
    const expectedScope = scope, turn = ++revision.current
    try {
      const value = await api<CanvasPreparationSnapshot>(`/projects/${projectId}/script/canvas/cancel`, { ...json('POST', { ...scopeBody, run_id: caps.run_id, owner_request_id: caps.inspection.owner_request_id }) })
      if (scopeRef.current !== expectedScope || revision.current !== turn) return
      current.current = value; setSnapshot(value); setRestoreError('')
    } catch (issue) { if (scopeRef.current === expectedScope && revision.current === turn) setRestoreError('停止尚未确认，请核对状态：' + (issue instanceof Error ? issue.message : String(issue))) }
  }
  return { snapshot, plan: snapshot?.plan, capabilities: snapshot?.preparation, loading, restoreError, reload, adoptionPlan, cancel, discard, accept, actionBody, currentScopeBody, received, markUnknown }
}

export function referenceRecoveryView(plan?: ScriptCanvasPlan, caps = plan?.preparation, modelId?: string, signature?: string) {
  const planUsable = !!plan?.signature && (!signature || plan.signature === signature)
  const needsRefresh = !!caps?.full_scope && caps.state === 'complete' && (!planUsable || caps.adoption?.can_adopt === false)
  const complete = planUsable && caps?.state === 'complete' && !plan.failed_units?.length
  const mismatch = !complete && !!caps?.model_id && !!modelId && caps.model_id !== modelId
  const prepareCurrent = !!caps?.adoption?.can_prepare_current && caps.adoption.source_matches === false
  const blocked = caps?.state === 'running' || caps?.state === 'unknown' || mismatch || needsRefresh
  const sourceChanged = caps?.adoption?.source_matches === false
  const sourceMessage = sourceChanged ? `当前分镜已更新，旧参考${caps?.adoption?.discarded ? '已放弃采用' : '已保留'}，不能直接采用。` : ''
  const views = (plan?.failed_units || []).map(referenceFailureView)
  const retries = blocked || caps && !caps.can_retry_failed ? [] : views.flatMap(view => view.retry && (!caps || caps.retryable_unit_keys.includes(view.unitKey)) ? [view.retry] : [])
  const pending = blocked || caps && !caps.can_continue ? [] : views.filter(view => view.canContinue && (!caps || caps.pending_unit_keys.includes(view.unitKey))).map(view => view.unitKey)
  const manualCoverage = !!plan?.failed_units?.length && plan.failed_units.every(unit => unit.stage === 'coverage') && !blocked
    && !retries.length && !pending.length && !prepareCurrent && !caps?.can_continue
  const adopt = !needsRefresh && planUsable && !!caps?.full_scope && caps.state === 'complete' && !plan?.failed_units?.length
  const canProcess = !blocked && (retries.length > 0 || pending.length > 0 || !plan?.failed_units?.length && (!caps || complete || caps.can_continue || caps.state === 'idle'))
  const restart = !canProcess && !prepareCurrent && !adopt && !!caps?.can_restart_all && caps.state !== 'running' && caps.state !== 'unknown'
  return { blocked, retries, pending, adopt, canProcess, restart, manualCoverage, needsRefresh, prepareCurrent, sourceChanged, sourceMessage,
    primaryAction: (caps?.inspection?.can_abandon ? 'abandon' : prepareCurrent ? 'prepare-current' : adopt ? 'adopt' : restart ? 'restart' : 'continue') as ReferenceAction,
    primaryLabel: caps?.inspection?.can_abandon ? '重新整理' : prepareCurrent ? '整理参考' : adopt ? '加入画布' : restart ? '重新整理' : (plan?.failed_units?.length || caps?.state === 'failed') && canProcess ? '重试' : '',
    primaryEnabled: canProcess || restart || prepareCurrent || !!caps?.inspection?.can_abandon,
    disabledReason: sourceChanged && !prepareCurrent ? caps?.adoption?.prepare_reason || '请刷新状态，核对当前范围可用的整理操作。' : '', coverageOnly: !!plan?.failed_units?.length && plan.failed_units.every(unit => unit.stage === 'coverage'),
    reason: manualCoverage ? '参考整理未完成，已有结果已保留。' : needsRefresh ? caps?.adoption?.reason || '未读到与当前来源一致的完整结果，请核对状态与分镜版本；旧成果已保留。' : mismatch ? '所选模型与本次运行不同；继续需使用原模型，或明确全部重新开始视觉参考准备。'
      : caps?.state === 'unknown' || caps?.state === 'running' ? caps.restart_reason : plan?.failed_units?.length || !canProcess ? (retries.length ? caps?.retry_reason : caps?.continue_reason) || '' : '' }
}
