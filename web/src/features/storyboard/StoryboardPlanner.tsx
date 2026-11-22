import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { isUncertainReferenceRequest, uncertainReferenceUnits } from './reference-failure'
import { ReferencePreparationModel } from './ReferencePreparationProgress'
import ReferencePreparationActivity from './ReferencePreparationActivity'
import ReferencePreparationRecovery, { ReferencePrimaryAction, referenceIsWorking } from './ReferencePreparationRecovery'
import { referenceRecoveryView, useCanvasPreparationRecovery, type ReferenceAction } from './useCanvasPreparationRecovery'
import { useEffect, useRef, useState } from 'react'
import { UnstyledButton, ActionIcon, Button, Checkbox, Group, Modal, NumberInput, Popover, Select, Textarea, TextInput } from '@mantine/core'
import { ArrowLeft, Check, ChevronRight, Clapperboard, Info, LoaderCircle, Plus, Puzzle, Save, Trash2 } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { ApiError, Model, ProjectDetail, ScriptCanvasCheck, ScriptCanvasPlan, ScriptCanvasResult } from '../../shared/api/api'
import type { StoryboardPlanningContext, StoryboardPlanningResult, StoryboardPlanningTask, StoryboardShotDraft } from '@video-studio/shared/storyboard/storyboard-planning-types'
import { maxScriptSceneDuration } from '@video-studio/shared/script/script-duration'
import { requestScriptCanvas } from '../script/script-canvas-handoff'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import { TaskReasoningSelect, taskReasoningLabel, useTaskReasoning } from '../models/TaskReasoningSelect'
import './storyboard-planner.css'
import CreativeSkillSelector from '../skills/CreativeSkillSelector'
import type { SkillAssignment, SkillPolicy } from '../../shared/api/skills-api'
import { useAppDialog } from '../../shared/ui/AppDialog'
import { cancelPlanningRequest, cancelPlanningTask, forgetPlanningTask, lookupPlanningTask, observePlanningTask, planningTaskFailure, planningTaskFailureDetails, planningTaskStageLabel,
  rememberedPlanningTask, rememberObservedPlanningTask, resumePlanningTask, startPlanningTask, type PlanningTaskInput } from './storyboard-planning-task'

type Props = {
  opened: boolean; onClose: () => void; detail: ProjectDetail; models: Model[]; initialSceneIds: string[];
  onRefresh: () => Promise<unknown>; onOpenCanvas: () => void; onNotice: (message: string) => void
  intent?: 'plan' | 'canvas'; onSaved?: (result: ScriptCanvasResult) => void | Promise<void>; presentation?: 'modal' | 'page'; returnLabel?: string
}
const batchLimit = 10
type PlanningResult = StoryboardPlanningResult & { skill_assignment?: SkillAssignment; motion_skill_assignment?: SkillAssignment }
type PlanningError = { message: string; raw_output?: string; diagnostics?: string; code?: string; retryable?: boolean; recovery?: ApiError['recovery'] }
const blockedVisualHistory = (error: PlanningError) => error.retryable === false && /^(?:visual_profile_|visual_catalog_legacy_response_preserved$)/.test(error.code || '')
const toggle = (values: string[], id: string, checked: boolean) => checked ? [...values, id] : values.filter(value => value !== id)
const errorText = (issue: unknown) => {
  const message = issue instanceof Error ? issue.message : String(issue)
  return message.replace(/^模型结果不符合 (?:controlled_storyboard|storyboard_directing_review) 契约（已修正一次）：/, '分镜规划结果未通过校验（自动修正后仍未通过）：')
}
function planningError(issue: unknown, prefix = ''): PlanningError {
  const details = issue as Partial<ApiError> | null
  const full = errorText(issue)
  const expanded = full.length > 240 || full.split('\n').length > 4
  const catalog = /参考对象目录|局部纠正目标|visual_profile_catalog/.test(full)
  const summary = expanded ? catalog
    ? '参考对象目录未通过校验；原回答已保留。请展开详情查看字段问题和纠正状态。'
    : full.split('\n')[0]!.slice(0, 160) + '…（完整错误见详情）' : full
  const diagnostics = typeof details?.diagnostics === 'string' ? details.diagnostics : ''
  return { message: prefix + summary, code: details?.code, retryable: details?.retryable, recovery: details?.recovery,
    ...(typeof details?.raw_output === 'string' ? { raw_output: details.raw_output } : {}),
    ...((diagnostics || expanded) ? { diagnostics: diagnostics || full } : {}) }
}
function errorReport(error: PlanningError): string {
  return [`错误：${error.message}`, error.diagnostics && `校验详情：\n${error.diagnostics}`,
    error.raw_output && `模型原始返回：\n${error.raw_output}`].filter(Boolean).join('\n\n')
}
function planIssue(result: StoryboardPlanningResult): string {
  for (const scene of result.scenes) {
    if (!scene.shots.length || scene.shots.length > 30) return '每场需要 1 至 30 个镜头'
    if (!Number.isInteger(scene.scene_duration) || scene.scene_duration < 1 || scene.scene_duration > maxScriptSceneDuration) return `每场规划时长应为 1 至 ${maxScriptSceneDuration} 秒`
    if (scene.shots.some(shot => !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 30)) return '每镜时长应为 1 至 30 秒'
    if (scene.shots.reduce((sum, shot) => sum + shot.duration, 0) !== scene.scene_duration) return `「${scene.scene_heading}」镜头合计时长需要等于本场规划时长`
    if (scene.shots.some(shot => !shot.title.trim() || !shot.prompt.trim() || !shot.image_prompt.trim() || !shot.video_prompt.trim())) return '请填写镜头标题、描述及图片和视频提示词'
  }
  return ''
}
const planned = (scene: StoryboardPlanningContext['scenes'][number]) => scene.planned === true && !scene.needs_replan && !scene.requires_redesign
const hasPreviousPlan = (scene: StoryboardPlanningContext['scenes'][number]) => !!scene.has_previous_plan || scene.shot_count > 0 || !!scene.requires_redesign
const needsCanvasNodes = (scene: StoryboardPlanningContext['scenes'][number]) => planned(scene) &&
  typeof scene.canvas_shot_count === 'number' && scene.canvas_shot_count < scene.shot_count
const replanLabel = (scene: StoryboardPlanningContext['scenes'][number]) =>
  scene.replan_reason === 'episode_script_changed' || scene.replan_reason === 'scene_changed'
    ? '正文已更新，需重新规划' : '资料已更新，需重新规划'
