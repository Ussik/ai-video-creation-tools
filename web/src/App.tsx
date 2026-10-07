import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon, Badge, Button, Checkbox, Modal, NumberInput,
  Menu as MantineMenu, Notification, SegmentedControl, Select, Textarea, TextInput, Tooltip,
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import {
  ArrowDown, ArrowDownWideNarrow, ArrowRight, ArrowUp, ArrowUpWideNarrow, Check, Clapperboard,
  Clock3, Download, Eye, FileText, Film, Image as ImageIcon, Layers3, LayoutGrid, List, LoaderCircle, Menu,
  MoreHorizontal, Music2, PanelLeftClose, PanelLeftOpen, Play, Plus, RefreshCcw, Save, Scissors, ScrollText, Search, Settings2,
  Sparkles, Trash2, Upload, FolderOpen, TriangleAlert, WandSparkles, X,
} from 'lucide-react'
import { api, json } from './api'
import type { Asset, ContinuityReport, Model, Modality, ProductionRange, Project, ProjectDetail, Provider, Shot, TimelineClip, VisualReferenceMode } from './api'
import VisualPreparation from './VisualPreparation'
import ModelSettings from './ModelSettings'
import TimelinePreview from './TimelinePreview'
import CutReviewPanel from './CutReviewPanel'
import CandidateCompare from './CandidateCompare'
import ProjectCanvas, { type CanvasLocation, type ScriptAction } from './ProjectCanvas'
import ScriptDirectorPanel from './ScriptDirectorPanel'
import ScriptEditor, { type DocumentSection } from './ScriptEditor'
import { useAppDialog } from './AppDialog'
import { filterLibraryAssets, libraryCollection, libraryEmptyText } from './asset-library'
import type { AssetLibraryView } from './asset-library'

type Tab = 'projects' | 'canvas' | 'studio' | 'assets' | 'jobs' | 'models'
type Generation = {
  visual_reference_mode?: VisualReferenceMode
  modality: Modality
  model_id: string
  mode: 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'edit' | 'extend'
  reference_asset_ids: string[]
  reference_video_url: string
  resolution: string
  duration: number
  ratio: string
  generate_audio: boolean
  draft: boolean
}
type Handoff = { assetId: string; modelId: string; sourceClipId: string; sourceOutMs: number }
type ShotForm = { title: string; prompt: string; duration: number; start_state: string; end_state: string; cut_note: string }
type GenerationRequest = {
  visual_reference_mode?: VisualReferenceMode
  visual_source_prompt?: string
  visual_signature?: string
  shot_id: string
  model_id: string
  prompt: string
  mode: Generation['mode']
  reference_asset_ids: string[]
  reference_video_url: string | null
  resolution: string
  duration: number
  ratio: string
  generate_audio: boolean
  draft: boolean
}
type GenerationReview = {
  projectId: string
  shot: ShotForm
  shotNumber: number
  modality: Modality
  providerName: string
  modelName: string
  remoteModelId: string
  referenceNames: string[]
  supportsAudio: boolean
  supportsDraft: boolean
  estimatedCost: string | null
  request: GenerationRequest
}
type CandidateReview = {
  shotId: string
  assetId: string
  note: string
  durationMs: number | null
  durationError: string | null
}

type CanvasStoredNode = {
  id: string
  type: 'text' | 'image' | 'video' | 'generation' | 'project_script_ref'
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

type PricingConfig = {
  currency?: string
  per_generation?: number
  per_image?: number
  per_second?: number
  per_second_by_resolution?: Record<string, number>
  per_1k_input_tokens?: number
  per_1k_output_tokens?: number
}

const initialGeneration: Generation = {
  modality: 'video', model_id: '', mode: 'text', reference_asset_ids: [],
  reference_video_url: '', resolution: '720p', duration: 5, ratio: '16:9', generate_audio: true, draft: false,
}

// 一级导航保持在四个核心工作区。项目打开后直接进入画布，
// 画布是项目内部的创作空间，不再作为独立一级菜单展示。
const tabs: { id: Tab; label: string; icon: typeof Clapperboard }[] = [
  { id: 'projects', label: '项目', icon: FolderOpen },
  { id: 'assets', label: '资产', icon: Layers3 },
  { id: 'jobs', label: '任务记录', icon: Clock3 },
  { id: 'models', label: '模型设置', icon: Settings2 },
]

const modes = [
  { value: 'text', label: '文生视频' },
  { value: 'first_frame', label: '首帧' },
  { value: 'first_last_frame', label: '首尾帧' },
  { value: 'reference', label: '参考生成' },
  { value: 'edit', label: '编辑视频' },
  { value: 'extend', label: '延长视频' },
] as const

const statusText: Record<string, string> = {
  queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败',
}
const reviewStatusText = { pending: '待审核', approved: '已通过', rejected: '已拒绝' } as const

function modelResolutions(model: Model | undefined, modality: Modality): string[] {
  const configured = model?.settings.resolutions
  if (Array.isArray(configured)) {
    const values = configured.filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (values.length) return values
  }
  return modality === 'image' ? ['1K', '1.5K', '2K'] : ['480p', '720p', '1080p']
}

function defaultResolution(model: Model | undefined, modality: Modality): string {
  const choices = modelResolutions(model, modality)
  const configured = model?.settings.default_resolution
  return typeof configured === 'string' && choices.includes(configured) ? configured : choices[0]
}

function durationBounds(model: Model | undefined): { min: number; max: number } {
  const min = typeof model?.settings.min_duration === 'number' ? model.settings.min_duration : 1
  const max = typeof model?.settings.max_duration === 'number' ? model.settings.max_duration : 120
  return { min, max }
}

function modelRatios(model: Model | undefined): string[] {
  const configured = model?.settings.ratios
  return Array.isArray(configured) && configured.every((value) => typeof value === 'string') && configured.length
    ? configured as string[] : ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']
}

function supportedVideoModes(model: Model | undefined): Generation['mode'][] {
  const configured = model?.settings.supported_modes
  const ids = Array.isArray(configured) ? configured : ['text']
  const available = modes.filter((mode) => ids.includes(mode.value)).map((mode) => mode.value)
  return available.length ? available : ['text']
}

function pricingConfig(model: Model | undefined): PricingConfig | null {
  const value = model?.settings.pricing
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as PricingConfig
}

function estimatedGenerationCost(model: Model | undefined, modality: Modality, request: GenerationRequest): string | null {
  const pricing = pricingConfig(model)
  if (!pricing) return null
  const resolutionRate = modality === 'video' && pricing.per_second_by_resolution
    ? pricing.per_second_by_resolution[request.resolution]
    : undefined
  const rate = typeof resolutionRate === 'number' ? resolutionRate : pricing.per_second
  let amount: number | undefined
  if (modality === 'video' && typeof rate === 'number') amount = rate * request.duration
  else if (modality === 'image' && typeof pricing.per_image === 'number') amount = pricing.per_image
  else if (typeof pricing.per_generation === 'number') amount = pricing.per_generation
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null
  const currency = pricing.currency || '¥'
  const digits = amount >= 100 ? 2 : amount >= 1 ? 3 : 4
  return `约 ${currency}${amount.toFixed(digits).replace(/\.?0+$/, '')}`
}

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
    : <video className="media-preview" src={asset.url} controls preload="metadata" />
  if (asset.kind === 'audio') return compact
    ? <div className="empty-preview"><Music2 size={18} /></div>
    : <audio className="audio-preview" src={asset.url} controls preload="metadata" />
  return <div className="empty-preview"><FileText size={compact ? 18 : 28} /></div>
}

