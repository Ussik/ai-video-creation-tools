import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Loader, Modal, Select } from '@mantine/core'
import { AlertCircle, ArrowRight } from 'lucide-react'
import { api, json, type Model, type ProjectDetail, type ScriptCanvasCheck, type ScriptCanvasPlan, type ScriptCanvasResult } from '../../shared/api/api'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import { assertStoryboardProductionScope } from './storyboard-production'
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
  checking: '正在检查分镜与参考设定', preparing: '正在整理人物、场景与道具设定', committing: '正在保存设定并准备画布', handoff: '正在打开画布',
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
  const prepared = useRef<{ modelId: string; plan: ScriptCanvasPlan } | null>(null)
  const { modelId, selectModel } = useSharedModelSelection('text', eligibleModels, { locked: !!phase || !!imported.current || completed })
  useEffect(() => {
    mounted.current = true; serial.current++; operation.current = false; phaseRef.current = null
    imported.current = null; prepared.current = null; setPhase(null); setError(''); setCompleted(false)
    return () => { mounted.current = false; serial.current++; controller.current?.abort() }
  }, [scopeKey])
  useEffect(() => { if (prepared.current?.modelId !== modelId) prepared.current = null }, [modelId])
  function transition(next: Phase) { phaseRef.current = next; setPhase(next) }
  function cancel() {
    if (phaseRef.current === 'committing' || phaseRef.current === 'handoff') return
    serial.current++; controller.current?.abort(); operation.current = false; transition(null)
    latest.current.onCancel()
  }
  async function start() {
    if (operation.current || completed || !sceneIds.length || !shotIds.length) return
    operation.current = true
    const turn = ++serial.current, key = scopeKey, abort = new AbortController(); controller.current = abort
    const active = () => mounted.current && liveScope.current === key && turn === serial.current && !abort.signal.aborted
    setError('')
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
        if (check.needs_analysis.length) {
          if (!eligibleModels.some(model => model.id === modelId)) throw new Error('这些镜头需要整理参考设定，请先在模型设置中启用一个文本模型。')
          transition('preparing')
          let plan = prepared.current?.modelId === modelId && prepared.current.plan.signature === check.signature ? prepared.current.plan : null
          if (!plan) {
            plan = await api<ScriptCanvasPlan>(`/projects/${projectId}/script/canvas/prepare`, { ...json('POST', {
              scene_ids: sceneIds, ...explicitDesign, signature: check.signature, model_id: modelId,
            }), signal: abort.signal })
            if (!active()) return
            prepared.current = { modelId, plan }
          }
          transition('committing')
          await api<ScriptCanvasResult>(`/projects/${projectId}/script/canvas/commit`, { ...json('POST', {
            scene_ids: plan.scene_ids, ...explicitDesign, signature: plan.signature, profiles: plan.profiles,
            ...(plan.reference_usage_version ? { reference_usage_version: plan.reference_usage_version } : {}),
            ...(plan.coverage_version ? { coverage_version: plan.coverage_version, visual_coverage: plan.visual_coverage } : {}),
          }), signal: abort.signal })
          if (!active()) return
          prepared.current = null
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
      if (active()) setError(`${imported.current ? '分镜已准备，打开画布失败：' : ''}${issue instanceof Error ? issue.message : String(issue)}`)
    } finally {
      if (active()) { operation.current = false; transition(null) }
    }
  }
  const committing = phase === 'committing' || phase === 'handoff'
  const actionLabel = completed ? '已加入画布' : imported.current ? '重试打开画布'
    : phase === 'checking' ? '检查中…' : phase === 'preparing' ? '整理中…'
      : phase === 'committing' ? '保存中…' : phase === 'handoff' ? '打开中…' : '准备并加入画布'
  return <Modal opened centered size="md" zIndex={320} title="加入画布制作" onClose={cancel}
    closeOnClickOutside={!committing} closeOnEscape={!committing} closeButtonProps={{ disabled: committing, 'aria-label': '关闭分镜制作准备' }}
    classNames={{ content: 'storyboard-production-modal', body: 'storyboard-production-body' }}>
    <div className="storyboard-production-summary"><strong>{shotIds.length} 个镜头</strong><span>来自 {sceneIds.length} 场</span></div>
    <p className="storyboard-production-description">加入前会检查参考设定。缺少时使用所选文本模型整理，已准备的设定会复用。进入画布后再生成分镜图片和视频。</p>
    {eligibleModels.length ? <Select label="整理参考设定文本模型" aria-label="整理参考设定文本模型" description="仅在参考设定需要补齐时使用"
      data={eligibleModels.map(model => ({ value: model.id, label: model.name }))} value={modelId || null} allowDeselect={false}
      disabled={!!phase || !!imported.current || completed} onChange={value => { if (value) { selectModel(value); prepared.current = null } }} comboboxProps={{ zIndex: 330 }} />
      : <p className="storyboard-production-help">参考设定已准备好时可直接加入；需要整理时，请先启用文本模型。</p>}
    {error && <Alert className="storyboard-production-error" color="red" icon={<AlertCircle size={16} />} role="alert">{error}</Alert>}
    {phase && <div className="storyboard-production-progress" role="status" aria-live="polite"><Loader size="xs" /><span>{progress[phase]}</span></div>}
    <div className="storyboard-production-actions"><Button variant="default" disabled={committing} onClick={cancel}>{phase === 'preparing' ? '取消整理' : '取消'}</Button>
      <Button className="storyboard-production-primary" variant="filled"
        leftSection={phase ? <Loader size={15} color="currentColor" /> : <ArrowRight size={15} />}
        disabled={!!phase || completed || !sceneIds.length || !shotIds.length} onClick={() => void start()}>
        {actionLabel}
      </Button></div>
  </Modal>
}