function episodeDocumentIds(context: StoryboardPlanningContext, sceneIds: string[]) {
  const episodes = new Set(context.scenes.filter(scene => sceneIds.includes(scene.id)).map(scene => scene.episode_number))
  return context.documents.filter(document => document.artifact_type === 'episode_script' && episodes.has(document.episode_number) &&
    (!context.default_document_ids || context.default_document_ids.includes(document.id))).map(document => document.id)
}
export default function StoryboardPlanner({ opened, onClose, detail, models, initialSceneIds, onRefresh, onOpenCanvas, onNotice, intent = 'canvas', onSaved, presentation = 'modal', returnLabel = intent === 'plan' ? '返回分镜管理' : '返回剧本' }: Props) {
  const planningOnly = intent === 'plan'
  const isPage = presentation === 'page'
  const scenePicker = useRef<HTMLElement>(null)
  const [selectingScenes, setSelectingScenes] = useState(false)
  const dialog = useAppDialog({ zIndex: 350 })
  const [guarding, setGuarding] = useState(false), [settingsRevision, setSettingsRevision] = useState(0)
  const guardLock = useRef(false), reviewLock = useRef(false), canvasLock = useRef(false)
  const live = useRef({ opened, projectId: detail.id }); live.current = { opened, projectId: detail.id }
  const [sceneIds, setSceneIds] = useState<string[]>([]), [documentIds, setDocumentIds] = useState<string[]>([]), [manualSkillIds, setSkillIds] = useState<string[]>([])
  const [skillManual, setSkillManual] = useState(false)
  const [referenceSkillIds, setReferenceSkillIds] = useState<string[]>([])
  const [referenceManual, setReferenceManual] = useState(false)
  const [referenceUsed, setReferenceUsed] = useState<{ skills: string[]; assignment?: SkillAssignment }>()
  const [referenceReloading, setReferenceReloading] = useState(false)
  const [referenceBlockedKey, setReferenceBlockedKey] = useState('')
  const [referenceFailures, setReferenceFailures] = useState<NonNullable<ScriptCanvasPlan['failed_units']>>([])
  const [referenceCompleted, setReferenceCompleted] = useState<ScriptCanvasPlan['profiles']>([])
  const [context, setContext] = useState<StoryboardPlanningContext | null>(null)
  const [shotsPerScene, setShotsPerScene] = useState<number | string>(''), [durationChoice, setDurationChoice] = useState<'preserve' | 'reestimate' | 'fixed'>('preserve'), [target, setTarget] = useState<number | string>(30)
  const [instructions, setInstructions] = useState(''), [pending, setPending] = useState<'context' | 'preview' | 'plan' | 'review' | 'repair' | 'references' | 'save' | null>(null)
  const [targetVideoModelId, setTargetVideoModelId] = useState('')
  const [saveLabel, setSaveLabel] = useState('正在加入画布')
  const [error, setError] = useState<PlanningError | null>(null), [result, setResult] = useState<PlanningResult | null>(null), [elapsed, setElapsed] = useState(0)
  const [resultModelId, setResultModelId] = useState('')
  const [planningTask, setPlanningTask] = useState<StoryboardPlanningTask | null>(null), [taskConnection, setTaskConnection] = useState('')
  const [cancellingTask, setCancellingTask] = useState(false), [taskObservedAt, setTaskObservedAt] = useState(0)
  const [cancelUnconfirmed, setCancelUnconfirmed] = useState(false)
  const taskRef = useRef<StoryboardPlanningTask | null>(null), taskInputRef = useRef<PlanningTaskInput | null>(null)
  const restoreAttempted = useRef(false), cancelRequested = useRef(false)
  const [refreshKey, setRefreshKey] = useState(0), [view, setView] = useState<'setup' | 'preview'>('setup')
  const [focusedSceneId, setFocusedSceneId] = useState(''), [replanExisting, setReplanExisting] = useState(false)
  const [planningMode, setPlanningMode] = useState<'redesign' | 'update'>('redesign')
  const initialized = useRef(false), skillInitialized = useRef(false), referenceSkillInitialized = useRef(false)
  const contextReady = useRef(false)
  const documentChoices = useRef(new Map<string, boolean>())
  const serial = useRef(0), requestId = useRef(''), applied = useRef<ScriptCanvasResult | null>(null), prepared = useRef<ScriptCanvasResult | null>(null), imported = useRef<ScriptCanvasResult | null>(null), controller = useRef<AbortController | null>(null)
  const acceptedReference = useRef<AbortController | null>(null)
  function releaseRequest() {
    serial.current++
    if (controller.current !== acceptedReference.current) controller.current?.abort()
    controller.current = null
  }
  const rangeIds = initialSceneIds.length ? initialSceneIds : detail.script.scenes.map(scene => scene.id)
  const rangeKey = rangeIds.join(',')
  const eligibleModels = models.filter(model => model.modality === 'text' && model.enabled)
  const videoModels = models.filter(model => model.modality === 'video' && model.enabled)
  const { modelId, selectModel } = useSharedModelSelection('text', eligibleModels, { active: opened, locked: !!pending || guarding || !!imported.current })
  const reasoning = useTaskReasoning(eligibleModels.find(model => model.id === modelId))
  useEffect(() => () => releaseRequest(), [])
  useEffect(() => {
    if (!opened) { releaseRequest(); setSelectingScenes(false); return }
    initialized.current = false; skillInitialized.current = false; referenceSkillInitialized.current = false; contextReady.current = false
    restoreAttempted.current = false; taskRef.current = null; taskInputRef.current = null; cancelRequested.current = false
    setPlanningTask(null); setTaskConnection(''); setCancellingTask(false); setCancelUnconfirmed(false)
    documentChoices.current.clear()
    setSceneIds(rangeIds.slice(0, batchLimit)); setDocumentIds([]); setSkillIds([]); setSkillManual(false); setReferenceSkillIds([]); setReferenceManual(false); setReferenceUsed(undefined); setReferenceReloading(false); setContext(null); setResult(null); setResultModelId(''); setError(null); setInstructions('')
    setDurationChoice('preserve'); setShotsPerScene(''); setReplanExisting(false); setPlanningMode('redesign'); setView('setup'); setFocusedSceneId('')
    setTargetVideoModelId('')
    setReferenceFailures([]); setReferenceCompleted([]); canvasLock.current = false
    applied.current = null; prepared.current = null; imported.current = null; guardLock.current = false; setGuarding(false)
    // Opening loads metadata only; the creator explicitly starts any model work.
  }, [opened, detail.id])
  useEffect(() => {
    if (!opened) return
    const turn = ++serial.current
    if (controller.current !== acceptedReference.current) controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    contextReady.current = false
    setContext(null); setResult(null); applied.current = null; prepared.current = null; imported.current = null
    if (!rangeIds.length) { setPending(null); return }
    setPending('context'); setError(null)
    api<StoryboardPlanningContext>(`/projects/${detail.id}/script/storyboard/context`, { ...json('POST', { scene_ids: rangeIds }), signal: abort.signal })
      .then(value => {
        if (turn !== serial.current) return
        contextReady.current = true
        setContext(value); setDocumentIds(current => current.filter(id => value.documents.some(document => document.id === id)))
        if (!skillInitialized.current) { setSkillIds(value.default_skill_ids || []); skillInitialized.current = true }
        if (!referenceSkillInitialized.current) { setReferenceSkillIds(value.reference_preparation?.default_skill_ids || []); referenceSkillInitialized.current = true }
        if (!initialized.current) {
          const missing = value.scenes.filter(needsCanvasNodes), unplanned = value.scenes.filter(scene => !planned(scene))
          const batch = (!planningOnly && missing.length ? missing : unplanned.length ? unplanned : value.scenes).slice(0, batchLimit)
          const selected = batch.map(scene => scene.id)
          setSceneIds(selected); setFocusedSceneId(selected[0] || ''); setView(batch.every(planned) ? 'preview' : 'setup'); initialized.current = true
        }
      })
      .catch(issue => { if (turn === serial.current && !abort.signal.aborted) setError(planningError(issue)) })
      .finally(() => { if (turn === serial.current) setPending(null) })
    return () => abort.abort()
  }, [opened, detail.id, rangeKey, refreshKey])
  const sceneSelectionKey = sceneIds.join(',')
  useEffect(() => {
    if (!context) return
    const defaults = new Set(episodeDocumentIds(context, sceneIds))
    const ids = context.documents.filter(document => documentChoices.current.get(document.id) ?? defaults.has(document.id)).map(document => document.id)
    setDocumentIds(current => current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids)
  }, [context, sceneSelectionKey])
  useEffect(() => {
    if (pending !== 'plan') return
    const started = Date.now(); setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  useEffect(() => {
    if (!opened || !planningOnly || !result || applied.current) return
    const guardUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guardUnload)
    return () => window.removeEventListener('beforeunload', guardUnload)
  }, [opened, planningOnly, result, pending])
  const selected = context?.scenes.filter(scene => sceneIds.includes(scene.id)) || []
  const savedScenes = context?.scenes.filter(planned) || []
  const unplannedScenes = context?.scenes.filter(scene => !planned(scene)) || []
  const pendingPlanningScenes = selected.filter(scene => replanExisting || !planned(scene))
  const requiresRedesign = selected.some(scene => scene.requires_redesign)
  const canChoosePlanningMode = selected.some(hasPreviousPlan)
  const canReuseSavedPlan = selected.some(planned)
  const effectivePlanningMode = requiresRedesign ? 'redesign' : canChoosePlanningMode && pendingPlanningScenes.length > 0 ? planningMode : 'update'
  const planningScenes = effectivePlanningMode === 'redesign' ? selected : pendingPlanningScenes
  const recovery = useCanvasPreparationRecovery({ projectId: detail.id, sceneIds, refreshKey: JSON.stringify([modelId, context?.signature, detail.shots.filter(shot => sceneIds.includes(shot.source_scene_id || ''))]), paused: !!pending && pending !== 'references', watching: pending === 'references', active: opened && !planningOnly && !!context && selected.length > 0 && selected.every(planned) })
  const recoveryView = referenceRecoveryView({ signature: '', scene_ids: sceneIds, profiles: referenceCompleted, ...recovery.plan, failed_units: referenceFailures }, recovery.capabilities, modelId, recovery.snapshot?.signature)
  useEffect(() => {
    if (recovery.plan) { setReferenceFailures(recovery.plan.failed_units || []); setReferenceCompleted(recovery.plan.profiles) }
    else if (recovery.capabilities?.adoption?.source_matches === false) { setReferenceFailures([]); setReferenceCompleted([]) }
    if (recovery.capabilities && (recovery.capabilities.can_retry_failed || recovery.capabilities.can_continue || recovery.capabilities.state === 'complete')) {
      setReferenceBlockedKey('')
      setError(current => current?.message.startsWith('上次参考设定请求的结果尚未确认') ? null : current)
    }
  }, [recovery.snapshot])
  const reusingSavedPlan = canReuseSavedPlan && !requiresRedesign && !replanExisting && (planningMode === 'update' || !planningScenes.length)
  const staleScenes = selected.filter(scene => scene.needs_replan)
  const reusedScenes = selected.filter(scene => !planningScenes.some(item => item.id === scene.id))
  const planningIds = planningScenes.map(scene => scene.id)
  const hasPreview = !!result || selected.length > 0 && !planningScenes.length
  const total = planningScenes.reduce((sum, scene) => sum + scene.duration, 0)
  const minimum = planningScenes.reduce((sum, scene) => sum + (effectivePlanningMode === 'redesign' ? 1 : Math.max(1, scene.shot_count)), 0) || 1
  const invalidTarget = durationChoice === 'fixed' && (!Number.isInteger(Number(target)) || Number(target) < minimum || Number(target) > maxScriptSceneDuration)
  const automaticShotCount = String(shotsPerScene).trim() === ''
  const invalidShotCount = !automaticShotCount && (!Number.isInteger(Number(shotsPerScene)) || Number(shotsPerScene) < 2 || Number(shotsPerScene) > 8)
  const awaitingReview = result?.directing_review?.status === 'pending_review'
  const reviewStatus = result?.directing_review?.status
  const reviewDeliveryPending = ['structured_initial_delivery_pending', 'storyboard_review_timeout'].includes(result?.directing_review?.error?.code || '')
  const needsManualReview = reviewStatus === 'review_inconclusive_needs_user' || reviewStatus === 'inconclusive'
  const saveableReview = ['passed', 'warnings', 'review_inconclusive_no_action', 'review_inconclusive_needs_user', 'inconclusive'].includes(reviewStatus || '')
  const issue = result && !applied.current && resultModelId !== modelId ? '文本模型已切换，当前分镜预览仍保留，请重新规划后保存。'
    : result ? planIssue(result) || (!applied.current && !awaitingReview && (!result.directing_review?.review_id || !saveableReview) ?
      reviewStatus === 'needs_work' ? '复核发现待修复问题，请先修复并复查当前草稿。' : '当前草稿尚未完成复核，请先复查后保存。' : '') : ''
  const previewScenes = selected.map(scene => result?.scenes.find(item => item.scene_id === scene.id) || {
    scene_id: scene.id, scene_heading: scene.heading, scene_duration: scene.duration,
    shots: (context?.existing_shots || []).filter(shot => shot.scene_id === scene.id),
  })
  const focusedScene = previewScenes.find(scene => scene.scene_id === focusedSceneId) || previewScenes[0]
  const planIsSaved = !!applied.current
  const focusedHasResult = !!result?.scenes.some(scene => scene.scene_id === focusedScene?.scene_id)
  const focusedIsDraft = focusedHasResult && !planIsSaved
  const previewCount = previewScenes.reduce((sum, scene) => sum + scene.shots.length, 0)
  const retainedOutline = !result && !applied.current ? planningTask?.outline_checkpoint : undefined
  const focusedOutline = retainedOutline?.scenes.find(scene => scene.scene_id === focusedScene?.scene_id)
  const retainedCount = retainedOutline?.scenes.reduce((sum, scene) => sum + scene.shot_count, 0) || 0
  const skillPolicy: SkillPolicy | null = context ? context.skill_policy || {
    stage: 'storyboard', label: '分镜规划', primary_id: context.default_skill_ids?.[0] || null,
    auxiliary_ids: context.default_skill_ids?.slice(1) || [], source: 'global', warning: '', skills: context.skills,
  } : null
  const skillAssignment = { task_kind: 'storyboard' as const, ...(skillManual ? { ids: manualSkillIds, source: 'manual' as const, reason: '沿用你为本次分镜规划选择的技能。', task_label: '手动选择' }
    : { ids: skillPolicy?.primary_id ? [skillPolicy.primary_id, ...skillPolicy.auxiliary_ids] : [], source: 'default' as const, task_label: '分镜规划 · 按功能分配', reason: '按分镜规划功能使用固定主技能与辅助技能，可以手动更换。' }) }
  const skillIds = skillAssignment.ids
  const primarySkill = skillPolicy?.skills.find(skill => skill.id === skillIds[0])
  const auxiliarySkills = skillIds.slice(1).map(id => skillPolicy?.skills.find(skill => skill.id === id)?.name || '技能需重新选择')
  const skillSource = skillManual ? '手动选择' : '按功能分配'
  const referencePolicy = context?.reference_preparation?.skill_policy
  const referenceIds = referenceManual ? referenceSkillIds : referencePolicy?.primary_id ? [referencePolicy.primary_id, ...referencePolicy.auxiliary_ids] : []
  const referenceInputKey = JSON.stringify({ project: detail.id, signature: context?.signature, referenceSignature: context?.reference_preparation?.signature, scenes: sceneIds, model: modelId,
    skills: referenceManual ? referenceSkillIds : null, policy: referencePolicy })
  const referenceBlocked = referenceBlockedKey === referenceInputKey
  useEffect(() => {
    if (recovery.capabilities && !['unknown', 'running'].includes(recovery.capabilities.state)) setReferenceBlockedKey('')
  }, [recovery.snapshot])
  const referenceAssignment = { task_kind: 'visual_assets' as const, ids: referenceIds, ...(referenceManual ? { source: 'manual' as const, task_label: '手动选择', reason: '沿用你为本次参考设定整理选择的技能。' }
    : { source: 'default' as const, task_label: '视觉设定整理 · 按功能分配', reason: '按视觉设定整理功能使用固定主技能与辅助技能，可以手动更换。' }) }
  const referencePrimary = referencePolicy?.skills.find(skill => skill.id === referenceIds[0])
  const referenceNeedsAnalysis = selected.filter(scene => context?.reference_preparation?.needs_analysis.includes(scene.id))
  async function reloadReferencePolicy() {
    const turn = serial.current
    setReferenceReloading(true)
    try {
      const defaults = await api<{ policies: SkillPolicy[] }>(`/projects/${detail.id}/skills/defaults`)
      if (turn !== serial.current) return
      const policy = defaults.policies.find(policy => policy.stage === 'visual_assets')
      if (!policy) throw new Error('参考设定技能配置未读取，请重试')
      const ids = policy.primary_id ? [policy.primary_id, ...policy.auxiliary_ids] : []
      setReferenceSkillIds(ids)
      setReferenceManual(false)
      setContext(current => current?.reference_preparation ? { ...current, reference_preparation: {
        ...current.reference_preparation, skill_policy: policy, default_skill_ids: ids,
      } } : current)
    } catch (issue) { if (turn === serial.current) setError(planningError(issue)) }
    finally { if (turn === serial.current) setReferenceReloading(false) }
  }
  async function confirmDiscard() {
    if (!planningOnly || !result || applied.current) return true
    if (guardLock.current) return false
    const turn = serial.current, projectId = detail.id
    guardLock.current = true; setGuarding(true)
    const confirmed = await dialog.confirm({ title: '放弃未保存的分镜草稿？', message: '当前分镜规划和手动修改尚未保存，继续后将丢失。', confirmLabel: '放弃草稿', cancelLabel: '继续编辑', danger: true })
    guardLock.current = false
    if (!live.current.opened || live.current.projectId !== projectId || turn !== serial.current) return false
    setGuarding(false)
    return confirmed
  }
  async function changeSettings(change: () => void) {
    if (pending) return
    const turn = serial.current
    if (!await confirmDiscard()) {
      if (live.current.opened && live.current.projectId === detail.id && turn === serial.current) setSettingsRevision(value => value + 1)
      return
    }
    change(); resetDraft()
  }
  async function requestClose() {
    if (pending === 'references') {
      // Detach without aborting the accepted reference request.
      serial.current++; controller.current = null; onClose(); return
    }
    if ((pending === 'plan' || pending === 'preview') && context?.planning_task_version === 1) {
      // Only detach this page. Server-owned work and its validated draft continue.
      serial.current++; controller.current?.abort(); onClose(); return
    }
    if (pending && pending !== 'context' || !await confirmDiscard()) return
    serial.current++; controller.current?.abort(); onClose()
  }
  function resetDraft() {
    setResult(null); setResultModelId(''); setError(null); setPlanningTask(null); setTaskConnection(''); setReferenceFailures([]); setReferenceCompleted([])
    setCancelUnconfirmed(false)
    taskRef.current = null; taskInputRef.current = null; cancelRequested.current = false
    applied.current = null; prepared.current = null; imported.current = null
  }
  function validateTaskResult(value: PlanningResult, input: PlanningTaskInput) {
    if ((value.target_video_model_id || '') !== (input.target_video_model_id || '')) throw new Error('返回的目标视频模型不匹配，请重新规划')
    if (value.mode && value.mode !== input.mode) throw new Error('返回的分镜方案方式不匹配，请重新规划')
    if ((value.duration_mode || 'preserve') !== (input.duration_mode || 'preserve')) throw new Error('返回的时长方式不匹配，请重新规划')
    const ids = value.scenes.map(scene => scene.scene_id)
    if (ids.length !== input.scene_ids.length || new Set(ids).size !== ids.length || ids.some(id => !input.scene_ids.includes(id))) throw new Error('返回的分镜场次不匹配，请刷新规划资料')
    if (input.mode === 'redesign' && value.scenes.some(scene => scene.shots.some(shot => !!shot.shot_id))) throw new Error('新方案包含旧镜头，请重新规划')
  }
  function receiveTask(task: StoryboardPlanningTask, input: PlanningTaskInput, turn: number, abort: AbortController) {
    if (turn !== serial.current || abort.signal.aborted || !live.current.opened || live.current.projectId !== detail.id) return
    if (task.project_id !== detail.id) throw new Error('分镜任务不属于当前项目')
    taskRef.current = task; taskInputRef.current = input; setPlanningTask(task); setTaskObservedAt(Date.now())
    const value = (task.result || task.candidate) as PlanningResult | undefined
    if (value) {
      validateTaskResult(value, input)
      setResultModelId(input.model_id); setResult(value); setView('preview')
      setFocusedSceneId(current => value.scenes.some(scene => scene.scene_id === current) ? current : value.scenes[0]?.scene_id || '')
    }
    if (task.status !== 'running') setTaskConnection('')
    if (task.status === 'succeeded') { requestId.current = crypto.randomUUID(); setError(null) }
    else if (task.status === 'running') setError(null)
    else setError({ message: planningTaskFailure(task, sceneLabel), raw_output: task.error?.raw_output, diagnostics: [task.error?.diagnostics, planningTaskFailureDetails(task)].filter(Boolean).join('\n\n') })
  }
  async function followTask(task: StoryboardPlanningTask, input: PlanningTaskInput, turn: number, abort: AbortController) {
    if (turn !== serial.current || abort.signal.aborted) return task
    taskInputRef.current = input
    rememberObservedPlanningTask(detail.id, input, task.id)
    if (cancelRequested.current && task.status === 'running') task = await cancelPlanningTask(detail.id, task.id)
    return observePlanningTask(detail.id, task, { signal: abort.signal,
      onUpdate: snapshot => receiveTask(snapshot, input, turn, abort),
      onConnectionChange: message => { if (turn === serial.current && !abort.signal.aborted) setTaskConnection(message) },
    })
  }
  // Reopening a page only observes remembered work. Paid continuation always needs an explicit action.
  useEffect(() => {
    if (!opened || !contextReady.current || !context || pending || !modelId || restoreAttempted.current || context.planning_task_version !== 1) return
    restoreAttempted.current = true
    const saved = rememberedPlanningTask(detail.id)
    if (!saved || saved.input.model_id !== modelId || !saved.input.scene_ids.length
      || saved.input.scene_ids.some(id => !rangeIds.includes(id))) return
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    setPending('preview')
    void (async () => {
      try {
        const scope = context.scenes.length === saved.input.scene_ids.length && context.scenes.every(scene => saved.input.scene_ids.includes(scene.id)) ? context
          : await api<StoryboardPlanningContext>(`/projects/${detail.id}/script/storyboard/context`, { ...json('POST', { scene_ids: saved.input.scene_ids }), signal: abort.signal })
        if (turn !== serial.current || abort.signal.aborted) return
        if (scope.signature !== saved.input.signature) { forgetPlanningTask(detail.id); return }
        setSceneIds(saved.input.scene_ids); setDocumentIds(saved.input.document_ids)
        documentChoices.current = new Map(scope.documents.map(document => [document.id, saved.input.document_ids.includes(document.id)]))
        setInstructions(saved.input.instructions); setPlanningMode(saved.input.mode)
        setReplanExisting(true); setShotsPerScene(saved.input.shots_per_scene ?? '')
        setDurationChoice(saved.input.duration_mode === 'reestimate' ? 'reestimate' : saved.input.target_duration !== undefined ? 'fixed' : 'preserve')
        if (saved.input.target_duration !== undefined) setTarget(saved.input.target_duration)
        setTargetVideoModelId(saved.input.target_video_model_id || '')
        setSkillManual(saved.input.skill_ids !== undefined)
        if (saved.input.skill_ids) setSkillIds(saved.input.skill_ids)
        const task = await api<StoryboardPlanningTask>(`/projects/${detail.id}/script/storyboard/tasks/${encodeURIComponent(saved.task_id || saved.request_id)}`, { signal: abort.signal })
        if (turn !== serial.current || abort.signal.aborted) return
        if (task.status === 'running') setPending('plan')
        await followTask(task, saved.input, turn, abort)
      } catch (issue) {
        if (turn === serial.current && !abort.signal.aborted) {
          const status = (issue as ApiError).status
          if (status === 409 || (status === 404 && saved.task_id)) forgetPlanningTask(detail.id)
          setError(status === 404 && !saved.task_id
            ? { message: '启动结果尚未确认。点击“开始规划”将继续查询这次请求，不会重复启动。' }
            : planningError(issue))
        }
      } finally { if (turn === serial.current && !abort.signal.aborted) setPending(null) }
    })()
    // Page lifecycle cleanup is handled by the shared controller; dependencies must not cancel the job.
  }, [opened, detail.id, context, modelId, pending])
  async function chooseScene(id: string, checked: boolean) {
    if (!await confirmDiscard()) return
    const next = toggle(sceneIds, id, checked)
    resetDraft(); setSceneIds(next); setDurationChoice('preserve'); setPlanningMode('redesign'); setFocusedSceneId(checked ? id : next[0] || '')
    setView(!replanExisting && next.length && next.every(id => context?.scenes.some(scene => scene.id === id && planned(scene))) ? 'preview' : 'setup')
  }
  async function chooseBatch(scenes: StoryboardPlanningContext['scenes']) {
    if (!await confirmDiscard()) return
    const batch = scenes.slice(0, batchLimit), ids = batch.map(scene => scene.id)
    resetDraft(); setSceneIds(ids); setDurationChoice('preserve'); setReplanExisting(false); setPlanningMode('redesign'); setFocusedSceneId(ids[0] || '')
    setView(batch.length && batch.every(planned) ? 'preview' : 'setup')
  }
  async function startPlanning(fresh = false) {
    if (!context || pending || !planningIds.length || invalidTarget || invalidShotCount || !eligibleModels.some(model => model.id === modelId)) return
    if (!await confirmDiscard()) return
    const restart = fresh || !!result
    const recoverPreview = !fresh && !result
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    restoreAttempted.current = true; setCancellingTask(false)
    setPending(recoverPreview ? 'preview' : 'plan'); resetDraft()
    try {
      const sameScope = context.scenes.length === planningIds.length && context.scenes.every(scene => planningIds.includes(scene.id))
      const scope = sameScope ? context : await api<StoryboardPlanningContext>(`/projects/${detail.id}/script/storyboard/context`, { ...json('POST', { scene_ids: planningIds }), signal: abort.signal })
      if (turn !== serial.current) return
      const input: PlanningTaskInput = {
        signature: scope.signature, scene_ids: planningIds, document_ids: documentIds, ...(skillManual ? { skill_ids: skillIds } : {}), model_id: modelId, mode: effectivePlanningMode,
        ...reasoning.request,
        ...(!automaticShotCount ? { shots_per_scene: Number(shotsPerScene) } : {}), ...(durationChoice === 'fixed' ? { target_duration: Number(target) } : {}),
        ...(durationChoice === 'reestimate' ? { duration_mode: 'reestimate' } : {}), instructions,
        ...(targetVideoModelId ? { target_video_model_id: targetVideoModelId } : {}),
      }
      taskInputRef.current = input
      let existingTask: StoryboardPlanningTask | null = null
      const remembered = !fresh && scope.planning_task_version === 1 ? rememberedPlanningTask(detail.id, input) : null
      if (!fresh && scope.planning_task_version === 1) {
        if (remembered) {
          try {
            existingTask = await api<StoryboardPlanningTask>(`/projects/${detail.id}/script/storyboard/tasks/${encodeURIComponent(remembered.task_id || remembered.request_id)}`, { signal: abort.signal })
          } catch (issue) { if ((issue as ApiError).status !== 404) throw issue }
        } else existingTask = (await lookupPlanningTask(detail.id, input, abort.signal)).task
        if (turn !== serial.current || abort.signal.aborted) return
      }
      let restored: PlanningResult | null = null
      if (recoverPreview && !existingTask && !remembered) {
        const cached = await api<{ preview: PlanningResult | null }>(`/projects/${detail.id}/script/storyboard/preview`, { ...json('POST', input), signal: abort.signal })
        if (turn !== serial.current || abort.signal.aborted) return
        restored = cached.preview
      }
      if (!restored) setPending('plan')
      let value: PlanningResult
      if (restored) value = restored
      else if (scope.planning_task_version === 1) {
        const task = existingTask || await startPlanningTask(detail.id, input, fresh, abort.signal)
        const completed = await followTask(task, input, turn, abort)
        if (completed.status !== 'succeeded' || !completed.result) return
        value = completed.result as PlanningResult
      } else value = await api<PlanningResult>(`/projects/${detail.id}/script/storyboard/plan`, { ...json('POST', { ...input, restart }), signal: abort.signal })
      if (turn !== serial.current) return
      if ((value.target_video_model_id || '') !== targetVideoModelId) throw new Error('返回的目标视频模型不匹配，请重新规划')
      if (value.mode && value.mode !== effectivePlanningMode) throw new Error('返回的分镜方案方式不匹配，请重新规划')
      if ((value.duration_mode || 'preserve') !== (durationChoice === 'reestimate' ? 'reestimate' : 'preserve')) throw new Error('返回的时长方式不匹配，请重新规划')
      if (effectivePlanningMode === 'redesign' && value.scenes.some(scene => scene.shots.some(shot => !!shot.shot_id))) throw new Error('新方案包含旧镜头，请重新规划')
      requestId.current = crypto.randomUUID(); setResultModelId(modelId); setResult({ ...value, mode: value.mode || effectivePlanningMode, duration_mode: value.duration_mode || 'preserve', instructions: value.instructions ?? instructions }); setFocusedSceneId(value.scenes[0]?.scene_id || ''); setView('preview')
      if (restored) onNotice('已恢复上次完成的分镜预览，可继续修改和保存')
    } catch (issue) {
      if (turn === serial.current && !abort.signal.aborted) {
        if ((issue as ApiError).status === 409) forgetPlanningTask(detail.id)
        setError(planningError(issue, cancelRequested.current ? '取消尚未确认，后台可能仍在处理。请重试取消：' : ''))
      }
    }
    finally { if (turn === serial.current) { setPending(null); setCancellingTask(false) } }
  }
  async function continuePlanning() {
    const task = taskRef.current, input = taskInputRef.current
    if (!task?.can_resume || !input || pending || guarding || modelId !== input.model_id) return
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    cancelRequested.current = false; setCancellingTask(false); setPending('plan'); setError(null); setTaskConnection('')
    try {
      const resumed = await resumePlanningTask(detail.id, task.id, abort.signal)
      if (turn !== serial.current || abort.signal.aborted) return
      await followTask(resumed, input, turn, abort)
    } catch (issue) { if (turn === serial.current && !abort.signal.aborted) setError(planningError(issue)) }
    finally { if (turn === serial.current && !abort.signal.aborted) setPending(null) }
  }
  function updateShot(sceneId: string, index: number, values: Partial<StoryboardShotDraft>) {
    if (applied.current) return
    editResult(current => ({ ...current, scenes: current.scenes.map(scene => scene.scene_id !== sceneId ? scene : { ...scene, shots: scene.shots.map((shot, i) => i === index ? { ...shot, ...values,
      ...(shot.continuity_plan ? { continuity_plan: { ...shot.continuity_plan, status: 'edited' as const } } : {}) } : shot) }) }))
  }
  function editResult(edit: (current: PlanningResult) => PlanningResult) {
    setPlanningTask(current => current && { ...current, can_resume: false })
    setResult(current => current && { ...edit(current), directing_review: current.directing_review
      ? { ...current.directing_review, status: 'edited', review_id: undefined, error: undefined } : undefined })
  }
  async function reviewDraft(repair = false) {
    if (!result || pending || reviewLock.current || guarding || applied.current || result.directing_review?.status === 'pending_review' || planIssue(result)) return
    reviewLock.current = true
    const candidate = result, turn = ++serial.current
    let abort: AbortController | undefined
    try {
      if (!repair && reviewDeliveryPending) {
        const confirmed = await dialog.confirm({ title: '发起新的导演复核？', message: '上次请求结果尚未确认。新的复核会再次调用模型，可能产生额外用量。',
          confirmLabel: '发起新复核', cancelLabel: '返回草稿' })
        if (!confirmed || turn !== serial.current || !live.current.opened || live.current.projectId !== detail.id) return
      }
      abort = new AbortController(); controller.current = abort
      setPending(repair ? 'repair' : 'review'); setError(null)
      const response = await api<NonNullable<PlanningResult['directing_review']> | Pick<PlanningResult, 'scenes' | 'directing_review'>>(`/projects/${detail.id}/script/storyboard/${repair ? 'repair' : 'review'}`, { ...json('POST', {
        ...(repair ? { review_id: candidate.directing_review?.review_id } : {}),
        signature: candidate.signature, model_id: modelId, mode: candidate.mode || 'update', instructions: candidate.instructions || '',
        ...((candidate.text_generation_options ?? taskInputRef.current?.text_generation_options) ? { text_generation_options: candidate.text_generation_options ?? taskInputRef.current?.text_generation_options } : {}),
        ...(candidate.duration_mode ? { duration_mode: candidate.duration_mode } : {}),
        document_ids: documentIds, ...(candidate.target_video_model_id ? { target_video_model_id: candidate.target_video_model_id } : {}),
        scenes: candidate.scenes.map(({ scene_id, scene_duration, shots }) => ({ scene_id, scene_duration, shots })),
      }), signal: abort.signal })
      if (turn === serial.current && !abort.signal.aborted) {
        setResult(current => current === candidate ? { ...current, ...('scenes' in response ? response : { directing_review: response }) } : current)
        setPlanningTask(current => current && { ...current, can_resume: false })
      }
    } catch (issue) { if (turn === serial.current && !abort?.signal.aborted) setError(planningError(issue)) }
    finally { reviewLock.current = false; if (turn === serial.current) setPending(null) }
  }
  async function commitPlan(abort: AbortController, active: () => boolean, saveOnly = false) {
    if (!result || applied.current) return applied.current
    const saved = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/storyboard/commit`, { ...json('POST', {
      signature: result.signature, request_id: requestId.current, review_id: result.directing_review?.review_id, mode: result.mode || 'update', instructions: result.instructions || '',
      ...(result.duration_mode ? { duration_mode: result.duration_mode } : {}),
      ...(saveOnly ? { save_only: true } : {}),
      ...(result.target_video_model_id ? { target_video_model_id: result.target_video_model_id } : {}),
      scenes: result.scenes.map(({ scene_id, scene_duration, shots }) => ({ scene_id, scene_duration, shots })),
    }), signal: abort.signal })
    if (!active()) return null
    applied.current = saved
    return saved
  }
  async function savePlan() {
    if (!context || pending || guarding || issue || !result && !applied.current) return
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    const active = () => turn === serial.current && !abort.signal.aborted && live.current.opened && live.current.projectId === detail.id
    setPending('save'); setSaveLabel('正在保存分镜方案'); setError(null)
    try {
      const saved = await commitPlan(abort, active, true)
      if (!saved || !active()) return
      await onRefresh()
      if (!active()) return
      await onSaved?.(saved)
      if (!active()) return
      onNotice('分镜方案已保存'); onClose()
    } catch (issue) { if (active()) setError(planningError(issue, applied.current ? '分镜方案已保存，刷新失败，可重试：' : '')) }
    finally { if (active()) setPending(null) }
  }
  async function addToCanvas(action: ReferenceAction = 'continue') {
    if (canvasLock.current || !context || pending || referenceReloading || recovery.loading || recovery.restoreError || !sceneIds.length || (result ? !!issue : !!planningScenes.length)) return
    const restarting = action === 'restart' || action === 'abandon' || action === 'prepare-current'
    if (!restarting && (referenceBlocked || recoveryView.blocked)) return
    const requestedKeys = typeof action === 'object' ? [action.unit_key] : restarting || action === 'adopt' ? []
      : recoveryView.retries.length ? recoveryView.retries.map(retry => retry.unit_key) : recoveryView.pending
    if (referenceFailures.length && !requestedKeys.length && !restarting && action !== 'adopt') return
    if (typeof action === 'object' && !recoveryView.retries.some(retry => retry.token === action.token && retry.unit_key === action.unit_key)) return
    canvasLock.current = true
    const turn = ++serial.current, abort = new AbortController(); controller.current = abort
    const active = () => turn === serial.current && !abort.signal.aborted
    setPending('save'); setSaveLabel('正在保存分镜'); setError(null)
    let referenceRequestActive = false, referenceRequestId: string | undefined
    try {
      if (!restarting && action !== 'adopt') await commitPlan(abort, active)
      if (!active()) return
      if (!imported.current) {
        // Saving the plan changes its source version. Always check references
        // afterwards and use the fresh preparation signature.
        setSaveLabel('正在检查参考设定')
        const check = await api<ScriptCanvasCheck>(`/projects/${detail.id}/script/canvas/check`, { ...json('POST', { scene_ids: sceneIds }), signal: abort.signal })
        if (!active()) return
        if (check.needs_analysis.length || restarting || recovery.capabilities?.full_scope && !prepared.current) {
          setPending('references')
          let plan: (ScriptCanvasPlan & { skill_assignment?: SkillAssignment }) | undefined = !restarting && typeof action !== 'object'
            && recovery.capabilities?.state === 'complete' && recovery.plan?.signature === check.signature
            && recovery.plan.status !== 'partial' && !recovery.plan.failed_units?.length ? recovery.plan : undefined
          if (action === 'adopt') {
            plan = await recovery.adoptionPlan(check.signature, abort.signal)
            if (!active()) return
          }
          if (!plan) {
            if (action === 'adopt') throw new Error('待采用结果已变化，请刷新恢复状态后核对；未重新调用模型。')
            if (!eligibleModels.some(model => model.id === modelId)) throw new Error('请选择文本模型，先整理分镜所需的人物、场景与道具设定，再加入画布。')
            const options = { ...reasoning.request, ...(referenceManual ? { skill_ids: referenceSkillIds } : {}) }
            const body = action === 'prepare-current' ? await recovery.currentScopeBody(check.signature, modelId, abort.signal, options) : recovery.actionBody(action, check.signature, modelId, options)
            referenceRequestActive = true
            referenceRequestId = body.request_id
            acceptedReference.current = abort
            plan = await api<ScriptCanvasPlan & { skill_assignment?: SkillAssignment }>(`/projects/${detail.id}/script/canvas/prepare`, { ...json('POST', body), signal: abort.signal })
            if (!active()) return
            recovery.received(body.request_id); recovery.accept(plan)
          }
          if (!active()) return
          referenceRequestActive = false
          setReferenceCompleted(plan.profiles)
          if (plan.status === 'partial' || plan.failed_units?.length) {
            setReferenceFailures(plan.failed_units || [])
            setError(null)
            return
          }
          setReferenceFailures([])
          setReferenceUsed({ skills: plan.used_skills?.map(skill => skill.name) || [], assignment: plan.skill_assignment })
          setPending('save'); setSaveLabel('正在保存参考设定')
          const references = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/canvas/commit`, { ...json('POST', {
            scene_ids: plan.scene_ids, signature: plan.signature, profiles: plan.profiles, reference_usage_version: plan.reference_usage_version,
            ...(plan.preparation ? { run_id: plan.preparation.run_id } : {}),
            coverage_version: plan.coverage_version, visual_coverage: plan.visual_coverage,
          }), signal: abort.signal })
          if (!active()) return
          prepared.current = references
        }
        setSaveLabel('正在加入画布')
        const canvas = await api<ScriptCanvasResult>(`/projects/${detail.id}/script/storyboard/canvas`, { ...json('POST', { scene_ids: sceneIds, mode: 'existing' }), signal: abort.signal })
        if (!active()) return
        imported.current = canvas
      }
      await onRefresh()
      if (!active()) return
      const canvas = { ...imported.current,
        design_id: applied.current?.design_id ?? imported.current.design_id,
        target_canvas_id: applied.current?.target_canvas_id || imported.current.target_canvas_id,
        created_shots: imported.current.created_shots + (applied.current?.created_shots || 0) + (prepared.current?.created_shots || 0),
        created_profiles: imported.current.created_profiles + (applied.current?.created_profiles || 0) + (prepared.current?.created_profiles || 0),
        updated_shot_ids: [...new Set([...(imported.current.updated_shot_ids || []), ...(applied.current?.updated_shot_ids || [])])],
      }
      const missing = canvas.shot_visual_bindings.some(binding => binding.usage !== 'none' && binding.required && !binding.board_asset_id && !binding.reference_assets?.length)
      requestScriptCanvas(detail.id, detail.ratio, canvas); onOpenCanvas(); onNotice(missing ? '分镜与参考设定已加入画布，请先生成并确认必需信息图' : '分镜与参考设定已加入画布'); onClose()
    } catch (issue) {
      if (active()) {
        const failure = planningError(issue)
        if (referenceRequestActive && isUncertainReferenceRequest(issue)) {
          recovery.markUnknown(requestedKeys)
          setReferenceBlockedKey(referenceInputKey)
          setReferenceFailures(units => uncertainReferenceUnits(units, requestedKeys))
          setError({ ...failure, message: '上次参考设定请求的结果尚未确认，已停止自动重发。请先核对请求记录，再恢复。' })
          return
        }
        if (referenceRequestActive && referenceRequestId) {
          recovery.received(referenceRequestId)
          const snapshot = await recovery.reload(abort.signal)
          if (!active()) return
          if (snapshot?.preparation?.state === 'failed' && snapshot.preparation.can_continue) { setError(null); return }
        }
        if (blockedVisualHistory(failure)) {
          setReferenceBlockedKey(referenceInputKey)
          setError({ ...failure, message: (applied.current ? '分镜已保存。' : '') + failure.message })
        } else setError(planningError(issue, applied.current ? '分镜已保存，后续操作失败，可重试：' : ''))
      }
    }
    finally {
      if (acceptedReference.current === abort) acceptedReference.current = null
      canvasLock.current = false; if (active()) setPending(null)
    }
  }
  async function cancelPlanning() {
    if ((pending === 'plan' || cancelUnconfirmed) && context?.planning_task_version === 1) {
      cancelRequested.current = true; setCancellingTask(true)
      const task = taskRef.current, input = taskInputRef.current
      if (!input) { serial.current++; controller.current?.abort(); setPending(null); setCancellingTask(false); return }
      const turn = serial.current
      try {
        const cancelled = task ? await cancelPlanningTask(detail.id, task.id) : (await cancelPlanningRequest(detail.id, input)).task
        if (turn !== serial.current || !controller.current || controller.current.signal.aborted) return
        setCancelUnconfirmed(false)
        if (cancelled) receiveTask(cancelled, input, turn, controller.current)
        else { forgetPlanningTask(detail.id); setError({ message: '本次规划已取消。' }) }
        if (!cancelled || cancelled.status !== 'running') { controller.current.abort(); setPending(null) }
      } catch (issue) {
        if (turn === serial.current) { setCancelUnconfirmed(true); setError(planningError(issue, '取消尚未确认，后台可能仍在处理。请重试取消：')) }
      } finally { if (turn === serial.current) setCancellingTask(false) }
      return
    }
    serial.current++; controller.current?.abort(); setPending(null)
  }
  const locked = !!pending || !!applied.current || guarding
  const taskTick = planningTask?.status === 'running' && pending === 'plan' ? Math.max(0, Date.now() - taskObservedAt) : 0
  const taskSeconds = planningTask ? Math.floor((planningTask.active_duration_ms + taskTick) / 1000) : 0
  const taskLabel = planningTask ? cancellingTask ? '正在取消规划' : planningTask.status === 'running' ? planningTaskStageLabel[planningTask.stage]
    : planningTask.status === 'succeeded' ? '分镜规划已完成' : planningTask.status === 'cancelled' ? '规划已取消' : '规划已暂停' : ''
  const sceneLabel = (id: string) => context?.scenes.find(scene => scene.id === id)?.heading || detail.script.scenes.find(scene => scene.id === id)?.heading || '所选场次'
  const referenceActivity = !planningOnly && hasPreview && pending ? pending === 'references' ? '正在整理参考' : pending === 'save' ? saveLabel : undefined : undefined
  const referenceWorking = referenceIsWorking(recovery.capabilities, referenceActivity)
  const backgroundPlanning = (pending === 'plan' || pending === 'preview') && context?.planning_task_version === 1
  const closeDisabled = guarding || !!pending && pending !== 'context' && pending !== 'references' && !backgroundPlanning
  const currentStep = pending === 'save' || pending === 'references' || planIsSaved ? 4
    : pending === 'plan' || pending === 'preview' ? 2
    : view === 'preview' ? 3 : sceneIds.length && !selectingScenes ? 2 : 1
  const selectedPlanningMode = reusingSavedPlan ? 'existing' : effectivePlanningMode
  const planningModes = [
    { value: 'redesign', label: '重新设计新方案', description: '从所选场次生成一套新分镜。' },
    { value: 'update', label: '沿用当前方案更新', description: '在当前方案中调整镜头。', disabled: requiresRedesign },
    ...(canReuseSavedPlan ? [{ value: 'existing', label: '复用已保存分镜', description: '保留已保存的镜头。', disabled: requiresRedesign }] : []),
  ]
  function changePlanningMode(value: string | null) {
    void changeSettings(() => {
      if (value === 'existing') { setReplanExisting(false); setPlanningMode('update') }
      else if (value === 'redesign' || value === 'update') { setPlanningMode(value); setReplanExisting(true) }
      else return
      setDurationChoice('preserve')
    })
  }
  return <><Modal opened={opened} fullScreen={isPage} onClose={() => void requestClose()} title={planningOnly ? '规划分镜' : '加入画布'} centered radius={isPage ? 0 : 18} size="min(940px, calc(100vw - 32px))" zIndex={240}
    classNames={{ content: `storyboard-planner${isPage ? ' storyboard-planner-page' : ''}`, header: 'storyboard-planner-header', body: 'storyboard-planner-body', close: 'storyboard-planner-close' }}
    closeButtonProps={{ disabled: closeDisabled, 'aria-label': '关闭分镜规划' }} closeOnClickOutside={!pending} closeOnEscape={!pending}>
    {isPage && <header className="storyboard-planner-page-header">
      <div><Button type="button" variant="subtle" leftSection={<ArrowLeft size={15} />} disabled={closeDisabled} onClick={() => void requestClose()} data-workspace-control="">{returnLabel}</Button><span aria-hidden="true">/</span><strong>规划分镜</strong></div>
      <nav aria-label="分镜规划步骤">
        <UnstyledButton type="button" aria-current={currentStep === 1 ? 'step' : undefined} disabled={locked || !rangeIds.length} onClick={() => { setSelectingScenes(true); setView('setup'); scenePicker.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus() }}><b>01</b>选择内容</UnstyledButton><ChevronRight size={13} aria-hidden="true" />
        <UnstyledButton type="button" aria-current={currentStep === 2 ? 'step' : undefined} disabled={locked || !sceneIds.length} onClick={() => { setSelectingScenes(false); setView('setup') }}><b>02</b>生成计划</UnstyledButton><ChevronRight size={13} aria-hidden="true" />
        <UnstyledButton type="button" aria-current={currentStep === 3 ? 'step' : undefined} disabled={locked || !hasPreview} onClick={() => setView('preview')}><b>03</b>预览确认</UnstyledButton><ChevronRight size={13} aria-hidden="true" />
        <span aria-current={currentStep === 4 ? 'step' : undefined}><b>04</b>{planningOnly ? '保存方案' : '加入画布'}</span>
      </nav>
    </header>}
    <div className="storyboard-planner-workspace">
      <aside ref={scenePicker} className="storyboard-planner-sidebar" aria-label="分镜场次">
        <header><strong>场次</strong><span>已选 {sceneIds.length} / {rangeIds.length}</span></header>
        <p className="storyboard-planner-note">每批最多 {batchLimit} 场，可分批{planningOnly ? '规划' : '加入'}</p>
        <Group className="storyboard-planner-selection-tools" role="group" aria-label="场次批次选择" gap={6} wrap="nowrap">
          <Button type="button" size="compact-xs" disabled={locked || !savedScenes.length} title={planningOnly ? '查看已保存的分镜，或选择重新规划' : '复用已规划分镜，优先补齐缺少的画布节点'} onClick={() => chooseBatch([...savedScenes.filter(needsCanvasNodes), ...savedScenes.filter(scene => !needsCanvasNodes(scene))])} variant="default">已规划</Button>
          <Button type="button" size="compact-xs" disabled={locked || !unplannedScenes.length} onClick={() => chooseBatch(unplannedScenes)} variant="default">待规划</Button>
          <Button type="button" size="compact-xs" className="storyboard-planner-selection-clear" disabled={locked || !sceneIds.length} onClick={() => chooseBatch([])} variant="subtle">清空选择</Button>
        </Group>
        <div className="storyboard-planner-scene-list">
          {rangeIds.map((id, index) => {
            const meta = context?.scenes.find(scene => scene.id === id), checked = sceneIds.includes(id), draftScene = result?.scenes.find(scene => scene.scene_id === id)
            const checkpointScene = retainedOutline?.scenes.find(scene => scene.scene_id === id)
            const count = draftScene?.shots.length || checkpointScene?.shot_count || meta?.shot_count || 0
            return <div key={id} className={`storyboard-planner-scene-item${checked ? ' is-selected' : ''}${view === 'preview' && focusedScene?.scene_id === id ? ' is-focused' : ''}`}>
              <Checkbox aria-label={`选择场次：${sceneLabel(id)}`} checked={checked} disabled={locked || !checked && sceneIds.length >= batchLimit} onChange={event => chooseScene(id, event.currentTarget.checked)} />
              <UnstyledButton type="button" className="storyboard-planner-scene-button" disabled={locked || !checked && sceneIds.length >= batchLimit} title={!checked && sceneIds.length >= batchLimit ? '本批已选满，可清空选择或切换已规划场次' : undefined} onClick={() => { if (checked && hasPreview) { setFocusedSceneId(id); setView('preview') } else chooseScene(id, !checked) }}>
                <span className="storyboard-planner-scene-number">{String(index + 1).padStart(2, '0')}</span>
                <strong>{sceneLabel(id)}</strong><small>{draftScene?.scene_duration || meta?.duration || detail.script.scenes.find(scene => scene.id === id)?.duration || 0} 秒<span>{draftScene ? `${planIsSaved ? '已保存' : '草稿'} · ${count} 镜` : checkpointScene ? `已保留大纲 · ${count} 镜` : meta?.requires_redesign ? '画布已删除，需重新设计' : meta?.needs_replan ? replanLabel(meta) : meta && planned(meta) ? `${typeof meta.canvas_shot_count !== 'number' ? '已规划' : needsCanvasNodes(meta) ? meta.canvas_shot_count ? '待补齐' : '待加入' : '已加入'} · ${count} 镜` : '待规划'}</span></small>
              </UnstyledButton>
            </div>
          })}
        </div>
      </aside>
      <main className="storyboard-planner-main">
        {!isPage && <nav className="storyboard-planner-tabs" aria-label="分镜工作步骤">
          <UnstyledButton type="button" aria-label="规划设置" aria-current={view === 'setup' ? 'step' : undefined} onClick={() => setView('setup')}><span>1</span>规划设置</UnstyledButton><ChevronRight size={13} />
          <UnstyledButton type="button" aria-label="分镜预览" aria-current={view === 'preview' ? 'step' : undefined} disabled={!hasPreview} onClick={() => setView('preview')}><span>{hasPreview ? <Check size={11} /> : '2'}</span>分镜预览</UnstyledButton>
          <small>{planningOnly ? planIsSaved ? '分镜方案已保存' : '规划、调整镜头后保存方案' : planIsSaved ? '分镜已保存，继续准备参考设定并加入画布' : '确认后准备参考设定并加入画布'}</small>
        </nav>}
        <div key={settingsRevision} className="storyboard-planner-scroll">
          {!planningOnly && !referenceWorking && <ReferencePreparationRecovery simple snapshot={recovery.snapshot} onDiscard={() => void recovery.discard()} capabilities={recovery.capabilities} sceneCount={sceneIds.length} busy={!!pending || recovery.loading || !!imported.current} error={recovery.restoreError} reading={recovery.loading}
            activity={referenceActivity} preparing={pending === 'references'} reason={recoveryView.reason} sourceMessage={recoveryView.sourceMessage} disabledReason={recoveryView.disabledReason} adopt={recoveryView.adopt}
            onReload={() => void recovery.reload()} onRestart={() => void addToCanvas('restart')} onAbandon={() => void addToCanvas('abandon')} />}
          {!referenceWorking && !recoveryView.adopt && (recoveryView.retries.length > 0 || recoveryView.pending.some(key => referenceFailures.find(unit => unit.unit_key === key)?.recovery?.model_call !== 'none')) && <small>将调用所选模型</small>}
          {error && recovery.capabilities?.state !== 'unknown' && <div className="storyboard-planner-error" role="alert">
            <div className="storyboard-planner-error-message"><span>{error.message}</span>{!applied.current && <Button variant="subtle" size="compact-xs" disabled={!!pending} onClick={() => void changeSettings(() => setRefreshKey(key => key + 1))}>刷新资料</Button>}</div>
            {(error.raw_output || error.diagnostics) && <WorkspaceDisclosure className="storyboard-planner-error-details" label="查看错误详情">
              {error.diagnostics && <section><strong>校验详情</strong><pre>{error.diagnostics}</pre></section>}
              {error.raw_output && <section><strong>模型原始返回</strong><pre>{error.raw_output}</pre></section>}
              <Button component="a" variant="default" size="compact-xs" href={`data:text/plain;charset=utf-8,${encodeURIComponent(errorReport(error))}`} download="分镜规划错误详情.txt">下载错误详情</Button>
            </WorkspaceDisclosure>}
          </div>}
          {!context ? <div className="storyboard-planner-empty">{pending === 'context' ? <><LoaderCircle size={22} /><strong>正在读取剧本与分镜</strong></> : <><Clapperboard size={24} /><strong>没有可用场次</strong></>}</div>
          : !sceneIds.length ? <div className="storyboard-planner-empty"><Clapperboard size={24} /><strong>{planningOnly ? '选择要规划分镜的场次' : '选择要加入画布的场次'}</strong><p>从左侧勾选场次，再规划镜头。</p></div>
          : view === 'setup' ? <>
            <header className="storyboard-planner-section-title"><h3>{planIsSaved ? '分镜已保存' : result ? '调整规划设置' : planningScenes.length ? '规划所选场次' : '所选分镜已准备好'}</h3><p>{planningOnly ? planIsSaved ? '本次镜头已保存，可返回分镜管理继续维护。' : planningScenes.length ? `${planningScenes.length} 场待规划${reusedScenes.length ? `，另有 ${reusedScenes.length} 场复用已保存分镜` : ''}。生成后可以逐镜修改，再保存方案。` : '这些镜头已保存，可返回分镜管理继续编辑，也可以重新规划。' : planIsSaved ? '本次镜头已保存，继续准备参考设定并加入画布。' : planningScenes.length ? `${planningScenes.length} 场待规划${reusedScenes.length ? `，另有 ${reusedScenes.length} 场复用已保存分镜` : ''}。生成后可以逐镜修改，再确认加入。` : '可以预览已保存镜头后直接加入，也可以重新规划。'}</p></header>
            {!!staleScenes.length && !planIsSaved && <p className="storyboard-planner-note" role="status">旧分镜和素材仍会保留，请先按最新资料重新规划{planningOnly ? '并保存方案。' : '后再加入画布。'}</p>}
            {requiresRedesign && !planIsSaved && <p className="storyboard-planner-note" role="status">{planningOnly ? '原方案的画布已删除，本次将重新设计并保存新方案。历史方案及素材保留。' : '原方案的画布已删除，本次将重新设计，确认后自动创建新画布。历史方案及素材保留。'}</p>}
            {canChoosePlanningMode && <>
              {isPage ? <section className="storyboard-mode-section" aria-label="分镜规划方式">
                <h3>镜头规划方式</h3>
                <div className="storyboard-mode-options">
                  {planningModes.map(mode => <UnstyledButton className="storyboard-mode-option" key={mode.value}
                    aria-pressed={selectedPlanningMode === mode.value} disabled={locked || mode.disabled}
                    onClick={() => changePlanningMode(mode.value)}>
                    <strong>{mode.label}</strong><small>{mode.description}</small>
                  </UnstyledButton>)}
                </div>
              </section> : <Select label="规划方式" aria-label="分镜规划方式" value={selectedPlanningMode} allowDeselect={false} disabled={locked}
                data={planningModes.map(({ value, label, disabled }) => ({ value, label, disabled }))} comboboxProps={{ zIndex: 350 }}
                onChange={changePlanningMode} />}
              {!requiresRedesign && <p className="storyboard-planner-note">{planningOnly ? reusingSavedPlan ? planningScenes.length ? '保留已保存镜头，仅规划尚未完成的场次。' : '查看已保存的镜头，或切换规划方式重新设计。' : effectivePlanningMode === 'redesign' ? '将所选场次保存为新分镜方案，原方案和素材保留。' : '沿用当前方案修改镜头，确认后保存。' : reusingSavedPlan ? planningScenes.length ? '复用已保存分镜与视觉设定，仅规划尚未完成的场次。' : '复用已保存分镜与视觉设定，可以直接确认加入画布。' : effectivePlanningMode === 'redesign' ? '所选场次的镜头与视觉设定会形成新方案并进入独立画布。旧方案和素材保留，不会自动参与新方案。' : '沿用当前镜头与视觉设定更新。未变化的设定和确认图会复用。'}</p>}</>}
            {planningScenes.length > 0 && <>
              <Select label="目标视频模型（可选）" aria-label="目标视频模型" placeholder="尚未指定，使用通用制作约束" clearable
                value={targetVideoModelId || null} data={videoModels.map(model => ({ value: model.id, label: model.name }))} disabled={locked}
                comboboxProps={{ zIndex: 350 }} onChange={value => void changeSettings(() => setTargetVideoModelId(value || ''))} />
              <section className="storyboard-planner-skill-card" aria-label="本次分镜技能">
                <header><span>本次分镜规划</span><small>{skillSource}</small></header>
                <div className="storyboard-planner-skill-choice"><span className="storyboard-planner-primary-skill"><Puzzle size={15} /><strong title={primarySkill?.name}>{skillIds.length && !primarySkill ? '技能需重新选择' : primarySkill?.name || '基础分镜规则'}</strong></span>
                  <CreativeSkillSelector stage="storyboard" projectId={detail.id} ids={skillIds} disabled={locked} appearance="planner" triggerLabel="更换" position="bottom-end"
                    selection={skillAssignment} onUseAutomatic={() => void changeSettings(() => setSkillManual(false))}
                    policies={skillPolicy ? [skillPolicy] : []}
                    onDefaultsChanged={() => void changeSettings(() => { skillInitialized.current = false; setSkillManual(false); setRefreshKey(value => value + 1) })} onChange={values => void changeSettings(() => { setSkillIds(values); setSkillManual(true) })} />
                </div>
                <p>主技能<span>·</span>辅助技能 {auxiliarySkills.length} 个{auxiliarySkills.length > 0 && <span className="storyboard-planner-auxiliary-names">{auxiliarySkills.join(' · ')}</span>}</p>
                <p>{skillAssignment.reason}</p>
              </section>
              <div className="storyboard-planner-settings"><Select label="文本模型" aria-label="分镜规划文本模型" data={eligibleModels.map(model => ({ value: model.id, label: model.name }))} value={modelId || null} allowDeselect={false} disabled={locked}
                onChange={value => { if (value && value !== modelId) void changeSettings(() => selectModel(value)) }} comboboxProps={{ zIndex: 350 }} />
                <TaskReasoningSelect reasoning={reasoning} disabled={locked} zIndex={350} />
                <NumberInput label="每场建议镜头数" placeholder="自动分析" description="留空时，按各场剧情与时长自动确定" inputWrapperOrder={['label', 'input', 'description', 'error']} min={2} max={8} allowDecimal={false} value={shotsPerScene} disabled={locked} onChange={value => void changeSettings(() => setShotsPerScene(value))} /></div>
              {!eligibleModels.length && <p className="storyboard-planner-error">请先配置并启用文本模型，再开始规划。</p>}
              {context.reference_budget && <p className="storyboard-planner-reference-budget" role="note">每镜最多 {context.reference_budget.max_setting_images} 张设定参考图，另为分镜图预留 {context.reference_budget.storyboard_images} 张；视频合计不超过 {context.reference_budget.max_images} 张。对象过多时按剧情拆分镜头。</p>}
              <Textarea label="导演要求" placeholder="例如：保留全部对白，强调人物反应和动作衔接" maxLength={4000} rows={2} value={instructions} disabled={locked} onChange={event => { const value = event.currentTarget.value; void changeSettings(() => setInstructions(value)) }} />
              <WorkspaceDisclosure className="storyboard-planner-disclosure" label={<><span>参考资料</span><small>{documentIds.length ? `已选 ${documentIds.length} 份` : '可选'}</small></>}>
                <div className="storyboard-planner-disclosure-body"><p className="storyboard-planner-note">所选场次正文、项目画幅与画风会用于规划。默认参考所选集的最新分集剧本，勾选其他文档可补充人物、世界观等设定。</p>
                  <div className="storyboard-planner-source-list">{context.documents.map(document => <Checkbox key={document.id} label={`${document.title} · ${document.characters.toLocaleString()} 字`} checked={documentIds.includes(document.id)} disabled={locked}
                    onChange={event => { const checked = event.currentTarget.checked; void changeSettings(() => { documentChoices.current.set(document.id, checked); setDocumentIds(current => toggle(current, document.id, checked)) }) }} />)}</div>
                  {!!context.project.style && <WorkspaceDisclosure className="storyboard-planner-details" label={<>查看项目画风</>}><p>{context.project.style}</p></WorkspaceDisclosure>}
                </div>
              </WorkspaceDisclosure>
            </>}
            <WorkspaceDisclosure className="storyboard-planner-disclosure" label={<><span>时长设置</span><small>{durationChoice === 'fixed' ? `${target} 秒` : durationChoice === 'reestimate' ? '按剧情重新估时' : '保留原时长'}</small></>}><div className="storyboard-planner-disclosure-body">
              {!!planningScenes.length && <><Select label="时长方式" aria-label="分镜时长方式" value={durationChoice} allowDeselect={false} disabled={locked}
                data={[{ value: 'preserve', label: '保留原时长' }, { value: 'reestimate', label: '按剧情重新估时' }, { value: 'fixed', label: '指定总时长' }]} comboboxProps={{ zIndex: 350 }}
                onChange={value => { if (value === 'preserve' || value === 'reestimate' || value === 'fixed') void changeSettings(() => { setDurationChoice(value); if (value === 'fixed') setTarget(Math.max(minimum, Math.min(maxScriptSceneDuration, total))) }) }} />
                {durationChoice === 'fixed' && <NumberInput label="本次目标时长" suffix=" 秒" min={minimum} max={maxScriptSceneDuration} allowDecimal={false} value={target} disabled={locked} onChange={value => void changeSettings(() => setTarget(value))} />}
                {invalidTarget && <p className="storyboard-planner-error">本次总时长应在 {minimum} 至 {maxScriptSceneDuration} 秒之间。</p>}
                <p className="storyboard-planner-note">{durationChoice === 'reestimate' ? '按完整对白、动作和停顿估算各场时长；先预览，确认后同步到场次。' : durationChoice === 'fixed' ? `源场次合计 ${total} 秒；按指定总时长分配，确认后同步到场次。` : `保留剧本场次时长（合计 ${total} 秒）。时长偏短时可选择按剧情重新估时。`}</p></>}
            </div></WorkspaceDisclosure>
          </> : focusedScene && <>
            {!planningOnly && !referenceWorking && <div className="storyboard-planner-reference-preparation">
              <section className="storyboard-planner-skill-card" aria-label="本次参考设定技能">
                <header><span>参考设定整理</span><small>{referenceManual ? '手动选择' : '按功能分配'}</small></header>
                <div className="storyboard-planner-skill-choice"><span className="storyboard-planner-primary-skill"><Puzzle size={15} /><strong>{referenceIds.length && !referencePrimary ? '技能需重新选择' : referencePrimary?.name || '基础设定规则'}</strong></span>
                  <CreativeSkillSelector stage="visual_assets" projectId={detail.id} ids={referenceIds} disabled={!!pending || !!imported.current || referenceReloading} appearance="prompt" triggerLabel="更换" position="bottom-end" policies={referencePolicy ? [referencePolicy] : []}
                    selection={referenceAssignment} onUseAutomatic={() => { setReferenceManual(false); setError(null) }}
                    onDefaultsChanged={() => void reloadReferencePolicy()} onChange={values => { setReferenceSkillIds(values); setReferenceManual(true); setError(null) }} />
                </div>
                <p>主技能<span>·</span>辅助技能 {Math.max(0, referenceIds.length - 1)} 个</p>
                <p>{referenceAssignment.reason}</p>
                {referenceUsed && <p>实际使用：{referenceUsed.skills.join(' · ') || '基础设定规则'}{referenceUsed.assignment?.reason && <>；选择理由：{referenceUsed.assignment.reason}</>}</p>}
              </section>
              <ReferencePreparationModel working={referenceWorking} capabilities={recovery.capabilities} models={models} modelId={modelId} label="整理设定的文本模型" disabled={!!pending || guarding || !!imported.current} onChange={value => { if (value !== modelId) selectModel(value) }} />
              <TaskReasoningSelect reasoning={reasoning} disabled={!!pending || guarding || !!imported.current} zIndex={350} />
              {recovery.capabilities?.text_generation_options?.reasoning && recovery.capabilities.text_generation_options.reasoning !== reasoning.value &&
                (recovery.capabilities.can_continue || recovery.capabilities.can_retry_failed) &&
                <small>续跑档位 · {taskReasoningLabel(recovery.capabilities.text_generation_options.reasoning)}</small>}
              {!eligibleModels.length && referenceNeedsAnalysis.length > 0 && <p className="storyboard-planner-error">这些场次还需要整理参考设定，请先启用一个文本模型。</p>}
            </div>}
            <header className="storyboard-planner-section-title"><h3>{focusedScene.scene_heading}</h3><p>{focusedOutline ? `已保留大纲 ${focusedOutline.shot_count} 镜 · 镜头合计 ${focusedOutline.shot_duration_sum} 秒 / 目标 ${focusedOutline.scene_duration} 秒 · 等待继续规划` : <>{focusedScene.shots.length} 个镜头 · {focusedScene.scene_duration} 秒 · {focusedIsDraft ? awaitingReview ? '草稿已暂存，处理结束后可修改与复查' : '未保存草稿，可修改后确认' : focusedHasResult && planIsSaved ? '已保存分镜' : focusedScene.shots.length ? '复用已保存分镜' : '尚无完整分镜'}</>}</p></header>
            {result && <WorkspaceDisclosure className="storyboard-planner-used-sources" label={<><Puzzle size={13} /><span>已使用：{result.used_skills[0]?.name || '基础分镜规则'}<small>辅助技能 {Math.max(0, result.used_skills.length - 1)} 个<span>·</span>参考资料 {result.source_documents.length} 份</small></span><ChevronRight size={13} /></>}>

              <div className="storyboard-planner-used-details">{result.skill_assignment?.reason && <p>选择理由：{result.skill_assignment.reason}</p>}<p>参考文档：{result.source_documents.map(document => document.title).join(' · ') || '未选择额外文档'}</p>{result.used_skills.map((skill, index) => <p key={skill.id}><strong>{index === 0 ? '主技能' : '辅助技能'} · {skill.name}</strong><small>版本 {skill.revision.slice(0, 8)} · {skill.files.join(' · ')}</small></p>)}</div>
              {result.motion_skills && <div className="storyboard-planner-used-details"><p>视频运动说明：{result.motion_skills.length ? result.motion_skills.map(skill => skill.name).join(' · ') : '基础运动规则'}</p>{result.motion_skill_assignment?.reason && <p>{result.motion_skill_assignment.reason}</p>}{result.motion_skills.map(skill => <p key={skill.id}><strong>{skill.name}</strong><small>版本 {skill.revision.slice(0, 8)} · {skill.files.join(' · ')}</small></p>)}</div>}
            </WorkspaceDisclosure>}
            {result?.directing_review && <div className="storyboard-planner-note" role="status">
              {result.directing_review.status === 'pending_review' ? '分镜生成已完成，导演复核仍在进行；草稿已保留。'
                : result.directing_review.status === 'edited' ? '分镜已修改，当前版本尚未复核运镜与接镜；以下保留上次问题供修改参考。'
                : result.directing_review.status === 'review_inconclusive_no_action' ? `分镜生成已完成，复核未定且没有待处理问题；可以保存草稿。${result.directing_review.error?.message || ''}`
                : result.directing_review.status === 'review_inconclusive_needs_user' || result.directing_review.status === 'inconclusive' ? `分镜生成已完成，复核未定，存在待确认问题；草稿已保留，可以保存草稿或稍后复核。${result.directing_review.error?.message || ''}`
                : result.directing_review.status === 'needs_work' ? `分镜生成已完成，复核发现待修复问题。${result.directing_review.error?.message || '请查看问题并修复当前草稿。'}`
                : result.directing_review.status === 'warnings' ? '分镜生成已完成，导演复核通过，但有以下节奏或动机提醒。'
                  : `分镜生成已完成，导演复核通过${result.directing_review.repaired ? '，已自动修订并复查' : ''}。`}
              {result.directing_review.issues.map((item, index) => {
                const unverified = result.directing_review?.status === 'review_inconclusive_no_action'
                  || result.directing_review?.status === 'review_inconclusive_needs_user' || result.directing_review?.status === 'inconclusive'
                return <p key={index}>{context.scenes.find(scene => scene.id === item.scene_id)?.heading || '所选场次'} · 第{item.shot_index + 1}镜：{unverified ? '未核实复核意见：' : ''}{item.message}{unverified ? ' 建议：' : ` 依据：${item.evidence} 建议：`}{item.repair}</p>
              })}
              {!planIsSaved && !awaitingReview && <Button variant="default" size="xs" loading={pending === 'review'} disabled={!!pending || !!planIssue(result)} onClick={() => void reviewDraft()}>{reviewDeliveryPending ? '发起新的复核' : '复查当前草稿'}</Button>}
              {!planningOnly && !planIsSaved && needsManualReview && <Button variant="light" size="xs" loading={pending === 'save'} disabled={!!pending || guarding || !!planIssue(result)} onClick={() => void savePlan()}>保存草稿，稍后复核</Button>}
              {!planIsSaved && result.directing_review.review_id && result.directing_review.status === 'needs_work' && <Button variant="light" size="xs" loading={pending === 'repair'} disabled={!!pending || !!planIssue(result) || result.directing_review.error?.code === 'storyboard_repeated_issues'} onClick={() => void reviewDraft(true)}>仅修复已确认问题</Button>}
            </div>}
            {result && !result.directing_review && !planIsSaved && <Button variant="default" size="xs" loading={pending === 'review'} disabled={!!pending || !!planIssue(result)} onClick={() => void reviewDraft()}>复查当前草稿</Button>}
            {issue && <p className="storyboard-planner-error" role="status">{issue}</p>}
            <fieldset key={focusedScene.scene_id} disabled={locked} className="storyboard-planner-preview">
              {focusedIsDraft && <NumberInput label="本场规划时长" suffix=" 秒" min={1} max={maxScriptSceneDuration} value={focusedScene.scene_duration} onChange={value => editResult(current => ({ ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, scene_duration: Number(value) } : item) }))} />}
              {focusedScene.shots.map((shot, index) => <WorkspaceDisclosure key={`${focusedScene.scene_id}-${index}`} className="storyboard-planner-shot" initiallyOpen={index === 0} label={<><span className="storyboard-planner-shot-number">{String(index + 1).padStart(2, '0')}</span><strong>{shot.title}</strong><span>{shot.duration} 秒</span></>}>

                <div className="storyboard-planner-shot-fields"><div className="storyboard-planner-settings"><TextInput label="镜头标题" readOnly={!focusedIsDraft} maxLength={120} value={shot.title} onChange={event => updateShot(focusedScene.scene_id, index, { title: event.currentTarget.value })} /><NumberInput label="镜头时长" readOnly={!focusedIsDraft} hideControls={!focusedIsDraft} suffix=" 秒" min={1} max={30} value={shot.duration} onChange={value => updateShot(focusedScene.scene_id, index, { duration: Number(value) })} /></div>
                  {(['prompt', 'image_prompt', 'video_prompt'] as const).map((key, field) => <Textarea key={key} label={['镜头描述', '首帧图片提示词', '动作与运镜视频提示词'][field]} readOnly={!focusedIsDraft} value={shot[key]} autosize minRows={key === 'prompt' ? 2 : 3} maxRows={8} maxLength={key === 'prompt' ? 10000 : 20000} onChange={event => updateShot(focusedScene.scene_id, index, { [key]: event.currentTarget.value })} />)}
                  <WorkspaceDisclosure className="storyboard-planner-details" label={<>起止状态与接镜</>}><div className="storyboard-planner-continuity">{(['start_state', 'end_state', 'cut_note'] as const).map((key, field) => <Textarea key={key} label={['开始状态', '结束状态', '接镜要求'][field]} readOnly={!focusedIsDraft} value={shot[key]} rows={2} maxLength={2000} onChange={event => updateShot(focusedScene.scene_id, index, { [key]: event.currentTarget.value })} />)}</div></WorkspaceDisclosure>
                  {focusedIsDraft && !shot.shot_id && <Button variant="subtle" size="xs" leftSection={<Trash2 size={13} />} onClick={() => editResult(current => ({ ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, shots: item.shots.filter((_, i) => i !== index) } : item) }))}>移除新增镜头</Button>}
                </div>
              </WorkspaceDisclosure>)}
              {focusedIsDraft && <Button variant="default" size="xs" leftSection={<Plus size={13} />} disabled={focusedScene.shots.length >= Math.min(30, focusedScene.scene_duration)} onClick={() => editResult(current => ({ ...current, scenes: current.scenes.map(item => item.scene_id === focusedScene.scene_id ? { ...item, shots: [...item.shots, { shot_id: null, title: '新增镜头', prompt: '', image_prompt: '', video_prompt: '', duration: 1, start_state: '', end_state: '', cut_note: '' }] } : item) }))}>添加镜头</Button>}
            </fieldset>
          </>}
        </div>
      </main>
    </div>
    <footer className={`storyboard-planner-actions${!planningOnly && hasPreview ? ' has-reference-actions' : ''}`}>
      {!(referenceWorking || recovery.capabilities?.state === 'unknown') && <div className="storyboard-planner-footer-status" role="status" aria-label="分镜规划进度" title={taskConnection || undefined}>{pending ? <><LoaderCircle size={14} />{pending === 'context' ? '正在读取资料' : pending === 'preview' ? '正在查找上次完成的预览' : pending === 'save' ? saveLabel : pending === 'references' ? `正在整理参考设定 · ${elapsed} 秒` : planningTask ? `${taskLabel} · ${taskSeconds} 秒` : `正在设计并复核运镜与接镜 · ${elapsed} 秒`}</> : <>
        {retainedOutline ? `${sceneIds.length} 场 · 已保留大纲 ${retainedCount} 镜` : hasPreview ? `${sceneIds.length} 场 · ${previewCount} 个镜头` : `${sceneIds.length} 场已选`}
        <small><span>{planningOnly ? planIsSaved ? '分镜已保存，可重试刷新后返回管理' : result ? '草稿尚未保存，确认后保存到分镜管理' : hasPreview ? '当前为已保存镜头，可返回分镜管理继续编辑' : '先规划，再保存分镜方案' : planIsSaved ? imported.current ? '分镜与设定已保存，继续打开画布' : '分镜已保存，继续准备参考设定' : hasPreview ? '先补齐参考图，再生成分镜' : '先规划，再确认加入'}</span>
          {referenceBlocked && <span role="status">请先处理保留的参考档案；相同输入已停止自动重试。</span>}
          {!!referenceFailures.length && <span role="status">已完成 {referenceCompleted.length} 个对象，另有 {referenceFailures.length} 个待处理；尚未加入画布。</span>}
          {!planningOnly && hasPreview && <Popover position="top-start" offset={6} width="min(360px, calc(100vw - 32px))" withinPortal zIndex={350} returnFocus>
            <Popover.Target><ActionIcon className="storyboard-planner-info-button" variant="subtle" size={20} aria-label="查看参考设定说明" title="查看参考设定说明"><Info size={14} /></ActionIcon></Popover.Target>
            <Popover.Dropdown className="storyboard-planner-info-popover" role="dialog" aria-label="参考设定说明">
              <p>确认时会整理所需人物、场景与关键道具设定，并和分镜一起加入画布。先生成并确认必需信息图，再生成依赖它们的分镜；未变化的设定与确认图会复用，设定已变更时会同步本次镜头引用，并需重新制作对应参考图。</p>
            </Popover.Dropdown>
          </Popover>}
        </small>
      </>}</div>}
      {referenceWorking && <ReferencePreparationActivity capabilities={recovery.capabilities} activity={referenceActivity} preparing={pending === 'references'} />}
      <div className="reference-footer-primary-actions">
      {cancelUnconfirmed && <Button variant="default" disabled={cancellingTask} onClick={() => void cancelPlanning()}>重试取消</Button>}
      {!backgroundPlanning && (pending === 'preview' || pending === 'plan') ? <Button variant="default" disabled={cancellingTask} onClick={() => void cancelPlanning()}>{cancellingTask ? '正在取消' : pending === 'preview' && context?.planning_task_version === 1 ? '停止查询' : '取消规划'}</Button> : !isPage && <Button className="storyboard-planner-close-action" variant="subtle" disabled={guarding || pending === 'save'} onClick={() => void requestClose()}>{backgroundPlanning ? '关闭' : planningOnly ? '返回' : '关闭'}</Button>}
      {(planningOnly || !hasPreview) && (result || planningTask?.can_resume || error) && !planIsSaved && <Button variant="default" disabled={locked || !planningIds.length || invalidTarget || invalidShotCount || !eligibleModels.some(model => model.id === modelId)} onClick={() => void startPlanning(true)}>重新规划</Button>}
      {backgroundPlanning ? null : planningTask?.can_resume ? <Button className="storyboard-planner-primary" leftSection={<Clapperboard size={14} />} disabled={locked || taskInputRef.current?.model_id !== modelId} onClick={() => void continuePlanning()}>{planningTask.error?.code === 'storyboard_review_invalid' && planningTask.outline_checkpoint && !planningTask.candidate ? '继续恢复大纲' : '继续规划'}</Button>
        : planningOnly && hasPreview ? result || planIsSaved ? <Button className="storyboard-planner-primary" leftSection={<Save size={14} />} disabled={!!pending || guarding || !!issue} onClick={() => void savePlan()}>{planIsSaved ? '重试刷新' : '保存分镜方案'}</Button> : !isPage && <Button className="storyboard-planner-primary" disabled={!!pending || guarding} onClick={() => void requestClose()}>{returnLabel}</Button>
        : hasPreview ? referenceWorking || !!recovery.restoreError || recovery.capabilities?.state === 'unknown' && !recovery.capabilities.inspection?.can_abandon ? null : <div className="storyboard-planner-reference-actions"><ReferencePrimaryAction key={`${recovery.capabilities?.run_id}:${recoveryView.primaryAction}`} action={recoveryView.primaryAction} onAction={action => void addToCanvas(action)} className="storyboard-planner-primary" leftSection={<Plus size={14} />} disabled={!!pending || referenceReloading || referenceBlocked && !recovery.capabilities?.inspection?.can_abandon || recovery.loading || !!recovery.restoreError || !!issue || needsManualReview || !recoveryView.primaryEnabled || ['restart', 'prepare-current', 'abandon'].includes(String(recoveryView.primaryAction)) && !eligibleModels.length}>{recoveryView.primaryLabel || (recoveryView.adopt ? '加入画布' : recoveryView.retries.length ? '重试' : referenceFailures.length ? '重试' : planIsSaved ? '继续加入画布' : '加入画布')}</ReferencePrimaryAction></div>
        : /^(?:storyboard_outline_relation_correction_(?:failed|exhausted)$|structural_(?:patch_|schema_|validator_|business_|boundary_))/.test(planningTask?.error?.code || '') ? null
        : backgroundPlanning ? null : <Button className="storyboard-planner-primary" leftSection={<Clapperboard size={14} />} disabled={locked || !context || !planningIds.length || invalidTarget || invalidShotCount || !eligibleModels.some(model => model.id === modelId)} onClick={() => void startPlanning()}>{error ? '继续规划' : '开始规划'}</Button>}
      </div>
    </footer>
  </Modal>{opened && dialog.dialog}</>
}