function App() {
  const { confirm, prompt, dialog } = useAppDialog()
  const [projects, setProjects] = useState<Project[]>([])
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [shotId, setShotId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('projects')
  const [scriptDirectorOpen, setScriptDirectorOpen] = useState(false)
  const [scriptDirectorOpenRequest, setScriptDirectorOpenRequest] = useState(0)
  const [scriptDirectorFocus, setScriptDirectorFocus] = useState<ScriptAction>('all')
  const [scriptDirectorContext, setScriptDirectorContext] = useState('')
  const [scriptEditorSection, setScriptEditorSection] = useState<DocumentSection>('outline')
  const canvasLocations = useRef(new Map<string, CanvasLocation>())
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false)
  const [projectCovers, setProjectCovers] = useState<Record<string, Asset | null>>({})
  const [projectQuery, setProjectQuery] = useState('')
  const [projectSort, setProjectSort] = useState<'updated' | 'name' | 'created'>('updated')
  const [assetQuery, setAssetQuery] = useState('')
  const [assetKindFilter, setAssetKindFilter] = useState<'all' | Asset['kind']>('all')
  const [assetSourceFilter, setAssetSourceFilter] = useState<'all' | Asset['source']>('all')
  const [assetSort, setAssetSort] = useState<'newest' | 'oldest'>('newest')
  const [assetViewMode, setAssetViewMode] = useState<'grid' | 'list'>('grid')
  const [assetLibraryView, setAssetLibraryView] = useState<AssetLibraryView>('history')
  const [assetPreview, setAssetPreview] = useState<Asset | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [shotForm, setShotForm] = useState<ShotForm>({ title: '', prompt: '', duration: 5, start_state: '', end_state: '', cut_note: '' })
  const [generation, setGeneration] = useState<Generation>(initialGeneration)
  const [generationReview, setGenerationReview] = useState<GenerationReview | null>(null)
  const [visualPreparationOpen, setVisualPreparationOpen] = useState(false)
  const [candidateReview, setCandidateReview] = useState<CandidateReview | null>(null)
  const [trimIn, setTrimIn] = useState<number | string>(0)
  const [trimOut, setTrimOut] = useState<number | string>(0)
  const [sourceAudioPercent, setSourceAudioPercent] = useState<number | string>(100)
  const [sourceAudioFadeMs, setSourceAudioFadeMs] = useState<number | string>(0)
  const [handoffByShot, setHandoffByShot] = useState<Record<string, Handoff>>({})
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
  const [mobileMenu, setMobileMenu] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const generationSubmitting = useRef(false)
  const continuityRequest = useRef(0)
  // Detail requests can overlap while switching projects. Ignore a response
  // for an older project so its script and canvas cannot flash in the new one.
  const detailRequest = useRef(0)

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
  const productionShotIds = new Set(productionShots.map((shot) => shot.id))
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
  const currentHandoff = currentShot ? handoffByShot[currentShot.id] : undefined
  const validHandoff = !!currentHandoff && currentHandoff.sourceClipId === previousClip?.id && currentHandoff.sourceOutMs === previousClip.out_ms
  const shotAssets = detail?.assets.filter((asset) => ((asset.shot_id === shotId && asset.source !== 'export') || asset.id === currentShot?.selected_asset_id) && asset.kind !== 'audio') || []
  const imageAssets = detail?.assets.filter((asset) => asset.kind === 'image') || []
  const continuityModels = models.filter(model => model.modality === 'text' && model.enabled && providers.some(provider => provider.id === model.provider_id && provider.enabled))
  const availableModels = models.filter((model) => model.modality === generation.modality && model.enabled && providers.find((provider) => provider.id === model.provider_id)?.enabled)
  const activeModel = availableModels.find((model) => model.id === generation.model_id)
  const activeProvider = providers.find((provider) => provider.id === activeModel?.provider_id)
  const activeTemplate = JSON.stringify(activeModel?.settings.request_template ?? {})
  const supportsImageReference = generation.modality === 'image' && (activeTemplate.includes('{{image}}') || activeTemplate.includes('{{images}}'))
  const supportsAudio = generation.modality === 'video' && activeTemplate.includes('{{generate_audio}}')
  const bounds = durationBounds(activeModel)
  const availableModes = supportedVideoModes(activeModel)
  const draftVariables = activeModel?.settings.draft_variables
  const draftResolution = draftVariables && typeof draftVariables === 'object' && 'resolution' in draftVariables && typeof draftVariables.resolution === 'string' ? draftVariables.resolution : '480p'
  const totalDurationMs = productionShots.reduce((sum, shot) => sum + clipDuration(clipMap.get(shot.id)), 0)
  const plannedDuration = productionShots.reduce((sum, shot) => sum + shot.duration, 0)
  const readyCount = productionShots.filter((shot) => {
    const clip = clipMap.get(shot.id)
    const asset = assetMap.get(clip?.asset_id || '')
    return !!shot.selected_asset_id && clip?.asset_id === shot.selected_asset_id && !!asset &&
      !detail?.asset_reviews.some((review) => review.shot_id === shot.id && review.asset_id === asset.id && review.status === 'rejected') &&
      (asset.kind === 'image' || asset.kind === 'video') && clip.out_ms - clip.in_ms >= 200 && clip.in_ms >= 0 &&
      (asset.kind === 'image' ? clip.in_ms === 0 : clip.source_duration_ms !== null && clip.out_ms <= clip.source_duration_ms)
  }).length
  const canExport = productionShots.length > 0 && readyCount === productionShots.length
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
  const latestExport = detail?.jobs.find((job) => job.job_type === 'export' && job.status === 'succeeded')
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
  const libraryAssets = useMemo(() => libraryCollection(detail?.assets || [], 'personal'), [detail])
  const historyAssets = useMemo(() => libraryCollection(detail?.assets || [], 'history'), [detail])
  const assetCollection = assetLibraryView === 'history' ? historyAssets : libraryAssets
  const visibleLibraryAssets = useMemo(() => {
    if (!detail) return []
    return filterLibraryAssets(assetCollection, detail.shots, { kind: assetKindFilter, source: assetSourceFilter, query: assetQuery, sort: assetSort })
  }, [assetCollection, assetKindFilter, assetQuery, assetSort, assetSourceFilter, detail])
  const selectedVisibleAssetCount = visibleLibraryAssets.filter((asset) => selectedAssetIds.includes(asset.id)).length
  const referenceCount = generation.reference_asset_ids.length
  const visualBindings = (detail?.shot_visual_bindings || []).filter(binding => binding.shot_id === currentShot?.id)
  const generationIssue = generation.modality === 'video'
    ? generation.mode === 'first_frame' && referenceCount !== 1 ? '首帧模式需要选 1 张图片'
      : generation.mode === 'first_last_frame' && referenceCount !== 2 ? '首尾帧模式需要选 2 张图片'
        : ['edit', 'extend'].includes(generation.mode) && !generation.reference_video_url.trim() ? '编辑或延长需要填写参考视频地址'
          : generation.mode === 'reference' && referenceCount === 0 && !generation.reference_video_url.trim() && !(visualBindings.length && (generation.visual_reference_mode || 'profiles') === 'profiles') ? '参考生成需要图片或视频地址'
            : null
    : null

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
    return next
  }

  async function refreshDetail(id = projectId) {
    if (!id) return
    const requestId = ++detailRequest.current
    const next = await api<ProjectDetail>(`/projects/${id}`)
    if (requestId !== detailRequest.current || id !== projectId) return next
    setDetail(next)
    void refreshContinuity(id).catch(report)
    return next
  }

  async function refreshContinuity(id = projectId) {
    if (!id) return
    const requestId = ++continuityRequest.current
    setContinuityLoading(true)
    try {
      const next = await api<ContinuityReport>(`/projects/${id}/continuity`)
      if (requestId === continuityRequest.current) setContinuity(next)
      return next
    } finally {
      if (requestId === continuityRequest.current) setContinuityLoading(false)
    }
  }

  async function analyzeContinuity() {
    if (!projectId || !continuityModelId || semanticChecking) return
    const targetProject = projectId
    setSemanticChecking(true)
    try {
      await api(`/projects/${targetProject}/continuity/analyze`, json('POST', { model_id: continuityModelId }))
      await refreshContinuity(targetProject)
    } catch (error) { report(error) } finally { setSemanticChecking(false) }
  }

  function report(error: unknown) {
    setNotice(error instanceof Error ? error.message : String(error))
  }

  async function action(task: () => Promise<unknown>, success?: string) {
    setBusy(true)
    setNotice(null)
    try {
      await task()
      if (success) setNotice(success)
    } catch (error) {
      report(error)
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
    setRangeDraft({ start_shot_id: detail?.production_range?.start_shot_id ?? null,
      end_shot_id: detail?.production_range?.end_shot_id ?? null })
  }, [detail?.id, detail?.production_range?.start_shot_id, detail?.production_range?.end_shot_id])

  useEffect(() => {
    if (!projectId) return
    const saved = Number(window.localStorage.getItem(`production-target:${projectId}`))
    setProductionTarget(Number.isFinite(saved) && saved >= 5 && saved <= 600 ? saved : 45)
  }, [projectId])

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
        const cover = projectDetail.assets.find((asset) => asset.source === 'export' && asset.kind === 'video')
          || projectDetail.shots.map((shot) => projectDetail.assets.find((asset) => asset.id === shot.selected_asset_id)).find((asset): asset is Asset => !!asset && (asset.kind === 'image' || asset.kind === 'video'))
          || null
        return [project.id, cover] as const
      } catch {
        return [project.id, null] as const
      }
    })).then((covers) => { if (!cancelled) setProjectCovers(Object.fromEntries(covers)) })
    return () => { cancelled = true }
  }, [projects, tab])

  useEffect(() => {
    if (!projectId) return
    setSelectedAssetIds([])
    setDetail(null)
    setSelectedAssetIds([])
    setAssetPreview(null)
    setShotId(null)
    setGenerationReview(null)
    setCandidateReview(null)
    setHandoffByShot({})
    setShowTimelinePreview(false)
    continuityRequest.current += 1
    setContinuity(null)
    refreshDetail(projectId).then((next) => {
      if (next?.shots.length) setShotId(next.shots[0].id)
    }).catch(report)
    const timer = window.setInterval(() => refreshDetail(projectId).catch(report), 4000)
    return () => window.clearInterval(timer)
  }, [projectId])

  useEffect(() => {
    const shot = detail?.shots.find((item) => item.id === shotId)
    if (!shot) return
    const priorShot = detail?.shots.find((item) => item.position === shot.position - 1)
    const sourceClip = detail?.timeline_clips.find((clip) => clip.shot_id === priorShot?.id)
    const handoff = handoffByShot[shot.id]
    const restored = handoff && sourceClip && handoff.sourceClipId === sourceClip.id && handoff.sourceOutMs === sourceClip.out_ms
      ? handoff : undefined
    setShotForm({ title: shot.title, prompt: shot.prompt, duration: shot.duration, start_state: shot.start_state || '', end_state: shot.end_state || '', cut_note: shot.cut_note || '' })
    setGeneration((current) => ({
      ...current, modality: restored ? 'video' : current.modality,
      model_id: restored?.modelId || current.model_id,
      duration: Math.min(bounds.max, Math.max(bounds.min, shot.duration)), ratio: detail?.ratio || '16:9',
      mode: restored ? 'first_frame' : current.mode,
      reference_asset_ids: restored ? [restored.assetId] : [], reference_video_url: '',
    }))
  }, [shotId])

  useEffect(() => {
    setTrimIn((currentClip?.in_ms ?? 0) / 1000)
    setTrimOut((currentClip?.out_ms ?? 0) / 1000)
    setSourceAudioPercent(Math.round((currentClip?.source_audio_gain ?? 1) * 100))
    setSourceAudioFadeMs(currentClip?.source_audio_fade_ms ?? 0)
  }, [shotId, currentClip?.id, currentClip?.asset_id])

  useEffect(() => {
    if (!availableModels.some((model) => model.id === generation.model_id)) {
      setGeneration((current) => ({ ...current, model_id: availableModels[0]?.id || '', resolution: defaultResolution(availableModels[0], current.modality) }))
    }
  }, [generation.modality, generation.model_id, models, providers])

  useEffect(() => {
    if (!activeModel) return
    const { min, max } = durationBounds(activeModel)
    if ((generation.modality !== 'text' && !modelResolutions(activeModel, generation.modality).includes(generation.resolution)) || generation.duration < min || generation.duration > max) {
      setGeneration((current) => ({
        ...current,
        resolution: current.modality === 'text' ? current.resolution : modelResolutions(activeModel, current.modality).includes(current.resolution) ? current.resolution : defaultResolution(activeModel, current.modality),
        duration: Math.min(max, Math.max(min, current.duration)),
      }))
    }
  }, [activeModel, generation.modality, generation.resolution])

  useEffect(() => {
    if (generation.modality === 'video' && !availableModes.includes(generation.mode)) {
      setGeneration((current) => ({ ...current, mode: availableModes[0], reference_asset_ids: [], reference_video_url: '' }))
    }
  }, [generation.modality, generation.mode, activeModel])

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

  async function duplicateProject(project: Project) {
    await action(async () => {
      const created = await api<Project>('/projects', json('POST', {
        name: `${project.name} 副本`, brief: project.brief, ratio: project.ratio,
      }))
      await refreshProjects()
      setDetail(null)
      setProjectId(created.id)
      setTab('canvas')
    }, '已复制项目设置，新项目从空画布开始')
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
      const canvas = await api<CanvasSnapshot>(`/projects/${projectId}/canvas`)
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
        title: asset.filename, text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id,
        shot_id: asset.shot_id, model_id: null, job_id: null, prompt: '', settings: {},
      }))
      await api(`/projects/${projectId}/canvas`, json('PUT', { ...canvas, nodes: [...canvas.nodes, ...nodes] }))
      setSelectedAssetIds([])
      setTab('canvas')
      setNotice(skipped ? `已加入 ${addable.length} 个素材，${skipped} 个素材因画布容量上限未加入` : `${addable.length} 个素材已加入画布`)
    }, undefined)
  }

  function downloadAssets(assetIds: string[]) {
    const assets = (detail?.assets || []).filter((asset) => assetIds.includes(asset.id))
    assets.forEach((asset, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement('a')
        anchor.href = asset.url
        anchor.download = asset.filename
        anchor.target = '_blank'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }, index * 120)
    })
    setNotice(assets.length > 1 ? `已开始下载 ${assets.length} 个素材` : '已开始下载素材')
  }

  async function saveShot() {
    if (!shotId) return
    await api<Shot>(`/shots/${shotId}`, json('PATCH', shotForm))
    await refreshDetail()
  }

  async function saveTrim() {
    if (!currentClip || trimIssue || !trimChanged) return
    await action(async () => {
      await api(`/timeline-clips/${currentClip.id}`, json('PATCH', { in_ms: inMs, out_ms: outMs }))
      await refreshDetail()
    }, '入片区间已保存')
  }

  async function saveSourceAudio() {
    if (!currentClip || audioIssue || !audioChanged) return
    await action(async () => {
      await api(`/timeline-clips/${currentClip.id}`, json('PATCH', {
        source_audio_gain: audioGain, source_audio_fade_ms: audioFade,
      }))
      await refreshDetail()
    }, '片段原声设置已保存')
  }

  async function usePreviousTail() {
    if (!currentShot || !previousClip || !previousAsset) return
    const videoModel = activeModel?.modality === 'video' && availableModes.includes('first_frame') ? activeModel
      : models.find((model) => model.modality === 'video' && model.enabled && providers.find((provider) => provider.id === model.provider_id)?.enabled && supportedVideoModes(model).includes('first_frame'))
    if (!videoModel) {
      setNotice('请先启用支持首帧生成的视频模型')
      return
    }
    await action(async () => {
      const priorHandoff = handoffByShot[currentShot.id]
      const reusable = priorHandoff?.sourceClipId === previousClip.id && priorHandoff?.sourceOutMs === previousClip.out_ms
        ? assetMap.get(priorHandoff.assetId) : undefined
      const image = reusable || (previousAsset.kind === 'image' ? previousAsset
        : await api<Asset>(`/timeline-clips/${previousClip.id}/tail-frame`, { method: 'POST' }))
      setHandoffByShot((current) => ({ ...current, [currentShot.id]: { assetId: image.id, modelId: videoModel.id, sourceClipId: previousClip.id, sourceOutMs: previousClip.out_ms } }))
      setGeneration((current) => ({
        ...current, modality: 'video', model_id: videoModel.id, mode: 'first_frame',
        reference_asset_ids: [image.id], reference_video_url: '',
        resolution: defaultResolution(videoModel, 'video'),
        duration: Math.min(durationBounds(videoModel).max, Math.max(durationBounds(videoModel).min, currentShot.duration)),
      }))
      await refreshDetail()
    }, '已将上一镜尾帧设为当前镜头首帧')
  }

  async function addShot(sourceSceneId?: string) {
    if (!projectId) return
    await action(async () => {
      const count = detail?.shots.length || 0
      const sourceScene = detail?.script.scenes.find((scene) => scene.id === sourceSceneId)
      const sourceCount = detail?.shots.filter((shot) => shot.source_scene_id === sourceSceneId).length || 0
      const created = await api<Shot>(`/projects/${projectId}/shots`, json('POST', {
        title: sourceScene ? `${sourceScene.heading} · 镜头 ${sourceCount + 1}`.slice(0, 120) : `镜头 ${String(count + 1).padStart(2, '0')}`,
        prompt: sourceScene ? [sourceScene.heading, sourceScene.action].filter(Boolean).join('\n') : '',
        duration: 5,
        ...(sourceScene ? { source_scene_id: sourceScene.id } : {}),
      }))
      if (sourceScene && currentShot?.source_scene_id === sourceScene.id) {
        await api(`/shots/${created.id}`, json('PATCH', { position: currentShot.position + 1 }))
      }
      await refreshDetail()
      setShotId(created.id)
      setTab('canvas')
    })
  }

  async function moveShot(shot: Shot, direction: number) {
    await action(async () => {
      await api(`/shots/${shot.id}`, json('PATCH', { position: Math.max(0, shot.position + direction) }))
      await refreshDetail()
    })
  }

  async function deleteShot(shot: Shot) {
    if (!await confirm({ title: `删除「${shot.title}」`, message: '已生成的素材仍保留在素材库。', confirmLabel: '删除镜头', danger: true })) return
    await action(async () => {
      await api(`/shots/${shot.id}`, { method: 'DELETE' })
      const next = await refreshDetail()
      setShotId(next?.shots[0]?.id || null)
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

  function reviewGeneration() {
    if (busy || !projectId || !currentShot || !activeModel || !shotForm.prompt.trim() || generationIssue) return
    const input: GenerationRequest = {
      visual_reference_mode: generation.visual_reference_mode || 'profiles',
      shot_id: currentShot.id,
      model_id: activeModel.id,
      prompt: shotForm.prompt.trim(),
      mode: generation.modality === 'video' ? generation.mode : 'text',
      reference_asset_ids: [...generation.reference_asset_ids],
      reference_video_url: generation.reference_video_url || null,
      resolution: generation.resolution,
      duration: generation.duration,
      ratio: generation.modality === 'video' && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(generation.mode) ? 'adaptive' : generation.ratio,
      generate_audio: generation.generate_audio,
      draft: generation.draft,
    }
    void action(async () => {
      const request = await api<GenerationRequest>(`/projects/${projectId}/generate/preview`, json('POST', input))
      setGenerationReview({
        projectId,
        shot: { ...shotForm },
        shotNumber: shotIndex + 1,
        modality: generation.modality,
        providerName: activeProvider?.name || '未命名提供商',
        modelName: activeModel.name,
        remoteModelId: activeModel.remote_id,
        referenceNames: request.reference_asset_ids.map((id) => assetMap.get(id)?.filename || id),
        supportsAudio,
        supportsDraft: generation.modality === 'video' && activeModel.settings.supports_draft === true,
        estimatedCost: estimatedGenerationCost(activeModel, generation.modality, request),
        request,
      })
    })
  }

  async function generateCandidate() {
    const review = generationReview
    if (!review || generationSubmitting.current) return
    generationSubmitting.current = true
    setBusy(true)
    setNotice(null)
    try {
      await api<Shot>(`/shots/${review.request.shot_id}`, json('PATCH', review.shot))
      await api(`/projects/${review.projectId}/generate`, json('POST', review.request))
      setGenerationReview(null)
      setNotice('任务已加入队列')
      try {
        await refreshDetail(review.projectId)
      } catch {
        setNotice('任务已入队，任务记录刷新失败，请稍后手动刷新')
      }
    } catch (error) {
      setGenerationReview(null)
      setNotice(`提交未完成或状态未确认，请先查看任务记录。${error instanceof Error ? error.message : String(error)}`)
    } finally {
      generationSubmitting.current = false
      setBusy(false)
    }
  }

  async function selectCandidate(assetId: string) {
    if (!shotId || currentShot?.selected_asset_id === assetId) return
    await action(async () => {
      await api(`/shots/${shotId}/selection`, json('PUT', { asset_id: assetId }))
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
      await api(`/shots/${reviewedShotId}/assets/${assetId}/review`, json('PUT', { status, note }))
      await refreshDetail()
      setCandidateReview(null)
    }, status === 'approved' ? '候选已通过审核' : status === 'rejected'
      ? wasSelected ? '候选已拒绝并从时间线移除' : '候选已拒绝' : '审核记录已保存')
  }

  async function useLibraryAsset(assetId: string) {
    if (!shotId || currentShot?.selected_asset_id === assetId) return
    await action(async () => {
      await api(`/shots/${shotId}/selection`, json('PUT', { asset_id: assetId }))
      await refreshDetail()
      setTab('canvas')
    }, '素材已选入当前镜头')
  }

  async function saveAssetToLibrary(asset: Asset) {
    if (asset.saved) return
    await action(async () => {
      await api(`/assets/${asset.id}/save`, { method: 'POST' })
      await refreshDetail()
    }, '素材已保存到资产')
  }

  async function exportVideo() {
    if (!projectId) return
    await action(async () => {
      await api(`/projects/${projectId}/export`, { method: 'POST' })
      setTab('jobs')
      await refreshDetail()
    }, '导出任务已开始')
  }

  async function saveProductionRange() {
    if (!projectId || !rangeDraftValid) return
    await action(async () => {
      await api(`/projects/${projectId}/production-range`, json('PUT', rangeDraft))
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

  function toggleReference(id: string) {
    setGeneration((current) => ({
      ...current,
      reference_asset_ids: current.reference_asset_ids.includes(id)
        ? current.reference_asset_ids.filter((item) => item !== id)
        : [...current.reference_asset_ids, id].slice(0, current.modality === 'video' && current.mode === 'first_frame' ? 1 : current.mode === 'first_last_frame' ? 2 : 10),
    }))
  }

  function openScriptDirector(focusArtifact: ScriptAction = 'all') {
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

  function selectedNav(id: Tab) {
    if (id !== 'canvas') {
      setScriptDirectorOpen(false)
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
    }
    setProjectId(id)
    setScriptDirectorOpen(false)
    setTab('canvas')
    setMobileMenu(false)
  }

  const canvasOpen = tab === 'canvas' && !scriptEditorOpen
  return <div className={`app-shell ${canvasOpen ? 'canvas-workspace' : ''} ${scriptEditorOpen ? 'script-editor-fullscreen' : ''} ${tab === 'projects' ? 'projects-workspace' : ''}`}>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4" multiple hidden onChange={(event) => uploadFiles(event.target.files)} />
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><Clapperboard size={21} /></div>
        <div className="brand-copy"><strong>视频创作台</strong><span>我的工作区</span></div>
        <ActionIcon className="sidebar-close" variant="subtle" aria-label="关闭导航" onClick={() => setMobileMenu(false)}><X size={19} /></ActionIcon>
      </div>
      <nav className="main-nav" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => selectedNav(id)} title={label}><Icon size={17} /><span>{label}</span></button>)}
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
    {mobileMenu && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}

    <main className={`main-content ${canvasOpen ? 'is-canvas' : ''}`}>
      {tab !== 'projects' && !scriptEditorOpen && <header className="topbar">
        <div className="topbar-start"><ActionIcon className="mobile-toggle" variant="subtle" aria-label="打开导航" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></ActionIcon><button className="breadcrumb-link" onClick={() => selectedNav('projects')}>项目</button><span className="breadcrumb-sep">/</span><strong>{tab === 'models' ? '模型设置' : detail?.name || '未选择项目'}</strong></div>
        <div className="topbar-actions">
          {tab === 'studio' && detail && <Button variant="default" onClick={() => setTab('canvas')} leftSection={<Layers3 size={16} />}>返回画布</Button>}
          {tab === 'studio' && detail && <span className="topbar-meta">{detail.shots.length} 个镜头 · {detail.ratio}</span>}
          {tab === 'studio' && latestExportAsset && <Button component="a" variant="default" href={latestExportAsset.url} download title="下载最近成片" leftSection={<Download size={16} />}>最近成片</Button>}
          {tab === 'studio' && detail && <Button onClick={exportVideo} disabled={busy || !canExport} title={!canExport ? '请先为制作范围内的镜头选定有效片段' : '导出视频'} leftSection={<Download size={16} />}>导出视频</Button>}
        </div>
      </header>}

      {notice && <Notification className="app-notice" classNames={{ closeButton: 'app-notice-close' }} role="status" style={{ pointerEvents: 'none' }} closeButtonProps={{ 'aria-label': '关闭提示' }} onClose={() => setNotice(null)} color={notice.includes('失败') || notice.includes('错误') ? 'var(--fc-danger)' : 'var(--workspace-muted)'}>{notice}</Notification>}

      {tab === 'projects' && <section className="project-page" aria-label="项目">
        <div className="project-page-head">
          <div><h1>项目</h1>{(projectQuery || projects.length > 0) && <p>{projectQuery ? `${visibleProjects.length} / ${projects.length} 个项目` : `${projects.length} 个项目`}</p>}</div>
          <div className="project-page-tools"><TextInput size="sm" aria-label="搜索项目" placeholder="搜索项目或简介" leftSection={<Search size={15} />} value={projectQuery} onChange={(event) => setProjectQuery(event.currentTarget.value)} /><Select size="sm" aria-label="项目排序" value={projectSort} onChange={(value) => { if (value) setProjectSort(value as typeof projectSort) }} data={[{ value: 'updated', label: '最近更新' }, { value: 'created', label: '最近创建' }, { value: 'name', label: '名称排序' }]} allowDeselect={false} /></div>
        </div>
        <div className="project-gallery">
          <button className="project-card project-create" onClick={() => void createProject()}><div className="project-cover project-create-cover"><span className="project-create-icon"><Plus size={28} strokeWidth={1.8} /></span><span>开始创作</span></div></button>
          {visibleProjects.map((project) => { const cover = project.id === detail?.id ? detail.assets.find((asset) => asset.source === 'export' && asset.kind === 'video') || detail.shots.map((shot) => detail.assets.find((asset) => asset.id === shot.selected_asset_id)).find((asset): asset is Asset => !!asset && (asset.kind === 'image' || asset.kind === 'video')) || projectCovers[project.id] : projectCovers[project.id]; return <article className="project-card" key={project.id}>
            <button className="project-card-main" onClick={() => openProject(project.id)}><div className="project-cover">{cover ? <AssetPreview asset={cover} compact /> : <div className="project-cover-empty"><Clapperboard size={29} strokeWidth={1.25} /><span>暂无封面</span></div>}<span className="project-cover-ratio">{project.ratio}</span></div><div className="project-card-meta"><strong className="truncate">{project.name}</strong><small>{dateLabel(project.updated_at)} 更新</small></div></button>
            <MantineMenu shadow="md" width={164} position="bottom-end">
              <MantineMenu.Target><ActionIcon className="project-card-more" variant="subtle" aria-label={`项目操作：${project.name}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={17} /></ActionIcon></MantineMenu.Target>
              <MantineMenu.Dropdown><MantineMenu.Item onClick={() => void renameProject(project)}>重命名</MantineMenu.Item><MantineMenu.Item onClick={() => void duplicateProject(project)}>复制项目设置</MantineMenu.Item><MantineMenu.Item onClick={() => void openProject(project.id)}>打开项目</MantineMenu.Item><MantineMenu.Divider /><MantineMenu.Item color="red" onClick={() => { if (project.id === projectId) void deleteProject(); else void (async () => { if (!await confirm({ title: `删除项目「${project.name}」`, message: '项目中的镜头、素材和任务记录都会被删除。', confirmLabel: '删除项目', danger: true })) return; await action(async () => { await api(`/projects/${project.id}`, { method: 'DELETE' }); await refreshProjects() }, '项目已删除') })() }}>删除项目</MantineMenu.Item></MantineMenu.Dropdown>
            </MantineMenu>
          </article> })}
          {!visibleProjects.length && <div className="project-page-empty"><Search size={24} /><strong>没有匹配的项目</strong><span>换个关键词试试，或创建一个新项目。</span></div>}
        </div>
      </section>}

      {!detail && tab !== 'models' && tab !== 'projects' ? <div className="empty-workspace">
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
          onNotice={setNotice}
        />
      </div>}

      {detail && canvasOpen && <ProjectCanvas key={detail.id} detail={detail} models={models} providers={providers}
        initialLocation={canvasLocations.current.get(detail.id)}
        onLocationChange={location => { canvasLocations.current.set(detail.id, location) }}
        onRefresh={async () => { await refreshDetail(detail.id) }}
        onRenameProject={renameCurrentProject}
        onOpenModels={() => setTab('models')}
        onOpenScriptCreator={() => openScriptEditor()}
        onOpenScriptDocument={artifact => openScriptEditor(artifact.episode_number ? `episode-${artifact.episode_number}` : artifact.artifact_type)}
        onOpenScriptDirector={(focusArtifact = 'all', context) => {
          setScriptDirectorContext(context || '')
          openScriptDirector(focusArtifact)
        }}
        onNavigate={(destination) => { setScriptDirectorOpen(false); setTab(destination) }} />}

      {detail && scriptDirectorOpen && <ScriptDirectorPanel
        key={`script-director-${detail.id}`}
        hidden={scriptEditorOpen}
        openRequestId={scriptDirectorOpenRequest}
        detail={detail}
        models={models}
        providers={providers}
        focusArtifact={scriptDirectorFocus}
        initialContext={scriptDirectorContext}
        onRefresh={async () => { await refreshDetail(detail.id) }}
        onClose={() => { setScriptDirectorOpen(false); setScriptDirectorContext(''); setTab('canvas') }}
        onOpenModels={() => setTab('models')}
        onOpenDocument={artifact => openScriptEditor(artifact.episode_number ? `episode-${artifact.episode_number}` : artifact.artifact_type)}
        onNotice={setNotice}
      />}

      {detail && tab === 'studio' && <div className="studio-layout">
        <section className="shot-rail" aria-label="分镜列表">
          <div className="panel-heading"><div><span className="eyebrow">镜头顺序</span><h2>分镜 <span className="panel-count">{detail.shots.length}</span></h2></div><Tooltip label="添加镜头"><ActionIcon variant="subtle" aria-label="添加镜头" onClick={() => addShot()}><Plus size={18} /></ActionIcon></Tooltip></div>
          <div className="shot-list">
            {detail.shots.map((shot, index) => {
              const asset = assetMap.get(shot.selected_asset_id || '')
              return <button key={shot.id} className={`shot-item ${shot.id === shotId ? 'selected' : ''}`} onClick={() => setShotId(shot.id)}>
                <div className="shot-thumb"><AssetPreview asset={asset} compact /></div>
                <div className="shot-item-copy"><span className="shot-number">{String(index + 1).padStart(2, '0')} · {clipMap.has(shot.id) ? `${secondsLabel(clipDuration(clipMap.get(shot.id)))} 入片` : `${shot.duration}s 规划`}</span><strong className="truncate">{shot.title}</strong><small className="truncate">{detail.script.scenes.find((scene) => scene.id === shot.source_scene_id)?.heading || (asset ? '已选成片素材' : '待选素材')}</small></div>
                {asset && <Check className="shot-check" size={14} />}
              </button>
            })}
            {!detail.shots.length && <div className="rail-empty">还没有镜头</div>}
          </div>
          {currentScene && <Button className="add-scene-shot-button" variant="default" onClick={() => addShot(currentScene.id)} leftSection={<Plus size={16} />}>本场新增镜头</Button>}
          <Button className="add-shot-button" variant="subtle" onClick={() => addShot()} leftSection={<Plus size={16} />}>添加镜头</Button>
        </section>

        <section className="workspace-center">
          {currentShot ? <>
            <div className="workspace-header"><div><span className="eyebrow">镜头 {String(currentShot.position + 1).padStart(2, '0')} / {String(detail.shots.length).padStart(2, '0')}{currentScene && ` · ${currentScene.heading}`}</span><h1>{currentShot.title}</h1></div><div className="workspace-header-actions"><Tooltip label="前移镜头"><ActionIcon variant="subtle" aria-label="前移镜头" disabled={currentShot.position === 0} onClick={() => moveShot(currentShot, -1)}><ArrowUp size={17} /></ActionIcon></Tooltip><Tooltip label="后移镜头"><ActionIcon variant="subtle" aria-label="后移镜头" disabled={currentShot.position === detail.shots.length - 1} onClick={() => moveShot(currentShot, 1)}><ArrowDown size={17} /></ActionIcon></Tooltip><Tooltip label="删除镜头"><ActionIcon variant="subtle" color="red" aria-label="删除镜头" onClick={() => deleteShot(currentShot)}><Trash2 size={17} /></ActionIcon></Tooltip></div></div>
            <div className={`viewer ${detail.ratio === '9:16' ? 'viewer-portrait' : ''}`}>{selectedAsset ? <AssetPreview asset={selectedAsset} /> : <div className="viewer-overlay"><span className="viewer-reticle"><Film size={29} strokeWidth={1.3} /></span><strong>预览画面</strong><span>选择候选素材后显示在这里</span></div>}</div>
            <section className="cut-editor" aria-label="镜头取段与接镜">
              <div className="cut-editor-head"><div><span className="eyebrow">镜头衔接</span><h2>取段与接镜</h2></div><span className={`cut-status ${currentClip ? 'ready' : ''}`}>{currentClip ? `实际入片 ${secondsLabel(clipDuration(currentClip))}` : '先选成片素材'}</span></div>
              {previousShot && <>
                <div className="cut-compare">
                  <CutFrame asset={previousAsset} timeMs={previousClip ? Math.max(previousClip.in_ms, previousClip.out_ms - 40) : 0} caption="上一镜 · 尾帧" />
                  <ArrowRight className="cut-compare-arrow" size={18} aria-hidden="true" />
                  <CutFrame asset={selectedAsset} timeMs={Number.isFinite(inMs) ? Math.max(0, inMs) : currentClip?.in_ms || 0} caption="当前镜 · 首帧" />
                </div>
                <div className="cut-continuity"><div><span>上一镜结束状态</span><p>{previousShot.end_state || '尚未记录'}</p></div><div><span>当前镜开始状态</span><p>{shotForm.start_state || '尚未记录'}</p></div></div>
                {shotForm.cut_note && <p className="cut-note"><strong>接镜要求</strong>{shotForm.cut_note}</p>}
                <Button className="tail-reference-button" variant="default" size="xs" onClick={usePreviousTail} loading={busy} disabled={!previousClip || !previousAsset} leftSection={<ImageIcon size={14} />}>{validHandoff && generation.reference_asset_ids.includes(currentHandoff.assetId) ? '已作为首帧参考' : '使用上一镜尾帧作为首帧'}</Button>
              </>}
              {currentClip ? <div className="trim-editor"><div className="trim-editor-heading"><Scissors size={16} /><strong>成片取段</strong><span>规划 {currentShot.duration}s · 素材 {currentClip.source_duration_ms === null ? '静帧' : secondsLabel(currentClip.source_duration_ms)}</span></div><div className="trim-fields"><NumberInput label="素材入点" suffix=" 秒" min={0} max={currentClip.source_duration_ms === null ? 0 : currentClip.source_duration_ms / 1000} step={0.1} decimalScale={3} hideControls disabled={currentClip.source_duration_ms === null} value={trimIn} onChange={setTrimIn} /><NumberInput label={currentClip.source_duration_ms === null ? '画面停留至' : '素材出点'} suffix=" 秒" min={0.2} max={currentClip.source_duration_ms === null ? 30 : currentClip.source_duration_ms / 1000} step={0.1} decimalScale={3} hideControls value={trimOut} onChange={setTrimOut} /><Button variant="default" onClick={saveTrim} disabled={busy || !!trimIssue || !trimChanged} leftSection={<Save size={15} />}>保存取段</Button></div>{trimIssue && <span className="trim-error" role="status">{trimIssue}</span>}{selectedAsset?.kind === 'video' && <div className="source-audio-editor"><div className="trim-editor-heading"><Music2 size={16} /><strong>片段原声</strong><span>预览与导出使用同一设置</span></div><div className="source-audio-fields"><NumberInput label="原声音量" suffix=" %" min={0} max={200} step={10} decimalScale={0} hideControls value={sourceAudioPercent} onChange={setSourceAudioPercent} /><NumberInput label="首尾淡变" suffix=" 毫秒" min={0} max={500} step={50} decimalScale={0} hideControls value={sourceAudioFadeMs} onChange={setSourceAudioFadeMs} /><Button variant="default" onClick={() => setSourceAudioPercent(Number(sourceAudioPercent) === 0 ? 100 : 0)}>{Number(sourceAudioPercent) === 0 ? '恢复原声' : '静音'}</Button><Button variant="default" onClick={saveSourceAudio} disabled={busy || !!audioIssue || !audioChanged} leftSection={<Save size={15} />}>保存原声</Button></div>{audioIssue && <span className="trim-error" role="status">{audioIssue}</span>}</div>}</div> : <p className="cut-empty">选定候选素材后，可从素材中截取自然的动作片段，成片将按这里的入点和出点导出。</p>}
            </section>
            <div className="candidates-head"><div><h2>候选版本 <Badge variant="light" color="gray">{shotAssets.length}</Badge></h2><span className="section-note">版本审核与选片</span></div><div className="candidate-head-actions"><CandidateCompare shot={currentShot} assets={detail.assets} reviews={detail.asset_reviews} selectedAssetId={currentShot.selected_asset_id} /><Button variant="default" onClick={() => fileInput.current?.click()} leftSection={<Upload size={16} />}>导入素材</Button></div></div>
            <div className="candidate-grid">
              {shotAssets.map((asset) => {
                const review = reviewsByAsset.get(asset.id)
                const status = review?.status || 'pending'
                return <div className={`candidate ${currentShot.selected_asset_id === asset.id ? 'chosen' : ''} ${status === 'rejected' ? 'rejected' : ''}`} key={asset.id}>
                <div className="candidate-media"><AssetPreview asset={asset} compact /></div>
                <div className="candidate-info"><span>{asset.source === 'upload' ? '本地导入' : models.find((model) => model.id === asset.model_id)?.name || '生成素材'}</span><small>{dateLabel(asset.created_at)}</small></div>
                {asset.kind !== 'text' && <div className="candidate-review-summary"><Badge size="xs" variant="light" color={status === 'approved' ? 'teal' : status === 'rejected' ? 'red' : 'gray'}>{reviewStatusText[status]}</Badge>{currentShot.selected_asset_id === asset.id && <span>已入片</span>}</div>}
                {review?.note && <p className="candidate-review-note" title={review.note}>{review.note}</p>}
                {asset.kind === 'text' ? <><p className="candidate-text">{asset.text}</p><div className="candidate-actions"><Button className="candidate-action" variant="light" size="xs" onClick={() => { setShotForm((form) => ({ ...form, prompt: asset.text || '' })); setNotice('已填入镜头提示词，请保存分镜') }}>用作提示词</Button>{!asset.saved && <Button variant="subtle" size="xs" onClick={() => void saveAssetToLibrary(asset)} disabled={busy} leftSection={<Save size={13} />}>保存到资产</Button>}</div></>
                  : <div className="candidate-actions"><Button variant="default" size="xs" onClick={() => openCandidateReview(asset)} disabled={busy} leftSection={<Eye size={14} />}>审核</Button><Button variant={currentShot.selected_asset_id === asset.id ? 'light' : 'default'} color={currentShot.selected_asset_id === asset.id ? 'teal' : 'cyan'} size="xs" onClick={() => selectCandidate(asset.id)} disabled={busy || status === 'rejected' || currentShot.selected_asset_id === asset.id} leftSection={currentShot.selected_asset_id === asset.id ? <Check size={14} /> : undefined}>{status === 'rejected' ? '已拒绝' : currentShot.selected_asset_id === asset.id ? '已选用' : '选为成片'}</Button>{!asset.saved && <Button variant="subtle" size="xs" onClick={() => void saveAssetToLibrary(asset)} disabled={busy} leftSection={<Save size={13} />}>保存到资产</Button>}</div>}
              </div>
              })}
              {!shotAssets.length && <div className="candidate-empty"><ImageIcon size={22} /><span>候选结果会出现在这里</span></div>}
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
          </> : <div className="no-shot"><Clapperboard size={30} /><h2>建立第一个镜头</h2>{detail.script.scenes.length > 0 && <Button variant="default" onClick={() => openScriptEditor()} leftSection={<ScrollText size={16} />}>打开剧本创作</Button>}<Button onClick={() => addShot()} leftSection={<Plus size={16} />}>添加镜头</Button></div>}
        </section>

        <aside className="inspector" aria-label="镜头设置">
          {currentShot && <>
            <div className="inspector-head"><div><span className="eyebrow">当前镜头</span><h2>创作设置</h2></div><Tooltip label="保存分镜"><ActionIcon variant="subtle" aria-label="保存分镜" onClick={() => action(saveShot, '分镜已保存')} disabled={busy}><Save size={17} /></ActionIcon></Tooltip></div>
            <div className="inspector-scroll">
              <TextInput label="镜头名称" value={shotForm.title} onChange={(event) => setShotForm({ ...shotForm, title: event.target.value })} />
              <Textarea label="画面与动作提示词" rows={7} placeholder="主体、动作、场景、风格、运镜与声音..." value={shotForm.prompt} onChange={(event) => setShotForm({ ...shotForm, prompt: event.target.value })} />
              <div className="field-row"><NumberInput label="规划入片时长" min={1} max={30} step={1} decimalScale={0} suffix=" 秒" value={shotForm.duration} onChange={(value) => setShotForm({ ...shotForm, duration: Number(value) || 1 })} /><Select label="项目画幅" data={['16:9', '9:16']} allowDeselect={false} value={detail.ratio} onChange={(ratio) => { if (!ratio) return; void action(async () => { await api(`/projects/${detail.id}`, json('PATCH', { ratio })); await refreshDetail(); setGeneration((current) => ({ ...current, ratio: modelRatios(activeModel).includes(ratio) ? ratio : modelRatios(activeModel)[0] })) }) }} /></div>
              <div className="shot-state-fields"><Textarea label="镜头开始状态" rows={2} placeholder="角色位置、姿态、武器和运动方向" value={shotForm.start_state} onChange={(event) => setShotForm({ ...shotForm, start_state: event.target.value })} /><Textarea label="镜头结束状态" rows={2} placeholder="为下一镜留下明确的动作落点" value={shotForm.end_state} onChange={(event) => setShotForm({ ...shotForm, end_state: event.target.value })} /><Textarea label="接镜要求" rows={2} placeholder="说明与上一镜的衔接方式" value={shotForm.cut_note} onChange={(event) => setShotForm({ ...shotForm, cut_note: event.target.value })} /></div>
              <div className="inspector-divider" />
              <div className="generation-title"><WandSparkles size={17} /><strong>生成候选</strong></div>
              <SegmentedControl className="generation-segment" aria-label="生成类型" fullWidth value={generation.modality} data={[{ value: 'text', label: '文本' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }]} onChange={(value) => { const modality = value as Modality; setGeneration({ ...generation, modality, mode: 'text', reference_asset_ids: [], resolution: modality === 'image' ? '1.5K' : '720p' }) }} />
              <Select label="生成模型" searchable allowDeselect={false} value={generation.model_id || null} data={availableModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => { if (!value) return; const model = models.find((item) => item.id === value); setGeneration({ ...generation, model_id: value, mode: 'text', resolution: defaultResolution(model, generation.modality), duration: Math.min(durationBounds(model).max, Math.max(durationBounds(model).min, generation.duration)), ratio: modelRatios(model).includes(generation.ratio) ? generation.ratio : modelRatios(model)[0], reference_asset_ids: [], draft: false }) }} />
              <Button variant="default" leftSection={<ImageIcon size={15} />} onClick={() => setVisualPreparationOpen(true)}>视觉设定 · {visualBindings.length}</Button>
              {!!visualBindings.length && <Select label="视觉设定引用方式" value={generation.visual_reference_mode || 'profiles'} allowDeselect={false} data={[{ value: 'profiles', label: '设定信息图 + 文字' }, ...(generation.modality === 'video' ? [{ value: 'keyframe', label: '关键帧承接 + 文字' }] : []), { value: 'text_only', label: '仅文字设定' }]} onChange={value => value && setGeneration({ ...generation, visual_reference_mode: value as VisualReferenceMode })} />}
              {!availableModels.length && <button className="model-empty-link" onClick={() => setTab('models')}>暂无可用模型，前往模型设置添加 <ArrowRight size={14} /></button>}
              {activeProvider && <div className="model-hint">{activeProvider.has_key ? '已配置 API Key' : '请到模型设置中配置 API Key'}</div>}
              {activeModel && generation.modality === 'video' && <>
                <Select label="生成模式" allowDeselect={false} value={generation.mode} data={modes.filter((mode) => availableModes.includes(mode.value)).map((mode) => ({ value: mode.value, label: mode.label }))} onChange={(value) => { if (value) setGeneration({ ...generation, mode: value as Generation['mode'], reference_asset_ids: [] }) }} />
              </>}
              {activeModel && generation.modality !== 'text' && <>
                {(supportsImageReference || generation.modality === 'video' && ['first_frame', 'first_last_frame', 'reference'].includes(generation.mode)) && <div className="field"><span>参考图片 {generation.reference_asset_ids.length > 0 && `· 已选 ${generation.reference_asset_ids.length}`}</span>{imageAssets.length > 0 ? <div className="reference-list">{imageAssets.map((asset) => <button className={`reference-item ${generation.reference_asset_ids.includes(asset.id) ? 'active' : ''}`} key={asset.id} onClick={() => toggleReference(asset.id)} title={asset.filename} aria-pressed={generation.reference_asset_ids.includes(asset.id)}><img src={asset.url} alt={asset.filename} />{generation.reference_asset_ids.includes(asset.id) && <Check size={15} />}</button>)}</div> : <button className="button button-subtle reference-upload" onClick={() => fileInput.current?.click()}><Upload size={15} />导入参考图片</button>}</div>}
                {generation.modality === 'video' && ['reference', 'edit', 'extend'].includes(generation.mode) && <TextInput label="参考视频地址" description="公网 URL；部分模型支持预置素材 URI（按模型配置）。" value={generation.reference_video_url} placeholder="https://.../reference.mp4" onChange={(event) => setGeneration({ ...generation, reference_video_url: event.target.value })} />}
                <div className="field-row"><Select label={generation.modality === 'image' ? '图片尺寸' : '视频分辨率'} allowDeselect={false} value={generation.resolution} data={modelResolutions(activeModel, generation.modality)} onChange={(value) => { if (value) setGeneration({ ...generation, resolution: value }) }} />{generation.modality === 'video' && generation.mode !== 'edit' && <NumberInput label="生成时长" min={bounds.min} max={bounds.max} suffix=" 秒" value={generation.duration} onChange={(value) => setGeneration({ ...generation, duration: Number(value) || bounds.min })} />}</div>
                {generation.modality === 'video' && <Select label="生成画幅" allowDeselect={false} value={['first_frame', 'first_last_frame', 'edit', 'extend'].includes(generation.mode) ? 'adaptive' : generation.ratio} disabled={['first_frame', 'first_last_frame', 'edit', 'extend'].includes(generation.mode)} data={modelRatios(activeModel)} onChange={(value) => { if (value) setGeneration({ ...generation, ratio: value }) }} />}
                {generation.modality === 'video' && (supportsAudio || activeModel?.settings.supports_draft === true) && <div className="toggle-list">{supportsAudio && <Checkbox label="生成声音" checked={generation.generate_audio} onChange={(event) => setGeneration({ ...generation, generate_audio: event.currentTarget.checked })} />}{activeModel?.settings.supports_draft === true && <Checkbox label={`${draftResolution} 样片`} checked={generation.draft} onChange={(event) => setGeneration({ ...generation, draft: event.currentTarget.checked, resolution: event.currentTarget.checked ? draftResolution : defaultResolution(activeModel, 'video') })} />}</div>}
              </>}
            </div>
            <div className="inspector-actions">{generationIssue && <span className="generation-issue" role="status">{generationIssue}</span>}<Button variant="default" onClick={() => action(saveShot, '分镜已保存')} disabled={busy} leftSection={<Save size={16} />}>保存</Button><Button onClick={reviewGeneration} loading={busy} disabled={!shotForm.prompt.trim() || !activeModel || !!generationIssue} leftSection={<Sparkles size={16} />}>开始生成</Button></div>
          </>}
        </aside>
        <section className="timeline">
          <div className="timeline-head">
            <div><strong>成片时间线</strong><span className="timeline-duration">{productionRangeValid
              ? `本次 ${productionShots.length} 镜 · 实际 ${secondsLabel(totalDurationMs)} / 规划 ${plannedDuration.toFixed(1)}s · ${readyCount}/${productionShots.length} 镜已选`
              : '制作范围已失效，请重新选择'}</span>{productionRangeValid && <span className={`timeline-target ${totalDurationMs > targetSeconds * 1000 ? 'is-over' : ''}`}>目标约 {targetSeconds} 秒{totalDurationMs > targetSeconds * 1000 ? ` · 超出 ${secondsLabel(totalDurationMs - targetSeconds * 1000)}` : ''}</span>}</div>
            <div className="timeline-actions">
              <CutReviewPanel detail={detail} onChanged={async () => { await refreshDetail(detail.id) }} />
              <Button variant="default" size="xs" onClick={() => {
                setRangeDraft({ start_shot_id: detail.production_range?.start_shot_id ?? null,
                  end_shot_id: detail.production_range?.end_shot_id ?? null })
                setShowProductionRange(true)
              }} leftSection={<Scissors size={15} />}>制作范围</Button>
              <Button variant="default" size="xs" onClick={() => setShowTimelinePreview(true)} disabled={!canExport} leftSection={<Play size={15} />}>连续预览</Button>
              <Button variant="default" size="xs" onClick={exportVideo} disabled={busy || !canExport} title={!canExport ? '请先为制作范围内的镜头选定有效片段' : '导出视频'} leftSection={<Download size={15} />}>导出视频</Button>
            </div>
          </div>
          <div className="timeline-track">{detail.shots.map((shot, index) => {
            const clip = clipMap.get(shot.id)
            return <button key={shot.id}
              className={`timeline-clip ${clip ? 'ready' : ''} ${shot.id === shotId ? 'current' : ''} ${!productionShotIds.has(shot.id) ? 'outside-range' : ''}`}
              title={!productionShotIds.has(shot.id) ? '不在本次制作范围' : shot.title}
              onClick={() => setShotId(shot.id)}>
              <div className="timeline-clip-preview"><AssetPreview asset={assetMap.get(clip?.asset_id || '')} compact /></div>
              <div className="timeline-clip-label"><span>{String(index + 1).padStart(2, '0')} {shot.title}</span><b>{clip ? secondsLabel(clipDuration(clip)) : '待选'}</b></div>
            </button>
          })}</div>
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
            <div className="asset-history-tabs" role="tablist" aria-label="素材类型筛选">
              {[{ value: 'all', label: '全部' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'audio', label: '音频' }, ...(assetCollection.some(asset => asset.kind === 'text') ? [{ value: 'text', label: '文本' }] : [])].map((item) => <button type="button" role="tab" aria-selected={assetKindFilter === item.value} className={assetKindFilter === item.value ? 'active' : ''} key={item.value} onClick={() => { setAssetKindFilter(item.value as typeof assetKindFilter); setSelectedAssetIds([]) }}>{item.label} <span>{item.value === 'all' ? assetCollection.length : assetCollection.filter((asset) => asset.kind === item.value).length}</span></button>)}
            </div>
            {(assetCollection.length > 0 || assetQuery) && <div className="asset-library-tools">
              <TextInput className="asset-search" aria-label="搜索素材" placeholder="搜索文件名、提示词或镜头" leftSection={<Search size={15} />} value={assetQuery} onChange={(event) => { setAssetQuery(event.currentTarget.value); setSelectedAssetIds([]) }} />
              {assetLibraryView === 'personal' && <Select aria-label="素材来源筛选" value={assetSourceFilter} onChange={(value) => { if (value) { setAssetSourceFilter(value as typeof assetSourceFilter); setSelectedAssetIds([]) } }} data={[{ value: 'all', label: '全部来源' }, { value: 'generated', label: '模型生成' }, { value: 'upload', label: '本地导入' }, { value: 'export', label: '成片导出' }]} allowDeselect={false} />}
              <div className="asset-display-controls">
                {visibleLibraryAssets.length > 0 && <Checkbox aria-label="全选当前筛选素材" checked={selectedVisibleAssetCount === visibleLibraryAssets.length} indeterminate={selectedVisibleAssetCount > 0 && selectedVisibleAssetCount < visibleLibraryAssets.length} onChange={toggleVisibleAssets} />}
                <Tooltip label={assetViewMode === 'grid' ? '切换为列表' : '切换为网格'}><ActionIcon variant="subtle" aria-label={assetViewMode === 'grid' ? '切换为列表' : '切换为网格'} onClick={() => setAssetViewMode(current => current === 'grid' ? 'list' : 'grid')}>{assetViewMode === 'grid' ? <List size={18} /> : <LayoutGrid size={18} />}</ActionIcon></Tooltip>
              </div>
            </div>}

            {selectedAssetIds.length > 0 && <div className="asset-bulk-bar"><span>已选 {selectedAssetIds.length} 个</span><div className="asset-bulk-actions"><Button size="xs" variant="default" onClick={() => void addAssetsToCanvas(selectedAssetIds)} leftSection={<Layers3 size={14} />}>加入画布</Button><Button size="xs" variant="default" onClick={() => downloadAssets(selectedAssetIds)} leftSection={<Download size={14} />}>下载</Button><Button size="xs" variant="subtle" onClick={() => setSelectedAssetIds([])}>清除选择</Button></div></div>}
            <Dropzone className="asset-content-dropzone" enablePointerEvents activateOnClick={false} activateOnKeyboard={false} activateOnDrag={assetLibraryView === 'personal'} disabled={busy} loading={busy && assetLibraryView === 'personal'}
              onDrop={files => { if (assetLibraryView === 'personal') void uploadFiles(files) }} onReject={() => assetLibraryView === 'personal' && setNotice('仅支持 PNG/JPG/WebP、MP4/MOV、MP3/WAV/M4A，单文件不超过 300 MB')} maxSize={300 * 1024 * 1024}
              accept={['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/mp4']}>
              {assetLibraryView === 'personal' && <div className="asset-drag-hint" aria-hidden="true"><Upload size={24} /><span>松开以导入图片、视频或音频</span></div>}
            <div className={`asset-grid asset-grid-${assetViewMode}`}>{visibleLibraryAssets.map((asset) => {
          const review = reviewsByAsset.get(asset.id)
          const selected = selectedAssetIds.includes(asset.id)
          return <div className={`library-item ${selected ? 'is-selected' : ''}`} key={asset.id}>
          <div className="library-media" role="button" tabIndex={0} aria-label={`预览 ${asset.filename}`} onClick={() => setAssetPreview(asset)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setAssetPreview(asset) } }}><AssetPreview asset={asset} compact /><label className="library-select" onClick={(event) => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><Checkbox aria-label={`选择 ${asset.filename}`} checked={selected} onChange={() => toggleAssetSelection(asset.id)} /></label></div>
          <div className="library-copy"><strong className="truncate" title={asset.filename}>{asset.filename}</strong><small>{assetKindLabel(asset.kind)} · {assetSourceLabel(asset.source)} · {dateLabel(asset.created_at)}</small>{asset.shot_id && <small className="library-shot">镜头：{detail.shots.find((shot) => shot.id === asset.shot_id)?.title || '未命名镜头'}</small>}{shotId && review && <Badge size="xs" variant="light" color={review.status === 'approved' ? 'teal' : review.status === 'rejected' ? 'red' : 'gray'}>{reviewStatusText[review.status]}</Badge>}</div>
          <div className="library-actions"><MantineMenu shadow="md" width={210} position="bottom-end"><MantineMenu.Target><ActionIcon variant="subtle" className="asset-card-more" aria-label={`素材操作：${asset.filename}`}><MoreHorizontal size={18} /></ActionIcon></MantineMenu.Target><MantineMenu.Dropdown>
            {!asset.saved && <MantineMenu.Item leftSection={<Save size={14} />} onClick={() => void saveAssetToLibrary(asset)} disabled={busy}>保存到资产库</MantineMenu.Item>}
            {(asset.kind === 'image' || asset.kind === 'video') && shotId && <>
              <MantineMenu.Item leftSection={<Eye size={14} />} onClick={() => openCandidateReview(asset)} disabled={busy}>审核素材</MantineMenu.Item>
              <MantineMenu.Item leftSection={<Check size={14} />} disabled={busy || review?.status === 'rejected' || currentShot?.selected_asset_id === asset.id} onClick={() => useLibraryAsset(asset.id)}>{review?.status === 'rejected' ? '已拒绝' : currentShot?.selected_asset_id === asset.id ? '已用于当前镜头' : '选入当前镜头'}</MantineMenu.Item>
            </>}
            {asset.kind === 'audio' && <MantineMenu.Item disabled={busy} leftSection={<Music2 size={14} />} onClick={() => action(async () => { await api(`/projects/${detail.id}`, json('PATCH', { music_asset_id: detail.music_asset_id === asset.id ? null : asset.id })); await refreshDetail() })}>{detail.music_asset_id === asset.id ? '取消用作配乐' : '用作配乐'}</MantineMenu.Item>}
            {asset.kind !== 'audio' && <MantineMenu.Item leftSection={<Layers3 size={14} />} onClick={() => void addAssetsToCanvas([asset.id])} disabled={busy}>加入画布</MantineMenu.Item>}
            <MantineMenu.Item component="a" href={asset.url} download={asset.filename} leftSection={<Download size={14} />}>下载素材</MantineMenu.Item>
            </MantineMenu.Dropdown></MantineMenu>
          </div>
        </div>})}</div>
            {!visibleLibraryAssets.length && <div className="asset-history-empty" role="status">
              <span>{libraryEmptyText(assetLibraryView, assetCollection.length)}</span>
              {assetCollection.length > 0 && <button type="button" onClick={clearAssetFilters}>清除筛选</button>}
            </div>}
            </Dropzone>
          </main>
          <aside className="asset-library-rail" aria-label="资产分类">
            <button type="button" className={assetLibraryView === 'history' ? 'active' : ''} aria-current={assetLibraryView === 'history' ? 'page' : undefined} onClick={() => switchAssetLibrary('history')}><Clock3 size={18} /><span>生成历史</span><b>{historyAssets.length}</b></button>
            <button type="button" className={assetLibraryView === 'personal' ? 'active' : ''} aria-current={assetLibraryView === 'personal' ? 'page' : undefined} onClick={() => switchAssetLibrary('personal')}><FolderOpen size={18} /><span>个人资产库</span><b>{libraryAssets.length}</b></button>
          </aside>
        </div>
      </section>}

      {detail && tab === 'jobs' && <section className="page-section">
        <div className="page-header"><div><h1>任务记录</h1><p>生成结果先保留在候选和画布中，确认后再手动保存到资产库。</p></div><Button variant="default" onClick={() => refreshDetail()} leftSection={<RefreshCcw size={16} />}>刷新</Button></div>
        <div className="job-table">
          <div className="job-row job-header"><span>任务</span><span>状态</span><span>提交时间</span><span>结果</span></div>
          {detail.jobs.map((job) => {
            const result = detail.assets.find((asset) => asset.id === job.result_asset_id)
            const model = models.find((item) => item.id === job.model_id)
            const isImageTask = job.job_type === 'generation' && model?.modality === 'image'
            const modelUnavailable = job.job_type === 'generation' && !model
            const needsBillingCheck = job.status === 'failed' && !job.recovery_available && (isImageTask || modelUnavailable)
            return <div className={`job-row ${needsBillingCheck ? 'job-row-needs-review' : ''}`} key={job.id}>
              <div className="job-name"><div className="job-icon">{job.job_type === 'export' ? <Film size={18} /> : isImageTask || job.recovery_available ? <ImageIcon size={18} /> : <Sparkles size={18} />}</div><div><strong>{job.job_type === 'export' ? '成片导出' : model?.name || '生成任务'}</strong><small>{detail.shots.find((shot) => shot.id === job.shot_id)?.title || detail.name}{job.external_id && ` · ${job.external_id.slice(0, 16)}...`}</small></div></div>
              <span className={`job-status status-${job.status}`}>{job.status === 'running' && <LoaderCircle className="spin" size={13} />}{statusText[job.status]}</span>
              <span className="job-date">{dateLabel(job.created_at)}</span>
              <div className="job-result">
                {result ? <Button component="a" variant="default" size="xs" href={result.url} download={job.job_type === 'export'} leftSection={<Download size={14} />}>{job.job_type === 'export' ? '下载成片' : '查看结果'}</Button>
                  : needsBillingCheck ? <div className="job-recovery-guidance"><span>{isImageTask ? '没有可恢复的图片链接。请先核对提供商账单，再回到画布重新生成。' : '原模型不可用，请先核对提供商记录；需要重新生成时回到画布。'}</span>{job.shot_id && <Button variant="default" size="xs" onClick={() => { setShotId(job.shot_id); setTab('canvas') }} leftSection={<Clapperboard size={14} />}>回到画布</Button>}</div>
                    : job.status === 'failed' ? <Button variant="default" size="xs" disabled={busy} onClick={() => action(async () => { await api(`/jobs/${job.id}/retry`, { method: 'POST' }); await refreshDetail() }, job.recovery_available ? '图片下载恢复任务已入队' : '任务已重新入队')} leftSection={job.recovery_available ? <Download size={14} /> : <RefreshCcw size={14} />}>{job.recovery_available ? '恢复下载' : '重试'}</Button>
                      : <span>—</span>}
                {job.error && <small className="job-error" title={job.error}>{job.error}</small>}
              </div>
            </div>
          })}
          {!detail.jobs.length && <div className="table-empty">还没有任务。进入项目画布创建第一个生成节点。</div>}
        </div>
      </section>}

      {tab === 'models' && <ModelSettings providers={providers} models={models} refresh={refreshCatalog} action={action} busy={busy} />}
    </main>

    <Modal opened={assetPreview !== null} onClose={() => setAssetPreview(null)} title={assetPreview?.filename || '素材预览'} size="lg" centered>
      {assetPreview && <div className="asset-preview-modal">
        <div className="asset-preview-stage"><AssetPreview asset={assetPreview} /></div>
        <div className="asset-preview-meta">
          <div><span>类型</span><strong>{assetKindLabel(assetPreview.kind)}</strong></div>
          <div><span>来源</span><strong>{assetSourceLabel(assetPreview.source)}</strong></div>
          <div><span>创建时间</span><strong>{dateLabel(assetPreview.created_at)}</strong></div>
          {assetPreview.shot_id && <div><span>关联镜头</span><strong>{detail?.shots.find((shot) => shot.id === assetPreview.shot_id)?.title || '未命名镜头'}</strong></div>}
        </div>
        {assetPreview.prompt && <div className="asset-preview-prompt"><span>生成提示词</span><p>{assetPreview.prompt}</p></div>}
        {assetPreview.text && <div className="asset-preview-prompt"><span>文本内容</span><p>{assetPreview.text}</p></div>}
        <div className="asset-preview-actions">
          <Button variant="default" component="a" href={assetPreview.url} download={assetPreview.filename} leftSection={<Download size={15} />}>下载素材</Button>
          {assetPreview.kind !== 'audio' && <Button onClick={() => { void addAssetsToCanvas([assetPreview.id]); setAssetPreview(null) }} leftSection={<Layers3 size={15} />}>加入画布</Button>}
          {assetPreview.shot_id && <Button variant="subtle" onClick={() => { setShotId(assetPreview.shot_id); setTab('canvas'); setAssetPreview(null) }} leftSection={<Clapperboard size={15} />}>打开关联画布</Button>}
        </div>
      </div>}
    </Modal>
    <Modal className="generation-review-modal" opened={!!generationReview} onClose={() => { if (!busy) setGenerationReview(null) }} closeOnEscape={!busy} closeOnClickOutside={!busy} title="确认生成任务" size="lg" centered>
      {generationReview && <div className="generation-review">
        <p className="generation-review-intro">当前填写的生成参数</p>
        <dl className="generation-review-details">
          <div><dt>当前镜头</dt><dd>{String(generationReview.shotNumber).padStart(2, '0')} · {generationReview.shot.title}</dd></div>
          <div><dt>提供商</dt><dd>{generationReview.providerName}</dd></div>
          <div><dt>模型</dt><dd>{generationReview.modelName}<small>{generationReview.remoteModelId}</small></dd></div>
          <div><dt>生成类型</dt><dd>{generationReview.modality === 'video' ? '视频' : generationReview.modality === 'image' ? '图片' : '文本'}</dd></div>
          <div><dt>生成模式</dt><dd>{generationReview.modality === 'video' ? modes.find((mode) => mode.value === generationReview.request.mode)?.label : generationReview.modality === 'image' ? generationReview.referenceNames.length ? '参考图片生成' : '文生图' : '文本生成'}</dd></div>
          {generationReview.modality === 'video' && <div><dt>生成时长</dt><dd>{generationReview.request.duration} 秒</dd></div>}
          {generationReview.modality !== 'text' && <div><dt>{generationReview.modality === 'image' ? '图片尺寸' : '视频分辨率'}</dt><dd>{generationReview.request.resolution}</dd></div>}
          {generationReview.modality !== 'text' && <div><dt>画幅</dt><dd>{generationReview.request.ratio}</dd></div>}
          <div><dt>候选数量</dt><dd>1 个</dd></div>
          <div><dt>预计费用</dt><dd className={generationReview.estimatedCost ? 'generation-review-cost' : 'generation-review-cost is-unconfigured'}>{generationReview.estimatedCost || '未配置模型价格'}</dd></div>
          {!!generationReview.referenceNames.length && <div><dt>参考图片</dt><dd>{generationReview.referenceNames.join('、')}</dd></div>}
          {generationReview.request.reference_video_url && <div><dt>参考视频</dt><dd>{generationReview.request.reference_video_url}</dd></div>}
          {generationReview.supportsAudio && <div><dt>生成声音</dt><dd>{generationReview.request.generate_audio ? '开启' : '关闭'}</dd></div>}
          {generationReview.supportsDraft && <div><dt>样片模式</dt><dd>{generationReview.request.draft ? '开启' : '关闭'}</dd></div>}
        </dl>
        <div className="generation-review-prompt"><strong>当前提示词</strong><p>{generationReview.request.prompt}</p></div>
        <div className="generation-review-warning" role="note"><TriangleAlert size={18} /><p><strong>确认后将提交生成任务，可能产生费用。</strong><span>模型自定义请求模板可能调整厂商收到的实际参数。再次生成或失败后重新提交也可能再次计费；实际费用以提供商账单为准。</span></p></div>
        <div className="generation-review-actions"><Button variant="default" onClick={() => setGenerationReview(null)} disabled={busy}>返回修改</Button><Button onClick={generateCandidate} loading={busy} leftSection={<Sparkles size={16} />}>确认提交 1 个候选</Button></div>
      </div>}
    </Modal>
    {visualPreparationOpen && detail && <VisualPreparation detail={detail} models={models} shotId={currentShot?.id} onRefresh={() => refreshDetail()} onClose={() => setVisualPreparationOpen(false)} />}
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
      {detail && <TimelinePreview clips={detail.timeline_clips.filter((clip) => productionShotIds.has(clip.shot_id))}
        assets={detail.assets} shots={productionShots} ratio={detail.ratio}
        musicAsset={detail.assets.find((asset) => asset.id === detail.music_asset_id && asset.kind === 'audio') || null} />}
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
