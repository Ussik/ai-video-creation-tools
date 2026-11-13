import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Menu, UnstyledButton, ActionIcon, Button, Checkbox, Modal, NumberInput, Select, Textarea, TextInput, Tooltip } from '@mantine/core'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import {
  ArrowLeft, ArrowRight, Bold, Clapperboard, FileText, Heading1, Italic,
  List, ListOrdered, LoaderCircle, Minimize2, Plus, Redo2, RotateCcw, Save, Sparkles,
  ChevronDown, Search, Strikethrough, Trash2, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api, json } from '../../shared/api/api'
import type { Model, PlannedScene, PlannedShot, PlannedShotCreationResult, ProjectDetail, Provider, ScriptArtifactType, ScriptGenerationOptions, ShotPlanResult } from '../../shared/api/api'
import { scriptArtifactLabels, scriptStageArtifacts, scriptStageForArtifact, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { workflowProgress } from '@video-studio/shared/script/script-stage-access'
import { maxScriptSceneDuration } from '@video-studio/shared/script/script-duration'
import './script-editor.css'
import StoryboardPlanner from '../storyboard/StoryboardPlanner'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import { useAppDialog } from '../../shared/ui/AppDialog'
import ThemeToggle from '../../shared/ui/ThemeToggle'
import { applyTextFormat, type TextFormat } from '../../shared/lib/editor/text-editor'
import { scriptEditorExtensions } from './script-editor-extensions'
import './script-document-tables.css'
import { serializeScriptDocument } from './script-rich-document'
import { normalizeTextDocument, textDocumentText } from '../../shared/lib/editor/text-document'
import { useScriptDocumentNavigation } from './useScriptDocumentNavigation'
import { highlightScriptSearch, resolveScriptArtifactDocument, ScriptSearchHighlight, type ScriptSearchRange } from './script-document-search'
import { useScriptDocumentSearch } from './useScriptDocumentSearch'
import { ScriptDocumentSearch } from './ScriptDocumentSearch'

type SceneFields = {
  episode_number?: number
  heading: string
  location: string
  time_of_day: string
  characters: string
  action: string
  dialogue: string
  narration: string
  duration: number
}

type SavedScene = SceneFields & { id: string; position: number }
type EditorScene = SceneFields & { clientId: string; id?: string }
type ScriptArtifact = {
  id: string
  project_id?: string
  artifact_type: ScriptArtifactType
  episode_number?: number
  title: string
  content: string
  position: number
  status: 'draft' | 'ready' | 'edited'
  created_at?: string
  updated_at?: string
  document?: JSONContent
}
type ScriptDraft = {
  brief: string
  outline: string
  characters: string
  generation_options: ScriptGenerationOptions
  scenes: EditorScene[]
  artifacts: ScriptArtifact[]
}
export type DocumentSection = ScriptArtifactType | 'scenes' | `episode-${number}`
type ScriptDetail = ProjectDetail & {
  script: { outline: string; characters: string; generation_options?: ScriptGenerationOptions; scenes: SavedScene[]; artifacts?: ScriptArtifact[] }
}

type RichArtifactEditorProps = {
  value: string
  label: string
  placeholder: string
  disabled: boolean
  document?: JSONContent
  searchQuery: string
  activeSearchRange: ScriptSearchRange | null
  onFocus: (editor: Editor) => void
  onSelectionChange: (editor: Editor) => void
  onChange: (value: string, document: JSONContent) => void
}

function RichArtifactEditor({ value, label, placeholder, disabled, document, searchQuery, activeSearchRange, onFocus, onSelectionChange, onChange }: RichArtifactEditorProps) {
  const readyRef = useRef(false)
  const editor = useEditor({
    extensions: [...scriptEditorExtensions(), ScriptSearchHighlight],
    content: resolveScriptArtifactDocument(value, document, label),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: 'script-rich-editor-content',
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        'data-placeholder': placeholder,
      },
    },
    onCreate() {
      // Tiptap may emit a normalization transaction while mounting content;
      // that is not a user edit and must not mark a freshly opened project dirty.
      queueMicrotask(() => { readyRef.current = true })
    },
    onFocus({ editor: current }) { onFocus(current); onSelectionChange(current) },
    onSelectionUpdate({ editor: current }) { onSelectionChange(current) },
    onUpdate({ editor: current }) {
      if (!readyRef.current) return
      const next = normalizeTextDocument(current.getJSON())
      if (JSON.stringify(next) === JSON.stringify(normalizeTextDocument(resolveScriptArtifactDocument(value, document, label)))) return
      // Store the structured document in the existing text column as the
      // supported Markdown subset. This keeps formatting after a save/reload
      // without widening the API payload or adding a second persistence table.
      onChange(serializeScriptDocument(next), next)
    },
  }, [])
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [disabled, editor])
  useEffect(() => {
    if (!editor) return
    const next = resolveScriptArtifactDocument(value, document, label)
    if (JSON.stringify(normalizeTextDocument(editor.getJSON())) !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false })
    }
  }, [value, document, label, editor])
  useEffect(() => {
    if (editor) highlightScriptSearch(editor, searchQuery, activeSearchRange)
  }, [editor, value, document, searchQuery, activeSearchRange?.from, activeSearchRange?.to])

  return <EditorContent editor={editor} className="script-rich-editor" />
}

const artifactMetadata: Array<{ type: ScriptArtifactType; description: string; group: string }> = [
  { type: 'outline', description: '故事命题、核心冲突、主线因果与结局代价', group: '故事基底' },
  { type: 'synopsis', description: '从开端到结局的完整故事脉络', group: '故事基底' },
  { type: 'world', description: '时代、地点、规则与视觉基调', group: '故事基底' },
  { type: 'characters', description: '人物目标、内在需要、关键选择与成长', group: '人物设定' },
  { type: 'relationships', description: '双方诉求、权力与信息差、关系变化及代价', group: '人物设定' },
  { type: 'locations', description: '全剧地点、剧情用途与出场索引', group: '场景设计' },
  { type: 'location_layouts', description: '地理关系、空间布局、视线与人物行动路线', group: '场景设计' },
  { type: 'location_atmosphere', description: '陈设材质、光线色彩、环境声与情绪氛围', group: '场景设计' },
  { type: 'location_continuity', description: '各次出现的状态变化、空间锚点与跨场承接', group: '场景设计' },
  { type: 'props', description: '全剧道具、关联人物与出场索引', group: '道具设计' },
  { type: 'prop_visuals', description: '形态材质、辨识细节与外观变体', group: '道具设计' },
  { type: 'prop_functions', description: '剧情因果、伏笔作用、触发条件与能力边界', group: '道具设计' },
  { type: 'prop_continuity', description: '持有者、知情者、转移事件与损耗状态', group: '道具设计' },
  { type: 'structure', description: '按段落梳理节奏、转折与情绪', group: '叙事规划' },
  { type: 'hooks', description: '让观众愿意继续观看的悬念', group: '叙事规划' },
  { type: 'foreshadowing', description: '埋设位置、回收时机与剧情后果', group: '叙事规划' },
  { type: 'reversals', description: '改变观众判断的关键节点', group: '叙事规划' },
  { type: 'constraints', description: '风格、人物和内容上的限制', group: '叙事规划' },
  { type: 'episode_outline', description: '各集的选择、代价、状态变化与承接', group: '叙事规划' },
  { type: 'episode_script', description: '可直接进入分场制作的正文', group: '分集创作' },
]
const artifactCatalog = artifactMetadata.map(item => ({ ...item, title: scriptArtifactLabels[item.type] }))

const editorDocumentGroups: Array<{ stage: Exclude<ScriptStage, 'episode'>; title: string; description: string }> = [
  { stage: 'outline', title: '故事大纲', description: '全剧主线、世界规则、叙事规划与分集推进' },
  { stage: 'characters', title: '人物设定', description: '人物目标与成长、关系冲突与变化' },
  { stage: 'locations', title: '场景设计', description: '承载故事行动、冲突与情绪的空间' },
  { stage: 'props', title: '道具设计', description: '道具的剧情作用、归属与状态变化' },
]

