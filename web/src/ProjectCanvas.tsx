import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ActionIcon, Button, Menu, Modal, Popover, Textarea, TextInput, Tooltip,
} from '@mantine/core'
import { useClickOutside } from '@mantine/hooks'
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Check, ChevronDown, CircleAlert, Clock3, FileText, Film, FolderOpen,
  Image as ImageIcon, Info, LayoutGrid, Layers3, LoaderCircle, LocateFixed, Map as MapIcon, Maximize2, Minimize2, MoreHorizontal, MousePointer2,
  MessageSquare, Music2, PanelLeftClose, PanelLeftOpen, PenLine, Plus, RefreshCcw, Save, ScrollText,
  Search, Settings2, SlidersHorizontal, Sparkles,
  Eye, EyeOff, LayoutDashboard,
  Redo2, Trash2, Undo2, Upload, WandSparkles, X,
} from 'lucide-react'
import {
  Background, BaseEdge, getBezierPath, Handle, MiniMap, NodeResizer, PanOnScrollMode, Position, ReactFlow,
  ReactFlowProvider, applyEdgeChanges, useReactFlow,
} from '@xyflow/react'
import type { Connection, ConnectionLineComponentProps, Edge, EdgeChange, EdgeProps, Node, NodeChange, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, json } from './api'
import type { Asset, AssetTask, Job, Model, ProjectDetail, Provider, ScriptArtifact, Shot, VisualBoardPreview, VisualProfile, VisualReferenceMode } from './api'
import VisualPreparation from './VisualPreparation'
import VisualProfileInspector from './VisualProfileInspector'
import VisualCandidateManager from './VisualCandidateManager'
import { addVisualProfileNode, automaticVisualReferenceEdges, missingVisualReferences, syncVisualProfileNode, visualBoardJobs, visualBoardReferences, visualCandidateAssets, visualJobRequest, visualNodeAsset } from './canvas-visual-profiles'
import { connectImageVideoHandoff, createImageVideoHandoff, fixedReferenceAsset, imageVideoConnection, pinnedCanvasReference } from './canvas-shot-workflow'
import { rebasePromptDraft, videoPreferencePrompt } from './canvas-prompt-draft'
import { shotImagePrompt, shotVideoPrompt } from '../../backend/src/shot-prompts'
import { visualGenerationPrompt } from '../../backend/src/visual-prompt'
import type { MissingVisualReference } from './canvas-visual-profiles'
import { imageReferenceConfigError } from '../../backend/src/image-reference-config'
import CanvasTextEditor, { CanvasTextPreview } from './CanvasTextEditor'
import CanvasSelect from './CanvasSelect'
import StoryboardWorkspace from './StoryboardWorkspace'
import CanvasComposerToolbar from './CanvasComposerToolbar'
import { useAppDialog } from './AppDialog'
import { CanvasGenerationParameters, CanvasVideoModeMenu } from './CanvasGenerationControls'
import type { JSONContent } from '@tiptap/core'
import { generationCost, imageGenerationDefaults, imageParameterOptions, imageParameterValue, imagePreferencePrompt, imageRatioError, imageRatios, imageRequestResolution, modelDefaultResolution, usesModelParameter } from './canvas-model-parameters'
import { parseScriptDocument } from './script-rich-document'
import { textDocumentText } from './text-document'
import { fitImageNode, imageNodeMinimum } from './canvas-image-layout'
import { placeNewCanvasNodes } from './canvas-node-placement'
import './project-canvas.css'
import './canvas-visual-profiles.css'

type CanvasMode = 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'edit' | 'extend'
type CanvasView = 'canvas' | 'storyboard'
export type CanvasLocation = { view: CanvasView; storyboardId: string | null }
type CanvasModality = 'text' | 'image' | 'video'
type TextNodeMode = 'write'
export type ScriptAction = 'character' | 'location' | 'prop' | 'all'
type NodeQuickAction = 'image-to-image' | 'video-first-frame' | 'video-first-last' | 'video-extend'
export type CanvasNode = {
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
  settings: {
    visual_profile_id?: string
    visual_profile_revision?: number
    visual_completed_job_id?: string
    visual_reference_mode?: VisualReferenceMode
    role?: 'script'
    text_mode?: TextNodeMode
    text_document?: JSONContent | null
    group_id?: string | null
    group_title?: string | null
    modality?: CanvasModality
    mode?: CanvasMode
    resolution?: string | null
    clarity?: string | null
    quality?: string | null
    background?: string | null
    duration?: number
    ratio?: string
    generate_audio?: boolean
    candidate_count?: number
    draft?: boolean
    reference_video_url?: string | null
    prompt_override?: boolean
    prompt_is_final?: boolean
    prompt_base?: string
    prompt_template?: string
  }
}
type CanvasEdge = { id: string; source: string; target: string; reference_asset_id?: string }
export type CanvasGraph = { nodes: CanvasNode[]; edges: CanvasEdge[]; revision: string }
type CanvasViewport = { x: number; y: number; zoom: number }
type MiniMapPosition = { x: number; y: number }
type CanvasContextMenu = {
  x: number
  y: number
  position?: { x: number; y: number }
  nodeId?: string
  edgeId?: string
}
type CanvasAddMenu = {
  position?: { x: number; y: number }
  screen?: { x: number; y: number }
}
type SaveQueue = {
  id: string
  graph: CanvasGraph
  base: CanvasGraph
  serial: number
  savedSerial: number
  timer: number | null
  inFlight: Promise<void> | null
  conflict: boolean
}
type FlowData = Record<string, unknown> & {
  profile?: VisualProfile
  node: CanvasNode
  asset?: Asset
  shot?: Shot
  job?: Job
  model?: Model
  promptText: string
  imageEditingModels: string[]
  videoQuickModes: CanvasMode[]
  modelOptions: { value: string; label: string }[]
  busy: boolean
  onPromptChange: (id: string, value: string) => void
  onTextChange: (id: string, value: string) => void
  onTextDocumentChange: (id: string, text: string, document: JSONContent) => void
  onModelChange: (id: string, value: string) => void
  onSettingsChange: (id: string, patch: Partial<CanvasNode['settings']>) => void
  onOpenSettings: (id: string) => void
  onRun: (id: string) => void
  onTryAction: (id: string, action: NodeQuickAction) => void
  onImageSize: (id: string, assetId: string, width: number, height: number) => void
  scriptSceneCount?: number
  scriptDuration?: number
  scriptOutline?: string
  scriptArtifacts?: ScriptArtifact[]
  scriptTitle?: string
  scriptUpdatedAt?: string
  scriptExists?: boolean
  onOpenScriptDirector: (focusArtifact?: ScriptAction) => void
  onOpenScriptCreator: () => void
  onOpenScriptDocument?: (artifact: ScriptArtifact) => void
}
type FlowNode = Node<FlowData, 'studio'>
type GenerationRequest = {
  prompt_is_final?: boolean
  prompt_template?: string
  visual_reference_mode?: VisualReferenceMode
  visual_source_prompt?: string
  visual_signature?: string
  shot_id: string
  model_id: string
  prompt: string
  mode: CanvasMode
  reference_asset_ids: string[]
  reference_video_url: string | null
  resolution: string | null
  quality?: string | null
  clarity?: string | null
  background?: string | null
  duration: number
  ratio: string
  generate_audio: boolean
  draft: boolean
}
type GenerationReview = {
  candidateCount: number
  board?: { profile: VisualProfile; preview: VisualBoardPreview; input: ReturnType<typeof visualBoardReferences> & { prompt_append: string } }
  nodeId: string
  request: GenerationRequest
  shot: Pick<Shot, 'title'>
  model: Model
  provider?: Provider
  referenceNames: string[]
}
type ConflictReview = { remote: CanvasGraph; merged: CanvasGraph; conflicts: number }

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

class CanvasConflictError extends Error {}

async function saveCanvas(projectId: string, payload: CanvasGraph): Promise<CanvasGraph> {
  const response = await fetch(`/api/projects/${projectId}/canvas`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes: payload.nodes, edges: payload.edges, revision: payload.revision }),
  })
  if (response.status === 409) throw new CanvasConflictError('画布版本冲突，请合并服务器修改')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string; message?: string }
    throw new Error(body.detail || body.message || `保存失败 (${response.status})`)
  }
  return response.json() as Promise<CanvasGraph>
}

export interface ProjectCanvasProps {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  onRefresh: () => Promise<void>
  onRenameProject?: (name: string) => Promise<boolean>
  onOpenModels: () => void
  onNavigate: (destination: 'projects' | 'studio' | 'assets' | 'jobs' | 'models') => void
  onOpenScriptCreator: () => void
  onOpenScriptDocument?: (artifact: ScriptArtifact) => void
  onOpenScriptDirector?: (focusArtifact?: ScriptAction, context?: string) => void
  initialLocation?: CanvasLocation
  onLocationChange?: (location: CanvasLocation) => void
}

function draftKey(projectId: string) { return `project-canvas-draft:${projectId}` }
function autoImportKey(projectId: string) { return `project-canvas-imported:${projectId}` }
function viewportKey(projectId: string) { return `project-canvas-viewport:${projectId}` }
function minimapKey(projectId: string) { return `project-canvas-minimap:v2:${projectId}` }

function readCanvasViewport(projectId: string): CanvasViewport | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(viewportKey(projectId)) || '') as Partial<CanvasViewport>
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y) || !Number.isFinite(parsed.zoom)) return null
    return { x: Number(parsed.x), y: Number(parsed.y), zoom: Math.min(8, Math.max(0.1, Number(parsed.zoom))) }
  } catch { return null }
}

function keepCanvasViewport(projectId: string, viewport: CanvasViewport) {
  try { window.localStorage.setItem(viewportKey(projectId), JSON.stringify(viewport)) } catch { /* Storage may be disabled. */ }
}

function readMiniMapPosition(projectId: string): MiniMapPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(minimapKey(projectId)) || '') as Partial<MiniMapPosition>
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return { x: Number(parsed.x), y: Number(parsed.y) }
  } catch { return null }
}

function keepMiniMapPosition(projectId: string, position: MiniMapPosition) {
  try { window.localStorage.setItem(minimapKey(projectId), JSON.stringify(position)) } catch { /* In-memory position remains available. */ }
}
function keepDraft(queue: SaveQueue) {
  try { window.localStorage.setItem(draftKey(queue.id), JSON.stringify({ base: queue.base, graph: queue.graph })) }
  catch { /* The in-memory draft remains available during this visit. */ }
}

function clearDraft(projectId: string) {
  try { window.localStorage.removeItem(draftKey(projectId)) } catch { /* Storage may be disabled. */ }
}

function readDraft(projectId: string): { base: CanvasGraph; graph: CanvasGraph } | null {
  try {
    const value = window.localStorage.getItem(draftKey(projectId))
    if (!value) return null
    const parsed = JSON.parse(value) as { base: CanvasGraph; graph: CanvasGraph }
    if (!Array.isArray(parsed.base?.nodes) || !Array.isArray(parsed.graph?.nodes)) return null
    return { base: normalizeGraph(parsed.base), graph: normalizeGraph(parsed.graph) }
  } catch { return null }
}

const modeOptions: { value: CanvasMode; label: string }[] = [
  { value: 'text', label: '文生视频' },
  { value: 'first_frame', label: '首帧' },
  { value: 'first_last_frame', label: '首尾帧' },
  { value: 'reference', label: '参考生成' },
  { value: 'edit', label: '编辑视频' },
  { value: 'extend', label: '延长视频' },
]
const jobLabels = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' } as const

function blankNode(type: CanvasNode['type'], x: number, y: number): CanvasNode {
  return {
    id: crypto.randomUUID(), type, x, y,
    width: type === 'project_script_ref' ? 640 : type === 'generation' ? 440 : type === 'text' ? 420 : 400,
    // Media cards reserve a 16:9 preview plus a compact action rail. Keeping
    // the node at that ratio avoids letterbox space around 720p/1080p assets.
    height: type === 'project_script_ref' ? 350 : type === 'generation' ? 420 : type === 'text' ? 340 : 272,
    title: type === 'project_script_ref' ? '项目剧本' : type === 'generation' ? '生成节点' : type === 'text' ? '文本节点' : '',
    text: '', asset_id: null, shot_id: null, model_id: null, job_id: null,
    prompt: '', settings: {},
  }
}

function normalizeGraph(input: CanvasGraph): CanvasGraph {
  const nodes = input.nodes.map((rawNode) => {
    const node = { ...blankNode(rawNode.type, rawNode.x, rawNode.y), ...rawNode,
      settings: { ...(rawNode.settings || {}) } }
    // Text generation was folded into the image/video generators. Convert old
    // persisted text generators to editable text nodes so existing canvases
    // remain usable after the menu entry is removed.
    if (node.type === 'generation' && (node.settings.modality === 'text' || node.title === '文本生成')) {
      node.type = 'text'
      node.title = ['文本生成', '生成节点'].includes(node.title) ? '文本节点' : node.title
      node.text = node.text || node.prompt || ''
      node.prompt = ''
      node.width = Math.max(node.width, 420)
      node.height = Math.max(node.height, 340)
      node.settings = { ...node.settings, modality: undefined, prompt_override: undefined, text_mode: 'write' }
    } else if (node.type === 'text') {
      node.settings = { ...node.settings, text_mode: 'write' }
    }
    // Older media nodes used a 4:3 card (400x300), which leaves black bands
    // around a 16:9 result. Migrate only that untouched default size so a
    // user-resized card keeps its custom dimensions.
    if ((node.type === 'image' || node.type === 'video') && node.width === 400 && node.height === 300) {
      node.height = 272
    }
    // The former text-node-to-video composition mode is no longer a node
    // mode. Keep the video generator as a normal video node when loading it.
    if (node.type === 'generation' && (node.settings as { text_mode?: string }).text_mode === 'video') {
      node.settings = { ...node.settings, text_mode: undefined, group_id: undefined, group_title: undefined }
    }
    return node
  })
  // The project script is a source of creative context, not a graph input.
  // Older canvas snapshots could still contain script edges from the previous
  // workbench flow; drop them while loading so the card remains independent.
  const scriptNodeIds = new Set(nodes.filter((node) => node.type === 'project_script_ref').map((node) => node.id))
  // The first project-script card used the compact workbench layout. Upgrade
  // only that untouched default so existing custom node sizes remain intact.
  for (const node of nodes) {
    if (node.type === 'project_script_ref' && node.width === 390 && node.height === 216) {
      node.width = 640
      node.height = 350
    }
  }
  return {
    revision: input.revision,
    nodes,
    edges: input.edges.filter((edge) => !scriptNodeIds.has(edge.source) && !scriptNodeIds.has(edge.target)),
  }
}

function nodeMinSize(node: CanvasNode, asset?: Asset): { width: number; height: number } {
  if (node.type === 'project_script_ref') return { width: 560, height: 320 }
  if (node.type === 'generation' && asset?.kind === 'image') return imageNodeMinimum
  return node.type === 'generation' ? { width: 440, height: 420 }
    : node.type === 'text' ? { width: 420, height: 340 }
      : { width: 400, height: 272 }
}

function nodeSize(node: CanvasNode, asset?: Asset) {
  const minimum = nodeMinSize(node, asset)
  const width = Math.max(Number.isFinite(node.width) ? node.width : 0, minimum.width)
  const height = Math.max(Number.isFinite(node.height) ? node.height : 0, minimum.height)
  return { width, height }
}

// Canvas history only needs the small, JSON-like graph structure. Keeping a
// copy of nested settings here prevents a later inline edit from changing an
// older undo snapshot by reference.
function cloneGraph(graph: CanvasGraph): CanvasGraph {
  return {
    revision: graph.revision,
    nodes: graph.nodes.map((node) => ({ ...node, settings: { ...node.settings } })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  }
}

function scriptPrompt(script: ProjectDetail['script'] | undefined): string {
  if (!script) return ''
  const scenes = script.scenes.map((scene, index) => [
    `场次 ${index + 1}：${scene.heading}`,
    scene.location && `地点：${scene.location}`,
    scene.characters && `人物：${scene.characters}`,
    scene.action && `动作：${scene.action}`,
    scene.dialogue && `对白：${scene.dialogue}`,
    scene.narration && `旁白：${scene.narration}`,
    `时长：${scene.duration} 秒`,
  ].filter(Boolean).join('\n')).join('\n\n')
  const artifacts = (script.artifacts || [])
    .filter((artifact) => artifact.content?.trim() && !['outline', 'characters', 'structure'].includes(artifact.artifact_type))
    .map((artifact) => `${artifact.title}：${artifact.content.trim()}`)
    .join('\n\n')
  return [
    script.outline && `故事大纲：${script.outline}`,
    script.characters && `人物设定：${script.characters}`,
    artifacts && `剧本创作产物：\n${artifacts}`,
    scenes && `分场内容：\n${scenes}`,
  ].filter(Boolean).join('\n\n').slice(0, 30000)
}

function promptForNode(node: CanvasNode, graph: CanvasGraph, shots: Shot[], script?: ProjectDetail['script']): string {
  if (node.settings.prompt_override) return node.text
  const connected = graph.edges.filter((edge) => edge.target === node.id)
    .map((edge) => graph.nodes.find((source) => source.id === edge.source))
    .filter((source): source is CanvasNode => !!source)
    .map((source) => source.type === 'project_script_ref' ? scriptPrompt(script) : source.type === 'text' ? source.text.trim() : '')
    .filter(Boolean)
  const shotPrompt = shots.find((shot) => shot.id === node.shot_id)?.prompt.trim() || ''
  return [...connected, node.prompt.trim() || shotPrompt].filter(Boolean).join('\n\n')
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function mergeFields<T extends Record<string, unknown>>(base: T, local: T, remote: T): { item: T; conflicts: number } {
  const merged: Record<string, unknown> = { ...remote }
  let conflicts = 0
  for (const key of Object.keys(local)) {
    if (key === 'id' || sameValue(base[key], local[key])) continue
    if (key === 'settings' && base[key] && local[key] && remote[key]) {
      const nested = mergeFields(base[key] as Record<string, unknown>, local[key] as Record<string, unknown>,
        remote[key] as Record<string, unknown>)
      merged[key] = nested.item
      conflicts += nested.conflicts
      continue
    }
    if (!sameValue(base[key], remote[key]) && !sameValue(local[key], remote[key])) conflicts += 1
    merged[key] = local[key]
  }
  return { item: merged as T, conflicts }
}

function mergeItems<T extends { id: string }>(base: T[], local: T[], remote: T[]): { items: T[]; conflicts: number } {
  const original = new Map(base.map((item) => [item.id, item]))
  const mine = new Map(local.map((item) => [item.id, item]))
  const theirs = new Map(remote.map((item) => [item.id, item]))
  const order = [...new Set([...remote.map((item) => item.id), ...local.map((item) => item.id)])]
  let conflicts = 0
  const items: T[] = []
  for (const id of order) {
    const previous = original.get(id)
    const localItem = mine.get(id)
    const remoteItem = theirs.get(id)
    const localChanged = !sameValue(previous, localItem)
    const remoteChanged = !sameValue(previous, remoteItem)
    if (previous && localItem && remoteItem && localChanged && remoteChanged) {
      const merged = mergeFields(previous as T & Record<string, unknown>, localItem as T & Record<string, unknown>,
        remoteItem as T & Record<string, unknown>)
      items.push(merged.item)
      conflicts += merged.conflicts
      continue
    }
    if (localChanged && remoteChanged && !sameValue(localItem, remoteItem)) conflicts += 1
    const chosen = localChanged ? localItem : remoteItem
    if (chosen) items.push(chosen)
  }
  return { items, conflicts }
}

function mergeGraphs(base: CanvasGraph, local: CanvasGraph, remote: CanvasGraph): ConflictReview {
  const nodes = mergeItems(base.nodes, local.nodes, remote.nodes)
  const edges = mergeItems(base.edges, local.edges, remote.edges)
  const ids = new Set(nodes.items.map((node) => node.id))
  return {
    remote,
    merged: { nodes: nodes.items, edges: edges.items.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), revision: remote.revision },
    conflicts: nodes.conflicts + edges.conflicts,
  }
}

function modelResolutions(model?: Model): string[] {
  const values = model?.settings.resolutions
  return Array.isArray(values) && values.some((value) => typeof value === 'string')
    ? values.filter((value): value is string => typeof value === 'string')
    : model?.modality === 'image' ? ['1K', '2K', '4K'] : ['480p', '720p', '1080p']
}

const modelImageQualities = (model?: Model) => imageParameterOptions(model, 'quality')
const modelImageBackgrounds = (model?: Model) => imageParameterOptions(model, 'background')
const modelImageClarities = (model?: Model) => imageParameterOptions(model, 'clarity')

function modelRatios(model?: Model): string[] {
  const values = model?.settings.ratios
  return Array.isArray(values) && values.some((value) => typeof value === 'string')
    ? values.filter((value): value is string => typeof value === 'string')
    : model?.modality === 'image'
      ? imageRatios
      : ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']
}

function modelDurationBounds(model?: Model) {
  const configuredMin = model?.settings.min_duration
  const configuredMax = model?.settings.max_duration
  const min = typeof configuredMin === 'number' && Number.isFinite(configuredMin) ? Math.max(1, Math.min(120, Math.ceil(configuredMin))) : 1
  const max = typeof configuredMax === 'number' && Number.isFinite(configuredMax) ? Math.max(min, Math.min(120, Math.floor(configuredMax))) : 120
  return { min, max }
}

function modelDuration(model: Model | undefined, duration: number) {
  const { min, max } = modelDurationBounds(model)
  return Math.min(max, Math.max(min, Math.round(duration)))
}

function supportedModes(model?: Model): CanvasMode[] {
  const configured = model?.settings.supported_modes
  const supported = Array.isArray(configured) ? configured : ['text']
  return modeOptions.map(({ value }) => value).filter((value) => supported.includes(value))
}

function isCanvasEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  if (!element) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(element.tagName)
}

function NodeMedia({ asset, controls = false, onImageSize }: { asset?: Asset; controls?: boolean; onImageSize?: (width: number, height: number) => void }) {
  if (!asset) return <div className="pc-node-empty"><CircleAlert size={16} />素材不可用</div>
  if (asset.kind === 'image') return <img src={asset.url} alt={asset.filename} onLoad={onImageSize ? event => onImageSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight) : undefined} />
  if (asset.kind === 'video') return <video src={asset.url} controls={controls} muted={!controls} playsInline preload="metadata" />
  return <div className="pc-node-text">{asset.text || asset.filename}</div>
}

function nodeDimensionLabel(node: CanvasNode, model?: Model): string {
  if (node.type === 'generation' && node.settings.modality === 'image' && model) {
    const defaults = imageGenerationDefaults(model)
    return [imageParameterValue(model, 'clarity', node.settings.clarity || defaults.clarity), node.settings.ratio || defaults.ratio].filter(Boolean).join(' · ')
  }
  if (node.type === 'text') return ''
  const resolution = typeof node.settings.clarity === 'string' && node.settings.clarity.trim()
    ? node.settings.clarity.trim()
    : typeof node.settings.resolution === 'string' ? node.settings.resolution.trim() : ''
  const ratio = node.settings.modality === 'video' && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(node.settings.mode || '')
    ? '自适应' : typeof node.settings.ratio === 'string' ? node.settings.ratio.trim() : ''
  return [resolution, ratio].filter(Boolean).join(' · ')
}

