import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ActionIcon, Button, Checkbox, Modal, NumberInput, Select, Textarea, TextInput, Tooltip } from '@mantine/core'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor, JSONContent } from '@tiptap/core'
import {
  ArrowLeft, ArrowRight, Bold, Clapperboard, FileText, Heading1, Italic,
  List, ListOrdered, LoaderCircle, Minimize2, Plus, Redo2, Save, Sparkles,
  ChevronDown, Strikethrough, Trash2, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react'
import { api, json } from './api'
import type { Model, PlannedScene, PlannedShot, PlannedShotCreationResult, ProjectDetail, Provider, ScriptGenerationOptions, ShotPlanResult } from './api'
import './script-editor.css'
import { useAppDialog } from './AppDialog'
import { applyTextFormat, textEditorExtensions, type TextFormat } from './text-editor'
import { parseScriptDocument, serializeScriptDocument } from './script-rich-document'
import { normalizeTextDocument, textDocumentText } from './text-document'

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
type ScriptArtifactType = 'outline' | 'synopsis' | 'world' | 'characters' | 'relationships' | 'locations' | 'props' | 'structure' | 'hooks' | 'foreshadowing' | 'reversals' | 'constraints' | 'episode_outline' | 'episode_script'
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
type GeneratedArtifact = { artifact_type: ScriptArtifactType; title?: string; content: string }
type GeneratedScript = { outline: string; characters: string; scenes: SceneFields[]; artifacts?: GeneratedArtifact[] }
type ScriptDetail = ProjectDetail & {
  script: { outline: string; characters: string; generation_options?: ScriptGenerationOptions; scenes: SavedScene[]; artifacts?: ScriptArtifact[] }
}

type RichArtifactEditorProps = {
  value: string
  label: string
  placeholder: string
  disabled: boolean
  document?: JSONContent
  onFocus: (editor: Editor) => void
  onSelectionChange: (editor: Editor) => void
  onChange: (value: string, document: JSONContent) => void
}

function resolveScriptArtifactDocument(value: string, document?: JSONContent): JSONContent {
  return document && (textDocumentText(document) === value || serializeScriptDocument(document) === value)
    ? document : parseScriptDocument(value)
}

function RichArtifactEditor({ value, label, placeholder, disabled, document, onFocus, onSelectionChange, onChange }: RichArtifactEditorProps) {
  const readyRef = useRef(false)
  const editor = useEditor({
    extensions: textEditorExtensions(),
    content: resolveScriptArtifactDocument(value, document),
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
      if (JSON.stringify(next) === JSON.stringify(normalizeTextDocument(resolveScriptArtifactDocument(value, document)))) return
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
    const next = resolveScriptArtifactDocument(value, document)
    if (JSON.stringify(normalizeTextDocument(editor.getJSON())) !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false })
    }
  }, [value, document, editor])

  return <EditorContent editor={editor} className="script-rich-editor" />
}

const artifactCatalog: Array<{ type: ScriptArtifactType; title: string; description: string; group: string }> = [
  { type: 'outline', title: '概要设计', description: '一句话讲清故事的核心冲突和方向', group: '故事基底' },
  { type: 'synopsis', title: '故事简述', description: '从开端到结局的完整故事脉络', group: '故事基底' },
  { type: 'world', title: '背景设定', description: '时代、地点、规则与视觉基调', group: '故事基底' },
  { type: 'characters', title: '人物小传', description: '人物身份、欲望、关系和变化', group: '角色与世界' },
  { type: 'relationships', title: '人物关系', description: '角色之间的牵引、对立与秘密', group: '角色与世界' },
  { type: 'locations', title: '场景设计', description: '故事中反复出现的关键空间', group: '角色与世界' },
  { type: 'props', title: '道具设计', description: '推动剧情或承载信息的道具', group: '角色与世界' },
  { type: 'structure', title: '全剧分段', description: '按段落梳理节奏、转折与情绪', group: '叙事规划' },
  { type: 'hooks', title: '钩子预设', description: '让观众愿意继续观看的悬念', group: '叙事规划' },
  { type: 'foreshadowing', title: '伏笔预设', description: '提前埋下、后续回收的信息', group: '叙事规划' },
  { type: 'reversals', title: '反转预设', description: '改变观众判断的关键节点', group: '叙事规划' },
  { type: 'constraints', title: '创作禁区', description: '风格、人物和内容上的限制', group: '叙事规划' },
  { type: 'episode_outline', title: '分集大纲', description: '各集的事件、冲突和结尾悬念', group: '叙事规划' },
  { type: 'episode_script', title: '单集正文', description: '可直接进入分场制作的正文', group: '单集创作' },
]