function catalogForStage(stage: ScriptStage) {
  return scriptStageArtifacts[stage].map(type => artifactCatalog.find(item => item.type === type)!)
}

function defaultArtifacts(script: { outline?: string; characters?: string; scenes?: SavedScene[]; generation_options?: ScriptGenerationOptions }): ScriptArtifact[] {
  // Only these legacy fields contain actual saved document bodies. Generation
  // settings and scenes must not masquerade as separately authored chapters.
  const values: Partial<Record<ScriptArtifactType, string>> = {
    outline: script.outline || '', characters: script.characters || '',
  }
  return artifactCatalog.map((item, index) => ({
    id: `local-${item.type}`, artifact_type: item.type, title: item.title,
    content: values[item.type] || '', position: index, status: values[item.type] ? 'ready' : 'draft',
  }))
}

export interface ScriptEditorProps {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  busy?: boolean
  initialSection?: DocumentSection
  onRefresh: () => Promise<ProjectDetail | undefined>
  onOpenModels: () => void
  onOpenCanvas: () => void
  onOpenShotManager?: (sceneIds?: string[]) => void
  onNotice: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
  onSupplementStage?: (stage: Exclude<ScriptStage, 'episode'>) => void
}

function sceneFields(scene: Partial<SceneFields>): SceneFields {
  return {
    ...(scene.episode_number !== undefined ? { episode_number: scene.episode_number } : {}),
    heading: typeof scene.heading === 'string' ? scene.heading : '',
    location: typeof scene.location === 'string' ? scene.location : '',
    time_of_day: typeof scene.time_of_day === 'string' ? scene.time_of_day : '',
    characters: typeof scene.characters === 'string' ? scene.characters : '',
    action: typeof scene.action === 'string' ? scene.action : '',
    dialogue: typeof scene.dialogue === 'string' ? scene.dialogue : '',
    narration: typeof scene.narration === 'string' ? scene.narration : '',
    duration: typeof scene.duration === 'number' && Number.isFinite(scene.duration)
      ? Math.min(maxScriptSceneDuration, Math.max(1, Math.round(scene.duration))) : 5,
  }
}

