import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Loader, Modal } from '@mantine/core'
import { AlertCircle, ArrowRight } from 'lucide-react'
import { api, json, type Model, type ProjectDetail, type ScriptCanvasCheck, type ScriptCanvasPlan, type ScriptCanvasResult } from '../../shared/api/api'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import { TaskReasoningSelect, taskReasoningLabel, useTaskReasoning } from '../models/TaskReasoningSelect'
import { assertStoryboardProductionScope } from './storyboard-production'
import { isUncertainReferenceRequest, uncertainReferenceUnits } from './reference-failure'
import ReferencePreparationRecovery, { ReferencePrimaryAction, referenceIsWorking } from './ReferencePreparationRecovery'
import { referenceRecoveryView, useCanvasPreparationRecovery, type ReferenceAction } from './useCanvasPreparationRecovery'
import { ReferencePreparationModel } from './ReferencePreparationProgress'
import ReferencePreparationActivity from './ReferencePreparationActivity'
import './storyboard-production.css'

export type StoryboardProductionDialogProps = {
  projectId: string
  sceneIds: string[]
  shotIds: string[]
  designId: string | null
  models: Model[]
  onComplete: (result: ScriptCanvasResult) => void | Promise<void>
  onCancel: () => void
}
type Phase = 'checking' | 'preparing' | 'committing' | 'handoff' | null
const progress: Record<NonNullable<Phase>, string> = {
  checking: '正在检查分镜与参考设定', preparing: '正在整理参考', committing: '正在保存设定并准备画布', handoff: '正在打开画布',
}