function scriptUpdatedLabel(detail: ProjectDetail): string {
  const updated = detail.script?.scenes.map(scene => Date.parse(scene.updated_at)).filter(Number.isFinite) || []
  const projectUpdated = Date.parse(detail.updated_at)
  const timestamp = updated.length ? Math.max(...updated) : projectUpdated
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(timestamp)
}

function TextChoiceIcon() {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <rect x="2" y="1.5" width="16" height="17" rx="2" fill="currentColor" />
    <path d="M5.5 6h9M5.5 9h9M5.5 12h9M5.5 15h6" stroke="#262626" strokeWidth="1.3" />
  </svg>
}

/** A soft neutral edge with a moving highlight, matching the canvas visual language. */
function StudioEdge({ id, selected, style, data, ...props }: EdgeProps<Edge>) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.25,
  })
  const related = !!(data as { related?: boolean } | undefined)?.related
  const automatic = !!data?.visualBinding
  return <g className={`pc-studio-edge${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${style?.opacity === 0 ? ' is-hidden' : ''}`}>
    {automatic && <title>已绑定的设定参考图，点击调整镜头视觉设定</title>}
    <BaseEdge id={id} path={path} interactionWidth={28} style={{
      ...style,
      stroke: selected ? '#82c8f4' : '#5c6b7b',
      strokeWidth: selected ? 2.5 : 1.6,
      strokeLinecap: 'round',
    }} />
    <path d={path} className="pc-studio-edge-glow" aria-hidden="true" />
  </g>
}

function StudioConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
    curvature: 0.25,
  })
  return <g className="pc-studio-connection-line" aria-hidden="true">
    <path d={path} className="pc-studio-connection-base" />
    <path d={path} className="pc-studio-connection-glow" />
  </g>
}

const edgeTypes = { studio: StudioEdge }

function StudioNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, asset, job } = data
  const profile = data.profile
  const imageEditingAvailable = data.model?.modality === 'image' ? data.imageEditingModels.includes(data.model.id) : data.modelOptions.some(option => data.imageEditingModels.includes(option.value))
  const videoQuickModes = data.model?.modality === 'video' ? supportedModes(data.model) : data.videoQuickModes
  const isProjectScriptRef = node.type === 'project_script_ref'
  const isImageResult = node.type === 'generation' && asset?.kind === 'image'
  const icon = isProjectScriptRef ? <ScrollText size={15} /> : profile ? <ImageIcon size={15} /> : node.type === 'generation' ? <WandSparkles size={15} />
    : node.type === 'image' ? <ImageIcon size={15} />
      : node.type === 'video' ? <Film size={15} /> : <TextChoiceIcon />
  const tryButton = (action: NodeQuickAction, label: string, buttonIcon: React.ReactNode) => <button type="button" className="pc-node-try-action nodrag" onClick={(event) => { event.stopPropagation(); data.onTryAction(node.id, action) }}>{buttonIcon}<span>{label}</span></button>
  const [scriptSection, setScriptSection] = useState<'outline' | 'characters' | 'locations' | 'props' | 'episodes'>('outline')
  const nodeTitle = isProjectScriptRef
    ? (data.scriptTitle || node.title || '项目剧本')
    : profile ? `${profile.name} · ${profile.variant}`
    : node.title || asset?.filename || (node.type === 'generation' ? '生成节点' : node.type === 'image' ? '图片节点' : node.type === 'video' ? '视频节点' : '文本节点')
  const idlePlaceholder = <div className="pc-node-placeholder" aria-label={job?.status === 'running' || job?.status === 'queued' ? '生成中' : job?.status === 'failed' ? '生成失败' : '尚未生成'}>
    {job?.status === 'running' || job?.status === 'queued' ? <LoaderCircle size={42} className="pc-spin" />
      : job?.status === 'failed' ? <><CircleAlert size={40} /><span>生成失败，请查看任务记录</span></>
        : node.settings.modality === 'video' ? <Film size={54} strokeWidth={1.2} /> : <ImageIcon size={54} strokeWidth={1.2} />}
  </div>
  const generationTryActions = <div className="pc-node-try-list" aria-label="尝试操作">
    <span className="pc-node-try-label">尝试:</span>
    {(node.settings.modality === 'video' ? <>
      {videoQuickModes.includes('first_frame') && tryButton('video-first-frame', '首帧生成视频', <ImageIcon size={15} />)}
      {videoQuickModes.includes('first_last_frame') && tryButton('video-first-last', '首尾帧生成', <ArrowLeftRight size={15} />)}
      {videoQuickModes.includes('extend') && tryButton('video-extend', '延长视频', <Film size={15} />)}
    </> : node.settings.modality === 'image' && imageEditingAvailable ? <>
      {tryButton('image-to-image', '图生图', <ImageIcon size={15} />)}
    </> : null)}
  </div>
  return <>
  <div className={`pc-node pc-node-${node.type}${isImageResult ? ' pc-node-image-result' : ''}${profile ? ' pc-node-profile' : ''} ${selected ? 'is-selected' : ''}`}>
    {!isProjectScriptRef && <NodeResizer isVisible={selected} minWidth={nodeMinSize(node, asset).width} minHeight={nodeMinSize(node, asset).height} keepAspectRatio={isImageResult} />}
    <div className="pc-node-label"><span className="pc-node-label-icon">{icon}</span><strong title={nodeTitle}>{nodeTitle}</strong>{nodeDimensionLabel(node, data.model) && <span className="pc-node-dimension">{nodeDimensionLabel(node, data.model)}</span>}</div>
    {!isProjectScriptRef && <Handle className="pc-node-handle" type="target" position={Position.Left} title="连接到此节点" />}
    {isProjectScriptRef ? <div className="pc-project-script-card">
      <div className="pc-project-script-controls nodrag nopan">
        <button type="button" className="pc-project-script-edit" aria-label="打开剧本对话" onClick={(event) => { event.stopPropagation(); data.onOpenScriptDirector('all') }}>
          <MessageSquare size={14} />{data.scriptExists ? '剧本对话' : '开始创作'}
        </button>
        {data.scriptExists && <button type="button" className="pc-project-script-edit" aria-label="编辑剧本" onClick={(event) => { event.stopPropagation(); data.onOpenScriptCreator() }}>
          <PenLine size={14} />编辑
        </button>}
      </div>
      <div className="pc-project-script-heading">
        <strong>{data.scriptTitle || node.title || '项目剧本'}</strong>
        {data.scriptUpdatedAt && <time>{data.scriptUpdatedAt}</time>}
      </div>
      <div className="pc-project-script-tabs" role="tablist" aria-label="剧本内容分类">
        {([
          ['outline', '故事大纲'], ['characters', '人物小传'], ['locations', '场景设计'], ['props', '道具设计'], ['episodes', '分集剧本'],
        ] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={scriptSection === value}
          className={scriptSection === value ? 'is-active' : ''} onClick={(event) => { event.stopPropagation(); setScriptSection(value) }}>{label}</button>)}
      </div>
      <div className="pc-project-script-empty nowheel nodrag nopan">
        {(() => {
          if (scriptSection === 'episodes') {
            const episodes = (data.scriptArtifacts || []).filter(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) > 0).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
            return episodes.length ? <div className="pc-script-episodes">{episodes.map(artifact => <button key={artifact.id} type="button" onClick={event => { event.stopPropagation(); data.onOpenScriptDocument?.(artifact) }}><FileText size={16} /><span><strong>{artifact.title}</strong><small>已保存 · 点击编辑本集</small></span><ChevronDown size={14} /></button>)}</div> : <div className="pc-script-empty-state">
              <strong>还没有分集剧本</strong>
              <p>在对话中创作本集，确认保存后即可制作分镜。</p>
              <button type="button" className="pc-project-script-edit" aria-label="打开分集创作对话" onClick={event => { event.stopPropagation(); data.onOpenScriptDirector('all') }}><MessageSquare size={14} />打开剧本对话</button>
            </div>
          }
          const artifact = data.scriptArtifacts?.find((item) => item.artifact_type === scriptSection)
          const content = artifact?.content?.trim() || (scriptSection === 'outline' ? data.scriptOutline?.trim() : '')
          if (!content) return `暂无${scriptSection === 'outline' ? '故事大纲' : scriptSection === 'characters' ? '人物小传' : scriptSection === 'locations' ? '场景设计' : '道具设计'}，可在导演对话中生成`
          const document = parseScriptDocument(content)
          return <CanvasTextPreview text={textDocumentText(document)} document={document} />
        })()}
      </div>
    </div> : node.type === 'generation' ? <>
      <div className="pc-node-content pc-node-preview-content pc-node-idle-content">
        {asset ? <div className="pc-node-output"><NodeMedia asset={asset} controls={selected}
          onImageSize={isImageResult ? (width, height) => data.onImageSize(node.id, asset.id, width, height) : undefined} /></div> : idlePlaceholder}
        {!profile && !selected && !asset && ((node.settings.modality === 'video' && videoQuickModes.some(mode => ['first_frame', 'first_last_frame', 'extend'].includes(mode))) || imageEditingAvailable) && generationTryActions}
      </div>
      {(selected || profile) && <div className={`pc-node-foot ${job ? `pc-job-${job.status}` : ''}`}>
        {profile ? <><span>v{profile.revision} · {job?.status === 'running' || job?.status === 'queued' ? <span className="pc-profile-generating">生成中<span aria-hidden="true" /></span> : job?.status === 'failed' ? '生成失败' : asset && asset.id !== profile.board_asset_id ? '候选待确认' : profile.board_asset_id ? '已确认' : '待生成'}</span><span>{profile.kind === 'character' ? '人物设定' : profile.kind === 'location' ? '场景设定' : '道具设定'}</span></>
          : job ? <><span className="pc-status-dot" />{jobLabels[job.status]}</> : asset ? '已有结果' : '等待配置'}
              </div>}
    </> : node.type === 'text' ? <>
      {selected ? <div className="pc-node-content">
        <CanvasTextEditor text={node.text} document={node.settings.text_document} selected
          label="文本节点内容"
          onChange={(text, document) => data.onTextDocumentChange(node.id, text, document)} />
      </div> : <div className="pc-node-content pc-node-preview-content pc-node-idle-content">
        <CanvasTextPreview text={node.text} document={node.settings.text_document} />
      </div>}
      {selected && <div className="pc-node-foot">文本提示词</div>}
    </> : <>
      <div className="pc-node-media"><NodeMedia asset={asset} controls={selected} /></div>
      {!selected && <div className="pc-node-try-actions pc-node-try-actions-media" aria-label="尝试操作">
        {node.type === 'image' ? imageEditingAvailable && <>{tryButton('image-to-image', '图生图', <ImageIcon size={13} />)}</>
          : <>{videoQuickModes.includes('first_frame') && tryButton('video-first-frame', '首帧生成', <ImageIcon size={13} />)}{videoQuickModes.includes('first_last_frame') && tryButton('video-first-last', '首尾帧', <ArrowLeftRight size={13} />)}{videoQuickModes.includes('extend') && tryButton('video-extend', '延长视频', <Film size={13} />)}</>}
      </div>}
    </>}
    {!isProjectScriptRef && <Handle className="pc-node-handle" type="source" position={Position.Right} title="从此节点连接" />}
  </div>
  </>
}

const nodeTypes = { studio: StudioNode }

