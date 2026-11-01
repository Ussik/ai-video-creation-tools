import { StudioMediaPlayer } from '../shared/ui/media/StudioMediaPlayer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Tabs, FileButton, UnstyledButton,
  Accordion, ActionIcon, Badge, Button, Checkbox, Drawer, Modal, NumberInput,
  Menu as MantineMenu, Notification, Select, Textarea, TextInput, Tooltip,
  } from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import {
  ArrowDown, ArrowDownWideNarrow, ArrowRight, ArrowUp, ArrowUpWideNarrow, Check, Clapperboard,
  ChevronDown, Clock3, Download, Eye, FileText, Film, Image as ImageIcon, Layers3, LayoutGrid, List, Menu,
  MoreHorizontal, Music2, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCcw, Save, Scissors, ScrollText, Search, Settings2,
  Upload, FolderOpen, X, Puzzle, Mic2, Trash2,
} from 'lucide-react'
import { api, json } from '../shared/api/api'
import type { Asset, ContinuityReport, Model, ProductionRange, Project, ProjectDetail, Provider, Shot, TimelineClip } from '../shared/api/api'
import ModelSettings from '../features/models/ModelSettings'
import { preferredModel } from '../features/models/model-defaults'
import SkillsCenter from '../features/skills/SkillsCenter'
import SpeechStudio from '../features/speech/SpeechStudio'
import BasicFinalCutStudio from '../features/final-cut/BasicFinalCutStudio'
import TimelinePreview from '../features/final-cut/TimelinePreview'
import FinalCutSpeechPanel from '../features/final-cut/FinalCutSpeechPanel'
import FinalCutOutputSettings from '../features/final-cut/FinalCutOutputSettings'
import FinalCutTimeline from '../features/final-cut/FinalCutTimeline'
import { buildPartialTimelinePreview } from '../features/final-cut/partial-timeline-preview'
import { exportBelongsToFinalCut, finalCutPath, useFinalCutScope } from '../features/final-cut/final-cut-scope'
import { resolveSpeechTimeline, sliceSpeechAudio } from '@video-studio/shared/media/speech-timeline'
import CutReviewPanel from '../features/final-cut/CutReviewPanel'
import CandidateCompare from '../features/final-cut/CandidateCompare'
import TaskRecords from '../features/jobs/TaskRecords'
import { isTaskActive } from '../features/jobs/task-records'
import { jobRecoveryPresentation } from '../features/jobs/job-recovery'
import { canvasGraphPath, preferredCanvas, rememberCanvas, rememberedCanvas, type ProjectCanvasInfo } from '../features/canvas/project-canvases'
import { findShotCanvasTarget, requestShotCanvas } from '../features/canvas/canvas-shot-navigation'
import ProjectCanvas, { type CanvasLocation, type ScriptAction, type CanvasNodeProposalActions } from '../features/canvas/ProjectCanvas'
import type { CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { validateOptimizedPromptReferences, type OptimizedPromptDraft } from '../features/canvas/canvas-optimized-prompt'
import ScriptDirectorPanel from '../features/script/ScriptDirectorPanel'
import type { WorkflowRequest } from '../features/script/script-workflow'
import StoryboardPlanner from '../features/storyboard/StoryboardPlanner'
import ScriptEditor, { type DocumentSection } from '../features/script/ScriptEditor'
import { useAppDialog } from '../shared/ui/AppDialog'
import { filterLibraryAssets, libraryCollection, libraryEmptyText } from '../features/assets/asset-library'
import type { AssetLibraryView } from '../features/assets/asset-library'
import { useProjectDetailRefresh } from './hooks/useProjectDetailRefresh'
import { useAssetDownload } from '../features/assets/useAssetDownload'
import ThemeToggle from '../shared/ui/ThemeToggle'
import { assetPresentations, type AssetNameNode } from '../features/assets/asset-presentation'
import '../features/final-cut/final-cut-workspace.css'

type Tab = 'projects' | 'canvas' | 'studio' | 'assets' | 'jobs' | 'models' | 'skills'
type CandidateReview = {
  shotId: string
  assetId: string
  note: string
  durationMs: number | null
  durationError: string | null
}

type CanvasStoredNode = {
  id: string
  type: 'text' | 'image' | 'video' | 'generation' | 'image_analysis' | 'project_script_ref'
  x: number
  y: number
  width: number
  height: number
  title: string
  text: string
  asset_id: string | null
  shot_id: string | null
  model_id: string | null
  job_id: string | null
  prompt: string
  settings: Record<string, unknown>
}

type CanvasSnapshot = {
  revision: string
  nodes: CanvasStoredNode[]
  edges: Array<{ id: string; source: string; target: string }>
}

const tabs: { id: Tab; label: string; icon: typeof Clapperboard }[] = [
  { id: 'projects', label: '项目', icon: FolderOpen },
  { id: 'assets', label: '资产', icon: Layers3 },
  { id: 'jobs', label: '任务记录', icon: Clock3 },
  { id: 'models', label: '模型设置', icon: Settings2 },
  { id: 'skills', label: '技能中心', icon: Puzzle },
]

const reviewStatusText = { pending: '待审核', approved: '已通过', rejected: '已拒绝' } as const

function dateLabel(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function secondsLabel(ms: number) {
  return `${(ms / 1000).toFixed(3).replace(/\.?0+$/, '')}s`
}

function assetKindLabel(kind: Asset['kind']) {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文本'
}

function assetSourceLabel(source: Asset['source']) {
  return source === 'generated' ? '模型生成' : source === 'export' ? '成片导出' : '本地导入'
}

function clipDuration(clip?: TimelineClip) {
  return clip ? Math.max(0, clip.out_ms - clip.in_ms) : 0
}

function continuitySeverityColor(severity: 'ok' | 'warning' | 'error') {
  return severity === 'error' ? 'red' : severity === 'warning' ? 'yellow' : 'teal'
}

function continuitySeverityLabel(severity: 'ok' | 'warning' | 'error') {
  return severity === 'error' ? '需处理' : severity === 'warning' ? '建议检查' : '通过'
}

function CutFrame({ asset, timeMs, caption }: { asset?: Asset; timeMs: number; caption: string }) {
  const [failed, setFailed] = useState(false)
  const src = asset?.kind === 'video' ? `/api/assets/${asset.id}/frame?time_ms=${Math.max(0, timeMs)}` : asset?.kind === 'image' ? asset.url : ''
  useEffect(() => setFailed(false), [src])
  return <div className="cut-frame">
    <div className="cut-frame-image">{src && !failed ? <img src={src} alt={caption} onError={() => setFailed(true)} /> : <span>{asset ? '画面暂不可用' : '尚未选择素材'}</span>}</div>
    <div className="cut-frame-caption"><strong>{caption}</strong><span>{asset ? secondsLabel(timeMs) : '待选素材'}</span></div>
  </div>
}

function AssetPreview({ asset, compact = false }: { asset?: Asset | null; compact?: boolean }) {
  if (!asset) return <div className="empty-preview"><Film size={compact ? 18 : 30} strokeWidth={1.5} /></div>
  if (asset.kind === 'image') return <img className="media-preview" src={asset.url} alt={asset.filename} />
  if (asset.kind === 'video') return compact
    ? <video className="media-preview" src={asset.url} muted playsInline preload="metadata" onLoadedMetadata={(event) => { if (event.currentTarget.duration > 0.2) event.currentTarget.currentTime = 0.1 }} />
    : <StudioMediaPlayer className="media-preview" src={asset.url} controls preload="metadata" />
  if (asset.kind === 'audio') return compact
    ? <div className="empty-preview"><Music2 size={18} /></div>
    : <StudioMediaPlayer className="audio-preview" src={asset.url} controls preload="metadata" kind="audio" />
  return <div className="empty-preview"><FileText size={compact ? 18 : 28} /></div>
}

function App() {
  const { confirm, prompt, dialog } = useAppDialog()
  const [projects, setProjects] = useState<Project[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const { detail: projectDetail, setDetail, refreshDetail: refreshProjectDetail } = useProjectDetailRefresh(projectId)
  const activeProjectId = useRef(projectId)
  activeProjectId.current = projectId
  const [shotId, setShotId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('projects')
  const [finalCutMode, setFinalCutMode] = useState<'basic' | 'storyboard'>('basic')
  const [basicCutDirty, setBasicCutDirty] = useState(false)
  const storyboardCutOpen = tab === 'studio' && finalCutMode === 'storyboard'
  const finalCut = useFinalCutScope(projectId, storyboardCutOpen)
  const detail = storyboardCutOpen ? finalCut.detail : projectDetail
  const finalCutCanvasId = storyboardCutOpen ? finalCut.canvasId : null
  const finalCutRefresh = useRef(finalCut.refresh)
  finalCutRefresh.current = finalCut.refresh
  const activeView = useRef('')
  activeView.current = `${projectId}:${tab}:${finalCutCanvasId || ''}`
  const taskPollingState = useRef({ tab, active: false })
  taskPollingState.current = { tab, active: !!detail?.jobs.some(isTaskActive) }
  const [scriptDirectorOpen, setScriptDirectorOpen] = useState(false)
  const [scriptDirectorOpenRequest, setScriptDirectorOpenRequest] = useState(0)
  const [scriptDirectorFocus, setScriptDirectorFocus] = useState<ScriptAction>('all')
  const [scriptDirectorContext, setScriptDirectorContext] = useState('')
  const [scriptDirectorNodeSource, setScriptDirectorNodeSource] = useState<CanvasNodeProposalSource>()
  const canvasNodeProposalActions = useRef<CanvasNodeProposalActions | null>(null)
  const [scriptDirectorStageRequest, setScriptDirectorStageRequest] = useState<WorkflowRequest>()
  const [scriptEditorSection, setScriptEditorSection] = useState<DocumentSection>('outline')
  const canvasLocations = useRef(new Map<string, CanvasLocation>())
  const [optimizedPromptDraft, setOptimizedPromptDraft] = useState<OptimizedPromptDraft | null>(null)
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false)
  const [storyboardOpen, setStoryboardOpen] = useState(false)
  const [speechProjectId, setSpeechProjectId] = useState<string | null>(null)
  const [speechFocus, setSpeechFocus] = useState<{ lineId?: string; sceneId?: string | null; shotId?: string | null }>({})
  const [cutPreviewMode, setCutPreviewMode] = useState('cut')
  const [projectCovers, setProjectCovers] = useState<Record<string, Asset | null>>({})
  const [projectQuery, setProjectQuery] = useState('')
  const [projectSort, setProjectSort] = useState<'updated' | 'name' | 'created'>('updated')
  const [projectSelectionMode, setProjectSelectionMode] = useState(false)
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [assetQuery, setAssetQuery] = useState('')
  const [assetKindFilter, setAssetKindFilter] = useState<'all' | Asset['kind']>('all')
  const [assetSourceFilter, setAssetSourceFilter] = useState<'all' | Asset['source']>('all')
  const [assetSort, setAssetSort] = useState<'newest' | 'oldest'>('newest')
  const [assetViewMode, setAssetViewMode] = useState<'grid' | 'list'>('grid')
  const [assetLibraryView, setAssetLibraryView] = useState<AssetLibraryView>('history')
  const [assetPreview, setAssetPreview] = useState<Asset | null>(null)
  const [assetNameNodes, setAssetNameNodes] = useState<{ projectId: string; nodes: AssetNameNode[] } | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [candidateReview, setCandidateReview] = useState<CandidateReview | null>(null)
  const [trimIn, setTrimIn] = useState<number | string>(0)
  const [trimOut, setTrimOut] = useState<number | string>(0)
  const [sourceAudioPercent, setSourceAudioPercent] = useState<number | string>(100)
  const [sourceAudioFadeMs, setSourceAudioFadeMs] = useState<number | string>(0)
  const [showTimelinePreview, setShowTimelinePreview] = useState(false)
  const [showProductionRange, setShowProductionRange] = useState(false)
  const [rangeDraft, setRangeDraft] = useState<ProductionRange>({ start_shot_id: null, end_shot_id: null })
  const [productionTarget, setProductionTarget] = useState<number | string>(45)
  const [continuity, setContinuity] = useState<ContinuityReport | null>(null)
  const [continuityModelId, setContinuityModelId] = useState('')
  const [semanticChecking, setSemanticChecking] = useState(false)
  const [continuityLoading, setContinuityLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const assetDownload = useAssetDownload(setNotice)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const continuityRequest = useRef(0)

  // 画布默认把空间留给节点工作区，仍可通过导航底部的按钮展开。
  useEffect(() => {
    if (tab === 'canvas') setSidebarCollapsed(true)
  }, [tab])

  const currentShot = detail?.shots.find((shot) => shot.id === shotId)
  const shotIndex = detail?.shots.findIndex((shot) => shot.id === shotId) ?? -1
  const previousShot = shotIndex > 0 ? detail?.shots[shotIndex - 1] : undefined
  const currentScene = detail?.script.scenes.find((scene) => scene.id === currentShot?.source_scene_id)
  const selectedAsset = detail?.assets.find((asset) => asset.id === currentShot?.selected_asset_id)
  const reviewAsset = detail?.assets.find((asset) => asset.id === candidateReview?.assetId)
  const reviewShot = detail?.shots.find((shot) => shot.id === candidateReview?.shotId)
  const reviewClip = detail?.timeline_clips.find((clip) => clip.shot_id === candidateReview?.shotId &&
    clip.asset_id === candidateReview?.assetId && reviewShot?.selected_asset_id === clip.asset_id)
  const reviewInMs = reviewClip?.in_ms ?? 0
  const reviewOutMs = reviewClip?.out_ms ?? candidateReview?.durationMs ?? 0
  const reviewRecord = detail?.asset_reviews.find((review) => review.shot_id === candidateReview?.shotId && review.asset_id === candidateReview?.assetId)
  const reviewsByAsset = useMemo(() => new Map(detail?.asset_reviews.filter((review) => review.shot_id === shotId)
    .map((review) => [review.asset_id, review])), [detail, shotId])
  const assetMap = useMemo(() => new Map(detail?.assets.map((asset) => [asset.id, asset])), [detail])
  const clipMap = useMemo(() => new Map(detail?.timeline_clips.map((clip) => [clip.shot_id, clip])), [detail])
  const startIndex = detail?.production_range?.start_shot_id
    ? detail.shots.findIndex((shot) => shot.id === detail.production_range.start_shot_id) : 0
  const endIndex = detail?.production_range?.end_shot_id
    ? detail.shots.findIndex((shot) => shot.id === detail.production_range.end_shot_id) : (detail?.shots.length ?? 0) - 1
  const productionRangeValid = !!detail && (detail.shots.length === 0
    ? !detail.production_range?.start_shot_id && !detail.production_range?.end_shot_id
    : startIndex >= 0 && endIndex >= startIndex)
  const productionShots = productionRangeValid ? detail!.shots.slice(startIndex, endIndex + 1) : []
  const draftStartIndex = rangeDraft.start_shot_id
    ? detail?.shots.findIndex((shot) => shot.id === rangeDraft.start_shot_id) ?? -1 : 0
  const draftEndIndex = rangeDraft.end_shot_id
    ? detail?.shots.findIndex((shot) => shot.id === rangeDraft.end_shot_id) ?? -1 : (detail?.shots.length ?? 0) - 1
  const rangeDraftValid = !!detail?.shots.length && draftStartIndex >= 0 && draftEndIndex >= draftStartIndex
  const draftShots = rangeDraftValid ? detail!.shots.slice(draftStartIndex, draftEndIndex + 1) : []
  const draftDuration = draftShots.reduce((sum, shot) => sum + shot.duration, 0)
  const draftSceneCount = new Set(draftShots.map(shot => shot.source_scene_id).filter(Boolean)).size
  const scriptDuration = detail?.script.scenes.reduce((sum, scene) => sum + scene.duration, 0) ?? 0
  const targetSeconds = Number(productionTarget)
  const rangeChanged = rangeDraft.start_shot_id !== (detail?.production_range?.start_shot_id ?? null) ||
    rangeDraft.end_shot_id !== (detail?.production_range?.end_shot_id ?? null)
  const currentClip = clipMap.get(shotId || '')
  const previousClip = clipMap.get(previousShot?.id || '')
  const previousAsset = assetMap.get(previousClip?.asset_id || '')
  const shotAssets = detail?.assets.filter((asset) => ((asset.shot_id === shotId && asset.source !== 'export') || asset.id === currentShot?.selected_asset_id) && (asset.kind === 'image' || asset.kind === 'video')) || []
  const continuityModels = models.filter(model => model.modality === 'text' && model.enabled && providers.some(provider => provider.id === model.provider_id && provider.enabled))
  useEffect(() => {
    setContinuityModelId(current => continuityModels.some(model => model.id === current)
      ? current : preferredModel(continuityModels)?.id || '')
  }, [models, providers])
  const plannedDuration = productionShots.reduce((sum, shot) => sum + shot.duration, 0)
  const speechTimeline = resolveSpeechTimeline(productionShots, detail?.timeline_clips || [], detail?.speech?.placements || [])
  const timelinePreview = buildPartialTimelinePreview({ shots: productionShots, clips: detail?.timeline_clips || [],
    assets: detail?.assets || [], assetReviews: detail?.asset_reviews || [], speechAudio: speechTimeline.audio })
  const readyCount = timelinePreview.shots.length
  const totalDurationMs = timelinePreview.durationMs
  const canPreview = readyCount > 0
  const allSpeechTimeline = resolveSpeechTimeline(detail?.shots || [], detail?.timeline_clips || [], detail?.speech?.placements || [])
  const currentSpeechTimeline = productionShots.some(shot => shot.id === shotId) ? speechTimeline : allSpeechTimeline
  const currentStart = currentSpeechTimeline.shot_starts.get(shotId || '') || 0
  const currentSpeechAudio = sliceSpeechAudio(currentSpeechTimeline.audio, currentStart, currentStart + clipDuration(currentClip))
  const productionSceneIds = new Set(productionShots.map(shot => shot.source_scene_id).filter(Boolean))
  const unplacedSpeechLines = (detail?.speech?.lines || []).filter(line => line.selected_asset_id && (!line.scene_id || productionSceneIds.has(line.scene_id)) &&
    !detail?.speech?.placements?.some(item => item.line_id === line.id))
  const unplacedSpeechCount = unplacedSpeechLines.length
  const speechAttentionLineId = detail?.speech?.placements?.find(item => item.id === speechTimeline.issues[0]?.placement_id)?.line_id || unplacedSpeechLines[0]?.id
  const canExport = timelinePreview.complete && speechTimeline.issues.length === 0
  const inMs = Math.round(Number(trimIn) * 1000)
  const outMs = Math.round(Number(trimOut) * 1000)
  const trimIssue = !currentClip ? null
    : trimIn === '' || trimOut === '' || !Number.isFinite(inMs) || !Number.isFinite(outMs) ? '请输入有效秒数'
      : inMs < 0 || outMs <= inMs ? '出点必须晚于入点'
        : currentClip.source_duration_ms === null && inMs !== 0 ? '图片素材的入点固定为 0 秒'
          : currentClip.source_duration_ms !== null && outMs > currentClip.source_duration_ms ? `出点不能超过素材时长 ${secondsLabel(currentClip.source_duration_ms)}`
            : outMs - inMs < 200 ? '入片片段至少 0.2 秒'
              : currentClip.source_duration_ms === null && outMs > 30000 ? '图片停留最多 30 秒'
                : null
  const trimChanged = !!currentClip && (inMs !== currentClip.in_ms || outMs !== currentClip.out_ms)
  const audioGain = Number(sourceAudioPercent) / 100
  const audioFade = Number(sourceAudioFadeMs)
  const audioIssue = sourceAudioPercent === '' || sourceAudioFadeMs === '' || !Number.isFinite(audioGain) || audioGain < 0 || audioGain > 2 || !Number.isSafeInteger(audioFade) || audioFade < 0 || audioFade > 500
    ? '原声音量需在 0–200%，首尾淡变需在 0–500 毫秒之间'
    : null
  const audioChanged = !!currentClip && (audioGain !== currentClip.source_audio_gain || audioFade !== currentClip.source_audio_fade_ms)
  const latestExport = detail?.jobs.find((job) => job.job_type === 'export' && job.status === 'succeeded' &&
    exportBelongsToFinalCut(job, finalCutCanvasId, finalCut.canvases))
  const latestExportAsset = detail?.assets.find((asset) => asset.id === latestExport?.result_asset_id)
  const visibleProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase()
    return [...projects]
      .filter((project) => !query || `${project.name} ${project.brief}`.toLocaleLowerCase().includes(query))
      .sort((left, right) => projectSort === 'name'
        ? left.name.localeCompare(right.name, 'zh-CN')
        : projectSort === 'created'
          ? right.created_at.localeCompare(left.created_at)
          : right.updated_at.localeCompare(left.updated_at))
  }, [projectQuery, projectSort, projects])
  const selectedVisibleProjectCount = visibleProjects.filter(project => selectedProjectIds.includes(project.id)).length
  const libraryAssets = useMemo(() => libraryCollection(detail?.assets || [], 'personal'), [detail])
  const historyAssets = useMemo(() => libraryCollection(detail?.assets || [], 'history'), [detail])
  const assetLabels = useMemo(() => assetPresentations(detail, assetNameNodes?.projectId === detail?.id ? assetNameNodes?.nodes : []), [detail, assetNameNodes])
  const assetSearchNames = useMemo(() => new Map([...assetLabels].map(([id, label]) => [id, `${label.title} ${label.context} ${label.specs}`])), [assetLabels])
  const assetCollection = assetLibraryView === 'history' ? historyAssets : libraryAssets
  const visibleLibraryAssets = useMemo(() => {
    if (!detail) return []
    return filterLibraryAssets(assetCollection, detail.shots, { kind: assetKindFilter, source: assetSourceFilter, query: assetQuery, sort: assetSort }, assetSearchNames)
  }, [assetCollection, assetKindFilter, assetQuery, assetSort, assetSourceFilter, assetSearchNames, detail])
  const selectedVisibleAssetCount = visibleLibraryAssets.filter((asset) => selectedAssetIds.includes(asset.id)).length
  async function refreshCatalog() {
    const [nextProviders, nextModels] = await Promise.all([
      api<Provider[]>('/providers'), api<Model[]>('/models'),
    ])
    setProviders(nextProviders)
    setModels(nextModels)
  }

  async function refreshProjects() {
    const next = await api<Project[]>('/projects')
    setProjects(next)
    setSelectedProjectIds(selected => selected.filter(id => next.some(project => project.id === id)))
    return next
  }

  async function refreshDetail(id = activeProjectId.current) {
    const next = await refreshProjectDetail(id)
    if (!next) return
    await finalCutRefresh.current(id || undefined)
    void continuityRefresh.current(id, true).catch(report)
    return next
  }

  const continuityContext = useRef({ projectId, tab, canvasId: finalCutCanvasId })
  continuityContext.current = { projectId, tab, canvasId: finalCutCanvasId }
  const continuityRefresh = useRef(refreshContinuity)
  continuityRefresh.current = refreshContinuity

  async function refreshContinuity(id = activeProjectId.current, background = false) {
    const scope = continuityContext.current
    if (!id || id !== scope.projectId || scope.tab !== 'studio' || !scope.canvasId) return
    const isCurrent = () => continuityContext.current.projectId === id && continuityContext.current.tab === 'studio' && continuityContext.current.canvasId === scope.canvasId
    const requestId = ++continuityRequest.current
    if (!background) setContinuityLoading(true)
    try {
      const next = await api<ContinuityReport>(finalCutPath(`/projects/${id}/continuity`, scope.canvasId))
      if (requestId === continuityRequest.current && isCurrent()) {
        setContinuity(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      }
      return next
    } catch (error) {
      if (requestId === continuityRequest.current && isCurrent()) throw error
    } finally {
      if (requestId === continuityRequest.current && isCurrent()) setContinuityLoading(false)
    }
  }

  async function analyzeContinuity() {
    if (!projectId || !finalCutCanvasId || !continuityModelId || semanticChecking) return
    const targetProject = projectId
    const view = activeView.current
    setSemanticChecking(true)
    try {
      await api(finalCutPath(`/projects/${targetProject}/continuity/analyze`, finalCutCanvasId), json('POST', { model_id: continuityModelId }))
      if (view === activeView.current) await refreshContinuity(targetProject)
    } catch (error) { if (view === activeView.current) report(error) } finally { if (view === activeView.current) setSemanticChecking(false) }
  }

  function report(error: unknown) {
    setNotice(error instanceof Error ? error.message : String(error))
  }

  async function action(task: () => Promise<unknown>, success?: string) {
    const scope = finalCutCanvasId ? { projectId, canvasId: finalCutCanvasId } : null
    const isCurrent = () => !scope || activeProjectId.current === scope.projectId &&
      (continuityContext.current.tab !== 'studio' || continuityContext.current.canvasId === scope.canvasId)
    setBusy(true)
    setNotice(null)
    try {
      await task()
      if (success && isCurrent()) setNotice(success)
    } catch (error) {
      if (isCurrent()) report(error)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    setCandidateReview(null)
    setShowTimelinePreview(false)
    setShowProductionRange(false)
    setContinuity(null)
    setContinuityLoading(false)
    setSemanticChecking(false)
    continuityRequest.current += 1
    if (tab === 'studio' && finalCutCanvasId) void refreshContinuity().catch(report)
  }, [projectId, tab, finalCutCanvasId])

  useEffect(() => {
    if (detail) setShotId(current => detail.shots.some(shot => shot.id === current) ? current : detail.shots[0]?.id || null)
  }, [detail?.id, detail?.shots])

  useEffect(() => {
    setRangeDraft({ start_shot_id: detail?.production_range?.start_shot_id ?? null,
      end_shot_id: detail?.production_range?.end_shot_id ?? null })
  }, [detail?.id, detail?.production_range?.start_shot_id, detail?.production_range?.end_shot_id, finalCutCanvasId])

  useEffect(() => {
    if (!projectId) return
    const saved = Number(window.localStorage.getItem(`production-target:${projectId}`))
    setProductionTarget(Number.isFinite(saved) && saved >= 5 && saved <= 600 ? saved : 45)
  }, [projectId])

  useEffect(() => {
    if (tab !== 'assets' || !projectId || !detail) return
    let active = true
    const id = projectId
    // Optional naming context from every canvas also covers assets without a
    // shot/profile. Never write a graph or let a former project publish titles.
    void api<ProjectCanvasInfo[]>(`/projects/${id}/canvases`).then(async canvases => {
      const snapshots = await Promise.allSettled(canvases.map(canvas => api<CanvasSnapshot>(canvasGraphPath(id, canvas.is_default ? undefined : canvas.id))))
      if (active) setAssetNameNodes({ projectId: id, nodes: snapshots.flatMap(result => result.status === 'fulfilled' ? result.value.nodes : []) })
    }).catch(() => { if (active) setAssetNameNodes(null) })
    return () => { active = false }
  }, [tab, projectId, detail?.assets, detail?.jobs])

  useEffect(() => {
    Promise.all([refreshProjects(), refreshCatalog()]).then(([items]) => {
      if (items.length) setProjectId(items[0].id)
    }).catch(report)
  }, [])

  useEffect(() => {
    if (tab !== 'projects') return
    let cancelled = false
    Promise.all(projects.map(async (project) => {
      try {
        const projectDetail = await api<ProjectDetail>(`/projects/${project.id}`)
        const cover = projectDetail.assets.find((asset) => asset.kind === 'image' || asset.kind === 'video') || null
        return [project.id, cover] as const
      } catch {
        return [project.id, null] as const
      }
    })).then((covers) => { if (!cancelled) setProjectCovers(Object.fromEntries(covers)) })
    return () => { cancelled = true }
  }, [projects, tab])

  useEffect(() => {
    if (!projectId) return
    let active = true
    setSelectedAssetIds([])
    setDetail(null)
    setSelectedAssetIds([])
    setAssetPreview(null)
    setShotId(null)
    setCandidateReview(null)
    setShowTimelinePreview(false)
    continuityRequest.current += 1
    setContinuity(null)
    setContinuityLoading(false)
    // Wait for each background request before scheduling another. Slow local
    // or remote responses must not pile up and supersede every prior result.
    let timer: number | undefined
    const poll = async () => {
      try {
        const taskState = taskPollingState.current
        if (taskState.tab !== 'jobs' || (document.visibilityState !== 'hidden' && taskState.active)) await refreshDetail(projectId)
      } catch (error) { if (active) report(error) }
      finally { if (active) timer = window.setTimeout(poll, 4000) }
    }
    void refreshDetail(projectId).then((next) => {
      if (active && next?.shots.length) setShotId(next.shots[0].id)
    }).catch(error => { if (active) report(error) }).finally(() => {
      if (active) timer = window.setTimeout(poll, 4000)
    })
    return () => { active = false; window.clearTimeout(timer); continuityRequest.current += 1 }
  }, [projectId])

  useEffect(() => {
    // Let the initial project load establish its selected shot before refreshing history.
    if (!projectId || tab !== 'jobs' || detail?.id !== projectId) return
    const refreshVisibleTasks = () => {
      if (document.visibilityState !== 'hidden') void refreshDetail(projectId).catch(report)
    }
    refreshVisibleTasks()
    document.addEventListener('visibilitychange', refreshVisibleTasks)
    return () => document.removeEventListener('visibilitychange', refreshVisibleTasks)
  }, [projectId, tab, detail?.id])

  useEffect(() => {
    setTrimIn((currentClip?.in_ms ?? 0) / 1000)
    setTrimOut((currentClip?.out_ms ?? 0) / 1000)
    setSourceAudioPercent(Math.round((currentClip?.source_audio_gain ?? 1) * 100))
    setSourceAudioFadeMs(currentClip?.source_audio_fade_ms ?? 0)
  }, [shotId, currentClip?.id, currentClip?.asset_id])

  async function createProject() {
    if (busy) return
    await action(async () => {
      const created = await api<Project>('/projects', json('POST', {
        name: `未命名项目 ${new Date().toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}`,
        brief: '', ratio: '16:9',
      }))
      await refreshProjects()
      setDetail(null)
      setProjectId(created.id)
      setScriptDirectorOpen(false)
      setTab('canvas')
    }, '项目已创建')
  }

  async function deleteProject() {
    const project = projects.find((item) => item.id === projectId)
    if (!project || !await confirm({ title: `删除项目「${project.name}」`, message: '项目中的镜头、素材和任务记录都会被删除。', confirmLabel: '删除项目', danger: true })) return
    await action(async () => {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      const remaining = await refreshProjects()
      setDetail(null)
      setProjectId(remaining[0]?.id || null)
      setScriptDirectorOpen(false)
      setTab('projects')
    }, '项目已删除')
  }

  function toggleProjectSelection(id: string) {
    setSelectedProjectIds(selected => selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id])
  }

  async function deleteSelectedProjects() {
    const selected = projects.filter(project => selectedProjectIds.includes(project.id))
    if (busy || !selected.length || !await confirm({
      title: `删除 ${selected.length} 个项目`,
      message: '所选项目中的剧本、镜头、素材和任务记录都会被永久删除，无法恢复。',
      details: <ul className="project-delete-list">{selected.map(project => <li key={project.id}>{project.name}</li>)}</ul>,
      confirmLabel: `确认删除 ${selected.length} 个项目`, danger: true,
    })) return
    await action(async () => {
      const result = await api<{ deleted_ids: string[] }>('/projects/batch-delete', json('POST', { project_ids: selected.map(project => project.id) }))
      const deleted = new Set(result.deleted_ids)
      const remaining = projects.filter(project => !deleted.has(project.id))
      setProjects(remaining)
      setSelectedProjectIds([])
      setProjectSelectionMode(false)
      if (activeProjectId.current && deleted.has(activeProjectId.current)) {
        setDetail(null)
        setProjectId(remaining[0]?.id || null)
        setScriptDirectorOpen(false)
      }
      await refreshProjects()
    }, `已删除 ${selected.length} 个项目`)
  }

  async function renameCurrentProject(nextName: string): Promise<boolean> {
    const project = projects.find((item) => item.id === projectId)
    const name = nextName.trim()
    if (!project || !name) return false
    if (name === project.name) return true
    setBusy(true)
    setNotice(null)
    try {
      await api(`/projects/${project.id}`, json('PATCH', { name }))
      await refreshProjects()
      await refreshDetail(project.id)
      setNotice('项目已重命名')
      return true
    } catch (error) {
      report(error)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function renameProject(project: Project) {
    const nextName = await prompt({ title: '重命名项目', message: '修改项目名称。', defaultValue: project.name, placeholder: '项目名称', confirmLabel: '保存' })
    if (!nextName || nextName === project.name) return
    await action(async () => {
      await api(`/projects/${project.id}`, json('PATCH', { name: nextName }))
      await refreshProjects()
      if (project.id === projectId) await refreshDetail(project.id)
    }, '项目已重命名')
  }

  function switchAssetLibrary(view: AssetLibraryView) {
    setAssetLibraryView(view)
    setAssetKindFilter('all')
    setAssetSourceFilter('all')
    setAssetQuery('')
    setSelectedAssetIds([])
  }

  function clearAssetFilters() {
    setAssetKindFilter('all')
    setAssetSourceFilter('all')
    setAssetQuery('')
    setSelectedAssetIds([])
  }

  function toggleAssetSelection(id: string) {
    setSelectedAssetIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  function toggleVisibleAssets() {
    const visibleIds = visibleLibraryAssets.map((asset) => asset.id)
    setSelectedAssetIds((current) => selectedVisibleAssetCount === visibleIds.length
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])])
  }

  async function addAssetsToCanvas(assetIds: string[]) {
    if (!projectId || !assetIds.length) return
    const canvasAssets = (detail?.assets || []).filter((asset) => assetIds.includes(asset.id) && ['image', 'video', 'text'].includes(asset.kind))
    if (!canvasAssets.length) {
      setNotice('音频素材需要在时间线中使用，暂时不能作为画布节点')
      return
    }
    await action(async () => {
      const canvases = await api<ProjectCanvasInfo[]>(`/projects/${projectId}/canvases`)
      const selected = preferredCanvas(canvases, rememberedCanvas(projectId))
      if (!selected) throw new Error('项目没有可用画布')
      const path = canvasGraphPath(projectId, selected.is_default ? undefined : selected.id)
      const canvas = await api<CanvasSnapshot>(path)
      const existing = new Set(canvas.nodes.map((node) => node.asset_id).filter((id): id is string => !!id))
      const missing = canvasAssets.filter((asset) => !existing.has(asset.id))
      if (!missing.length) {
        setNotice('选中的素材已经在画布中')
        setTab('canvas')
        return
      }
      const capacity = Math.max(0, 500 - canvas.nodes.length)
      const addable = missing.slice(0, capacity)
      const skipped = missing.length - addable.length
      if (!addable.length) {
        setNotice('画布已达到 500 个节点上限，请先移除节点')
        setTab('canvas')
        return
      }
      const maxX = canvas.nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0)
      const nodes: CanvasStoredNode[] = addable.map((asset, index) => ({
        id: crypto.randomUUID(), type: asset.kind as CanvasStoredNode['type'],
        x: maxX + 180 + (index % 3) * 350, y: 100 + Math.floor(index / 3) * 300,
        width: asset.kind === 'text' ? 320 : 320, height: asset.kind === 'text' ? 220 : 260,
        title: assetLabels.get(asset.id)?.title || asset.filename, text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id,
        shot_id: asset.shot_id, model_id: null, job_id: null, prompt: '', settings: {},
      }))
      await api(path, json('PUT', { ...canvas, nodes: [...canvas.nodes, ...nodes] }))
      setSelectedAssetIds([])
      setTab('canvas')
      setNotice(skipped ? `已加入 ${addable.length} 个素材，${skipped} 个素材因画布容量上限未加入` : `${addable.length} 个素材已加入画布`)
    }, undefined)
  }

  function downloadAssets(assetIds: string[]) {
    if (detail) void assetDownload.download(detail.id, assetIds)
  }

  async function saveTrim() {
    if (!currentClip || trimIssue || !trimChanged) return
    await action(async () => {
      await api(finalCutPath(`/timeline-clips/${currentClip.id}`, finalCutCanvasId), json('PATCH', { in_ms: inMs, out_ms: outMs }))
      await refreshDetail()
    }, '入片区间已保存')
  }

  async function openShotInCanvas(targetShotId: string) {
    if (!detail || busy || !detail.shots.some(shot => shot.id === targetShotId)) return
    const project = detail
    await action(async () => {
      const canvases = await api<ProjectCanvasInfo[]>(`/projects/${project.id}/canvases`)
      const target = await findShotCanvasTarget(canvases, rememberedCanvas(project.id), targetShotId,
        project.shots.find(shot => shot.id === targetShotId)?.selected_asset_id || null, async canvas => {
          const storageId = canvas.id === project.id ? project.id : `${project.id}:${canvas.id}`
          try {
            const draft = JSON.parse(window.localStorage.getItem(`project-canvas-draft:${storageId}`) || '')
            if (Array.isArray(draft.base?.nodes) && Array.isArray(draft.graph?.nodes) && Array.isArray(draft.graph.edges)) return draft.graph
          } catch { /* Read the persisted graph if a draft is unavailable. */ }
          return api<import('../features/canvas/ProjectCanvas').CanvasGraph>(canvasGraphPath(project.id, canvas.is_default ? undefined : canvas.id))
        })
      if (activeProjectId.current !== project.id) return
      rememberCanvas(project.id, target.canvasId)
      requestShotCanvas(project.id, { ...target, requestId: crypto.randomUUID() })
      canvasLocations.current.set(project.id, { view: 'canvas', storyboardId: null })
      setShotId(targetShotId); setTab('canvas')
    })
  }

  async function saveSourceAudio() {
    if (!currentClip || audioIssue || !audioChanged) return
    await action(async () => {
      await api(finalCutPath(`/timeline-clips/${currentClip.id}`, finalCutCanvasId), json('PATCH', {
        source_audio_gain: audioGain, source_audio_fade_ms: audioFade,
      }))
      await refreshDetail()
    }, '片段原声设置已保存')
  }

  async function moveShot(shot: Shot, direction: number) {
    await action(async () => {
      await api(finalCutPath(`/shots/${shot.id}`, finalCutCanvasId), json('PATCH', { position: Math.max(0, (detail?.shots.findIndex(item => item.id === shot.id) ?? 0) + direction) }))
      await refreshDetail()
    })
  }

  async function uploadFiles(files: FileList | File[] | null) {
    if (!files || !projectId) return
    await action(async () => {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        if (tab === 'studio' && shotId) form.append('shot_id', shotId)
        await api(`/projects/${projectId}/assets`, { method: 'POST', body: form })
      }
      await refreshDetail()
      if (fileInput.current) fileInput.current.value = ''
    }, '素材已导入')
  }

  async function selectCandidate(assetId: string) {
    if (!shotId || currentShot?.selected_asset_id === assetId) return
    await action(async () => {
      await api(finalCutPath(`/shots/${shotId}/selection`, finalCutCanvasId), json('PUT', { asset_id: assetId }))
      await refreshDetail()
    }, '已选为成片镜头')
  }

  function openCandidateReview(asset: Asset) {
    if (!shotId || (asset.kind !== 'image' && asset.kind !== 'video')) return
    const knownDuration = currentClip?.asset_id === asset.id ? currentClip.source_duration_ms : null
    setCandidateReview({
      shotId, assetId: asset.id, note: reviewsByAsset.get(asset.id)?.note || '',
      durationMs: knownDuration, durationError: null,
    })
    if (asset.kind === 'video' && knownDuration === null) {
      void api<{ duration_ms: number }>(`/assets/${asset.id}/metadata`).then(({ duration_ms }) => {
        setCandidateReview((current) => current?.shotId === shotId && current.assetId === asset.id
          ? { ...current, durationMs: duration_ms } : current)
      }).catch((error: unknown) => {
        setCandidateReview((current) => current?.shotId === shotId && current.assetId === asset.id
          ? { ...current, durationError: error instanceof Error ? error.message : String(error) } : current)
      })
    }
  }

  async function saveCandidateReview(status: 'pending' | 'approved' | 'rejected') {
    if (!candidateReview) return
    const { shotId: reviewedShotId, assetId, note } = candidateReview
    const wasSelected = detail?.shots.find((shot) => shot.id === reviewedShotId)?.selected_asset_id === assetId
    await action(async () => {
      await api(finalCutPath(`/shots/${reviewedShotId}/assets/${assetId}/review`, finalCutCanvasId), json('PUT', { status, note }))
      await refreshDetail()
      setCandidateReview(null)
    }, status === 'approved' ? '候选已通过审核' : status === 'rejected'
      ? wasSelected ? '候选已拒绝并从时间线移除' : '候选已拒绝' : '审核记录已保存')
  }

  async function saveAssetToLibrary(asset: Asset) {
    if (asset.saved) return
    await action(async () => {
      await api(`/assets/${asset.id}/save`, { method: 'POST' })
      await refreshDetail()
    }, '素材已保存到资产')
  }

  async function exportVideo() {
    if (!projectId || !finalCutCanvasId || !canExport) return
    const view = activeView.current
    if (unplacedSpeechCount && !await confirm({ title: '还有配音未入片', message: `${unplacedSpeechCount} 句已选用的配音尚未设置播放位置，本次导出不会包含这些配音。`, confirmLabel: '继续导出当前成片', cancelLabel: '返回检查' })) return
    if (view !== activeView.current) return
    await action(async () => {
      await api(finalCutPath(`/projects/${projectId}/export`, finalCutCanvasId), json('POST', { allow_unplaced_speech: unplacedSpeechCount > 0 }))
      if (view === activeView.current) setTab('jobs')
      await refreshDetail()
    }, '导出任务已开始')
  }

  function openSpeech(lineId?: string, fromShot = currentShot) {
    if (!detail) return
    const line = detail.speech?.lines.find(item => item.id === lineId)
    const placement = detail.speech?.placements?.find(item => item.line_id === lineId)
    const anchor = detail.shots.find(shot => shot.id === placement?.shot_id) || fromShot
    setSpeechFocus({ lineId, sceneId: line ? line.scene_id : anchor?.source_scene_id, shotId: anchor?.id })
    setSpeechProjectId(detail.id)
  }

  async function saveProductionRange() {
    if (!projectId || !rangeDraftValid) return
    await action(async () => {
      await api(finalCutPath(`/projects/${projectId}/production-range`, finalCutCanvasId), json('PUT', rangeDraft))
      await refreshDetail()
      setShowProductionRange(false)
    }, '制作范围已更新')
  }

  function selectRangeByTarget() {
    if (!detail?.shots.length || !Number.isFinite(targetSeconds) || targetSeconds < 5) return
    const start = rangeDraft.start_shot_id ? detail.shots.findIndex(shot => shot.id === rangeDraft.start_shot_id) : 0
    if (start < 0) return
    let total = 0
    let end = start
    for (let index = start; index < detail.shots.length; index += 1) {
      const next = total + detail.shots[index]!.duration
      if (index > start && next > targetSeconds) break
      total = next
      end = index
    }
    setRangeDraft({ start_shot_id: detail.shots[start]!.id, end_shot_id: detail.shots[end]!.id })
  }

  function openScriptDirector(focusArtifact: ScriptAction = 'all', stageRequest?: WorkflowRequest, context = '', nodeSource?: CanvasNodeProposalSource) {
    setScriptDirectorContext(context)
    setScriptDirectorNodeSource(nodeSource)
    setScriptDirectorStageRequest(stageRequest)
    setScriptDirectorOpenRequest(request => request + 1)
    setScriptDirectorFocus(focusArtifact)
    setScriptEditorOpen(false)
    setScriptDirectorOpen(true)
    setTab('canvas')
  }

  function openScriptEditor(section: DocumentSection = 'outline') {
    setScriptEditorSection(section)
    // Keep the director mounted while reading/editing documents so its running
    // requests, pending messages and draft preview survive the round trip.
    setScriptEditorOpen(true)
    setTab('canvas')
  }

  async function canLeaveBasicCut() {
    if (tab !== 'studio' || finalCutMode !== 'basic' || !basicCutDirty) return true
    return confirm({ title: '离开当前剪辑？', message: '还有尚未保存的修改。离开后会保留本机草稿，返回时可恢复；也可以取消并先保存。', confirmLabel: '保留草稿并离开' })
  }

  async function changeFinalCutMode(mode: 'basic' | 'storyboard') {
    if (mode === finalCutMode || !await canLeaveBasicCut()) return
    setBasicCutDirty(false)
    setFinalCutMode(mode)
  }

  async function returnToCanvas() {
    if (!await canLeaveBasicCut()) return
    if (projectId && finalCutCanvasId) rememberCanvas(projectId, finalCutCanvasId)
    setTab('canvas')
  }

  async function selectedNav(id: Tab) {
    if (id !== tab && !await canLeaveBasicCut()) return
    if (id !== 'canvas') {
      setScriptEditorOpen(false)
    }
    setTab(id)
    setMobileMenu(false)
  }

  const continuityIssues = continuity ? continuity.shots.filter(item => item.issues.length).map(item => ({
      key: `shot-${item.shot_id}`,
      heading: item.title,
      severity: item.issues.some(issue => issue.severity === 'error') ? 'error' as const : 'warning' as const,
      checks: item.issues,
    })) : []

  async function openProject(id: string) {
    if (id !== projectId) {
      setDetail(null)
      setAssetPreview(null)
      setScriptDirectorOpen(false)
      setScriptDirectorContext('')
      setScriptDirectorNodeSource(undefined)
      setScriptDirectorStageRequest(undefined)
    }
    setProjectId(id)
    setTab('canvas')
    setMobileMenu(false)
  }

  async function switchProject(id: string | null) {
    if (!id || id === projectId || busy || assetDownload.downloading || !projects.some(project => project.id === id)) return
    if (!await canLeaveBasicCut()) return
    setBasicCutDirty(false)
    setDetail(null)
    setAssetPreview(null)
    setSelectedAssetIds([])
    setAssetNameNodes(null)
    setCandidateReview(null)
    setShowProductionRange(false)
    setShowTimelinePreview(false)
    setSpeechProjectId(null)
    setStoryboardOpen(false)
    setScriptDirectorOpen(false)
    setScriptDirectorContext('')
    setScriptDirectorNodeSource(undefined)
    setScriptDirectorStageRequest(undefined)
    setScriptEditorOpen(false)
    clearAssetFilters()
    setNotice(null)
    setProjectId(id)
  }

  const canvasOpen = tab === 'canvas' && !scriptEditorOpen
  return <div className={`app-shell ${canvasOpen ? 'canvas-workspace' : ''} ${scriptEditorOpen ? 'script-editor-fullscreen' : ''} ${tab === 'projects' ? 'projects-workspace' : ''}`}>
    <FileButton ref={fileInput} accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4" multiple onChange={files => void uploadFiles(files)}>{() => null}</FileButton>
    <aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><Clapperboard size={21} /></div>
        <div className="brand-copy"><strong>视频创作台</strong><span>我的工作区</span></div>
        <ActionIcon className="sidebar-close" variant="subtle" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><X size={19} /></ActionIcon>
      </div>
      <nav className="main-nav" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => <UnstyledButton key={id} className={tab === id ? 'active' : ''} onClick={() => selectedNav(id)} aria-label={label} aria-current={tab === id ? 'page' : undefined} title={label}><Icon size={17} /><span>{label}</span></UnstyledButton>)}
      </nav>
      <div className="sidebar-footer">
        <span className="sidebar-status-label"><span className="status-dot" /><span className="sidebar-status-text">本地工作区</span></span>
        <Tooltip label={sidebarCollapsed ? '展开导航' : '收起导航'} position="right">
          <ActionIcon className="sidebar-collapse" variant="subtle" aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </ActionIcon>
        </Tooltip>
      </div>
    </aside>
    <Drawer opened={mobileMenu} onClose={() => setMobileMenu(false)} title="视频创作台" size={260} zIndex={300} closeButtonProps={{ 'aria-label': '关闭导航' }} classNames={{ content: 'mobile-nav-panel', header: 'mobile-nav-header', body: 'mobile-nav-body' }}>
      <nav className="main-nav" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => <UnstyledButton key={id} className={tab === id ? 'active' : ''} onClick={() => selectedNav(id)} aria-label={label} aria-current={tab === id ? 'page' : undefined} title={label}><Icon size={17} /><span>{label}</span></UnstyledButton>)}
      </nav>
    </Drawer>

    <main className={`main-content ${canvasOpen ? 'is-canvas' : ''} ${tab === 'studio' ? 'is-final-cut' : ''} ${tab === 'studio' && finalCutMode === 'basic' ? 'is-basic-final-cut' : ''}`}>
      {tab !== 'projects' && !scriptEditorOpen && <header className="topbar">
        <div className="topbar-start"><ActionIcon className="mobile-toggle" variant="subtle" aria-label="打开导航" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></ActionIcon><Button className="breadcrumb-link" onClick={() => selectedNav('projects')} data-workspace-control="" variant="subtle">项目</Button><span className="breadcrumb-sep">/</span>{tab === 'skills' || tab === 'models' ? <strong>{tab === 'skills' ? '技能中心' : '模型设置'}</strong> : <Select className="header-project-switcher" aria-label="切换项目" placeholder="选择项目" value={projectId} onChange={switchProject} data={projects.map(project => ({ value: project.id, label: project.name }))} searchable allowDeselect={false} disabled={busy || assetDownload.downloading} rightSection={<ChevronDown size={14} />} comboboxProps={{ width: 340, position: 'bottom-start' }} />}{tab === 'studio' && <span className="topbar-meta">成片工作台</span>}</div>
        <div className="topbar-actions">
          {tab === 'studio' && detail && <Button variant="default" onClick={returnToCanvas} leftSection={<Layers3 size={16} />}>返回画布</Button>}
          {tab === 'studio' && <Button.Group>
            <Button variant={finalCutMode === 'basic' ? 'filled' : 'default'} aria-pressed={finalCutMode === 'basic'} onClick={() => void changeFinalCutMode('basic')}>基础剪辑</Button>
            <Button variant={finalCutMode === 'storyboard' ? 'filled' : 'default'} aria-pressed={finalCutMode === 'storyboard'} onClick={() => void changeFinalCutMode('storyboard')}>按分镜选片</Button>
          </Button.Group>}
          {detail && tab === 'studio' && <Button variant="default" onClick={() => openSpeech()} leftSection={<Mic2 size={16} />}>配音</Button>}
          {detail && storyboardCutOpen && <FinalCutOutputSettings detail={detail} onRefresh={() => refreshDetail(detail.id)} />}
          {storyboardCutOpen && latestExportAsset && <Button component="a" variant="default" href={latestExportAsset.url} download title="下载最近成片" leftSection={<Download size={16} />}>最近成片</Button>}
          {storyboardCutOpen && detail && <Button onClick={exportVideo} disabled={busy || !canExport} title={!canExport ? '请先为制作范围内的镜头选定有效片段' : '导出视频'} leftSection={<Download size={16} />}>导出视频</Button>}
          {tab !== 'canvas' && <ThemeToggle />}
        </div>
      </header>}

      {notice && <Notification className="app-notice" classNames={{ closeButton: 'app-notice-close' }} role="status" style={{ pointerEvents: 'none' }} closeButtonProps={{ 'aria-label': '关闭提示' }} onClose={() => setNotice(null)} color={notice.includes('失败') || notice.includes('错误') ? 'var(--fc-danger)' : 'var(--workspace-muted)'}>{notice}</Notification>}

      {tab === 'projects' && <section className="project-page" aria-label="项目">
        <div className="project-page-head">
          <div className="project-page-title"><div><h2>全部项目</h2>{(projectQuery || projects.length > 0) && <p>{projectQuery ? `${visibleProjects.length} / ${projects.length} 个项目` : `${projects.length} 个项目`}</p>}</div><div className="project-page-actions">{!projectSelectionMode && <Button size="sm" variant="default" disabled={busy || !projects.length} onClick={() => setProjectSelectionMode(true)}>批量管理</Button>}<ActionIcon className="mobile-toggle" variant="subtle" aria-label="打开导航" onClick={() => setMobileMenu(true)}><Menu size={20} /></ActionIcon></div></div>
          <div className="project-page-tools"><TextInput size="sm" aria-label="搜索项目" placeholder="搜索项目或简介" leftSection={<Search size={15} />} value={projectQuery} onChange={(event) => setProjectQuery(event.currentTarget.value)} /><Select size="sm" aria-label="项目排序" value={projectSort} onChange={(value) => { if (value) setProjectSort(value as typeof projectSort) }} data={[{ value: 'updated', label: '最近更新' }, { value: 'created', label: '最近创建' }, { value: 'name', label: '名称排序' }]} allowDeselect={false} /><ThemeToggle /></div>
        </div>
        {projectSelectionMode && <div className="project-batch-toolbar" role="region" aria-label="项目批量管理">
          <Checkbox label="全选当前结果" checked={visibleProjects.length > 0 && selectedVisibleProjectCount === visibleProjects.length} indeterminate={selectedVisibleProjectCount > 0 && selectedVisibleProjectCount < visibleProjects.length} disabled={busy || !visibleProjects.length} onChange={(event) => {
            const checked = event.currentTarget.checked
            setSelectedProjectIds(selected => checked ? [...new Set([...selected, ...visibleProjects.map(project => project.id)])] : selected.filter(id => !visibleProjects.some(project => project.id === id)))
          }} />
          <span className="project-batch-count" role="status">已选 {selectedProjectIds.length} 个项目{selectedProjectIds.length > selectedVisibleProjectCount && <small>（{selectedProjectIds.length - selectedVisibleProjectCount} 个不在当前结果中）</small>}</span>
          <div className="project-batch-actions">
            <Button size="sm" variant="default" disabled={busy} onClick={() => { setSelectedProjectIds([]); setProjectSelectionMode(false) }}>取消批量管理</Button>
            <Button size="sm" color="red" leftSection={<Trash2 size={15} />} loading={busy} disabled={!selectedProjectIds.length} onClick={() => void deleteSelectedProjects()}>删除所选项目</Button>
          </div>
        </div>}
        <div className="project-gallery">
          {!projectSelectionMode && <UnstyledButton className="project-card project-create" disabled={busy} onClick={() => void createProject()}><div className="project-cover project-create-cover"><span className="project-create-icon"><Plus size={28} strokeWidth={1.8} /></span><span>开始创作</span></div></UnstyledButton>}
          {visibleProjects.map((project) => { const cover = project.id === detail?.id ? detail.assets.find((asset) => asset.kind === 'image' || asset.kind === 'video') || null : projectCovers[project.id]; return <article className={`project-card${projectSelectionMode && selectedProjectIds.includes(project.id) ? ' project-card-selected' : ''}`} key={project.id}>
            <UnstyledButton className="project-card-main" disabled={busy} aria-pressed={projectSelectionMode ? selectedProjectIds.includes(project.id) : undefined} onClick={() => projectSelectionMode ? toggleProjectSelection(project.id) : openProject(project.id)}><div className="project-cover">{cover ? <AssetPreview asset={cover} compact /> : <div className="project-cover-empty"><Clapperboard size={29} strokeWidth={1.25} /><span>暂无封面</span></div>}<span className="project-cover-ratio">{project.ratio}</span></div><div className="project-card-meta"><strong className="truncate">{project.name}</strong><small>{dateLabel(project.updated_at)} 更新</small></div></UnstyledButton>
            {projectSelectionMode ? <Checkbox className="project-card-select" aria-label={`选择项目：${project.name}`} checked={selectedProjectIds.includes(project.id)} disabled={busy} onChange={() => toggleProjectSelection(project.id)} /> : <MantineMenu shadow="md" width={164} position="bottom-end">
              <MantineMenu.Target><ActionIcon className="project-card-more" variant="subtle" aria-label={`项目操作：${project.name}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={17} /></ActionIcon></MantineMenu.Target>
              <MantineMenu.Dropdown><MantineMenu.Item onClick={() => void renameProject(project)}>重命名</MantineMenu.Item><MantineMenu.Divider /><MantineMenu.Item color="red" onClick={() => { if (project.id === projectId) void deleteProject(); else void (async () => { if (!await confirm({ title: `删除项目「${project.name}」`, message: '项目中的镜头、素材和任务记录都会被删除。', confirmLabel: '删除项目', danger: true })) return; await action(async () => { await api(`/projects/${project.id}`, { method: 'DELETE' }); await refreshProjects() }, '项目已删除') })() }}>删除项目</MantineMenu.Item></MantineMenu.Dropdown>
            </MantineMenu>}
          </article> })}
          {!visibleProjects.length && <div className="project-page-empty"><Search size={24} /><strong>没有匹配的项目</strong><span>换个关键词试试，或创建一个新项目。</span></div>}
        </div>
      </section>}

      {!detail && tab !== 'models' && tab !== 'projects' && tab !== 'skills' ? <div className="empty-workspace">
        <div className="empty-workspace-icon"><Clapperboard size={31} /></div>
        <h1>还没有项目</h1><p>先创建项目，再在画布中添加内容和生成节点。</p>
        <Button onClick={() => void createProject()} leftSection={<Plus size={17} />}>新建项目</Button>
      </div> : null}

      {detail && scriptEditorOpen && <div className="script-page-host script-page-overlay">
        <ScriptEditor
          key={`script-editor-${detail.id}`}
          initialSection={scriptEditorSection}
          detail={detail}
          models={models}
          providers={providers}
          onRefresh={() => refreshDetail(detail.id)}
          onOpenModels={() => { setScriptEditorOpen(false); setTab('models') }}
          onOpenCanvas={() => { setScriptEditorOpen(false); setTab('canvas') }}
          onSupplementStage={stage => {
            openScriptDirector('all', { stage, episode_number: 0, operation: 'supplement', intent: 'stage_design' })
          }}
          onNotice={setNotice}
        />
      </div>}

      {detail && canvasOpen && <ProjectCanvas key={`project-canvas-${detail.id}`} detail={detail} models={models} providers={providers}
        initialLocation={canvasLocations.current.get(detail.id)}
        optimizedPromptDraft={optimizedPromptDraft?.projectId === detail.id ? optimizedPromptDraft : null}
        onOptimizedPromptDraftApplied={() => setOptimizedPromptDraft(null)}
        onLocationChange={location => { canvasLocations.current.set(detail.id, location) }}
        onRefresh={async () => { await refreshDetail(detail.id) }}
        onRenameProject={renameCurrentProject}
        onOpenModels={() => setTab('models')}
        onOpenScriptCreator={() => openScriptEditor()}
        onOpenSpeech={() => { setSpeechFocus({}); setSpeechProjectId(detail.id) }}
        onOpenScriptDocument={artifact => openScriptEditor(artifact.episode_number ? `episode-${artifact.episode_number}` : artifact.artifact_type)}
        registerNodeProposalActions={actions => { canvasNodeProposalActions.current = actions }}
        onOpenScriptDirector={(focusArtifact = 'all', context, source) => {
          openScriptDirector(focusArtifact, undefined, context, source)
        }}
        onNavigate={(destination) => { setScriptEditorOpen(false); setTab(destination) }} />}

      {detail && speechProjectId === detail.id && <SpeechStudio key={`speech-${detail.id}:${finalCutCanvasId || 'project'}`} projectId={detail.id} projectName={detail.name}
        scenes={detail.script.scenes} shots={detail.shots} finalCutCanvasId={finalCutCanvasId} initialLineId={speechFocus.lineId} initialSceneId={speechFocus.sceneId} initialShotId={speechFocus.shotId}
        onOpenFinalCut={() => { setSpeechProjectId(null); setTab('studio'); void refreshDetail(detail.id) }}
        onClose={() => { setSpeechProjectId(null); void refreshDetail(detail.id) }} onAssetsChanged={() => refreshDetail(detail.id)} />}

      {detail && scriptDirectorOpen && <ScriptDirectorPanel
        key={`script-director-${detail.id}`}
        hidden={scriptEditorOpen || tab !== 'canvas'}
        openRequestId={scriptDirectorOpenRequest}
        detail={detail}
        models={models}
        providers={providers}
        focusArtifact={scriptDirectorFocus}
        initialContext={scriptDirectorContext}
        canvasNodeSource={scriptDirectorNodeSource}
        onApplyCanvasNodeProposal={async proposal => {
          const actions = canvasNodeProposalActions.current
          if (!actions) throw new Error('对应画布尚未打开，请返回来源画布后再确认方案')
          return actions.apply(proposal)
        }}
        initialStageRequest={scriptDirectorStageRequest}
        onRefresh={async () => { await refreshDetail(detail.id) }}
        onClose={() => { setScriptDirectorOpen(false); setScriptDirectorContext(''); setScriptDirectorNodeSource(undefined); setScriptDirectorStageRequest(undefined); setTab('canvas') }}
        onOpenModels={() => setTab('models')}
        onOpenDocument={artifact => openScriptEditor(artifact.episode_number ? `episode-${artifact.episode_number}` : artifact.artifact_type)}
        onNotice={setNotice}
      />}

      {projectDetail && tab === 'studio' && finalCutMode === 'basic' && <BasicFinalCutStudio
        key={`basic-final-cut-${projectDetail.id}`}
        detail={projectDetail}
        sourceCanvasId={rememberedCanvas(projectDetail.id)}
        onRefresh={() => refreshDetail(projectDetail.id)}
        onOpenSpeech={lineId => openSpeech(lineId)}
        onNotice={setNotice}
        onDirtyChange={setBasicCutDirty}
      />}

      {projectDetail && storyboardCutOpen && <section className="final-cut-scope-bar" aria-label="成片制作方案">
        <Select label="制作方案" aria-label="切换成片制作方案" placeholder={finalCut.loading ? '正在读取方案…' : '选择制作方案'}
          value={finalCutCanvasId} data={finalCut.choices.map(canvas => ({ value: canvas.id, label: canvas.design_id ? canvas.name : `${canvas.name} · 默认方案` }))}
          onChange={value => { setNotice(null); finalCut.choose(value) }} allowDeselect={false} searchable disabled={busy || !finalCut.choices.length} />
        {finalCutCanvasId && <span>镜头、制作范围与成片预览随方案切换</span>}
        {!detail && <div className="final-cut-scope-state" role={finalCut.error ? 'alert' : 'status'}>
          {finalCut.error || '正在读取所选方案的镜头与成片…'}
          {finalCut.error && <Button variant="subtle" size="xs" onClick={finalCut.retry}>重新加载</Button>}
        </div>}
      </section>}

      {detail && storyboardCutOpen && <div className="studio-layout final-cut-workspace" aria-label="成片工作台">
        <section className="shot-rail" aria-label="分镜列表">
          <div className="panel-heading"><div><span className="eyebrow">入片顺序</span><h2>镜头 <span className="panel-count">{detail.shots.length}</span></h2></div></div>
          <div className="shot-list">
            {detail.shots.map((shot, index) => {
              const asset = assetMap.get(shot.selected_asset_id || '')
              return <UnstyledButton key={shot.id} className={`shot-item ${shot.id === shotId ? 'selected' : ''}`} onClick={() => setShotId(shot.id)}>
                <div className="shot-thumb"><AssetPreview asset={asset} compact /></div>
                <div className="shot-item-copy"><span className="shot-number">{String(index + 1).padStart(2, '0')} · {clipMap.has(shot.id) ? `${secondsLabel(clipDuration(clipMap.get(shot.id)))} 入片` : `${shot.duration}s 规划`}</span><strong className="truncate">{shot.title}</strong><small className="truncate">{detail.script.scenes.find((scene) => scene.id === shot.source_scene_id)?.heading || (asset ? '已选成片素材' : '待选素材')}</small></div>
                {asset && <Check className="shot-check" size={14} />}
              </UnstyledButton>
            })}
            {!detail.shots.length && <div className="rail-empty">还没有镜头</div>}
          </div>
          <Button variant="default" onClick={returnToCanvas} leftSection={<Layers3 size={16} />}>在画布制作镜头</Button>
        </section>

        <section className="workspace-center">
          {currentShot ? <>
            <div className="workspace-header"><div><span className="eyebrow">镜头 {String(shotIndex + 1).padStart(2, '0')} / {String(detail.shots.length).padStart(2, '0')}{currentScene && ` · ${currentScene.heading}`}</span><h1>{currentShot.title}</h1></div><div className="workspace-header-actions"><Tooltip label="前移镜头"><ActionIcon variant="subtle" aria-label="前移镜头" disabled={shotIndex <= 0} onClick={() => moveShot(currentShot, -1)}><ArrowUp size={17} /></ActionIcon></Tooltip><Tooltip label="后移镜头"><ActionIcon variant="subtle" aria-label="后移镜头" disabled={shotIndex === detail.shots.length - 1} onClick={() => moveShot(currentShot, 1)}><ArrowDown size={17} /></ActionIcon></Tooltip></div></div>
            <Tabs value={cutPreviewMode} onChange={value => value && setCutPreviewMode(value)} className="final-cut-preview-tabs"><Tabs.List><Tabs.Tab value="cut">实际入片</Tabs.Tab><Tabs.Tab value="source">原始素材</Tabs.Tab></Tabs.List></Tabs>
            {currentClip && cutPreviewMode === 'cut' ? <div className="final-cut-current-preview"><TimelinePreview key={`${currentShot.id}:${currentClip.id}`} clips={[currentClip]} assets={detail.assets} shots={[currentShot]} ratio={detail.ratio} speechAudio={currentSpeechAudio} audioSettings={detail.audio_settings} musicOffsetMs={currentStart} active={!showTimelinePreview && speechProjectId !== detail.id && !candidateReview}
              musicAsset={detail.assets.find(asset => asset.id === detail.music_asset_id && asset.kind === 'audio')} /></div>
              : <div className={`viewer ${detail.ratio === '9:16' ? 'viewer-portrait' : ''}`}>{selectedAsset ? <AssetPreview asset={selectedAsset} /> : <div className="viewer-overlay"><span className="viewer-reticle"><Film size={29} strokeWidth={1.3} /></span><strong>预览画面</strong><span>从下方选定成片素材后显示在这里</span></div>}</div>}
            <section className="cut-editor" aria-label="镜头衔接">
              <div className="cut-editor-head"><div><span className="eyebrow">镜头衔接</span><h2>{previousShot ? '与上一镜对照' : '开场状态'}</h2></div><span className={`cut-status ${currentClip ? 'ready' : ''}`}>{currentClip ? `实际入片 ${secondsLabel(clipDuration(currentClip))}` : '先选成片素材'}</span></div>
              {!previousShot && <div className="cut-continuity"><div><span>当前镜开始状态</span><p>{currentShot.start_state || '尚未记录'}</p></div><div><span>当前镜结束状态</span><p>{currentShot.end_state || '尚未记录'}</p></div></div>}
              {previousShot && <>
                <div className="cut-compare">
                  <CutFrame asset={previousAsset} timeMs={previousClip ? Math.max(previousClip.in_ms, previousClip.out_ms - 40) : 0} caption="上一镜 · 尾帧" />
                  <ArrowRight className="cut-compare-arrow" size={18} aria-hidden="true" />
                  <CutFrame asset={selectedAsset} timeMs={Number.isFinite(inMs) ? Math.max(0, inMs) : currentClip?.in_ms || 0} caption="当前镜 · 首帧" />
                </div>
                <div className="cut-continuity"><div><span>上一镜结束状态</span><p>{previousShot.end_state || '尚未记录'}</p></div><div><span>当前镜开始状态</span><p>{currentShot.start_state || '尚未记录'}</p></div></div>
                {currentShot.cut_note && <p className="cut-note"><strong>接镜要求</strong>{currentShot.cut_note}</p>}
                <Button variant="default" size="xs" onClick={() => void openShotInCanvas(currentShot.id)} loading={busy} leftSection={<Layers3 size={14} />}>回画布调整接镜</Button>
              </>}

            </section>
            <div className="candidates-head"><div><h2>可用素材 <Badge variant="light" color="gray">{shotAssets.length}</Badge></h2><span className="section-note">选择用于最终成片的版本</span></div><div className="candidate-head-actions"><CandidateCompare shot={currentShot} assets={detail.assets} reviews={detail.asset_reviews} selectedAssetId={currentShot.selected_asset_id} /><Button variant="default" onClick={() => fileInput.current?.click()} leftSection={<Upload size={16} />}>导入素材</Button></div></div>
            <div className="candidate-grid">
              {shotAssets.map((asset) => {
                const review = reviewsByAsset.get(asset.id)
                const status = review?.status || 'pending'
                return <div className={`candidate ${currentShot.selected_asset_id === asset.id ? 'chosen' : ''} ${status === 'rejected' ? 'rejected' : ''}`} key={asset.id}>
                <div className="candidate-media"><AssetPreview asset={asset} compact /></div>
                <div className="candidate-info"><span>{asset.source === 'upload' ? '本地导入' : models.find((model) => model.id === asset.model_id)?.name || '生成素材'}</span><small>{dateLabel(asset.created_at)}</small></div>
                {asset.kind !== 'text' && <div className="candidate-review-summary"><Badge size="xs" variant="light" color={status === 'approved' ? 'teal' : status === 'rejected' ? 'red' : 'gray'}>{reviewStatusText[status]}</Badge>{currentShot.selected_asset_id === asset.id && <span>已入片</span>}</div>}
                {review?.note && <p className="candidate-review-note" title={review.note}>{review.note}</p>}
                <div className="candidate-actions"><Button variant="default" size="xs" onClick={() => openCandidateReview(asset)} disabled={busy} leftSection={<Eye size={14} />}>审核</Button><Button variant={currentShot.selected_asset_id === asset.id ? 'light' : 'default'} color={currentShot.selected_asset_id === asset.id ? 'teal' : 'studio'} size="xs" onClick={() => selectCandidate(asset.id)} disabled={busy || status === 'rejected' || currentShot.selected_asset_id === asset.id} leftSection={currentShot.selected_asset_id === asset.id ? <Check size={14} /> : undefined}>{status === 'rejected' ? '已拒绝' : currentShot.selected_asset_id === asset.id ? '已选用' : '选为成片'}</Button>{!asset.saved && <Button variant="subtle" size="xs" onClick={() => void saveAssetToLibrary(asset)} disabled={busy} leftSection={<Save size={13} />}>保存到资产</Button>}</div>
              </div>
              })}
              {!shotAssets.length && <div className="candidate-empty"><ImageIcon size={22} /><span>该镜头还没有可用素材，请回画布制作或导入素材</span></div>}
            </div>
            {continuity && <section className="continuity-panel" aria-label="连续性检查">
              <div className="continuity-head">
                <div><strong>连续性检查</strong><span>仅检查当前制作范围的镜头与相邻接镜</span></div>
                <Button variant="default" size="xs" loading={continuityLoading} onClick={() => void refreshContinuity()} leftSection={<RefreshCcw size={14} />}>刷新检查</Button>
              </div>
              <div className="continuity-semantic-controls">
                <Select aria-label="连续性语义检查模型" placeholder="选择文本模型" value={continuityModelId || null} onChange={value => setContinuityModelId(value || '')} data={continuityModels.map(model => ({ value: model.id, label: model.name }))} disabled={semanticChecking} />
                <Button variant="default" size="xs" loading={semanticChecking} disabled={!continuityModels.some(model => model.id === continuityModelId)} onClick={() => void analyzeContinuity()}>模型检查接镜状态</Button>
                <small>{continuity.semantic_review?.status === 'checked' ? '镜头文字状态已检查' : continuity.semantic_review?.status === 'stale' ? '镜头或资料已变化，请重新进行模型检查' : '素材与时长已检查，镜头文字状态尚未进行模型检查'}</small>
              </div>
              <div className="continuity-summary">
                <Badge variant="light" color={continuity.summary.error_count ? 'red' : 'teal'}>{continuity.summary.error_count} 个错误</Badge>
                <Badge variant="light" color={continuity.summary.warning_count ? 'yellow' : 'gray'}>{continuity.summary.warning_count} 个提醒</Badge>
                <span>{continuity.summary.status === 'ready' ? '已具备进入连续预览的基础条件' : continuity.summary.status === 'warning' ? '可以预览，但建议先处理提醒' : '处理错误后再进入连续预览'}</span>
              </div>
              {continuityIssues.length ? <div className="continuity-issues">
                {continuityIssues.map((item) => <div className={`continuity-issue continuity-${item.severity}`} key={item.key}>
                  <div className="continuity-issue-head"><Badge size="xs" variant="light" color={continuitySeverityColor(item.severity)}>{continuitySeverityLabel(item.severity)}</Badge><strong>{item.heading}</strong></div>
                  <ul>{item.checks.map((check) => <li key={`${item.key}-${check.code}`}>{check.message}</li>)}</ul>
                </div>)}
              </div> : <div className="continuity-empty"><Check size={15} />未发现素材与时长问题{continuity.semantic_review?.status === 'checked' ? '，文字状态检查无提醒' : '；文字状态尚未完成模型检查'}</div>}
            </section>}
          </> : <div className="no-shot"><Clapperboard size={30} /><h2>还没有入片镜头</h2>{detail.script.scenes.length > 0 && <Button variant="default" onClick={() => openScriptEditor()} leftSection={<ScrollText size={16} />}>打开剧本创作</Button>}<Button onClick={returnToCanvas} leftSection={<Layers3 size={16} />}>前往画布制作</Button></div>}
        </section>

        <aside className="inspector final-cut-inspector" aria-label="成片片段设置">
          {currentShot ? <>
            <div className="inspector-head"><div><span className="eyebrow">当前片段</span><h2>片段设置</h2></div></div>
            <div className="inspector-scroll">
              <div className="final-cut-shot-summary"><strong>{currentShot.title}</strong><span>{selectedAsset ? selectedAsset.filename : '尚未选定成片素材'}</span><small>规划 {currentShot.duration} 秒{currentClip ? ` · 实际入片 ${secondsLabel(clipDuration(currentClip))}` : ''}</small></div>
              {currentClip ? <div className="trim-editor"><div className="trim-editor-heading"><Scissors size={16} /><strong>成片取段</strong><span>规划 {currentShot.duration}s · 素材 {currentClip.source_duration_ms === null ? '静帧' : secondsLabel(currentClip.source_duration_ms)}</span></div><div className="trim-fields"><NumberInput label="素材入点" suffix=" 秒" min={0} max={currentClip.source_duration_ms === null ? 0 : currentClip.source_duration_ms / 1000} step={0.1} decimalScale={3} hideControls disabled={currentClip.source_duration_ms === null} value={trimIn} onChange={setTrimIn} /><NumberInput label={currentClip.source_duration_ms === null ? '画面停留至' : '素材出点'} suffix=" 秒" min={0.2} max={currentClip.source_duration_ms === null ? 30 : currentClip.source_duration_ms / 1000} step={0.1} decimalScale={3} hideControls value={trimOut} onChange={setTrimOut} /><Button variant="default" onClick={saveTrim} disabled={busy || !!trimIssue || !trimChanged} leftSection={<Save size={15} />}>保存取段</Button></div>{trimIssue && <span className="trim-error" role="status">{trimIssue}</span>}{selectedAsset?.kind === 'video' && <div className="source-audio-editor"><div className="trim-editor-heading"><Music2 size={16} /><strong>片段原声</strong><span>预览与导出使用同一设置</span></div><div className="source-audio-fields"><NumberInput label="原声音量" suffix=" %" min={0} max={200} step={10} decimalScale={0} hideControls value={sourceAudioPercent} onChange={setSourceAudioPercent} /><NumberInput label="首尾淡变" suffix=" 毫秒" min={0} max={500} step={50} decimalScale={0} hideControls value={sourceAudioFadeMs} onChange={setSourceAudioFadeMs} /><Button variant="default" onClick={() => setSourceAudioPercent(Number(sourceAudioPercent) === 0 ? 100 : 0)}>{Number(sourceAudioPercent) === 0 ? '恢复原声' : '静音'}</Button><Button variant="default" onClick={saveSourceAudio} disabled={busy || !!audioIssue || !audioChanged} leftSection={<Save size={15} />}>保存原声</Button></div>{audioIssue && <span className="trim-error" role="status">{audioIssue}</span>}</div>}</div> : <p className="cut-empty">选定候选素材后，可从素材中截取自然的动作片段，成片将按这里的入点和出点导出。</p>}
              <div className="inspector-divider" />
              <FinalCutSpeechPanel detail={detail} shot={currentShot} finalCutCanvasId={finalCutCanvasId} onRefresh={() => refreshDetail(detail.id)} onOpenSpeech={lineId => openSpeech(lineId)} />
            </div>
            <div className="inspector-actions"><Button variant="default" onClick={() => void openShotInCanvas(currentShot.id)} loading={busy} leftSection={<Layers3 size={16} />}>在画布调整此镜头</Button></div>
          </> : <div className="final-cut-empty">选择一个镜头后，可设置入片区间和原声。</div>}
        </aside>
        <section className="timeline">
          <div className="timeline-head">
            <div><strong>成片时间线</strong><span className="timeline-duration">{productionRangeValid
              ? `本次 ${productionShots.length} 镜 · 可预览 ${secondsLabel(totalDurationMs)} / 规划 ${plannedDuration.toFixed(1)}s · ${readyCount}/${productionShots.length} 镜就绪`
              : '制作范围已失效，请重新选择'}</span>{productionRangeValid && <span className={`timeline-target ${totalDurationMs > targetSeconds * 1000 ? 'is-over' : ''}`}>目标约 {targetSeconds} 秒{totalDurationMs > targetSeconds * 1000 ? ` · 超出 ${secondsLabel(totalDurationMs - targetSeconds * 1000)}` : ''}</span>}</div>
            <div className="timeline-actions">
              <CutReviewPanel key={`${detail.id}:${finalCutCanvasId}`} detail={detail} finalCutCanvasId={finalCutCanvasId} onChanged={async () => { await refreshDetail(detail.id) }} />
              <Button variant="default" size="xs" onClick={() => {
                setRangeDraft({ start_shot_id: detail.production_range?.start_shot_id ?? null,
                  end_shot_id: detail.production_range?.end_shot_id ?? null })
                setShowProductionRange(true)
              }} leftSection={<Scissors size={15} />}>制作范围</Button>
              <Button variant="default" size="xs" onClick={() => setShowTimelinePreview(true)} disabled={!canPreview}
                title={canPreview ? timelinePreview.complete ? '预览制作范围内的全部镜头' : `预览 ${readyCount} 个可用镜头，跳过 ${timelinePreview.missingShots.length} 个暂不可入片的镜头` : '选定至少一个有效片段后即可预览'}
                leftSection={<Play size={15} />}>连续预览</Button>
              <Button variant="default" size="xs" onClick={exportVideo} disabled={busy || !canExport} title={!canExport ? '请先为制作范围内的镜头选定有效片段' : '导出视频'} leftSection={<Download size={15} />}>导出视频</Button>
            </div>
          </div>
          {(speechTimeline.issues.length > 0 || unplacedSpeechCount > 0) && <div className="final-cut-audio-notice" role="status">{speechTimeline.issues[0]?.message || `${unplacedSpeechCount} 句已选用配音尚未加入成片`}<Button variant="subtle" size="compact-xs" onClick={() => openSpeech(speechAttentionLineId)}>处理配音</Button></div>}
          <FinalCutTimeline shots={productionShots} clips={detail.timeline_clips} assets={detail.assets} audio={speechTimeline.audio} musicAsset={detail.assets.find(asset => asset.id === detail.music_asset_id)} selectedShotId={shotId} onSelectShot={setShotId}
            onSelectSpeech={lineId => openSpeech(lineId, detail.shots.find(shot => shot.id === detail.speech?.placements?.find(item => item.line_id === lineId)?.shot_id))} />
        </section>
      </div>}

      {detail && tab === 'assets' && <section className="page-section asset-library-page">
        <div className="asset-library-shell">
          <main className="asset-library-main" aria-label={assetLibraryView === 'history' ? '生成历史' : '个人资产库'}>
            <div className="asset-history-head">
              <div><h1>{assetLibraryView === 'history' ? '生成历史' : '个人资产库'}</h1></div>
              <div className="asset-history-actions">
                <Tooltip label={assetSort === 'newest' ? '最新创建在前' : '最早创建在前'}><ActionIcon variant="subtle" aria-label={assetSort === 'newest' ? '按创建时间倒序排列' : '按创建时间正序排列'} onClick={() => setAssetSort(current => current === 'newest' ? 'oldest' : 'newest')}>{assetSort === 'newest' ? <ArrowDownWideNarrow size={18} /> : <ArrowUpWideNarrow size={18} />}</ActionIcon></Tooltip>
                {assetLibraryView === 'personal' && <Button className="asset-import-button" variant="subtle" size="sm" disabled={busy} onClick={() => fileInput.current?.click()} leftSection={<Upload size={16} />}>导入素材</Button>}
              </div>
            </div>
            <Tabs value={assetKindFilter} onChange={value => { if (value) setAssetKindFilter(value as typeof assetKindFilter) }} activateTabWithKeyboard={true} className="asset-history-tabs-root"><Tabs.List className="asset-history-tabs" aria-label="素材类型筛选">
              {[{ value: 'all', label: '全部' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'audio', label: '音频' }, ...(assetCollection.some(asset => asset.kind === 'text') ? [{ value: 'text', label: '文本' }] : [])].map((item) => <Tabs.Tab type="button"   className={assetKindFilter === item.value ? 'active' : ''} key={item.value} onClick={() => { setAssetKindFilter(item.value as typeof assetKindFilter); setSelectedAssetIds([]) }} value={item.value}>{item.label} <span>{item.value === 'all' ? assetCollection.length : assetCollection.filter((asset) => asset.kind === item.value).length}</span></Tabs.Tab>)}
            </Tabs.List></Tabs>
            {(assetCollection.length > 0 || assetQuery) && <div className="asset-library-tools">
              <TextInput className="asset-search" aria-label="搜索素材" placeholder="搜索文件名、提示词或镜头" leftSection={<Search size={15} />} value={assetQuery} onChange={(event) => { setAssetQuery(event.currentTarget.value); setSelectedAssetIds([]) }} />
              {assetLibraryView === 'personal' && <Select aria-label="素材来源筛选" value={assetSourceFilter} onChange={(value) => { if (value) { setAssetSourceFilter(value as typeof assetSourceFilter); setSelectedAssetIds([]) } }} data={[{ value: 'all', label: '全部来源' }, { value: 'generated', label: '模型生成' }, { value: 'upload', label: '本地导入' }, { value: 'export', label: '成片导出' }]} allowDeselect={false} />}
              <div className="asset-display-controls">
                {visibleLibraryAssets.length > 0 && <Checkbox aria-label="全选当前筛选素材" checked={selectedVisibleAssetCount === visibleLibraryAssets.length} indeterminate={selectedVisibleAssetCount > 0 && selectedVisibleAssetCount < visibleLibraryAssets.length} onChange={toggleVisibleAssets} />}
                <Tooltip label={assetViewMode === 'grid' ? '切换为列表' : '切换为网格'}><ActionIcon variant="subtle" aria-label={assetViewMode === 'grid' ? '切换为列表' : '切换为网格'} onClick={() => setAssetViewMode(current => current === 'grid' ? 'list' : 'grid')}>{assetViewMode === 'grid' ? <List size={18} /> : <LayoutGrid size={18} />}</ActionIcon></Tooltip>
              </div>
            </div>}

            {selectedAssetIds.length > 0 && <div className="asset-bulk-bar"><span>已选 {selectedAssetIds.length} 个</span><div className="asset-bulk-actions"><Button size="xs" variant="default" onClick={() => void addAssetsToCanvas(selectedAssetIds)} leftSection={<Layers3 size={14} />}>加入画布</Button><Button size="xs" variant="default" onClick={() => downloadAssets(selectedAssetIds)} loading={assetDownload.downloading} leftSection={<Download size={14} />}>{assetDownload.downloading ? '准备下载' : selectedAssetIds.length > 1 ? '下载 ZIP' : '下载'}</Button><Button size="xs" variant="subtle" onClick={() => setSelectedAssetIds([])}>清除选择</Button></div></div>}
            <Dropzone className="asset-content-dropzone" enablePointerEvents activateOnClick={false} activateOnKeyboard={false} activateOnDrag={assetLibraryView === 'personal'} disabled={busy} loading={busy && assetLibraryView === 'personal'}
              onDrop={files => { if (assetLibraryView === 'personal') void uploadFiles(files) }} onReject={() => assetLibraryView === 'personal' && setNotice('仅支持 PNG/JPG/WebP、MP4/MOV、MP3/WAV/M4A，单文件不超过 300 MB')} maxSize={300 * 1024 * 1024}
              accept={['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/mp4']}>
              {assetLibraryView === 'personal' && <div className="asset-drag-hint" aria-hidden="true"><Upload size={24} /><span>松开以导入图片、视频或音频</span></div>}
            <div className={`asset-grid asset-grid-${assetViewMode}`}>{visibleLibraryAssets.map((asset) => {
          const review = reviewsByAsset.get(asset.id)
          const selected = selectedAssetIds.includes(asset.id)
          const label = assetLabels.get(asset.id)
          const title = label?.title || asset.filename
          return <div className={`library-item ${selected ? 'is-selected' : ''}`} key={asset.id}>
          <div className="library-media"><UnstyledButton className="library-preview-button" aria-label={`预览 ${title}`} onClick={() => setAssetPreview(asset)}><AssetPreview asset={asset} compact /></UnstyledButton><label className="library-select" onClick={(event) => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Checkbox aria-label={`选择 ${title}`} checked={selected} onChange={() => toggleAssetSelection(asset.id)} /></label></div>
          <div className="library-copy"><strong className="library-asset-title" title={title}>{title}</strong>{(label?.context || label?.specs) && <small className="library-asset-context">{[label.context, label.specs].filter(Boolean).join(' · ')}</small>}<small>{assetKindLabel(asset.kind)} · {assetSourceLabel(asset.source)} · {dateLabel(asset.created_at)}</small>{asset.shot_id && <small className="library-shot">镜头：{detail.shots.find((shot) => shot.id === asset.shot_id)?.title || '未命名镜头'}</small>}{shotId && review && <Badge size="xs" variant="light" color={review.status === 'approved' ? 'teal' : review.status === 'rejected' ? 'red' : 'gray'}>{reviewStatusText[review.status]}</Badge>}</div>
          <div className="library-actions"><MantineMenu shadow="md" width={210} position="bottom-end"><MantineMenu.Target><ActionIcon variant="subtle" className="asset-card-more" aria-label={`素材操作：${title}`}><MoreHorizontal size={18} /></ActionIcon></MantineMenu.Target><MantineMenu.Dropdown>
            {!asset.saved && <MantineMenu.Item leftSection={<Save size={14} />} onClick={() => void saveAssetToLibrary(asset)} disabled={busy}>保存到资产库</MantineMenu.Item>}
            {asset.kind === 'audio' && <MantineMenu.Item disabled={busy} leftSection={<Music2 size={14} />} onClick={() => action(async () => { await api(`/projects/${detail.id}`, json('PATCH', { music_asset_id: detail.music_asset_id === asset.id ? null : asset.id })); await refreshDetail() })}>{detail.music_asset_id === asset.id ? '取消用作配乐' : '用作配乐'}</MantineMenu.Item>}
            {asset.kind !== 'audio' && <MantineMenu.Item leftSection={<Layers3 size={14} />} onClick={() => void addAssetsToCanvas([asset.id])} disabled={busy}>加入画布</MantineMenu.Item>}
            <MantineMenu.Item onClick={() => downloadAssets([asset.id])} disabled={assetDownload.downloading} leftSection={<Download size={14} />}>下载素材</MantineMenu.Item>
            </MantineMenu.Dropdown></MantineMenu>
          </div>
        </div>})}</div>
            {!visibleLibraryAssets.length && <div className="asset-history-empty" role="status">
              <span>{libraryEmptyText(assetLibraryView, assetCollection.length)}</span>
              {assetCollection.length > 0 && <Button type="button" onClick={clearAssetFilters} data-workspace-control="" variant="subtle">清除筛选</Button>}
            </div>}
            </Dropzone>
          </main>
          <aside className="asset-library-rail" aria-label="资产分类">
            <UnstyledButton type="button" className={assetLibraryView === 'history' ? 'active' : ''} aria-current={assetLibraryView === 'history' ? 'page' : undefined} onClick={() => switchAssetLibrary('history')}><Clock3 size={18} /><span>生成历史</span><b>{historyAssets.length}</b></UnstyledButton>
            <UnstyledButton type="button" className={assetLibraryView === 'personal' ? 'active' : ''} aria-current={assetLibraryView === 'personal' ? 'page' : undefined} onClick={() => switchAssetLibrary('personal')}><FolderOpen size={18} /><span>个人资产库</span><b>{libraryAssets.length}</b></UnstyledButton>
          </aside>
        </div>
      </section>}

      {detail && tab === 'jobs' && <TaskRecords key={`task-records-${detail.id}`} detail={detail} models={models} providers={providers} busy={busy}
        onRefresh={() => refreshDetail(detail.id)} onPreview={setAssetPreview}
        onPromptOptimized={(job, prompt) => {
          validateOptimizedPromptReferences(job, detail)
          canvasLocations.current.set(detail.id, { view: 'canvas', storyboardId: null })
          setOptimizedPromptDraft({ id: crypto.randomUUID(), projectId: detail.id, job, prompt }); setTab('canvas')
        }}
        onOpenCanvas={id => { if (id) void openShotInCanvas(id); else setTab('canvas') }}
        onOpenSpeech={() => { setSpeechFocus({}); setSpeechProjectId(detail.id) }}
        onRetry={job => { void action(async () => { await api(`/jobs/${job.id}/retry`, { method: 'POST' }); await refreshDetail() },
          jobRecoveryPresentation(job, models.find(model => model.id === job.model_id)?.modality)?.notice || '任务已重新入队') }} />}

      {tab === 'models' && <ModelSettings providers={providers} models={models} refresh={refreshCatalog} action={action} busy={busy} />}
      {tab === 'skills' && <SkillsCenter projectId={detail?.id} projectName={detail?.name} />}
      {detail && <StoryboardPlanner key={`storyboard-planner-${detail.id}`} opened={storyboardOpen} onClose={() => setStoryboardOpen(false)} detail={detail} models={models.filter(model => providers.some(provider => provider.id === model.provider_id && provider.enabled))}
        initialSceneIds={currentScene ? [currentScene.id] : detail.script.scenes.map(scene => scene.id)} onRefresh={() => refreshDetail(detail.id)}
        onOpenCanvas={() => setTab('canvas')} onNotice={setNotice} />}
    </main>

    <Modal opened={assetPreview !== null} onClose={() => setAssetPreview(null)} title={assetPreview && assetLabels.get(assetPreview.id)?.title || assetPreview?.filename || '素材预览'} size="lg" centered>
      {assetPreview && <div className="asset-preview-modal">
        <div className="asset-preview-stage"><AssetPreview asset={assetPreview} /></div>
        <div className="asset-preview-meta">
          <div><span>类型</span><strong>{assetKindLabel(assetPreview.kind)}</strong></div>
          <div><span>来源</span><strong>{assetSourceLabel(assetPreview.source)}</strong></div>
          <div><span>创建时间</span><strong>{dateLabel(assetPreview.created_at)}</strong></div>
          <div><span>原始文件名</span><strong title={assetPreview.filename}>{assetPreview.filename}</strong></div>
          {assetLabels.get(assetPreview.id)?.context && <div><span>素材信息</span><strong>{assetLabels.get(assetPreview.id)?.context}</strong></div>}
          {assetLabels.get(assetPreview.id)?.specs && <div><span>生成规格</span><strong>{assetLabels.get(assetPreview.id)?.specs}</strong></div>}
          {assetPreview.shot_id && <div><span>关联镜头</span><strong>{detail?.shots.find((shot) => shot.id === assetPreview.shot_id)?.title || '未命名镜头'}</strong></div>}
        </div>
        {assetPreview.prompt && <div className="asset-preview-prompt"><span>生成提示词</span><p>{assetPreview.prompt}</p></div>}
        {assetPreview.text && <div className="asset-preview-prompt"><span>文本内容</span><p>{assetPreview.text}</p></div>}
        <div className="asset-preview-actions">
          <Button variant="default" onClick={() => downloadAssets([assetPreview.id])} loading={assetDownload.downloading} leftSection={<Download size={15} />}>下载素材</Button>
          {assetPreview.kind !== 'audio' && <Button onClick={() => { void addAssetsToCanvas([assetPreview.id]); setAssetPreview(null) }} leftSection={<Layers3 size={15} />}>加入画布</Button>}
          {assetPreview.shot_id && <Button variant="subtle" onClick={() => { void openShotInCanvas(assetPreview.shot_id!); setAssetPreview(null) }} disabled={busy} leftSection={<Clapperboard size={15} />}>打开关联画布</Button>}
        </div>
      </div>}
    </Modal>
    <Modal className="candidate-review-modal" opened={!!candidateReview} onClose={() => { if (!busy) setCandidateReview(null) }} closeOnEscape={!busy} closeOnClickOutside={!busy} title="候选审核" size="xl" centered>
      {candidateReview && reviewAsset && <div className="candidate-review-detail">
        <div className="candidate-review-heading"><div><strong>{detail?.shots.find((shot) => shot.id === candidateReview.shotId)?.title}</strong><span>{reviewAsset.source === 'upload' ? '本地导入' : models.find((model) => model.id === reviewAsset.model_id)?.name || '生成素材'} · {dateLabel(reviewAsset.created_at)}</span></div><Badge variant="light" color={reviewRecord?.status === 'approved' ? 'teal' : reviewRecord?.status === 'rejected' ? 'red' : 'gray'}>{reviewStatusText[reviewRecord?.status || 'pending']}</Badge></div>
        <div className="candidate-review-media"><AssetPreview asset={reviewAsset} /></div>
        {reviewAsset.kind === 'video' && (candidateReview.durationMs && candidateReview.durationMs > 0
          ? <div className="candidate-review-frames" aria-label="视频关键画面">
            {([
              { caption: '首帧', timeMs: reviewInMs },
              { caption: '中帧', timeMs: Math.floor((reviewInMs + reviewOutMs) / 2) },
              { caption: '尾帧', timeMs: Math.max(reviewInMs, reviewOutMs - 100) },
            ]).map((frame) => <CutFrame key={frame.caption} asset={reviewAsset} {...frame} />)}
          </div>
          : <div className="candidate-review-frame-status" role="status">{candidateReview.durationError || '正在读取视频关键画面…'}</div>)}
        <Textarea label="审核备注" placeholder="记录角色、动作、画面或接镜问题" minRows={3} maxRows={6} autosize maxLength={2000}
          value={candidateReview.note} onChange={(event) => setCandidateReview({ ...candidateReview, note: event.currentTarget.value })} />
        {reviewAsset.id === detail?.shots.find((shot) => shot.id === candidateReview.shotId)?.selected_asset_id &&
          <p className="candidate-review-selected-warning">拒绝当前入片版本后，该镜头会从时间线移除。</p>}
        <div className="candidate-review-actions">
          {!reviewAsset.saved && <Button variant="default" onClick={() => void saveAssetToLibrary(reviewAsset)} disabled={busy} leftSection={<Save size={15} />}>保存到资产</Button>}
          <Button variant="default" onClick={() => saveCandidateReview('pending')} disabled={busy || reviewRecord?.status !== 'approved' && reviewRecord?.status !== 'rejected' && candidateReview.note === (reviewRecord?.note || '')}>{reviewRecord?.status === 'pending' || !reviewRecord ? '保存备注' : '改为待审核'}</Button>
          <Button variant="light" color="red" onClick={() => saveCandidateReview('rejected')} disabled={busy || !candidateReview.note.trim() || reviewRecord?.status === 'rejected' && candidateReview.note === reviewRecord.note} leftSection={<X size={15} />}>{reviewAsset.id === detail?.shots.find((shot) => shot.id === candidateReview.shotId)?.selected_asset_id ? '拒绝并移出时间线' : '拒绝候选'}</Button>
          <Button color="teal" onClick={() => saveCandidateReview('approved')} disabled={busy || reviewRecord?.status === 'approved' && candidateReview.note === reviewRecord.note} leftSection={<Check size={15} />}>通过审核</Button>
        </div>
      </div>}
    </Modal>
    <Modal className="timeline-preview-modal" opened={showTimelinePreview} onClose={() => setShowTimelinePreview(false)} title="成片连续预览" size="xl" centered>
      {detail && <>
        <div className="final-cut-preview-summary">
          <div className="final-cut-preview-summary-heading"><Badge variant="light" color={timelinePreview.complete ? 'teal' : 'gray'}>{timelinePreview.complete ? '完整预览' : '部分预览'}</Badge>
            <strong>{readyCount} / {productionShots.length} 镜</strong><span>预览时长 {secondsLabel(totalDurationMs)}</span></div>
          {!timelinePreview.complete && <>
            <p>自动跳过暂不可入片的镜头，配音随画面对齐。补齐制作范围后可导出完整成片。</p>
            <Accordion className="final-cut-preview-missing" variant="default">
              <Accordion.Item value="missing"><Accordion.Control>已跳过 {timelinePreview.missingShots.length} 个镜头</Accordion.Control>
                <Accordion.Panel><div className="final-cut-preview-missing-shots">{timelinePreview.missingShots.map(shot => <Button key={shot.id} variant="subtle" size="compact-xs" onClick={() => {
                  setShowTimelinePreview(false); setShotId(shot.id)
                }} title="查看并处理此镜头">{String(shot.position + 1).padStart(2, '0')} · {shot.title}</Button>)}</div></Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </>}
        </div>
        <TimelinePreview clips={timelinePreview.clips} assets={detail.assets} shots={timelinePreview.shots} ratio={detail.ratio}
          speechAudio={timelinePreview.audio} audioSettings={detail.audio_settings}
          musicAsset={detail.assets.find((asset) => asset.id === detail.music_asset_id && asset.kind === 'audio') || null} />
      </>}
    </Modal>
    <Modal opened={showProductionRange} onClose={() => setShowProductionRange(false)} title="本次制作范围" centered>
      {detail && <div className="production-range-editor">
        <div className="production-target-field"><NumberInput label="成片目标时长" suffix=" 秒" min={5} max={600} step={1} value={productionTarget} onChange={(value) => {
          setProductionTarget(value)
          const next = Number(value)
          if (Number.isFinite(next) && next >= 5 && next <= 600) window.localStorage.setItem(`production-target:${detail.id}`, String(next))
        }} /><Button variant="default" onClick={selectRangeByTarget} disabled={!detail.shots.length || !Number.isFinite(targetSeconds) || targetSeconds < 5} leftSection={<Scissors size={15} />}>按目标选镜头</Button></div>
        <div className="production-range-fields">
          <Select label="起始镜头" placeholder="第一镜" clearable searchable value={rangeDraft.start_shot_id}
            data={detail.shots.map((shot, index) => ({ value: shot.id, label: `${String(index + 1).padStart(2, '0')} · ${shot.title}` }))}
            onChange={(value) => setRangeDraft((current) => ({ ...current, start_shot_id: value }))} />
          <Select label="结束镜头" placeholder="最后一镜" clearable searchable value={rangeDraft.end_shot_id}
            data={detail.shots.map((shot, index) => ({ value: shot.id, label: `${String(index + 1).padStart(2, '0')} · ${shot.title}` }))}
            onChange={(value) => setRangeDraft((current) => ({ ...current, end_shot_id: value }))} />
        </div>
        <div className={`production-range-summary ${!rangeDraftValid ? 'is-invalid' : ''}`} role="status">
          {rangeDraftValid
            ? `${draftShots.length} 镜 · 规划 ${draftDuration} 秒${Number.isFinite(targetSeconds) && draftDuration > targetSeconds ? ` · 超出目标 ${draftDuration - targetSeconds} 秒` : ''}`
            : detail.shots.length ? '起始镜头不能晚于结束镜头' : '请先创建分镜'}
        </div>
        {rangeDraftValid && detail.script.scenes.length > 0 && <p className="production-story-coverage">完整剧本 {detail.script.scenes.length} 场 · 约 {scriptDuration} 秒；本次镜头覆盖 {draftSceneCount} 场。剧本其他场次仍保留。</p>}
        <div className="production-range-actions">
          <Button variant="default" onClick={() => setRangeDraft({ start_shot_id: null, end_shot_id: null })}
            disabled={!detail.shots.length}>全部镜头</Button>
          <Button onClick={saveProductionRange} loading={busy} disabled={!rangeDraftValid || !rangeChanged}>应用范围</Button>
        </div>
      </div>}
    </Modal>
    {dialog}
  </div>
}

export default App