const matureArtifactTypes: ScriptArtifactType[] = [
  'outline', 'synopsis', 'world', 'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints',
  'characters', 'relationships', 'locations', 'props', 'episode_outline', 'episode_script',
]
const matureArtifactCatalog = artifactCatalog.filter((item) => matureArtifactTypes.includes(item.type))
const standaloneArtifactTypes: ScriptArtifactType[] = ['characters', 'locations', 'props', 'episode_script']
const storyArtifactCatalog = matureArtifactCatalog.filter((item) => !standaloneArtifactTypes.includes(item.type))
const standaloneDocumentHeadings: Record<'characters' | 'locations' | 'props' | 'episode_script', string> = {
  characters: '人物清单', locations: '场景清单', props: '道具清单', episode_script: '单集正文',
}

function defaultArtifacts(script: { outline?: string; characters?: string; scenes?: SavedScene[]; generation_options?: ScriptGenerationOptions }): ScriptArtifact[] {
  const sceneContent = (script.scenes || []).map((scene, index) => [
    `第 ${index + 1} 场｜${scene.heading}`,
    scene.location && `地点：${scene.location}`,
    scene.time_of_day && `时间：${scene.time_of_day}`,
    scene.characters && `人物：${scene.characters}`,
    scene.action && `动作：${scene.action}`,
    scene.dialogue && `对白：${scene.dialogue}`,
    scene.narration && `旁白：${scene.narration}`,
    `时长：${scene.duration} 秒`,
  ].filter(Boolean).join('\n')).join('\n\n')
  const values: Partial<Record<ScriptArtifactType, string>> = {
    outline: script.outline || '', synopsis: script.outline || '', characters: script.characters || '', structure: sceneContent,
    world: [script.generation_options?.era && `时代与地点：${script.generation_options.era}`, script.generation_options?.visual_style && `视觉风格：${script.generation_options.visual_style}`].filter(Boolean).join('\n'),
    hooks: script.generation_options?.core_hook || '',
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
  onNotice: (message: string) => void
  onDirtyChange?: (dirty: boolean) => void
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
      ? Math.min(30, Math.max(1, Math.round(scene.duration))) : 5,
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

function ScriptEditor({ detail, models, providers, busy = false, initialSection, onRefresh, onOpenModels, onOpenCanvas, onNotice, onDirtyChange }: ScriptEditorProps) {
  const { confirm, dialog } = useAppDialog()
  const [draft, setDraft] = useState<ScriptDraft>(() => fromDetail(detail))
  const [saved, setSaved] = useState<ScriptDraft>(() => fromDetail(detail))
  const draftRef = useRef<ScriptDraft>(draft)
  const historyRef = useRef<{ past: ScriptDraft[]; future: ScriptDraft[] }>({ past: [], future: [] })
  const historyActionRef = useRef(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [activeSceneId, setActiveSceneId] = useState<string | null>(() => fromDetail(detail).scenes[0]?.clientId || null)
  const [activeDocumentSection, setActiveDocumentSection] = useState<DocumentSection>(initialSection || 'outline')
  const [editorZoom, setEditorZoom] = useState(100)
  const [formatMenu, setFormatMenu] = useState<'heading' | 'list' | null>(null)
  const [, setSelectionRevision] = useState(0)
  const focusedEditorRef = useRef<Editor | null>(null)
  const focusedArtifactRef = useRef<ScriptArtifactType | null>(null)
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([])
  const [modelId, setModelId] = useState('')
  const [showGenerate, setShowGenerate] = useState(false)
  const [scriptPrompt, setScriptPrompt] = useState('')
  const [scriptPromptCustomized, setScriptPromptCustomized] = useState(false)
  const [scriptPromptLoading, setScriptPromptLoading] = useState(false)
  const [scriptPromptError, setScriptPromptError] = useState<string | null>(null)
  const scriptPromptEditedRef = useRef(false)
  const scriptPromptRequestId = useRef(0)
  const [scriptPromptRefresh, setScriptPromptRefresh] = useState(0)
  const [showGenerated, setShowGenerated] = useState(false)
  const [generated, setGenerated] = useState<GeneratedScript | null>(null)
  const [rawOutput, setRawOutput] = useState<string | null>(null)
  const [showConvert, setShowConvert] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [planPrompt, setPlanPrompt] = useState('')
  const [planPromptCustomized, setPlanPromptCustomized] = useState(false)
  const [planPromptLoading, setPlanPromptLoading] = useState(false)
  const [planPromptError, setPlanPromptError] = useState<string | null>(null)
  const planPromptEditedRef = useRef(false)
  const planPromptRequestId = useRef(0)
  const [planPromptRefresh, setPlanPromptRefresh] = useState(0)
  const [planModelId, setPlanModelId] = useState('')
  const [shotsPerScene, setShotsPerScene] = useState<number | string>(3)
  const [plannedScenes, setPlannedScenes] = useState<PlannedScene[] | null>(null)
  const [planRequestId, setPlanRequestId] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planRawOutput, setPlanRawOutput] = useState<string | null>(null)
  const [deleteSceneId, setDeleteSceneId] = useState<string | null>(null)
  const [working, setWorking] = useState<'save' | 'generate' | 'convert' | 'plan' | 'create-plan' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange

  const remoteScript = (detail as ScriptDetail).script
  const remoteSignature = JSON.stringify({ brief: detail.brief, script: remoteScript })
  const remoteSignatureRef = useRef(remoteSignature)
  remoteSignatureRef.current = remoteSignature
  const syncedRemoteSignature = useRef(remoteSignature)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const hasUnsavedWork = dirty || !!generated || (showPlan && !!plannedScenes)
  const existingDurationByScene = useMemo(() => {
    const durations = new Map<string, number>()
    detail.shots.forEach((shot) => {
      if (shot.source_scene_id) durations.set(shot.source_scene_id, (durations.get(shot.source_scene_id) || 0) + shot.duration)
    })
    return durations
  }, [detail.shots])
  const linkedSceneIds = useMemo(() => new Set(existingDurationByScene.keys()), [existingDurationByScene])
  const availableModels = models.filter((model) => model.modality === 'text' && model.enabled && providers.some((provider) => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))
  const selectedModelAvailable = availableModels.some((model) => model.id === modelId)
  const selectedScenes = draft.scenes.filter((scene) => scene.id && selectedSceneIds.includes(scene.id))
  const quickConvertScenes = selectedScenes.filter((scene) => !linkedSceneIds.has(scene.id!))
  const selectedPlanModelAvailable = availableModels.some((model) => model.id === planModelId)
  const validShotsPerScene = Number.isInteger(Number(shotsPerScene)) && Number(shotsPerScene) >= 2 && Number(shotsPerScene) <= 5
  const shortScenes = selectedScenes.filter((scene) => scene.duration < Number(shotsPerScene))
  const planIssues = plannedScenes?.map(plannedSceneIssue) || []
  const planReady = !!planRequestId && !!plannedScenes?.length && plannedScenes.length === selectedScenes.length && new Set(plannedScenes.map((scene) => scene.scene_id)).size === selectedScenes.length && plannedScenes.every((scene) => selectedScenes.some((selected) => selected.id === scene.scene_id && selected.duration === scene.scene_duration)) && planIssues.every((issue) => !issue)
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
    if (!showGenerate) return
    const requestId = ++scriptPromptRequestId.current
    setScriptPromptLoading(true)
    setScriptPromptError(null)
    void api<{ prompt: string }>(`/projects/${detail.id}/script/generate/prompt`, json('POST', {
      idea: draft.brief, generation_options: draft.generation_options,
    })).then((result) => {
      if (requestId === scriptPromptRequestId.current && !scriptPromptEditedRef.current) setScriptPrompt(result.prompt)
    }).catch((issue) => {
      if (requestId === scriptPromptRequestId.current) setScriptPromptError(`提示词加载失败：${errorMessage(issue)}`)
    }).finally(() => {
      if (requestId === scriptPromptRequestId.current) setScriptPromptLoading(false)
    })
    return () => { if (requestId === scriptPromptRequestId.current) scriptPromptRequestId.current += 1 }
  }, [showGenerate, detail.id, draft.brief, JSON.stringify(draft.generation_options), scriptPromptRefresh])

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
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-script-section]'))
    if (!sections.length) return
    const scrollRoot = document.querySelector<HTMLElement>('.script-document-editor')
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      const section = visible?.target instanceof HTMLElement ? visible.target.dataset.scriptSection : undefined
      if (section && (section === 'scenes' || /^episode-\d+$/.test(section) || artifactCatalog.some((item) => item.type === section))) {
        setActiveDocumentSection(section as DocumentSection)
      }
    }, { root: scrollRoot, rootMargin: '-16px 0px -55% 0px', threshold: 0.01 })
    sections.forEach((section) => observer.observe(section))
    return () => observer.disconnect()
    }, [detail.id, draft.artifacts.length, draft.scenes.length, activeDocumentSection])

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
    if (!editor || !artifactType) {
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

  useEffect(() => {
    if (initialSection) selectDocumentSection(initialSection)
  }, [initialSection, detail.id])

  function selectDocumentSection(section: DocumentSection, resetDocument = false) {
    setActiveDocumentSection(section)
    focusedEditorRef.current = null
    focusedArtifactRef.current = null
    if (section === 'scenes') {
      setActiveSceneId((current) => current || draft.scenes[0]?.clientId || null)
    }
    window.requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>('.script-document-editor')
      const target = document.getElementById(`script-section-${section}`)
      if (!editor) return
      if (resetDocument || section.startsWith('episode-') || standaloneArtifactTypes.includes(section as ScriptArtifactType)) {
        editor.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      if (!target) return
      // Keep the fixed mature-project header and vertically centered directory in
      // place. Element.scrollIntoView() would also scroll the outer full-screen
      // page, hiding the toolbar; move only the document's scroll container.
      const editorRect = editor.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      editor.scrollTo({ top: Math.max(0, editor.scrollTop + targetRect.top - editorRect.top - 16), behavior: 'smooth' })
    })
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
    const invalidDuration = draft.scenes.findIndex((scene) => !Number.isInteger(scene.duration) || scene.duration < 1 || scene.duration > 30)
    if (invalidDuration >= 0) {
      setActiveSceneId(draft.scenes[invalidDuration].clientId)
      setError(`第 ${invalidDuration + 1} 场的预计时长应为 1-30 秒的整数`)
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
        artifacts: draft.artifacts.map(({ id, project_id: _projectId, created_at: _createdAt, updated_at: _updatedAt, document: _document, ...artifact }, index) => ({
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

  async function generateScript() {
    if (disabled || !draft.brief.trim() || !selectedModelAvailable || !scriptPrompt.trim() || (!scriptPromptCustomized && (scriptPromptLoading || scriptPromptError))) return
    if (generated && !await confirm({ title: '重新生成剧本草稿', message: '当前待处理的生成结果会被替换。', confirmLabel: '继续生成', danger: true })) return
    setWorking('generate')
    setError(null)
    setRawOutput(null)
    try {
      const result = await api<GeneratedScript>(`/projects/${detail.id}/script/generate`, json('POST', {
        model_id: modelId,
        idea: draft.brief,
        generation_options: draft.generation_options,
        prompt_override: scriptPrompt,
      }))
      const next: GeneratedScript = {
        outline: typeof result.outline === 'string' ? result.outline : '',
        characters: typeof result.characters === 'string' ? result.characters : '',
        scenes: Array.isArray(result.scenes) ? result.scenes.map(sceneFields) : [],
        artifacts: Array.isArray(result.artifacts) ? result.artifacts.flatMap((artifact) => {
          if (!artifact || typeof artifact !== 'object' || typeof artifact.content !== 'string') return []
          const type = artifact.artifact_type
          if (!artifactCatalog.some((item) => item.type === type) || !artifact.content.trim()) return []
          return [{ artifact_type: type, title: typeof artifact.title === 'string' ? artifact.title : undefined, content: artifact.content.trim() }]
        }) : [],
      }
      setGenerated(next)
      setShowGenerate(false)
      setShowGenerated(true)
    } catch (issue) {
      setError(`生成失败：${errorMessage(issue)}`)
      setRawOutput(issue instanceof Error && 'raw_output' in issue && typeof issue.raw_output === 'string' ? issue.raw_output : null)
    } finally {
      setWorking(null)
    }
  }

  function applyGenerated() {
    if (!generated) return
    const linkedScenes = draft.scenes.filter((scene) => (scene.episode_number || 0) > 0 || scene.id && linkedSceneIds.has(scene.id))
    const scenes = [
      ...linkedScenes,
      ...generated.scenes.map((scene) => ({ ...sceneFields(scene), clientId: crypto.randomUUID() })),
    ]
    setDraft((current) => ({
      ...current,
      outline: generated.outline,
      characters: generated.characters,
      artifacts: current.artifacts.map((artifact) => {
        if (artifact.episode_number) return artifact
        const generatedArtifact = generated.artifacts?.find((item) => item.artifact_type === artifact.artifact_type)
        if (artifact.artifact_type === 'outline') return { ...artifact, content: generated.outline, status: 'edited' }
        if (artifact.artifact_type === 'characters') return { ...artifact, content: generated.characters, status: 'edited' }
        if (generatedArtifact) return {
          ...artifact,
          ...(generatedArtifact.title ? { title: generatedArtifact.title } : {}),
          content: generatedArtifact.content,
          status: 'edited' as const,
        }
        if (artifact.artifact_type === 'structure') return { ...artifact, content: scenes.map((scene, index) => `第 ${index + 1} 场｜${scene.heading}\n${scene.action}`).join('\n\n'), status: 'edited' }
        return artifact
      }),
      scenes,
    }))
    setActiveSceneId(scenes[0]?.clientId || null)
    setSelectedSceneIds([])
    setGenerated(null)
    setShowGenerated(false)
    onNotice('草稿已放入编辑器，请检查并保存')
  }

  function openGenerate() {
    setError(null)
    setRawOutput(null)
    setModelId((current) => availableModels.some((model) => model.id === current)
      ? current : availableModels.length === 1 ? availableModels[0]!.id : '')
    scriptPromptEditedRef.current = false
    setScriptPromptCustomized(false)
    setScriptPrompt('')
    setShowGenerate(true)
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
            duration: typeof shot.duration === 'number' && Number.isFinite(shot.duration) ? shot.duration : 0,
            start_state: typeof shot.start_state === 'string' ? shot.start_state : '',
            end_state: typeof shot.end_state === 'string' ? shot.end_state : '',
            cut_note: typeof shot.cut_note === 'string' ? shot.cut_note : '',
          })),
        }
      })
      setPlannedScenes(plan)
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
  const storyOutlineItems = storyArtifactCatalog
  const standaloneDocumentItems = matureArtifactCatalog.filter((item) => standaloneArtifactTypes.includes(item.type)
    && (item.type !== 'episode_script' || draft.artifacts.some(artifact => artifact.artifact_type === 'episode_script' && !artifact.episode_number && artifact.content.trim())))
  const standaloneDocument = standaloneDocumentItems.find((item) => item.type === activeDocumentSection)
  const episodeDocuments = draft.artifacts.filter(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) > 0).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
  const selectedEpisode = episodeDocuments.find(item => `episode-${item.episode_number}` === activeDocumentSection)
  const productionSceneCandidates = selectedEpisode
    ? draft.scenes.filter(scene => scene.episode_number === selectedEpisode.episode_number)
    : draft.scenes

  return <section className="script-page" aria-label="剧本创作">
    <header className="script-page-header script-editor-topbar">
      <div className="script-editor-titlebar">
        <button type="button" className="script-editor-back" onClick={onOpenCanvas} aria-label="返回画布" title="返回画布"><ArrowLeft size={17} /></button>
        <div className="script-editor-document-title"><strong>编辑器 - {detail.name || '未命名项目'}</strong><span>{draft.scenes.length} 场 · {totalDuration} 秒</span></div>
        <span className={`script-save-state ${hasUnsavedWork ? 'is-dirty' : ''}`}><span />{dirty ? '未保存' : generated ? '待处理' : showPlan && plannedScenes ? '待创建' : '已保存'}</span>
      </div>
      <div className="script-editor-toolbar" aria-label="编辑工具">
        <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo || disabled} onClick={undoDraft}><Undo2 size={16} /></button>
        <button type="button" aria-label="重做" title="重做" disabled={!canRedo || disabled} onClick={redoDraft}><Redo2 size={16} /></button>
        <i />
        <button type="button" aria-label="缩小" title="缩小" onClick={() => setEditorZoom((value) => Math.max(80, value - 10))} disabled={editorZoom <= 80}><ZoomOut size={16} /></button>
        <span className="script-editor-zoom">{editorZoom}%</span>
        <button type="button" aria-label="放大" title="放大" onClick={() => setEditorZoom((value) => Math.min(140, value + 10))} disabled={editorZoom >= 140}><ZoomIn size={16} /></button>
        <i />
        <div className="script-format-menu">
          <button type="button" aria-label="标题格式" title="标题格式" aria-haspopup="menu" aria-expanded={formatMenu === 'heading'} aria-pressed={formatMenu === 'heading' || focusedEditorIsActive('heading')} className={formatMenu === 'heading' || focusedEditorIsActive('heading') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => setFormatMenu((value) => value === 'heading' ? null : 'heading')}><Heading1 size={16} /><ChevronDown size={11} /></button>
          {formatMenu === 'heading' && <div className="script-format-popover" role="menu" aria-label="标题格式">
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h1')}><Heading1 size={15} /><strong>标题 1</strong></button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h2')}><Heading1 size={15} /><strong>标题 2</strong></button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('h3')}><Heading1 size={15} /><strong>标题 3</strong></button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('paragraph')}><FileText size={15} /><strong>正文</strong></button>
          </div>}
        </div>
        <div className="script-format-menu">
          <button type="button" aria-label="列表格式" title="列表格式" aria-haspopup="menu" aria-expanded={formatMenu === 'list'} aria-pressed={formatMenu === 'list' || focusedEditorIsActive('bulletList') || focusedEditorIsActive('orderedList')} className={formatMenu === 'list' || focusedEditorIsActive('bulletList') || focusedEditorIsActive('orderedList') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => setFormatMenu((value) => value === 'list' ? null : 'list')}><List size={16} /><ChevronDown size={11} /></button>
          {formatMenu === 'list' && <div className="script-format-popover" role="menu" aria-label="列表格式">
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('bulletList')}><List size={15} /><strong>无序列表</strong></button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('orderedList')}><ListOrdered size={15} /><strong>有序列表</strong></button>
          </div>}
        </div>
        <i />
        <button type="button" aria-label="粗体" title="粗体" aria-pressed={focusedEditorIsActive('bold')} className={focusedEditorIsActive('bold') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('bold')}><Bold size={16} /></button>
        <button type="button" aria-label="斜体" title="斜体" aria-pressed={focusedEditorIsActive('italic')} className={focusedEditorIsActive('italic') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('italic')}><Italic size={16} /></button>
        <button type="button" aria-label="删除线" title="删除线" aria-pressed={focusedEditorIsActive('strike')} className={focusedEditorIsActive('strike') ? 'is-active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => formatFocusedText('strike')}><Strikethrough size={16} /></button>
      </div>
      <div className="script-page-actions">
        {generated && <Button variant="subtle" leftSection={<FileText size={15} />} onClick={() => setShowGenerated(true)} disabled={disabled}>查看生成结果</Button>}
        <Button variant="subtle" leftSection={<Clapperboard size={15} />} disabled={disabled || dirty || !productionSceneCandidates.some(scene => scene.id && !linkedSceneIds.has(scene.id))} onClick={() => { setSelectedSceneIds([]); setShowConvert(true) }}>制作分镜</Button>
        <Button variant="subtle" leftSection={<Sparkles size={15} />} onClick={openGenerate} disabled={disabled}>生成剧本</Button>
        <Button leftSection={working === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} onClick={saveScript} disabled={!dirty || disabled}>保存</Button>
        <button type="button" className="script-editor-exit" onClick={onOpenCanvas} aria-label="退出编辑器" title="退出编辑器"><Minimize2 size={16} /></button>
      </div>
    </header>

    {error && <div className="script-error" role="alert">{error}<button onClick={() => setError(null)} aria-label="关闭提示">关闭</button></div>}

    <section className="script-document" aria-label="剧本文档">
      <aside className="script-document-nav" aria-label="剧本目录">
        <div className="script-document-nav-feature">
          <button type="button" className={`script-document-nav-primary ${storyOutlineItems.some((item) => activeDocumentSection === item.type) ? 'is-active' : ''}`} onClick={() => selectDocumentSection('outline', true)}>故事大纲</button>
          <div className="script-document-nav-nested">
            {storyOutlineItems.map((item) => <button type="button" key={item.type} className={`script-document-nav-item ${activeDocumentSection === item.type ? 'is-active' : ''}`} onClick={() => selectDocumentSection(item.type)}><span>{item.title}</span></button>)}
          </div>
        </div>
        {standaloneDocumentItems.map((item) => <button type="button" key={item.type} className={`script-document-nav-primary script-document-nav-standalone ${activeDocumentSection === item.type ? 'is-active' : ''}`} onClick={() => selectDocumentSection(item.type)}>{item.title}</button>)}
        {episodeDocuments.map(artifact => <button type="button" key={artifact.id} className={`script-document-nav-primary script-document-nav-standalone ${selectedEpisode?.id === artifact.id ? 'is-active' : ''}`} onClick={() => selectDocumentSection(`episode-${artifact.episode_number!}`)}>{artifact.title}</button>)}
      </aside>
      <article
        className="script-document-editor"
        style={{ '--script-editor-scale': editorZoom / 100 } as CSSProperties}
      >
        <div className="script-long-document">
          {selectedEpisode ? <>
            <header className="script-long-document-cover script-standalone-cover"><span className="script-kicker">分集剧本</span><h1>{selectedEpisode.title}</h1><p>只修改当前集，其他集和已保存资料保留。</p></header>
            <section id={`script-section-episode-${selectedEpisode.episode_number}`} data-script-section={`episode-${selectedEpisode.episode_number}`} className="script-long-section script-standalone-section">
              <RichArtifactEditor
                key={selectedEpisode.id}
                label={selectedEpisode.title}
                placeholder="填写本集分场正文"
                value={selectedEpisode.content}
                document={selectedEpisode.document}
                disabled={disabled}
                onFocus={editor => { focusedEditorRef.current = editor; focusedArtifactRef.current = 'episode_script' }}
                onSelectionChange={editor => { focusedEditorRef.current = editor; setSelectionRevision(value => value + 1) }}
                onChange={(content, document) => updateArtifact('episode_script', content, document, selectedEpisode.episode_number)}
              />
            </section>
          </> : standaloneDocument ? <>
            <header className="script-long-document-cover script-standalone-cover">
              <span className="script-kicker">{standaloneDocument.group}</span>
              <h1>{standaloneDocumentHeadings[standaloneDocument.type as 'characters' | 'locations' | 'props' | 'episode_script']}</h1>
              <p>{standaloneDocument.description}</p>
            </header>
            {(() => {
              const artifact = draft.artifacts.find((entry) => entry.artifact_type === standaloneDocument.type && !entry.episode_number)
              if (!artifact) return null
              return <section id={`script-section-${standaloneDocument.type}`} data-script-section={standaloneDocument.type} className={`script-long-section script-standalone-section ${artifact.content.trim() ? '' : 'is-empty'} ${activeDocumentSection === standaloneDocument.type ? 'is-active' : ''}`}>
                <header className="script-long-section-heading"><div><span className="script-section-index">01</span><div><span className="script-kicker">{standaloneDocument.group}</span><h2>{standaloneDocument.title}</h2></div></div></header>
                <RichArtifactEditor
                  label={standaloneDocument.title}
                  placeholder={`填写${standaloneDocument.title}，支持分段描述和手动修改`}
                  value={artifact.content}
                  disabled={disabled}
                  document={artifact.document}
                  onFocus={(editor) => { focusedEditorRef.current = editor; focusedArtifactRef.current = standaloneDocument.type }}
                  onSelectionChange={(editor) => { focusedEditorRef.current = editor; setSelectionRevision((value) => value + 1) }}
                  onChange={(content, document) => updateArtifact(artifact.artifact_type, content, document)}
                />
              </section>
            })()}
          </> : <>
          <header className="script-long-document-cover">
            <span className="script-kicker">故事大纲</span>
            <h1>故事大纲</h1>
            <p>{[draft.generation_options.genre, draft.generation_options.genre_fusion].filter(Boolean).join(' × ') || draft.brief.trim() || '还没有创作概述。可以先从故事方向和人物关系开始。'}</p>
          </header>
          {storyArtifactCatalog.map((item, index) => {
            const artifact = draft.artifacts.find((entry) => entry.artifact_type === item.type)
            if (!artifact) return null
            return <section id={`script-section-${item.type}`} data-script-section={item.type} className={`script-long-section ${artifact.content.trim() ? '' : 'is-empty'} ${activeDocumentSection === item.type ? 'is-active' : ''}`} key={item.type}>
              <header className="script-long-section-heading">
                <div><span className="script-section-index">{String(index + 1).padStart(2, '0')}</span><div><span className="script-kicker">{item.group}</span><h2>{item.title}</h2></div></div>
              </header>
              <RichArtifactEditor
                label={item.title}
                placeholder={`填写${item.title}，支持分段描述和手动修改`}
                value={artifact.content}
                disabled={disabled}
                document={artifact.document}
                onFocus={(editor) => { focusedEditorRef.current = editor; focusedArtifactRef.current = item.type }}
                onSelectionChange={(editor) => { focusedEditorRef.current = editor; setSelectionRevision((value) => value + 1) }}
                onChange={(content, document) => updateArtifact(artifact.artifact_type, content, document)}
              />
            </section>
          })}
          </>}
        </div>
      </article>
    </section>

    <Modal opened={showGenerate} onClose={() => setShowGenerate(false)} title="生成剧本草稿" classNames={{ content: 'script-modal-content', body: 'script-modal-body' }}>
      <div className="script-modal-stack">
        <Select label="文本模型" placeholder="选择已添加的模型" searchable allowDeselect={false} value={modelId || null} data={availableModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => setModelId(value || '')} />
        {!availableModels.length && <button className="script-model-link" onClick={() => { setShowGenerate(false); onOpenModels() }}>前往模型设置添加文本模型 <ArrowRight size={15} /></button>}
        <div className="script-idea-preview"><span>创意概述</span><p>{draft.brief.trim() || '请先填写创意概述'}</p></div>
        <div className="script-prompt-editor">
          <div className="script-prompt-heading"><strong>实际发送提示词</strong><Button variant="subtle" size="compact-xs" disabled={scriptPromptLoading || disabled} onClick={() => { scriptPromptEditedRef.current = false; setScriptPromptCustomized(false); setScriptPrompt(''); setScriptPromptRefresh((value) => value + 1) }}>恢复自动提示词</Button></div>
          <Textarea aria-label="剧本生成提示词" minRows={8} maxRows={16} autosize maxLength={500000} value={scriptPrompt} disabled={disabled} onChange={(event) => { scriptPromptEditedRef.current = true; setScriptPromptCustomized(true); setScriptPrompt(event.currentTarget.value) }} />
          {scriptPromptLoading && !scriptPromptCustomized && <small role="status">正在整理提示词...</small>}
          {scriptPromptError && !scriptPromptCustomized && <small className="script-prompt-error" role="alert">{scriptPromptError}</small>}
        </div>
        {error?.startsWith('生成失败') && <div className="script-error" role="alert">{error}</div>}
        {rawOutput && <div className="script-raw-output"><strong>模型原始输出</strong><pre>{rawOutput}</pre></div>}
        <div className="script-modal-actions"><Button variant="default" onClick={() => setShowGenerate(false)}>取消</Button><Button leftSection={working === 'generate' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} disabled={!selectedModelAvailable || !draft.brief.trim() || !scriptPrompt.trim() || (!scriptPromptCustomized && (scriptPromptLoading || !!scriptPromptError)) || disabled} onClick={generateScript}>生成草稿</Button></div>
      </div>
    </Modal>

    <Modal opened={showGenerated && !!generated} onClose={() => setShowGenerated(false)} title="检查生成结果" size="lg" classNames={{ content: 'script-modal-content', body: 'script-modal-body' }}>
      {generated && <div className="script-modal-stack">
        <div className="script-generated-meta">{generated.scenes.length} 场 · 约 {generated.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒</div>
        <div className="script-generated-section"><strong>故事大纲</strong><p>{generated.outline || '未生成'}</p></div>
        <div className="script-generated-section"><strong>人物设定</strong><p>{generated.characters || '未生成'}</p></div>
        <div className="script-generated-scenes"><strong>分场</strong>{generated.scenes.map((scene, index) => <div key={index}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{scene.heading || '未命名场次'}</b><small>{scene.duration} 秒{scene.location ? ` · ${scene.location}` : ''}</small><p>{scene.action}</p></div></div>)}</div>
        <p className="script-replace-warning">应用后会替换编辑器中的大纲、人物与未制作分镜的场次；{linkedSceneIds.size ? `${linkedSceneIds.size} 个已关联分镜的场次会保留在前面，` : ''}保存前仍可修改。{draft.scenes.filter((scene) => scene.id && linkedSceneIds.has(scene.id)).length + generated.scenes.length > 100 ? '场次数量超过 100，无法应用。' : ''}</p>
        <div className="script-modal-actions"><Button variant="default" onClick={() => setShowGenerated(false)}>稍后处理</Button><Button disabled={draft.scenes.filter((scene) => scene.id && linkedSceneIds.has(scene.id)).length + generated.scenes.length > 100} onClick={applyGenerated}>放入编辑器</Button></div>
      </div>}
    </Modal>

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
          <Select label="文本模型" placeholder="选择已添加的模型" searchable allowDeselect={false} value={planModelId || null} disabled={disabled} data={availableModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => { if (value !== planModelId) void (async () => { if (await discardPlanPreview()) setPlanModelId(value || '') })() }} />
          <NumberInput label="每场目标镜头数" min={2} max={5} value={shotsPerScene} disabled={disabled} onChange={(value) => { if (value !== shotsPerScene) void (async () => { if (await discardPlanPreview()) setShotsPerScene(value) })() }} />
        </div>
        <div className="script-prompt-editor">
          <div className="script-prompt-heading"><strong>实际发送提示词</strong><Button variant="subtle" size="compact-xs" disabled={planPromptLoading || disabled} onClick={() => { planPromptEditedRef.current = false; setPlanPromptCustomized(false); setPlanPrompt(''); setPlanPromptRefresh((value) => value + 1) }}>恢复自动提示词</Button></div>
          <Textarea aria-label="分镜规划提示词" minRows={8} maxRows={16} autosize maxLength={500000} value={planPrompt} disabled={disabled} onChange={(event) => { planPromptEditedRef.current = true; setPlanPromptCustomized(true); setPlanPrompt(event.currentTarget.value) }} />
          {planPromptLoading && !planPromptCustomized && <small role="status">正在整理提示词...</small>}
          {planPromptError && !planPromptCustomized && <small className="script-prompt-error" role="alert">{planPromptError}</small>}
        </div>
        {!availableModels.length && <button className="script-model-link" onClick={() => void (async () => { if (await closePlan()) onOpenModels() })()}>前往模型设置添加文本模型 <ArrowRight size={15} /></button>}
        {shortScenes.length > 0 && validShotsPerScene && <div className="script-plan-hint">{shortScenes.length === 1 ? `「${shortScenes[0].heading}」` : `${shortScenes.length} 个短场次`}少于目标镜头数。规划时会减少镜头，确保每个镜头至少 1 秒。</div>}
        {planError && <div className="script-error" role="alert">{planError}</div>}
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
                  <Textarea label="画面提示词" aria-label={`${scene.scene_heading}镜头 ${shotIndex + 1} 画面提示词`} maxLength={10000} minRows={2} autosize value={shot.prompt} disabled={disabled} onChange={(event) => updatePlannedShot(scene.scene_id, shotIndex, { prompt: event.currentTarget.value })} />
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
    {dialog}
  </section>
}

export default ScriptEditor