function fromDetail(detail: ProjectDetail): ScriptDraft {
  const script = (detail as ScriptDetail).script
  const fallback = defaultArtifacts(script || {})
  const remoteArtifacts = Array.isArray(script?.artifacts) ? script.artifacts : []
  const artifacts = artifactCatalog.flatMap((catalogItem, index) => {
    const matching = remoteArtifacts.filter(item => item.artifact_type === catalogItem.type)
    return (matching.length ? matching : [fallback[index]!]).map(artifact => ({
      ...artifact,
      position: Number.isFinite(artifact.position) ? artifact.position : index,
      content: typeof artifact.content === 'string' ? artifact.content : '',
      title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title : artifactCatalog.find((item) => item.type === artifact.artifact_type)?.title || '未命名章节',
    }))
  })
  return {
    brief: detail.brief || '',
    outline: script?.outline || '',
    characters: script?.characters || '',
    generation_options: {
      genre: script?.generation_options?.genre || '',
      genre_fusion: script?.generation_options?.genre_fusion || '',
      audience: script?.generation_options?.audience || '',
      era: script?.generation_options?.era || '',
      character_notes: script?.generation_options?.character_notes || '',
      core_hook: script?.generation_options?.core_hook || '',
      visual_style: script?.generation_options?.visual_style || '',
      story_structure: script?.generation_options?.story_structure || '',
      episode_count: script?.generation_options?.episode_count ?? 20,
      episode_duration: script?.generation_options?.episode_duration,
    },
    scenes: (script?.scenes || []).map((scene) => ({ ...sceneFields(scene), id: scene.id, clientId: scene.id })),
    artifacts,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function plannedSceneIssue(scene: PlannedScene): string | null {
  if (scene.shots.length < 1 || scene.shots.length > Math.min(5, scene.scene_duration)) return `本场需保留 1-${Math.min(5, scene.scene_duration)} 个镜头`
  if (scene.shots.some((shot) => !shot.title.trim() || !shot.prompt.trim())) return '请填写每个镜头的标题和画面提示词'
  if (scene.shots.some((shot) => shot.title.length > 120)) return '镜头标题不能超过 120 字'
  if (scene.shots.some((shot) => shot.prompt.length > 10000)) return '画面提示词不能超过 10000 字'
  if (scene.shots.some((shot) => !Number.isInteger(shot.duration) || shot.duration < 1 || shot.duration > 30)) return '镜头时长应为 1-30 秒的整数'
  const duration = scene.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (duration !== scene.scene_duration) return `镜头合计 ${duration} 秒，需等于本场 ${scene.scene_duration} 秒`
  return null
}

function ScriptEditor({ detail, models, providers, busy = false, initialSection, onRefresh, onOpenModels, onOpenCanvas, onOpenShotManager, onNotice, onDirtyChange, onSupplementStage }: ScriptEditorProps) {
  const { confirm, dialog } = useAppDialog()
  const [draft, setDraft] = useState<ScriptDraft>(() => fromDetail(detail))
  const [saved, setSaved] = useState<ScriptDraft>(() => fromDetail(detail))
  const [editingEmptySections, setEditingEmptySections] = useState<Set<ScriptArtifactType>>(() => new Set())
  const draftRef = useRef<ScriptDraft>(draft)
  const historyRef = useRef<{ past: ScriptDraft[]; future: ScriptDraft[] }>({ past: [], future: [] })
  const historyActionRef = useRef(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [activeSceneId, setActiveSceneId] = useState<string | null>(() => fromDetail(detail).scenes[0]?.clientId || null)
  const { activeSection: activeDocumentSection, editorRef: documentEditorRef, selectSection } = useScriptDocumentNavigation<DocumentSection>({
    documentId: detail.id, initialSection, defaultSection: 'outline',
  })
  // Keep generated candidates out of the editable draft and the commit payload.
  // This projection can refresh even while the user has unsaved manual edits.
  const pendingArtifacts = useMemo<ScriptArtifact[]>(() => (detail.script_generation_progress?.documents || [])
    .filter(item => item.content.trim() && !detail.script.artifacts?.some(saved => saved.artifact_type === item.artifact_type
      && (saved.episode_number || 0) === item.episode_number && saved.title === item.title && saved.content === item.content))
    .map((item, position) => ({ ...item, id: `generation-draft:${item.artifact_type}:${item.episode_number}`, position, status: 'draft' })),
  [detail.script_generation_progress, detail.script.artifacts])
  const searchableDocuments = useMemo(() => {
    const artifacts = [...pendingArtifacts, ...draft.artifacts]
    const projectDocuments = editorDocumentGroups.flatMap(group => catalogForStage(group.stage).flatMap(item => {
      return artifacts.filter(entry => entry.artifact_type === item.type && !entry.episode_number)
        .map(artifact => ({ artifact, section: item.type, title: group.title === artifact.title ? artifact.title : `${group.title} · ${artifact.title}` }))
    }))
    const legacyScript = artifacts.filter(artifact => artifact.artifact_type === 'episode_script' && !artifact.episode_number && artifact.content.trim())
      .map(artifact => ({ artifact, section: 'episode_script', title: artifact.title }))
    const episodes = artifacts.filter(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) > 0)
      .sort((a, b) => a.episode_number! - b.episode_number!)
      .map(artifact => ({ artifact, section: `episode-${artifact.episode_number}`, title: artifact.title }))
    return [...projectDocuments, ...legacyScript, ...episodes].map(({ artifact, section, title }) => ({
      id: artifact.id, section, title: artifact.id?.startsWith('generation-draft:') ? `${title} · 待确认草稿` : title,
      document: resolveScriptArtifactDocument(artifact.content, artifact.document, artifact.title),
    }))
  }, [draft.artifacts, pendingArtifacts])
  const search = useScriptDocumentSearch(searchableDocuments, match => {
    selectSection(match.section as DocumentSection, false, '[data-script-search-active]')
  })
  function artifactSearchProps(artifact: ScriptArtifact) {
    return {
      searchQuery: search.opened ? search.query : '',
      activeSearchRange: search.opened && search.activeMatch?.documentId === artifact.id ? search.activeMatch : null,
    }
  }
  const [editorZoom, setEditorZoom] = useState(100)
  const [formatMenu, setFormatMenu] = useState<'heading' | 'list' | null>(null)
  const [, setSelectionRevision] = useState(0)
  const focusedEditorRef = useRef<Editor | null>(null)
  const focusedArtifactRef = useRef<ScriptArtifactType | null>(null)
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])
  const [showConvert, setShowConvert] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [storyboardOpen, setStoryboardOpen] = useState(false)
  const [planningSceneIds, setPlanningSceneIds] = useState<string[]>([])
  const [planPrompt, setPlanPrompt] = useState('')
  const [planPromptCustomized, setPlanPromptCustomized] = useState(false)
  const [planPromptLoading, setPlanPromptLoading] = useState(false)
  const [planPromptError, setPlanPromptError] = useState<string | null>(null)
  const planPromptEditedRef = useRef(false)
  const planPromptRequestId = useRef(0)
  const [planPromptRefresh, setPlanPromptRefresh] = useState(0)
  const [shotsPerScene, setShotsPerScene] = useState<number | string>(3)
  const [plannedScenes, setPlannedScenes] = useState<PlannedScene[] | null>(null)
  const [planSourceModelId, setPlanSourceModelId] = useState('')
  const [planRequestId, setPlanRequestId] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planRawOutput, setPlanRawOutput] = useState<string | null>(null)
  const [deleteSceneId, setDeleteSceneId] = useState<string | null>(null)
  const [working, setWorking] = useState<'save' | 'convert' | 'plan' | 'create-plan' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange

  const remoteScript = (detail as ScriptDetail).script
  const remoteSignature = JSON.stringify({ brief: detail.brief, script: remoteScript })
  const remoteSignatureRef = useRef(remoteSignature)
  remoteSignatureRef.current = remoteSignature
  const syncedRemoteSignature = useRef(remoteSignature)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const hasUnsavedWork = dirty || (showPlan && !!plannedScenes)
  const existingDurationByScene = useMemo(() => {
    const durations = new Map<string, number>()
    detail.shots.forEach((shot) => {
      if (shot.source_scene_id) durations.set(shot.source_scene_id, (durations.get(shot.source_scene_id) || 0) + shot.duration)
    })
    return durations
  }, [detail.shots])
  const linkedSceneIds = useMemo(() => new Set(existingDurationByScene.keys()), [existingDurationByScene])
  const availableModels = models.filter((model) => model.modality === 'text' && model.enabled && providers.some((provider) => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))
  const { modelId: planModelId, selectModel: selectPlanModel } = useSharedModelSelection('text', availableModels,
    { locked: busy || !!working, active: showPlan })
  const selectedScenes = draft.scenes.filter((scene) => scene.id && selectedSceneIds.includes(scene.id))
  const quickConvertScenes = selectedScenes.filter((scene) => !linkedSceneIds.has(scene.id!))
  const selectedPlanModelAvailable = availableModels.some((model) => model.id === planModelId)
  const validShotsPerScene = Number.isInteger(Number(shotsPerScene)) && Number(shotsPerScene) >= 2 && Number(shotsPerScene) <= 5
  const shortScenes = selectedScenes.filter((scene) => scene.duration < Number(shotsPerScene))
  const planIssues = plannedScenes?.map(plannedSceneIssue) || []
  const planModelChanged = !!plannedScenes && planSourceModelId !== planModelId
  const planReady = !planModelChanged && !!planRequestId && !!plannedScenes?.length && plannedScenes.length === selectedScenes.length && new Set(plannedScenes.map((scene) => scene.scene_id)).size === selectedScenes.length && plannedScenes.every((scene) => selectedScenes.some((selected) => selected.id === scene.scene_id && selected.duration === scene.scene_duration)) && planIssues.every((issue) => !issue)
  const totalDuration = draft.scenes.reduce((sum, scene) => sum + scene.duration, 0)
  const disabled = busy || !!working
  const canUndo = historyRevision >= 0 && historyRef.current.past.length > 0
  const canRedo = historyRevision >= 0 && historyRef.current.future.length > 0

  useEffect(() => {
    const previous = draftRef.current
    if (previous !== draft) {
      if (!historyActionRef.current) {
        historyRef.current.past.push(previous)
        if (historyRef.current.past.length > 80) historyRef.current.past.shift()
        historyRef.current.future = []
      }
      historyActionRef.current = false
      draftRef.current = draft
      setHistoryRevision((value) => value + 1)
    }
  }, [draft])

  function undoDraft() {
    const previous = historyRef.current.past.pop()
    if (!previous) return
    historyRef.current.future.unshift(draftRef.current)
    historyActionRef.current = true
    draftRef.current = previous
    setDraft(previous)
    setHistoryRevision((value) => value + 1)
  }

  function redoDraft() {
    const next = historyRef.current.future.shift()
    if (!next) return
    historyRef.current.past.push(draftRef.current)
    historyActionRef.current = true
    draftRef.current = next
    setDraft(next)
    setHistoryRevision((value) => value + 1)
  }

  useEffect(() => {
    if (!showPlan || !validShotsPerScene || selectedSceneIds.length === 0) return
    const requestId = ++planPromptRequestId.current
    setPlanPromptLoading(true)
    setPlanPromptError(null)
    void api<{ prompt: string }>(`/projects/${detail.id}/script/plan-shots/prompt`, json('POST', {
      scene_ids: selectedSceneIds, shots_per_scene: Number(shotsPerScene),
    })).then((result) => {
      if (requestId === planPromptRequestId.current && !planPromptEditedRef.current) setPlanPrompt(result.prompt)
    }).catch((issue) => {
      if (requestId === planPromptRequestId.current) setPlanPromptError(`提示词加载失败：${errorMessage(issue)}`)
    }).finally(() => {
      if (requestId === planPromptRequestId.current) setPlanPromptLoading(false)
    })
    return () => { if (requestId === planPromptRequestId.current) planPromptRequestId.current += 1 }
  }, [showPlan, detail.id, selectedSceneIds.join(','), shotsPerScene, remoteSignature, planPromptRefresh])

  useEffect(() => { onDirtyChangeRef.current?.(hasUnsavedWork) }, [hasUnsavedWork])
  useEffect(() => () => { onDirtyChangeRef.current?.(false) }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!disabled && dirty) void saveScript()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled, dirty])

  useEffect(() => {
    if (dirty || remoteSignature === syncedRemoteSignature.current) return
    syncedRemoteSignature.current = remoteSignature
    const next = fromDetail(detail)
    const currentSceneIds = new Set(next.scenes.map((scene) => scene.id).filter((id): id is string => !!id))
    setSelectedSceneIds((current) => current.filter((id) => currentSceneIds.has(id)))
    if (showPlan && plannedScenes) setPlanError('剧本已更新，原镜头规划不再适用。请重新生成预览。')
    setPlannedScenes(null)
    setPlanRequestId(null)
    setPlanRawOutput(null)
    if (JSON.stringify(next) !== JSON.stringify(saved)) {
      setSaved(next)
      setDraft(next)
      setActiveSceneId((current) => next.scenes.some((scene) => scene.clientId === current) ? current : next.scenes[0]?.clientId || null)
    }
  }, [remoteSignature, dirty])

  useEffect(() => {
    if (!hasUnsavedWork) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [hasUnsavedWork])

  useEffect(() => {
    if (!formatMenu) return
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.script-format-menu')) setFormatMenu(null)
    }
    document.addEventListener('pointerdown', closeMenu)
    return () => document.removeEventListener('pointerdown', closeMenu)
  }, [formatMenu])

  function updateArtifact(type: ScriptArtifactType, content: string, document?: JSONContent, episodeNumber = 0) {
    const plainContent = document ? textDocumentText(document) : content
    setDraft((current) => {
      const artifact = current.artifacts.find((item) => item.artifact_type === type && (item.episode_number || 0) === episodeNumber)
      if (artifact?.content === content && JSON.stringify(artifact.document || null) === JSON.stringify(document || null)) return current
      return {
        ...current,
        artifacts: current.artifacts.map((item) => item.artifact_type === type && (item.episode_number || 0) === episodeNumber
          ? { ...item, content, document, status: 'edited' } : item),
        ...(type === 'outline' ? { outline: plainContent } : {}),
        ...(type === 'characters' ? { characters: plainContent } : {}),
        ...(type === 'world' ? {
          generation_options: { ...current.generation_options, era: plainContent.replace(/^时代与地点：/, '') },
        } : {}),
        ...(type === 'hooks' ? {
          generation_options: { ...current.generation_options, core_hook: plainContent },
        } : {}),
      }
    })
  }

  function formatFocusedText(kind: TextFormat) {
    const editor = focusedEditorRef.current
    const artifactType = focusedArtifactRef.current
    if (!editor || !artifactType || !editor.isEditable) {
      setError('先点击一个剧本正文输入区域')
      return
    }
    applyTextFormat(editor, kind)
    setFormatMenu(null)
  }

  function focusedEditorIsActive(name: string, attrs?: Record<string, unknown>): boolean {
    const editor = focusedEditorRef.current
    return !!editor?.isActive(name, attrs)
  }

  function selectDocumentSection(section: DocumentSection, resetDocument = false) {
    selectSection(section, resetDocument)
    focusedEditorRef.current = null
    focusedArtifactRef.current = null
    if (section === 'scenes') {
      setActiveSceneId((current) => current || draft.scenes[0]?.clientId || null)
    }
  }

  function clearFormattingFocus() {
    focusedEditorRef.current = null
    focusedArtifactRef.current = null
    setSelectionRevision(value => value + 1)
  }

  function renderGenerationDraft(artifact: ScriptArtifact) {
    return <div className="script-generation-draft" aria-label={`${artifact.title}待确认草稿`}>
      <div className="script-generation-draft-status"><strong>已保存草稿 · 待确认</strong><span>确认后可编辑</span></div>
      <RichArtifactEditor key={artifact.id} {...artifactSearchProps(artifact)} label={artifact.title} placeholder=""
        value={artifact.content} disabled onFocus={clearFormattingFocus} onSelectionChange={clearFormattingFocus} onChange={() => {}} />
    </div>
  }

  function removeScene(clientId: string) {
    const index = draft.scenes.findIndex((scene) => scene.clientId === clientId)
    const scene = draft.scenes[index]
    if (!scene) return
    const nextScenes = draft.scenes.filter((item) => item.clientId !== clientId)
    setDraft((current) => ({ ...current, scenes: current.scenes.filter((item) => item.clientId !== clientId) }))
    setSelectedSceneIds((current) => current.filter((id) => id !== scene.id))
    if (activeSceneId === clientId) setActiveSceneId(nextScenes[Math.min(index, nextScenes.length - 1)]?.clientId || null)
    setDeleteSceneId(null)
  }

  async function saveScript() {
    if (disabled || !dirty) return
    const emptyHeading = draft.scenes.findIndex((scene) => !scene.heading.trim())
    if (emptyHeading >= 0) {
      setActiveSceneId(draft.scenes[emptyHeading].clientId)
      setError(`第 ${emptyHeading + 1} 场需要填写场景标题`)
      return
    }
    const invalidDuration = draft.scenes.findIndex((scene) => !Number.isInteger(scene.duration) || scene.duration < 1 || scene.duration > maxScriptSceneDuration)
    if (invalidDuration >= 0) {
      setActiveSceneId(draft.scenes[invalidDuration].clientId)
      setError(`第 ${invalidDuration + 1} 场的预计时长应为 1-${maxScriptSceneDuration} 秒的整数`)
      return
    }
    setWorking('save')
    setError(null)
    try {
      const savedScript = await api<ProjectDetail['script'] & { artifacts?: ScriptArtifact[] }>(`/projects/${detail.id}/script/commit`, json('PUT', {
        brief: draft.brief,
        outline: draft.outline,
        characters: draft.characters,
        generation_options: draft.generation_options,
        scenes: draft.scenes.map(({ id, clientId: _clientId, ...fields }) => ({ ...(id ? { id } : {}), ...fields })),
        artifacts: draft.artifacts.filter(artifact => !artifact.id.startsWith('local-') || artifact.content.trim()).map(({ id, project_id: _projectId, created_at: _createdAt, updated_at: _updatedAt, document: _document, ...artifact }, index) => ({
          ...artifact,
          ...(id.startsWith('local-') ? {} : { id }),
          position: index,
        })),
      }))
      const nextDraft = fromDetail({ ...detail, brief: draft.brief, script: savedScript })
      setDraft(nextDraft)
      setSaved(nextDraft)
      setActiveSceneId((current) => {
        const currentScene = draft.scenes.find((scene) => scene.clientId === current)
        const index = draft.scenes.findIndex((scene) => scene.clientId === current)
        return currentScene?.id || nextDraft.scenes[Math.max(index, 0)]?.clientId || null
      })
      setSelectedSceneIds((current) => current.filter((id) => nextDraft.scenes.some((scene) => scene.id === id)))
      try {
        await onRefresh()
        onNotice('剧本已保存')
      } catch {
        onNotice('剧本已保存，项目刷新失败，请稍后重试')
      }
    } catch (issue) {
      setError(`保存失败：${errorMessage(issue)}`)
    } finally {
      setWorking(null)
    }
  }

  async function convertToShots() {
    if (disabled || dirty || quickConvertScenes.length === 0) return
    setWorking('convert')
    setError(null)
    try {
      const result = await api<{ shots: { id: string }[]; skipped_scene_ids: string[] }>(`/projects/${detail.id}/script/convert-to-shots`, json('POST', {
        scene_ids: quickConvertScenes.map((scene) => scene.id),
      }))
      setSelectedSceneIds([])
      setShowConvert(false)
      try {
        await onRefresh()
      } catch {
        onNotice(`已创建 ${result.shots.length} 个分镜，项目刷新失败，请稍后重试`)
        return
      }
      if (result.shots.length) {
        onNotice(`已添加 ${result.shots.length} 个分镜${result.skipped_scene_ids.length ? `，跳过 ${result.skipped_scene_ids.length} 个已有分镜的场次` : ''}，可导入项目画布`)
        onOpenCanvas()
      } else {
        onNotice('所选场次已有分镜')
      }
    } catch (issue) {
      setError(`拆分失败：${errorMessage(issue)}`)
      setShowConvert(false)
    } finally {
      setWorking(null)
    }
  }

  async function discardPlanPreview(): Promise<boolean> {
    if (plannedScenes && !await confirm({ title: '丢弃分镜规划预览', message: '当前 AI 规划预览将丢失，重新生成可能再次产生费用。', confirmLabel: '丢弃预览', danger: true })) return false
    setPlannedScenes(null)
    setPlanRequestId(null)
    setPlanError(null)
    setPlanRawOutput(null)
    return true
  }

  async function closePlan(): Promise<boolean> {
    if (working === 'plan' || working === 'create-plan' || !await discardPlanPreview()) return false
    setShowPlan(false)
    return true
  }

  async function generateShotPlan() {
    if (disabled || dirty || !selectedScenes.length || selectedScenes.length > 10 || !selectedPlanModelAvailable || !validShotsPerScene || !planPrompt.trim() || (!planPromptCustomized && (planPromptLoading || planPromptError))) return
    if (plannedScenes && !await confirm({ title: '重新规划分镜', message: '当前预览和手动修改会被替换。', confirmLabel: '重新规划', danger: true })) return
    setWorking('plan')
    setPlanError(null)
    setPlanRawOutput(null)
    const planningSignature = remoteSignatureRef.current
    try {
      const result = await api<ShotPlanResult>(`/projects/${detail.id}/script/plan-shots`, json('POST', {
        model_id: planModelId,
        scene_ids: selectedScenes.map((scene) => scene.id),
        shots_per_scene: Number(shotsPerScene),
        prompt_override: planPrompt,
      }))
      if (remoteSignatureRef.current !== planningSignature) throw new Error('剧本已更新，请重新生成分镜规划')
      if (!Array.isArray(result.scenes) || result.scenes.length !== selectedScenes.length) throw new Error('模型返回的场次数量不完整，请重试')
      const plan = selectedScenes.map((scene) => {
        const matches = result.scenes.filter((item) => item.scene_id === scene.id)
        if (matches.length !== 1 || !Array.isArray(matches[0].shots) || matches[0].shots.length < 1 || matches[0].shots.length > Math.min(5, scene.duration)) {
          throw new Error(`「${scene.heading}」的镜头数量超出 1-${Math.min(5, scene.duration)} 个，请重试`)
        }
        if (matches[0].scene_duration !== scene.duration) throw new Error(`「${scene.heading}」的场次时长已变化，请刷新后重试`)
        return {
          scene_id: scene.id!,
          scene_heading: scene.heading,
          scene_duration: scene.duration,
          shots: matches[0].shots.map((shot) => ({
            title: typeof shot.title === 'string' ? shot.title : '',
            prompt: typeof shot.prompt === 'string' ? shot.prompt : '',
            image_prompt: typeof shot.image_prompt === 'string' ? shot.image_prompt : '',
            video_prompt: typeof shot.video_prompt === 'string' ? shot.video_prompt : '',
            duration: typeof shot.duration === 'number' && Number.isFinite(shot.duration) ? shot.duration : 0,
            start_state: typeof shot.start_state === 'string' ? shot.start_state : '',
            end_state: typeof shot.end_state === 'string' ? shot.end_state : '',
            cut_note: typeof shot.cut_note === 'string' ? shot.cut_note : '',
          })),
        }
      })
      setPlannedScenes(plan)
      setPlanSourceModelId(planModelId)
      setPlanRequestId(crypto.randomUUID())
      setPlanRawOutput(null)
    } catch (issue) {
      setPlanError(`规划失败：${errorMessage(issue)}`)
      setPlanRawOutput(issue instanceof Error && 'raw_output' in issue && typeof issue.raw_output === 'string' ? issue.raw_output : null)
    } finally {
      setWorking(null)
    }
  }

  function updatePlannedShot(sceneId: string, shotIndex: number, patch: Partial<PlannedShot>) {
    setPlannedScenes((current) => current?.map((scene) => scene.scene_id === sceneId ? {
      ...scene,
      shots: scene.shots.map((shot, index) => index === shotIndex ? { ...shot, ...patch } : shot),
    } : scene) || null)
  }

  function addPlannedShot(sceneId: string) {
    setPlannedScenes((current) => current?.map((scene) => {
      if (scene.scene_id !== sceneId || scene.shots.length >= Math.min(5, scene.scene_duration)) return scene
      const shots = scene.shots.map((shot) => ({ ...shot }))
      const longestIndex = shots.reduce((best, shot, index) => shot.duration > shots[best].duration ? index : best, 0)
      if (shots[longestIndex].duration > 1) shots[longestIndex].duration -= 1
      shots.push({ title: `镜头 ${shots.length + 1}`, prompt: '', duration: 1,
        start_state: '', end_state: '', cut_note: '' })
      return { ...scene, shots }
    }) || null)
  }

  function removePlannedShot(sceneId: string, shotIndex: number) {
    setPlannedScenes((current) => current?.map((scene) => {
      if (scene.scene_id !== sceneId || scene.shots.length <= 1 || shotIndex < 0 || shotIndex >= scene.shots.length) return scene
      const shots = scene.shots.map((shot) => ({ ...shot }))
      const [removed] = shots.splice(shotIndex, 1)
      const neighborIndex = Math.min(shotIndex, shots.length - 1)
      shots[neighborIndex].duration += removed.duration
      return { ...scene, shots }
    }) || null)
  }

  async function createPlannedShots() {
    if (disabled || dirty || !planReady || !plannedScenes || !planRequestId) return
    setWorking('create-plan')
    setPlanError(null)
    try {
      const result = await api<PlannedShotCreationResult>(`/projects/${detail.id}/script/create-planned-shots`, json('POST', {
        request_id: planRequestId,
        scenes: plannedScenes.map((scene) => ({
          scene_id: scene.scene_id,
          shots: scene.shots.map((shot) => ({
            title: shot.title.trim(),
            prompt: shot.prompt.trim(),
            image_prompt: shot.image_prompt?.trim() || '',
            video_prompt: shot.video_prompt?.trim() || '',
            duration: shot.duration,
            start_state: shot.start_state || '',
            end_state: shot.end_state || '',
            cut_note: shot.cut_note || '',
          })),
        })),
      }))
      setShowPlan(false)
      setPlannedScenes(null)
      setPlanRequestId(null)
      setSelectedSceneIds([])
      const replayNotice = result.replayed
        ? result.payload_changed
          ? '此前提交已成功；之后对预览的修改未创建，已返回此前创建的分镜'
          : `此前提交已成功，已返回已创建的 ${result.shots.length} 个分镜`
        : `已创建 ${result.shots.length} 个分镜`
      let refreshFailed = false
      try {
        await onRefresh()
      } catch {
        refreshFailed = true
      }
      onNotice(`${replayNotice}${refreshFailed ? '；项目刷新失败，请稍后重试' : '，可导入项目画布'}`)
      if (result.shots[0] && !refreshFailed) onOpenCanvas()
    } catch (issue) {
      setPlanError(`创建失败：${errorMessage(issue)}`)
    } finally {
      setWorking(null)
    }
  }

  const sceneForDeletion = draft.scenes.find((scene) => scene.clientId === deleteSceneId)
  const activeGroup = editorDocumentGroups.find(group => group.stage === scriptStageForArtifact(activeDocumentSection)) || editorDocumentGroups[0]!
  const activeGroupCatalog = catalogForStage(activeGroup.stage)
  const activeGroupDrafts = activeGroupCatalog.filter(item => pendingArtifacts.some(artifact => artifact.artifact_type === item.type && !artifact.episode_number)).length
  const activeGroupFilled = activeGroupCatalog.filter(item => [...draft.artifacts, ...pendingArtifacts].some(artifact => artifact.artifact_type === item.type && !artifact.episode_number && artifact.content.trim())).length
  const activeGroupMissing = activeGroupCatalog.length - activeGroupFilled
  const canSupplementGroup = !!onSupplementStage && workflowProgress(remoteScript || {}).completed[activeGroup.stage]
  const legacyScript = [...draft.artifacts, ...pendingArtifacts].find(artifact => artifact.artifact_type === 'episode_script' && !artifact.episode_number && artifact.content.trim())
  const episodeDocuments = [...draft.artifacts, ...pendingArtifacts]
    .filter(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) > 0)
    .filter((item, index, items) => items.findIndex(other => other.episode_number === item.episode_number) === index)
    .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
  const selectedEpisode = episodeDocuments.find(item => `episode-${item.episode_number}` === activeDocumentSection)
  const productionSceneCandidates = selectedEpisode
    ? draft.scenes.filter(scene => scene.episode_number === selectedEpisode.episode_number)
    : draft.scenes

  return <section className="script-page" aria-label="剧本创作">
    <header className="script-page-header script-editor-topbar">
      <div className="script-editor-titlebar">
        <ActionIcon type="button" className="script-editor-back" onClick={onOpenCanvas} aria-label="返回画布" title="返回画布" data-workspace-control=""><ArrowLeft size={17} /></ActionIcon>
        <div className="script-editor-document-title"><strong>编辑器 - {detail.name || '未命名项目'}</strong><span>{draft.scenes.length} 场 · {totalDuration} 秒</span></div>
        <span className={`script-save-state ${hasUnsavedWork ? 'is-dirty' : ''}`}><span />{dirty ? '未保存' : showPlan && plannedScenes ? '待创建' : '已保存'}</span>
      </div>
      <div className="script-editor-toolbar" aria-label="编辑工具">
        <ActionIcon type="button" aria-label="撤销" title="撤销" disabled={!canUndo || disabled} onClick={undoDraft} data-workspace-control=""><Undo2 size={16} /></ActionIcon>
        <ActionIcon type="button" aria-label="重做" title="重做" disabled={!canRedo || disabled} onClick={redoDraft} data-workspace-control=""><Redo2 size={16} /></ActionIcon>
        <i />
        <ActionIcon type="button" aria-label="缩小" title="缩小" onClick={() => setEditorZoom((value) => Math.max(80, value - 10))} disabled={editorZoom <= 80} data-workspace-control=""><ZoomOut size={16} /></ActionIcon>
        <span className="script-editor-zoom">{editorZoom}%</span>
        <ActionIcon type="button" aria-label="放大" title="放大" onClick={() => setEditorZoom((value) => Math.min(140, value + 10))} disabled={editorZoom >= 140} data-workspace-control=""><ZoomIn size={16} /></ActionIcon>
        <i />
        <div className="script-format-menu"><Menu opened={formatMenu === 'heading'} onChange={opened => setFormatMenu(opened ? 'heading' : null)} withinPortal={false} returnFocus={false} position="bottom-start">
          <Menu.Target><UnstyledButton type="button" aria-label="标题格式" title="标题格式" aria-haspopup="menu" aria-expanded={formatMenu === 'heading'} aria-pressed={formatMenu === 'heading' || focusedEditorIsActive('heading')} className={formatMenu === 'heading' || focusedEditorIsActive('heading') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => setFormatMenu((value) => value === 'heading' ? null : 'heading')}><Heading1 size={16} /><ChevronDown size={11} /></UnstyledButton></Menu.Target>
          {formatMenu === 'heading' && <Menu.Dropdown className="script-format-popover" role="menu" aria-label="标题格式">
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h1')} data-workspace-control=""><Heading1 size={15} /><strong>标题 1</strong></Menu.Item>
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h2')} data-workspace-control=""><Heading1 size={15} /><strong>标题 2</strong></Menu.Item>
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h3')} data-workspace-control=""><Heading1 size={15} /><strong>标题 3</strong></Menu.Item>
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('paragraph')} data-workspace-control=""><FileText size={15} /><strong>正文</strong></Menu.Item>
          </Menu.Dropdown>}
        </Menu></div>
        <div className="script-format-menu"><Menu opened={formatMenu === 'list'} onChange={opened => setFormatMenu(opened ? 'list' : null)} withinPortal={false} returnFocus={false} position="bottom-start">
          <Menu.Target><UnstyledButton type="button" aria-label="列表格式" title="列表格式" aria-haspopup="menu" aria-expanded={formatMenu === 'list'} aria-pressed={formatMenu === 'list' || focusedEditorIsActive('bulletList') || focusedEditorIsActive('orderedList')} className={formatMenu === 'list' || focusedEditorIsActive('bulletList') || focusedEditorIsActive('orderedList') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => setFormatMenu((value) => value === 'list' ? null : 'list')}><List size={16} /><ChevronDown size={11} /></UnstyledButton></Menu.Target>
          {formatMenu === 'list' && <Menu.Dropdown className="script-format-popover" role="menu" aria-label="列表格式">
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('bulletList')} data-workspace-control=""><List size={15} /><strong>无序列表</strong></Menu.Item>
            <Menu.Item type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('orderedList')} data-workspace-control=""><ListOrdered size={15} /><strong>有序列表</strong></Menu.Item>
          </Menu.Dropdown>}
        </Menu></div>
        <i />
        <ActionIcon type="button" aria-label="粗体" title="粗体" aria-pressed={focusedEditorIsActive('bold')} className={focusedEditorIsActive('bold') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('bold')} data-workspace-control=""><Bold size={16} /></ActionIcon>
        <ActionIcon type="button" aria-label="斜体" title="斜体" aria-pressed={focusedEditorIsActive('italic')} className={focusedEditorIsActive('italic') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('italic')} data-workspace-control=""><Italic size={16} /></ActionIcon>
        <ActionIcon type="button" aria-label="删除线" title="删除线" aria-pressed={focusedEditorIsActive('strike')} className={focusedEditorIsActive('strike') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('strike')} data-workspace-control=""><Strikethrough size={16} /></ActionIcon>
      </div>
      <div className="script-page-actions">
        <ActionIcon type="button" className={`script-editor-search-toggle ${search.opened ? 'is-active' : ''}`} aria-label="全文搜索" title="全文搜索（Ctrl/Cmd + F）" aria-expanded={search.opened} aria-controls="script-full-text-search" onClick={search.open} data-workspace-control=""><Search size={16} /></ActionIcon>
        <Button className="script-canvas-action" variant="subtle" title="规划并保存分镜方案" leftSection={<Plus size={15} />} disabled={disabled || dirty || !productionSceneCandidates.length} onClick={() => { const ids = productionSceneCandidates.flatMap(scene => scene.id ? [scene.id] : []); if (onOpenShotManager) onOpenShotManager(ids); else { setPlanningSceneIds(ids); setStoryboardOpen(true) } }}>规划分镜</Button>
        <Button leftSection={working === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} onClick={saveScript} disabled={!dirty || disabled}>保存</Button>
        <ActionIcon type="button" className="script-editor-exit" onClick={onOpenCanvas} aria-label="退出编辑器" title="退出编辑器" data-workspace-control=""><Minimize2 size={16} /></ActionIcon>
        <ThemeToggle />
      </div>
      <ScriptDocumentSearch search={search} />
    </header>

    {error && <div className="script-error" role="alert">{error}<Button onClick={() => setError(null)} aria-label="关闭提示" data-workspace-control="" variant="subtle">关闭</Button></div>}

    <section className="script-document" aria-label="剧本文档">
      <aside className="script-document-nav" aria-label="剧本目录">
        {editorDocumentGroups.map(group => {
          const items = catalogForStage(group.stage)
          return <div key={group.stage} className={items.length > 1 ? 'script-document-nav-feature' : undefined} data-script-stage={group.stage}>
            <Button type="button" className={`script-document-nav-primary ${items.length === 1 ? 'script-document-nav-standalone' : ''} ${scriptStageForArtifact(activeDocumentSection) === group.stage ? 'is-active' : ''}`} onClick={() => selectDocumentSection(items[0]!.type, true)} data-workspace-control="" variant="subtle">{group.title}</Button>
            {items.length > 1 && <div className="script-document-nav-nested">
              {items.map(item => {
                const missing = ![...draft.artifacts, ...pendingArtifacts].some(artifact => artifact.artifact_type === item.type && !artifact.episode_number && artifact.content.trim())
                return <UnstyledButton type="button" key={item.type} className={`script-document-nav-item ${missing ? 'is-missing' : ''} ${activeDocumentSection === item.type ? 'is-active' : ''}`} title={missing ? `${item.title}（未生成）` : item.title} onClick={() => selectDocumentSection(item.type)}><span>{item.title}</span>{missing && <span className="script-document-missing-dot" aria-hidden="true" />}</UnstyledButton>
              })}
            </div>}
          </div>
        })}
        {legacyScript && <Button type="button" className={`script-document-nav-primary script-document-nav-standalone ${activeDocumentSection === 'episode_script' ? 'is-active' : ''}`} onClick={() => selectDocumentSection('episode_script', true)} data-workspace-control="" variant="subtle">{scriptArtifactLabels.episode_script}</Button>}
        {episodeDocuments.map(artifact => <Button type="button" key={artifact.id} className={`script-document-nav-primary script-document-nav-standalone ${selectedEpisode?.id === artifact.id ? 'is-active' : ''}`} onClick={() => selectDocumentSection(`episode-${artifact.episode_number!}`)} data-workspace-control="" variant="subtle">{artifact.title}</Button>)}
      </aside>
      <article
        ref={documentEditorRef}
        className="script-document-editor"
        style={{ '--script-editor-scale': editorZoom / 100 } as CSSProperties}
      >
        <div className="script-long-document">
          {selectedEpisode || activeDocumentSection === 'episode_script' && legacyScript ? (() => {
            const artifact = selectedEpisode || legacyScript!
            const pending = pendingArtifacts.find(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) === (artifact.episode_number || 0))
            const accepted = draft.artifacts.find(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) === (artifact.episode_number || 0)
              && ((item.episode_number || 0) > 0 || item.content.trim()))
            const section: DocumentSection = selectedEpisode ? `episode-${selectedEpisode.episode_number!}` : 'episode_script'
            return <>
            <header className="script-long-document-cover script-standalone-cover"><span className="script-kicker">分集剧本</span><h1>分集剧本</h1><p>{pending && !accepted ? '本集草稿已保存，确认后可编辑和制作分镜。' : selectedEpisode ? '只修改当前集，其他集和已保存资料保留。' : '已保存的剧本正文，支持手动修改。'}</p></header>
            <section id={`script-section-${section}`} data-script-section={section} className="script-long-section script-standalone-section">
              <header className="script-long-section-heading"><div><h2>{artifact.title}</h2></div></header>
              {pending && renderGenerationDraft(pending)}
              {pending && accepted && <div className="script-confirmed-version-label">已确认版本</div>}
              {accepted && <RichArtifactEditor
                key={accepted.id}
                {...artifactSearchProps(accepted)}
                label={accepted.title}
                placeholder="填写本集分场正文"
                value={accepted.content}
                document={accepted.document}
                disabled={disabled}
                onFocus={editor => { focusedEditorRef.current = editor; focusedArtifactRef.current = 'episode_script' }}
                onSelectionChange={editor => { focusedEditorRef.current = editor; setSelectionRevision(value => value + 1) }}
                onChange={(content, document) => updateArtifact('episode_script', content, document, artifact.episode_number || 0)}
              />}
            </section>
          </>
          })() : <>
          <header className={`script-long-document-cover ${activeGroup.stage === 'outline' ? '' : 'script-standalone-cover'}`}>
            <span className="script-kicker">{activeGroup.title}</span>
            <h1>{activeGroup.title}</h1>
            <p>{activeGroup.stage === 'outline' ? [draft.generation_options.genre, draft.generation_options.genre_fusion].filter(Boolean).join(' × ') || draft.brief.trim() || activeGroup.description : activeGroup.description}</p>
            <div className="script-stage-completeness">
              <span>{activeGroupDrafts ? '已生成' : '已填写'} {activeGroupFilled}/{activeGroupCatalog.length} 项{activeGroupDrafts > 0 ? `，${activeGroupDrafts} 项待确认` : ''}{activeGroupMissing > 0 ? `，${activeGroupMissing} 项未生成` : '，栏目已齐全'}</span>
              {activeGroupMissing > 0 && canSupplementGroup && <Button size="xs" variant="light" leftSection={<Sparkles size={13} />} disabled={disabled || hasUnsavedWork} title={hasUnsavedWork ? '请先保存当前手动修改' : `选择模型后，只补齐${activeGroup.title}未生成的栏目`} onClick={() => onSupplementStage?.(activeGroup.stage)}>补齐{activeGroup.title}缺项</Button>}
            </div>
          </header>
          {activeGroupCatalog.map((item, index) => {
            const artifact = draft.artifacts.find((entry) => entry.artifact_type === item.type && !entry.episode_number)
            if (!artifact) return null
            const pending = pendingArtifacts.find(entry => entry.artifact_type === item.type && !entry.episode_number)
            const heading = !artifact.content.trim() && pending ? pending : artifact
            return <section id={`script-section-${item.type}`} data-script-section={item.type} className={`script-long-section ${artifact.content.trim() || pending ? '' : 'is-empty'} ${activeDocumentSection === item.type ? 'is-active' : ''}`} key={item.type}>
              <header className="script-long-section-heading">
                <div><span className="script-section-index">{String(index + 1).padStart(2, '0')}</span><div><span className="script-kicker">{item.group}</span><h2>{heading.title === activeGroup.title && (activeGroup.stage === 'locations' || activeGroup.stage === 'props') ? item.title : heading.title}</h2></div></div>
              </header>
              {pending && renderGenerationDraft(pending)}
              {pending && artifact.content.trim() && <div className="script-confirmed-version-label">已确认版本</div>}
              {!artifact.content.trim() && !editingEmptySections.has(item.type) ? !pending && <div className="script-section-empty">
                <div><strong>未生成</strong><span>此栏目暂无正文，可手动填写{canSupplementGroup ? '，或通过上方入口补齐缺项' : ''}。</span></div>
                <Button size="xs" variant="subtle" disabled={disabled} aria-label={`手动填写${item.title}`} onClick={() => setEditingEmptySections(current => new Set(current).add(item.type))}>手动填写</Button>
              </div> : <RichArtifactEditor
                key={artifact.id}
                {...artifactSearchProps(artifact)}
                label={artifact.title}
                placeholder={`填写${item.title}，支持分段描述和手动修改`}
                value={artifact.content}
                disabled={disabled}
                document={artifact.document}
                onFocus={(editor) => { focusedEditorRef.current = editor; focusedArtifactRef.current = item.type }}
                onSelectionChange={(editor) => { focusedEditorRef.current = editor; setSelectionRevision((value) => value + 1) }}
                onChange={(content, document) => updateArtifact(artifact.artifact_type, content, document)}
              />}
            </section>
          })}
          </>}
        </div>
      </article>
    </section>

    <Modal opened={showConvert} onClose={() => !working && setShowConvert(false)} title={selectedEpisode ? `第 ${selectedEpisode.episode_number} 集 · 选择制作场次` : '选择制作场次'} classNames={{ content: 'script-modal-content', body: 'script-modal-body' }}>
      <div className="script-modal-stack">
        <p className="script-confirm-copy">完整剧本会保留。仅将选中的场次创建为镜头，不会调用生成模型；已有镜头不会重复创建。</p>
        <div className="script-scene-production-list">
          {productionSceneCandidates.map(scene => <label key={scene.clientId}>
            <Checkbox aria-label={`制作场次：${scene.heading}`} disabled={disabled || !scene.id || linkedSceneIds.has(scene.id)} checked={!!scene.id && selectedSceneIds.includes(scene.id)}
              onChange={event => { const checked = event.currentTarget.checked; if (scene.id) setSelectedSceneIds(ids => checked ? [...ids, scene.id!] : ids.filter(id => id !== scene.id)) }} />
            <strong>{!selectedEpisode && scene.episode_number ? `第 ${scene.episode_number} 集 · ` : ''}{scene.heading}</strong><small>{scene.id && linkedSceneIds.has(scene.id) ? '已创建镜头' : `${scene.duration} 秒`}</small>
          </label>)}
        </div>
        <p className="script-confirm-copy">已选 {quickConvertScenes.length} 场 · {quickConvertScenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒</p>
        <div className="script-modal-actions"><Button variant="default" disabled={disabled} onClick={() => setShowConvert(false)}>取消</Button><Button loading={working === 'convert'} disabled={disabled || dirty || quickConvertScenes.length === 0} onClick={convertToShots} leftSection={<Clapperboard size={16} />}>确认创建</Button></div>
      </div>
    </Modal>

    <Modal opened={showPlan} onClose={() => void closePlan()} title="AI 拆分分镜" size="xl" closeOnEscape={!working} closeOnClickOutside={!working} classNames={{ content: 'script-modal-content', body: 'script-modal-body' }}>
      <div className="script-modal-stack">
        <p className="script-confirm-copy">将所选 {selectedScenes.length} 场规划为多个镜头。已有分镜的场次会追加新镜头，原有镜头和素材保持不变；新增镜头会增加项目总时长。</p>
        <div className="script-plan-settings">
          <Select label="文本模型" placeholder="选择已添加的模型" searchable allowDeselect={false} value={planModelId || null} disabled={disabled} data={availableModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => { if (value !== planModelId) void (async () => { if (await discardPlanPreview()) selectPlanModel(value || '') })() }} />
          <NumberInput label="每场目标镜头数" min={2} max={5} value={shotsPerScene} disabled={disabled} onChange={(value) => { if (value !== shotsPerScene) void (async () => { if (await discardPlanPreview()) setShotsPerScene(value) })() }} />
        </div>
        <div className="script-prompt-editor">
          <div className="script-prompt-heading"><strong>提示词设置</strong><Button variant="default" size="xs" leftSection={<RotateCcw size={14} />} loading={planPromptLoading} disabled={planPromptLoading || disabled} onClick={() => { planPromptEditedRef.current = false; setPlanPromptCustomized(false); setPlanPrompt(''); setPlanPromptRefresh((value) => value + 1) }}>恢复自动提示词</Button></div>
          <Textarea aria-label="分镜规划提示词" minRows={8} maxRows={16} autosize maxLength={500000} value={planPrompt} disabled={disabled} onChange={(event) => { planPromptEditedRef.current = true; setPlanPromptCustomized(true); setPlanPrompt(event.currentTarget.value) }} />
          {planPromptLoading && !planPromptCustomized && <small role="status">正在整理提示词...</small>}
          {planPromptError && !planPromptCustomized && <small className="script-prompt-error" role="alert">{planPromptError}</small>}
        </div>
        {!availableModels.length && <Button className="script-model-link" onClick={() => void (async () => { if (await closePlan()) onOpenModels() })()} data-workspace-control="" variant="subtle">前往模型设置添加文本模型 <ArrowRight size={15} /></Button>}
        {shortScenes.length > 0 && validShotsPerScene && <div className="script-plan-hint">{shortScenes.length === 1 ? `「${shortScenes[0].heading}」` : `${shortScenes.length} 个短场次`}少于目标镜头数。规划时会减少镜头，确保每个镜头至少 1 秒。</div>}
        {planError && <div className="script-error" role="alert">{planError}</div>}
        {planModelChanged && <div className="script-error" role="alert">文本模型已变化，当前预览已保留，请重新规划后创建分镜。</div>}
        {planRawOutput && <div className="script-raw-output"><strong>模型原始输出</strong><pre>{planRawOutput}</pre></div>}
        {plannedScenes ? <div className="script-plan-preview">
          <div className="script-plan-heading"><strong>镜头规划</strong><span>{plannedScenes.reduce((sum, scene) => sum + scene.shots.length, 0)} 个镜头 · 可修改后创建</span></div>
          {plannedScenes.map((scene, sceneIndex) => {
            const issue = planIssues[sceneIndex]
            const duration = scene.shots.reduce((sum, shot) => sum + shot.duration, 0)
            const existingDuration = existingDurationByScene.get(scene.scene_id)
            return <section className="script-plan-scene" key={scene.scene_id}>
              <div className="script-plan-scene-heading"><div><span>{String(sceneIndex + 1).padStart(2, '0')}</span><strong>{scene.scene_heading}</strong></div><div className="script-plan-scene-timing"><small className={issue ? 'is-invalid' : ''}>本次新增 {duration} / {scene.scene_duration} 秒</small>{existingDuration !== undefined && <small>已有 {existingDuration} 秒 + 新增 {duration} 秒 = 合计 {existingDuration + duration} 秒</small>}</div></div>
              <div className="script-plan-scene-tools"><span>{scene.shots.length} 个镜头{scene.shots.length < Number(shotsPerScene) ? ` · 目标 ${shotsPerScene} 个` : ''}</span><Tooltip label="添加镜头"><ActionIcon variant="subtle" aria-label={`为${scene.scene_heading}添加镜头`} disabled={disabled || scene.shots.length >= Math.min(5, scene.scene_duration)} onClick={() => addPlannedShot(scene.scene_id)}><Plus size={16} /></ActionIcon></Tooltip></div>
              <div className="script-plan-shots">{scene.shots.map((shot, shotIndex) => <div className="script-plan-shot" key={`${scene.scene_id}-${shotIndex}`}>
                <div className="script-plan-shot-rail"><span>镜头 {String(shotIndex + 1).padStart(2, '0')}</span><Tooltip label="删除镜头"><ActionIcon variant="subtle" color="red" aria-label={`删除${scene.scene_heading}镜头 ${shotIndex + 1}`} disabled={disabled || scene.shots.length <= 1} onClick={() => removePlannedShot(scene.scene_id, shotIndex)}><Trash2 size={15} /></ActionIcon></Tooltip></div>
                <div className="script-plan-shot-fields">
                  <TextInput label="镜头标题" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 标题`} maxLength={120} value={shot.title} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { title: event.currentTarget.value })} />
                  <NumberInput label="时长" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 时长`} min={1} max={30} suffix=" 秒" value={shot.duration} disabled={disabled} onChange={(value) => updatePlannedShot(scene.scene_id, shotIndex, { duration: typeof value === 'number' ? value : 0 })} />
                  <Textarea label="镜头描述" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 画面提示词`} maxLength={10000} minRows={2} autosize value={shot.prompt} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { prompt: event.currentTarget.value })} />
                  <Textarea label="首帧图片提示词" maxLength={20000} minRows={2} autosize value={shot.image_prompt || ''} placeholder="留空时根据镜头描述整理单幅首帧要求" disabled={disabled} onChange={event => updatePlannedShot(scene.scene_id, shotIndex, { image_prompt: event.currentTarget.value })} />
                  <Textarea label="动作与运镜视频提示词" maxLength={20000} minRows={2} autosize value={shot.video_prompt || ''} placeholder="留空时根据镜头描述与开镜、收镜状态整理视频要求" disabled={disabled} onChange={event => updatePlannedShot(scene.scene_id, shotIndex, { video_prompt: event.currentTarget.value })} />
                  <Textarea label="开始状态" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 开始状态`} maxLength={2000} minRows={2} autosize value={shot.start_state || ''} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { start_state: event.currentTarget.value })} />
                  <Textarea label="结束状态" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 结束状态`} maxLength={2000} minRows={2} autosize value={shot.end_state || ''} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { end_state: event.currentTarget.value })} />
                  <TextInput label="接镜备注" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 接镜备注`} maxLength={2000} value={shot.cut_note || ''} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { cut_note: event.currentTarget.value })} />
                </div>
              </div>)}</div>
              {issue && <p className="script-plan-issue" role="status">{issue}</p>}
            </section>
          })}
        </div> : <div className="script-plan-scenes">{selectedScenes.map((scene, index) => {
          const existingDuration = existingDurationByScene.get(scene.id!)
          return <div key={scene.id}><span>{String(index + 1).padStart(2, '0')}</span><strong>{scene.heading}</strong><small>{existingDuration === undefined ? `计划新增 ${scene.duration} 秒` : `已有 ${existingDuration} 秒 + 计划新增 ${scene.duration} 秒 = 合计 ${existingDuration + scene.duration} 秒`}</small></div>
        })}</div>}
        <div className="script-modal-actions script-plan-actions">
          <Button variant="default" onClick={() => void closePlan()} disabled={disabled}>取消</Button>
          <Button variant={plannedScenes ? 'default' : 'filled'} leftSection={working === 'plan' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} disabled={disabled || !selectedPlanModelAvailable || !validShotsPerScene || !planPrompt.trim() || (!planPromptCustomized && (planPromptLoading || !!planPromptError)) || selectedScenes.length > 10} onClick={generateShotPlan}>{plannedScenes ? '重新规划' : '生成预览'}</Button>
          {plannedScenes && <Button leftSection={working === 'create-plan' ? <LoaderCircle size={16} className="spin" /> : <Clapperboard size={16} />} disabled={disabled || !planReady} onClick={createPlannedShots}>创建 {plannedScenes.reduce((sum, scene) => sum + scene.shots.length, 0)} 个分镜</Button>}
        </div>
      </div>
    </Modal>

    <Modal opened={!!sceneForDeletion} onClose={() => setDeleteSceneId(null)} title="删除场次" classNames={{ content: 'script-modal-content', body: 'script-modal-body' }}>
      {sceneForDeletion && <div className="script-modal-stack"><p className="script-confirm-copy">删除「{sceneForDeletion.heading || '未命名场次'}」？保存剧本后才会移除该场次。已制作的镜头和素材会保留，但镜头会失去与该场次的关联。</p><div className="script-modal-actions"><Button variant="default" onClick={() => setDeleteSceneId(null)}>取消</Button><Button className="script-danger-button" color="red" onClick={() => removeScene(sceneForDeletion.clientId)} leftSection={<Trash2 size={16} />}>删除场次</Button></div></div>}
    </Modal>
    <StoryboardPlanner intent="plan" opened={storyboardOpen} onClose={() => setStoryboardOpen(false)} detail={detail} models={availableModels} initialSceneIds={planningSceneIds}
      onRefresh={onRefresh} onOpenCanvas={onOpenCanvas} onNotice={onNotice} />
    {dialog}
  </section>
}

export default ScriptEditor