export default function StoryboardProductionDialog(props: StoryboardProductionDialogProps) {
  const { projectId, sceneIds, shotIds, designId, models } = props
  const eligibleModels = useMemo(() => models.filter(model => model.modality === 'text' && model.enabled), [models])
  const [phase, setPhase] = useState<Phase>(null), [error, setError] = useState(''), [completed, setCompleted] = useState(false)
  const scopeKey = JSON.stringify([projectId, sceneIds, shotIds, designId])
  const latest = useRef(props); latest.current = props
  const liveScope = useRef(scopeKey); liveScope.current = scopeKey
  const mounted = useRef(false), serial = useRef(0), operation = useRef(false), phaseRef = useRef<Phase>(null)
  const controller = useRef<AbortController | null>(null), imported = useRef<ScriptCanvasResult | null>(null)
  const prepared = useRef<{ modelId: string; plan: ScriptCanvasPlan } | null>(null), referencesCommitted = useRef(false)
  const [failedUnits, setFailedUnits] = useState<NonNullable<ScriptCanvasPlan['failed_units']>>([])
  const [completedUnits, setCompletedUnits] = useState<ScriptCanvasPlan['profiles']>([])
  const [uncertain, setUncertain] = useState(false)
  const { modelId, selectModel } = useSharedModelSelection('text', eligibleModels, { locked: !!phase || !!imported.current || completed })
  const reasoning = useTaskReasoning(eligibleModels.find(model => model.id === modelId))
  const recovery = useCanvasPreparationRecovery({ projectId, sceneIds, designId, refreshKey: JSON.stringify([modelId, [...shotIds].sort()]), paused: !!phase && phase !== 'preparing', watching: phase === 'preparing' })
  const recoveryView = referenceRecoveryView({ signature: '', scene_ids: sceneIds, profiles: completedUnits, ...recovery.plan, failed_units: failedUnits }, recovery.capabilities, modelId, recovery.snapshot?.signature)
  const savedReasoning = recovery.capabilities?.text_generation_options?.reasoning
  useEffect(() => {
    if (recovery.plan) { setFailedUnits(recovery.plan.failed_units || []); setCompletedUnits(recovery.plan.profiles) }
    else if (recovery.capabilities?.adoption?.source_matches === false) { setFailedUnits([]); setCompletedUnits([]) }
    if (recovery.capabilities) setUncertain(recovery.capabilities.state === 'unknown')
    if (recovery.capabilities && recovery.capabilities.state !== 'unknown') setError(current => current.startsWith('上次请求的结果尚未确认') ? '' : current)
  }, [recovery.snapshot])
  useEffect(() => {
    mounted.current = true; serial.current++; operation.current = false; phaseRef.current = null
    imported.current = null; prepared.current = null; referencesCommitted.current = false; setFailedUnits([]); setCompletedUnits([]); setUncertain(false); setPhase(null); setError(''); setCompleted(false)
    return () => { mounted.current = false; serial.current++; if (phaseRef.current !== 'preparing') controller.current?.abort() }
  }, [scopeKey])
  useEffect(() => { if (prepared.current?.modelId !== modelId) prepared.current = null }, [modelId])
  function transition(next: Phase) { phaseRef.current = next; setPhase(next) }
  function cancel() {
    if (phaseRef.current === 'committing' || phaseRef.current === 'handoff') return
    serial.current++
    // Closing releases this subscriber while the accepted reference request
    // continues; its result remains available after reopening.
    if (phaseRef.current === 'preparing') controller.current = null
    else controller.current?.abort()
    operation.current = false; transition(null)
    latest.current.onCancel()
  }
  async function start(action: ReferenceAction = 'continue') {
    if (operation.current || completed || recovery.loading || recovery.restoreError || uncertain && action !== 'abandon' || !sceneIds.length || !shotIds.length) return
    if (action !== 'restart' && action !== 'abandon' && action !== 'prepare-current' && recoveryView.blocked) return
    const restarting = action === 'restart' || action === 'abandon' || action === 'prepare-current'
    const requestedKeys = typeof action === 'object' ? [action.unit_key] : restarting || action === 'adopt' ? []
      : recoveryView.retries.length ? recoveryView.retries.map(retry => retry.unit_key) : recoveryView.pending
    if (failedUnits.length && !requestedKeys.length && !restarting && action !== 'adopt') return
    if (typeof action === 'object' && !recoveryView.retries.some(retry => retry.token === action.token && retry.unit_key === action.unit_key)) return
    operation.current = true
    const turn = ++serial.current, key = scopeKey, abort = new AbortController(); controller.current = abort
    const active = () => mounted.current && liveScope.current === key && turn === serial.current && !abort.signal.aborted
    setError('')
    let referenceRequestActive = false, referenceRequestId: string | undefined
    try {
      if (!imported.current) {
        transition('checking')
        const detail = await api<ProjectDetail>(`/projects/${projectId}`, { signal: abort.signal })
        if (!active()) return
        const containsHistorical = shotIds.some(shotId => !detail.shots.some(shot => shot.id === shotId && !shot.superseded_by))
        const productionSnapshot = containsHistorical && designId
          ? await api<ShotManagementSnapshot>(`/projects/${projectId}/shot-management`, { signal: abort.signal }) : undefined
        if (!active()) return
        assertStoryboardProductionScope(detail, projectId, sceneIds, shotIds, designId, productionSnapshot)
        const explicitDesign = designId ? { design_id: designId } : {}
        const check = await api<ScriptCanvasCheck>(`/projects/${projectId}/script/canvas/check`, { ...json('POST', { scene_ids: sceneIds, ...explicitDesign }), signal: abort.signal })
        if (!active()) return
        if (check.needs_analysis.length || restarting || recovery.capabilities?.full_scope && !referencesCommitted.current) {
          transition('preparing')
          const cached = prepared.current?.modelId === modelId ? prepared.current.plan : recovery.capabilities?.state === 'complete' ? recovery.plan : undefined
          let plan = !restarting && typeof action !== 'object' && cached?.signature === check.signature && cached.status !== 'partial' && !cached.failed_units?.length ? cached : null
          if (action === 'adopt') {
            plan = await recovery.adoptionPlan(check.signature, abort.signal)
            if (!active()) return
          }
          if (!plan) {
            if (action === 'adopt') throw new Error('待采用结果已变化，请刷新恢复状态后核对；未重新调用模型。')
            if (!eligibleModels.some(model => model.id === modelId)) throw new Error('这些镜头需要整理参考设定，请先在模型设置中启用一个文本模型。')
            const body = action === 'prepare-current' ? await recovery.currentScopeBody(check.signature, modelId, abort.signal, reasoning.request) : recovery.actionBody(action, check.signature, modelId, reasoning.request)
            referenceRequestActive = true
            referenceRequestId = body.request_id
            plan = await api<ScriptCanvasPlan>(`/projects/${projectId}/script/canvas/prepare`, { ...json('POST', body), signal: abort.signal })
            if (!active()) return
            referenceRequestActive = false
            recovery.received(body.request_id); recovery.accept(plan)
            if (plan.status === 'partial' || plan.failed_units?.length) {
              setFailedUnits(plan.failed_units || [])
              setCompletedUnits(plan.profiles)
              return
            }
            setFailedUnits([])
            setCompletedUnits(plan.profiles)
            prepared.current = { modelId, plan }
          }
          transition('committing')
          await api<ScriptCanvasResult>(`/projects/${projectId}/script/canvas/commit`, { ...json('POST', {
            scene_ids: plan.scene_ids, ...explicitDesign, signature: plan.signature, profiles: plan.profiles,
            ...(plan.preparation ? { run_id: plan.preparation.run_id } : {}),
            ...(plan.reference_usage_version ? { reference_usage_version: plan.reference_usage_version } : {}),
            ...(plan.coverage_version ? { coverage_version: plan.coverage_version, visual_coverage: plan.visual_coverage } : {}),
          }), signal: abort.signal })
          if (!active()) return
          prepared.current = null; referencesCommitted.current = true
        }
        transition('committing')
        const result = await api<ScriptCanvasResult>(`/projects/${projectId}/script/storyboard/canvas`, { ...json('POST', {
          scene_ids: sceneIds, shot_ids: shotIds, design_id: designId, mode: 'existing',
        }), signal: abort.signal })
        if (!active()) return
        imported.current = result
      }
      transition('handoff')
      await latest.current.onComplete(imported.current)
      if (active()) setCompleted(true)
    } catch (issue) {
      if (active() && referenceRequestActive && isUncertainReferenceRequest(issue)) {
        recovery.markUnknown(requestedKeys)
        setUncertain(true); setFailedUnits(units => uncertainReferenceUnits(units, requestedKeys))
        setError('上次请求的结果尚未确认，已停止自动重发。请先核对请求记录，再恢复。')
        return
      }
      if (active() && referenceRequestActive && referenceRequestId) {
        recovery.received(referenceRequestId)
        const snapshot = await recovery.reload(abort.signal)
        if (!active()) return
        if (snapshot?.preparation?.state === 'failed' && snapshot.preparation.can_continue) return
      }
      if (active()) setError(`${imported.current ? '分镜已准备，打开画布失败：' : ''}${issue instanceof Error ? issue.message : String(issue)}`)
    } finally {
      if (active()) { operation.current = false; transition(null) }
    }
  }
  const committing = phase === 'committing' || phase === 'handoff'
  const actionLabel = completed ? '已加入画布' : imported.current ? '重试打开画布'
    : phase === 'checking' ? '检查中…' : phase === 'preparing' ? '整理中…'
      : phase === 'committing' ? '保存中…' : phase === 'handoff' ? '打开中…' : referencesCommitted.current ? '重试加入画布' : recoveryView.primaryLabel || (recoveryView.adopt ? '加入画布'
        : recoveryView.retries.length ? '重试' : failedUnits.length ? '重试' : '加入画布')
  const working = referenceIsWorking(recovery.capabilities, phase ? progress[phase] : undefined)
  const modelNotice = recoveryView.adopt || imported.current || completed ? '' : recoveryView.retries.length ? '将调用所选模型'
    : failedUnits.length ? recoveryView.pending.some(key => failedUnits.find(unit => unit.unit_key === key)?.recovery?.model_call !== 'none') ? '将调用所选模型' : ''
      : ''
  return <Modal opened centered size="lg" zIndex={320} title="加入画布" onClose={cancel}
    closeOnClickOutside={!committing} closeOnEscape={!committing} closeButtonProps={{ disabled: committing, 'aria-label': '关闭分镜制作准备' }}
    classNames={{ content: `storyboard-production-modal${working ? ' is-working' : ''}`, header: 'storyboard-production-header', body: 'storyboard-production-body' }}>
    <div className="storyboard-production-context">
    <div className="storyboard-production-summary"><strong>{shotIds.length} 个镜头</strong><span>来自 {sceneIds.length} 场</span></div>
    {!working && (eligibleModels.length ? <ReferencePreparationModel working={working} capabilities={recovery.capabilities} models={models} modelId={modelId}
      label="参考设定模型" disabled={!!phase || !!imported.current || completed} onChange={value => { selectModel(value); prepared.current = null }} dropdownZIndex={330} />
      : <p className="storyboard-production-help">参考设定已准备好时可直接加入；需要整理时，请先启用文本模型。</p>)}
    {!working && <TaskReasoningSelect reasoning={reasoning} disabled={!!phase || !!imported.current || completed} zIndex={330} />}
    {!working && savedReasoning && savedReasoning !== reasoning.value && (recovery.capabilities?.can_continue || recovery.capabilities?.can_retry_failed) &&
      <span className="storyboard-production-help">续跑档位 · {taskReasoningLabel(savedReasoning)}</span>}
    </div>
    {!working && <div className="storyboard-production-content">
    <div className="storyboard-production-notices">
      <ReferencePreparationRecovery simple snapshot={recovery.snapshot} onDiscard={() => void recovery.discard()} capabilities={recovery.capabilities} sceneCount={sceneIds.length} busy={!!phase || recovery.loading || completed} error={recovery.restoreError} reading={recovery.loading}
        activity={phase ? progress[phase] : undefined} preparing={phase === 'preparing'} reason={recoveryView.reason} sourceMessage={recoveryView.sourceMessage} disabledReason={recoveryView.disabledReason} adopt={recoveryView.adopt} completed={completed}
        onReload={() => void recovery.reload()} onRestart={() => void start('restart')} onAbandon={() => void start('abandon')} />
      {error && recovery.capabilities?.state !== 'unknown' && <Alert className="storyboard-production-error" color="red" icon={<AlertCircle size={16} />} role="alert">{error}</Alert>}
      {modelNotice && !working && <span className="storyboard-production-cost">{modelNotice}</span>}
    </div>
    </div>}
    <div className={`storyboard-production-actions${modelNotice ? ' has-model-notice' : ''}`}>
      {working && <ReferencePreparationActivity capabilities={recovery.capabilities} activity={phase ? progress[phase] : undefined} preparing={phase === 'preparing'} />}
      <div className="reference-footer-primary-actions"><Button className="storyboard-production-cancel" variant="subtle" disabled={committing} onClick={cancel}>关闭</Button>
      {!working && !recovery.restoreError && (recovery.capabilities?.state !== 'unknown' || recovery.capabilities.inspection?.can_abandon) && <ReferencePrimaryAction key={`${recovery.capabilities?.run_id}:${recoveryView.primaryAction}`} action={recoveryView.primaryAction} onAction={action => void start(action)} className="storyboard-production-primary" variant="filled"
        leftSection={phase ? <Loader size={15} color="currentColor" /> : <ArrowRight size={15} />}
        disabled={!!phase || completed || recovery.loading || !!recovery.restoreError || uncertain && !recovery.capabilities?.inspection?.can_abandon || !sceneIds.length || !shotIds.length || !recoveryView.primaryEnabled || ['restart', 'prepare-current', 'abandon'].includes(String(recoveryView.primaryAction)) && !eligibleModels.length}>
        {actionLabel}
      </ReferencePrimaryAction>}</div></div>
  </Modal>
}