function ProjectCanvasInner({ detail, models, providers, onRefresh, onRenameProject, onOpenModels, onNavigate, onOpenScriptCreator, onOpenScriptDocument, onOpenScriptDirector: onOpenDirectorPanel, initialLocation, onLocationChange }: ProjectCanvasProps) {
  const { confirm, dialog } = useAppDialog()
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const startLocation = useRef(initialLocation)
  const [viewMode, setViewMode] = useState<CanvasView>(initialLocation?.view || 'canvas')
  // Liblib-style left rail: it keeps the canvas graph discoverable while node
  // content and generation settings stay in the canvas itself.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'canvas' | 'assets' | 'profiles'>('canvas')
  const [profileSearch, setProfileSearch] = useState('')
  const [profileFilter, setProfileFilter] = useState<'all' | VisualProfile['kind']>('all')
  const [profileInspectorId, setProfileInspectorId] = useState<string | null>(null)
  const [profileDraftDirty, setProfileDraftDirty] = useState(false)
  const [candidateProfileId, setCandidateProfileId] = useState<string | null>(null)
  const [sidebarSearch, setSidebarSearch] = useState('')
  const [sidebarFilter, setSidebarFilter] = useState<'all' | CanvasNode['type']>('all')
  const [sidebarAssetFilter, setSidebarAssetFilter] = useState<'all' | Asset['kind']>('all')
  const [sidebarAssetSearch, setSidebarAssetSearch] = useState('')
  const [projectNameEditing, setProjectNameEditing] = useState(false)
  const [projectNameDraft, setProjectNameDraft] = useState(detail.name)
  const projectNameInputRef = useRef<HTMLInputElement>(null)
  const [referenceTargetNodeId, setReferenceTargetNodeId] = useState<string | null>(null)
  const [referenceUploadTargetId, setReferenceUploadTargetId] = useState<string | null>(null)
  const [referenceReturnNodeId, setReferenceReturnNodeId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error' | 'conflict'>('saved')
  const [notice, setNoticeState] = useState<{ message: string } | null>(null)
  const setNotice = useCallback((message: string | null) => {
    setNoticeState(message === null ? null : { message })
  }, [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNoticeState(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [composerNodeId, setComposerNodeId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [storyboardSelectedId, setStoryboardSelectedId] = useState<string | null>(initialLocation?.storyboardId || null)
  useEffect(() => {
    onLocationChange?.({ view: viewMode, storyboardId: storyboardSelectedId })
  }, [viewMode, storyboardSelectedId, onLocationChange])
  const pendingCanvasFocus = useRef<string | null>(null)
  const [composerRevealKey, setComposerRevealKey] = useState(0)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [showEdges, setShowEdges] = useState(true)
  const [showMinimap, setShowMinimap] = useState(false)
  const [minimapPosition, setMinimapPosition] = useState<MiniMapPosition | null>(null)
  const [viewportZoom, setViewportZoom] = useState(100)
  const [savedViewport, setSavedViewport] = useState<CanvasViewport | null>(null)
  const [addMenu, setAddMenu] = useState<CanvasAddMenu | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null)
  const [pendingRunNodeId, setPendingRunNodeId] = useState<string | null>(null)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [review, setReview] = useState<GenerationReview | null>(null)
  const [generationInfoOpen, setGenerationInfoOpen] = useState(false)
  const [generationInfoTrigger, setGenerationInfoTrigger] = useState<HTMLButtonElement | null>(null)
  const [generationInfoDropdown, setGenerationInfoDropdown] = useState<HTMLDivElement | null>(null)
  // Canvas/composer controls stop bubbling, so dismiss on the capture phase.
  useClickOutside(() => setGenerationInfoOpen(false), ['pointerdown'],
    [generationInfoTrigger, generationInfoDropdown], generationInfoOpen, true)
  useEffect(() => {
    setComposerExpanded(false)
  }, [selectedNodeId, composerNodeId, detail.id, viewMode])
  useEffect(() => {
    setGenerationInfoOpen(false)
    setReview(null)
  }, [selectedNodeId, composerNodeId, detail.id, composerExpanded])
  const [visualPreparationOpen, setVisualPreparationOpen] = useState(false)
  const previewingRef = useRef(false)
  const [conflictReview, setConflictReview] = useState<ConflictReview | null>(null)
  const [busy, setBusy] = useState(false)
  const queueRef = useRef<SaveQueue | null>(null)
  const placementDetailRef = useRef(detail)
  placementDetailRef.current = detail
  const historyRef = useRef<{ past: CanvasGraph[]; future: CanvasGraph[] }>({ past: [], future: [] })
  // React Flow emits many position changes while a node is dragged. Keep one
  // undo checkpoint for the complete gesture so history and autosave remain
  // useful on a large canvas.
  const dragSnapshotRef = useRef<CanvasGraph | null>(null)
  const [, setHistoryTick] = useState(0)
  const autoImportAttempted = useRef(false)
  const initialViewApplied = useRef(false)
  const minimapDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startLeft: number
    startTop: number
    mapWidth: number
    mapHeight: number
    element: HTMLElement
    dragging: boolean
  } | null>(null)
  // The magnetic hit area starts React Flow's mouse-based connection handler
  // from a pointer event. Keep the pointer id so its movement and release can
  // be forwarded to that handler even when compatibility mouse events are
  // suppressed by preventDefault().
  const magnetConnectionRef = useRef<{ pointerId: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const referenceUploadInputRef = useRef<HTMLInputElement>(null)
  const profileUploadInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const { fitView, screenToFlowPosition, setCenter, setViewport, zoomTo } = useReactFlow<FlowNode, Edge>()

  useEffect(() => {
    if (!projectNameEditing) setProjectNameDraft(detail.name)
  }, [detail.name, projectNameEditing])

  useEffect(() => {
    if (!projectNameEditing) return
    projectNameInputRef.current?.focus()
    projectNameInputRef.current?.select()
  }, [projectNameEditing])

  const cancelProjectNameEdit = useCallback(() => {
    setProjectNameDraft(detail.name)
    setProjectNameEditing(false)
  }, [detail.name])

  const saveProjectName = useCallback(async () => {
    const nextName = projectNameDraft.trim()
    if (!nextName) {
      cancelProjectNameEdit()
      return
    }
    if (!onRenameProject || nextName === detail.name) {
      setProjectNameDraft(detail.name)
      setProjectNameEditing(false)
      return
    }
    const saved = await onRenameProject(nextName)
    if (saved) setProjectNameEditing(false)
  }, [cancelProjectNameEdit, detail.name, onRenameProject, projectNameDraft])

  const showError = useCallback((error: unknown) => {
    setNotice(error instanceof Error ? error.message : String(error))
  }, [])

  // Keep the visible connection affordance quiet until the pointer comes
  // close. The small magnetic pull is applied directly to the handle DOM
  // nodes so moving the pointer does not rerender the entire React Flow graph.
  const clearConnectionMagnet = useCallback(() => {
    const canvas = viewportRef.current
    if (!canvas) return
    canvas.querySelectorAll<HTMLElement>('.pc-node-handle[data-magnet="true"]').forEach((handle) => {
      handle.dataset.magnet = 'false'
      handle.style.removeProperty('--pc-magnet-x')
      handle.style.removeProperty('--pc-magnet-y')
    })
  }, [])

  const updateConnectionMagnet = useCallback((clientX: number, clientY: number, target: EventTarget | null) => {
    const canvas = viewportRef.current
    if (!canvas) return
    // Node content, editors and controls keep their own pointer interactions.
    // Only the empty pane and the actual ports participate in magnetism.
    if (!(target instanceof Element) || (!target.classList.contains('react-flow__pane') && !target.closest('.pc-node-handle'))) {
      clearConnectionMagnet()
      return
    }
    const handles = canvas.querySelectorAll<HTMLElement>('.pc-node-handle')
    const radius = 92
    handles.forEach((handle) => {
      const rect = handle.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const deltaX = clientX - centerX
      const deltaY = clientY - centerY
      const distance = Math.hypot(deltaX, deltaY)
      if (distance >= radius) {
        if (handle.dataset.magnet === 'true') {
          handle.dataset.magnet = 'false'
          handle.style.removeProperty('--pc-magnet-x')
          handle.style.removeProperty('--pc-magnet-y')
        }
        return
      }
      const strength = 1 - distance / radius
      // Pull towards the pointer with a soft cap, keeping the handle close to
      // its real React Flow anchor so the connection hit testing stays stable.
      const pull = 5 + strength * 13
      const scale = distance ? pull / distance : 0
      handle.dataset.magnet = 'true'
      // Never pull a port into the card, where it would intercept a node click.
      const pullX = Math.max(-18, Math.min(18, deltaX * scale))
      handle.style.setProperty('--pc-magnet-x', `${handle.classList.contains('react-flow__handle-left') ? Math.min(0, pullX) : Math.max(0, pullX)}px`)
      handle.style.setProperty('--pc-magnet-y', `${Math.max(-18, Math.min(18, deltaY * scale))}px`)
    })
  }, [clearConnectionMagnet])

  // The minimap is a fixed React Flow panel by default. Keep its viewport
  // navigation intact for clicks and wheel zoom, while allowing a drag gesture
  // to reposition the panel itself within the canvas. Pointer capture keeps
  // the gesture alive when the cursor leaves the small minimap surface.
  const onCanvasPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const canvas = viewportRef.current
    if (!canvas) return
    if (event.button !== 0 || !event.isPrimary) return

    // The handle moves toward the pointer while it is in the magnetic zone.
    // The enlarged hit area only applies to empty canvas around a port.
    // Presses inside a node must remain available for selection and dragging.
    if (target.classList.contains('react-flow__pane')) {
      const candidates = Array.from(canvas.querySelectorAll<HTMLElement>('.pc-node-handle[data-magnet="true"]'))
        .map((handle) => {
          const rect = handle.getBoundingClientRect()
          const dx = event.clientX - (rect.left + rect.width / 2)
          const dy = event.clientY - (rect.top + rect.height / 2)
          return { handle, distance: Math.hypot(dx, dy) }
        })
        .filter(candidate => candidate.distance < 92)
        .sort((left, right) => left.distance - right.distance)
      const nearest = candidates[0]?.handle
      if (nearest) {
        event.preventDefault()
        event.stopPropagation()
        magnetConnectionRef.current = { pointerId: event.pointerId }
        nearest.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          clientX: event.clientX,
          clientY: event.clientY,
        }))
        return
      }
    }

    if (!showMinimap || minimapDragRef.current) return
    const dock = target.closest('.pc-minimap-dock')
    const map = dock?.querySelector('.react-flow__minimap')
    if (!(map instanceof HTMLElement)) return
    clearConnectionMagnet()
    const mapBounds = map.getBoundingClientRect()
    const canvasBounds = canvas.getBoundingClientRect()
    minimapDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: mapBounds.left - canvasBounds.left,
      startTop: mapBounds.top - canvasBounds.top,
      mapWidth: mapBounds.width,
      mapHeight: mapBounds.height,
      element: map,
      dragging: false,
    }
    try { map.setPointerCapture(event.pointerId) } catch { /* Pointer capture is not available in every browser. */ }
  }, [clearConnectionMagnet, showMinimap])

  const onCanvasPointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const magnetConnection = magnetConnectionRef.current
    if (magnetConnection?.pointerId === event.pointerId) {
      // React Flow registers a document-level mousemove listener for a
      // connection drag. Forward the pointer coordinates so the temporary
      // line follows the cursor while the magnetic gesture is held.
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: event.buttons || 1,
        clientX: event.clientX,
        clientY: event.clientY,
      }))
    }
    const drag = minimapDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      updateConnectionMagnet(event.clientX, event.clientY, event.target)
      return
    }
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (!drag.dragging && Math.hypot(deltaX, deltaY) < 4) return
    drag.dragging = true
    event.preventDefault()
    event.stopPropagation()
    const canvas = viewportRef.current
    if (!canvas) return
    const bounds = canvas.getBoundingClientRect()
    const maxLeft = Math.max(8, bounds.width - drag.mapWidth - 8)
    const maxTop = Math.max(8, bounds.height - drag.mapHeight - 8)
    const next = {
      x: Math.min(maxLeft, Math.max(8, drag.startLeft + deltaX)),
      y: Math.min(maxTop, Math.max(8, drag.startTop + deltaY)),
    }
    setMinimapPosition(next)
    keepMiniMapPosition(detail.id, next)
  }, [detail.id, updateConnectionMagnet])

  const onCanvasPointerUpCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const magnetConnection = magnetConnectionRef.current
    if (magnetConnection?.pointerId === event.pointerId) {
      // Compatibility mouseup may also be suppressed after the synthetic
      // mousedown, so explicitly close React Flow's connection gesture.
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: 0,
        clientX: event.clientX,
        clientY: event.clientY,
      }))
      magnetConnectionRef.current = null
    }
    const drag = minimapDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.dragging) {
      event.preventDefault()
      event.stopPropagation()
    }
    try { drag.element.releasePointerCapture(event.pointerId) } catch { /* Pointer capture may already be released. */ }
    minimapDragRef.current = null
  }, [])

  const onCanvasPointerLeaveCapture = useCallback(() => {
    clearConnectionMagnet()
  }, [clearConnectionMagnet])

  const flush = useCallback(async (queue: SaveQueue): Promise<void> => {
    if (queue.timer !== null) { window.clearTimeout(queue.timer); queue.timer = null }
    if (queue.conflict) throw new Error('画布版本冲突，请先合并')
    if (queue.inFlight) { await queue.inFlight; return flush(queue) }
    if (queue.savedSerial === queue.serial) return
    const pending = (async () => {
      while (queue.savedSerial < queue.serial) {
        const serial = queue.serial
        const snapshot = queue.graph
        if (queueRef.current === queue) setSaveState('saving')
        try {
          const saved = normalizeGraph(await saveCanvas(queue.id, { ...snapshot, revision: queue.base.revision }))
          queue.base = saved
          queue.graph = { ...queue.graph, revision: saved.revision }
          queue.savedSerial = serial
          if (queue.savedSerial === queue.serial) clearDraft(queue.id)
          else keepDraft(queue)
          if (queueRef.current === queue) {
            setGraph(queue.graph)
            setSaveState(queue.savedSerial === queue.serial ? 'saved' : 'pending')
          }
        } catch (error) {
          if (error instanceof CanvasConflictError) {
            queue.conflict = true
            if (queueRef.current === queue) setSaveState('conflict')
          } else if (queueRef.current === queue) setSaveState('error')
          throw error
        }
      }
    })()
    queue.inFlight = pending
    try { await pending } finally { queue.inFlight = null }
  }, [])

  const scheduleSave = useCallback((queue: SaveQueue) => {
    if (queue.timer !== null) window.clearTimeout(queue.timer)
    if (queue.conflict) { setSaveState('conflict'); return }
    setSaveState('pending')
    queue.timer = window.setTimeout(() => { void flush(queue).catch(showError) }, 650)
  }, [flush, showError])

  const changeGraph = useCallback((updater: (current: CanvasGraph) => CanvasGraph) => {
    const queue = queueRef.current
    if (!queue || queue.id !== detail.id) return
    const candidate = updater(queue.graph)
    const nodes = placeNewCanvasNodes(queue.graph.nodes, candidate.nodes,
      node => nodeSize(node, visualNodeAsset(node, placementDetailRef.current)))
    const updated = nodes === candidate.nodes ? candidate : { ...candidate, nodes }
    // Keep the project script card independent even when an older action or a
    // restored draft tries to reintroduce a script edge.
    const scriptNodeIds = new Set(updated.nodes.filter((node) => node.type === 'project_script_ref').map((node) => node.id))
    const next = scriptNodeIds.size
      ? { ...updated, edges: updated.edges.filter((edge) => !scriptNodeIds.has(edge.source) && !scriptNodeIds.has(edge.target)) }
      : updated
    if (next === queue.graph || sameValue({ nodes: next.nodes, edges: next.edges },
      { nodes: queue.graph.nodes, edges: queue.graph.edges })) return
    const history = historyRef.current
    history.past.push(cloneGraph(queue.graph))
    if (history.past.length > 100) history.past.shift()
    history.future = []
    setHistoryTick((value) => value + 1)
    queue.graph = next
    queue.serial += 1
    keepDraft(queue)
    setGraph(next)
    scheduleSave(queue)
  }, [detail.id, scheduleSave])

  useEffect(() => {
    let active = true
    setViewMode(startLocation.current?.view || 'canvas')
    const rememberedViewport = readCanvasViewport(detail.id)
    setSavedViewport(rememberedViewport)
    setViewportZoom(Math.round((rememberedViewport?.zoom || 1) * 100))
    setMinimapPosition(readMiniMapPosition(detail.id))
    setShowMinimap(false)
    setShowEdges(true)
    dragSnapshotRef.current = null
    initialViewApplied.current = false
    autoImportAttempted.current = false
    historyRef.current = { past: [], future: [] }
    setHistoryTick((value) => value + 1)
    setGraph(null)
    setProfileInspectorId(null)
    setSelectedNodeId(null)
    setSelectedNodeIds([])
    setSelectedEdgeId(null)
    setReferenceReturnNodeId(null)
    setLoadError(null)
    setSaveState('saved')
    void api<CanvasGraph>(`/projects/${detail.id}/canvas`).then((value) => {
      if (!active) return
      const remote = normalizeGraph(value)
      const removedScriptEdges = remote.edges.length !== value.edges.length
      const draft = readDraft(detail.id)
      const queue: SaveQueue = { id: detail.id, graph: remote, base: remote, serial: 0, savedSerial: 0,
        timer: null, inFlight: null, conflict: false }
      if (draft && !sameValue({ nodes: draft.graph.nodes, edges: draft.graph.edges },
        { nodes: remote.nodes, edges: remote.edges })) {
        queue.graph = draft.graph
        queue.base = draft.base
        queue.serial = 1
        if (remote.revision !== draft.base.revision) {
          queue.conflict = true
          setSaveState('conflict')
          setConflictReview(mergeGraphs(draft.base, draft.graph, remote))
        } else scheduleSave(queue)
      } else if (draft) clearDraft(detail.id)
      queueRef.current = queue
      setGraph(queue.graph)
      // Persist the migration once so stale script edges disappear from the
      // server snapshot as well as the local canvas.
      if (removedScriptEdges && !queue.conflict) {
        queue.serial = Math.max(queue.serial, 1)
        scheduleSave(queue)
      }
    }).catch((error: unknown) => { if (active) setLoadError(error instanceof Error ? error.message : String(error)) })
    return () => {
      active = false
      const queue = queueRef.current
      if (queue?.id === detail.id) {
        if (queue.timer !== null) window.clearTimeout(queue.timer)
        if (!queue.conflict && queue.serial !== queue.savedSerial) void flush(queue).catch(() => {})
        queueRef.current = null
      }
    }
  }, [detail.id, flush, scheduleSave])

  useEffect(() => {
    if (!graph) return
    const completions = graph.nodes.filter((node) => (node.type === 'generation' || node.type === 'text') && node.job_id &&
      detail.jobs.find((job) => job.id === node.job_id)?.status === 'succeeded')
    if (!completions.length) return
    changeGraph((current) => {
      const nodes = [...current.nodes]
      const edges = [...current.edges]
      let changed = false
      for (const node of completions) {
        const live = nodes.find((item) => item.id === node.id)
        const job = detail.jobs.find((item) => item.id === live?.job_id)
        const asset = detail.assets.find((item) => item.id === job?.result_asset_id)
        if (!live || !asset) continue
        if (live.settings.visual_profile_id) {
          const profile = detail.visual_profiles?.find(item => item.id === live.settings.visual_profile_id)
          if (profile && live.settings.visual_completed_job_id !== job?.id) {
            nodes[nodes.indexOf(live)] = { ...live, asset_id: asset.id,
              settings: { ...live.settings, visual_completed_job_id: job!.id } }
            changed = true
          }
          continue
        }
        // Remove result nodes created by the previous completion behavior. A
        // generated node already previews its own asset; keep only explicitly
        // added asset nodes or existing provenance links.
        const legacyResultTitle = `${live.title || '生成节点'} · ${asset.kind === 'video' ? '视频' : asset.kind === 'image' ? '图片' : '文本'}`
        const legacyResultIds = new Set(nodes.filter((item) => item.id !== live.id && item.asset_id === asset.id &&
          item.type === asset.kind && item.title === legacyResultTitle).map((item) => item.id))
        if (legacyResultIds.size) {
          for (let index = nodes.length - 1; index >= 0; index -= 1) {
            if (legacyResultIds.has(nodes[index].id)) nodes.splice(index, 1)
          }
          for (let index = edges.length - 1; index >= 0; index -= 1) {
            if (legacyResultIds.has(edges[index].source) || legacyResultIds.has(edges[index].target)) edges.splice(index, 1)
          }
          changed = true
        }
        if (live.asset_id === asset.id) continue
        if (live.type === 'text') {
          if (asset.kind !== 'text') continue
          nodes[nodes.indexOf(live)] = { ...live, asset_id: asset.id, text: asset.text || '',
            settings: { ...live.settings, text_mode: 'write' } }
          changed = true
          continue
        }
        nodes[nodes.indexOf(live)] = { ...live, asset_id: asset.id }
        changed = true
        // The generation node already renders its completed result. Do not
        // create a second image/video/text node automatically; users can add
        // an asset node explicitly when they need a separate reusable copy.
        const resultNode = nodes.find((item) => item.asset_id === asset.id && item.type === asset.kind)
        if (resultNode && edges.length < 1000 && !edges.some((edge) => edge.source === live.id && edge.target === resultNode.id)) {
          edges.push({ id: crypto.randomUUID(), source: live.id, target: resultNode.id })
          changed = true
        }
      }
      return changed ? { ...current, nodes, edges } : current
    })
  }, [graph, detail.jobs, detail.assets, detail.visual_profiles, changeGraph])

  useEffect(() => {
    if (!graph?.nodes.some(node => node.settings.visual_profile_id)) return
    changeGraph(current => ({ ...current, nodes: current.nodes.map(node => {
      const profile = detail.visual_profiles?.find(item => item.id === node.settings.visual_profile_id)
      if (!node.settings.visual_profile_id) return node
      if (!profile) return { ...node, job_id: null, asset_id: null, settings: { ...node.settings, visual_profile_id: undefined, visual_profile_revision: undefined } }
      return syncVisualProfileNode(node, profile, detail)
    }) }))
  }, [graph, detail.visual_profiles, detail.asset_tasks, changeGraph])

  useEffect(() => {
    if (!graph || !detail.name) return
    if (!graph.nodes.some((node) => node.type === 'project_script_ref' && node.title !== detail.name)) return
    changeGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.type === 'project_script_ref' ? { ...node, title: detail.name } : node),
    }))
  }, [graph, detail.name, changeGraph])

  const assetMap = useMemo(() => new Map(detail.assets.map((asset) => [asset.id, asset])), [detail.assets])
  const shotMap = useMemo(() => new Map(detail.shots.map((shot) => [shot.id, shot])), [detail.shots])
  const jobMap = useMemo(() => new Map(detail.jobs.map((job) => [job.id, job])), [detail.jobs])
  const modelMap = useMemo(() => new Map(models.map((model) => [model.id, model])), [models])
  const availableModels = models.filter((model) => model.modality !== 'text' && model.enabled &&
    providers.some((provider) => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))
  const updateNodeById = useCallback((id: string, patch: Partial<CanvasNode>) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }))
  }, [changeGraph])
  const updateNodeSettingsById = useCallback((id: string, patch: Partial<CanvasNode['settings']>) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id
      ? { ...node, settings: { ...node.settings, ...patch } } : node) }))
  }, [changeGraph])
  const editNodePrompt = useCallback((id: string, value: string, prepared?: { base: string; template: string }) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id
      ? { ...node, text: value, settings: { ...node.settings, prompt_override: true,
        ...(prepared ? { prompt_is_final: true, prompt_base: prepared.base, prompt_template: prepared.template } : {}) } } : node) }))
  }, [changeGraph])
  const selectNodeModel = useCallback((id: string, modelId: string) => {
    const model = modelMap.get(modelId)
    const modes = supportedModes(model)
    const imageDefaults = imageGenerationDefaults(model)
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id
      ? { ...node, model_id: modelId || null, settings: { ...node.settings,
        modality: model?.modality || node.settings.modality,
        mode: node.settings.mode && (!model || modes.includes(node.settings.mode)) ? node.settings.mode : modes[0] || 'text',
        duration: model?.modality === 'video' ? modelDuration(model, node.settings.duration || shotMap.get(node.shot_id || '')?.duration || 5) : node.settings.duration,
        resolution: model?.modality === 'text' ? null : modelDefaultResolution(model, modelResolutions(model)) || null,
        clarity: model?.modality === 'image' ? imageParameterValue(model, 'clarity', node.settings.clarity || imageDefaults.clarity) : undefined,
        quality: model?.modality === 'image' ? imageParameterValue(model, 'quality', node.settings.quality || imageDefaults.quality) : undefined,
        background: model?.modality === 'image' ? imageParameterValue(model, 'background', node.settings.background || imageDefaults.background) : undefined,
        ratio: modelRatios(model).includes(node.settings.ratio || '') ? node.settings.ratio
          : model?.modality === 'image' ? imageDefaults.ratio : modelRatios(model).includes(detail.ratio) ? detail.ratio : modelRatios(model)[0], draft: false } }
      : node) }))
  }, [changeGraph, modelMap, shotMap, detail.ratio])
  const tryNodeAction = useCallback(async (sourceId: string, action: NodeQuickAction) => {
    if (busy) {
      setNotice('请等待当前操作完成')
      return
    }
    const source = queueRef.current?.graph.nodes.find((node) => node.id === sourceId)
    if (!source) return
    if (action === 'video-first-frame' && !source.settings.visual_profile_id && visualNodeAsset(source, detail)?.kind === 'image') {
      try {
        const current = queueRef.current!.graph
        const handoff = createImageVideoHandoff(current, source, detail, availableModels,
          blankNode('generation', source.x + source.width + 170, source.y), crypto.randomUUID())
        changeGraph(() => handoff.graph)
        setViewMode('canvas')
        focusSidebarNode(handoff.nodeId)
        setNotice(handoff.created ? '已创建分镜视频节点，当前图片已固定为首帧；检查动作与运镜后生成' : '已定位使用这张首帧的分镜视频节点')
      } catch (issue) { showError(issue) }
      return
    }
    if (source.type === 'generation' && action.startsWith('video-') && !source.asset_id) {
      const mode = action === 'video-first-frame' ? 'first_frame' : action === 'video-first-last' ? 'first_last_frame' : 'extend'
      updateNodeSettingsById(source.id, { mode })
      setComposerNodeId(source.id)
      setSelectedNodeId(source.id); setSelectedNodeIds([source.id])
      setNotice(mode === 'first_frame' ? '通过参考添加1张首帧图片' : mode === 'first_last_frame' ? '通过参考按顺序添加首帧和尾帧图片' : '请添加参考视频地址')
      return
    }
    if (action === 'image-to-image') {
      // Image-to-image is an input mode for the current composer. Open a
      // reference upload directly instead of creating a second generator node.
      setReferenceUploadTargetId(source.id)
      setReferenceTargetNodeId(source.id)
      setComposerNodeId(source.id)
      setSelectedNodeId(source.id)
      setSelectedNodeIds([source.id])
      setSelectedEdgeId(null)
      setContextMenu(null)
      setAddMenu(null)
      setNotice('请选择一张参考图片，上传后会与提示词一起生成')
      window.setTimeout(() => referenceUploadInputRef.current?.click(), 0)
      return
    }
    const modality: CanvasModality = action.startsWith('video-') ? 'video' : 'image'
    const node = blankNode('generation', source.x + source.width + 170, source.y)
    node.title = action === 'video-first-frame' ? '首帧生成视频'
        : action === 'video-first-last' ? '首尾帧生成视频' : '延长视频'
    node.settings = { modality, ratio: detail.ratio,
      ...(action === 'video-first-frame' ? { mode: 'first_frame' as CanvasMode } : {}),
      ...(action === 'video-first-last' ? { mode: 'first_last_frame' as CanvasMode } : {}),
      ...(action === 'video-extend' ? { mode: 'extend' as CanvasMode } : {}) }
    node.shot_id = source.shot_id
    // The source text is carried by the new edge and assembled by
    // promptForNode. Keeping a second copy here would submit the same prompt
    // twice when using the text-node quick action.
    node.prompt = ''
    // Seedance-style first/last-frame generation consumes image references.
    // When the source is a video, materialize its frame(s) as regular image
    // nodes first so the resulting graph remains editable and the validation
    // rules do not silently pass a video into an image-only mode.
    let referenceNodes: CanvasNode[] = []
    if ((action === 'video-first-frame' || action === 'video-first-last') && source.type === 'video') {
      if (!source.asset_id) {
        setNotice('该视频节点没有可提取的素材')
        return
      }
      setBusy(true)
      try {
        const frames = action === 'video-first-frame' ? ['first'] : ['first', 'last']
        const response = await api<{ assets: Asset[] }>(`/assets/${source.asset_id}/frames`, json('POST', { frames }))
        referenceNodes = response.assets.map((asset, index) => ({
          ...blankNode('image', source.x - 350, source.y + index * 290),
          title: index === 0 ? `${source.title || asset.filename} · 首帧` : `${source.title || asset.filename} · 尾帧`,
          asset_id: asset.id,
          shot_id: source.shot_id,
        }))
        await onRefresh()
      } catch (error) {
        showError(error)
        return
      } finally {
        setBusy(false)
      }
    }
    changeGraph((current) => ({
      ...current,
      nodes: [...current.nodes, ...referenceNodes, node],
      edges: [...current.edges,
        ...(referenceNodes.length ? referenceNodes.map((reference) => ({ id: crypto.randomUUID(), source: reference.id, target: node.id }))
          : [{ id: crypto.randomUUID(), source: source.id, target: node.id }])],
    }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
    
    
    setNotice(`已创建${node.title}节点，请选择模型并确认参数`)
    setComposerNodeId(node.id)
  }, [busy, changeGraph, detail, models, providers, onRefresh, showError])
  const selectNodeForView = useCallback((id: string) => {
    setComposerNodeId(id)
    setSelectedNodeId(id)
    setSelectedNodeIds([id])
    setSelectedEdgeId(null)
    
    
  }, [])
  const fitNodeToImage = useCallback((id: string, assetId: string, width: number, height: number) => {
    changeGraph(current => {
      const node = current.nodes.find(item => item.id === id)
      if (!node || node.type !== 'generation' || visualNodeAsset(node, detail)?.id !== assetId) return current
      const size = fitImageNode(node, { width, height })
      return size === node ? current : { ...current, nodes: current.nodes.map(item => item.id === id ? { ...item, ...size } : item) }
    })
  }, [changeGraph, detail])
  const flowNodes = useMemo<FlowNode[]>(() => (graph?.nodes || []).map((node) => {
    const displayedAsset = visualNodeAsset(node, detail)
    const { width, height } = nodeSize(node, displayedAsset)
    return {
      id: node.id, type: 'studio', position: { x: node.x, y: node.y },
      // These cards have explicit persisted sizes. React Flow does not read CSS
      // styles when checking dimensions, and rebuilding a controlled node without
      // `measured` discards its handle bounds. Preserve both on every graph update
      // so selecting, editing, autosaving or polling jobs cannot hide the cards.
      width, height, measured: { width, height }, style: { width, height },
      selected: node.id === selectedNodeId || selectedNodeIds.includes(node.id),
      data: { node, asset: displayedAsset, profile: detail.visual_profiles?.find(item => item.id === node.settings.visual_profile_id), shot: shotMap.get(node.shot_id || ''),
      job: jobMap.get(node.job_id || ''), model: modelMap.get(node.model_id || ''),
      videoQuickModes: [...new Set(availableModels.filter(model => model.modality === 'video').flatMap(model => supportedModes(model)))],
      imageEditingModels: availableModels.filter(model => model.modality === 'image' && ['image', 'images', 'image_references'].some(field => usesModelParameter(model, field))).map(model => model.id),
      promptText: graph ? promptForNode(node, graph, detail.shots, detail.script) : '',
      modelOptions: availableModels.filter((model) => {
        const desiredModality = node.settings.modality || (node.type === 'image' ? 'image' : node.type === 'video' ? 'video' : undefined)
        return !desiredModality || model.modality === desiredModality
      })
        .map((model) => ({ value: model.id, label: model.name })),
      busy, onPromptChange: editNodePrompt,
      onTextChange: (id: string, value: string) => updateNodeById(id, { text: value }),
      onTextDocumentChange: (id: string, text: string, document: JSONContent) => changeGraph(current => ({
        ...current, nodes: current.nodes.map(item => item.id === id
          ? { ...item, text, settings: { ...item.settings, text_document: document } } : item),
      })),
      onModelChange: selectNodeModel,
      onSettingsChange: updateNodeSettingsById,
      onOpenSettings: selectNodeForView,
      onRun: (id: string) => { setComposerNodeId(id); setSelectedNodeId(id); setSelectedNodeIds([id]); setSelectedEdgeId(null); setPendingRunNodeId(id) },
      onTryAction: tryNodeAction,
      onImageSize: fitNodeToImage,
      scriptSceneCount: detail.script?.scenes?.length || 0,
      scriptDuration: detail.script?.scenes?.reduce((sum, scene) => sum + (scene.duration || 0), 0) || 0,
      scriptOutline: detail.script?.outline || '',
      scriptArtifacts: detail.script?.artifacts || [],
      scriptTitle: detail.name || '项目剧本',
      scriptUpdatedAt: scriptUpdatedLabel(detail),
      scriptExists: !!(detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length),
      onOpenScriptDirector: openScriptDirector,
      onOpenScriptCreator, onOpenScriptDocument },
    }
  }), [graph, selectedNodeId, selectedNodeIds, assetMap, shotMap, jobMap, modelMap, models, providers, busy, changeGraph, editNodePrompt, updateNodeById, updateNodeSettingsById, selectNodeModel, selectNodeForView, tryNodeAction, fitNodeToImage, detail, onNavigate, openScriptDirector, onOpenScriptCreator, onOpenScriptDocument])
  const automaticReferenceEdges = useMemo(() => graph ? automaticVisualReferenceEdges(graph, detail, models) : [], [graph, detail, models])
  const automaticReferenceEdgeIds = useMemo(() => new Set(automaticReferenceEdges.map(edge => edge.id)), [automaticReferenceEdges])
  const flowEdges = useMemo<Edge[]>(() => [...(graph?.edges || []), ...automaticReferenceEdges].map((edge) => {
    const automatic = automaticReferenceEdgeIds.has(edge.id)
    const selected = edge.id === selectedEdgeId
    const relatedNodeIds = new Set(selectedNodeIds)
    if (selectedNodeId) relatedNodeIds.add(selectedNodeId)
    const related = relatedNodeIds.has(edge.source) || relatedNodeIds.has(edge.target)
    return {
      ...edge,
      type: 'studio',
      data: { ...(edge as Edge & { data?: Record<string, unknown> }).data, related, visualBinding: automatic },
      selectable: !automatic,
      deletable: !automatic,
      ariaLabel: automatic ? '设定参考图连接，点击调整镜头视觉设定' : undefined,
      selected,
      animated: false,
      className: `pc-flow-edge${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}`,
      style: {
        stroke: selected ? '#a8d8e8' : related ? '#789bad' : '#526372',
        strokeWidth: selected ? 2.7 : related ? 2.2 : 1.6,
        opacity: showEdges ? 1 : 0,
        pointerEvents: showEdges ? 'auto' : 'none',
      },
    }
  }), [graph?.edges, automaticReferenceEdges, automaticReferenceEdgeIds, selectedEdgeId, selectedNodeId, selectedNodeIds, showEdges])
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId)
  const selectedProfile = detail.visual_profiles?.find(item => item.id === selectedNode?.settings.visual_profile_id)
  const inspectedProfile = detail.visual_profiles?.find(profile => profile.id === profileInspectorId)
  const inspectedProfileGenerating = !!inspectedProfile && (detail.asset_tasks.some(task => task.id === inspectedProfile.asset_task_id && task.status === 'generating')
    || visualBoardJobs(inspectedProfile, detail.jobs).some(job => job.status === 'queued' || job.status === 'running'))
  const profileJobs = selectedProfile ? visualBoardJobs(selectedProfile, detail.jobs) : []
  const profileCandidates = profileJobs.filter(job => job.status === 'succeeded').map(job => assetMap.get(job.result_asset_id || '')).filter((asset): asset is Asset => !!asset && !selectedProfile?.archived_candidate_asset_ids?.includes(asset.id))
  const candidateProfile = detail.visual_profiles?.find(profile => profile.id === candidateProfileId)
  const candidateNode = graph?.nodes.find(node => node.settings.visual_profile_id === candidateProfileId)
  const candidateGenerating = detail.asset_tasks.find(task => task.id === candidateProfile?.asset_task_id)?.status === 'generating'
  const selectedBoardAsset = selectedNode && visualNodeAsset(selectedNode, detail)
  const selectedJob = jobMap.get(selectedNode?.job_id || '')
  const selectedNodeGenerating = selectedNode?.type === 'generation' && (selectedJob?.status === 'queued' || selectedJob?.status === 'running'
    || profileJobs.some(job => job.status === 'queued' || job.status === 'running'))
  const selectedShot = shotMap.get(selectedNode?.shot_id || '')
  const visualBindings = (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === selectedShot?.id)
  const missingReferences = useMemo(() => graph && selectedNode ? missingVisualReferences(graph, selectedNode.id, detail, models) : [], [graph, selectedNode, detail, models])
  const referenceReturnNode = graph?.nodes.find(node => node.id === referenceReturnNodeId)
  const visualReferenceMode = selectedNode?.settings.visual_reference_mode || 'profiles'
  const selectedModel = modelMap.get(selectedNode?.model_id || '')
  const composerModel = selectedModel
  const composerModelId = selectedNode?.model_id || ''
  const composerModality: CanvasModality | undefined = selectedNode?.type === 'generation'
    ? selectedNode.settings.modality || composerModel?.modality
    : composerModel?.modality || (selectedNode?.type === 'image' ? 'image' : selectedNode?.type === 'video' ? 'video' : undefined)
  const composerResolutions = modelResolutions(composerModel)
  const composerResolution = selectedNode?.settings.resolution || modelDefaultResolution(composerModel, composerResolutions)
  const composerImageDefaults = imageGenerationDefaults(composerModel)
  const composerClarities = composerModality === 'image' ? modelImageClarities(composerModel) : []
  const composerClarity = imageParameterValue(composerModel, 'clarity', selectedNode?.settings.clarity || composerImageDefaults.clarity)
  const composerQualities = composerModality === 'image' ? modelImageQualities(composerModel) : []
  const composerQuality = imageParameterValue(composerModel, 'quality', selectedNode?.settings.quality || composerImageDefaults.quality)
  const composerBackgrounds = composerModality === 'image' ? modelImageBackgrounds(composerModel) : []
  const composerBackground = imageParameterValue(composerModel, 'background', selectedNode?.settings.background || composerImageDefaults.background)
  const selectedMode = selectedNode?.settings.mode || 'text'
  const composerUsesReferenceRatio = composerModality === 'video' && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(selectedMode)
  const composerRatio = composerUsesReferenceRatio ? 'adaptive' : selectedNode?.settings.ratio
    || (composerModality === 'image' ? composerImageDefaults.ratio : detail.ratio)
  const incoming = graph?.edges.filter((edge) => edge.target === selectedNodeId)
    .map((edge) => {
      const source = graph.nodes.find(node => node.id === edge.source)
      return source && pinnedCanvasReference(source, edge.reference_asset_id)
    }).filter((node): node is CanvasNode => !!node) || []
  // A generator-to-result edge records provenance, not an extra reference.
  // Its latest result can change when rerun, while this media node stays fixed.
  const composerReferences = selectedNode?.type === 'generation'
    ? incoming : incoming.filter(node => node.type !== 'generation')
  const inputTexts = composerReferences
    .map((node) => node.type === 'project_script_ref' ? scriptPrompt(detail.script) : node.type === 'text' ? node.text.trim() : '')
    .filter(Boolean)
  const inputImages = [...new Map(composerReferences.map((node) => visualNodeAsset(node, detail, true))
    .filter((asset): asset is Asset => asset?.kind === 'image').map(asset => [asset.id, asset])).values()]
  const inputVideo = composerReferences.map((node) => assetMap.get(node.asset_id || '')).find((asset) => asset?.kind === 'video')
  const lastBoardReferences = visualJobRequest(selectedJob).reference_asset_ids
  const profileReferenceChanged = selectedProfile && selectedJob && Array.isArray(lastBoardReferences) &&
    !sameValue([...lastBoardReferences].sort(), inputImages.map(asset => asset.id).sort())
  const shotPrompt = selectedShot ? composerModality === 'video' ? shotVideoPrompt(selectedShot) : shotImagePrompt(selectedShot) : ''
  const sourcePrompt = selectedNode?.prompt.trim() && selectedNode.prompt !== selectedShot?.prompt ? selectedNode.prompt : shotPrompt
  const ownBasePrompt = selectedNode?.settings.prompt_is_final ? selectedNode.settings.prompt_base ?? sourcePrompt
    : selectedNode?.settings.prompt_override ? selectedNode.text : sourcePrompt || ''
  const compiledPrompt = [...inputTexts, ownBasePrompt].filter(Boolean).join('\n\n')
  // Drafts live on their node, including media nodes, so changing selection or
  // dismissing the toolbar never discards prompt/model edits.
  const resolutions = modelResolutions(selectedModel)
  const { min: durationMin, max: durationMax } = modelDurationBounds(selectedModel)
  const composerDuration = modelDuration(selectedModel, selectedNode?.settings.duration || selectedShot?.duration || 5)
  const promptBindings = [...visualBindings].sort((a, b) => {
    const left = `${a.kind}\0${a.name}\0${a.profile_id}`, right = `${b.kind}\0${b.name}\0${b.profile_id}`
    return left < right ? -1 : left > right ? 1 : 0
  })
  const preparedReferenceIds = inputImages.map(asset => asset.id)
  if (visualReferenceMode === 'profiles') for (const binding of promptBindings) {
    if (binding.board_asset_id && !preparedReferenceIds.includes(binding.board_asset_id)) preparedReferenceIds.push(binding.board_asset_id)
  }
  const promptImageMode = preparedReferenceIds.length ? 'reference' : 'text'
  const promptResolution = composerModel?.modality === 'image' ? imageRequestResolution(composerModel, composerResolution, { ratio: composerRatio, clarity: composerClarity, mode: promptImageMode }) || null : null
  const preferencePrompt = composerModel?.modality === 'image' ? imagePreferencePrompt(composerModel, compiledPrompt, {
    ratio: composerRatio, resolution: promptResolution, clarity: composerClarity, quality: composerQuality, background: composerBackground,
  }, promptImageMode) : composerModel?.modality === 'video' ? videoPreferencePrompt(compiledPrompt, selectedMode, composerDuration) : compiledPrompt
  const automaticPrompt = composerModel && composerModel.modality !== 'text'
    ? visualGenerationPrompt(preferencePrompt, promptBindings, preparedReferenceIds, visualReferenceMode) : preferencePrompt
  const composerPrompt = selectedProfile ? selectedNode?.text || '' : selectedNode?.type === 'text' ? selectedNode.text
    : selectedNode?.settings.prompt_is_final ? rebasePromptDraft(selectedNode.settings.prompt_template || '', selectedNode.text, automaticPrompt) : automaticPrompt
  const missingShotCount = detail.shots.filter((shot) => !graph?.nodes.some((node) =>
    node.type === 'generation' && node.shot_id === shot.id)).length
  const requestTemplate = JSON.stringify(selectedModel?.settings.request_template || {})
  const supportsAudio = selectedModel?.modality === 'video' && requestTemplate.includes('{{generate_audio}}')
  const supportsImageReferences = selectedModel?.modality === 'image' &&
    !imageReferenceConfigError(selectedModel.settings, 1, 'reference')
  const generationInputKey = JSON.stringify([selectedNode?.id, composerPrompt, selectedNode?.settings, composerModel,
    preparedReferenceIds, inputVideo?.id, promptBindings, selectedProfile, profileDraftDirty])
  const generationInputRef = useRef(generationInputKey)
  generationInputRef.current = generationInputKey
  useEffect(() => {
    setGenerationInfoOpen(false)
    setReview(null)
  }, [generationInputKey])

  useEffect(() => {
    if (viewMode !== 'canvas' || !graph?.nodes.length || initialViewApplied.current) return
    if (savedViewport) {
      initialViewApplied.current = true
      return
    }
    initialViewApplied.current = true
    const first = graph.nodes.find((node) => node.type === 'generation') || graph.nodes[0]
    const wide = (viewportRef.current?.clientWidth || 0) > 900
    void setCenter(first.x + first.width / 2 + (wide ? 210 : 0), first.y + first.height / 2,
      { zoom: 1, duration: 350 })
  }, [graph, savedViewport, setCenter, viewMode])

  useEffect(() => {
    if (viewMode !== 'canvas') return
    const viewport = viewportRef.current
    if (!viewport) return
    let previousWidth = viewport.clientWidth
    const observer = new ResizeObserver(() => {
      const width = viewport.clientWidth
      if (!width || !previousWidth) { previousWidth = width; return }
      const changedLayout = (width > 900) !== (previousWidth > 900) || Math.abs(width - previousWidth) / previousWidth > 0.25
      previousWidth = width
      if (!changedLayout || !initialViewApplied.current) return
      const nodes = queueRef.current?.graph.nodes || []
      const focus = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.type === 'generation') || nodes[0]
      if (focus) void setCenter(focus.x + focus.width / 2 + (width > 900 ? 210 : 0),
        focus.y + focus.height / 2, { zoom: 1, duration: 0 }).then(() => setComposerRevealKey(key => key + 1))
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [setCenter, selectedNodeId, viewMode])

  function centerPosition() {
    if (viewMode === 'storyboard') {
      const offset = (graph?.nodes.length || 0) * 30
      return { x: 80 + offset, y: 80 + offset }
    }
    const bounds = viewportRef.current?.getBoundingClientRect()
    const position = bounds ? screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      : { x: 80, y: 80 }
    return { x: Math.round(position.x - 140), y: Math.round(position.y - 100) }
  }

  function addNode(type: 'text' | 'generation', modality?: CanvasModality, at?: { x: number; y: number }) {
    const position = at || centerPosition()
    const node = blankNode(type, position.x, position.y)
    if (type === 'text') node.settings.text_mode = 'write'
    if (type === 'generation' && modality) {
      node.settings.modality = modality
      node.title = modality === 'image' ? '图片生成' : '视频生成'
    }
    if (type === 'generation') node.settings.ratio = modality === 'image' ? '9:16' : detail.ratio
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
    
    
    if (viewMode === 'storyboard') setStoryboardSelectedId(node.id)
    setComposerNodeId(node.id)
    setAddMenu(null)
  }

  function ensureProjectScriptCard() {
    if (!graph) return
    const existing = graph.nodes.find(node => node.type === 'project_script_ref')
    if (existing) {
      setSelectedNodeId(existing.id)
      setSelectedNodeIds([existing.id])
      setSelectedEdgeId(null)
      return
    }
    const position = centerPosition()
    const node = { ...blankNode('project_script_ref', position.x, position.y), title: detail.name || '项目剧本' }
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
  }

  function openScriptDirector(focusArtifact: ScriptAction = 'all', context?: string) {
    setContextMenu(null)
    setAddMenu(null)
    ensureProjectScriptCard()
    if (onOpenDirectorPanel) onOpenDirectorPanel(focusArtifact, context)
    else onOpenScriptCreator()
  }

  function changeComposerModel(modelId: string) {
    if (selectedNode) selectNodeModel(selectedNode.id, modelId)
  }

  function submitComposer() {
    if (!selectedNode || busy || previewingRef.current || submittingRef.current) return
    if (selectedProfile) { setPendingRunNodeId(selectedNode.id); return }
    const prompt = composerPrompt.trim()
    if (!prompt) { setNotice('请先输入提示词'); return }
    if (selectedNode?.type === 'generation') {
      editNodePrompt(selectedNode.id, prompt, { base: ownBasePrompt, template: automaticPrompt })
      if (composerModelId !== (selectedNode.model_id || '')) selectNodeModel(selectedNode.id, composerModelId)
      setPendingRunNodeId(selectedNode.id)
      return
    }

    const model = availableModels.find((item) => item.id === composerModelId)
    const modality: CanvasModality = model?.modality || 'image'
    const position = { x: selectedNode.x + selectedNode.width + 170, y: selectedNode.y }
    const nextResolutions = modelResolutions(model)
    const nextRatios = modelRatios(model)
    const node: CanvasNode = {
      ...blankNode('generation', position.x, position.y),
      title: modality === 'video' ? '视频生成' : '图片生成',
      text: prompt,
      shot_id: selectedNode.shot_id || assetMap.get(selectedNode.asset_id || '')?.shot_id || null,
      model_id: model?.id || null,
      settings: { modality, prompt_override: true, prompt_is_final: true, prompt_base: ownBasePrompt, prompt_template: automaticPrompt,
        visual_reference_mode: visualReferenceMode, ratio: nextRatios.includes(composerRatio) ? composerRatio : nextRatios[0],
        resolution: nextResolutions.includes(composerResolution) ? composerResolution : nextResolutions[0] || null,
        clarity: modality === 'image'
          ? imageParameterValue(model, 'clarity', composerClarity)
          : undefined,
        quality: modality === 'image'
          ? imageParameterValue(model, 'quality', composerQuality)
          : undefined,
        background: modality === 'image'
          ? imageParameterValue(model, 'background', composerBackground)
          : undefined,
        duration: modality === 'video' ? composerDuration : undefined, generate_audio: selectedNode.settings.generate_audio,
        candidate_count: selectedNode.settings.candidate_count,
        draft: selectedNode.settings.draft,
        mode: modality === 'video' && selectedNode.type === 'image' && supportedModes(model).includes('first_frame')
          ? 'first_frame' : selectedNode.settings.mode || 'text' },
    }
    const sourceIds = [...new Set([selectedNode.id, ...composerReferences.map(source => source.id)])]
    const edges = sourceIds.map(source => {
      const reference = source === selectedNode.id ? selectedNode : composerReferences.find(item => item.id === source)
      const asset = reference && !reference.settings.visual_profile_id ? visualNodeAsset(reference, detail) : undefined
      return { id: crypto.randomUUID(), source, target: node.id,
        ...(asset?.kind === 'image' ? { reference_asset_id: asset.id } : {}) }
    })
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node], edges: [...current.edges, ...edges] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
    
    setPendingRunNodeId(node.id)
    setComposerNodeId(node.id)
  }

  function showSidebarAssets(kind: 'all' | Asset['kind'] = 'all', targetId?: string) {
    setComposerExpanded(false)
    setReferenceTargetNodeId(targetId || null)
    setSidebarTab('assets')
    setSidebarAssetFilter(kind)
    setSidebarOpen(true)
    setAddMenu(null)
  }

  function focusSidebarNode(id: string) {
    const node = queueRef.current?.graph.nodes.find((item) => item.id === id)
    if (!node) return
    setComposerExpanded(false)
    if (viewMode === 'storyboard') pendingCanvasFocus.current = id
    setViewMode('canvas')
    setComposerNodeId(id)
    setSelectedNodeId(id)
    setSelectedNodeIds([id])
    setSelectedEdgeId(null)
    if (pendingCanvasFocus.current) return
    const wide = (viewportRef.current?.clientWidth || 0) > 900
    // Reveal after the explicit navigation finishes. A concurrent centering
    // animation otherwise overwrites the composer's safe viewport.
    void setCenter(node.x + node.width / 2 + (wide ? 80 : 0), node.y + node.height / 2, { zoom: 1, duration: 0 })
      .then(() => setComposerRevealKey(key => key + 1))
  }

  function addAssetNode(asset: Asset, at?: { x: number; y: number }) {
    if (asset.kind !== 'image' && asset.kind !== 'video' && asset.kind !== 'text') return
    const target = referenceTargetNodeId ? queueRef.current?.graph.nodes.find(node => node.id === referenceTargetNodeId) : undefined
    if (target && !at) {
      const currentGraph = queueRef.current!.graph
      if (currentGraph.edges.some(edge => edge.target === target.id && currentGraph.nodes.some(node => node.id === edge.source && node.asset_id === asset.id))) {
        setNotice('该素材已连接到当前节点')
        return
      }
      const existingReference = currentGraph.nodes.find(node => node.type === asset.kind && node.asset_id === asset.id)
      const reference = existingReference || { ...blankNode(asset.kind, target.x - 540, target.y), title: asset.filename,
        text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id, shot_id: asset.shot_id }
      const nearbyCount = currentGraph.edges.filter(edge => edge.target === target.id).length
      if (!existingReference) reference.y += nearbyCount * 100
      changeGraph(current => ({ ...current, nodes: [
        ...current.nodes.map(node => node.id === target.id && !node.settings.visual_profile_id && !node.shot_id && asset.shot_id ? { ...node, shot_id: asset.shot_id } : node),
        ...(!existingReference ? [reference] : []),
      ],
        edges: [...current.edges, { id: crypto.randomUUID(), source: reference.id, target: target.id }] }))
      setSelectedNodeId(target.id)
      setSelectedNodeIds([target.id])
      setSelectedEdgeId(null)
      setNotice('已添加参考并连接到当前节点')
      return
    }
    const position = at || centerPosition()
    const node = { ...blankNode(asset.kind, position.x, position.y), title: asset.filename,
      text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id, shot_id: asset.shot_id }
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)
    
    
  }

  function openProfileSidebar() {
    setViewMode('canvas'); setSidebarOpen(true); setSidebarTab('profiles'); setReferenceTargetNodeId(null)
  }

  function openProfileInspector(profile: VisualProfile) {
    setProfileInspectorId(profile.id)
    setComposerNodeId(null)
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
  }

  function addProfileToCanvas(profile: VisualProfile, targetId = referenceTargetNodeId) {
    const current = queueRef.current?.graph
    if (!current) return
    const target = current.nodes.find(node => node.id === targetId)
    if (target?.settings.visual_profile_id === profile.id) { setNotice('设定不能引用自身'); return }
    if (target && !profile.board_asset_id) { setNotice(`请先确认 ${profile.name} 的设定图`); return }
    const position = target ? { x: target.x - 540, y: target.y } : centerPosition()
    const model = availableModels.find(item => item.modality === 'image')
    const added = addVisualProfileNode(current, profile, { ...blankNode('generation', position.x, position.y), model_id: model?.id || null,
      job_id: detail.asset_tasks.find(task => task.id === profile.asset_task_id)?.generation_job_id || null,
      settings: { modality: 'image', ...imageGenerationDefaults(model), resolution: modelDefaultResolution(model, modelResolutions(model)) || null } })
    const alreadyConnected = target && [...current.edges, ...automaticVisualReferenceEdges(added.graph, detail, models)]
      .some(edge => edge.source === added.nodeId && edge.target === target.id)
    changeGraph(() => target && !alreadyConnected ? { ...added.graph, edges: [...added.graph.edges, { id: crypto.randomUUID(), source: added.nodeId, target: target.id }] } : added.graph)
    setProfileInspectorId(null)
    setViewMode('canvas')
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
    if (target) { setReferenceTargetNodeId(null); setComposerNodeId(target.id); setComposerRevealKey(key => key + 1); setNotice(alreadyConnected ? '该设定图已连接' : '已连接设定参考图'); return }
    focusSidebarNode(added.nodeId)
  }

  function locateMissingReference(reference: MissingVisualReference) {
    const current = queueRef.current?.graph
    if (!current || !selectedNode) return
    if (reference.action === 'bindings') { setVisualPreparationOpen(true); return }
    const profile = detail.visual_profiles?.find(item => item.id === reference.profileId)
    if (!profile) { setVisualPreparationOpen(true); return }
    // Preserve the original target when following a chain of missing references.
    if (!referenceReturnNodeId || !current.nodes.some(node => node.id === referenceReturnNodeId)) setReferenceReturnNodeId(selectedNode.id)
    setNotice(null); setProfileInspectorId(null); setReferenceTargetNodeId(null)
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
    if (reference.nodeId) focusSidebarNode(reference.nodeId)
    else addProfileToCanvas(profile, null)
  }

  async function useProfileBoard(profile: VisualProfile, assetId: string) {
    await api(`/visual-profiles/${profile.id}`, json('PATCH', { board_asset_id: assetId, expected_revision: profile.revision }))
    changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.settings.visual_profile_id === profile.id ? { ...node, asset_id: assetId } : node) }))
    await onRefresh(); setNotice('已确认使用此设定图')
  }

  async function confirmProfileBoard(assetId: string) {
    if (!selectedProfile || busy || selectedNodeGenerating) return
    setBusy(true)
    try {
      await useProfileBoard(selectedProfile, assetId)
    } catch (issue) { showError(issue) } finally { setBusy(false) }
  }

  async function uploadProfileBoard(file: File) {
    if (!selectedProfile || !selectedNode || busy || selectedNodeGenerating) return
    const nodeId = selectedNode.id
    setBusy(true)
    try {
      const payload = new FormData(); payload.append('file', file)
      const asset = await api<Asset>(`/projects/${detail.id}/assets`, { method: 'POST', body: payload })
      updateNodeById(nodeId, { asset_id: asset.id }); await onRefresh()
      setNotice('图片已上传，确认后将作为设定图')
    } catch (issue) { showError(issue) } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!graph) return
    const open = () => {
      const pending = window.sessionStorage.getItem(`visual-canvas-open:${detail.id}`)
      if (!pending) return
      window.sessionStorage.removeItem(`visual-canvas-open:${detail.id}`)
      openProfileSidebar()
      try {
        const ids = JSON.parse(pending) as string[]
        for (const id of ids) {
          const profile = detail.visual_profiles?.find(item => item.id === id)
          if (profile) addProfileToCanvas(profile, null)
        }
      } catch { setNotice('设定画布入口参数无效') }
    }
    open(); window.addEventListener('visual-canvas-open', open)
    return () => window.removeEventListener('visual-canvas-open', open)
  }, [graph, detail.visual_profiles, detail.id])

  function importShots() {
    if (!detail.shots.length) { setNotice('项目还没有分镜，请先在剧本或时间线中创建'); return }
    autoImportAttempted.current = true
    try { window.localStorage.setItem(autoImportKey(detail.id), '1') } catch { /* Import still proceeds. */ }
    let addedShots = 0
    let addedJobs = 0
    let addedAssets = 0
    let missingReferences = 0
    let hitLimit = false
    let firstImported: CanvasNode | null = null
    changeGraph((current) => {
      const nodes = [...current.nodes]
      const edges = [...current.edges]
      let y = nodes.length ? Math.max(...nodes.map((node) => node.y + node.height)) + 100 : 80
      for (const shot of detail.shots) {
        const job = detail.jobs.find((item) => item.job_type === 'generation' && item.shot_id === shot.id)
        const imageModel = availableModels.find(model => model.modality === 'image')
        let settings: CanvasNode['settings'] = { ...(!job ? { modality: 'image' as const, ...imageGenerationDefaults(imageModel) } : {}), duration: shot.duration, ratio: detail.ratio,
          group_id: shot.id,
          group_title: `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}` }
        let referenceIds: string[] = []
        let restoredDraft = ''
        let prompt = job && modelMap.get(job.model_id || '')?.modality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot)
        if (job) {
          try {
            const request = JSON.parse(job.request) as Partial<GenerationRequest>
            settings = { ...settings, mode: request.mode, resolution: request.resolution, clarity: request.clarity,
              quality: request.quality, background: request.background, duration: request.duration,
              ratio: request.ratio, generate_audio: request.generate_audio, draft: request.draft,
              visual_reference_mode: request.visual_reference_mode,
              reference_video_url: request.reference_video_url }
            referenceIds = Array.isArray(request.reference_asset_ids)
              ? request.reference_asset_ids.filter((id): id is string => typeof id === 'string') : []
            prompt = request.visual_source_prompt ?? (typeof request.prompt === 'string' ? request.prompt : prompt)
            if (request.prompt_is_final && typeof request.prompt === 'string') {
              restoredDraft = request.prompt
              settings = { ...settings, prompt_is_final: true, prompt_override: true, prompt_base: prompt,
                prompt_template: request.prompt_template || '' }
            }
          } catch { /* Keep the shot defaults for legacy jobs. */ }
        }
        const shotGenerations = nodes.filter((node) => node.type === 'generation' && node.shot_id === shot.id)
        let generation = job ? shotGenerations.find((node) => node.job_id === job.id) : shotGenerations[0]
        const newGeneration = !generation
        if (!generation) {
          if (nodes.length >= 500) { hitLimit = true; break }
          const rowY = shotGenerations.length
            ? Math.max(...nodes.filter((node) => node.shot_id === shot.id).map((node) => node.y + node.height)) + 80 : y
          generation = { ...blankNode('generation', 80, rowY), title: shot.title, shot_id: shot.id,
            model_id: job ? job.model_id : imageModel?.id || null, job_id: job?.id || null, prompt, text: restoredDraft,
            asset_id: job?.result_asset_id || null, settings }
          nodes.push(generation)
          if (!firstImported) firstImported = generation
          if (shotGenerations.length) addedJobs += 1
          else addedShots += 1
        }
        let leftY = generation.y
        if (newGeneration) for (const referenceId of referenceIds) {
          const asset = detail.assets.find((item) => item.id === referenceId && item.kind === 'image')
          if (!asset) { missingReferences += 1; continue }
          let source = nodes.find((node) => node.asset_id === asset.id && node.type === 'image')
          if (!source) {
            if (nodes.length >= 500) { hitLimit = true; break }
            source = { ...blankNode('image', generation.x - 350, leftY), title: asset.filename,
              asset_id: asset.id, shot_id: asset.shot_id }
            nodes.push(source)
            addedAssets += 1
            leftY += source.height + 22
          }
          if (edges.length < 1000 && !edges.some((edge) => edge.source === source.id && edge.target === generation.id)) {
            edges.push({ id: crypto.randomUUID(), source: source.id, target: generation.id, reference_asset_id: asset.id })
          }
        }
        const assets = detail.assets.filter((asset) => asset.kind !== 'audio' && asset.source !== 'export' &&
          !referenceIds.includes(asset.id) && (asset.shot_id === shot.id || asset.id === shot.selected_asset_id))
        let rightY = Math.max(generation.y, ...nodes.filter((node) => node.shot_id === shot.id &&
          (node.type === 'image' || node.type === 'video' || node.type === 'text')).map((node) => node.y + node.height + 22))
        for (const asset of assets) {
          const kind = asset.kind
          if (kind !== 'image' && kind !== 'video' && kind !== 'text') continue
          let media = nodes.find((node) => node.asset_id === asset.id && node.type === kind)
          if (!media) {
            if (nodes.length >= 500) { hitLimit = true; break }
            media = { ...blankNode(kind, generation.x + generation.width + 170, rightY), title: asset.filename, asset_id: asset.id,
              shot_id: shot.id, text: kind === 'text' ? asset.text || '' : '' }
            nodes.push(media)
            addedAssets += 1
            rightY += media.height + 25
            if (asset.id === job?.result_asset_id && edges.length < 1000) {
              edges.push({ id: crypto.randomUUID(), source: generation.id, target: media.id })
            }
          } else {
            const mediaId = media.id
            if (newGeneration && asset.id === job?.result_asset_id && edges.length < 1000 &&
              !edges.some((edge) => edge.source === generation.id && edge.target === mediaId)) {
              edges.push({ id: crypto.randomUUID(), source: generation.id, target: mediaId })
            }
          }
        }
        y = Math.max(y, generation.y + nodeSize(generation, assetMap.get(generation.asset_id || '')).height + 60, rightY + 60, leftY + 60)
      }
      return addedShots || addedJobs || addedAssets ? { ...current, nodes, edges } : current
    })
    const added = addedShots + addedJobs + addedAssets
    setNotice(added ? `已补入 ${addedShots} 个分镜、${addedJobs} 个新任务、${addedAssets} 个素材${missingReferences ? `；${missingReferences} 张旧参考图已不存在` : ''}${hitLimit ? '；已达到画布容量上限' : ''}` : '分镜、任务和素材已同步')
    if (firstImported && viewMode === 'canvas' && initialViewApplied.current) {
      const node: CanvasNode = queueRef.current?.graph.nodes.find(item => item.id === firstImported!.id) || firstImported
      const wide = (viewportRef.current?.clientWidth || 0) > 900
      void setCenter(node.x + node.width / 2 + (wide ? 210 : 0), node.y + node.height / 2,
        { zoom: 1, duration: 350 })
    }
  }

  function organizeShotGroups() {
    if (!detail.shots.length) { setNotice('项目还没有分镜，请先在剧本中创建'); return }
    const titles = new Map(detail.shots.map((shot) => [shot.id,
      `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}`]))
    let changed = 0
    changeGraph((current) => {
      const nodes = current.nodes.map((node) => {
        if (node.type !== 'generation' || !node.shot_id) return node
        const title = titles.get(node.shot_id)
        if (!title || (node.settings.group_id === node.shot_id && node.settings.group_title === title)) return node
        changed += 1
        return { ...node, settings: { ...node.settings, group_id: node.shot_id, group_title: title } }
      })
      return changed ? { ...current, nodes } : current
    })
    setNotice(changed ? `已按镜头整理 ${changed} 个生成节点` : '生成节点已经按镜头整理')
  }

  function organizeCanvas() {
    if (!graph?.nodes.length) { setNotice('画布还没有节点'); return }
    let moved = 0
    changeGraph((current) => {
      const nodeMap = new Map(current.nodes.map((node) => [node.id, node]))
      const groupOrder = new Map<string, number>()
      for (const node of current.nodes) {
        const shot = node.shot_id ? shotMap.get(node.shot_id) : undefined
        groupOrder.set(node.settings.group_id || node.shot_id || `ungrouped:${node.type}`, shot?.position ?? 999999)
      }
      const groups = new Map<string, CanvasNode[]>()
      for (const node of current.nodes) {
        const key = node.settings.group_id || node.shot_id || `ungrouped:${node.type}`
        const items = groups.get(key) || []
        items.push(node)
        groups.set(key, items)
      }
      const orderedGroups = [...groups.entries()].sort((a, b) => (groupOrder.get(a[0]) ?? 999999) - (groupOrder.get(b[0]) ?? 999999))
      const positions = new Map<string, { x: number; y: number }>()
      let groupY = 80
      for (const [, group] of orderedGroups) {
        const lanes: Record<'source' | 'generation' | 'result', CanvasNode[]> = { source: [], generation: [], result: [] }
        for (const node of group) {
          const hasIncomingGeneration = current.edges.some((edge) => edge.target === node.id && nodeMap.get(edge.source)?.type === 'generation')
          const hasOutgoingGeneration = current.edges.some((edge) => edge.source === node.id && nodeMap.get(edge.target)?.type === 'generation')
          const lane = node.type === 'generation' ? 'generation' : hasIncomingGeneration ? 'result' : hasOutgoingGeneration ? 'source' : 'source'
          lanes[lane].push(node)
        }
        const sourceWidth = Math.max(360, ...lanes.source.map(node => nodeSize(node, assetMap.get(node.asset_id || '')).width))
        const generationWidth = Math.max(440, ...lanes.generation.map(node => nodeSize(node, assetMap.get(node.asset_id || '')).width))
        const laneX = { source: 80, generation: 80 + sourceWidth + 120, result: 80 + sourceWidth + generationWidth + 240 }
        let groupHeight = 0
        for (const lane of (['source', 'generation', 'result'] as const)) {
          let laneY = groupY
          for (const node of lanes[lane]) {
            positions.set(node.id, { x: laneX[lane], y: laneY })
            laneY += nodeSize(node, assetMap.get(node.asset_id || '')).height + 80
          }
          groupHeight = Math.max(groupHeight, laneY - groupY)
        }
        groupY += Math.max(220, groupHeight) + 70
      }
      const nodes = current.nodes.map((node) => {
        const position = positions.get(node.id)
        if (!position || (position.x === node.x && position.y === node.y)) return node
        moved += 1
        return { ...node, x: position.x, y: position.y }
      })
      return moved ? { ...current, nodes } : current
    })
    if (!moved) { setNotice('节点已经是整理后的布局'); return }
    setNotice(`已整理 ${moved} 个节点，按输入、生成和结果重新排列`)
    if (viewMode === 'canvas') window.setTimeout(() => { void fitView({ padding: 0.16, duration: 320 }) }, 50)
  }

  useEffect(() => {
    if (!graph || graph.nodes.length || !detail.shots.length) return
    if (autoImportAttempted.current) return
    try { if (window.localStorage.getItem(autoImportKey(detail.id))) return } catch { /* Continue once in memory. */ }
    importShots()
  }, [graph, detail.id, detail.shots.length])

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const selectionChanges = changes.filter((change): change is Extract<NodeChange<FlowNode>, { type: 'select' }> => change.type === 'select')
    if (selectionChanges.length) {
      // Selection is controlled in one direction only: React Flow reports
      // select changes here and we mirror them into the canvas selection state.
      // Keeping a second onSelectionChange writer lets an older non-empty
      // selection race a click and can repeatedly rebuild the whole node tree.
      const selected = new Map(selectionChanges.map((change) => [change.id, change.selected]))
      const sourceNodes = queueRef.current?.graph.nodes || graph?.nodes || []
      const ids = sourceNodes.filter((node) => selected.get(node.id) ??
        (node.id === selectedNodeId || selectedNodeIds.includes(node.id))).map((node) => node.id)
      setSelectedNodeIds((current) => sameStringList(current, ids) ? current : ids)
      setSelectedNodeId((current) => {
        const next = current && ids.includes(current) ? current : ids[0] || null
        return current === next ? current : next
      })
    }
    if (!changes.some((change) => change.type === 'position' || change.type === 'dimensions' || change.type === 'remove')) return
    const removedIds = new Set(changes.flatMap((change) => change.type === 'remove' ? [change.id] : []))
    const positionChanges = changes.filter((change): change is Extract<NodeChange<FlowNode>, { type: 'position' }> => change.type === 'position')
    if (positionChanges.some(change => change.dragging)) setComposerNodeId(null)
    // Apply only the changed fields to the latest graph. A resize observation
    // may arrive after an add/edit but before its render, so filtering the live
    // graph through the older flowNodes snapshot can delete newly added nodes
    // or restore stale positions and sizes.
    const nextNodes = (current: CanvasGraph): CanvasNode[] => {
      const movedPositions = new Map(positionChanges.flatMap((change) => change.position ? [[change.id, change.position] as const] : []))
      const groupedMoves = new Map<string, { dx: number; dy: number }>()
      for (const change of positionChanges) {
        const node = current.nodes.find((item) => item.id === change.id)
        if (!node?.settings.group_id || !change.position || (change.dragging !== true && !dragSnapshotRef.current)) continue
        const sameGroupMoves = positionChanges.filter((item) => current.nodes.find((candidate) => candidate.id === item.id)?.settings.group_id === node.settings.group_id)
        if (sameGroupMoves.length === 1) groupedMoves.set(node.settings.group_id, { dx: change.position.x - node.x, dy: change.position.y - node.y })
      }
      return current.nodes.filter((node) => !removedIds.has(node.id)).map((node) => {
      let next = node
      for (const change of changes) {
        if (!('id' in change) || change.id !== node.id) continue
        if (change.type === 'position' && change.position) {
          next = { ...next, x: change.position.x, y: change.position.y }
        } else if (change.type === 'dimensions' && change.dimensions) {
          next = { ...next, width: change.dimensions.width || next.width, height: change.dimensions.height || next.height }
        }
      }
      const groupMove = node.settings.group_id ? groupedMoves.get(node.settings.group_id) : undefined
      if (groupMove && !movedPositions.has(node.id)) next = { ...next, x: next.x + groupMove.dx, y: next.y + groupMove.dy }
      return next
    }) }
    const nextEdges = (current: CanvasGraph): CanvasEdge[] => current.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target))
    const isDragging = positionChanges.some((change) => change.dragging)
    const queue = queueRef.current
    // During a drag, update the controlled graph without adding history entries
    // or scheduling a request for every pointer frame. The final event commits
    // one checkpoint and one save.
    if (queue && positionChanges.length && (isDragging || dragSnapshotRef.current)) {
      if (!dragSnapshotRef.current) dragSnapshotRef.current = cloneGraph(queue.graph)
      const next = { ...queue.graph, nodes: nextNodes(queue.graph), edges: nextEdges(queue.graph) }
      queue.graph = next
      setGraph(next)
      if (isDragging) return
      const snapshot = dragSnapshotRef.current
      dragSnapshotRef.current = null
      if (snapshot && !sameValue({ nodes: snapshot.nodes, edges: snapshot.edges }, { nodes: next.nodes, edges: next.edges })) {
        const history = historyRef.current
        history.past.push(snapshot)
        if (history.past.length > 100) history.past.shift()
        history.future = []
        queue.serial += 1
        keepDraft(queue)
        setHistoryTick((value) => value + 1)
        scheduleSave(queue)
      }
      return
    }
    changeGraph((current) => ({
      ...current,
      nodes: nextNodes(current),
      edges: nextEdges(current),
    }))
  }

  function onEdgesChange(changes: EdgeChange<Edge>[]) {
    if (!changes.some((change) => change.type === 'remove')) return
    const updated = applyEdgeChanges(changes, flowEdges)
    const ids = new Set(updated.map((edge) => edge.id))
    changeGraph((current) => ({ ...current, edges: current.edges.filter((edge) => ids.has(edge.id)) }))
  }

  function isValidConnection(connection: Connection | Edge): boolean {
    if (!graph || !connection.source || !connection.target || connection.source === connection.target) return false
    const source = graph.nodes.find((node) => node.id === connection.source)
    const target = graph.nodes.find((node) => node.id === connection.target)
    if (!source || !target) return false
    const handoff = imageVideoConnection(source, target, detail, models)
    if (handoff) {
      // A reverse drag still means the image feeds the video. Check the
      // normalized pair so it cannot create a backwards or duplicate edge.
      const existing = graph.edges.find(edge => edge.source === handoff.source.id && edge.target === handoff.target.id)
      return !existing || existing.reference_asset_id !== handoff.asset.id
    }
    if ([...graph.edges, ...automaticReferenceEdges].some((edge) => edge.source === source.id && edge.target === target.id)) return false
    // The project script is a standalone creative brief. It is intentionally
    // kept out of the graph so its content can be used from the director panel
    // without adding a visible or persisted connection.
    if (source.type === 'project_script_ref' || target.type === 'project_script_ref') return false
    if (target.settings.visual_profile_id) return source.type === 'image' || source.type === 'text' || source.settings.modality === 'image'
    if (source.settings.visual_profile_id && target.type === 'generation') return true
    if (source.type === 'generation' && target.type === 'generation' && visualNodeAsset(source, detail)?.kind === 'image') return true
    return (target.type === 'generation' && source.type !== 'generation') ||
      (source.type === 'generation' && target.type !== 'generation')
  }

  function onConnect(connection: Connection) {
    if (!isValidConnection(connection) || !connection.source || !connection.target) return
    const source = graph?.nodes.find(node => node.id === connection.source)
    const target = graph?.nodes.find(node => node.id === connection.target)
    const handoff = source && target && imageVideoConnection(source, target, detail, models)
    if (handoff) {
      try {
        changeGraph(current => connectImageVideoHandoff(current, handoff, detail, availableModels, crypto.randomUUID()))
        setSelectedNodeId(handoff.target.id); setSelectedNodeIds([handoff.target.id]); setSelectedEdgeId(null)
        setComposerNodeId(handoff.target.id); setContextMenu(null); setAddMenu(null)
        setNotice('已连接到现有视频节点，当前图片已固定为输入参考；检查视频提示词后生成')
      } catch (issue) { showError(issue) }
      return
    }
    const asset = source && !source.settings.visual_profile_id ? visualNodeAsset(source, detail) : undefined
    changeGraph((current) => ({ ...current, edges: [...current.edges,
      { id: crypto.randomUUID(), source: connection.source!, target: connection.target!,
        ...(asset?.kind === 'image' && target?.type === 'generation' ? { reference_asset_id: asset.id } : {}) }] }))
  }

  function openAutomaticReference(edge: Edge) {
    setSelectedNodeId(edge.target); setSelectedNodeIds([edge.target]); setSelectedEdgeId(null)
    setComposerNodeId(edge.target); setAddMenu(null); setContextMenu(null)
    setVisualPreparationOpen(true)
  }

  async function deleteSelection(nodeId: string | null = null, edgeId: string | null = selectedEdgeId) {
    const nodeIds = nodeId ? [nodeId] : selectedNodeIds.length ? selectedNodeIds : selectedNodeId ? [selectedNodeId] : []
    if (!nodeIds.length && !edgeId) return
    const ok = await confirm({
      title: nodeIds.length > 1 ? `移除 ${nodeIds.length} 个节点` : '移除画布内容',
      message: nodeIds.length > 1 ? '原始分镜、素材和任务记录仍会保留。' : '原始分镜、素材和任务记录仍会保留。',
      confirmLabel: '移除', danger: true,
    })
    if (!ok) return
    const nodeIdSet = new Set(nodeIds)
    changeGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !nodeIdSet.has(node.id)),
      edges: current.edges.filter((edge) => edge.id !== edgeId && !nodeIdSet.has(edge.source) && !nodeIdSet.has(edge.target)),
    }))
    if (!nodeId || nodeIdSet.has(selectedNodeId || '')) setSelectedNodeId(null)
    setSelectedNodeIds([])
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null)
    setContextMenu(null)
  }

  function commitHistoryGraph(snapshot: CanvasGraph) {
    const queue = queueRef.current
    if (!queue || queue.id !== detail.id) return
    const next = { ...cloneGraph(snapshot), revision: queue.graph.revision }
    if (sameValue({ nodes: next.nodes, edges: next.edges }, { nodes: queue.graph.nodes, edges: queue.graph.edges })) return
    queue.graph = next
    queue.serial += 1
    keepDraft(queue)
    setGraph(next)
    scheduleSave(queue)
    setHistoryTick((value) => value + 1)
  }

  function undoGraph() {
    const history = historyRef.current
    const queue = queueRef.current
    if (!queue || !history.past.length) return
    const previous = history.past.pop()!
    history.future.push(cloneGraph(queue.graph))
    if (history.future.length > 100) history.future.shift()
    commitHistoryGraph(previous)
  }

  function redoGraph() {
    const history = historyRef.current
    const queue = queueRef.current
    if (!queue || !history.future.length) return
    const next = history.future.pop()!
    history.past.push(cloneGraph(queue.graph))
    if (history.past.length > 100) history.past.shift()
    commitHistoryGraph(next)
  }

  function duplicateSelection(sourceId = selectedNodeId) {
    if (queueRef.current?.graph.nodes.find(node => node.id === sourceId)?.settings.visual_profile_id) {
      setNotice('此设定已在画布中；不同服装或状态请新增设定版本'); setContextMenu(null); return
    }
    if (!sourceId) return
    const source = graph?.nodes.find((node) => node.id === sourceId)
    if (!source || source.type === 'project_script_ref') return
    const duplicateId = crypto.randomUUID()
    changeGraph((current) => {
      const currentSource = current.nodes.find((node) => node.id === sourceId)
      if (!currentSource) return current
      const duplicate: CanvasNode = {
        ...currentSource,
        id: duplicateId,
        x: currentSource.x + 48,
        y: currentSource.y + 48,
        title: `${currentSource.title || '节点'} 副本`,
        settings: { ...currentSource.settings, group_id: null, group_title: null },
      }
      // A copied generator keeps its prompt and model but starts as a fresh
      // candidate. Result assets and old task ids belong to the source node.
      if (duplicate.type === 'generation') {
        duplicate.job_id = null
        duplicate.asset_id = null
      }
      const incoming = current.edges
        .filter((edge) => edge.target === sourceId)
        .map((edge) => ({ id: crypto.randomUUID(), source: edge.source, target: duplicateId }))
      return { ...current, nodes: [...current.nodes, duplicate], edges: [...current.edges, ...incoming] }
    })
    setSelectedNodeId(duplicateId)
    setSelectedNodeIds([duplicateId])
    setSelectedEdgeId(null)
    
    
    setContextMenu(null)
  }

  function openContextMenu(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, target: { nodeId?: string; edgeId?: string; position?: { x: number; y: number } }) {
    event.preventDefault()
    event.stopPropagation()
    const bounds = viewportRef.current?.getBoundingClientRect()
    if (!bounds) return
    if (target.nodeId) {
      setSelectedNodeId(target.nodeId)
      setSelectedNodeIds([target.nodeId])
      setSelectedEdgeId(null)
      
    } else if (target.edgeId) {
      setSelectedEdgeId(target.edgeId)
      setSelectedNodeId(null)
      setSelectedNodeIds([])
      
    } else {
      setSelectedNodeId(null)
      setSelectedNodeIds([])
      setSelectedEdgeId(null)
      setAddMenu(null)
      setContextMenu(null)
    }
    setContextMenu({
      x: Math.max(10, Math.min(event.clientX - bounds.left, Math.max(10, bounds.width - 248))),
      y: Math.max(10, Math.min(event.clientY - bounds.top, Math.max(10, bounds.height - 300))),
      ...target,
    })
    setAddMenu(null)
  }

  async function prepareGeneration(): Promise<GenerationReview | undefined> {
    if (previewingRef.current) return
    if (!selectedNode || selectedNode.type !== 'generation') return
    if (selectedNodeGenerating) { setNotice('此节点正在生成，请等待任务完成'); return }
    const shot = selectedShot
    const model = selectedModel
    if (graph && fixedReferenceAsset(graph, selectedNode.id, detail.assets).some(reference => !reference.asset)) {
      setNotice('固定的参考图片已不存在，请移除该参考并重新选择；不会自动替换为新的生成结果')
      return
    }
    if (!model || !availableModels.some((item) => item.id === model.id)) {
      setNotice('请先选择已启用的模型')
      return
    }
    if (missingReferences.length) {
      setNotice(`请先补齐参考图：${missingReferences.map(reference => reference.name).join('、')}，点击「待补齐参考图」中的对应项定位处理`)
      return
    }
    if (selectedProfile) {
      if (profileDraftDirty && profileInspectorId === selectedProfile.id) { setNotice('请先保存右侧编辑的设定，再生成信息图'); return }
      previewingRef.current = true; setBusy(true)
      try {
        const references = visualBoardReferences(queueRef.current!.graph, selectedNode.id, detail)
        const input = { ...references, prompt_append: [...inputTexts, selectedNode.text.trim()].filter(Boolean).join('\n\n') }
        const preview = await api<VisualBoardPreview>(`/visual-profiles/${selectedProfile.id}/board-preview`, json('POST', {
          ...input, model_id: model.id, expected_revision: selectedProfile.revision,
        }))
        const ratio = composerRatio
        const clarity = composerClarity
        const resolution = imageRequestResolution(model, composerResolution, { ratio, clarity, mode: preview.mode }) || null
        const ratioIssue = imageRatioError(model, resolution || '', ratio, preview.mode)
        if (ratioIssue) throw new Error(ratioIssue)
        const referenceIssue = imageReferenceConfigError(model.settings, preview.reference_asset_ids.length, preview.mode)
        if (referenceIssue) throw new Error(referenceIssue)
        const quality = composerQuality
        const background = composerBackground
        return { candidateCount: selectedNode.settings.candidate_count || 1, nodeId: selectedNode.id, board: { profile: selectedProfile, preview, input },
          model, provider: providers.find(provider => provider.id === model.provider_id),
          shot: { title: `${selectedProfile.name} · ${selectedProfile.variant}` }, referenceNames: preview.reference_names,
          request: { shot_id: '', model_id: model.id, mode: preview.mode, prompt: imagePreferencePrompt(model, preview.prompt, { ratio, resolution, clarity, quality, background }, preview.mode),
            reference_asset_ids: preview.reference_asset_ids, reference_video_url: null, ratio, resolution, clarity, quality, background,
            duration: 1, generate_audio: false, draft: false } }
      } catch (issue) { showError(issue) } finally { previewingRef.current = false; setBusy(false) }
      return
    }
    const missingProfileReference = composerReferences.find(node => node.settings.visual_profile_id && !visualNodeAsset(node, detail, true))
    if (missingProfileReference) { setNotice(`请先确认 ${missingProfileReference.title} 的设定图`); return }
    if (!composerPrompt.trim() || !compiledPrompt.trim() && !selectedNode.settings.prompt_is_final) { setNotice('请输入提示词或连接文本节点'); return }
    const mode = model.modality === 'video' ? selectedMode : 'text'
    if (model.modality === 'video' && !supportedModes(model).includes(mode)) {
      setNotice('当前模型不支持所选模式')
      return
    }
    if (inputImages.length && model.modality === 'video' && !['first_frame', 'first_last_frame', 'reference'].includes(mode)) {
      setNotice('连接的参考图未被当前模式使用，请选择首帧、首尾帧或参考生成')
      return
    }
    if (inputImages.length && model.modality === 'image') {
      const referenceIssue = imageReferenceConfigError(model.settings, inputImages.length, 'reference')
      if (referenceIssue) { setNotice(referenceIssue); return }
    }
    if (inputImages.length && model.modality === 'text') {
      setNotice('文本模型不会使用参考图片，请移除图片连接')
      return
    }
    if (inputVideo && model.modality !== 'video') {
      setNotice('当前模型不会使用视频参考，请移除视频连接')
      return
    }
    if (inputVideo && model.modality === 'video' && !['reference', 'edit', 'extend'].includes(mode)) {
      setNotice('连接的视频未被当前模式使用，请选择参考生成、编辑或延长')
      return
    }
    if (mode === 'first_frame' && inputImages.length !== 1) { setNotice('首帧模式需要连接 1 张图片'); return }
    if (mode === 'first_last_frame' && inputImages.length !== 2) { setNotice('首尾帧模式需要连接 2 张图片'); return }
    const videoUrl = ['reference', 'edit', 'extend'].includes(mode)
      ? (selectedNode.settings.reference_video_url || inputVideo?.remote_url || '').trim() : ''
    if (['edit', 'extend'].includes(mode) && !videoUrl) { setNotice('编辑或延长模式需要参考视频地址'); return }
    if (mode === 'reference' && !inputImages.length && !videoUrl && !(visualBindings.length && visualReferenceMode === 'profiles')) { setNotice('参考生成需要图片连接或视频地址'); return }
    // Image generation has no duration parameter. Keep the request value
    // neutral so a newly created image task does not look like a 5-second
    // video in the confirmation dialog or create an unnecessarily long shot.
    const duration = model.modality === 'video' ? composerDuration : shot?.duration || 1
    if (!Number.isInteger(duration) || duration < durationMin || duration > durationMax) {
      setNotice(`生成时长需在 ${durationMin}–${durationMax} 秒之间`)
      return
    }
    const ratio = ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode)
      ? 'adaptive' : composerRatio
    const clarity = model.modality === 'image'
      ? composerClarity : null
    const baseResolution = selectedNode.settings.resolution || (model.modality === 'text' ? null : modelDefaultResolution(model, resolutions) || null)
    const imageMode = preparedReferenceIds.length ? 'reference' : 'text'
    const resolution = model.modality === 'image' ? (imageRequestResolution(model, baseResolution || '', { ratio, clarity: clarity || '', mode: imageMode }) || null) : baseResolution
    if (model.modality === 'image') {
      const ratioError = imageRatioError(model, resolution || '', ratio, imageMode)
      if (ratioError) { setNotice(ratioError); return }
    }
    const supportedResolutions = modelResolutions(model)
    if (model.modality !== 'text' && resolution && !supportedResolutions.includes(resolution)) {
      setNotice('当前模型不支持所选分辨率，请重新选择')
      return
    }
    if (!['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode) && !modelRatios(model).includes(ratio)) {
      setNotice('当前模型不支持所选画幅，请重新选择')
      return
    }
    const quality = model.modality === 'image' ? composerQuality : null
    const background = model.modality === 'image' ? composerBackground : null
    const request: GenerationRequest = {
      shot_id: shot?.id || '', model_id: model.id,
      visual_reference_mode: visualReferenceMode,
      prompt: composerPrompt.trim(), prompt_is_final: true, prompt_template: automaticPrompt,
      ...(compiledPrompt.trim() ? { visual_source_prompt: compiledPrompt.trim() } : {}),
      mode: model.modality === 'image' ? imageMode : mode,
      reference_asset_ids: inputImages.map((asset) => asset.id),
      reference_video_url: videoUrl || null, resolution, clarity, quality, background, duration, ratio,
      generate_audio: supportsAudio ? selectedNode.settings.generate_audio ?? true : false,
      draft: model.settings.supports_draft === true && selectedNode.settings.draft === true,
    }
    previewingRef.current = true
    setBusy(true)
    try {
      const prepared = await api<GenerationRequest>(`/projects/${detail.id}/generate/preview`, json('POST', { ...request, shot_id: request.shot_id || null }))
      return { candidateCount: Math.max(1, Math.min(4, Math.trunc(selectedNode.settings.candidate_count || 1))),
        nodeId: selectedNode.id, request: { ...prepared, shot_id: prepared.shot_id || '' }, shot: shot || { title: selectedNode.title || `镜头 ${String(detail.shots.length + 1).padStart(2, '0')}` }, model,
        provider: providers.find((provider) => provider.id === model.provider_id),
        referenceNames: prepared.reference_asset_ids.map(id => assetMap.get(id)?.filename || id) }
    } catch (issue) { showError(issue) }
    finally { previewingRef.current = false; setBusy(false) }
  }

  async function showGenerationInfo() {
    if (generationInfoOpen) { setGenerationInfoOpen(false); return }
    if (busy || previewingRef.current || submittingRef.current) return
    setReview(null)
    setGenerationInfoOpen(true)
    const inputKey = generationInputKey
    const prepared = await prepareGeneration()
    if (inputKey !== generationInputRef.current) return
    if (prepared) setReview(prepared)
    else setGenerationInfoOpen(false)
  }

  async function runGeneration() {
    if (previewingRef.current || submittingRef.current) return
    setGenerationInfoOpen(false)
    setReview(null)
    const inputKey = generationInputKey
    const prepared = await prepareGeneration()
    if (inputKey !== generationInputRef.current) { setNotice('生成配置已更新，请重新点击生成'); return }
    if (prepared) await submitGeneration(prepared, inputKey)
  }

  async function submitGeneration(current: GenerationReview, inputKey: string) {
    if (submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    const candidateCount = current.candidateCount
    try {
      const queue = queueRef.current
      if (!queue) throw new Error('画布还未载入')
      await flush(queue)
      if (inputKey !== generationInputRef.current) throw new Error('生成配置已更新，请重新点击生成')
      let request = current.request
      if (current.board) {
        const { profile, preview, input } = current.board
        const generated = await api<{ job: Job; jobs: Job[]; task: AssetTask }>(`/visual-profiles/${profile.id}/generate`, json('POST', {
          ...input, model_id: request.model_id, expected_revision: profile.revision, reference_signature: preview.reference_signature,
          prompt: request.prompt, ratio: request.ratio, resolution: request.resolution, clarity: request.clarity,
          quality: request.quality, background: request.background, candidate_count: candidateCount,
        }))
        updateNodeById(current.nodeId, { job_id: generated.job.id })
        setReview(null); setNotice(candidateCount > 1 ? `已加入 ${candidateCount} 个设定图候选生成任务` : '设定图生成任务已加入队列')
        await flush(queue); await onRefresh(); return
      }
      if (!request.shot_id) {
        const shot = await api<Shot>(`/projects/${detail.id}/shots`, json('POST', {
          title: current.shot.title, prompt: (request.visual_source_prompt || request.prompt).slice(0, 10000), duration: request.duration,
        }))
        request = { ...request, shot_id: shot.id }
        updateNodeById(current.nodeId, { shot_id: shot.id })
        await flush(queue)
      }
      let latestJob: Job | null = null
      for (let index = 0; index < candidateCount; index += 1) {
        latestJob = await api<Job>(`/projects/${detail.id}/generate`, json('POST', request))
      }
      if (!latestJob) throw new Error('没有创建生成任务')
      changeGraph((graphValue) => ({ ...graphValue, nodes: graphValue.nodes.map((node) => node.id === current.nodeId
        ? { ...node, job_id: latestJob!.id, asset_id: null } : node) }))
      setReview(null)
      setNotice(candidateCount > 1 ? `已加入 ${candidateCount} 个候选生成任务` : '生成任务已加入队列')
      try { await flush(queue) } catch { setNotice('任务已入队，但画布关联保存失败；任务记录中仍可查看') }
      await onRefresh()
    } catch (error) {
      setReview(null)
      setNotice(`提交未完成或状态未确认，请查看任务记录。${error instanceof Error ? error.message : String(error)}`)
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!pendingRunNodeId || pendingRunNodeId !== selectedNodeId || !selectedNode) return
    setPendingRunNodeId(null)
    void runGeneration()
  }, [pendingRunNodeId, selectedNodeId, selectedNode])

  async function uploadCanvasFiles(files: FileList | File[], at?: { x: number; y: number }) {
    if (!files.length || busy) return
    setBusy(true)
    try {
      const uploaded: Asset[] = []
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        uploaded.push(await api<Asset>(`/projects/${detail.id}/assets`, { method: 'POST', body: form }))
      }
      await onRefresh()
      const position = at || centerPosition()
      const referenceCount = referenceTargetNodeId ? uploaded.filter((asset) => asset.kind === 'image').length : 0
      uploaded.forEach((asset, index) => {
        if (asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'text') {
          const asReference = referenceTargetNodeId && asset.kind === 'image'
          addAssetNode(asset, asReference ? undefined : { x: position.x + index * 30, y: position.y + index * 30 })
        }
      })
      setNotice(referenceCount ? `已添加 ${referenceCount} 张参考图片` : `已导入 ${uploaded.length} 个素材`)
    } catch (error) { showError(error) }
    finally {
      setBusy(false)
      setReferenceUploadTargetId(null)
      if (uploadInputRef.current) uploadInputRef.current.value = ''
      if (referenceUploadInputRef.current) referenceUploadInputRef.current.value = ''
    }
  }

  function openCanvasUpload() {
    if (referenceTargetNodeId) {
      setReferenceUploadTargetId(referenceTargetNodeId)
      referenceUploadInputRef.current?.click()
      return
    }
    uploadInputRef.current?.click()
  }

  function dropOnCanvas(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (viewMode === 'storyboard') {
      if (event.dataTransfer.files.length) { void uploadCanvasFiles(event.dataTransfer.files); return }
      const storyboardAsset = assetMap.get(event.dataTransfer.getData('application/x-canvas-asset'))
      if (storyboardAsset) addAssetNode(storyboardAsset)
      return
    }
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    if (event.dataTransfer.files.length) { void uploadCanvasFiles(event.dataTransfer.files, at); return }
    const asset = assetMap.get(event.dataTransfer.getData('application/x-canvas-asset'))
    if (asset) addAssetNode(asset, at)
  }

  async function inspectConflict() {
    const queue = queueRef.current
    if (!queue) return
    try {
      const remote = normalizeGraph(await api<CanvasGraph>(`/projects/${queue.id}/canvas`))
      setConflictReview(mergeGraphs(queue.base, queue.graph, remote))
    } catch (error) { showError(error) }
  }

  async function applyMerge() {
    const queue = queueRef.current
    if (!queue || !conflictReview) return
    queue.base = conflictReview.remote
    queue.graph = conflictReview.merged
    queue.serial += 1
    queue.conflict = false
    keepDraft(queue)
    setGraph(queue.graph)
    setConflictReview(null)
    try { await flush(queue) } catch (error) { showError(error) }
  }

  async function useServerVersion() {
    const queue = queueRef.current
    if (!queue || !conflictReview) return
    const ok = await confirm({ title: '加载服务器版本', message: '当前未保存的画布修改将被丢弃。', confirmLabel: '加载并丢弃', danger: true })
    if (!ok) return
    queue.base = conflictReview.remote
    queue.graph = conflictReview.remote
    queue.serial = 0
    queue.savedSerial = 0
    queue.conflict = false
    clearDraft(queue.id)
    setGraph(queue.graph)
    setSaveState('saved')
    setConflictReview(null)
    setSelectedNodeId(null)
    setSelectedNodeIds([])
  }

  const sidebarNodes = useMemo(() => {
    const query = sidebarSearch.trim().toLocaleLowerCase()
    return (graph?.nodes || [])
      .filter((node) => sidebarFilter === 'all' || node.type === sidebarFilter
        || (sidebarFilter === 'text' && node.type === 'project_script_ref'))
      .filter((node) => {
        if (!query) return true
        const shotTitle = detail.shots.find((shot) => shot.id === node.shot_id)?.title || ''
        return `${node.title} ${node.text} ${shotTitle}`.toLocaleLowerCase().includes(query)
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
  }, [detail.shots, graph?.nodes, sidebarFilter, sidebarSearch])
  const sidebarAssets = useMemo(() => {
    const query = sidebarAssetSearch.trim().toLocaleLowerCase()
    return detail.assets
      .filter((asset) => (asset.saved || !!referenceTargetNodeId) && asset.source !== 'export')
      .filter((asset) => sidebarAssetFilter === 'all' || asset.kind === sidebarAssetFilter)
      .filter((asset) => {
        if (!query) return true
        const shotTitle = detail.shots.find((shot) => shot.id === asset.shot_id)?.title || ''
        return `${asset.filename} ${shotTitle}`.toLocaleLowerCase().includes(query)
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [detail.assets, detail.shots, sidebarAssetFilter, sidebarAssetSearch, referenceTargetNodeId])
  const contextNode = contextMenu?.nodeId ? graph?.nodes.find((node) => node.id === contextMenu.nodeId) : undefined
  const contextEdge = contextMenu?.edgeId ? graph?.edges.find((edge) => edge.id === contextMenu.edgeId) : undefined

  async function openModelsSafely() {
    const queue = queueRef.current
    try {
      if (queue) await flush(queue)
      onOpenModels()
    } catch (error) { showError(error) }
  }

  useEffect(() => {
    if (!selectedNodeId) return
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.react-flow__node-toolbar, .react-flow__node, .pc-text-editor-modal-root, .pc-context-menu, .pc-add-menu, [data-canvas-overlay], .mantine-Select-dropdown, .mantine-Combobox-dropdown, [role="listbox"], .mantine-Modal-root, [role="menu"]')) return
      setSelectedNodeId(null)
      setSelectedNodeIds([])
      setSelectedEdgeId(null)
      setAddMenu(null)
      setContextMenu(null)
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  }, [selectedNodeId])

  useEffect(() => {
    if (referenceTargetNodeId && selectedNodeId !== referenceTargetNodeId) setReferenceTargetNodeId(null)
  }, [selectedNodeId, referenceTargetNodeId])

  return <div className="project-canvas"
    onKeyDown={(event) => {
      // A dialog owns its shortcuts. Closing a nested candidate/setting modal
      // must not also clear the canvas selection and its composer underneath.
      if (event.target instanceof Element && event.target.closest('.mantine-Modal-root')) {
        event.stopPropagation()
        return
      }
      // Keep canvas shortcuts close to the interaction surface. Editing controls
      // own Backspace/Delete so removing a selected node never truncates text.
      if (event.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); event.stopPropagation(); return }
        if (addMenu) { setAddMenu(null); event.stopPropagation(); return }
        setSelectedNodeId(null)
        setSelectedNodeIds([])
        setSelectedEdgeId(null)
        event.stopPropagation()
        return
      }
      if (isCanvasEditingTarget(event.target)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && selectedNodeId) {
        event.preventDefault()
        event.stopPropagation()
        duplicateSelection()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedNodeId || selectedEdgeId)) {
        event.preventDefault()
        event.stopPropagation()
        deleteSelection()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) redoGraph()
        else undoGraph()
      }
    }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes('application/x-canvas-asset')) event.preventDefault() }}
    onDrop={dropOnCanvas}>
    <input ref={uploadInputRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4" multiple hidden onChange={(event) => { if (event.currentTarget.files) void uploadCanvasFiles(event.currentTarget.files) }} />
    <input ref={referenceUploadInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden
      onChange={(event) => { if (event.currentTarget.files && referenceUploadTargetId) void uploadCanvasFiles(event.currentTarget.files) }} />
    <div className="pc-toolbar">
      <div className="pc-canvas-nav">
        <Tooltip label="项目"><ActionIcon variant="subtle" aria-label="返回项目" onClick={() => onNavigate('projects')}><FolderOpen size={18} /></ActionIcon></Tooltip>
        {projectNameEditing
          ? <input ref={projectNameInputRef} className="pc-project-name-input" aria-label="编辑项目名称" value={projectNameDraft}
            onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
            onBlur={() => void saveProjectName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void saveProjectName() }
              if (event.key === 'Escape') { event.preventDefault(); cancelProjectNameEdit() }
            }} />
          : <button type="button" className="pc-project-name" title="编辑项目名称" onClick={() => setProjectNameEditing(true)}>{detail.name}</button>}
        <Menu shadow="md" width={172} position="bottom-start"><Menu.Target><ActionIcon variant="subtle" aria-label="切换创作页面"><ChevronDown size={16} /></ActionIcon></Menu.Target><Menu.Dropdown>
          <Menu.Item leftSection={<FolderOpen size={15} />} onClick={() => onNavigate('projects')}>项目</Menu.Item>
          <Menu.Item leftSection={<ScrollText size={15} />} onClick={() => openScriptDirector('all')}>剧本创作</Menu.Item>
          <Menu.Item leftSection={<ImageIcon size={15} />} onClick={openProfileSidebar}>视觉设定</Menu.Item>
          <Menu.Item leftSection={<Film size={15} />} onClick={() => onNavigate('studio')} disabled={!detail.shots.length}>剪辑与导出</Menu.Item>
          <Menu.Item leftSection={<Layers3 size={15} />} onClick={() => onNavigate('assets')}>资产</Menu.Item>
          <Menu.Item leftSection={<Clock3 size={15} />} onClick={() => onNavigate('jobs')}>任务记录</Menu.Item>
          <Menu.Item leftSection={<Settings2 size={15} />} onClick={() => void openModelsSafely()}>模型设置</Menu.Item>
        </Menu.Dropdown></Menu>
      </div>
      <div className="pc-mode-switch" role="tablist" aria-label="创作视图">
        <button type="button" role="tab" aria-selected={viewMode === 'canvas'} className={viewMode === 'canvas' ? 'is-active' : ''}
          onClick={() => { setContextMenu(null); setAddMenu(null); setViewMode('canvas') }}><MousePointer2 size={15} />工作流</button>
        <button type="button" role="tab" aria-selected={viewMode === 'storyboard'} className={viewMode === 'storyboard' ? 'is-active' : ''}
          onClick={() => { setContextMenu(null); setAddMenu(null); setViewMode('storyboard') }}><LayoutGrid size={15} />故事板</button>
      </div>
      <div className="pc-save-status" role="status">
        {saveState === 'saved' ? <><Check size={14} />已保存</>
          : saveState === 'saving' || saveState === 'pending' ? <><LoaderCircle size={14} className="pc-spin" />{saveState === 'saving' ? '保存中' : '待保存'}</>
            : <button onClick={() => saveState === 'conflict' ? void inspectConflict() : queueRef.current && void flush(queueRef.current).catch(showError)}><CircleAlert size={14} />{saveState === 'conflict' ? '版本冲突 · 合并' : '保存失败 · 重试'}</button>}
      </div>
    </div>
    <div className={`pc-body ${viewMode === 'storyboard' ? 'pc-body-storyboard' : sidebarOpen ? 'pc-body-sidebar-open' : ''}`}>
      {viewMode === 'canvas' && sidebarOpen && <aside className="pc-canvas-sidebar" aria-label="画布节点与素材" data-canvas-overlay>
        <div className="pc-sidebar-tabs" role="tablist" aria-label="画布侧栏">
          <button type="button" role="tab" aria-selected={sidebarTab === 'canvas'} className={sidebarTab === 'canvas' ? 'active' : ''}
            onClick={() => setSidebarTab('canvas')}><Layers3 size={15} />画布 <span>{graph?.nodes.length || 0}</span></button>
          <button type="button" role="tab" aria-selected={sidebarTab === 'assets'} className={sidebarTab === 'assets' ? 'active' : ''}
            onClick={() => setSidebarTab('assets')}><ImageIcon size={15} />资产 <span>{detail.assets.filter((asset) => (asset.saved || !!referenceTargetNodeId) && asset.source !== 'export').length}</span></button>
          <button type="button" role="tab" aria-selected={sidebarTab === 'profiles'} className={sidebarTab === 'profiles' ? 'active' : ''}
            onClick={() => setSidebarTab('profiles')}><ImageIcon size={15} />设定</button>
          <Tooltip label="收起侧栏"><ActionIcon variant="subtle" aria-label="收起画布侧栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={16} /></ActionIcon></Tooltip>
        </div>
        {sidebarTab === 'canvas' ? <>
          <div className="pc-sidebar-tools">
            <TextInput size="xs" aria-label="搜索画布节点" placeholder="搜索节点、镜头或内容" value={sidebarSearch}
              leftSection={<Search size={14} />} onChange={(event) => setSidebarSearch(event.currentTarget.value)} />
            <div className="pc-sidebar-filter-line"><SlidersHorizontal size={13} /><CanvasSelect aria-label="节点类型筛选" value={sidebarFilter}
              data={[{ value: 'all', label: '所有节点' }, { value: 'generation', label: '生成节点' }, { value: 'text', label: '文本节点' }, { value: 'project_script_ref', label: '项目剧本' }, { value: 'image', label: '图片节点' }, { value: 'video', label: '视频节点' }]}
              onChange={(value) => value && setSidebarFilter(value as typeof sidebarFilter)} /><span>{sidebarNodes.length}</span></div>
          </div>
          <div className="pc-sidebar-list">
            {sidebarNodes.map((node) => {
              const nodeAsset = assetMap.get(node.asset_id || '')
              const nodeShot = shotMap.get(node.shot_id || '')
              const icon = node.type === 'project_script_ref' ? <ScrollText size={15} /> : node.type === 'generation' ? <WandSparkles size={15} /> : node.type === 'image' ? <ImageIcon size={15} />
                : node.type === 'video' ? <Film size={15} /> : <FileText size={15} />
              return <div className={`pc-sidebar-node ${selectedNodeId === node.id ? 'is-selected' : ''}`} key={node.id}
                onClick={() => focusSidebarNode(node.id)} onDoubleClick={() => focusSidebarNode(node.id)}>
                <span className="pc-sidebar-node-icon">{icon}</span><span className="pc-sidebar-node-copy"><strong title={node.title || nodeAsset?.filename || '未命名节点'}>{node.title || nodeAsset?.filename || '未命名节点'}</strong>
                  <small>{node.type === 'project_script_ref' ? '项目级剧本' : node.type === 'generation' ? (nodeShot ? `镜头 ${String(nodeShot.position + 1).padStart(2, '0')} · ${nodeShot.title}` : '待配置生成') : node.type === 'text' ? '文本 / 提示词' : nodeAsset?.filename || '素材节点'}</small></span>
                <Menu shadow="md" width={150} position="right-start"><Menu.Target><ActionIcon variant="subtle" className="pc-sidebar-more" aria-label={`更多操作：${node.title || '节点'}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={16} /></ActionIcon></Menu.Target><Menu.Dropdown>
                  <Menu.Item leftSection={<LocateFixed size={14} />} onClick={() => focusSidebarNode(node.id)}>定位节点</Menu.Item>
                  <Menu.Item leftSection={<Settings2 size={14} />} onClick={() => selectNodeForView(node.id)}>选择节点</Menu.Item>
                  <Menu.Item leftSection={<Plus size={14} />} onClick={() => duplicateSelection(node.id)}>复制节点</Menu.Item>
                  <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => deleteSelection(node.id, null)}>删除节点</Menu.Item>
                </Menu.Dropdown></Menu>
              </div>
            })}
            {!sidebarNodes.length && <div className="pc-sidebar-empty"><Layers3 size={20} /><p>{sidebarSearch ? '没有匹配的节点' : '画布还没有节点'}</p><button type="button" onClick={() => openScriptDirector('all')}>剧本创作</button></div>}
          </div>
        </> : sidebarTab === 'profiles' ? <>
          <div className="pc-sidebar-tools">
            <TextInput size="xs" aria-label="搜索视觉设定" placeholder="搜索名称或版本" value={profileSearch} leftSection={<Search size={14} />} onChange={event => setProfileSearch(event.currentTarget.value)} />
            <div className="pc-sidebar-filter-pills" role="group" aria-label="设定类型筛选">{(['all', 'character', 'location', 'prop'] as const).map(kind => <button type="button" key={kind} className={profileFilter === kind ? 'active' : ''} onClick={() => setProfileFilter(kind)}>{kind === 'all' ? '全部' : kind === 'character' ? '人物' : kind === 'location' ? '场景' : '道具'}</button>)}</div>
            <Button variant="default" size="xs" leftSection={<WandSparkles size={14} />} onClick={() => setVisualPreparationOpen(true)}>整理 / 管理设定</Button>
            {referenceTargetNodeId && <span className="pc-profile-reference-target">为 {selectedNode?.title} 选择参考图</span>}
          </div>
          <div className="pc-sidebar-list">
            {(detail.visual_profiles || []).filter(profile => (profileFilter === 'all' || profile.kind === profileFilter) && `${profile.name} ${profile.variant}`.toLocaleLowerCase().includes(profileSearch.trim().toLocaleLowerCase())).map(profile => {
              const board = assetMap.get(profile.board_asset_id || '')
              const inCanvas = graph?.nodes.some(node => node.settings.visual_profile_id === profile.id)
              return <div className={`pc-sidebar-node pc-sidebar-profile ${(profileInspectorId || selectedProfile?.id) === profile.id ? 'is-selected' : ''}`} key={profile.id}>
                <button type="button" className="pc-profile-list-open" aria-label={`查看设定：${profile.name} · ${profile.variant}`} onClick={() => openProfileInspector(profile)}>
                  <span className="pc-profile-list-thumb">{board ? <img src={board.url} alt={`${profile.name} 设定图`} /> : <ImageIcon size={18} />}</span>
                  <span className="pc-sidebar-node-copy"><strong>{profile.name}</strong><small>{profile.variant} · v{profile.revision}</small><small>{profile.board_asset_id ? '已确认' : '待图'}{inCanvas ? ' · 已在画布' : ''}</small></span>
                </button>
                <Tooltip label={referenceTargetNodeId ? '添加为参考' : inCanvas ? '定位节点' : '加入画布'}><ActionIcon variant="subtle" aria-label={`${referenceTargetNodeId ? '添加设定参考' : inCanvas ? '定位设定节点' : '加入设定画布'}：${profile.name} · ${profile.variant}`} onClick={() => addProfileToCanvas(profile)}>{inCanvas && !referenceTargetNodeId ? <LocateFixed size={15} /> : <Plus size={15} />}</ActionIcon></Tooltip>
                <Tooltip label="管理候选"><ActionIcon variant="subtle" aria-label={`管理候选：${profile.name} · ${profile.variant}`} onClick={() => setCandidateProfileId(profile.id)}><Layers3 size={15} /></ActionIcon></Tooltip>
              </div>
            })}
            {!detail.visual_profiles?.length && <div className="pc-sidebar-empty"><ImageIcon size={22} /><p>暂无视觉设定</p><button type="button" onClick={() => setVisualPreparationOpen(true)}>整理设定草稿</button></div>}
          </div>
        </> : <>
          <div className="pc-sidebar-tools">
            <TextInput size="xs" aria-label="搜索资产" placeholder="搜索素材、镜头或文件名" value={sidebarAssetSearch}
              leftSection={<Search size={14} />} onChange={(event) => setSidebarAssetSearch(event.currentTarget.value)} />
            <div className="pc-sidebar-filter-pills" role="group" aria-label="资产类型筛选">
              {(['all', 'image', 'video', 'audio', 'text'] as const).map((kind) => <button type="button" key={kind} className={sidebarAssetFilter === kind ? 'active' : ''}
                onClick={() => setSidebarAssetFilter(kind)}>{kind === 'all' ? '全部' : kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文本'}</button>)}
            </div>
          </div>
          <div className="pc-sidebar-list pc-sidebar-assets">
            {sidebarAssets.map((asset) => <div className="pc-sidebar-asset" key={asset.id} draggable onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-canvas-asset', asset.id)
            }}>
              <div className="pc-sidebar-asset-thumb">{asset.kind === 'audio' ? <Music2 size={18} /> : <NodeMedia asset={asset} />}</div>
              <div className="pc-sidebar-asset-copy"><strong title={asset.filename}>{asset.filename}</strong><small>{asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '文本'} · {asset.source === 'generated' ? '生成' : '导入'}</small></div>
              {asset.kind === 'audio' ? <Tooltip label="音频素材可在时间线中使用"><span className="pc-sidebar-audio-mark"><Music2 size={14} /></span></Tooltip> : <Tooltip label={referenceTargetNodeId ? '添加为当前节点的参考' : '添加到画布'}><ActionIcon variant="subtle" aria-label={`将 ${asset.filename} ${referenceTargetNodeId ? '添加为参考' : '添加到画布'}`} onClick={() => addAssetNode(asset)}><Plus size={16} /></ActionIcon></Tooltip>}
            </div>)}
            {!sidebarAssets.length && <div className="pc-sidebar-empty"><ImageIcon size={20} /><p>还没有匹配的素材</p><button type="button" onClick={openCanvasUpload}>上传素材</button></div>}
          </div>
        </>}
      </aside>}
      {viewMode === 'canvas' && <div className="pc-flow" ref={viewportRef}
        onPointerDownCapture={onCanvasPointerDownCapture}
        onPointerMoveCapture={onCanvasPointerMoveCapture}
        onPointerUpCapture={onCanvasPointerUpCapture}
        onPointerCancelCapture={onCanvasPointerUpCapture}
        onPointerLeave={onCanvasPointerLeaveCapture}>
        {graph ? <ReactFlow<FlowNode, Edge>
          nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} isValidConnection={isValidConnection}
          // Selection on pointer down also occurs for dragging. Only an
          // explicit click opens the composer; moving a card keeps it closed.
          onNodeClick={(event, node) => {
            setAddMenu(null); setContextMenu(null)
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            setComposerNodeId(node.id); setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null)
          }}
          onNodeDragStart={() => setComposerNodeId(null)}
          onEdgeClick={(_, edge) => {
            if (edge.data?.visualBinding) { openAutomaticReference(edge); return }
            setSelectedEdgeId(edge.id); setSelectedNodeId(null); setSelectedNodeIds([])
          }}
          onPaneClick={(event) => {
            // Mantine Select renders its option list in a portal. React Flow
            // still receives the bubbled click as a pane click, which used to
            // clear the selected node immediately after a model was chosen.
            const target = event.target
            if (target instanceof Element && target.closest('.mantine-Combobox-dropdown, [role="listbox"], [data-canvas-overlay]')) return
            setComposerNodeId(null); setSelectedNodeId(null); setSelectedNodeIds([]); setSelectedEdgeId(null); setAddMenu(null); setContextMenu(null)
          }}
          onPaneContextMenu={(event) => openContextMenu(event, { position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) })}
          onNodeContextMenu={(event, node) => openContextMenu(event, { nodeId: node.id })}
          onEdgeContextMenu={(event, edge) => {
            if (edge.data?.visualBinding) { event.preventDefault(); openAutomaticReference(edge); return }
            openContextMenu(event, { edgeId: edge.id })
          }}
          onDoubleClick={(event) => {
            // Only the empty pane may open the creation menu. Descendants such
            // as nodes and editors also live inside it, so closest() is too broad.
            const target = event.target
            if (!(target instanceof HTMLElement) || !target.classList.contains('react-flow__pane')) return
            const bounds = viewportRef.current?.getBoundingClientRect()
            if (!bounds) return
            const menuWidth = bounds.width <= 700 ? 276 : 376
            const menuHeight = bounds.width <= 700 ? Math.min(440, bounds.height - 110) : 376
            const x = Math.max(10, Math.min(event.clientX - bounds.left + 8, bounds.width - menuWidth - 10))
            const y = Math.max(10, Math.min(event.clientY - bounds.top + 8, bounds.height - menuHeight - 10))
            setAddMenu({
              position: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              screen: { x, y },
            })
          }}
          // Keep the first/active node readable on entry. Full-canvas framing is
          // an explicit dock action, matching node-editor workflows where the
          // viewport should not jump back to every node after each update.
          minZoom={0.1} maxZoom={8}
          defaultViewport={savedViewport || undefined}
          onInit={instance => {
            const id = pendingCanvasFocus.current
            pendingCanvasFocus.current = null
            const node = queueRef.current?.graph.nodes.find(item => item.id === id)
            if (node) window.requestAnimationFrame(() => {
              const wide = (viewportRef.current?.clientWidth || 0) > 900
              void instance.setCenter(node.x + node.width / 2 + (wide ? 80 : 0), node.y + node.height / 2, { zoom: 1, duration: 0 })
                .then(() => setComposerRevealKey(key => key + 1))
            })
          }}
          onMove={(_, viewport) => setViewportZoom(Math.round(viewport.zoom * 100))}
          onMoveEnd={(_, viewport) => {
            const next = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
            setViewportZoom(Math.round(next.zoom * 100))
            keepCanvasViewport(detail.id, next)
          }}
          panOnScroll panOnScrollMode={PanOnScrollMode.Free} panOnScrollSpeed={1}
          zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false} panOnDrag={[0, 1, 2]}
          selectionOnDrag selectionKeyCode="Shift" multiSelectionKeyCode={["Meta", "Control", "Shift"]} panActivationKeyCode="Space" autoPanOnNodeDrag preventScrolling nodesDraggable nodesConnectable
          snapToGrid snapGrid={[12, 12]} deleteKeyCode={null}
          // A larger connection radius makes the small reference-inspired-style plus
          // buttons easy to catch on a trackpad without making the cards feel
          // cluttered. The preview line uses the same flowing treatment as
          // persisted edges while the pointer is choosing an endpoint.
          connectionRadius={42}
          // Start the preview as soon as a handle (including its magnetic
          // hit area) is pressed. React Flow otherwise waits for the first
          // mousemove before rendering the temporary connection.
          connectionDragThreshold={0}
          connectionLineComponent={StudioConnectionLine}
          defaultEdgeOptions={{ type: 'studio', animated: false }}
        >
          <Background color="#393d3e" gap={20} size={1} />
          {showMinimap && <div className="pc-minimap-dock" style={minimapPosition ? { left: `${minimapPosition.x}px`, top: `${minimapPosition.y}px`, right: 'auto', bottom: 'auto' } : undefined}>
            <div className="pc-minimap-drag-handle" role="button" tabIndex={0} aria-label="拖动小地图" title="拖动小地图" />
            <MiniMap pannable zoomable nodeColor={node => node.selected ? '#929292' : '#535353'} />
          </div>}
          <Tooltip label={sidebarOpen ? '收起节点列表' : '打开节点列表'}>
            <ActionIcon variant="subtle" className={`pc-node-list-toggle ${sidebarOpen ? 'is-active' : ''}`}
              aria-label={sidebarOpen ? '收起左侧节点列表' : '打开左侧节点列表'} onClick={() => setSidebarOpen(open => !open)}>
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </ActionIcon>
          </Tooltip>
          <div className="pc-flow-utility" aria-label="画布工具" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <Tooltip label={showMinimap ? '隐藏小地图' : '显示小地图'}><ActionIcon variant="subtle" aria-label={showMinimap ? '隐藏小地图' : '显示小地图'} aria-pressed={showMinimap} onClick={() => setShowMinimap(value => !value)}><MapIcon size={16} /></ActionIcon></Tooltip>
            <Tooltip label={showEdges ? '隐藏连线' : '显示连线'}><ActionIcon variant="subtle" className={showEdges ? '' : 'is-active'}
              aria-label={showEdges ? '隐藏连线' : '显示连线'} aria-pressed={!showEdges} onClick={() => setShowEdges((value) => !value)}>{showEdges ? <Eye size={16} /> : <EyeOff size={16} />}</ActionIcon></Tooltip>
            <Tooltip label="整理画布"><ActionIcon variant="subtle" aria-label="整理画布" onClick={organizeCanvas}><LayoutDashboard size={16} /></ActionIcon></Tooltip>
            <Tooltip label="重置到 100%"><button type="button" className="pc-flow-zoom-label" aria-label="重置缩放到 100%" onClick={() => void zoomTo(1, { duration: 220 })}>{viewportZoom}%</button></Tooltip>
            <Tooltip label="清除视口记忆"><ActionIcon variant="subtle" aria-label="清除视口记忆并重置" onClick={() => {
              try { window.localStorage.removeItem(viewportKey(detail.id)) } catch { /* Storage may be disabled. */ }
              setSavedViewport(null)
              setViewportZoom(100)
              void setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 240 })
            }}><RefreshCcw size={15} /></ActionIcon></Tooltip>
          </div>
          {selectedNode && composerNodeId === selectedNode.id && selectedNode.type !== 'text' && selectedNode.type !== 'project_script_ref' && selectedNodeIds.length === 1 && selectedNodeIds[0] === selectedNodeId && <CanvasComposerToolbar key={selectedNode.id} nodeId={selectedNode.id} expanded={composerExpanded} revealKey={composerRevealKey} onCollapse={() => setComposerExpanded(false)}>
            <div className={`pc-prompt-composer nowheel ${selectedProfile ? 'pc-profile-composer' : ''} ${composerExpanded ? 'is-expanded' : ''}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <div className="pc-prompt-composer-head">
                <div className="pc-prompt-composer-chips">
                  {referenceReturnNode && referenceReturnNode.id !== selectedNode.id && <button type="button" className="pc-composer-chip pc-reference-return" aria-label={`返回生成节点：${referenceReturnNode.title}`} onClick={() => {
                    focusSidebarNode(referenceReturnNode.id); setReferenceReturnNodeId(null)
                  }}><ArrowLeft size={14} /><span>返回 {referenceReturnNode.title || '原节点'}</span></button>}
                  <button type="button" className="pc-composer-chip" onClick={() => showSidebarAssets(selectedProfile ? 'image' : 'all', selectedNode.id)}><Plus size={15} />参考</button>
                  {!selectedProfile && selectedBoardAsset?.kind === 'image' && <button type="button" className="pc-composer-chip" aria-label="制作分镜视频" disabled={busy || selectedNodeGenerating}
                    onClick={() => void tryNodeAction(selectedNode.id, 'video-first-frame')}><Film size={15} /><span>制作分镜视频</span></button>}
                  {selectedProfile && <><button type="button" className="pc-composer-chip" onClick={() => { setComposerExpanded(false); setSidebarOpen(true); setSidebarTab('profiles'); setReferenceTargetNodeId(selectedNode.id) }}><ImageIcon size={15} />设定参考</button><Tooltip label="编辑设定"><button type="button" className="pc-composer-chip" aria-label="编辑设定" onClick={() => { setComposerExpanded(false); openProfileInspector(selectedProfile) }}><PenLine size={15} /></button></Tooltip></>}
                  {selectedProfile && <Tooltip label="上传设定图"><button type="button" className="pc-composer-chip" aria-label="上传设定图" disabled={busy || selectedNodeGenerating} onClick={() => profileUploadInputRef.current?.click()}><Upload size={15} /></button></Tooltip>}
                </div>
                <button type="button" className="pc-composer-expand" aria-label={composerExpanded ? '缩小创作区' : '放大创作区'} title={composerExpanded ? '缩小创作区' : '放大创作区'} aria-expanded={composerExpanded} onClick={() => setComposerExpanded((value) => !value)}>{composerExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
              </div>
              <div className="pc-prompt-composer-body">
              {selectedShot && <div className="pc-visual-context">
                <button type="button" className="pc-composer-chip pc-visual-context-button" onClick={() => setVisualPreparationOpen(true)}><ImageIcon size={14} />视觉设定 · {visualBindings.length}</button>
                {visualBindings.length > 0 && <><span className="pc-visual-context-status">{visualReferenceMode !== 'profiles' ? '文字设定已带入'
                  : visualBindings.filter(binding => binding.required && !binding.board_asset_id).length ? '必需信息图待确认' : '已绑定'}</span>
                  <CanvasSelect className="pc-visual-reference-select" size="xs" aria-label="视觉设定引用方式" value={visualReferenceMode}
                    disabled={busy}
                    onChange={value => { if (value) updateNodeSettingsById(selectedNode.id, { visual_reference_mode: value as VisualReferenceMode }) }}
                    data={[
                      { value: 'profiles', label: '设定信息图 + 文字' },
                      ...(composerModality === 'video' ? [{ value: 'keyframe', label: '关键帧承接 + 文字' }] : []),
                      { value: 'text_only', label: '仅文字设定' },
                    ]} />
                </>}
              </div>}
              {missingReferences.length > 0 && <div className="pc-missing-references" role="group" aria-label="待补齐参考图">
                <div className="pc-missing-references-heading"><strong>待补齐参考图 · {missingReferences.length}</strong><span>生成后需确认使用</span></div>
                <div className="pc-missing-references-list">{missingReferences.map(reference => <button key={reference.profileId} type="button"
                  aria-label={`${reference.action === 'bindings' ? '调整引用' : '定位参考设定'}：${reference.name} · ${reference.variant}`}
                  onClick={() => locateMissingReference(reference)}>
                  <LocateFixed size={14} /><span title={`${reference.name} · ${reference.variant}`}>{reference.name}{reference.variant && ` · ${reference.variant}`}</span>
                  <small>{reference.action === 'bindings' ? '调整引用' : reference.action === 'confirm' ? '去确认' : '去生成'}</small><ArrowRight size={13} />
                </button>)}</div>
              </div>}
              {composerReferences.length > 0 && <div className="pc-composer-references" aria-label="已连接的参考">
                {composerReferences.map((node, index) => <div className="pc-composer-reference" key={node.id}>
                  <button type="button" title={node.title || '参考节点'} aria-label={`定位参考：${node.title || index + 1}`} onClick={() => focusSidebarNode(node.id)}>
                    {visualNodeAsset(node, detail, true)?.kind === 'image' ? <img src={visualNodeAsset(node, detail, true)!.url} alt={node.title} />
                      : node.type === 'project_script_ref' ? <ScrollText size={22} />
                        : node.type === 'text' ? <FileText size={22} /> : <Film size={22} />}
                    <span>{index + 1}</span>
                  </button>
                  <button type="button" className="pc-composer-reference-remove" aria-label={`移除参考：${node.title || index + 1}`}
                    onClick={() => changeGraph(current => ({ ...current, edges: current.edges.filter(edge => !(edge.source === node.id && edge.target === selectedNode.id)) }))}><X size={12} /></button>
                </div>)}
              </div>}
              {composerModality === 'video' && ['reference', 'edit', 'extend'].includes(selectedMode) && <TextInput disabled={busy} aria-label="参考视频地址" placeholder="https://…（或连接已生成视频）" value={selectedNode.settings.reference_video_url || inputVideo?.remote_url || ''} onChange={event => updateNodeSettingsById(selectedNode.id, { reference_video_url: event.currentTarget.value })} className="pc-reference-video-input" />}
              {selectedProfile && <div className="pc-profile-board-review">
                <div><strong>{selectedProfile.name} · v{selectedProfile.revision}</strong><span>{selectedBoardAsset?.id === selectedProfile.board_asset_id ? '已确认' : selectedBoardAsset ? '候选待确认' : '待生成'}</span>
                  {selectedBoardAsset && <a href={selectedBoardAsset.url} target="_blank" rel="noreferrer" title="查看信息图"><Maximize2 size={14} /></a>}
                  <Button className="pc-candidate-manager-entry" variant="default" size="xs" leftSection={<Layers3 size={13} />} onClick={() => setCandidateProfileId(selectedProfile.id)}>管理候选 · {visualCandidateAssets(selectedProfile, detail, selectedNode.asset_id).filter(asset => !selectedProfile.archived_candidate_asset_ids?.includes(asset.id)).length}</Button>
                  {selectedBoardAsset && selectedBoardAsset.id !== selectedProfile.board_asset_id && <Button variant="default" size="xs" leftSection={<Check size={13} />} disabled={busy || selectedNodeGenerating} onClick={() => void confirmProfileBoard(selectedBoardAsset.id)}>确认使用</Button>}
                </div>
                {!!profileCandidates.length && <div className="pc-profile-candidates" aria-label="设定图候选">{profileCandidates.map((asset, index) => <button key={asset.id} type="button" className={selectedBoardAsset?.id === asset.id ? 'active' : ''} aria-label={`查看设定图候选 ${profileCandidates.length - index}`} onClick={() => updateNodeById(selectedNode.id, { asset_id: asset.id })}><img src={asset.url} alt={`候选 ${profileCandidates.length - index}`} />{asset.id === selectedProfile.board_asset_id && <Check size={12} />}</button>)}
                  {selectedProfile.board_asset_id && !profileCandidates.some(asset => asset.id === selectedProfile.board_asset_id) && assetMap.get(selectedProfile.board_asset_id) && <button type="button" aria-label="查看已确认设定图" onClick={() => updateNodeById(selectedNode.id, { asset_id: selectedProfile.board_asset_id })}><img src={assetMap.get(selectedProfile.board_asset_id)!.url} alt="已确认设定图" /><Check size={12} /></button>}
                </div>}
                {selectedJob?.error && <p role="alert">{selectedJob.error}</p>}
                {profileReferenceChanged && <p role="status">参考图已变化，可重新生成候选图</p>}
              </div>}
              {!selectedProfile && <div className="pc-prompt-kind-label">{composerModality === 'video' ? '视频提示词' : '图片提示词'}</div>}
              <Textarea className="pc-prompt-composer-input" aria-label={selectedProfile ? '信息图补充要求' : '创作提示词'} autosize={!composerExpanded} minRows={selectedProfile ? 2 : 6} maxRows={10} maxLength={selectedProfile ? 10000 : 80000}
                disabled={busy}
                data-autofocus={composerExpanded || undefined}
                styles={{ input: { background: 'transparent', border: 0, boxShadow: 'none', minHeight: composerExpanded ? 240 : selectedProfile ? 64 : 160 } }}
                placeholder={selectedProfile ? '本次补充要求（可选）' : composerModality === 'video' ? '描述画面、动作和运镜，可通过「参考」添加素材' : supportsImageReferences ? '描述画面，可通过「参考」添加图片进行编辑' : '描述主体、场景、光线与构图'}
                value={composerPrompt} onChange={(event) => {
                  const value = event.currentTarget.value
                  if (selectedNode?.type === 'generation') editNodePrompt(selectedNode.id, value, selectedProfile ? undefined : { base: ownBasePrompt, template: automaticPrompt })
                  else if (selectedNode?.type === 'text') updateNodeById(selectedNode.id, { text: value })
                  else if (selectedNode) editNodePrompt(selectedNode.id, value, { base: ownBasePrompt, template: automaticPrompt })
                }} />
              </div>
              <div className="pc-prompt-composer-foot">
                <div className="pc-prompt-composer-settings">
                  <CanvasSelect className="pc-composer-model" aria-label="生成模型" value={composerModelId || null} searchable
                    placeholder={availableModels.length ? '选择模型' : '暂无可用模型'} comboboxProps={{ position: 'top-start', width: 280 }}
                    onChange={(value) => changeComposerModel(value || '')}
                    data={availableModels.filter((model) => !selectedNode || (selectedNode.type === 'generation'
                      ? (!selectedNode.settings.modality || model.modality === selectedNode.settings.modality || model.id === selectedNode.model_id)
                      : (selectedNode.type === 'image' ? model.modality === 'image' : selectedNode.type === 'video' ? model.modality === 'video' : true)
                        || model.id === selectedNode.model_id))
                      .map((model) => ({ value: model.id, label: model.name }))} />
                  {composerModality === 'video' && <CanvasVideoModeMenu key={`mode:${selectedNode.id}`} value={selectedMode}
                    supportedModes={composerModel ? supportedModes(composerModel) : []}
                    onChange={mode => updateNodeSettingsById(selectedNode.id, { mode })} />}
                  {composerModel && composerModel.modality !== 'text' && <>
                    <span className="pc-composer-divider" />
                    <CanvasGenerationParameters key={`params:${selectedNode.id}:${composerModel.id}`} modality={composerModel.modality}
                      ratios={composerUsesReferenceRatio ? ['adaptive'] : modelRatios(composerModel)} ratio={composerRatio} resolutions={composerResolutions} resolution={composerResolution}
                      clarities={composerClarities} clarity={composerClarity} qualities={composerQualities} quality={composerQuality} backgrounds={composerBackgrounds} background={composerBackground}
                      duration={composerDuration} minDuration={durationMin} maxDuration={durationMax}
                      showDuration={composerModel.modality === 'video' && selectedMode !== 'edit'}
                      audioSupported={supportsAudio} generateAudio={selectedNode.settings.generate_audio !== false}
                      count={selectedNode.settings.candidate_count || 1}
                      onChange={patch => updateNodeSettingsById(selectedNode.id, patch)}
                      onCountChange={candidate_count => updateNodeSettingsById(selectedNode.id, { candidate_count })} />
                  </>}
                </div>
                <div className="pc-prompt-composer-actions">
                  {selectedNode.type === 'generation' && <Popover opened={generationInfoOpen} onChange={setGenerationInfoOpen}
                    closeOnClickOutside={false}
                    position="top-end" offset={10} width="min(440px, calc(100vw - 24px))" withinPortal zIndex={220}
                    middlewares={{ flip: { padding: 12 }, shift: { padding: 12, crossAxis: true } }} preventPositionChangeWhenVisible={false}
                    trapFocus returnFocus classNames={{ dropdown: 'pc-generation-info-popover' }}>
                    <Popover.Target>
                      <ActionIcon ref={setGenerationInfoTrigger} variant="subtle" className="pc-composer-info" aria-label="查看生成信息" title="查看生成信息"
                        aria-expanded={generationInfoOpen} aria-haspopup="dialog" disabled={busy || selectedNodeGenerating || !composerModelId}
                        onClick={() => void showGenerationInfo()}><Info size={18} /></ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown ref={setGenerationInfoDropdown} className="nodrag nowheel" data-canvas-overlay role="dialog" aria-label="生成任务信息"
                      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
                      onWheel={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setGenerationInfoOpen(false) }}>
                      <div className="pc-generation-info-heading"><strong>生成信息</strong></div>
                      {review ? <div className="pc-generation-info-content">
                        <dl>
                          <div><dt>{review.board ? '设定档案' : '目标镜头'}</dt><dd>{review.shot.title}</dd></div>
                          <div><dt>模型</dt><dd>{review.model.name} · {review.provider?.name || '未知服务商'}</dd></div>
                          <div><dt>类型与模式</dt><dd>{review.board ? '设定信息图' : review.model.modality === 'video' ? modeOptions.find(item => item.value === review.request.mode)?.label : review.model.modality === 'image' ? '生成图片' : '生成文本'}</dd></div>
                          <div><dt>参数</dt><dd>{review.model.modality === 'image'
                            ? [review.request.resolution, review.request.quality && `画质 ${review.request.quality}`, review.request.clarity, review.request.background && `背景 ${review.request.background}`].filter(Boolean).join(' · ')
                            : review.request.resolution || '默认'}{review.model.modality === 'video' ? ` · ${review.request.duration} 秒` : ''}{review.model.modality !== 'text' ? ` · ${review.request.ratio}` : ''}{review.request.draft ? ' · 样片' : ''}</dd></div>
                          {review.model.modality === 'video' && <div><dt>生成声音</dt><dd>{review.request.generate_audio ? '开启' : '关闭'}</dd></div>}
                          <div><dt>参考图</dt><dd>{review.referenceNames.length ? review.referenceNames.map((name, index) => ['first_frame', 'first_last_frame'].includes(review.request.mode) ? `${index === 0 ? '首帧' : '尾帧'}：${name}` : name).join('、') : '无'}</dd></div>
                          {review.request.reference_video_url && <div><dt>参考视频</dt><dd>{review.request.reference_video_url}</dd></div>}
                          <div><dt>候选数量</dt><dd>{review.candidateCount} 个</dd></div>
                          <div><dt>总费用预估</dt><dd>{generationCost(review.model, review.request, review.candidateCount) ? `约 ${generationCost(review.model, review.request, review.candidateCount)}` : '模型未配置费用，请核对厂商价格'}</dd></div>
                        </dl>
                        {!!review.request.reference_asset_ids.length && <div className="pc-visual-thumbnails">{review.request.reference_asset_ids.map(id => assetMap.get(id)).filter((asset): asset is Asset => !!asset).map(asset => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={asset.filename} title={asset.filename} /></a>)}</div>}
                        {review.request.visual_signature && <p>{review.request.visual_reference_mode === 'text_only' ? '仅使用文字设定' : review.request.visual_reference_mode === 'keyframe' ? '使用关键帧与文字设定' : '使用设定信息图与文字设定'}</p>}
                        <div className="pc-generation-info-prompt"><span>实际提交提示词</span><p>{review.request.prompt}</p></div>
                      </div> : <div className="pc-generation-info-loading" role="status"><LoaderCircle size={16} className="pc-spin" />正在整理生成信息</div>}
                    </Popover.Dropdown>
                  </Popover>}
                  <button type="button" className="pc-composer-submit" aria-label={selectedNodeGenerating ? '生成中，请等待' : '开始生成'} disabled={busy || selectedNodeGenerating || (!selectedProfile && (!composerPrompt.trim() || !compiledPrompt.trim() && !selectedNode.settings.prompt_is_final)) || !composerModelId} onClick={submitComposer}>{selectedNodeGenerating ? <LoaderCircle size={19} className="pc-spin" /> : <ArrowRight size={19} />}</button>
                </div>
              </div>
            </div>
          </CanvasComposerToolbar>}
        </ReactFlow> : <div className="pc-loading">{loadError ? <><CircleAlert size={20} />{loadError}<Button variant="default" size="xs" onClick={() => window.location.reload()} leftSection={<RefreshCcw size={14} />}>重新载入</Button></> : <><LoaderCircle size={20} className="pc-spin" />正在载入画布</>}</div>}
        {contextMenu && <div className="pc-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
          {contextNode ? <>
            <div className="pc-context-heading"><span>{contextNode.type === 'project_script_ref' ? '项目剧本' : contextNode.type === 'generation' ? '生成节点' : contextNode.type === 'text' ? '文本节点' : '素材节点'}</span><strong>{contextNode.title || '未命名节点'}</strong></div>
            {contextNode.type === 'project_script_ref'
              ? <button role="menuitem" onClick={() => { setContextMenu(null); (detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length) ? onOpenScriptCreator() : openScriptDirector() }}><ScrollText size={16} />{detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length ? '编辑剧本' : '开始剧本创作'}</button>
              : <button role="menuitem" onClick={() => { selectNodeForView(contextNode.id); setContextMenu(null) }}><Settings2 size={16} />编辑节点</button>}
            {contextNode.type === 'generation' && <button role="menuitem" onClick={() => { setPendingRunNodeId(contextNode.id); setContextMenu(null) }}><Sparkles size={16} />提交生成</button>}
            {contextNode.type !== 'project_script_ref' && <button role="menuitem" onClick={() => duplicateSelection(contextNode.id)}><Plus size={16} />复制节点</button>}
            <div className="pc-context-divider" />
            <button className="is-danger" role="menuitem" onClick={() => deleteSelection(contextNode.id, null)}><Trash2 size={16} />删除节点</button>
          </> : contextEdge ? <>
            <div className="pc-context-heading"><span>节点连接</span><strong>参考或结果关系</strong></div>
            <button className="is-danger" role="menuitem" onClick={() => deleteSelection(null, contextEdge.id)}><Trash2 size={16} />删除连接</button>
          </> : <>
            <div className="pc-context-heading"><span>画布操作</span><strong>在当前位置创建</strong></div>
            <button role="menuitem" onClick={() => { addNode('text', undefined, contextMenu.position); setContextMenu(null) }}><FileText size={16} />添加文本</button>
            <button role="menuitem" onClick={() => { addNode('generation', 'image', contextMenu.position); setContextMenu(null) }}><ImageIcon size={16} />图片生成</button>
            <button role="menuitem" onClick={() => { addNode('generation', 'video', contextMenu.position); setContextMenu(null) }}><Film size={16} />视频生成</button>
            {detail.shots.length > 0 && <button role="menuitem" onClick={() => { importShots(); setContextMenu(null) }}><ScrollText size={16} />导入分镜</button>}
            <div className="pc-context-divider" />
            <button role="menuitem" onClick={() => { void fitView({ padding: 0.15, duration: 300 }); setContextMenu(null) }}><MousePointer2 size={16} />适配全部节点</button>
          </>}
        </div>}
        {graph && !graph.nodes.length && <div className="pc-empty">
          <div className="pc-empty-hint"><MousePointer2 size={16} />双击画布，自由生成节点</div>
          <div className="pc-empty-actions"><Button variant="default" onClick={() => addNode('text')} leftSection={<FileText size={16} />}>文本</Button><Button variant="default" onClick={() => addNode('generation', 'image')} leftSection={<ImageIcon size={16} />}>图片生成</Button><Button variant="default" onClick={() => addNode('generation', 'video')} leftSection={<Film size={16} />}>视频生成</Button><Button variant="default" onClick={() => openScriptDirector('all')} leftSection={<ScrollText size={16} />}>剧本生成</Button>{detail.shots.length > 0 && <Button variant="default" onClick={importShots} leftSection={<Layers3 size={16} />}>导入分镜</Button>}</div>
        </div>}
        {graph && graph.nodes.length > 0 && missingShotCount > 0 && <div className="pc-import-prompt"><span>{missingShotCount} 个分镜尚未加入画布</span><Button variant="default" size="xs" onClick={importShots} leftSection={<Layers3 size={14} />}>导入分镜</Button></div>}
        </div>}
      {viewMode === 'storyboard' && (graph ? <StoryboardWorkspace
          detail={detail}
          graph={graph}
          models={models}
          selectedId={storyboardSelectedId}
          saveState={saveState}
          onSelect={(id) => {
            setStoryboardSelectedId(id)
            const node = graph.nodes.find(item => item.id === id)
            setSelectedNodeId(node?.id || null)
            setSelectedNodeIds(node ? [node.id] : [])
            setSelectedEdgeId(null)
          }}
          onOpenDirector={context => openScriptDirector('all', context)}
          onOpenScript={artifact => artifact && onOpenScriptDocument ? onOpenScriptDocument(artifact) : onOpenScriptCreator()}
          onOpenSettings={focusSidebarNode}
          onCreateVideo={id => void tryNodeAction(id, 'video-first-frame')}
          onTextChange={(id, text, document) => changeGraph(current => ({
            ...current, nodes: current.nodes.map(node => node.id === id
              ? { ...node, text, settings: { ...node.settings, text_document: document } } : node),
          }))}
        /> : <div className="pc-loading"><LoaderCircle size={20} className="pc-spin" />正在载入故事板</div>)}
      <div className="pc-create-dock pc-create-dock-tools">
        <Tooltip label="撤销"><ActionIcon variant="subtle" aria-label="撤销画布操作" onClick={undoGraph} disabled={!historyRef.current.past.length}><Undo2 size={18} /></ActionIcon></Tooltip>
        <Tooltip label="重做"><ActionIcon variant="subtle" aria-label="重做画布操作" onClick={redoGraph} disabled={!historyRef.current.future.length}><Redo2 size={18} /></ActionIcon></Tooltip>
        <Tooltip label="添加节点"><ActionIcon variant="subtle" aria-label="添加节点" aria-expanded={!!addMenu} onClick={() => setAddMenu((current) => current ? null : {})}><Plus size={20} /></ActionIcon></Tooltip>
        <Tooltip label="添加文本"><ActionIcon variant="subtle" aria-label="添加文本" onClick={() => addNode('text')} disabled={!graph}><FileText size={19} /></ActionIcon></Tooltip>
        <Tooltip label="图片生成"><ActionIcon variant="subtle" aria-label="添加图片生成节点" onClick={() => addNode('generation', 'image')} disabled={!graph}><ImageIcon size={19} /></ActionIcon></Tooltip>
        <Tooltip label="视频生成"><ActionIcon variant="subtle" aria-label="添加视频生成节点" onClick={() => addNode('generation', 'video')} disabled={!graph}><Film size={19} /></ActionIcon></Tooltip>
        <Tooltip label="上传素材"><ActionIcon variant="subtle" aria-label="上传素材到画布" onClick={openCanvasUpload}><Upload size={19} /></ActionIcon></Tooltip>
        <Tooltip label="浏览素材"><ActionIcon variant="subtle" aria-label="浏览画布素材" onClick={() => showSidebarAssets()}><Layers3 size={19} /></ActionIcon></Tooltip>
        {viewMode === 'canvas' && <Tooltip label="适配画布"><ActionIcon variant="subtle" aria-label="适配全部节点" onClick={() => void fitView({ padding: 0.15, duration: 300 })}><MousePointer2 size={18} /></ActionIcon></Tooltip>}
      </div>
      {addMenu && <div
        className={`pc-add-menu ${addMenu.screen ? 'pc-add-menu-canvas' : 'pc-add-menu-dock'}`}
        role="menu"
        style={addMenu.screen ? { left: addMenu.screen.x, top: addMenu.screen.y } : undefined}
      >
        <button role="menuitem" onClick={() => addNode('text', undefined, addMenu.position)}><FileText size={17} />文本</button>
        <button role="menuitem" onClick={() => addNode('generation', 'image', addMenu.position)}><ImageIcon size={17} />图片生成</button>
        <button role="menuitem" onClick={() => addNode('generation', 'video', addMenu.position)}><Film size={17} />视频生成</button>
        <button role="menuitem" onClick={() => showSidebarAssets('audio')}><Music2 size={17} />音频素材</button>
        <button role="menuitem" onClick={() => { setAddMenu(null); openCanvasUpload() }}><Upload size={17} />上传素材</button>
        <button role="menuitem" onClick={() => showSidebarAssets()}><Layers3 size={17} />素材库</button>
        <button role="menuitem" onClick={() => { onNavigate('jobs'); setAddMenu(null) }}><Clock3 size={17} />生成历史</button>
        {detail.shots.length > 0 && <button role="menuitem" onClick={() => { importShots(); setAddMenu(null) }}><ScrollText size={17} />导入分镜</button>}
        <button role="menuitem" onClick={() => { organizeShotGroups(); setAddMenu(null) }}><WandSparkles size={17} />按镜头整理生成器组</button>
        {(selectedNodeId || selectedEdgeId) && <button role="menuitem" onClick={() => { deleteSelection(); setAddMenu(null) }}><Trash2 size={17} />移除所选</button>}
      </div>}

    </div>
    {notice && <div className="pc-notice" role="status"><span>{notice.message}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    <input type="file" hidden ref={profileUploadInputRef} accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadProfileBoard(file); event.currentTarget.value = '' }} />
    {candidateProfile && <VisualCandidateManager key={candidateProfile.id} profile={candidateProfile} detail={detail} models={models} displayedAssetId={candidateNode?.asset_id} generating={candidateGenerating} onConfirm={assetId => useProfileBoard(candidateProfile, assetId)} onRefresh={onRefresh} onClose={() => setCandidateProfileId(null)} />}
    {viewMode === 'canvas' && inspectedProfile && <VisualProfileInspector key={inspectedProfile.id} profile={inspectedProfile} detail={detail} generating={inspectedProfileGenerating} onRefresh={async () => { await onRefresh(); setNotice('设定已保存') }} onClose={() => setProfileInspectorId(null)} onBindings={() => setVisualPreparationOpen(true)} onDirtyChange={setProfileDraftDirty} />}
    {visualPreparationOpen && <VisualPreparation detail={detail} models={models} shotId={selectedShot?.id || storyboardSelectedId || undefined} onRefresh={onRefresh} onClose={() => setVisualPreparationOpen(false)} onOpenCanvas={ids => { setVisualPreparationOpen(false); openProfileSidebar(); ids.forEach(id => { const profile = detail.visual_profiles?.find(item => item.id === id); if (profile) addProfileToCanvas(profile, null) }) }} />}
    <Modal opened={!!conflictReview} onClose={() => setConflictReview(null)} title="画布版本冲突" centered size="md">
      {conflictReview && <div className="pc-conflict"><p>服务器上的画布已被其他编辑更新。本地修改仍保留。合并会保留双方独立新增的节点；同一内容同时修改时以本地版本为准。</p><strong>{conflictReview.conflicts} 处内容冲突</strong><div><Button variant="default" onClick={useServerVersion}>加载服务器版本</Button><Button onClick={() => void applyMerge()} leftSection={<Save size={15} />}>合并并保存</Button></div></div>}
    </Modal>
    {dialog}
  </div>
}

export default function ProjectCanvas(props: ProjectCanvasProps) {
  return <ReactFlowProvider><ProjectCanvasInner {...props} /></ReactFlowProvider>
}
