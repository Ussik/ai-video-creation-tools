import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Tabs, FileButton, UnstyledButton,
  ActionIcon, Badge, Button, Drawer, Menu, Modal, Popover, Text, TextInput, Tooltip,
} from '@mantine/core'
import { useClickOutside } from '@mantine/hooks'
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Check, ChevronDown, CircleAlert, Clock3, FileText, Film, FolderOpen,
  Image as ImageIcon, ScanEye, Info, LayoutGrid, Layers3, LoaderCircle, LocateFixed, Map as MapIcon, Maximize2, Minimize2, MoreHorizontal, MousePointer2,
  MessageSquare, Mic2, Music2, PanelLeftClose, PanelLeftOpen, PenLine, Plus, RefreshCcw, Save, ScrollText,
  Search, Settings2, SlidersHorizontal, Sparkles,
  Eye, EyeOff, LayoutDashboard,
  Redo2, Trash2, Undo2, Upload, WandSparkles, X, UserRound, MapPin, Package,
} from 'lucide-react'
import {
  Background, BaseEdge, getBezierPath, Handle, MiniMap, NodeResizer, PanOnScrollMode, Position, ReactFlow,
  ReactFlowProvider, applyEdgeChanges, useReactFlow,
} from '@xyflow/react'
import type { Connection, ConnectionLineComponentProps, Edge, EdgeChange, EdgeProps, Node, NodeChange, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, json } from '../../shared/api/api'
import { assetPresentations } from '../assets/asset-presentation'
import { orderModelsByDefault } from '../models/model-defaults'
import type { Asset, Job, Model, ProjectDetail, Provider, ScriptArtifact, Shot, VisualBoardPreview, VisualProfile, VisualReferenceMode } from '../../shared/api/api'
import { videoRatioOptions, videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { supportsImagePromptAnalysis } from '@video-studio/shared/models/image-analysis-settings'
import { videoReferenceConfigError, supportsVideoMultiReference } from '@video-studio/shared/media/video-reference-config'
import { videoReferenceUsageLabels, type VideoReferenceUsageSelection } from '@video-studio/shared/media/video-reference-usage'
import { scopedVisualReferenceAssetIds, videoReferenceManifest, visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import VideoReferencePanel from '../visuals/VideoReferencePanel'
import VisualBindingEditor, { type VisualBindingContext } from '../visuals/VisualBindingEditor'
import { visualBindingNeedsRefresh } from '../visuals/visual-binding-status'
import VisualProfileOrganizer from '../visuals/VisualProfileOrganizer'
import VisualProfileInspector from '../visuals/VisualProfileInspector'
import VisualCandidateManager from '../visuals/VisualCandidateManager'
import ShotCandidateManager, { ShotCandidateStrip } from './ShotCandidateManager'
import { shotMediaCandidates } from './canvas-shot-candidates'
import { canvasJobMatchesStoryboard, storyboardRevision, syncCanvasStoryboardRevision } from './canvas-storyboard-revision'
import { addVisualProfileNode, automaticVisualReferenceEdges, missingVisualReferences, syncVisualProfileNode, visualBoardJobs, visualBoardReferences, visualCandidateAssets, visualJobRequest, visualNodeAsset } from './canvas-visual-profiles'
import { connectImageVideoHandoff, createImageVideoHandoff, fixedReferenceAsset, imageVideoConnection, pinnedCanvasReference } from './canvas-shot-workflow'
import { enqueueCanvasVisualBoard, prepareCanvasVisualBoard, visualReferenceGenerating } from './canvas-reference-generation'
import { videoPreferencePrompt } from './canvas-prompt-draft'
import { canvasPromptBody, rewriteCanvasPromptSections } from './canvas-prompt-composition'
import { extractPromptBody, getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { isPromptSectionDocument, parsePromptSectionDocument, reconcilePromptSectionDocument, resolvePromptSectionSource,
  serializePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { findPromptParameterConflicts, synchronizePromptParameters } from '@video-studio/shared/visuals/prompt-parameter-conflicts'
import CanvasPromptDocumentStatus from './CanvasPromptDocumentStatus'
import { withVisualProfilePrompt } from '@video-studio/shared/visuals/visual-profile-prompt'
import { visualSettingTemplates, withVisualSettingTemplate, type VisualSettingKind } from '@video-studio/shared/visuals/visual-setting-template'
import { replacePromptReference, promptReferenceBindings, disconnectedPromptReferenceIds, disconnectRemovedPromptReplacements } from './canvas-prompt-references'
import { materializePromptReference, replaceConnectedPromptReference, promptReferenceSources, freezeLegacyPromptReferenceDrafts } from './canvas-prompt-reference-graph'
import { extractPromptReferenceIds, resolvePromptReferences, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import CanvasPromptEditor from './CanvasPromptEditor'
import CanvasProfileInheritance from './CanvasProfileInheritance'
import CanvasReferenceList, { type CanvasReferenceItem } from './CanvasReferenceList'
import { activeProfileReferenceSnapshot, profileCandidateReferenceState, resolveCanvasVisualBoardReferences } from './canvas-visual-board-references'
import { resolveCanvasProfileDisplayText } from './canvas-profile-display-text'
import { visualProfileBaseReadiness, visualProfileBoardReady } from '../visuals/visual-profile-inheritance'
import { createReferenceBatch, evaluateReferenceBatch, markReferenceBatchSubmitting, recordReferenceBatchSubmission, recordReferenceBatchFailure, readReferenceBatch, writeReferenceBatch, clearReferenceBatch, type ReferenceBatchState } from './canvas-reference-batch'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'
import { enrichExplicitReferenceBindings } from '@video-studio/shared/visuals/explicit-reference-context'
import { visualBindingApplies, visualBindingsForModality } from '@video-studio/shared/visuals/visual-binding-usage'
import { withProjectStyle, styleReferenceWarning } from '@video-studio/shared/visuals/visual-style'
import type { MissingVisualReference } from './canvas-visual-profiles'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import CanvasTextEditor, { CanvasTextPreview } from './CanvasTextEditor'
import NodeMedia from './CanvasNodeMedia'
import CanvasImageAnalysisPanel from './CanvasImageAnalysisPanel'
import { resolveCanvasImageAnalysisSource } from './canvas-image-analysis'
import CanvasVideoAnalysisPanel from './CanvasVideoAnalysisPanel'
import { resolveCanvasVideoAnalysisSource, videoAnalysisModels } from './canvas-video-analysis'
import { useCanvasVideoAnalysis } from './useCanvasVideoAnalysis'
import { videoAnalysisShotPrompt, videoAnalysisText, type VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import CanvasMediaPreview from './CanvasMediaPreview'
import { videoGenerationDurationMs, videoReviewModels } from './canvas-video-review'
import CanvasEdgeMotionProvider, { useCanvasEdgeMotionPath } from './CanvasEdgeMotion'
import CanvasSelect from './CanvasSelect'
import CanvasNodeTypeFilter from './CanvasNodeTypeFilter'
import { canvasNodeCategory, type CanvasNodeTypeFilter as NodeTypeFilter } from './canvas-node-type-filter'
import StoryboardWorkspace from '../storyboard/StoryboardWorkspace'
import CanvasComposerToolbar from './CanvasComposerToolbar'
import PromptSkillAction from '../skills/PromptSkillAction'
import PromptOptimizationModal from '../jobs/PromptOptimizationModal'
import { canOptimizeImagePrompt } from '@video-studio/shared/jobs/prompt-optimization'
import { jobRecoveryPresentation } from '../jobs/job-recovery'
import { addOptimizedPromptDraft, type OptimizedPromptDraft } from './canvas-optimized-prompt'
import { useAppDialog } from '../../shared/ui/AppDialog'
import ThemeToggle from '../../shared/ui/ThemeToggle'
import { CanvasGenerationParameters, CanvasVideoModeMenu, videoModeLabel } from './CanvasGenerationControls'
import { createGenerationNodeCapabilities, generationNodeCapabilityDescriptions, generationNodeDirectorContext, type GenerationNodeReference } from './canvas-node-capabilities'
import { canvasNodeProposalFingerprint, canvasNodeProposalSourceKey, type CanvasNodeProposal, type CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { canvasGenerationSubmissionFinished, canvasGenerationSubmissionSource, canvasGenerationSubmissionStoragePrefix,
  createCanvasGenerationSubmission, readCanvasGenerationSubmission, recoverCanvasGenerationSubmission,
  withCanvasGenerationSubmissionLock, type CanvasGenerationSubmission } from './canvas-generation-submission'
import { addCanvasNodeProposalDraft, assertCanvasNodeProposalCurrent, assertCanvasNodeProposalValues, canvasNodeProposalSourceMatches,
  type CanvasNodeProposalActions, type CanvasNodeProposalApplyResult } from './canvas-node-proposal'
export type { CanvasNodeProposalActions } from './canvas-node-proposal'
import type { JSONContent } from '@tiptap/core'
import { generationCost, imageGenerationDefaults, imageParameterOptions, imageParameterValue, imagePreferencePrompt, imageRatioError, imageRatios, imageRequestResolution, imageResolutionClarity, modelDefaultResolution, usesModelParameter, videoParameterPolicy } from './canvas-model-parameters'
import { parseScriptDocument } from '../script/script-rich-document'
import { textDocumentText } from '../../shared/lib/editor/text-document'
import { fitImageNode, imageNodeMinimum } from './canvas-image-layout'
import { placeNewCanvasNodes } from './canvas-node-placement'
import { canvasPromptIndex, canvasReferenceKey, compactCanvasZoom, indexedCanvasPrompt, reuseFlowEdge, reuseFlowNode, sameCanvasContent, shallowEqual, shouldVirtualizeCanvas, updateCanvasGeometry } from './canvas-performance'
import { addScriptCanvasNodes, bindScriptCanvasRequest, clearScriptCanvasRequest, readScriptCanvasRequest, scriptCanvasInitialFocus } from '../script/script-canvas-handoff'
import ProjectCanvasSwitcher, { type CanvasActions } from './ProjectCanvasSwitcher'
import { canvasGraphPath, type ProjectCanvasInfo } from './project-canvases'
import { allProjectShots, canvasDesignShots } from './canvas-design-scope'
import { clearShotCanvasRequest, readShotCanvasRequest, shotCanvasNode } from './canvas-shot-navigation'
import './project-canvas.css'
import './canvas-visual-profiles.css'
import './canvas-visual-management.css'
import './canvas-sidebar.css'
import '../visuals/video-reference-panel.css'

type CanvasMode = 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'edit' | 'extend'
type CanvasView = 'canvas' | 'storyboard'
export type CanvasLocation = { view: CanvasView; storyboardId: string | null }
type CanvasModality = 'text' | 'image' | 'video'
type TextNodeMode = 'write'
export type ScriptAction = 'character' | 'location' | 'prop' | 'all'
type NodeQuickAction = 'image-to-image' | 'video-reference' | 'video-first-frame' | 'video-first-last' | 'video-extend'
export type CanvasNode = {
  id: string
  type: 'text' | 'image' | 'video' | 'generation' | 'image_analysis' | 'video_analysis' | 'project_script_ref'
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
    image_analysis_instructions?: string
    image_analysis_source_asset_id?: string | null
    video_analysis_instructions?: string
    video_analysis_start_ms?: number
    video_analysis_end_ms?: number | null
    video_analysis_fps?: number
    video_analysis_result?: VideoPromptAnalysisResult
    visual_profile_id?: string
    visual_profile_revision?: number
    visual_template_kind?: VisualSettingKind
    visual_dependencies?: boolean
    profile_prompt_override?: string
    prompt_reference_overrides?: Record<string, string | null>
    visual_completed_job_id?: string
    generation_completed_job_id?: string
    storyboard_revision?: number
    visual_reference_mode?: VisualReferenceMode
    storyboard_reference_asset_id?: string | null
    image_video_handoff?: {
      source_node_id: string
      source_asset_id: string
      source_signature: string
      applied_signature: string
      inherited_reference_asset_ids?: string[]
    }
    video_reference_usages?: VideoReferenceUsageSelection[]
    excluded_visual_profile_ids?: string[]
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
    prompt_document?: boolean
    prompt_sections?: PromptSectionDocument
    prompt_body?: string
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
  canvasId?: string
  storageId: string
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
  active: boolean
  compact: boolean
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
  onOptimizePrompt: (id: string) => void
  onTextChange: (id: string, value: string) => void
  onTextDocumentChange: (id: string, text: string, document: JSONContent) => void
  onModelChange: (id: string, value: string) => void
  onSettingsChange: (id: string, patch: Partial<CanvasNode['settings']>) => void
  onOpenSettings: (id: string) => void
  onRun: (id: string) => void
  onTryAction: (id: string, action: NodeQuickAction) => void
  onMediaSize: (id: string, assetId: string, width: number, height: number) => void
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
  source_artifact_type?: VisualSettingKind
  explicit_reference_asset_ids?: string[]
  prompt_reference_overrides?: Record<string, string | null>
  storyboard_revision?: number
  project_style_version?: string
  project_visual_style?: import('@video-studio/shared/visuals/visual-style').ProjectVisualStyle
  style_warnings?: string[]
  prompt_is_final?: boolean
  prompt_document?: boolean
  prompt_body?: string
  prompt_template?: string
  visual_reference_mode?: VisualReferenceMode
  storyboard_reference_asset_id?: string | null
  video_reference_usages?: VideoReferenceUsageSelection[]
  excluded_visual_profile_ids?: string[]
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
  board?: { profile: VisualProfile; preview: VisualBoardPreview; input: ReturnType<typeof visualBoardReferences> & { prompt_append: string; prompt_override?: string } }
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

async function saveCanvas(projectId: string, payload: CanvasGraph, canvasId?: string): Promise<CanvasGraph> {
  const response = await fetch(`/api${canvasGraphPath(projectId, canvasId)}`, {
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
  onOpenSpeech?: () => void
  onOpenScriptDocument?: (artifact: ScriptArtifact) => void
  onOpenScriptDirector?: (focusArtifact?: ScriptAction, context?: string, source?: CanvasNodeProposalSource) => void
  registerNodeProposalActions?: (actions: CanvasNodeProposalActions | null) => void
  initialLocation?: CanvasLocation
  onLocationChange?: (location: CanvasLocation) => void
  optimizedPromptDraft?: OptimizedPromptDraft | null
  onOptimizedPromptDraftApplied?: () => void
}

export type CanvasSession = {
  revision?: string;
  nodeTypeFilter?: NodeTypeFilter;
  history: { past: CanvasGraph[]; future: CanvasGraph[] };
  selection?: { nodeId: string | null; nodeIds: string[]; edgeId: string | null; composerNodeId: string | null };
}
type CanvasInstanceProps = ProjectCanvasProps & {
  canvas: ProjectCanvasInfo; canvasSession: CanvasSession; canvasMenu: React.ReactNode;
  registerCanvasActions: (actions: CanvasActions | null) => void;
  onCanvasViewport: (viewport: ProjectCanvasInfo['viewport']) => void;
}

function draftKey(projectId: string) { return `project-canvas-draft:${projectId}` }
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
  try { window.localStorage.setItem(draftKey(queue.storageId), JSON.stringify({ base: queue.base, graph: queue.graph })) }
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

const modeOptions: CanvasMode[] = ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend']
const jobLabels = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' } as const
const projectScriptDefaultSize = { width: 720, height: 480 }
const visualSettingIcons = { character: UserRound, location: MapPin, prop: Package }

function VisualSettingMenuItems({ onSelect, fromImage = false }: { onSelect: (kind: VisualSettingKind) => void; fromImage?: boolean }) {
  return <>{(['character', 'location', 'prop'] as const).map(kind => {
    const Icon = visualSettingIcons[kind]
    return <Menu.Item key={kind} role="menuitem" onClick={() => onSelect(kind)} data-workspace-control="">
      <Icon size={16} />{fromImage ? '创建' : ''}{visualSettingTemplates[kind].label}
    </Menu.Item>
  })}</>
}

function blankNode(type: CanvasNode['type'], x: number, y: number): CanvasNode {
  return {
    id: crypto.randomUUID(), type, x, y,
    width: type === 'project_script_ref' ? projectScriptDefaultSize.width : type === 'generation' ? 440 : type === 'text' || type === 'image_analysis' || type === 'video_analysis' ? 420 : 400,
    // Media cards reserve a 16:9 preview plus a compact action rail. Keeping
    // the node at that ratio avoids letterbox space around 720p/1080p assets.
    height: type === 'project_script_ref' ? projectScriptDefaultSize.height : type === 'generation' ? 420 : type === 'text' || type === 'image_analysis' || type === 'video_analysis' ? 340 : 272,
    title: type === 'video_analysis' ? '视频反推提示词' : type === 'image_analysis' ? '图片反推提示词' : type === 'project_script_ref' ? '项目剧本' : type === 'generation' ? '生成节点' : type === 'text' ? '文本节点' : '',
    text: '', asset_id: null, shot_id: null, model_id: null, job_id: null,
    prompt: '', settings: {},
  }
}

function ensureCanvasScript(graph: CanvasGraph, canvasId: string, title: string, previous?: CanvasNode): CanvasGraph {
  if (graph.nodes.some(node => node.type === 'project_script_ref')) return graph
  const x = graph.nodes.length ? Math.max(-1_000_000, Math.min(...graph.nodes.map(node => node.x)) - projectScriptDefaultSize.width - 120) : 60
  const y = graph.nodes.length ? Math.min(...graph.nodes.map(node => node.y)) : 80
  const script = previous || { ...blankNode('project_script_ref', x, y), id: `project-script:${canvasId}`, title: title || '项目剧本' }
  return { ...graph, nodes: [script, ...graph.nodes] }
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
  // Give older default script cards more room for document text. Upgrade only
  // previous defaults so user-resized cards retain their custom dimensions.
  for (const node of nodes) {
    if (node.type === 'project_script_ref' && (node.width === 390 && node.height === 216 || node.width === 640 && node.height === 350)) {
      node.width = projectScriptDefaultSize.width
      node.height = projectScriptDefaultSize.height
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
  if (node.type === 'generation' && (asset?.kind === 'image' || asset?.kind === 'video')) return imageNodeMinimum
  return node.type === 'generation' ? { width: 440, height: 420 }
    : node.type === 'text' || node.type === 'image_analysis' || node.type === 'video_analysis' ? { width: 420, height: 340 }
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
  if (model?.modality === 'video') return videoResolutionOptions(model.settings)
  const values = model?.settings.resolutions
  return Array.isArray(values) && values.some((value) => typeof value === 'string')
    ? values.filter((value): value is string => typeof value === 'string')
    : model?.modality === 'image' ? ['1K', '2K', '4K'] : videoResolutionOptions()
}

const modelImageQualities = (model?: Model) => imageParameterOptions(model, 'quality')
const modelImageBackgrounds = (model?: Model) => imageParameterOptions(model, 'background')
const modelImageClarities = (model?: Model) => imageParameterOptions(model, 'clarity')

function modelRatios(model?: Model): string[] {
  if (model?.modality === 'video') return videoRatioOptions(model.settings)
  const values = model?.settings.ratios
  return Array.isArray(values) && values.some((value) => typeof value === 'string')
    ? values.filter((value): value is string => typeof value === 'string')
    : model?.modality === 'image'
      ? imageRatios
      : videoRatioOptions()
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
  return modeOptions.filter((value) => supported.includes(value))
}

function isCanvasEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  return !!element.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')
}

function nodeDimensionLabel(node: CanvasNode, model?: Model): string {
  if (node.type === 'generation' && node.settings.modality === 'image' && model) {
    const defaults = imageGenerationDefaults(model)
    return [imageParameterValue(model, 'clarity', node.settings.clarity || imageResolutionClarity(node.settings.resolution) || defaults.clarity), node.settings.ratio || defaults.ratio].filter(Boolean).join(' · ')
  }
  if (node.type === 'text' || node.type === 'image_analysis' || node.type === 'video_analysis') return ''
  const resolution = typeof node.settings.clarity === 'string' && node.settings.clarity.trim()
    ? node.settings.clarity.trim()
    : typeof node.settings.resolution === 'string' ? node.settings.resolution.trim() : ''
  const ratioValue = typeof node.settings.ratio === 'string' ? node.settings.ratio.trim() : ''
  const ratio = ratioValue === 'adaptive' || !ratioValue && node.settings.modality === 'video' && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(node.settings.mode || '')
    ? '自适应' : ratioValue
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

/** Static SVG strokes, with small compositor markers on the inspected links. */
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
  useCanvasEdgeMotionPath(id, path, !!data?.motion && style?.opacity !== 0)
  return <g className={`pc-studio-edge${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${style?.opacity === 0 ? ' is-hidden' : ''}`}>
    {automatic && <title>已绑定的设定参考图，点击调整镜头视觉设定</title>}
    <BaseEdge id={id} path={path} interactionWidth={28} style={{
      ...style,
      stroke: selected ? 'var(--pc-edge-selected)' : related ? 'var(--pc-edge-active)' : 'var(--pc-edge-idle)',
      strokeWidth: selected ? 2.8 : related ? 2.4 : 1.5,
      strokeLinecap: 'round',
    }} />
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
  </g>
}

const edgeTypes = { studio: StudioEdge }

function StudioNode({ data, selected }: NodeProps<FlowNode>) {
  const { node, asset, job } = data
  const recovery = job && jobRecoveryPresentation(job, data.model?.modality)
  const profile = data.profile
  const templateKind = node.settings.visual_template_kind
  const TemplateIcon = templateKind ? visualSettingIcons[templateKind] : undefined
  const imageEditingAvailable = data.model?.modality === 'image' ? data.imageEditingModels.includes(data.model.id) : data.modelOptions.some(option => data.imageEditingModels.includes(option.value))
  const videoQuickModes = data.model?.modality === 'video' ? supportedModes(data.model) : data.videoQuickModes
  const isProjectScriptRef = node.type === 'project_script_ref'
  const isMediaResult = node.type === 'generation' && (asset?.kind === 'image' || asset?.kind === 'video')
  const icon = node.type === 'image_analysis' || node.type === 'video_analysis' ? <ScanEye size={15} /> : isProjectScriptRef ? <ScrollText size={15} /> : TemplateIcon ? <TemplateIcon size={15} /> : profile ? <ImageIcon size={15} /> : node.type === 'generation' ? <WandSparkles size={15} />
    : node.type === 'image' ? <ImageIcon size={15} />
      : node.type === 'video' ? <Film size={15} /> : <TextChoiceIcon />
  const tryButton = (action: NodeQuickAction, label: string, buttonIcon: React.ReactNode) => <UnstyledButton type="button" className="pc-node-try-action nodrag"
    disabled={data.busy || node.type === 'generation' && (job?.status === 'queued' || job?.status === 'running')}
    onClick={(event) => { event.stopPropagation(); data.onTryAction(node.id, action) }}>{buttonIcon}<span>{label}</span></UnstyledButton>
  const [scriptSection, setScriptSection] = useState<'outline' | 'characters' | 'locations' | 'props' | 'episodes'>('outline')
  const nodeTitle = isProjectScriptRef
    ? (data.scriptTitle || node.title || '项目剧本')
    : profile ? `${profile.name} · ${profile.variant}`
    : node.title || asset?.filename || (node.type === 'generation' ? '生成节点' : node.type === 'image' ? '图片节点' : node.type === 'video' ? '视频节点' : '文本节点')
  const idlePlaceholder = <div className="pc-node-placeholder" aria-label={job?.status === 'running' || job?.status === 'queued' ? '生成中' : recovery?.action === 'verify' ? '原任务待核对' : job?.status === 'failed' ? '生成失败' : '尚未生成'}>
    {job?.status === 'running' || job?.status === 'queued' ? <LoaderCircle size={42} className="pc-spin" />
      : job?.status === 'failed' ? <><CircleAlert size={40} /><span>{canOptimizeImagePrompt(job, data.model?.modality) ? '内容审核拒绝，请调整提示词' : recovery?.canvas || '生成失败，请查看任务记录'}</span>
        {canOptimizeImagePrompt(job, data.model?.modality) && <Button className="nodrag nopan" variant="light" size="xs" disabled={data.busy}
          leftSection={<Sparkles size={14} />} onClick={event => { event.stopPropagation(); data.onOptimizePrompt(node.id) }}>优化提示词</Button>}</>
        : TemplateIcon ? <><TemplateIcon size={46} strokeWidth={1.2} /><span>连接参考图片，制作{visualSettingTemplates[templateKind!].label}图</span></>
          : node.settings.modality === 'video' ? <Film size={54} strokeWidth={1.2} /> : <ImageIcon size={54} strokeWidth={1.2} />}
  </div>
  const generationTryActions = <div className="pc-node-try-list" aria-label="尝试操作">
    <span className="pc-node-try-label">尝试:</span>
    {(node.settings.modality === 'video' ? <>
      {videoQuickModes.includes('reference') && tryButton('video-reference', '多图参考', <ImageIcon size={15} />)}
      {videoQuickModes.includes('first_frame') && tryButton('video-first-frame', videoModeLabel('first_frame'), <ImageIcon size={15} />)}
      {videoQuickModes.includes('first_last_frame') && tryButton('video-first-last', videoModeLabel('first_last_frame'), <ArrowLeftRight size={15} />)}
      {videoQuickModes.includes('extend') && tryButton('video-extend', videoModeLabel('extend'), <Film size={15} />)}
    </> : node.settings.modality === 'image' && imageEditingAvailable ? <>
      {tryButton('image-to-image', '图生图', <ImageIcon size={15} />)}
    </> : null)}
  </div>
  return <>
  <div className={`pc-node pc-node-${node.type}${isMediaResult ? ' pc-node-media-result' : ''}${profile ? ' pc-node-profile' : ''}${data.compact ? ' is-compact' : ''} ${selected ? 'is-selected' : ''}`}>
    {selected && !data.compact && <NodeResizer isVisible minWidth={nodeMinSize(node, asset).width} minHeight={nodeMinSize(node, asset).height} keepAspectRatio={isMediaResult} />}
    <div className="pc-node-label"><span className="pc-node-label-icon">{icon}</span><strong title={nodeTitle}>{nodeTitle}</strong>{nodeDimensionLabel(node, data.model) && <span className="pc-node-dimension">{nodeDimensionLabel(node, data.model)}</span>}</div>
    {!isProjectScriptRef && <Handle className="pc-node-handle" type="target" position={Position.Left} title="连接到此节点" />}
    {isProjectScriptRef ? <div className="pc-project-script-card">
      <div className="pc-project-script-controls nodrag nopan">
        <Button type="button" className="pc-project-script-edit" aria-label="打开剧本对话" onClick={(event) => { event.stopPropagation(); data.onOpenScriptDirector('all') }} data-workspace-control="" variant="subtle">
          <MessageSquare size={14} />{data.scriptExists ? '剧本对话' : '开始创作'}
        </Button>
        {data.scriptExists && <Button type="button" className="pc-project-script-edit" aria-label="编辑剧本" onClick={(event) => { event.stopPropagation(); data.onOpenScriptCreator() }} data-workspace-control="" variant="subtle">
          <PenLine size={14} />编辑
        </Button>}
      </div>
      <div className="pc-project-script-heading">
        <strong>{data.scriptTitle || node.title || '项目剧本'}</strong>
        {data.scriptUpdatedAt && <time>{data.scriptUpdatedAt}</time>}
      </div>
      <Tabs value={scriptSection} onChange={value => { if (value) setScriptSection(value as typeof scriptSection) }} activateTabWithKeyboard={true} className="pc-project-script-tabs-root"><Tabs.List className="pc-project-script-tabs" aria-label="剧本内容分类">
        {([
          ['outline', '故事大纲'], ['characters', '人物小传'], ['locations', '场景设计'], ['props', '道具设计'], ['episodes', '分集剧本'],
        ] as const).map(([value, label]) => <Tabs.Tab key={value} type="button"
          className={scriptSection === value ? 'is-active' : ''} onClick={(event) => { event.stopPropagation(); setScriptSection(value) }} value={value}>{label}</Tabs.Tab>)}
      </Tabs.List></Tabs>
      <div className="pc-project-script-empty nowheel nodrag nopan">
        {(() => {
          if (scriptSection === 'episodes') {
            const episodes = (data.scriptArtifacts || []).filter(item => item.artifact_type === 'episode_script' && (item.episode_number || 0) > 0).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
            return episodes.length ? <div className="pc-script-episodes">{episodes.map(artifact => <UnstyledButton key={artifact.id} type="button" onClick={event => { event.stopPropagation(); data.onOpenScriptDocument?.(artifact) }}><FileText size={16} /><span><strong>{artifact.title}</strong><small>已保存 · 点击编辑本集</small></span><ChevronDown size={14} /></UnstyledButton>)}</div> : <div className="pc-script-empty-state">
              <strong>还没有分集剧本</strong>
              <p>在对话中创作本集，确认保存后即可制作分镜。</p>
              <Button type="button" className="pc-project-script-edit" aria-label="打开分集创作对话" onClick={event => { event.stopPropagation(); data.onOpenScriptDirector('all') }} data-workspace-control="" variant="subtle"><MessageSquare size={14} />打开剧本对话</Button>
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
        {asset ? <div className="pc-node-output"><NodeMedia asset={asset} controls={data.active} previewSize={data.compact ? 320 : 640}
          onMediaSize={isMediaResult ? (width, height) => data.onMediaSize(node.id, asset.id, width, height) : undefined} /></div> : idlePlaceholder}
        {!profile && !templateKind && !selected && !data.compact && !asset && ((node.settings.modality === 'video' && videoQuickModes.some(mode => ['first_frame', 'first_last_frame', 'extend'].includes(mode))) || imageEditingAvailable) && generationTryActions}
      </div>
      {(selected || profile) && <div className={`pc-node-foot ${job ? `pc-job-${job.status}` : ''}`}>
        {profile ? <><span>v{profile.revision} · {job?.status === 'running' || job?.status === 'queued' ? <span className="pc-profile-generating">生成中<span aria-hidden="true" /></span> : job?.status === 'failed' ? '生成失败' : asset && asset.id !== profile.board_asset_id ? '候选待确认' : profile.board_asset_id ? '已确认' : '待生成'}</span><span>{profile.kind === 'character' ? '人物设定' : profile.kind === 'location' ? '场景设定' : '道具设定'}</span></>
          : job ? <><span className="pc-status-dot" />{jobLabels[job.status]}</> : asset ? '已有结果' : templateKind ? `${visualSettingTemplates[templateKind].label} · 图片参考` : '等待配置'}
              </div>}
    </> : node.type === 'video_analysis' ? <>
      <div className="pc-node-content pc-image-analysis-card nodrag nopan nowheel">
        {asset ? <NodeMedia asset={asset} controls={false} previewSize={320} /> : <div className="pc-image-analysis-empty"><Film size={30} /><span>上传视频或连接已有视频节点</span></div>}
        {node.text ? <div className="pc-image-analysis-copy"><CanvasTextPreview text={node.text} /></div> : <p>分析画风、动作与运镜，整理逐镜头视频提示词。</p>}
        <Button variant="light" size="xs" leftSection={<ScanEye size={14} />} onClick={event => { event.stopPropagation(); data.onOpenSettings(node.id) }}>{node.text ? '编辑视频反推' : '配置视频反推'}</Button>
      </div>
      {selected && <div className="pc-node-foot">{node.settings.video_analysis_result ? `${node.settings.video_analysis_result.shots.length} 个镜头 · 提示词可编辑` : '豆包视频理解 · 文本输出'}</div>}
    </> : node.type === 'image_analysis' ? <>
      <div className="pc-node-content pc-image-analysis-card nodrag nopan nowheel">
        {asset ? <img src={asset.url} alt="反推来源图片" draggable={false} /> : <div className="pc-image-analysis-empty"><ScanEye size={30} /><span>上传图片或连接已有图片节点</span></div>}
        {node.text ? <div className="pc-image-analysis-copy"><CanvasTextPreview text={node.text} /></div> : <p>分析画面主体、构图、光线与风格，整理专业生图提示词。</p>}
        <Button variant="light" size="xs" leftSection={<ScanEye size={14} />} onClick={event => { event.stopPropagation(); data.onOpenSettings(node.id) }}>{node.text ? '编辑反推提示词' : '配置图片反推'}</Button>
      </div>
      {selected && <div className="pc-node-foot">{node.text ? '提示词可连接到生成节点' : '图片理解 · 文本输出'}</div>}
    </> : node.type === 'text' ? <>
      {data.active ? <div className="pc-node-content">
        <CanvasTextEditor text={node.text} document={node.settings.text_document} selected
          label="文本节点内容"
          onChange={(text, document) => data.onTextDocumentChange(node.id, text, document)} />
      </div> : <div className="pc-node-content pc-node-preview-content pc-node-idle-content">
        <CanvasTextPreview text={node.text} document={node.settings.text_document} />
      </div>}
      {selected && <div className="pc-node-foot">文本提示词</div>}
    </> : <>
      <div className="pc-node-media"><NodeMedia asset={asset} controls={data.active} previewSize={data.compact ? 320 : 640} /></div>
      {!selected && !data.compact && <div className="pc-node-try-actions pc-node-try-actions-media" aria-label="尝试操作">
        {node.type === 'image' ? imageEditingAvailable && <>{tryButton('image-to-image', '图生图', <ImageIcon size={13} />)}</>
          : <>{videoQuickModes.includes('first_frame') && tryButton('video-first-frame', videoModeLabel('first_frame'), <ImageIcon size={13} />)}{videoQuickModes.includes('first_last_frame') && tryButton('video-first-last', videoModeLabel('first_last_frame'), <ArrowLeftRight size={13} />)}{videoQuickModes.includes('extend') && tryButton('video-extend', videoModeLabel('extend'), <Film size={13} />)}</>}
      </div>}
    </>}
    {!isProjectScriptRef && <Handle className="pc-node-handle" type="source" position={Position.Right} title="从此节点连接" />}
  </div>
  </>
}

const MemoStudioNode = memo(StudioNode, (previous, next) => {
  if (previous.selected !== next.selected) return false
  const { node: previousNode, ...previousData } = previous.data
  const { node: nextNode, ...nextData } = next.data
  // Coordinates belong to React Flow's wrapper; moving a card does not change
  // its content. All display fields, callbacks and selection stay observable.
  return shallowEqual(previousNode, nextNode, ['x', 'y']) && shallowEqual(previousData, nextData)
})
const nodeTypes = { studio: MemoStudioNode }

function ProjectCanvasInner({ detail, models, providers, onRefresh, onRenameProject, onNavigate, onOpenModels, onOpenScriptCreator, onOpenScriptDocument, onOpenSpeech, onOpenScriptDirector: onOpenDirectorPanel, registerNodeProposalActions, initialLocation, onLocationChange, canvas, canvasSession, canvasMenu, registerCanvasActions, onCanvasViewport, optimizedPromptDraft, onOptimizedPromptDraftApplied }: CanvasInstanceProps) {
  const allShots = useMemo(() => allProjectShots(detail), [detail.shots, detail.historical_shots])
  const canvasShots = useMemo(() => canvasDesignShots(detail, canvas.design_id), [allShots, canvas.design_id])
  const browsingDetail = useMemo(() => ({ ...detail, shots: allShots }), [detail, allShots])
  const { confirm, dialog } = useAppDialog()
  const canvasId = canvas.is_default ? undefined : canvas.id
  const storageId = canvas.id === detail.id ? detail.id : `${detail.id}:${canvas.id}`
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const startLocation = useRef(initialLocation)
  const [viewMode, setViewMode] = useState<CanvasView>(initialLocation?.view || 'canvas')
  // Liblib-style left rail: it keeps the canvas graph discoverable while node
  // content and generation settings stay in the canvas itself.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'canvas' | 'assets' | 'profiles'>('canvas')
  const [profileSearch, setProfileSearch] = useState('')
  const [profileFilter, setProfileFilter] = useState<'all' | VisualProfile['kind']>('all')
  const [profileScope, setProfileScope] = useState<'canvas' | 'all'>('canvas')
  const [profileInspectorId, setProfileInspectorId] = useState<string | null>(null)
  const [profileDraftDirty, setProfileDraftDirty] = useState(false)
  const [candidateProfileId, setCandidateProfileId] = useState<string | null>(null)
  const [shotCandidateNodeId, setShotCandidateNodeId] = useState<string | null>(null)
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(canvasSession.selection?.nodeId || null)
  const [composerNodeId, setComposerNodeId] = useState<string | null>(canvasSession.selection?.composerNodeId || null)
  const [optimizationNodeId, setOptimizationNodeId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(canvasSession.selection?.nodeIds || [])
  const [storyboardSelectedId, setStoryboardSelectedId] = useState<string | null>(initialLocation?.storyboardId || null)
  const [storyboardQuery, setStoryboardQuery] = useState('')
  useEffect(() => {
    if (viewMode !== 'storyboard') setStoryboardQuery('')
  }, [viewMode])
  useEffect(() => {
    onLocationChange?.({ view: viewMode, storyboardId: storyboardSelectedId })
  }, [viewMode, storyboardSelectedId, onLocationChange])
  const pendingCanvasFocus = useRef<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(canvasSession.selection?.edgeId || null)
  const [showEdges, setShowEdges] = useState(true)
  const [nodeTypeFilter, setNodeTypeFilter] = useState<NodeTypeFilter>(canvasSession.nodeTypeFilter || 'all')
  const filterNeedsFit = useRef(false)
  const [showMinimap, setShowMinimap] = useState(false)
  const [minimapPosition, setMinimapPosition] = useState<MiniMapPosition | null>(null)
  const [viewportZoom, setViewportZoom] = useState(100)
  const [savedViewport, setSavedViewport] = useState<CanvasViewport | null>(null)
  const [addMenu, setAddMenu] = useState<CanvasAddMenu | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null)
  const [pendingRunNodeId, setPendingRunNodeId] = useState<string | null>(null)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [review, setReview] = useState<GenerationReview | null>(null)
  const [generationSubmissions, setGenerationSubmissions] = useState<Record<string, CanvasGenerationSubmission>>({})
  const recoveringGenerationSubmissionsRef = useRef(new Map<string, Promise<void>>())
  const [referencePreview, setReferencePreview] = useState<Asset | null>(null)
  const [nodeMediaPreview, setNodeMediaPreview] = useState<{ asset: Asset; title: string; shotId?: string | null; initialPanel?: 'review' | 'comparison' } | null>(null)
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
  const [visualTool, setVisualTool] = useState<'create' | 'organize' | 'bindings' | null>(null)
  const [visualBindingContext, setVisualBindingContext] = useState<VisualBindingContext>({})
  const [composerBindingsOpen, setComposerBindingsOpen] = useState(false)
  const composerBindingsTriggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { setComposerBindingsOpen(false) }, [selectedNodeId, composerNodeId, detail.id, viewMode])
  const [visualPanelBusy, setVisualPanelBusy] = useState(false)
  function closeComposerBindings() {
    if (visualPanelBusy) return
    setComposerBindingsOpen(false)
    composerBindingsTriggerRef.current?.focus({ preventScroll: true })
  }
  const [scriptCanvasError, setScriptCanvasError] = useState('')
  const [scriptCanvasRetry, setScriptCanvasRetry] = useState(0)
  const scriptCanvasAttempt = useRef<string | null>(null)
  const previewingRef = useRef(false)
  const [conflictReview, setConflictReview] = useState<ConflictReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [analysisRun, setAnalysisRun] = useState<{ nodeId: string; phase: 'uploading' | 'analyzing'; started: number } | null>(null)
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({})
  const [analysisElapsed, setAnalysisElapsed] = useState(0)
  const [analysisUploads, setAnalysisUploads] = useState<Record<string, Asset>>({})
  const analysisRequestRef = useRef<{ controller: AbortController; nodeId: string } | null>(null)
  useEffect(() => () => { analysisRequestRef.current?.controller.abort() }, [])
  useEffect(() => {
    if (!analysisRun) return
    if (graph && !graph.nodes.some(node => node.id === analysisRun.nodeId)) {
      analysisRequestRef.current?.controller.abort()
      analysisRequestRef.current = null
      setAnalysisRun(null)
      return
    }
    const timer = window.setInterval(() => setAnalysisElapsed(Math.floor((Date.now() - analysisRun.started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [analysisRun, graph])
  const queueRef = useRef<SaveQueue | null>(null)
  const nodeProposalSourcesRef = useRef(new Map<string, SaveQueue>())
  const nodeProposalHandoffRef = useRef(false)
  const applyingNodeProposalRef = useRef<{ id: string; promise: Promise<CanvasNodeProposalApplyResult> } | null>(null)
  const nodeProposalActionsRef = useRef<CanvasNodeProposalActions | null>(null)
  const proposalModelInputsRef = useRef({ models, providers })
  proposalModelInputsRef.current = { models, providers }
  const placementDetailRef = useRef(detail)
  placementDetailRef.current = detail
  const storyboardModelsRef = useRef(models)
  storyboardModelsRef.current = models
  const syncStoryboardGraph = useCallback((value: CanvasGraph) => syncCanvasStoryboardRevision(value,
    allProjectShots(placementDetailRef.current), storyboardModelsRef.current, placementDetailRef.current.assets), [])
  const historyRef = useRef<{ past: CanvasGraph[]; future: CanvasGraph[] }>(canvasSession.history)
  // React Flow emits many position changes while a node is dragged. Keep one
  // undo checkpoint for the complete gesture so history and autosave remain
  // useful on a large canvas.
  const dragSnapshotRef = useRef<CanvasGraph | null>(null)
  const [, setHistoryTick] = useState(0)
  canvasSession.history = historyRef.current
  canvasSession.nodeTypeFilter = nodeTypeFilter
  canvasSession.selection = { nodeId: selectedNodeId, nodeIds: selectedNodeIds, edgeId: selectedEdgeId, composerNodeId }
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
  const submittedReferenceJobs = useRef(new Map<string, string[]>())
  const [persistentReferenceBatch, setPersistentReferenceBatch] = useState<ReferenceBatchState | null>(null)
  const referenceBatchPlanRef = useRef<ReferenceBatchState | null>(null)
  const [referenceBatch, setReferenceBatch] = useState<{ targetId: string; submitting: boolean; queued: number;
    failures: Array<{ profileId: string; name: string; message: string }> } | null>(null)
  const [referenceConfirmation, setReferenceConfirmation] = useState<{ targetId: string; confirmed: number;
    skipped: Array<{ profile_id: string; name: string; message: string }> } | null>(null)
  const removalPendingRef = useRef(false)
  const { fitView, screenToFlowPosition, setCenter, setViewport, zoomTo, getInternalNode } = useReactFlow<FlowNode, Edge>()
  const [selectionRevision, setSelectionRevision] = useState(0)

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
  const magnetFrameRef = useRef<number | null>(null)
  const clearConnectionMagnet = useCallback(() => {
    if (magnetFrameRef.current !== null) window.cancelAnimationFrame(magnetFrameRef.current)
    magnetFrameRef.current = null
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
    // Read all bounds before changing styles, avoiding alternating layout
    // reads and writes while the pointer passes several ports.
    const measured = Array.from(handles, handle => ({ handle, rect: handle.getBoundingClientRect() }))
    measured.forEach(({ handle, rect }) => {
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
      const x = `${handle.classList.contains('react-flow__handle-left') ? Math.min(0, pullX) : Math.max(0, pullX)}px`
      const y = `${Math.max(-18, Math.min(18, deltaY * scale))}px`
      if (handle.style.getPropertyValue('--pc-magnet-x') !== x) handle.style.setProperty('--pc-magnet-x', x)
      if (handle.style.getPropertyValue('--pc-magnet-y') !== y) handle.style.setProperty('--pc-magnet-y', y)
    })
  }, [clearConnectionMagnet])

  const pendingMagnetRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)
  const scheduleConnectionMagnet = useCallback((x: number, y: number, target: EventTarget | null) => {
    pendingMagnetRef.current = { x, y, target }
    if (magnetFrameRef.current !== null) return
    magnetFrameRef.current = window.requestAnimationFrame(() => {
      magnetFrameRef.current = null
      const pending = pendingMagnetRef.current
      if (pending) updateConnectionMagnet(pending.x, pending.y, pending.target)
    })
  }, [updateConnectionMagnet])
  useEffect(() => () => {
    if (magnetFrameRef.current !== null) window.cancelAnimationFrame(magnetFrameRef.current)
  }, [])

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
      if (event.buttons && !magnetConnection) clearConnectionMagnet()
      else scheduleConnectionMagnet(event.clientX, event.clientY, event.target)
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
    keepMiniMapPosition(storageId, next)
  }, [detail.id, clearConnectionMagnet, scheduleConnectionMagnet])

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
          const saved = normalizeGraph(await saveCanvas(queue.id, { ...snapshot, revision: queue.base.revision }, queue.canvasId))
          queue.base = saved
          queue.graph = { ...queue.graph, revision: saved.revision }
          queue.savedSerial = serial
          if (queue.savedSerial === queue.serial) clearDraft(queue.storageId)
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

  const changeGraph = useCallback((updater: (current: CanvasGraph) => CanvasGraph, options?: { freezeLegacyReferences?: boolean }) => {
    const queue = queueRef.current
    if (!queue || queue.id !== detail.id) return
    const stable = options?.freezeLegacyReferences === false ? queue.graph : freezeLegacyPromptReferenceDrafts(queue.graph, placementDetailRef.current, models)
    const candidate = ensureCanvasScript(syncStoryboardGraph(disconnectRemovedPromptReplacements(queue.graph, updater(stable))), canvas.id, placementDetailRef.current.name,
      queue.graph.nodes.find(node => node.type === 'project_script_ref'))
    const nodes = placeNewCanvasNodes(queue.graph.nodes, candidate.nodes,
      node => nodeSize(node, visualNodeAsset(node, placementDetailRef.current)))
    const updated = nodes === candidate.nodes ? candidate : { ...candidate, nodes }
    // Keep the project script card independent even when an older action or a
    // restored draft tries to reintroduce a script edge.
    const scriptNodeIds = new Set(updated.nodes.filter((node) => node.type === 'project_script_ref').map((node) => node.id))
    const next = scriptNodeIds.size
      ? { ...updated, edges: updated.edges.filter((edge) => !scriptNodeIds.has(edge.source) && !scriptNodeIds.has(edge.target)) }
      : updated
    if (next === queue.graph || sameCanvasContent(next, queue.graph)) return
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
  }, [detail.id, canvas.id, scheduleSave, syncStoryboardGraph, models])

  useEffect(() => {
    let active = true
    const rememberedSelection = canvasSession.selection
    setViewMode(startLocation.current?.view || 'canvas')
    const rememberedViewport = readCanvasViewport(storageId) || canvas.viewport
    setSavedViewport(rememberedViewport)
    setViewportZoom(Math.round((rememberedViewport?.zoom || 1) * 100))
    setMinimapPosition(readMiniMapPosition(storageId))
    setShowMinimap(false)
    setShowEdges(true)
    dragSnapshotRef.current = null
    initialViewApplied.current = false
    historyRef.current = canvasSession.history
    setHistoryTick((value) => value + 1)
    setGraph(null)
    setProfileInspectorId(null); setVisualTool(null); setVisualPanelBusy(false); setProfileDraftDirty(false)
    setSelectedNodeId(null)
    setSelectedNodeIds([])
    setSelectedEdgeId(null)
    setReferenceReturnNodeId(null)
    setLoadError(null)
    setSaveState('saved')
    void api<CanvasGraph>(canvasGraphPath(detail.id, canvasId)).then((value) => {
      if (!active) return
      const remote = normalizeGraph(value)
      if (canvasSession.revision && canvasSession.revision !== remote.revision) {
        historyRef.current = { past: [], future: [] }; canvasSession.history = historyRef.current
      }
      const removedScriptEdges = remote.edges.length !== value.edges.length
      const draft = readDraft(storageId)
      const queue: SaveQueue = { id: detail.id, canvasId, storageId, graph: remote, base: remote, serial: 0, savedSerial: 0,
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
      } else if (draft) clearDraft(storageId)
      const withScript = ensureCanvasScript(syncStoryboardGraph(queue.graph), canvas.id, detail.name)
      const addedScript = withScript !== queue.graph
      queue.graph = withScript
      queueRef.current = queue
      setGraph(queue.graph)
      setGenerationSubmissions({})
      void recoverSavedGenerationSubmissions(queue)
      const selection = rememberedSelection
      if (selection) {
        const ids = new Set(queue.graph.nodes.map(node => node.id))
        setSelectedNodeId(selection.nodeId && ids.has(selection.nodeId) ? selection.nodeId : null)
        setSelectedNodeIds(selection.nodeIds.filter(id => ids.has(id)))
        setSelectedEdgeId(selection.edgeId && queue.graph.edges.some(edge => edge.id === selection.edgeId) ? selection.edgeId : null)
        setComposerNodeId(selection.composerNodeId && ids.has(selection.composerNodeId) ? selection.composerNodeId : null)
      }
      // Persist missing project cards and old script-edge cleanup once. The
      // card references shared project documents; it never imports old shots.
      if ((removedScriptEdges || addedScript) && !queue.conflict) {
        queue.serial = Math.max(queue.serial, 1)
        keepDraft(queue)
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
  }, [detail.id, flush, scheduleSave, syncStoryboardGraph])

  useEffect(() => {
    const recover = (event?: Event) => {
      const key = event && 'key' in event ? (event as StorageEvent).key : null
      if (key && !key.startsWith(canvasGenerationSubmissionStoragePrefix)) return
      const queue = queueRef.current
      if (queue && document.visibilityState !== 'hidden') void recoverSavedGenerationSubmissions(queue)
    }
    window.addEventListener('storage', recover)
    window.addEventListener('online', recover)
    document.addEventListener('visibilitychange', recover)
    return () => {
      window.removeEventListener('storage', recover)
      window.removeEventListener('online', recover)
      document.removeEventListener('visibilitychange', recover)
    }
  }, [detail.id, canvas.id])

  useEffect(() => {
    if (graph && syncStoryboardGraph(graph) !== graph) changeGraph(syncStoryboardGraph)
  }, [detail.shots, detail.historical_shots, graph, changeGraph, syncStoryboardGraph])

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
        if (!live || !asset || !canvasJobMatchesStoryboard(live, job)) continue
        if (live.settings.visual_profile_id) {
          const profile = detail.visual_profiles?.find(item => item.id === live.settings.visual_profile_id)
          if (profile && live.settings.visual_completed_job_id !== job?.id) {
            nodes[nodes.indexOf(live)] = { ...live, asset_id: visualJobRequest(job).auto_confirm_first && profile.board_asset_id ? profile.board_asset_id : asset.id,
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
        // Consume a media completion once. Later graph refreshes must preserve
        // an explicitly selected historical candidate on this generator.
        if (live.type === 'generation' && (asset.kind === 'image' || asset.kind === 'video') && live.settings.generation_completed_job_id === job?.id) continue
        if (live.asset_id === asset.id) continue
        if (live.type === 'text') {
          if (asset.kind !== 'text') continue
          nodes[nodes.indexOf(live)] = { ...live, asset_id: asset.id, text: asset.text || '',
            settings: { ...live.settings, text_mode: 'write' } }
          changed = true
          continue
        }
        nodes[nodes.indexOf(live)] = { ...live, asset_id: asset.id,
          settings: { ...live.settings, ...((asset.kind === 'image' || asset.kind === 'video') ? { generation_completed_job_id: job!.id } : {}) } }
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
  const assetLabels = useMemo(() => assetPresentations(browsingDetail, graph?.nodes), [browsingDetail, graph?.nodes])
  const shotMap = useMemo(() => new Map(allShots.map((shot) => [shot.id, shot])), [allShots])
  const jobMap = useMemo(() => new Map(detail.jobs.map((job) => [job.id, job])), [detail.jobs])
  const modelMap = useMemo(() => new Map(models.map((model) => [model.id, model])), [models])
  const profileMap = useMemo(() => new Map((detail.visual_profiles || []).map(profile => [profile.id, profile])), [detail.visual_profiles])
  const availableModels = useMemo(() => orderModelsByDefault(models.filter((model) => model.modality !== 'text' && model.enabled &&
    providers.some((provider) => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))), [models, providers])
  const visionModels = useMemo(() => orderModelsByDefault(models.filter(model => model.enabled && supportsImagePromptAnalysis(model)
    && providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))), [models, providers])
  const reviewModels = useMemo(() => videoReviewModels(models, providers), [models, providers])
  const analysisDetail = useMemo(() => ({ ...detail, assets: [...detail.assets, ...Object.values(analysisUploads).filter(asset => !detail.assets.some(item => item.id === asset.id))] }), [detail, analysisUploads])
  const videoAnalysisOptions = useMemo(() => orderModelsByDefault(videoAnalysisModels(models, providers)), [models, providers])
  const videoAnalysis = useCanvasVideoAnalysis({ detail, canvasId: canvas.id, graph, getGraph: () => queueRef.current?.graph, models: videoAnalysisOptions,
    changeGraph, refresh: onRefresh, notice: setNotice })
  const nodeModelOptions = useMemo(() => {
    const options = availableModels.map(model => ({ value: model.id, label: model.name }))
    return { all: options, image: options.filter(option => modelMap.get(option.value)?.modality === 'image'),
      video: options.filter(option => modelMap.get(option.value)?.modality === 'video'), text: [] }
  }, [availableModels, modelMap])
  const videoQuickModes = useMemo(() => [...new Set(availableModels.filter(model => model.modality === 'video').flatMap(model => supportedModes(model)))], [availableModels])
  const imageEditingModels = useMemo(() => availableModels.filter(model => model.modality === 'image' && ['image', 'images', 'image_references'].some(field => usesModelParameter(model, field))).map(model => model.id), [availableModels])
  const updateNodeById = useCallback((id: string, patch: Partial<CanvasNode>) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }))
  }, [changeGraph])
  const updateNodeSettingsById = useCallback((id: string, patch: Partial<CanvasNode['settings']>) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id
      ? { ...node, settings: { ...node.settings, ...patch } } : node) }))
  }, [changeGraph])
  const editNodePrompt = useCallback((id: string, value: string, prepared?: { base: string; template: string; document?: PromptSectionDocument }) => {
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id
      ? { ...node, text: value, settings: { ...node.settings, prompt_override: true,
        ...(prepared ? { prompt_is_final: true, prompt_document: true, prompt_body: extractPromptBody({ prompt: value, prompt_template: prepared.template }),
          prompt_sections: prepared.document ?? parsePromptSectionDocument(value, {
            sourceText: prepared.template, previousDocument: node.settings.prompt_sections }),
          prompt_base: prepared.base, prompt_template: prepared.template } : {}) } } : node) }))
  }, [changeGraph])
  const selectNodeModel = useCallback((id: string, modelId: string) => {
    const model = modelMap.get(modelId)
    const modes = supportedModes(model)
    const imageDefaults = imageGenerationDefaults(model)
    changeGraph((current) => ({ ...current, nodes: current.nodes.map((node) => {
      if (node.id !== id) return node
      const mode = node.settings.mode && (!model || modes.includes(node.settings.mode)) ? node.settings.mode : modes[0] || 'text'
      return { ...node, model_id: modelId || null, settings: { ...node.settings,
        modality: model?.modality || node.settings.modality,
        mode,
        ...(model?.modality === 'video' && mode !== node.settings.mode ? { visual_reference_mode: mode === 'reference' ? 'profiles'
          : ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode) ? 'keyframe' : 'text_only' } : {}),
        duration: model?.modality === 'video' ? modelDuration(model, node.settings.duration || shotMap.get(node.shot_id || '')?.duration || 5) : node.settings.duration,
        resolution: model?.modality === 'text' ? null : model?.modality === 'image'
          ? modelResolutions(model).includes(node.settings.resolution || '') ? node.settings.resolution : imageDefaults.resolution
          : modelDefaultResolution(model, modelResolutions(model)) || null,
        clarity: model?.modality === 'image' ? imageParameterValue(model, 'clarity', node.settings.clarity || imageResolutionClarity(node.settings.resolution) || imageDefaults.clarity) : undefined,
        quality: model?.modality === 'image' ? imageParameterValue(model, 'quality', node.settings.quality || imageDefaults.quality) : undefined,
        background: model?.modality === 'image' ? imageParameterValue(model, 'background', node.settings.background || imageDefaults.background) : undefined,
        ratio: modelRatios(model).includes(node.settings.ratio || '') ? node.settings.ratio
          : model?.modality === 'image' ? imageDefaults.ratio : modelRatios(model).includes(detail.ratio) ? detail.ratio : modelRatios(model)[0], draft: false } }
    }) }))
  }, [changeGraph, modelMap, shotMap, detail.ratio])
  const selectNodeVideoMode = useCallback((id: string, mode: CanvasMode) => {
    const current = queueRef.current?.graph
    const node = current?.nodes.find(item => item.id === id)
    if (!current || !node) return
    const job = detail.jobs.find(item => item.id === node.job_id)
    if (busy || job?.status === 'queued' || job?.status === 'running') return
    const images = current.edges.filter(edge => edge.target === id).flatMap(edge => {
      const source = current.nodes.find(item => item.id === edge.source)
      if (!source || node.type !== 'generation' && source.type === 'generation') return []
      const asset = visualNodeAsset(pinnedCanvasReference(source, edge.reference_asset_id), detail, true)
      return asset?.kind === 'image' ? [asset] : []
    })
    const storyboard = node.settings.storyboard_reference_asset_id
      || (node.shot_id ? images.find(asset => asset.shot_id === node.shot_id)?.id : undefined) || images[0]?.id
    updateNodeSettingsById(id, { mode,
      visual_reference_mode: mode === 'reference' ? 'profiles' : ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode) ? 'keyframe' : 'text_only',
      ...(storyboard ? { storyboard_reference_asset_id: storyboard } : {}),
    })
  }, [busy, detail, updateNodeSettingsById])
  const tryNodeAction = useCallback(async (sourceId: string, action: NodeQuickAction) => {
    if (busy) {
      setNotice('请等待当前操作完成')
      return
    }
    const source = queueRef.current?.graph.nodes.find((node) => node.id === sourceId)
    if (!source) return
    if (['video-first-frame', 'video-reference'].includes(action) && !source.settings.visual_profile_id && visualNodeAsset(source, detail)?.kind === 'image') {
      try {
        const current = queueRef.current!.graph
        const handoff = createImageVideoHandoff(current, source, detail, availableModels,
          blankNode('generation', source.x + source.width + 170, source.y), crypto.randomUUID(), action === 'video-reference' ? 'reference' : 'first_frame')
        changeGraph(() => handoff.graph)
        setViewMode('canvas')
        focusSidebarNode(handoff.nodeId)
        const target = handoff.graph.nodes.find(node => node.id === handoff.nodeId)
        setNotice(handoff.updated ? '最新图片调整已同步到视频；检查动作与运镜后生成'
          : handoff.created && handoff.preserved ? '已保留原视频节点并创建新视频，已承接最新图片调整；检查动作与运镜后生成'
          : handoff.created ? target?.settings.mode === 'reference'
            ? '已创建多图参考视频节点，已承接最新图片调整；分镜图仅作构图参考，请用提示词设计开场、动作和收镜'
            : '已创建首帧视频节点，已承接最新图片调整；检查动作与运镜后生成'
          : '已定位使用这张分镜图的视频节点')
      } catch (issue) { showError(issue) }
      return
    }
    if (source.type === 'generation' && action.startsWith('video-') && !source.asset_id) {
      const mode = action === 'video-reference' ? 'reference' : action === 'video-first-frame' ? 'first_frame' : action === 'video-first-last' ? 'first_last_frame' : 'extend'
      const job = detail.jobs.find(item => item.id === source.job_id)
      if (job?.status === 'queued' || job?.status === 'running') return
      selectNodeVideoMode(source.id, mode)
      setComposerNodeId(source.id)
      setSelectedNodeId(source.id); setSelectedNodeIds([source.id])
      setNotice(mode === 'reference' ? '按镜头出镜范围添加参考图，再设计开场、动作与收镜' : mode === 'first_frame' ? '通过参考添加1张首帧图片' : mode === 'first_last_frame' ? '通过参考按顺序添加首帧和尾帧图片' : '请添加参考视频地址')
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
    node.title = videoModeLabel(action === 'video-reference' ? 'reference' : action === 'video-first-frame' ? 'first_frame' : action === 'video-first-last' ? 'first_last_frame' : 'extend')
    node.settings = { modality, ratio: detail.ratio, visual_reference_mode: action === 'video-reference' ? 'profiles' : 'keyframe',
      ...(action === 'video-reference' ? { mode: 'reference' as CanvasMode } : {}),
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
  }, [busy, changeGraph, detail, models, providers, onRefresh, showError, selectNodeVideoMode])
  const selectNodeForView = useCallback((id: string) => {
    setComposerNodeId(id)
    setSelectedNodeId(id)
    setSelectedNodeIds([id])
    setSelectedEdgeId(null)


  }, [])
  const fitNodeToMedia = useCallback((id: string, assetId: string, width: number, height: number) => {
    changeGraph(current => {
      const node = current.nodes.find(item => item.id === id)
      if (!node || node.type !== 'generation' || visualNodeAsset(node, detail)?.id !== assetId) return current
      const size = fitImageNode(node, { width, height })
      return size === node ? current : { ...current, nodes: current.nodes.map(item => item.id === id ? { ...item, ...size } : item) }
    })
  }, [changeGraph, detail])
  const nodeActions = {
    onPromptChange: editNodePrompt,
    onOptimizePrompt: (id: string) => { selectNodeForView(id); setOptimizationNodeId(id) },
    onTextChange: (id: string, value: string) => updateNodeById(id, { text: value }),
    onTextDocumentChange: (id: string, text: string, document: JSONContent) => changeGraph(current => ({
      ...current, nodes: current.nodes.map(item => item.id === id
        ? { ...item, text, settings: { ...item.settings, text_document: document } } : item),
    })),
    onModelChange: selectNodeModel, onSettingsChange: updateNodeSettingsById, onOpenSettings: selectNodeForView,
    onRun: (id: string) => { setComposerNodeId(id); setSelectedNodeId(id); setSelectedNodeIds([id]); setSelectedEdgeId(null); setPendingRunNodeId(id) },
    onTryAction: tryNodeAction, onMediaSize: fitNodeToMedia,
    onOpenScriptDirector: openScriptDirector, onOpenScriptCreator,
    onOpenScriptDocument: (artifact: ScriptArtifact) => onOpenScriptDocument?.(artifact),
  }
  const latestNodeActions = useRef(nodeActions)
  useLayoutEffect(() => { latestNodeActions.current = nodeActions })
  const nodeCallbacks = useMemo(() => ({
    onPromptChange: (...args: Parameters<typeof nodeActions.onPromptChange>) => latestNodeActions.current.onPromptChange(...args),
    onOptimizePrompt: (id: string) => latestNodeActions.current.onOptimizePrompt(id),
    onTextChange: (...args: Parameters<typeof nodeActions.onTextChange>) => latestNodeActions.current.onTextChange(...args),
    onTextDocumentChange: (...args: Parameters<typeof nodeActions.onTextDocumentChange>) => latestNodeActions.current.onTextDocumentChange(...args),
    onModelChange: (...args: Parameters<typeof nodeActions.onModelChange>) => latestNodeActions.current.onModelChange(...args),
    onSettingsChange: (...args: Parameters<typeof nodeActions.onSettingsChange>) => latestNodeActions.current.onSettingsChange(...args),
    onOpenSettings: (...args: Parameters<typeof nodeActions.onOpenSettings>) => latestNodeActions.current.onOpenSettings(...args),
    onRun: (...args: Parameters<typeof nodeActions.onRun>) => latestNodeActions.current.onRun(...args),
    onTryAction: (...args: Parameters<typeof nodeActions.onTryAction>) => latestNodeActions.current.onTryAction(...args),
    onMediaSize: (...args: Parameters<typeof nodeActions.onMediaSize>) => latestNodeActions.current.onMediaSize(...args),
    onOpenScriptDirector: (...args: Parameters<typeof nodeActions.onOpenScriptDirector>) => latestNodeActions.current.onOpenScriptDirector(...args),
    onOpenScriptCreator: () => latestNodeActions.current.onOpenScriptCreator(),
    onOpenScriptDocument: (artifact: ScriptArtifact) => latestNodeActions.current.onOpenScriptDocument(artifact),
  }), [])
  const promptIndex = useMemo(() => graph ? canvasPromptIndex(graph, allShots) : null, [graph, allShots])
  const scriptInputPrompt = useMemo(() => scriptPrompt(detail.script), [detail.script])
  const referenceKey = useMemo(() => canvasReferenceKey(graph?.nodes || []), [graph?.nodes])
  const automaticReferenceEdges = useMemo(() => graph ? automaticVisualReferenceEdges(graph, detail, models) : [], [referenceKey, graph?.edges, detail.assets, detail.visual_profiles, detail.shot_visual_bindings, models])
  const virtualizeCanvas = useMemo(() => shouldVirtualizeCanvas(graph?.nodes || [], (graph?.edges.length || 0) + automaticReferenceEdges.length), [graph?.nodes, graph?.edges.length, automaticReferenceEdges.length])
  const compactNodes = virtualizeCanvas && viewportZoom <= compactCanvasZoom
  const nodeCategories = useMemo(() => new Map((graph?.nodes || []).map(node =>
    [node.id, canvasNodeCategory(node, modelMap, assetMap)])), [graph?.nodes, modelMap, assetMap])
  const visibleNodeIds = useMemo(() => new Set((graph?.nodes || []).filter(node =>
    nodeTypeFilter === 'all' || nodeCategories.get(node.id) === nodeTypeFilter).map(node => node.id)),
  [graph?.nodes, nodeCategories, nodeTypeFilter])
  const nodeTypeCounts = useMemo(() => {
    const counts: Record<NodeTypeFilter, number> = { all: nodeCategories.size, image: 0, video: 0, text: 0, project_script_ref: 0 }
    for (const category of nodeCategories.values()) counts[category] += 1
    return counts
  }, [nodeCategories])
  const selectedIds = useMemo(() => new Set([...selectedNodeIds, ...(selectedNodeId ? [selectedNodeId] : [])]), [selectedNodeId, selectedNodeIds])
  const hasSelectableCanvasNodes = graph?.nodes.some(node => node.type !== 'project_script_ref' && visibleNodeIds.has(node.id)) || false
  const hasRemovableCanvasContent = !!graph?.edges.length || graph?.nodes.some(node => node.type !== 'project_script_ref') || false
  useEffect(() => {
    if (viewMode !== 'canvas' || nodeTypeFilter === 'all' || !selectedNodeId || !nodeCategories.has(selectedNodeId)) return
    // Explicit navigation and newly created nodes must always reveal their target.
    // Changing the filter itself prunes hidden selections before this effect runs.
    if (!visibleNodeIds.has(selectedNodeId)) setNodeTypeFilter('all')
  }, [viewMode, nodeTypeFilter, selectedNodeId, nodeCategories, visibleNodeIds])
  useEffect(() => {
    if (!filterNeedsFit.current || viewMode !== 'canvas') return
    if (!visibleNodeIds.size) { filterNeedsFit.current = false; return }
    const frame = window.requestAnimationFrame(() => {
      filterNeedsFit.current = false
      void fitView({ nodes: [...visibleNodeIds].map(id => ({ id })), padding: 0.18, duration: 260 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [nodeTypeFilter, visibleNodeIds, viewMode, fitView])
  const scriptNodeData = useMemo(() => ({
    scriptSceneCount: detail.script?.scenes?.length || 0,
    scriptDuration: detail.script?.scenes?.reduce((sum, scene) => sum + (scene.duration || 0), 0) || 0,
    scriptOutline: detail.script?.outline || '', scriptArtifacts: detail.script?.artifacts || [],
    scriptTitle: detail.name || '项目剧本', scriptUpdatedAt: scriptUpdatedLabel(detail),
    scriptExists: !!(detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length),
  }), [detail.script, detail.name, detail.brief, detail.updated_at])
  const flowNodesRef = useRef<FlowNode[]>([])
  const flowNodes = useMemo<FlowNode[]>(() => {
    const previousNodes = flowNodesRef.current
    const previousById = new Map(previousNodes.map(node => [node.id, node]))
    const next = (graph?.nodes || []).map((node) => {
      const profile = profileMap.get(node.settings.visual_profile_id || '')
      const displayedAssetId = profile ? node.asset_id || profile.board_asset_id : node.settings.visual_profile_id ? null : node.asset_id
      const analysisSource = node.type === 'image_analysis' && graph ? resolveCanvasImageAnalysisSource(node, graph, analysisDetail)
        : node.type === 'video_analysis' && graph ? resolveCanvasVideoAnalysisSource(node, graph, videoAnalysis.detail) : undefined
      const displayedAsset = node.type === 'image_analysis' ? analysisDetail.assets.find(asset => asset.id === analysisSource?.assetId)
        : node.type === 'video_analysis' ? videoAnalysis.detail.assets.find(asset => asset.id === analysisSource?.assetId) : assetMap.get(displayedAssetId || '')
      const { width, height } = nodeSize(node, displayedAsset)
      const selected = visibleNodeIds.has(node.id) && selectedIds.has(node.id)
      const active = selected && selectedIds.size === 1 && !nodeMediaPreview && !shotCandidateNodeId
      const modality = node.settings.modality || (node.type === 'image' ? 'image' : node.type === 'video' ? 'video' : undefined)
      const next = reuseFlowNode(previousById.get(node.id), {
        id: node.id, type: 'studio', position: { x: node.x, y: node.y },
        // React Flow uses these persisted dimensions to retain handle bounds
        // and visibility when controlled nodes update.
        width, height, measured: { width, height }, style: { width, height }, selected, hidden: !visibleNodeIds.has(node.id),
        deletable: node.type !== 'project_script_ref',
        data: {
          node, active, compact: compactNodes && !active, asset: displayedAsset, profile, shot: shotMap.get(node.shot_id || ''),
          job: jobMap.get(node.job_id || ''), model: modelMap.get(node.model_id || ''), videoQuickModes, imageEditingModels,
          promptText: promptIndex ? indexedCanvasPrompt(node, promptIndex, () => scriptInputPrompt) : '',
          modelOptions: nodeModelOptions[modality || 'all'], busy, ...nodeCallbacks,
          ...(node.type === 'project_script_ref' ? scriptNodeData : {}),
        },
      })
      // Box selection updates React Flow's internal selection before notifying
      // us. Resend rejected selections even if our controlled props are equal.
      const internal = getInternalNode(node.id)
      return internal && !!internal.selected !== selected ? { ...next } : next
    })
    const result = previousNodes.length === next.length && next.every((node, index) => node === previousNodes[index]) ? previousNodes : next
    return result
  }, [graph, selectedIds, selectionRevision, visibleNodeIds, nodeMediaPreview, shotCandidateNodeId, compactNodes, promptIndex, scriptInputPrompt, profileMap, assetMap, analysisDetail, videoAnalysis.detail, shotMap, jobMap, modelMap, busy, videoQuickModes, imageEditingModels, nodeModelOptions, nodeCallbacks, scriptNodeData, getInternalNode])
  useLayoutEffect(() => { flowNodesRef.current = flowNodes }, [flowNodes])
  const automaticReferenceEdgeIds = useMemo(() => new Set(automaticReferenceEdges.map(edge => edge.id)), [automaticReferenceEdges])
  const flowEdgesRef = useRef<Edge[]>([])
  const flowEdges = useMemo<Edge[]>(() => {
    const previousEdges = flowEdgesRef.current
    const previousById = new Map(previousEdges.map(edge => [edge.id, edge]))
    const next = [...(graph?.edges || []), ...automaticReferenceEdges].map((edge) => {
      const automatic = automaticReferenceEdgeIds.has(edge.id)
      const visible = showEdges && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
      const selected = visible && edge.id === selectedEdgeId
      const related = selectedIds.has(edge.source) || selectedIds.has(edge.target)
      return reuseFlowEdge(previousById.get(edge.id), {
        ...edge,
        type: 'studio',
        data: { ...(edge as Edge & { data?: Record<string, unknown> }).data, related, visualBinding: automatic,
          motion: visible && (selected || related && selectedIds.size === 1) },
        selectable: !automatic,
        deletable: !automatic,
        ariaLabel: automatic ? '设定参考图连接，点击调整镜头视觉设定' : undefined,
        selected,
        // Focused links paint above idle links, while node cards stay above both.
        zIndex: selected ? 0 : related ? -1 : -2,
        animated: false,
        hidden: !visible,
        className: `pc-flow-edge${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}`,
        style: {
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
        },
      })
    })
    return previousEdges.length === next.length && next.every((edge, index) => edge === previousEdges[index]) ? previousEdges : next
  }, [graph?.edges, automaticReferenceEdges, automaticReferenceEdgeIds, selectedEdgeId, selectedIds, showEdges, visibleNodeIds])
  useLayoutEffect(() => { flowEdgesRef.current = flowEdges }, [flowEdges])
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId)
  const selectedCanvasNodeIds = useMemo(() => {
    const ids = new Set(selectedNodeIds)
    if (selectedNodeId) ids.add(selectedNodeId)
    return graph?.nodes.filter(node => ids.has(node.id) && (viewMode !== 'canvas' || visibleNodeIds.has(node.id))).map(node => node.id) || []
  }, [graph?.nodes, selectedNodeId, selectedNodeIds, viewMode, visibleNodeIds])
  const selectedProfile = detail.visual_profiles?.find(item => item.id === selectedNode?.settings.visual_profile_id)
  const selectedTemplateKind = !selectedProfile && selectedNode?.type === 'generation' && selectedNode.settings.modality === 'image'
    ? selectedNode.settings.visual_template_kind : undefined
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
    || profileJobs.some(job => job.status === 'queued' || job.status === 'running')
    || !!selectedProfile && !!visualReferenceGenerating(selectedProfile, selectedNode, detail, submittedReferenceJobs.current.get(selectedProfile.id)))
  const selectedProfileNeedsReview = selectedProfile?.board_style_status === 'needs_review'
    || selectedProfile?.base_reference_status === 'needs_review' || selectedProfile?.base_reference_status === 'waiting'
  const selectedProfileBoardStatus = selectedNodeGenerating ? '生成中'
    : selectedBoardAsset && selectedBoardAsset.id === selectedProfile?.board_asset_id ? selectedProfileNeedsReview ? '需复核' : '已确认'
      : selectedBoardAsset ? '候选待确认' : '待生成'
  const selectedShot = shotMap.get(selectedNode?.shot_id || '')
  const shotCandidateModality = (selectedNode?.settings.modality || modelMap.get(selectedNode?.model_id || '')?.modality) === 'video' ? 'video' : 'image'
  const shotCandidates = useMemo(() => shotMediaCandidates(selectedShot?.id, detail, shotCandidateModality),
    [selectedShot?.id, detail.id, detail.assets, detail.jobs, shotCandidateModality])
  const shotCandidateNode = graph?.nodes.find(node => node.id === shotCandidateNodeId && node.type === 'generation' && !node.settings.visual_profile_id)
  const candidateShot = shotMap.get(shotCandidateNode?.shot_id || '')
  const managedShotModality = (shotCandidateNode?.settings.modality || modelMap.get(shotCandidateNode?.model_id || '')?.modality) === 'video' ? 'video' : 'image'
  const managedShotCandidates = useMemo(() => shotMediaCandidates(candidateShot?.id, detail, managedShotModality),
    [candidateShot?.id, detail.id, detail.assets, detail.jobs, managedShotModality])
  const managedShotJob = jobMap.get(shotCandidateNode?.job_id || '')
  const managedShotGenerating = managedShotJob?.status === 'queued' || managedShotJob?.status === 'running'
  const protectedShotCandidateIds = [...new Set([
    ...(graph?.nodes.filter(node => node.shot_id === candidateShot?.id).map(node => node.asset_id).filter((id): id is string => !!id) || []),
    ...(candidateShot?.selected_asset_id ? [candidateShot.selected_asset_id] : []),
  ])]
  const allVisualBindings = (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === selectedShot?.id)
  const missingReferences = useMemo(() => graph && selectedNode ? missingVisualReferences(graph, selectedNode.id, detail, models) : [], [graph, selectedNode, detail, models])
  const referenceGenerating = new Map(missingReferences.map(reference => {
    const profile = profileMap.get(reference.profileId)
    return [reference.profileId, profile ? visualReferenceGenerating(profile, graph?.nodes.find(node => node.settings.visual_profile_id === profile.id),
      detail, submittedReferenceJobs.current.get(profile.id)) : null]
  }))
  const referencesToGenerate = missingReferences.filter(reference => reference.action === 'generate' && !referenceGenerating.get(reference.profileId))
  const referencesToConfirm = missingReferences.filter(reference => reference.action === 'confirm' && !profileMap.get(reference.profileId)?.board_asset_id && !referenceGenerating.get(reference.profileId))
  const referenceReturnNode = graph?.nodes.find(node => node.id === referenceReturnNodeId)
  const visualReferenceMode = selectedNode?.settings.visual_reference_mode || 'profiles'
  const selectedModel = modelMap.get(selectedNode?.model_id || '')
  const selectedJobRecovery = selectedJob && jobRecoveryPresentation(selectedJob, selectedModel?.modality)
  const composerModel = selectedModel
  const composerModelId = selectedNode?.model_id || ''
  const composerModality: CanvasModality | undefined = selectedNode?.type === 'generation'
    ? selectedNode.settings.modality || composerModel?.modality
    : composerModel?.modality || (selectedNode?.type === 'image' ? 'image' : selectedNode?.type === 'video' ? 'video' : undefined)
  const visualBindings = visualBindingsForModality(allVisualBindings, composerModality)
  const staleVisualBindingCount = visualBindings.filter(binding => detail.visual_profiles?.some(profile =>
    profile.id === binding.profile_id && visualBindingNeedsRefresh(binding, profile, detail.project_visual_style))).length
  const selectedMode = selectedNode?.settings.mode || 'text'
  const composerDraft = composerModel?.settings.supports_draft === true && selectedNode?.settings.draft === true
  const videoPolicy = videoParameterPolicy(composerModel, selectedMode, composerDraft)
  const composerResolutions = videoPolicy.draftResolution ? [videoPolicy.draftResolution] : modelResolutions(composerModel)
  const savedResolution = selectedNode?.settings.resolution
  const composerResolution = videoPolicy.draftResolution || (composerModality === 'video' && savedResolution
    ? composerResolutions.find(value => value.toLowerCase() === savedResolution.toLowerCase())
      || (composerModel?.settings.video_reference_profile === 'seedance_2_5' ? modelDefaultResolution(composerModel, composerResolutions) : savedResolution)
    : savedResolution || modelDefaultResolution(composerModel, composerResolutions))
  const composerImageDefaults = imageGenerationDefaults(composerModel)
  const composerClarities = composerModality === 'image' ? modelImageClarities(composerModel) : []
  const composerClarity = imageParameterValue(composerModel, 'clarity', selectedNode?.settings.clarity || imageResolutionClarity(selectedNode?.settings.resolution) || composerImageDefaults.clarity)
  const composerQualities = composerModality === 'image' ? modelImageQualities(composerModel) : []
  const composerQuality = imageParameterValue(composerModel, 'quality', selectedNode?.settings.quality || composerImageDefaults.quality)
  const composerBackgrounds = composerModality === 'image' ? modelImageBackgrounds(composerModel) : []
  const composerBackground = imageParameterValue(composerModel, 'background', selectedNode?.settings.background || composerImageDefaults.background)
  const composerRatio = videoPolicy.ratioFollowsSource ? 'adaptive' : selectedNode?.settings.ratio || (composerModality === 'video' && ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(selectedMode)
    ? 'adaptive' : composerModality === 'image' ? composerImageDefaults.ratio : detail.ratio)
  const incoming = graph?.edges.filter((edge) => edge.target === selectedNodeId)
    .map((edge) => {
      const source = graph.nodes.find(node => node.id === edge.source)
      return source && pinnedCanvasReference(source, edge.reference_asset_id)
    }).filter((node): node is CanvasNode => !!node) || []
  const pinnedReferenceIds = [...new Set(graph?.edges.filter(edge => edge.target === selectedNodeId && edge.source !== selectedNodeId
    && graph.nodes.some(node => node.id === edge.source && node.type !== 'image_analysis' && node.type !== 'video_analysis')).flatMap(edge => edge.reference_asset_id || []) || [])]
  // A generator-to-result edge records provenance, not an extra reference.
  // Its latest result can change when rerun, while this media node stays fixed.
  const composerReferences = (selectedNode?.type === 'generation'
    ? incoming : incoming.filter(node => node.type !== 'generation')).filter(node => {
      const binding = allVisualBindings.find(binding => binding.profile_id === node.settings.visual_profile_id)
      return !binding || visualBindingApplies(binding, composerModality)
    })
  const inputTexts = composerReferences
    .map((node) => node.type === 'project_script_ref' ? scriptPrompt(detail.script) : node.type === 'text' || node.type === 'image_analysis' || node.type === 'video_analysis' ? node.text.trim() : '')
    .filter(Boolean)
  const connectedImages = [...new Map(composerReferences.flatMap(node => {
    const binding = visualReferenceMode === 'profiles' && node.settings.visual_profile_id
      ? visualBindings.find(binding => binding.profile_id === node.settings.visual_profile_id) : undefined
    return binding ? visualBindingReferenceAssetIds(binding).map(id => assetMap.get(id))
      : [visualNodeAsset(node, detail, true)]
  })
    .filter((asset): asset is Asset => asset?.kind === 'image').map(asset => [asset.id, asset])).values()]
  // Switching to strict first-frame keeps other connections available for a
  // later multi-reference run, while only the pinned opening image is sent.
  const inputImages = composerModality === 'video' && selectedMode === 'text' ? []
    : composerModality === 'video' && selectedMode === 'first_frame' && selectedNode?.settings.storyboard_reference_asset_id
      ? connectedImages.filter(asset => asset.id === selectedNode.settings.storyboard_reference_asset_id) : connectedImages
  const inputVideo = composerReferences.map((node) => assetMap.get(node.asset_id || '')).find((asset) => asset?.kind === 'video')
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
  const promptOverrides = selectedNode?.settings.prompt_reference_overrides || {}
  const promptBindings = promptReferenceBindings([...visualBindings].sort((a, b) => {
    const left = `${a.kind}\0${a.name}\0${a.profile_id}`, right = `${b.kind}\0${b.name}\0${b.profile_id}`
    return left < right ? -1 : left > right ? 1 : 0
  }), promptOverrides)
  const storyboardCandidate = selectedNode?.settings.storyboard_reference_asset_id !== undefined ? selectedNode.settings.storyboard_reference_asset_id
    : composerModality === 'video' && selectedShot ? inputImages.find(asset => asset.shot_id === selectedShot.id)?.id : undefined
  const rawStoryboardReferenceAssetId = inputImages.some(asset => asset.id === storyboardCandidate) ? storyboardCandidate : undefined
  const rawVideoReferences = videoReferenceManifest(inputImages.map(asset => asset.id), promptBindings, {
    mode: selectedMode, visual_reference_mode: visualReferenceMode,
    storyboard_reference_asset_id: rawStoryboardReferenceAssetId,
    excluded_visual_profile_ids: selectedNode?.settings.excluded_visual_profile_ids,
    video_reference_usages: selectedNode?.settings.video_reference_usages,
  })
  const activeImageBindings = visualBindings.filter(binding => !selectedNode?.settings.excluded_visual_profile_ids?.includes(binding.profile_id))
  const rawPreparedReferenceIds = composerModality === 'video' ? rawVideoReferences.map(entry => entry.asset_id)
    : selectedProfile ? inputImages.map(asset => asset.id)
      : scopedVisualReferenceAssetIds(inputImages.map(asset => asset.id), allVisualBindings, activeImageBindings, pinnedReferenceIds)
  if (composerModality !== 'video' && visualReferenceMode === 'profiles') for (const binding of promptBindings.filter(binding => !selectedNode?.settings.excluded_visual_profile_ids?.includes(binding.profile_id))) {
    for (const id of visualBindingReferenceAssetIds(binding)) if (!rawPreparedReferenceIds.includes(id)) rawPreparedReferenceIds.push(id)
  }
  const profileInheritance = selectedProfile ? visualProfileBaseReadiness(selectedProfile, detail) : undefined
  const directBaseProfile = profileInheritance?.baseProfile
  const baseProfileReady = !!directBaseProfile && !profileInheritance?.error && !profileInheritance?.waitingProfile && visualProfileBoardReady(directBaseProfile, detail)
  const baseProfileReferences = directBaseProfile?.board_asset_id ? [directBaseProfile.board_asset_id] : []
  const waitingBaseProfile = profileInheritance?.waitingProfile || directBaseProfile
  const baseProfileGenerating = !!waitingBaseProfile && !!visualReferenceGenerating(waitingBaseProfile,
    graph?.nodes.find(node => node.settings.visual_profile_id === waitingBaseProfile.id), detail, submittedReferenceJobs.current.get(waitingBaseProfile.id))
  for (const id of [...baseProfileReferences].reverse()) {
    const index = rawPreparedReferenceIds.indexOf(id)
    if (index >= 0) rawPreparedReferenceIds.splice(index, 1)
    rawPreparedReferenceIds.unshift(id)
  }
  const profileReferences = selectedProfile && selectedNode && graph
    ? resolveCanvasVisualBoardReferences(selectedNode, selectedProfile, graph, detail) : undefined
  if (profileReferences) rawPreparedReferenceIds.splice(0, rawPreparedReferenceIds.length, ...profileReferences.rawAssetIds)
  let promptReferenceIssue: string | undefined = graph?.edges.some(edge => edge.target === selectedNodeId
    && edge.reference_asset_id && assetMap.get(edge.reference_asset_id)?.kind !== 'image')
    ? '连线引用的图片已不存在，请移除或重新选择参考' : undefined
  let preparedReferenceIds = rawPreparedReferenceIds
  let resolvedPromptReplacements: Record<string, string | null> = {}
  try {
    // Resolve the graph/binding inputs first. Mentions may describe those
    // inputs, but may not silently add an image after its edge was removed.
    if (profileReferences) {
      preparedReferenceIds = profileReferences.assetIds
      resolvedPromptReplacements = profileReferences.replacements
      promptReferenceIssue ||= profileReferences.error
    } else {
      const resolved = resolvePromptReferences({ prompt: '', referenceAssetIds: rawPreparedReferenceIds,
        overrides: promptOverrides, requiredAssetIds: baseProfileReferences })
      preparedReferenceIds = resolved.referenceAssetIds
      resolvedPromptReplacements = resolved.replacements
    }
  } catch (error) { promptReferenceIssue = error instanceof Error ? error.message : '图片引用无效' }
  let explicitReferenceIds: string[] = []
  try {
    explicitReferenceIds = resolvePromptReferences({ prompt: '', referenceAssetIds: pinnedReferenceIds, overrides: promptOverrides })
      .referenceAssetIds.filter(id => preparedReferenceIds.includes(id))
  } catch { /* The reference error above already blocks submission. */ }
  // Actual fixed inputs carry their saved identity locally, even when the
  // shot's defaults leave that object unused. Input collection stays scoped
  // above so semantic context cannot silently reconnect another image.
  const compilePromptBindings = !selectedProfile && visualReferenceMode === 'profiles'
    && (composerModality === 'image' || composerModality === 'video' && selectedMode === 'reference')
    ? enrichExplicitReferenceBindings(promptBindings, { referenceAssetIds: preparedReferenceIds,
      explicitReferenceAssetIds: explicitReferenceIds, savedBindings: allVisualBindings, profiles: detail.visual_profiles,
      overrides: promptOverrides, excludedVisualProfileIds: selectedNode?.settings.excluded_visual_profile_ids })
    : promptBindings
  const profileReferenceState = selectedProfile && profileReferences ? profileCandidateReferenceState({
    profile: selectedProfile, detail, displayedAssetId: selectedBoardAsset?.id, references: profileReferences,
    generating: selectedNodeGenerating, currentBaseSignature: selectedProfile.base_reference_signature || undefined,
  }) : undefined
  const submittedProfileReferences = selectedProfile && selectedNodeGenerating ? activeProfileReferenceSnapshot(selectedProfile, detail) : undefined
  const submittedProfileRequest = visualJobRequest(submittedProfileReferences?.job)
  const overrideAsset = (id: string | null | undefined) => id && Object.hasOwn(promptOverrides, id) ? promptOverrides[id] || undefined : id || undefined
  const effectiveStoryboardId = overrideAsset(rawStoryboardReferenceAssetId)
  const storyboardReferenceAssetId = effectiveStoryboardId && preparedReferenceIds.includes(effectiveStoryboardId) ? effectiveStoryboardId : undefined
  const mappedVideoUsages = selectedNode?.settings.video_reference_usages?.flatMap(item => {
    const asset_id = overrideAsset(item.asset_id)
    return asset_id ? [{ ...item, asset_id }] : []
  })
  const videoReferences = videoReferenceManifest(preparedReferenceIds, compilePromptBindings.map((binding, index) => ({ ...binding,
    profile_id: binding.profile_id || `explicit-${index}`, required: !!binding.required })), {
    mode: selectedMode, visual_reference_mode: visualReferenceMode, storyboard_reference_asset_id: storyboardReferenceAssetId,
    excluded_visual_profile_ids: selectedNode?.settings.excluded_visual_profile_ids, video_reference_usages: mappedVideoUsages,
    append_profile_assets: false,
  })
  const activeVideoReferenceUsages: VideoReferenceUsageSelection[] = videoReferences.flatMap(entry => entry.usage ? [{ asset_id: entry.asset_id, usage: entry.usage }] : [])
  const styleWarnings = preparedReferenceIds.flatMap((id, index) => {
    const asset = assetMap.get(id)
    if (!asset || detail.visual_profiles?.some(profile => profile.board_asset_id === id && profile.board_style_version === detail.project_visual_style?.version
      || profile.reference_assets?.some(reference => reference.asset_id === id && reference.style_version === detail.project_visual_style?.version))
      || promptBindings.some(binding => binding.reference_assets?.some(reference => reference.asset_id === id && reference.style_version === detail.project_visual_style?.version))) return []
    const job = detail.jobs.find(job => job.result_asset_id === id)
    const warning = styleReferenceWarning(detail.project_visual_style, visualJobRequest(job).project_style_version, index)
    return warning ? [warning] : []
  })
  const promptImageMode = preparedReferenceIds.length ? 'reference' : 'text'
  const promptResolution = composerModel?.modality === 'image' ? imageRequestResolution(composerModel, composerResolution, { ratio: composerRatio, clarity: composerClarity, mode: promptImageMode }) || null : null
  function compileComposerPrompt(body: string) {
    const profilePrompt = selectedProfile ? withVisualProfilePrompt(body, {
      ...selectedProfile,
      definition: resolveCanvasProfileDisplayText(selectedProfile.definition, selectedProfile, detail),
      view_requirements: resolveCanvasProfileDisplayText(selectedProfile.view_requirements, selectedProfile, detail),
      state_delta: resolveCanvasProfileDisplayText(selectedProfile.state_delta || '', selectedProfile, detail),
    }, (selectedProfile.base_profile_id && !baseProfileReady ? [] : preparedReferenceIds).map(asset_id => {
      const source = profileReferences?.sources.find(source => source.assetId === asset_id)
      const profile = profileMap.get(source?.profileId || '')
      return { asset_id, name: profile?.name || source?.label || assetMap.get(asset_id)?.filename || '参考图片', variant: profile?.variant,
        definition: profile ? resolveCanvasProfileDisplayText(profile.definition, profile, detail) : undefined, role: source?.role }
    })) : selectedTemplateKind ? withVisualSettingTemplate(body, selectedTemplateKind, preparedReferenceIds.map(asset_id => ({
      asset_id, name: assetMap.get(asset_id)?.filename || '参考图片',
    }))) : body
    if (!composerModel || composerModel.modality === 'text') return profilePrompt
    const preferencePrompt = composerModel.modality === 'image' ? imagePreferencePrompt(composerModel, profilePrompt, {
      ratio: composerRatio, resolution: promptResolution, clarity: composerClarity, quality: composerQuality, background: composerBackground,
    }, promptImageMode) : videoPreferencePrompt(profilePrompt, selectedMode, composerDuration, {
      ratio: composerRatio, resolution: composerResolution, durationFollowsSource: videoPolicy.durationFollowsSource,
    })
    return withProjectStyle(selectedProfile || selectedTemplateKind ? preferencePrompt : visualGenerationPrompt(preferencePrompt, compilePromptBindings, preparedReferenceIds, visualReferenceMode,
      composerModality === 'video' ? { mode: selectedMode, storyboard_reference_asset_id: storyboardReferenceAssetId,
        excluded_visual_profile_ids: selectedNode?.settings.excluded_visual_profile_ids, video_reference_usages: activeVideoReferenceUsages }
        : { excluded_visual_profile_ids: selectedNode?.settings.excluded_visual_profile_ids }), detail.project_visual_style)
  }
  const automaticPrompt = compileComposerPrompt(compiledPrompt)
  const automaticPromptDraft = tokenizePromptReferenceNumbers(automaticPrompt, preparedReferenceIds)
  const legacyTemplate = tokenizePromptReferenceNumbers(selectedNode?.settings.prompt_template || '', preparedReferenceIds)
  const savedSections = isPromptSectionDocument(selectedNode?.settings.prompt_sections) ? selectedNode.settings.prompt_sections : undefined
  const savedPromptText = selectedProfile ? selectedNode?.settings.profile_prompt_override ?? '' : selectedNode?.text || ''
  const savedDocument = savedSections ? serializePromptSectionDocument(savedSections)
    : selectedNode?.settings.prompt_document || selectedNode?.settings.prompt_is_final && getManagedPromptBlocks(savedPromptText).length > 0
      ? savedPromptText : undefined
  const savedBody = savedDocument !== undefined ? extractPromptBody({ prompt: savedDocument }) : selectedNode?.settings.prompt_body
  const composerBody = tokenizePromptReferenceNumbers(selectedProfile ? resolveCanvasProfileDisplayText(canvasPromptBody({
    prompt: selectedNode?.settings.profile_prompt_override ?? ['按照已保存的视觉设定与视图要求制作当前对象的信息图。', ...inputTexts, selectedNode?.text].filter(Boolean).join('\n\n'),
    prompt_body: savedBody, prompt_template: legacyTemplate,
  }), selectedProfile, detail) : selectedNode?.type === 'text' ? savedBody ?? selectedNode.text
    : selectedNode?.settings.prompt_is_final || savedBody !== undefined ? canvasPromptBody({ prompt: tokenizePromptReferenceNumbers(selectedNode?.text || '', preparedReferenceIds),
      prompt_body: savedBody, prompt_template: legacyTemplate }, compiledPrompt) : compiledPrompt, preparedReferenceIds)
  const generatedPrompt = tokenizePromptReferenceNumbers(compileComposerPrompt(composerBody), preparedReferenceIds)
  const composerSections = savedDocument === undefined
    ? parsePromptSectionDocument(generatedPrompt, { sourceText: generatedPrompt })
    : reconcilePromptSectionDocument(parsePromptSectionDocument(tokenizePromptReferenceNumbers(savedDocument, preparedReferenceIds), {
      sourceText: legacyTemplate, previousDocument: savedSections }), generatedPrompt, { body: composerBody })
  const composerPrompt = serializePromptSectionDocument(composerSections)
  const composerParameters = { modality: composerModality === 'video' ? 'video' as const : 'image' as const,
    ratio: composerRatio, duration: videoPolicy.durationFollowsSource ? null : composerDuration,
    resolution: composerModality === 'image' ? promptResolution : composerResolution,
    clarity: composerClarity, quality: composerQuality, background: composerBackground,
    mode: composerModality === 'image' ? promptImageMode : selectedMode }
  const promptParameterConflicts = findPromptParameterConflicts(composerPrompt, composerParameters)
  function saveComposerDocument(value: string, document?: PromptSectionDocument) {
    if (!selectedNode) return
    const sections = document ?? parsePromptSectionDocument(value, { sourceText: automaticPromptDraft, previousDocument: composerSections })
    if (selectedProfile) updateNodeSettingsById(selectedNode.id, { prompt_document: true, prompt_sections: sections,
      prompt_body: extractPromptBody({ prompt: value }), profile_prompt_override: value, prompt_template: automaticPromptDraft })
    else editNodePrompt(selectedNode.id, value, { base: ownBasePrompt, template: automaticPromptDraft, document: sections })
  }
  function resolveComposerSource(id: string, choice: 'keep_custom' | 'follow_source') {
    const document = resolvePromptSectionSource(composerSections, id, choice)
    saveComposerDocument(serializePromptSectionDocument(document), document)
  }
  const composerHasContent = !!composerBody.trim()
  const promptSourcePending = composerSections.blocks.some(block => block.pendingSourceText !== undefined)
  // A saved document can contain authored mentions inside marked blocks too.
  // Every mention still needs an active graph/binding input.
  const explicitReferencePrompt = savedDocument === undefined ? composerBody : composerPrompt
  let mentionedReferenceIds: string[] = []
  try {
    mentionedReferenceIds = extractPromptReferenceIds(composerPrompt)
    const disconnected = disconnectedPromptReferenceIds(explicitReferencePrompt, rawPreparedReferenceIds, promptOverrides)
    if (disconnected.length) promptReferenceIssue = '提示词中的参考已断开或未在当前模式生效，请点击失效标签重新连接、替换或移除'
  } catch (error) { promptReferenceIssue = error instanceof Error ? error.message : '图片引用无效' }
  const promptReferenceChoices = profileReferences ? profileReferences.sources.flatMap(source => {
    const asset = assetMap.get(source.assetId)
    return asset?.kind === 'image' ? [{ ...source, url: asset.url, required: source.role === 'base',
      description: source.role === 'base' ? '自动继承 · 必需参考' : source.profileId ? '设定库 · 补充参考' : '素材库 · 补充参考',
      provenance: source.role === 'base' ? 'base' as const : 'connection' as const }] : []
  }) : graph && selectedNode ? promptReferenceSources(graph, selectedNode.id, preparedReferenceIds, detail)
    .map(source => ({ ...source, url: assetMap.get(source.assetId)!.url, required: baseProfileReferences.includes(source.assetId) })) : []
  const profileReferenceItems: CanvasReferenceItem[] = submittedProfileReferences ? submittedProfileReferences.assetIds.map((assetId, index) => {
    const sources = Array.isArray(submittedProfileRequest.reference_sources) ? submittedProfileRequest.reference_sources : []
    const saved = sources.find((source: unknown): source is Record<string, unknown> => !!source && typeof source === 'object'
      && (source as Record<string, unknown>).asset_id === assetId)
    const names = Array.isArray(submittedProfileRequest.reference_names) ? submittedProfileRequest.reference_names : []
    const asset = assetMap.get(assetId)
    const sourceNode = graph?.nodes.find(node => node.id !== selectedNodeId && visualNodeAsset(node, detail, true)?.id === assetId)
    return { assetId, asset, name: typeof names[index] === 'string' ? names[index] : asset?.filename || `参考图 ${index + 1}`,
      source: saved?.role === 'base' ? 'base' : typeof saved?.profile_id === 'string' ? 'profile' : 'snapshot',
      version: typeof saved?.revision === 'number' ? `v${saved.revision}` : '提交时版本',
      required: saved?.role === 'base', canLocate: !!sourceNode }
  }) : (profileReferences?.sources || []).map(source => {
    const profile = profileMap.get(source.profileId || '')
    return { assetId: source.assetId, asset: assetMap.get(source.assetId),
      name: profile ? `${profile.name} · ${profile.variant}` : source.label,
      source: source.role === 'base' ? 'base' : source.profileId ? 'profile' : 'asset',
      version: profile ? `v${profile.revision}` : undefined,
      required: source.role === 'base', canLocate: !!(source.nodeId || source.profileId) }
  })
  const submittedPromptReferences = profileReferenceItems.map(item => ({ assetId: item.assetId, url: item.asset?.url || '',
    label: item.name, required: !!item.required, invalid: item.asset?.kind !== 'image',
    description: item.version || '提交时版本', provenance: '本次任务' }))
  const displayedProfilePrompt = submittedProfileReferences && typeof submittedProfileRequest.prompt === 'string'
    ? tokenizePromptReferenceNumbers(submittedProfileRequest.prompt, submittedProfileReferences.assetIds) : composerPrompt
  const promptAdditionalChoices = detail.assets.filter(asset => asset.kind === 'image' && !preparedReferenceIds.includes(asset.id)).map(asset => {
    const profile = detail.visual_profiles?.find(profile => profile.board_asset_id === asset.id ||
      profile.reference_assets?.some(reference => reference.asset_id === asset.id))
    const node = graph?.nodes.find(node => node.id !== selectedNodeId && node.asset_id === asset.id)
    return { assetId: asset.id, url: asset.url, nodeId: node?.id,
      label: node?.title || (profile ? `${profile.name} · ${profile.variant}` : asset.filename),
      description: '添加后建立固定图片引用', provenance: '项目素材' }
  })
  const promptEditorReferences = [...new Set([...preparedReferenceIds, ...mentionedReferenceIds])].flatMap(id => {
    const mappedId = Object.hasOwn(resolvedPromptReplacements, id) ? resolvedPromptReplacements[id] : id
    const reference = promptReferenceChoices.find(choice => choice.assetId === mappedId)
    if (reference) return [{ ...reference, assetId: id, invalid: false }]
    const asset = assetMap.get(mappedId || id)
    const previous = promptAdditionalChoices.find(choice => choice.assetId === (mappedId || id))
    return [{ assetId: id, url: asset?.url || '', label: previous?.label || '已失效的引用图片', required: false,
      description: '引用已断开或未在当前模式生效', provenance: '失效引用', invalid: true }]
  })
  useLayoutEffect(() => {
    if (!selectedNode || selectedNode.type === 'text' || selectedNode.type === 'image_analysis' || selectedNode.type === 'video_analysis' || !preparedReferenceIds.length || promptReferenceIssue) return
    // Freeze legacy numeric drafts while their original input order is still
    // available, before a subsequent link edit can change that order.
    const migrate = (value: string | undefined) => value === undefined ? value : tokenizePromptReferenceNumbers(value, preparedReferenceIds)
    const text = selectedNode.settings.prompt_is_final ? migrate(selectedNode.text)! : selectedNode.text
    const template = migrate(selectedNode.settings.prompt_template)
    const profilePrompt = migrate(selectedNode.settings.profile_prompt_override)
    const body = migrate(selectedNode.settings.prompt_body)
    const sections = rewriteCanvasPromptSections(selectedNode.settings.prompt_sections, value => migrate(value)!)
    if (text === selectedNode.text && template === selectedNode.settings.prompt_template && profilePrompt === selectedNode.settings.profile_prompt_override && body === selectedNode.settings.prompt_body
      && JSON.stringify(sections) === JSON.stringify(selectedNode.settings.prompt_sections)) return
    changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === selectedNode.id
      ? { ...node, text, settings: { ...node.settings, prompt_sections: sections, prompt_body: body, prompt_template: template, profile_prompt_override: profilePrompt } } : node) }))
  }, [selectedNode, preparedReferenceIds.join('\0'), promptReferenceIssue, changeGraph])
  function addComposerPromptReference(reference: { assetId: string; nodeId?: string }): boolean {
    if (!selectedNode || busy) return false
    if (composerModality === 'video' && selectedMode === 'first_frame' && preparedReferenceIds.length) {
      setNotice('首帧模式仅使用一张图片，请替换现有参考，或切换到多图参考后再添加')
      return false
    }
    try {
      changeGraph(current => {
        const connected = materializePromptReference(current, selectedNode.id, reference.assetId, detail, { sourceNodeId: reference.nodeId })
        return { ...connected, nodes: connected.nodes.map(node => {
          if (node.id !== selectedNode.id || !Object.hasOwn(node.settings.prompt_reference_overrides || {}, reference.assetId)) return node
          const overrides = { ...node.settings.prompt_reference_overrides }
          delete overrides[reference.assetId]
          return { ...node, settings: { ...node.settings, prompt_reference_overrides: overrides } }
        }) }
      })
      return true
    } catch (error) { showError(error); return false }
  }
  function changeComposerPromptReference(source: string, replacement: string | null): boolean {
    if (!selectedNode || busy || baseProfileReferences.includes(source)) return false
    try {
      changeGraph(current => {
        const connected = replaceConnectedPromptReference(current, selectedNode.id, source, replacement, detail,
          { sourceNodeId: promptAdditionalChoices.find(item => item.assetId === replacement)?.nodeId })
        return { ...connected, nodes: connected.nodes.map(node => {
          if (node.id !== selectedNode.id) return node
          const overrides = replacePromptReference(node.settings.prompt_reference_overrides, source, replacement)
          const rewrite = (value: string) => value.replace(/\[\[ref:([^\]]+)\]\]/g, (token, id: string) =>
            id === source ? replacement ? `[[ref:${replacement}]]` : '' : overrides[id] === null ? '' : token)
          return { ...node, text: rewrite(node.text), settings: { ...node.settings, prompt_reference_overrides: overrides,
            ...(node.settings.prompt_sections ? { prompt_sections: rewriteCanvasPromptSections(node.settings.prompt_sections, rewrite) } : {}),
            ...(node.settings.prompt_body !== undefined ? { prompt_body: rewrite(node.settings.prompt_body) } : {}),
            ...(node.settings.profile_prompt_override !== undefined ? { profile_prompt_override: rewrite(node.settings.profile_prompt_override) } : {}),
            ...(node.settings.prompt_template !== undefined ? { prompt_template: rewrite(node.settings.prompt_template) } : {}),
            ...(node.settings.storyboard_reference_asset_id === source ? { storyboard_reference_asset_id: replacement } : {}),
            video_reference_usages: node.settings.video_reference_usages?.flatMap(item => item.asset_id === source
              ? replacement ? [{ ...item, asset_id: replacement }] : [] : [item]),
          } }
        }) }
      })
      return true
    } catch (error) { showError(error); return false }
  }
  const referenceBatchDecision = persistentReferenceBatch && graph ? evaluateReferenceBatch(persistentReferenceBatch, graph, detail) : null
  const missingShotCount = canvasShots.filter((shot) => !graph?.nodes.some((node) =>
    node.type === 'generation' && node.shot_id === shot.id)).length
  const supportsAudio = selectedModel?.modality === 'video' && usesModelParameter(selectedModel, 'generate_audio', selectedMode)
  const generationInputKey = JSON.stringify([detail.id, canvas.id, viewMode, selectedNode?.id, selectedNode?.title, selectedNode?.shot_id, selectedNode?.job_id, composerPrompt, selectedNode?.settings, composerModel,
    preparedReferenceIds.map(id => assetMap.get(id) || id), inputVideo, promptBindings, selectedProfile, profileDraftDirty,
    selectedJob?.id, selectedJob?.status, selectedNodeGenerating, detail.project_visual_style,
    providers.map(provider => [provider.id, provider.enabled, provider.adapter])])
  const generationInputRef = useRef(generationInputKey)
  generationInputRef.current = generationInputKey
  const selectedGenerationSubmission = selectedNode ? generationSubmissions[selectedNode.id] : undefined
  const selectedSubmissionPending = selectedGenerationSubmission && !canvasGenerationSubmissionFinished(selectedGenerationSubmission)
  const optimizedDraftAttempt = useRef<string | null>(null)
  useEffect(() => {
    const queue = queueRef.current
    if (!graph || !queue || queue.conflict || !optimizedPromptDraft || optimizedDraftAttempt.current === optimizedPromptDraft.id) return
    optimizedDraftAttempt.current = optimizedPromptDraft.id
    try {
      let added: ReturnType<typeof addOptimizedPromptDraft> | undefined
      changeGraph(current => {
        if (current.nodes.some(node => node.id === optimizedPromptDraft.id)) return current
        added = addOptimizedPromptDraft(current, optimizedPromptDraft, detail, models)
        return added.graph
      })
      if (added) {
        setViewMode('canvas'); setSelectedNodeId(added.node.id); setSelectedNodeIds([added.node.id]); setSelectedEdgeId(null); setComposerNodeId(added.node.id)
        const node = queue.graph.nodes.find(node => node.id === added!.node.id)!
        window.requestAnimationFrame(() => { if (queueRef.current === queue) void setCenter(node.x + node.width / 2, node.y + node.height / 2, { zoom: 1, duration: 220 }) })
        setNotice('优化提示词已加入新草稿，请确认参数和参考图后手动生成')
      }
      onOptimizedPromptDraftApplied?.()
    } catch (issue) { showError(issue); onOptimizedPromptDraftApplied?.() }
  }, [graph, optimizedPromptDraft, detail, models, changeGraph, setCenter, setNotice, showError, onOptimizedPromptDraftApplied])
  useEffect(() => {
    setGenerationInfoOpen(false)
    setReview(null)
  }, [generationInputKey])

  useEffect(() => {
    if (viewMode !== 'canvas' || !graph?.nodes.length || initialViewApplied.current) return
    if (readShotCanvasRequest(detail.id)?.canvasId === canvas.id) return
    if (savedViewport) {
      initialViewApplied.current = true
      return
    }
    initialViewApplied.current = true
    const nodes = graph.nodes.filter(node => visibleNodeIds.has(node.id))
    const first = nodes.find((node) => node.type === 'generation') || nodes[0]
    if (!first) return
    const wide = (viewportRef.current?.clientWidth || 0) > 900
    void setCenter(first.x + first.width / 2 + (wide ? 210 : 0), first.y + first.height / 2,
      { zoom: 1, duration: 350 })
  }, [graph, savedViewport, setCenter, viewMode, visibleNodeIds])

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
      const nodes = (queueRef.current?.graph.nodes || []).filter(node => visibleNodeIds.has(node.id))
      const focus = nodes.find((node) => node.id === selectedNodeId) || nodes.find((node) => node.type === 'generation') || nodes[0]
      if (focus) void setCenter(focus.x + focus.width / 2 + (width > 900 ? 210 : 0),
        focus.y + focus.height / 2, { zoom: 1, duration: 0 })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [setCenter, selectedNodeId, viewMode, visibleNodeIds])

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

  function addNode(type: 'text' | 'generation' | 'image_analysis' | 'video_analysis', modality?: CanvasModality, at?: { x: number; y: number }) {
    const position = at || centerPosition()
    const node = blankNode(type, position.x, position.y)
    if (type === 'text') node.settings.text_mode = 'write'
    if (type === 'image_analysis') node.model_id = visionModels[0]?.id || null
    if (type === 'video_analysis') { node.model_id = videoAnalysisOptions[0]?.id || null; node.settings.video_analysis_fps = 2 }
    if (type === 'generation' && modality) {
      const model = availableModels.find(model => model.modality === modality)
      node.model_id = model?.id || null
      node.settings = { ...node.settings, ...(modality === 'image' ? imageGenerationDefaults(model) : {}), modality }
      node.title = modality === 'image' ? '图片生成' : '视频生成'
      if (modality === 'video') {
        const mode = supportedModes(model)[0] || 'text'
        node.settings.mode = mode
        node.settings.visual_reference_mode = mode === 'reference' ? 'profiles'
          : ['first_frame', 'first_last_frame', 'edit', 'extend'].includes(mode) ? 'keyframe' : 'text_only'
        node.settings.duration = modelDuration(model, 5)
        node.settings.resolution = modelDefaultResolution(model, modelResolutions(model)) || '480p'
        node.settings.ratio = modelRatios(model).includes(detail.ratio) ? detail.ratio : modelRatios(model)[0]
      }
    }
    if (type === 'generation' && !modality) node.settings.ratio = detail.ratio
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)


    if (viewMode === 'storyboard') setStoryboardSelectedId(node.id)
    setComposerNodeId(node.id)
    setAddMenu(null)
  }

  function addVisualSettingNode(kind: VisualSettingKind, at?: { x: number; y: number }, source?: CanvasNode) {
    if (!graph) return
    const position = at || (source ? { x: source.x + source.width + 100, y: source.y } : centerPosition())
    const model = availableModels.find(model => model.modality === 'image' && !imageReferenceConfigError(model.settings, 1))
      || availableModels.find(model => model.modality === 'image')
    const template = visualSettingTemplates[kind]
    const node = { ...blankNode('generation', position.x, position.y), title: template.label, model_id: model?.id || null,
      prompt: template.body, settings: { ...imageGenerationDefaults(model), modality: 'image' as const, visual_template_kind: kind } }
    const asset = source ? visualNodeAsset(source, detail) : undefined
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node],
      edges: asset?.kind === 'image' && source ? [...current.edges,
        { id: crypto.randomUUID(), source: source.id, target: node.id, reference_asset_id: asset.id }] : current.edges }))
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    setContextMenu(null); setAddMenu(null)
    setNotice(asset ? `已连接参考图片，可编辑${template.label}提示词后生成` : `连接图片到${template.label}节点，或从「添加参考」选择图片`)
  }

  function addImageAnalysisFromSource(source: CanvasNode) {
    const asset = visualNodeAsset(source, detail, true)
    if (asset?.kind !== 'image') return
    const node = blankNode('image_analysis', source.x + source.width + 100, source.y)
    node.model_id = visionModels[0]?.id || null
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node], edges: [...current.edges,
      { id: crypto.randomUUID(), source: source.id, target: node.id, reference_asset_id: asset.id }] }))
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    setContextMenu(null); setAddMenu(null)
  }

  function addVideoAnalysisFromSource(source: CanvasNode) {
    const asset = visualNodeAsset(source, detail)
    if (asset?.kind !== 'video') return
    const node = blankNode('video_analysis', source.x + source.width + 100, source.y)
    node.model_id = videoAnalysisOptions[0]?.id || null
    node.settings.video_analysis_fps = 2
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node], edges: [...current.edges,
      { id: crypto.randomUUID(), source: source.id, target: node.id, reference_asset_id: asset.id }] }))
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    setContextMenu(null); setAddMenu(null)
  }

  function createGenerationFromVideoAnalysis(source: CanvasNode, index: number) {
    const result = source.settings.video_analysis_result, shot = result?.shots[index]
    if (!graph || !result || !shot?.video_prompt.trim()) return
    const input = resolveCanvasVideoAnalysisSource(source, graph, videoAnalysis.detail)
    if (input.issue || input.assetId !== result.asset_id) { setNotice('来源视频已变化，请重新反推后再创建'); return }
    const node = blankNode('generation', source.x + source.width + 100, source.y)
    const model = availableModels.find(item => item.modality === 'video' && supportedModes(item).includes('text'))
    node.model_id = model?.id || null; node.title = shot.title || '视频生成'
    node.prompt = videoAnalysisShotPrompt(shot, result.global_style)
    node.settings = { modality: 'video', mode: 'text', visual_reference_mode: 'text_only',
      duration: modelDuration(model, (shot.end_ms - shot.start_ms) / 1000),
      ratio: modelRatios(model).includes(detail.ratio) ? detail.ratio : modelRatios(model)[0],
      resolution: modelDefaultResolution(model, modelResolutions(model)) || '720p' }
    // Freeze only the chosen shot. Connecting the whole analysis would mix all
    // other shots into its prompt and implicitly reuse the source video.
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    setNotice('已创建当前镜头的视频生成草稿，可检查提示词和生成时长后生成')
  }

  function cancelImageAnalysis() {
    analysisRequestRef.current?.controller.abort()
    analysisRequestRef.current = null
    setAnalysisRun(null)
  }

  function clearAnalysisSource(nodeId: string) {
    if (analysisRequestRef.current) return
    changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, asset_id: null } : node),
      edges: current.edges.filter(edge => edge.target !== nodeId) }))
    setAnalysisErrors(current => ({ ...current, [nodeId]: '' }))
  }

  async function uploadAnalysisImage(nodeId: string, file: File) {
    if (analysisRequestRef.current) return
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setAnalysisErrors(current => ({ ...current, [nodeId]: '请选择 PNG、JPEG、WebP 或 GIF 图片' })); return
    }
    const request = { nodeId, controller: new AbortController() }
    analysisRequestRef.current = request
    setAnalysisErrors(current => ({ ...current, [nodeId]: '' })); setAnalysisElapsed(0)
    setAnalysisRun({ nodeId, phase: 'uploading', started: Date.now() })
    try {
      const form = new FormData(); form.append('file', file)
      const asset = await api<Asset>(`/projects/${detail.id}/assets`, { method: 'POST', body: form, signal: request.controller.signal })
      if (analysisRequestRef.current !== request || request.controller.signal.aborted) return
      if (asset.kind !== 'image') throw new Error('上传文件未识别为图片，请更换文件')
      setAnalysisUploads(current => ({ ...current, [asset.id]: asset }))
      changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? { ...node, asset_id: asset.id } : node),
        edges: current.edges.filter(edge => edge.target !== nodeId) }))
      await onRefresh()
    } catch (issue) {
      if (analysisRequestRef.current === request && !request.controller.signal.aborted) setAnalysisErrors(current => ({ ...current, [nodeId]: issue instanceof Error ? issue.message : String(issue) }))
    } finally {
      if (analysisRequestRef.current === request) { analysisRequestRef.current = null; setAnalysisRun(null) }
    }
  }

  async function analyzeCanvasImage(nodeId: string) {
    if (analysisRequestRef.current) return
    const current = queueRef.current?.graph, node = current?.nodes.find(node => node.id === nodeId)
    if (!current || node?.type !== 'image_analysis') return
    const source = resolveCanvasImageAnalysisSource(node, current, analysisDetail)
    const model = visionModels.find(model => model.id === node.model_id)
    const issue = source.issue || (!model ? '请选择支持图片理解的模型' : '')
    if (issue || !source.assetId || !model) { setAnalysisErrors(current => ({ ...current, [nodeId]: issue })); return }
    const request = { nodeId, controller: new AbortController() }
    const sourceAssetId = source.assetId, instructions = node.settings.image_analysis_instructions || '', originalText = node.text
    analysisRequestRef.current = request
    setAnalysisErrors(current => ({ ...current, [nodeId]: '' })); setAnalysisElapsed(0)
    setAnalysisRun({ nodeId, phase: 'analyzing', started: Date.now() })
    const timeout = window.setTimeout(() => request.controller.abort(new Error('图片反推超时，请重试或切换支持看图的模型')), 300_000)
    try {
      const value = await api<{ prompt: string; asset_id: string; model_id: string }>(`/projects/${detail.id}/canvas/image-prompt-analysis`, {
        ...json('POST', { asset_id: sourceAssetId, model_id: model.id, instructions }), signal: request.controller.signal,
      })
      if (analysisRequestRef.current !== request || request.controller.signal.aborted) return
      if (!value.prompt?.trim() || value.asset_id !== sourceAssetId || value.model_id !== model.id) throw new Error('反推结果与当前图片或模型不匹配，请重试')
      const latestGraph = queueRef.current?.graph, latest = latestGraph?.nodes.find(item => item.id === nodeId)
      if (!latest || latest.type !== 'image_analysis') return
      const latestSource = resolveCanvasImageAnalysisSource(latest, latestGraph!, analysisDetail)
      if (latestSource.issue || latestSource.assetId !== sourceAssetId || latest.model_id !== model.id
        || (latest.settings.image_analysis_instructions || '') !== instructions || latest.text !== originalText) {
        throw new Error('图片、反推要求或提示词已变化，本次结果未覆盖当前内容，请重新反推')
      }
      changeGraph(current => ({ ...current, nodes: current.nodes.map(item => item.id === nodeId ? { ...item, text: value.prompt.trim(),
        settings: { ...item.settings, image_analysis_source_asset_id: sourceAssetId } } : item) }))
      setNotice('已生成专业提示词，可编辑后连接到生成节点')
    } catch (issue) {
      if (analysisRequestRef.current === request) setAnalysisErrors(current => ({ ...current, [nodeId]: request.controller.signal.aborted
        ? '图片反推超时，请重试或切换支持看图的模型' : issue instanceof Error ? issue.message : String(issue) }))
    } finally {
      window.clearTimeout(timeout)
      if (analysisRequestRef.current === request) { analysisRequestRef.current = null; setAnalysisRun(null) }
    }
  }

  function createGenerationFromAnalysis(source: CanvasNode) {
    if (!source.text.trim()) return
    const node = blankNode('generation', source.x + source.width + 100, source.y)
    const model = availableModels.find(model => model.modality === 'image')
    node.title = '图片生成'; node.model_id = model?.id || null
    node.settings = { ...imageGenerationDefaults(model), modality: 'image' }
    changeGraph(current => ({ ...current, nodes: [...current.nodes, node], edges: [...current.edges,
      { id: crypto.randomUUID(), source: source.id, target: node.id }] }))
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    setNotice('已创建图片生成节点，并连接反推提示词')
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
    if (!graph || !selectedNode || busy || previewingRef.current || submittingRef.current) return
    if (promptReferenceIssue) { setNotice(promptReferenceIssue); return }
    if (promptParameterConflicts.length) { setNotice(promptParameterConflicts[0].message); return }
    if (promptSourcePending) { setNotice('设定来源已更新，请在「设定来源与同步」中确认保留本节点修改或跟随项目'); return }
    if (selectedProfile) { setPendingRunNodeId(selectedNode.id); return }
    const prompt = composerPrompt.trim()
    if (!composerHasContent) { setNotice('请先输入提示词'); return }
    if (selectedNode?.type === 'generation') {
      editNodePrompt(selectedNode.id, prompt, { base: ownBasePrompt, template: automaticPromptDraft, document: composerSections })
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
      settings: { modality, prompt_override: true, prompt_is_final: true, prompt_document: true, prompt_sections: composerSections, prompt_body: composerBody, prompt_base: ownBasePrompt, prompt_template: automaticPromptDraft,
        prompt_reference_overrides: selectedNode.settings.prompt_reference_overrides,
        storyboard_reference_asset_id: selectedNode.settings.storyboard_reference_asset_id,
        video_reference_usages: selectedNode.settings.video_reference_usages,
        excluded_visual_profile_ids: selectedNode.settings.excluded_visual_profile_ids,
        reference_video_url: selectedNode.settings.reference_video_url,
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
        mode: modality === 'video' && selectedNode.type === 'image' && !selectedNode.settings.mode && supportedModes(model).includes('first_frame')
          ? 'first_frame' : selectedNode.settings.mode || 'text' },
    }
    const sourceIds = new Set(composerReferences.map(source => source.id))
    // Preserve every image snapshot, including several views from one node.
    const edges = graph.edges.filter(edge => edge.target === selectedNode.id && sourceIds.has(edge.source))
      .map(edge => ({ ...edge, id: crypto.randomUUID(), target: node.id }))
    const ownAsset = visualNodeAsset(selectedNode, detail, true)
    edges.push({ id: crypto.randomUUID(), source: selectedNode.id, target: node.id,
      ...(ownAsset?.kind === 'image' ? { reference_asset_id: ownAsset.id } : {}) })
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
    // Explicit navigation centers the node; its editor follows below it.
    void setCenter(node.x + node.width / 2 + (wide ? 80 : 0), node.y + node.height / 2, { zoom: 1, duration: 0 })
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
      const reference = existingReference || { ...blankNode(asset.kind, target.x - 540, target.y), title: assetLabels.get(asset.id)?.title || asset.filename,
        text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id, shot_id: asset.shot_id }
      const nearbyCount = currentGraph.edges.filter(edge => edge.target === target.id).length
      if (!existingReference) reference.y += nearbyCount * 100
      changeGraph(current => ({ ...current, nodes: [
        ...current.nodes.map(node => node.id === target.id && !node.settings.visual_profile_id && !node.settings.visual_template_kind && !node.shot_id && asset.shot_id
          ? { ...node, shot_id: asset.shot_id, settings: { ...node.settings,
            storyboard_revision: storyboardRevision(shotMap.get(asset.shot_id || '')?.storyboard_revision) } } : node),
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
    const node = { ...blankNode(asset.kind, position.x, position.y), title: assetLabels.get(asset.id)?.title || asset.filename,
      text: asset.kind === 'text' ? asset.text || '' : '', asset_id: asset.id, shot_id: asset.shot_id }
    changeGraph((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedNodeId(node.id)
    setSelectedNodeIds([node.id])
    setSelectedEdgeId(null)


  }

  function openProfileSidebar() {
    setViewMode('canvas'); setSidebarOpen(true); setSidebarTab('profiles'); setReferenceTargetNodeId(null)
  }

  async function leaveVisualPanel() {
    if (visualPanelBusy) return false
    return !profileDraftDirty || await confirm({ title: '保留当前修改？', message: '当前设定或草稿尚未保存。离开会丢弃这些修改。', confirmLabel: '丢弃并继续', cancelLabel: '继续编辑' })
  }

  async function closeVisualPanel() {
    if (!await leaveVisualPanel()) return
    setProfileInspectorId(null); setVisualTool(null); setProfileDraftDirty(false)
  }

  async function openVisualTool(tool: 'create' | 'organize' | 'bindings', context: VisualBindingContext = {}) {
    if (!await leaveVisualPanel()) return
    setViewMode('canvas'); setProfileInspectorId(null); setProfileDraftDirty(false)
    setVisualBindingContext(context); setVisualTool(tool); setComposerExpanded(false); setComposerNodeId(null)
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
  }

  async function openProfileInspector(profile: VisualProfile) {
    if (profileInspectorId === profile.id && !visualTool) return
    if (!await leaveVisualPanel()) return
    setViewMode('canvas'); setVisualTool(null); setProfileDraftDirty(false); setProfileInspectorId(profile.id)
    setComposerNodeId(null)
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
  }

  function removeProfileNodes(profile: VisualProfile) {
    const withoutProfile = (current: CanvasGraph) => {
      const removed = new Set(current.nodes.filter(node => node.settings.visual_profile_id === profile.id).map(node => node.id))
      return { ...current, nodes: current.nodes.filter(node => !removed.has(node.id)), edges: current.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) }
    }
    changeGraph(withoutProfile)
    // Canvas undo cannot restore a deleted database definition. Keep earlier
    // layout history usable without reintroducing invalid profile references.
    historyRef.current = { past: historyRef.current.past.map(withoutProfile), future: historyRef.current.future.map(withoutProfile) }
    setSelectedNodeId(null); setSelectedNodeIds([]); setSelectedEdgeId(null)
    setProfileInspectorId(null); setVisualTool(null); setNotice('设定已删除，生成的素材仍保留')
  }

  function addProfileToCanvas(profile: VisualProfile, targetId = referenceTargetNodeId) {
    if ((profile.design_id || null) !== (canvas.design_id || null)) { setNotice('该设定属于其他方案，请切换对应画布查看'); return }
    const current = queueRef.current?.graph
    if (!current) return
    const target = current.nodes.find(node => node.id === targetId)
    if (target?.settings.visual_profile_id === profile.id) { setNotice('设定不能引用自身'); return }
    const targetBinding = target?.settings.visual_reference_mode !== 'keyframe' && target?.settings.visual_reference_mode !== 'text_only'
      ? detail.shot_visual_bindings?.find(binding => binding.shot_id === target?.shot_id && binding.profile_id === profile.id) : undefined
    if (target && !profile.board_asset_id && !targetBinding?.reference_assets?.length) { setNotice(`请先确认 ${profile.name} 的设定图，或为镜头选择独立参考图`); return }
    const position = target ? { x: target.x - 540, y: target.y } : centerPosition()
    const model = availableModels.find(item => item.modality === 'image')
    const added = addVisualProfileNode(current, profile, { ...blankNode('generation', position.x, position.y), model_id: model?.id || null,
      job_id: detail.asset_tasks.find(task => task.id === profile.asset_task_id)?.generation_job_id || null,
      settings: { modality: 'image', ...imageGenerationDefaults(model) } })
    const alreadyConnected = target && [...current.edges, ...automaticVisualReferenceEdges(added.graph, detail, models)]
      .some(edge => edge.source === added.nodeId && edge.target === target.id)
    const targetModality = target?.settings.modality || modelMap.get(target?.model_id || '')?.modality
    const boardId = targetBinding?.board_asset_id || profile.board_asset_id
    const fixedIds = targetBinding?.reference_assets?.length
      ? !visualBindingApplies(targetBinding, targetModality) ? visualBindingReferenceAssetIds(targetBinding) : []
      : boardId ? [boardId] : []
    // Explicitly adding an inactive setting is local to this node. Preserve
    // every selected view as a fixed input, without enabling the shot binding.
    try {
      changeGraph(() => {
        if (!target) return added.graph
        if (fixedIds.length) return fixedIds.reduce((next, assetId) => materializePromptReference(next, target.id, assetId, detail,
          { sourceNodeId: added.nodeId }), added.graph)
        return !alreadyConnected ? { ...added.graph, edges: [...added.graph.edges, { id: crypto.randomUUID(), source: added.nodeId, target: target.id }] } : added.graph
      })
    } catch (issue) { showError(issue); return }
    setProfileInspectorId(null)
    setViewMode('canvas')
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
    if (target) { setReferenceTargetNodeId(null); setComposerNodeId(target.id); setNotice(alreadyConnected ? '该设定图已连接' : '已连接设定参考图'); return }
    focusSidebarNode(added.nodeId)
  }

  function locateMissingReference(reference: MissingVisualReference) {
    const current = queueRef.current?.graph
    if (!current || !selectedNode) return
    if (reference.action === 'bindings') { void openVisualTool('bindings', { target: selectedNode.shot_id ? `shot:${selectedNode.shot_id}` : undefined }); return }
    const profile = detail.visual_profiles?.find(item => item.id === reference.profileId)
    if (!profile) { void openVisualTool('bindings', { target: selectedNode.shot_id ? `shot:${selectedNode.shot_id}` : undefined }); return }
    // Preserve the original target when following a chain of missing references.
    if (!referenceReturnNodeId || !current.nodes.some(node => node.id === referenceReturnNodeId)) setReferenceReturnNodeId(selectedNode.id)
    setNotice(null); setProfileInspectorId(null); setReferenceTargetNodeId(null)
    if ((viewportRef.current?.clientWidth || 0) <= 700) setSidebarOpen(false)
    if (reference.nodeId) focusSidebarNode(reference.nodeId)
    else addProfileToCanvas(profile, null)
  }

  function saveReferenceBatchPlan(plan: ReferenceBatchState) {
    writeReferenceBatch(plan)
    const current = queueRef.current
    if (current?.id === plan.projectId && (current.canvasId || current.id) === plan.canvasId) {
      referenceBatchPlanRef.current = plan
      setPersistentReferenceBatch(plan)
    }
  }

  async function generateRequiredReferences() {
    const queue = queueRef.current
    if (!queue || !selectedNode || busy || visualPanelBusy || previewingRef.current || submittingRef.current) return
    try {
      const plan = createReferenceBatch({ projectId: detail.id, canvasId: canvas.id, targetId: selectedNode.id,
        profileIds: missingVisualReferences(queue.graph, selectedNode.id, detail, models)
          .filter(reference => reference.action === 'generate').map(reference => reference.profileId) }, detail)
      if (!plan.items.length) return
      saveReferenceBatchPlan(plan)
      await submitReferenceBatch(plan)
    } catch (error) { showError(error) }
  }

  async function submitReferenceBatch(initial: ReferenceBatchState) {
    const queue = queueRef.current
    if (!queue || queue.id !== initial.projectId || (queue.canvasId || detail.id) !== (canvasId || detail.id)
      || initial.canvasId !== canvas.id || submittingRef.current || previewingRef.current || busy || visualPanelBusy) return
    const decision = evaluateReferenceBatch(initial, queue.graph, detail)
    if (!decision.ready.length) return
    submittingRef.current = true
    setBusy(true)
    let plan = initial
    const result = { targetId: initial.targetId, submitting: true,
      queued: initial.items.filter(item => item.status === 'submitted').length,
      failures: [] as Array<{ profileId: string; name: string; message: string }> }
    setReferenceBatch(result)
    try {
      let nextGraph = queue.graph
      const candidates: Array<{ profile: VisualProfile; nodeId: string; model: Model }> = []
      const target = nextGraph.nodes.find(node => node.id === initial.targetId)!
      for (const [index, reference] of decision.ready.entries()) {
        const profile = profileMap.get(reference.profileId)!
        try {
          const existing = nextGraph.nodes.find(node => node.settings.visual_profile_id === profile.id)
          const model = existing?.model_id ? availableModels.find(item => item.id === existing.model_id && item.modality === 'image')
            : availableModels.find(item => item.modality === 'image')
          if (!model) throw new Error(existing?.model_id ? '此设定的图片模型不可用，请重新选择' : '请先配置可用的图片模型')
          if (profileDraftDirty && profileInspectorId === profile.id) throw new Error('请先保存正在编辑的设定')
          if (!existing && nextGraph.nodes.filter(node => node.type !== 'project_script_ref').length >= 500) throw new Error('画布节点已达到上限')
          const added = addVisualProfileNode(nextGraph, profile, { ...blankNode('generation', target.x - 540, target.y + index * 300),
            model_id: model.id, settings: { modality: 'image', ...imageGenerationDefaults(model) } })
          nextGraph = added.graph
          if (existing && !existing.model_id) nextGraph = { ...nextGraph, nodes: nextGraph.nodes.map(node => node.id === existing.id ? { ...node, model_id: model.id } : node) }
          candidates.push({ profile, nodeId: added.nodeId, model })
        } catch (error) { plan = recordReferenceBatchFailure(plan, profile.id, error instanceof Error ? error.message : String(error)) }
      }
      changeGraph(() => nextGraph)
      await flush(queue)
      for (const { profile, nodeId, model } of candidates) {
        let submitted = false
        try {
          if (queueRef.current !== queue) break
          const node = queue.graph.nodes.find(item => item.id === nodeId)
          if (!node) throw new Error('参考节点已移除')
          const prepared = await prepareCanvasVisualBoard(node, profile, queue.graph, detail, model)
          if (queueRef.current !== queue) break
          plan = markReferenceBatchSubmitting(plan, profile.id)
          saveReferenceBatchPlan(plan)
          const generated = await enqueueCanvasVisualBoard(prepared.board, prepared.request, prepared.candidateCount)
          submitted = true
          const ids = (generated.jobs?.length ? generated.jobs : [generated.job]).map(job => job.id)
          plan = recordReferenceBatchSubmission(plan, profile.id, ids)
          submittedReferenceJobs.current.set(profile.id, ids)
          saveReferenceBatchPlan(plan)
          result.queued += 1
          if (queueRef.current === queue) updateNodeById(nodeId, { job_id: generated.job.id })
          else {
            queue.graph = { ...queue.graph, nodes: queue.graph.nodes.map(node => node.id === nodeId ? { ...node, job_id: generated.job.id } : node) }
            queue.serial += 1; keepDraft(queue)
          }
          await flush(queue)
        } catch (error) {
          const message = submitted ? '任务已入队，画布关联保存失败；可在任务记录中查看' : error instanceof Error ? error.message : String(error)
          // An uncertain submission is never retried automatically.
          plan = recordReferenceBatchFailure(plan, profile.id, message)
        }
      }
    } catch (error) {
      for (const item of plan.items.filter(item => item.status === 'pending')) plan = recordReferenceBatchFailure(plan, item.profileId,
        `画布保存：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      saveReferenceBatchPlan(plan)
      result.failures = evaluateReferenceBatch(plan, queue.graph, detail).blocked.map(item => ({ ...item,
        name: profileMap.get(item.profileId)?.name || '参考图' }))
      setReferenceBatch({ ...result, submitting: false })
      submittingRef.current = false; setBusy(false)
      try { await onRefresh() } catch { setNotice('任务状态刷新失败，可在任务记录中查看') }
    }
  }

  useEffect(() => {
    const plan = readReferenceBatch(detail.id, canvas.id)
    referenceBatchPlanRef.current = plan
    setPersistentReferenceBatch(plan)
  }, [detail.id, canvas.id])
  useEffect(() => {
    const plan = referenceBatchPlanRef.current
    if (!plan || !graph || queueRef.current?.graph !== graph || plan.canvasId !== canvas.id || busy || visualPanelBusy
      || submittingRef.current || previewingRef.current) return
    const decision = evaluateReferenceBatch(plan, graph, detail)
    if (decision.completed.length === plan.items.length) {
      clearReferenceBatch(detail.id, canvas.id); referenceBatchPlanRef.current = null; setPersistentReferenceBatch(null)
    } else if (decision.ready.length) void submitReferenceBatch(plan)
  }, [persistentReferenceBatch, graph, detail, busy, visualPanelBusy, canvas.id])
  useEffect(() => {
    if (!persistentReferenceBatch || !persistentReferenceBatch.items.some(item => item.status === 'submitted')) return
    const timer = window.setInterval(() => { void onRefresh().catch(() => {}) }, 4000)
    return () => window.clearInterval(timer)
  }, [persistentReferenceBatch, onRefresh])

  function changeVideoMode(mode: CanvasMode) {
    if (!selectedNode) return
    selectNodeVideoMode(selectedNode.id, mode)
  }

  function excludeVideoReference(profileId: string, restore = false) {
    if (!selectedNode || visualBindings.find(binding => binding.profile_id === profileId)?.required) return
    changeGraph(current => {
      const target = current.nodes.find(node => node.id === selectedNode.id)
      if (!target) return current
      const excluded = new Set(target.settings.excluded_visual_profile_ids || [])
      if (restore) excluded.delete(profileId); else excluded.add(profileId)
      const excludedBinding = visualBindings.find(binding => binding.profile_id === profileId)
      const assetIds = new Set(excludedBinding ? visualBindingReferenceAssetIds(excludedBinding) : [])
      const retainedIds = new Set(visualBindings.filter(binding => binding.profile_id !== profileId && !excluded.has(binding.profile_id)).flatMap(visualBindingReferenceAssetIds))
      return { ...current, nodes: current.nodes.map(node => node.id === target.id
        ? { ...node, settings: { ...node.settings, excluded_visual_profile_ids: [...excluded] } } : node),
        edges: restore ? current.edges : current.edges.filter(edge => {
          if (edge.target !== target.id) return true
          const source = current.nodes.find(node => node.id === edge.source)
          const assetId = edge.reference_asset_id || source && visualNodeAsset(source, detail, true)?.id
          return !(source?.settings.visual_profile_id === profileId || assetId && assetIds.has(assetId)
            && !retainedIds.has(assetId) && assetId !== storyboardReferenceAssetId)
        }),
      }
    })
  }

  async function useProfileBoard(profile: VisualProfile, assetId: string) {
    const confirmed = await api<VisualProfile>(`/visual-profiles/${profile.id}`, json('PATCH', { board_asset_id: assetId, expected_revision: profile.revision, expected_style_version: detail.project_visual_style?.version }))
    // Approving a candidate changes its snapshot, not the editable definition.
    // Adopt that revision now so the refresh does not discard manual prompt edits.
    changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.settings.visual_profile_id === profile.id ? { ...node, asset_id: assetId,
      settings: { ...node.settings, visual_profile_revision: confirmed.revision } } : node) }))
    await onRefresh(); setNotice('已确认使用此设定图')
  }

  async function confirmProfileBoard(assetId: string) {
    if (!selectedProfile || busy || selectedNodeGenerating) return
    setBusy(true)
    try {
      await useProfileBoard(selectedProfile, assetId)
    } catch (issue) { showError(issue) } finally { setBusy(false) }
  }

  async function confirmRequiredReferences() {
    const queue = queueRef.current
    if (!queue || !selectedNode || busy || visualPanelBusy || submittingRef.current || !referencesToConfirm.length) return
    const targetId = selectedNode.id
    submittingRef.current = true; setBusy(true)
    try {
      const result = await api<{ confirmed: VisualProfile[]; skipped: Array<{ profile_id: string; name: string; message: string }> }>(`/projects/${detail.id}/visual-profiles/confirm-first`, json('POST', {
        profiles: referencesToConfirm.map(reference => ({ id: reference.profileId, expected_revision: profileMap.get(reference.profileId)!.revision })),
        expected_style_version: detail.project_visual_style?.version,
      }))
      if (queueRef.current === queue) {
        const confirmed = new Map(result.confirmed.map(profile => [profile.id, profile]))
        changeGraph(current => ({ ...current, nodes: current.nodes.map(node => {
          const profile = confirmed.get(node.settings.visual_profile_id || '')
          return profile ? { ...node, asset_id: profile.board_asset_id, settings: { ...node.settings, visual_profile_revision: profile.revision } } : node
        }) }))
        setReferenceConfirmation({ targetId, confirmed: result.confirmed.length, skipped: result.skipped })
      }
      await onRefresh()
      setNotice(result.confirmed.length ? `已确认 ${result.confirmed.length} 份参考图，可继续生成` : '没有新增确认，请查看待处理项')
    } catch (issue) { showError(issue) } finally { submittingRef.current = false; setBusy(false) }
  }

  async function useShotCandidate(nodeId: string, assetId: string) {
    const queue = queueRef.current
    const node = queue?.graph.nodes.find(item => item.id === nodeId)
    if (!queue || !node || node.type !== 'generation' || node.settings.visual_profile_id || !node.shot_id) throw new Error('分镜节点已变化，请重新打开候选')
    if (queue.conflict) throw new Error('画布版本冲突，请先合并后再切换候选')
    const modality = node.settings.modality || modelMap.get(node.model_id || '')?.modality
    if (modality !== 'image' && modality !== 'video') throw new Error('当前节点不支持分镜素材候选')
    const shot = shotMap.get(node.shot_id)
    if (!shot || !shotMediaCandidates(shot.id, detail, modality).some(asset => asset.id === assetId)) throw new Error('该素材不属于当前镜头的候选')
    if (shot.archived_candidate_asset_ids?.includes(assetId)) throw new Error('请先恢复该候选，再设为当前素材')
    const job = detail.jobs.find(item => item.id === node.job_id)
    if (job?.status === 'queued' || job?.status === 'running') throw new Error('请等待当前生成完成后再切换')
    changeGraph(current => ({ ...current, nodes: current.nodes.map(item => item.id === nodeId
      ? { ...item, asset_id: assetId, settings: { ...item.settings, generation_completed_job_id: job?.status === 'succeeded' ? job.id : undefined } } : item) }))
    try { await flush(queue) } catch (issue) {
      if (queueRef.current === queue) changeGraph(current => ({ ...current, nodes: current.nodes.map(item =>
        item.id === nodeId && item.asset_id === assetId && item.job_id === node.job_id
          ? { ...item, asset_id: node.asset_id, settings: { ...item.settings, generation_completed_job_id: node.settings.generation_completed_job_id } }
          : item) }))
      throw issue
    }
    if (queueRef.current === queue) setNotice(modality === 'video' ? '已设为当前分镜视频' : '已设为当前分镜图片')
  }

  async function archiveShotCandidate(nodeId: string, assetId: string, archived: boolean) {
    const queue = queueRef.current
    const node = queue?.graph.nodes.find(item => item.id === nodeId)
    if (!queue || !node?.shot_id) throw new Error('分镜节点已变化，请重新打开候选')
    if (archived && queue.graph.nodes.some(item => item.shot_id === node.shot_id && item.asset_id === assetId)) {
      throw new Error('该素材正在当前画布中使用，请先切换后再归档')
    }
    await api(`/shots/${node.shot_id}/candidates/${assetId}`, json('PUT', { archived }))
    await onRefresh()
    if (queueRef.current === queue) setNotice(archived ? '候选已归档，可在管理候选中恢复' : '候选已恢复')
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
        const entry = JSON.parse(pending) as string[] | { profileIds: string[]; shotId?: string }
        const ids = Array.isArray(entry) ? entry : entry.profileIds
        if (!Array.isArray(entry) && entry.shotId) void openVisualTool('bindings', { target: `shot:${entry.shotId}` })
        for (const id of ids) {
          const profile = detail.visual_profiles?.find(item => item.id === id)
          if (profile) addProfileToCanvas(profile, null)
        }
      } catch { setNotice('设定画布入口参数无效') }
    }
    open(); window.addEventListener('visual-canvas-open', open)
    return () => window.removeEventListener('visual-canvas-open', open)
  }, [graph, detail.visual_profiles, detail.id])

  useEffect(() => {
    if (!graph || !queueRef.current || queueRef.current.id !== detail.id) return
    const open = async () => {
      const queue = queueRef.current
      if (!queue || queue.id !== detail.id) return
      let request
      try { request = readScriptCanvasRequest(detail.id) } catch (issue) { setScriptCanvasError(issue instanceof Error ? issue.message : String(issue)); return }
      if (!request || request.canvas_id && request.canvas_id !== canvas.id || scriptCanvasAttempt.current === request.id) return
      if (request.result.design_id && request.result.design_id !== canvas.design_id) { setScriptCanvasError('分镜方案与当前画布不一致，请打开对应方案画布'); return }
      try { request = bindScriptCanvasRequest(detail.id, request.id, canvas.id) } catch (issue) { setScriptCanvasError(issue instanceof Error ? issue.message : String(issue)); return }
      if (!request) return
      const currentRequest = request
      scriptCanvasAttempt.current = request.id
      setScriptCanvasError('')
      let applied = false
      try {
        const imageModel = availableModels.find(model => model.modality === 'image')
        let imported: ReturnType<typeof addScriptCanvasNodes> | undefined
        changeGraph(current => {
          imported = addScriptCanvasNodes(current, currentRequest.result, currentRequest.ratio, imageModel, models, detail.assets)
          return imported.graph
        })
        if (!imported) throw new Error('画布尚未加载，请稍后重试')
        // The local graph and recoverable draft now own these nodes. A failed
        // save must retry that graph, rather than replay the import on remount.
        applied = true
        clearScriptCanvasRequest(detail.id, currentRequest.id, canvas.id)
        setViewMode('canvas'); setSidebarOpen(true); setSidebarTab('profiles'); setReferenceTargetNodeId(null)
        const focus = scriptCanvasInitialFocus(imported, currentRequest.result, detail, models)
        const targetId = focus.targetNodeId
        setSelectedNodeId(targetId || null); setSelectedNodeIds(targetId ? [targetId] : [])
        setComposerNodeId(null)
        await flush(queue)
        if (queueRef.current === queue) {
          const guidance = focus.bindingUpdateCount === focus.missingReferenceCount ? '请调整镜头设定引用'
            : `请先生成并确认设定信息图${focus.bindingUpdateCount ? '，已有图的设定需调整镜头引用' : ''}`
          setNotice(`已加入 ${imported.addedProfiles} 个设定节点、${imported.addedShots} 个分镜节点${imported.addedReferences ? `、${imported.addedReferences} 个引用图节点` : ''}，已有节点已复用${focus.missingReferenceCount ? `；${focus.missingReferenceCount} 份参考待补齐，${guidance}` : ''}`)
          const nodeIds = focus.missingReferenceCount && targetId ? [targetId] : [...imported.profileNodeIds, ...imported.shotNodeIds]
          window.requestAnimationFrame(() => { if (queueRef.current === queue) void fitView({ nodes: nodeIds.map(id => ({ id })), padding: 0.2, duration: 320 }) })
        }
      } catch (issue) {
        if (queueRef.current === queue) {
          if (applied) showError(issue)
          else setScriptCanvasError(issue instanceof Error ? issue.message : String(issue))
        }
      }
    }
    void open()
    window.addEventListener('script-canvas-open', open)
    return () => { window.removeEventListener('script-canvas-open', open) }
  }, [graph, detail.id, canvas.id, models, scriptCanvasRetry, changeGraph, flush, fitView, showError])

  function importShots(shotIds?: string[], focus = true) {
    if (!canvasShots.length) { setNotice('当前画布方案还没有可导入分镜'); return }
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
      for (const shot of canvasShots.filter(shot => !shotIds || shotIds.includes(shot.id))) {
        const revision = storyboardRevision(shot.storyboard_revision)
        const shotJobs = detail.jobs.filter((item) => {
          if (item.job_type !== 'generation' || item.shot_id !== shot.id) return false
          const request = visualJobRequest(item)
          return storyboardRevision(request.storyboard_revision) === revision
            && !request.visual_profile_id && !request.asset_task_id && request.visual_reference_generation !== true
            && !request.visual_reference_view && !['character', 'location', 'prop'].includes(String(request.source_artifact_type || ''))
        })
        const job = shotJobs[0]
        const imageModel = availableModels.find(model => model.modality === 'image')
        let settings: CanvasNode['settings'] = { ...(!job ? { modality: 'image' as const, ...imageGenerationDefaults(imageModel) } : {}), duration: shot.duration, ratio: detail.ratio,
          group_id: shot.id, storyboard_revision: revision,
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
                prompt_document: request.prompt_document, prompt_body: request.prompt_body, prompt_template: request.prompt_template || '',
                ...(request.prompt_document ? { prompt_sections: parsePromptSectionDocument(tokenizePromptReferenceNumbers(request.prompt, referenceIds), {
                  sourceText: tokenizePromptReferenceNumbers(request.prompt_template || '', referenceIds),
                }) } : {}) }
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
        const currentResults = new Set(shotJobs.map(item => item.result_asset_id))
        const assets = detail.assets.filter((asset) => asset.kind !== 'audio' && asset.source !== 'export' &&
          !referenceIds.includes(asset.id) && (asset.id === shot.selected_asset_id
            || asset.shot_id === shot.id && (revision === 0 || currentResults.has(asset.id))))
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
    if (focus && firstImported && viewMode === 'canvas' && initialViewApplied.current) {
      const node: CanvasNode = queueRef.current?.graph.nodes.find(item => item.id === firstImported!.id) || firstImported
      const wide = (viewportRef.current?.clientWidth || 0) > 900
      void setCenter(node.x + node.width / 2 + (wide ? 210 : 0), node.y + node.height / 2,
        { zoom: 1, duration: 350 })
    }
  }

  useEffect(() => {
    if (!graph) return
    const request = readShotCanvasRequest(detail.id)
    if (!request || request.canvasId !== canvas.id) return
    const shot = shotMap.get(request.shotId)
    if (!shot) { clearShotCanvasRequest(detail.id, request.requestId); return }
    setViewMode('canvas')
    initialViewApplied.current = true
    let node = graph.nodes.find(node => node.id === request.nodeId)
      || shotCanvasNode(graph.nodes, shot.id, shot.selected_asset_id)
    if (!node) {
      importShots([shot.id], false)
      node = shotCanvasNode(queueRef.current?.graph.nodes || [], shot.id, shot.selected_asset_id)
    }
    clearShotCanvasRequest(detail.id, request.requestId)
    if (!node) { setNotice('当前画布已满，请腾出节点空间后导入此镜头'); return }
    setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null); setComposerNodeId(node.id)
    const target = node
    window.requestAnimationFrame(() => {
      void setCenter(target.x + target.width / 2 + ((viewportRef.current?.clientWidth || 0) > 900 ? 80 : 0),
        target.y + target.height / 2, { zoom: 1, duration: 0 })
    })
  }, [graph, detail.id, allShots, canvas.id, setCenter])

  function organizeShotGroups() {
    if (!allShots.length) { setNotice('项目还没有分镜，请先在剧本中创建'); return }
    const titles = new Map(allShots.map((shot) => [shot.id,
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

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const selectionChanges = changes.filter((change): change is Extract<NodeChange<FlowNode>, { type: 'select' }> => change.type === 'select')
    if (selectionChanges.length) {
      // Selection is controlled in one direction only: React Flow reports
      // select changes here and we mirror them into the canvas selection state.
      // Keeping a second onSelectionChange writer lets an older non-empty
      // selection race a click and can repeatedly rebuild the whole node tree.
      const selected = new Map(selectionChanges.map((change) => [change.id, change.selected]))
      const sourceNodes = queueRef.current?.graph.nodes || graph?.nodes || []
      const selectedNodes = sourceNodes.filter((node) => visibleNodeIds.has(node.id) && (selected.get(node.id) ?? selectedIds.has(node.id)))
      const ids = selectedNodes.filter(node => selectedNodes.length === 1 || node.type !== 'project_script_ref').map(node => node.id)
      if (ids.length !== selectedNodes.length) setSelectionRevision(value => value + 1)
      setSelectedNodeIds((current) => sameStringList(current, ids) ? current : ids)
      setSelectedNodeId((current) => {
        const next = current && ids.includes(current) ? current : ids[0] || null
        return current === next ? current : next
      })
    }
    const scriptIds = new Set((queueRef.current?.graph.nodes || []).filter(node => node.type === 'project_script_ref').map(node => node.id))
    changes = changes.filter(change => change.type !== 'remove' || !scriptIds.has(change.id))
    if (!changes.some((change) => change.type === 'position' || change.type === 'dimensions' || change.type === 'remove')) return
    const removedIds = new Set(changes.flatMap((change) => change.type === 'remove' ? [change.id] : []))
    const positionChanges = changes.filter((change): change is Extract<NodeChange<FlowNode>, { type: 'position' }> => change.type === 'position')
    const dimensionChanges = changes.filter((change): change is Extract<NodeChange<FlowNode>, { type: 'dimensions' }> => change.type === 'dimensions')
    if (positionChanges.some(change => change.dragging) || dimensionChanges.some(change => change.resizing)) setComposerNodeId(null)
    // Apply only the changed fields to the latest graph. A resize observation
    // may arrive after an add/edit but before its render, so filtering the live
    // graph through the older flowNodes snapshot can delete newly added nodes
    // or restore stale positions and sizes.
    const nextEdges = (current: CanvasGraph): CanvasEdge[] => removedIds.size ? current.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)) : current.edges
    const isInteracting = positionChanges.some((change) => change.dragging) || dimensionChanges.some((change) => change.resizing)
    const queue = queueRef.current
    // During dragging/resizing, update the graph without adding history entries
    // or scheduling a request for every pointer frame. The final event commits
    // one checkpoint and one save.
    if (queue && (positionChanges.length || dimensionChanges.length) && (isInteracting || dragSnapshotRef.current)) {
      if (!dragSnapshotRef.current) dragSnapshotRef.current = cloneGraph(queue.graph)
      const next = { ...queue.graph, nodes: updateCanvasGeometry(queue.graph.nodes, changes, !!dragSnapshotRef.current), edges: nextEdges(queue.graph) }
      queue.graph = next
      setGraph(next)
      if (isInteracting) return
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
      nodes: updateCanvasGeometry(current.nodes, changes, !!dragSnapshotRef.current),
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
    if (target.type === 'image_analysis') return source.type !== 'image_analysis' && !target.asset_id
      && !graph.edges.some(edge => edge.target === target.id) && visualNodeAsset(source, detail, true)?.kind === 'image'
    if (target.type === 'video_analysis') return source.type !== 'video_analysis' && !target.asset_id
      && !graph.edges.some(edge => edge.target === target.id) && visualNodeAsset(source, detail)?.kind === 'video'
    if (source.type === 'video_analysis') return target.type === 'generation'
    if (source.type === 'image_analysis') return target.type === 'generation'
    if (target.settings.visual_template_kind) return source.type === 'text' || visualNodeAsset(source, detail, true)?.kind === 'image'
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
    const bound = source?.settings.visual_profile_id && target?.shot_id
      ? detail.shot_visual_bindings?.find(binding => binding.shot_id === target.shot_id && binding.profile_id === source.settings.visual_profile_id) : undefined
    const targetModality = target?.settings.modality || modelMap.get(target?.model_id || '')?.modality
    if (bound?.reference_assets?.length && target?.type === 'generation' && !visualBindingApplies(bound, targetModality)) {
      try {
        changeGraph(current => visualBindingReferenceAssetIds(bound).reduce((next, assetId) =>
          materializePromptReference(next, target.id, assetId, detail, { sourceNodeId: source?.id }), current))
      } catch (issue) { showError(issue) }
      return
    }
    // Active multi-view bindings retain their selected snapshots. Other
    // explicit links keep the selected/confirmed image version.
    const asset = bound?.reference_assets?.length ? undefined : bound?.board_asset_id ? assetMap.get(bound.board_asset_id)
      : source ? visualNodeAsset(source, detail, true) : undefined
    changeGraph((current) => ({ ...current, edges: [...current.edges,
      { id: crypto.randomUUID(), source: connection.source!, target: connection.target!,
        ...(asset && (asset.kind === 'image' && (target?.type === 'generation' || target?.type === 'image_analysis')
          || asset.kind === 'video' && target?.type === 'video_analysis') ? { reference_asset_id: asset.id } : {}) }] }))
    if (target?.settings.visual_template_kind) {
      setSelectedNodeId(target.id); setSelectedNodeIds([target.id]); setSelectedEdgeId(null); setComposerNodeId(target.id)
      setNotice('已连接参考，设定图提示词已更新，可编辑后生成')
    }
  }

  function openAutomaticReference(edge: Edge) {
    setSelectedNodeId(edge.target); setSelectedNodeIds([edge.target]); setSelectedEdgeId(null)
    setComposerNodeId(edge.target); setAddMenu(null); setContextMenu(null)
    const target = graph?.nodes.find(node => node.id === edge.target)
    void openVisualTool('bindings', { target: target?.shot_id ? `shot:${target.shot_id}` : undefined })
  }

  function cancelCanvasSelection() {
    setSelectedNodeId(null); setSelectedNodeIds([]); setSelectedEdgeId(null)
    setComposerNodeId(null); setContextMenu(null); setAddMenu(null)
    viewportRef.current?.focus({ preventScroll: true })
  }

  function changeNodeTypeFilter(value: NodeTypeFilter) {
    if (value === nodeTypeFilter) return
    const nodes = queueRef.current?.graph.nodes || []
    const ids = new Set(nodes.filter(node => value === 'all' || canvasNodeCategory(node, modelMap, assetMap) === value).map(node => node.id))
    filterNeedsFit.current = true
    setNodeTypeFilter(value)
    setSelectedNodeIds(current => current.filter(id => ids.has(id)))
    setSelectedNodeId(current => current && ids.has(current) ? current : null)
    setComposerNodeId(current => current && ids.has(current) ? current : null)
    setShotCandidateNodeId(current => current && ids.has(current) ? current : null)
    setSelectedEdgeId(current => {
      const edge = [...(queueRef.current?.graph.edges || []), ...automaticReferenceEdges].find(edge => edge.id === current)
      return edge && ids.has(edge.source) && ids.has(edge.target) ? current : null
    })
    setContextMenu(null); setAddMenu(null)
  }

  function selectAllCanvasNodes() {
    const nodes = (queueRef.current?.graph.nodes || []).filter(node => node.type !== 'project_script_ref' && visibleNodeIds.has(node.id))
    const ids = nodes.map(node => node.id)
    setSelectedNodeIds(ids)
    setSelectedNodeId(ids.includes(selectedNodeId || '') ? selectedNodeId : ids[0] || null)
    setSelectedEdgeId(null); setComposerNodeId(null); setContextMenu(null); setAddMenu(null)
    viewportRef.current?.focus({ preventScroll: true })
  }

  async function removeCanvasContent(nodeIds: string[], edgeIds: string[], clear = false) {
    const queue = queueRef.current
    if (!queue || queue.id !== detail.id || removalPendingRef.current) return
    const requestedNodeIds = new Set(nodeIds)
    const removableNodes = queue.graph.nodes.filter(node => node.type !== 'project_script_ref')
    const nodeIdSet = new Set(removableNodes.filter(node => requestedNodeIds.has(node.id)).map(node => node.id))
    const requestedEdgeIds = new Set(edgeIds)
    const edgeIdSet = new Set(queue.graph.edges.filter(edge => requestedEdgeIds.has(edge.id) ||
      nodeIdSet.has(edge.source) || nodeIdSet.has(edge.target)).map(edge => edge.id))
    if (!nodeIdSet.size && !edgeIdSet.size) return
    removalPendingRef.current = true
    try {
      const ok = await confirm({
        title: clear ? `清空画布（${nodeIdSet.size} 个节点）` : nodeIdSet.size > 1 ? `移除 ${nodeIdSet.size} 个节点` : '移除画布内容',
        message: `将移除${nodeIdSet.size ? ` ${nodeIdSet.size} 个节点及相关连线` : '所选连接'}。原始分镜、素材和任务记录仍会保留，可通过撤销恢复。`,
        confirmLabel: clear ? '清空画布' : '移除', danger: true,
      })
      // Confirmation belongs to the graph that opened it, even if the project
      // changes while the dialog is open. New nodes are outside its scope.
      if (!ok || queueRef.current !== queue) return
      if (clear || nodeIdSet.size === removableNodes.length && nodeIdSet.size > 0) {
        // Clearing the graph also cancels an earlier un-applied import for this
        // canvas. Returning here must not turn that old request into new nodes.
        try {
          const request = readScriptCanvasRequest(queue.id)
          if (request && (!request.canvas_id || request.canvas_id === canvas.id)) {
            clearScriptCanvasRequest(queue.id, request.id, canvas.id)
            setScriptCanvasError('')
          }
        } catch { /* An invalid handoff must not prevent removing canvas nodes. */ }
      }
      changeGraph(current => ({
        ...current,
        nodes: current.nodes.filter(node => !nodeIdSet.has(node.id)),
        edges: current.edges.filter(edge => !edgeIdSet.has(edge.id) && !nodeIdSet.has(edge.source) && !nodeIdSet.has(edge.target)),
      }))
      setSelectedNodeId(current => current && nodeIdSet.has(current) ? null : current)
      setSelectedNodeIds(current => current.filter(id => !nodeIdSet.has(id)))
      setComposerNodeId(current => current && nodeIdSet.has(current) ? null : current)
      setSelectedEdgeId(current => current && edgeIdSet.has(current) ? null : current)
      setContextMenu(null)
      setNotice(nodeIdSet.size ? `已移除 ${nodeIdSet.size} 个节点，可撤销恢复` : '已移除连接，可撤销恢复')
      viewportRef.current?.focus({ preventScroll: true })
    } finally { removalPendingRef.current = false }
  }

  function deleteSelection(nodeId: string | null = null, edgeId: string | null = selectedEdgeId) {
    return removeCanvasContent(nodeId ? [nodeId] : selectedCanvasNodeIds, edgeId ? [edgeId] : [])
  }

  function clearCanvas() {
    const current = queueRef.current?.graph
    if (current) return removeCanvasContent(current.nodes.map(node => node.id), current.edges.map(edge => edge.id), true)
  }

  function commitHistoryGraph(snapshot: CanvasGraph) {
    const queue = queueRef.current
    if (!queue || queue.id !== detail.id) return
    const next = ensureCanvasScript(syncStoryboardGraph({ ...cloneGraph(snapshot), revision: queue.graph.revision }), canvas.id, detail.name,
      queue.graph.nodes.find(node => node.type === 'project_script_ref'))
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
        duplicate.settings.generation_completed_job_id = undefined
      }
      const incoming = current.edges
        .filter((edge) => edge.target === sourceId)
        .map((edge) => ({ ...edge, id: crypto.randomUUID(), target: duplicateId }))
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
      if (!selectedCanvasNodeIds.includes(target.nodeId)) setSelectedNodeIds([target.nodeId])
      if (selectedCanvasNodeIds.length > 1 && selectedCanvasNodeIds.includes(target.nodeId)) setComposerNodeId(null)
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
      y: Math.max(10, Math.min(event.clientY - bounds.top, Math.max(10, bounds.height - (target.edgeId ? 300 : 500)))),
      ...target,
    })
    setAddMenu(null)
  }

  function generationReferences(assetIds: string[]): GenerationNodeReference[] {
    return assetIds.map(assetId => {
      const asset = assetMap.get(assetId)
      const reference = videoReferences.find(item => item.asset_id === assetId)
      return { assetId, label: reference?.name || asset?.filename || assetId, kind: asset?.kind || 'unknown',
        available: !!asset, usage: reference?.usage || (reference?.purpose === 'storyboard' ? 'storyboard' : null) }
    })
  }

  function selectedGenerationCapabilities() {
    if (!selectedNode || selectedNode.type !== 'generation') return
    const queue = queueRef.current
    const inputKey = generationInputKey
    const referenceVideo = ['reference', 'edit', 'extend'].includes(selectedMode)
      ? (selectedNode.settings.reference_video_url || inputVideo?.remote_url || '') : ''
    const videoAssetId = referenceVideo.startsWith('asset://') ? referenceVideo.slice('asset://'.length) : undefined
    return createGenerationNodeCapabilities({
      state: { projectId: detail.id, canvasId: canvas.id, node: { id: selectedNode.id, title: selectedNode.title },
        model: selectedModel ? { id: selectedModel.id, name: selectedModel.name, modality: selectedModel.modality } : null,
        job: selectedJob ? { id: selectedJob.id, status: selectedJob.status } : null, generating: !!selectedNodeGenerating },
      references: generationReferences([...new Set([...preparedReferenceIds, ...(videoAssetId ? [videoAssetId] : [])])]),
      isCurrent: () => !!queue && queueRef.current === queue && generationInputRef.current === inputKey,
      preparePreview: prepareGeneration,
    })
  }

  async function prepareGeneration(): Promise<GenerationReview | undefined> {
    if (previewingRef.current) return
    if (!selectedNode || selectedNode.type !== 'generation') return
    const queue = queueRef.current
    const inputKey = generationInputKey
    const isCurrent = () => !!queue && queueRef.current === queue && generationInputRef.current === inputKey
    if (!isCurrent()) return
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
    if (selectedTemplateKind && !preparedReferenceIds.length) { setNotice('请先连接图片或添加参考图，再生成设定图'); return }
    if (promptReferenceIssue) { setNotice(promptReferenceIssue); return }
    if (promptParameterConflicts.length) { setNotice(promptParameterConflicts[0].message); return }
    if (promptSourcePending) { setNotice('设定来源已更新，请在「设定来源与同步」中确认保留本节点修改或跟随项目'); return }
    if (preparedReferenceIds.some(id => assetMap.get(id)?.kind !== 'image')) { setNotice('提示词引用的图片已不存在，请重新选择'); return }
    if (missingReferences.length) {
      setNotice(`请先补齐参考图：${missingReferences.map(reference => reference.name).join('、')}，点击「待补齐参考图」中的对应项定位处理`)
      return
    }
    if (!composerHasContent) { setNotice('请输入提示词'); return }
    if (selectedProfile) {
      if (profileDraftDirty && profileInspectorId === selectedProfile.id) { setNotice('请先保存右侧编辑的设定，再生成信息图'); return }
      previewingRef.current = true; setBusy(true)
      try {
        const prepared = await prepareCanvasVisualBoard(selectedNode, selectedProfile, queue!.graph, detail, model, composerPrompt)
        if (!isCurrent()) return
        return { ...prepared,
          provider: providers.find(provider => provider.id === model.provider_id) }
      } catch (issue) { if (isCurrent()) showError(issue) } finally { previewingRef.current = false; if (queueRef.current === queue) setBusy(false) }
      return
    }
    const missingProfileReference = composerReferences.find(node => {
      if (!node.settings.visual_profile_id
        || composerModality === 'video' && selectedMode === 'first_frame' && selectedNode.settings.storyboard_reference_asset_id) return false
      const binding = visualReferenceMode === 'profiles' && visualBindings.find(binding => binding.profile_id === node.settings.visual_profile_id)
      const ids = binding ? visualBindingReferenceAssetIds(binding) : []
      return binding ? !ids.length || ids.some(id => assetMap.get(id)?.kind !== 'image') : !visualNodeAsset(node, detail, true)
    })
    if (missingProfileReference) { setNotice(`请先确认 ${missingProfileReference.title} 的设定图`); return }
    if (!composerPrompt.trim() || !compiledPrompt.trim() && !selectedNode.settings.prompt_is_final) { setNotice('请输入提示词或连接文本节点'); return }
    const mode = model.modality === 'video' ? selectedMode : 'text'
    if (model.modality === 'video' && !supportedModes(model).includes(mode)) {
      setNotice('当前模型不支持所选模式')
      return
    }
    if (model.modality === 'video') {
      const issue = videoReferenceConfigError(model.settings, preparedReferenceIds.length, mode)
      if (issue) { setNotice(issue); return }
    }
    const imageReferenceModes = model.settings.video_reference_profile === 'seedance_2_5'
      ? ['first_frame', 'first_last_frame', 'reference', 'edit', 'extend'] : ['first_frame', 'first_last_frame', 'reference']
    if (preparedReferenceIds.length && model.modality === 'video' && !imageReferenceModes.includes(mode)) {
      setNotice('连接的参考图未被当前模式使用，请选择首帧、首尾帧或参考生成')
      return
    }
    if (preparedReferenceIds.length && model.modality === 'image') {
      const referenceIssue = imageReferenceConfigError(model.settings, preparedReferenceIds.length, 'reference')
      if (referenceIssue) { setNotice(referenceIssue); return }
    }
    if (preparedReferenceIds.length && model.modality === 'text') {
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
    if (mode === 'first_frame' && preparedReferenceIds.length !== 1) { setNotice('首帧模式需要引用 1 张图片'); return }
    if (mode === 'first_last_frame' && preparedReferenceIds.length !== 2) { setNotice('首尾帧模式需要引用 2 张图片'); return }
    const videoUrl = ['reference', 'edit', 'extend'].includes(mode)
      ? (selectedNode.settings.reference_video_url || inputVideo?.remote_url || '').trim() : ''
    if (['edit', 'extend'].includes(mode) && !videoUrl) { setNotice('编辑或延长模式需要参考视频地址'); return }
    if (mode === 'reference' && !preparedReferenceIds.length && !videoUrl) { setNotice('参考生成需要引用图片或视频地址'); return }
    // Image generation has no duration parameter. Keep the request value
    // neutral so a newly created image task does not look like a 5-second
    // video in the confirmation dialog or create an unnecessarily long shot.
    const duration = model.modality === 'video' ? composerDuration : shot?.duration || 1
    if (!Number.isInteger(duration) || duration < durationMin || duration > durationMax) {
      setNotice(`生成时长需在 ${durationMin}–${durationMax} 秒之间`)
      return
    }
    const ratio = composerRatio
    const clarity = model.modality === 'image'
      ? composerClarity : null
    const baseResolution = model.modality === 'video' ? composerResolution
      : selectedNode.settings.resolution || (model.modality === 'text' ? null : modelDefaultResolution(model, resolutions) || null)
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
      ...(selectedTemplateKind ? { source_artifact_type: selectedTemplateKind } : {}),
      project_style_version: detail.project_visual_style?.version,
      shot_id: shot?.id || '', model_id: model.id,
      ...(shot ? { storyboard_revision: storyboardRevision(selectedNode.settings.storyboard_revision) } : {}),
      visual_reference_mode: visualReferenceMode,
      excluded_visual_profile_ids: selectedNode.settings.excluded_visual_profile_ids || [],
      prompt_reference_overrides: promptOverrides,
      ...(model.modality === 'video' ? { storyboard_reference_asset_id: mode === 'reference' ? storyboardReferenceAssetId || null : null,
        video_reference_usages: mode === 'reference' ? activeVideoReferenceUsages : [] } : {}),
      prompt: composerPrompt.trim(), prompt_is_final: true, prompt_document: true, prompt_body: composerBody, prompt_template: automaticPromptDraft,
      ...(compiledPrompt.trim() ? { visual_source_prompt: compiledPrompt.trim() } : {}),
      mode: model.modality === 'image' ? imageMode : mode,
      reference_asset_ids: resolvePromptReferences({ prompt: explicitReferencePrompt, referenceAssetIds: inputImages.map(asset => asset.id), overrides: promptOverrides }).referenceAssetIds,
      ...(explicitReferenceIds.length ? { explicit_reference_asset_ids: explicitReferenceIds } : {}),
      reference_video_url: videoUrl || null, resolution, clarity, quality, background, duration, ratio,
      generate_audio: supportsAudio ? selectedNode.settings.generate_audio ?? true : false,
      draft: model.settings.supports_draft === true && selectedNode.settings.draft === true,
    }
    previewingRef.current = true
    setBusy(true)
    try {
      const prepared = await api<GenerationRequest>(`/projects/${detail.id}/generate/preview`, json('POST', { ...request, shot_id: request.shot_id || null }))
      if (!isCurrent()) return
      return { candidateCount: Math.max(1, Math.min(4, Math.trunc(selectedNode.settings.candidate_count || 1))),
        nodeId: selectedNode.id, request: { ...prepared, shot_id: prepared.shot_id || '' }, shot: shot || { title: selectedNode.title || `镜头 ${String(detail.shots.length + 1).padStart(2, '0')}` }, model,
        provider: providers.find((provider) => provider.id === model.provider_id),
        referenceNames: prepared.reference_asset_ids.map((id, index) => {
          const reference = model.modality === 'video' ? videoReferences.find(entry => entry.asset_id === id) : undefined
          return reference ? `图片${index + 1}：${reference.name}${reference.variant ? ` · ${reference.variant}` : ''}（${reference.usage ? videoReferenceUsageLabels[reference.usage] : reference.purpose === 'storyboard' ? '整体构图' : '按素材设定'}）` : assetMap.get(id)?.filename || id
        }) }
    } catch (issue) {
      if (!isCurrent()) return
      if (issue instanceof Error && issue.message.includes('镜头设定引用已更新，请刷新画布并重新检查生成参数')) {
        try {
          await onRefresh()
          if (isCurrent()) setNotice('镜头设定引用已更新，已刷新画布。请检查提示词和生成参数后重新生成。')
        } catch (refreshIssue) { if (isCurrent()) showError(refreshIssue) }
      } else showError(issue)
    }
    finally { previewingRef.current = false; if (queueRef.current === queue) setBusy(false) }
  }

  async function showGenerationInfo() {
    if (generationInfoOpen) { setGenerationInfoOpen(false); return }
    if (busy || previewingRef.current || submittingRef.current) return
    setReview(null)
    setGenerationInfoOpen(true)
    const inputKey = generationInputKey
    const queue = queueRef.current
    const prepared = await selectedGenerationCapabilities()?.preparePreview()
    if (inputKey !== generationInputRef.current || queueRef.current !== queue) return
    if (prepared) setReview(prepared)
    else setGenerationInfoOpen(false)
  }

  async function runGeneration() {
    if (previewingRef.current || submittingRef.current) return
    let pending: CanvasGenerationSubmission | null = null
    try { pending = selectedNode ? readCanvasGenerationSubmission({ projectId: detail.id, canvasId: canvas.id, nodeId: selectedNode.id }) : null }
    catch (error) { showError(error); return }
    if (pending && !canvasGenerationSubmissionFinished(pending)) {
      setGenerationSubmissions(value => ({ ...value, [pending.nodeId]: pending }))
      await resumeGenerationSubmission(pending.nodeId, false)
      return
    }
    setGenerationInfoOpen(false)
    setReview(null)
    const inputKey = generationInputKey
    const queue = queueRef.current
    const prepared = await selectedGenerationCapabilities()?.preparePreview()
    if (inputKey !== generationInputRef.current || queueRef.current !== queue) return
    if (prepared) await submitGeneration(prepared, inputKey)
  }

  async function addGenerationToDirector() {
    if (!onOpenDirectorPanel || busy || previewingRef.current || submittingRef.current || nodeProposalHandoffRef.current) return
    const capabilities = selectedGenerationCapabilities()
    const queue = queueRef.current
    const inputKey = generationInputKey
    if (!capabilities || !queue) return
    const isCurrent = () => queueRef.current === queue && generationInputRef.current === inputKey
    nodeProposalHandoffRef.current = true; setBusy(true)
    try {
      await flush(queue)
      if (!isCurrent()) return
      const prepared = await capabilities.preparePreview()
      if (!prepared || !isCurrent()) return
      previewingRef.current = true; setBusy(true)
      const references = capabilities.readReferences()
      const resolvedIds = prepared.request.reference_asset_ids.filter(id => !references.some(reference => reference.assetId === id))
      const actualReferences = [...references, ...generationReferences(resolvedIds)]
      const context = generationNodeDirectorContext(capabilities.readState(), actualReferences, prepared)
      let source: CanvasNodeProposalSource | undefined
      const request = prepared.request
      if (!selectedProfile && selectedNode?.type === 'generation' && ['image', 'video'].includes(prepared.model.modality)
        && (!request.reference_video_url || request.reference_video_url.startsWith('asset://'))) {
        // Saving the canvas updates the project timestamp. Read the owning
        // record after flush rather than binding a source to stale props.
        const currentProject = await api<ProjectDetail>(`/projects/${detail.id}`)
        if (!isCurrent()) return
        const creativeContext = (project: ProjectDetail) => ({ style: project.project_visual_style, shots: allProjectShots(project),
          bindings: project.shot_visual_bindings, profiles: project.visual_profiles })
        if (canvasNodeProposalSourceKey(creativeContext(currentProject)) !== canvasNodeProposalSourceKey(creativeContext(detail))) {
          await onRefresh()
          if (isCurrent()) setNotice('项目创作来源已更新，请检查节点后重新添加快照')
          return
        }
        const serial = queue.serial, revision = queue.base.revision
        const fingerprint = await canvasNodeProposalFingerprint(queue.graph, selectedNode.id)
        if (!isCurrent() || queue.serial !== serial || queue.base.revision !== revision) return
        source = { project_id: detail.id, project_updated_at: currentProject.updated_at,
          project_style_version: currentProject.project_visual_style?.version || null,
          canvas_id: canvas.id, canvas_revision: revision, source_node_id: selectedNode.id, source_fingerprint: fingerprint,
          model_id: request.model_id, modality: prepared.model.modality as 'image' | 'video', mode: request.mode, prompt: request.prompt,
          parameters: { ratio: request.ratio, resolution: request.resolution, duration: request.duration, generate_audio: request.generate_audio,
            draft: request.draft, clarity: request.clarity ?? null, quality: request.quality ?? null, background: request.background ?? null, candidate_count: prepared.candidateCount },
          reference_assets: request.reference_asset_ids.map(asset_id => ({ asset_id, usage: request.video_reference_usages?.find(item => item.asset_id === asset_id)?.usage || null })),
          reference_video_asset_id: request.reference_video_url ? request.reference_video_url.slice('asset://'.length) : null,
          shot_id: request.shot_id || null, storyboard_revision: request.storyboard_revision ?? null,
          storyboard_reference_asset_id: request.storyboard_reference_asset_id || null }
        nodeProposalSourcesRef.current.set(canvasNodeProposalSourceKey(source), queue)
        if (nodeProposalSourcesRef.current.size > 4) nodeProposalSourcesRef.current.delete(nodeProposalSourcesRef.current.keys().next().value!)
      }
      if (!isCurrent()) return
      setGenerationInfoOpen(false)
      onOpenDirectorPanel('all', context, source)
    } catch (issue) { if (isCurrent()) showError(issue) }
    finally {
      nodeProposalHandoffRef.current = false; previewingRef.current = false
      if (queueRef.current === queue) setBusy(false)
    }
  }

  function applyNodeProposal(proposal: CanvasNodeProposal): Promise<CanvasNodeProposalApplyResult> {
    const running = applyingNodeProposalRef.current
    if (running) return running.id === proposal.id ? running.promise : Promise.reject(new Error('另一个调整草稿正在保存，请稍后重试'))
    const execute = async (): Promise<CanvasNodeProposalApplyResult> => {
      const queue = queueRef.current
      if (!queue || !canvasNodeProposalSourceMatches(proposal.source, detail.id, canvas.id)) throw new Error('调整方案不属于当前项目画布，请回到来源画布')
      if (busy || previewingRef.current || submittingRef.current || nodeProposalHandoffRef.current) throw new Error('请等待当前画布操作完成')
      setBusy(true)
      const sourceKey = canvasNodeProposalSourceKey(proposal.source)
      try {
        assertCanvasNodeProposalValues(proposal)
        const existing = queue.graph.nodes.find(node => node.id === proposal.created_node_id)
        if (existing) {
          if (existing.type !== 'generation') throw new Error('调整草稿标识已被其他节点使用')
          await flush(queue)
          return { nodeId: existing.id, referenceNodeCount: 0, alreadyApplied: true }
        }
        if (nodeProposalSourcesRef.current.get(sourceKey) !== queue) throw new Error('来源快照已过期，请重新添加节点快照')
        await flush(queue)
        const serial = queue.serial, revision = queue.base.revision
        const isCurrent = () => queueRef.current === queue && queue.serial === serial && queue.base.revision === revision
        if (!isCurrent()) throw new Error('画布已切换，请重新打开调整方案')
        const currentProject = await api<ProjectDetail>(`/projects/${detail.id}`)
        if (!isCurrent()) throw new Error('画布配置已更新，请重新添加节点快照')
        const currentModels = proposalModelInputsRef.current
        const modelGuard = canvasNodeProposalSourceKey(currentModels)
        const model = await assertCanvasNodeProposalCurrent(queue.graph, proposal, currentProject, currentModels.models, currentModels.providers)
        if (!isCurrent()) throw new Error('画布配置已更新，请重新添加节点快照')
        const validation = await api<{ valid: boolean }>(`/projects/${detail.id}/canvases/${canvas.id}/node-proposals/validate`, json('POST', {
          source: proposal.source, validation_fingerprint: proposal.validation_fingerprint,
        }))
        if (validation.valid !== true) throw new Error('来源验证未通过，请重新生成调整方案')
        if (!isCurrent() || canvasNodeProposalSourceKey(proposalModelInputsRef.current) !== modelGuard) throw new Error('来源或模型配置已更新，请重新添加节点快照')
        let added: ReturnType<typeof addCanvasNodeProposalDraft> | undefined
        changeGraph(current => { added = addCanvasNodeProposalDraft(current, proposal, currentProject, model); return added.graph }, { freezeLegacyReferences: false })
        if (!added) throw new Error('画布还未载入')
        setViewMode('canvas'); setSelectedNodeId(added.node.id); setSelectedNodeIds([added.node.id]); setSelectedEdgeId(null); setComposerNodeId(added.node.id)
        setNotice(`已创建导演调整草稿${added.referenceNodeCount ? `与 ${added.referenceNodeCount} 个固定参考节点` : ''}，检查后可手动生成；可撤销本次新增`)
        await flush(queue)
        if (queueRef.current !== queue) throw new Error('草稿已保存到来源画布，请回到该画布查看')
        return { nodeId: added.node.id, referenceNodeCount: added.referenceNodeCount, alreadyApplied: added.alreadyApplied }
      } finally { if (queueRef.current === queue) setBusy(false) }
    }
    const promise = execute().finally(() => { if (applyingNodeProposalRef.current?.promise === promise) applyingNodeProposalRef.current = null })
    applyingNodeProposalRef.current = { id: proposal.id, promise }
    return promise
  }

  nodeProposalActionsRef.current = { apply: applyNodeProposal }
  useEffect(() => {
    registerNodeProposalActions?.({ apply: proposal => nodeProposalActionsRef.current!.apply(proposal) })
    return () => registerNodeProposalActions?.(null)
  }, [registerNodeProposalActions])

  async function associateGenerationSubmission(queue: SaveQueue, item: CanvasGenerationSubmission) {
    if (queueRef.current !== queue) return
    setGenerationSubmissions(value => ({ ...value, [item.nodeId]: item }))
    if (queue.conflict) return
    const node = queue.graph.nodes.find(value => value.id === item.nodeId)
    const accepted = item.candidates.flatMap(candidate => candidate.jobId ? [candidate.jobId] : [])
    const latestJobId = accepted.at(-1)
    if (!node || canvasGenerationSubmissionSource(queue.graph, item.nodeId, item.shot?.id) !== item.sourceSignature
      || node.job_id !== item.baselineJobId && !accepted.includes(node.job_id || '')) return
    const shotId = item.shot?.id || node.shot_id
    if (shotId !== node.shot_id || latestJobId && latestJobId !== node.job_id) {
      changeGraph(value => ({ ...value, nodes: value.nodes.map(current => current.id === item.nodeId ? {
        ...current, shot_id: shotId, ...(latestJobId ? { job_id: latestJobId, asset_id: null,
          settings: { ...current.settings, generation_completed_job_id: undefined } } : {}),
      } : current) }), { freezeLegacyReferences: false })
    }
    await flush(queue)
  }

  async function recoverSavedGenerationSubmissions(queue: SaveQueue) {
    let refreshNeeded = false
    for (const node of queue.graph.nodes) {
      if (queueRef.current !== queue) return
      const scope = { projectId: queue.id, canvasId: canvas.id, nodeId: node.id }
      let item: CanvasGenerationSubmission | null
      try { item = readCanvasGenerationSubmission(scope) } catch (error) { if (queueRef.current === queue) showError(error); continue }
      if (!item) continue
      setGenerationSubmissions(value => ({ ...value, [node.id]: item! }))
      if (item.candidates.some(candidate => candidate.jobId && !detail.jobs.some(job => job.id === candidate.jobId))) refreshNeeded = true
      const latestJob = item.candidates.flatMap(candidate => candidate.jobId ? [candidate.jobId] : []).at(-1)
      if (canvasGenerationSubmissionFinished(item) && (item.rejected || latestJob === node.job_id)) continue
      const key = `${queue.storageId}:${node.id}`
      if (recoveringGenerationSubmissionsRef.current.has(key)) continue
      const pending = withCanvasGenerationSubmissionLock(scope, false, async () => {
        if (queueRef.current !== queue) return
        const live = readCanvasGenerationSubmission(scope)
        if (!live) return
        await associateGenerationSubmission(queue, live)
        await recoverCanvasGenerationSubmission(live, { onProgress: async value => {
          if (value.candidates.some(candidate => candidate.jobId && !detail.jobs.some(job => job.id === candidate.jobId))) refreshNeeded = true
          await associateGenerationSubmission(queue, value)
        } })
      }).catch(error => { if (queueRef.current === queue) setNotice(`已有提交待确认，可在原节点检查或继续。${error instanceof Error ? error.message : String(error)}`) })
        .finally(() => { if (recoveringGenerationSubmissionsRef.current.get(key) === pending) recoveringGenerationSubmissionsRef.current.delete(key) })
      recoveringGenerationSubmissionsRef.current.set(key, pending)
      await pending
    }
    if (refreshNeeded && queueRef.current === queue) {
      try { await onRefresh() } catch (error) { if (queueRef.current === queue) showError(error) }
    }
  }

  async function resumeGenerationSubmission(nodeId: string, allowSubmit: boolean) {
    if (submittingRef.current || previewingRef.current) return
    const queue = queueRef.current
    if (!queue) return
    submittingRef.current = true
    setBusy(true)
    try {
      const scope = { projectId: detail.id, canvasId: canvas.id, nodeId }
      await withCanvasGenerationSubmissionLock(scope, allowSubmit, async () => {
        if (queueRef.current !== queue) return
        const item = readCanvasGenerationSubmission(scope)
        if (!item) throw new Error('没有待恢复的生成提交')
        if (allowSubmit) await flush(queue)
        await associateGenerationSubmission(queue, item)
        const recovered = await recoverCanvasGenerationSubmission(item, { allowSubmit,
          isActive: () => queueRef.current === queue && queue.graph.nodes.some(node => node.id === nodeId),
          onProgress: value => associateGenerationSubmission(queue, value) })
        if (queueRef.current !== queue) return
        const count = recovered.candidates.filter(candidate => candidate.jobId).length
        setNotice(recovered.rejected ? `原提交已接收 ${count}/${recovered.candidates.length} 个任务，其余被拒绝。再次生成会创建全新一轮。${recovered.rejected}`
          : count === recovered.candidates.length ? `已找回 ${count} 个生成任务`
          : `已确认 ${count}/${recovered.candidates.length} 个任务；继续原提交会沿用原参数和候选数量`)
      })
      if (queueRef.current === queue) await onRefresh()
    } catch (error) {
      if (queueRef.current === queue) { showError(error); await onRefresh().catch(() => {}) }
    }
    finally { submittingRef.current = false; if (queueRef.current === queue) setBusy(false) }
  }

  async function submitGeneration(current: GenerationReview, inputKey: string) {
    if (submittingRef.current) return
    const sourceQueue = queueRef.current
    submittingRef.current = true
    setBusy(true)
    const candidateCount = current.candidateCount
    try {
      const queue = queueRef.current
      if (!queue) throw new Error('画布还未载入')
      await flush(queue)
      if (inputKey !== generationInputRef.current || queueRef.current !== queue) return
      const request = current.request
      if (current.board) {
        const { model_id, project_style_version, prompt, ratio, resolution, clarity, quality, background } = request
        const generated = await enqueueCanvasVisualBoard(current.board, { model_id, project_style_version, prompt, ratio, resolution, clarity, quality, background }, candidateCount)
        updateNodeById(current.nodeId, { job_id: generated.job.id })
        setReview(null); setNotice(candidateCount > 1 ? `已加入 ${candidateCount} 个设定图候选生成任务` : '设定图生成任务已加入队列')
        await flush(queue); await onRefresh(); return
      }
      const scope = { projectId: detail.id, canvasId: canvas.id, nodeId: current.nodeId }
      await withCanvasGenerationSubmissionLock(scope, true, async () => {
        if (queueRef.current !== queue || inputKey !== generationInputRef.current) return
        const node = queue.graph.nodes.find(value => value.id === current.nodeId)
        if (!node) throw new Error('来源节点已删除')
        const previous = readCanvasGenerationSubmission(scope)
        const item = createCanvasGenerationSubmission({ ...scope, request: { ...request, shot_id: request.shot_id || null },
          candidateCount, sourceSignature: canvasGenerationSubmissionSource(queue.graph, node.id), baselineJobId: node.job_id,
          ...(!request.shot_id && !request.source_artifact_type ? { shotInput: {
            title: current.shot.title, prompt: (request.visual_source_prompt || request.prompt).slice(0, 10000), duration: request.duration,
          } } : {}),
        })
        setGenerationSubmissions(value => ({ ...value, [item.nodeId]: item }))
        await associateGenerationSubmission(queue, item)
        // A different tab may have created this intent while preview/save was
        // pending. Only the explicit continuation action may submit that batch.
        const result = await recoverCanvasGenerationSubmission(item, { allowSubmit: item.id !== previous?.id,
          isActive: () => queueRef.current === queue && queue.graph.nodes.some(value => value.id === current.nodeId),
          onProgress: value => associateGenerationSubmission(queue, value) })
        if (queueRef.current !== queue) return
        const count = result.candidates.filter(value => value.jobId).length
        setNotice(count === result.candidates.length ? count > 1 ? `已加入 ${count} 个候选生成任务` : '生成任务已加入队列'
          : `已确认 ${count}/${result.candidates.length} 个任务，请检查已有任务或继续原提交`)
      })
      setReview(null)
      if (queueRef.current === queue) await onRefresh()
    } catch (error) {
      setReview(null)
      if (queueRef.current?.id === detail.id) setNotice(`提交未完成或状态未确认，原提交已保留，可检查已有任务或继续原提交。${error instanceof Error ? error.message : String(error)}`)
      if (queueRef.current === sourceQueue) await onRefresh().catch(() => {})
    } finally {
      submittingRef.current = false
      if (queueRef.current === sourceQueue) setBusy(false)
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
      const remote = normalizeGraph(await api<CanvasGraph>(canvasGraphPath(queue.id, queue.canvasId)))
      setConflictReview(mergeGraphs(queue.base, queue.graph, remote))
    } catch (error) { showError(error) }
  }

  async function applyMerge() {
    const queue = queueRef.current
    if (!queue || !conflictReview) return
    queue.base = conflictReview.remote
    queue.graph = ensureCanvasScript(syncStoryboardGraph(conflictReview.merged), canvas.id, detail.name)
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
    queue.graph = ensureCanvasScript(syncStoryboardGraph(conflictReview.remote), canvas.id, detail.name)
    queue.serial = queue.graph === conflictReview.remote ? 0 : 1
    queue.savedSerial = 0
    queue.conflict = false
    clearDraft(queue.storageId)
    setGraph(queue.graph)
    setSaveState('saved')
    setConflictReview(null)
    setSelectedNodeId(null)
    setSelectedNodeIds([])
    if (queue.serial) { keepDraft(queue); scheduleSave(queue) }
  }

  const canvasLeaveRef = useRef<CanvasActions | null>(null)
  canvasLeaveRef.current = {
    revision: () => queueRef.current?.base.revision,
    leave: async () => {
      if (busy || submittingRef.current || removalPendingRef.current || visualPanelBusy) { setNotice('请等待当前操作完成'); return false }
      if (!await leaveVisualPanel()) return false
      const queue = queueRef.current
      if (!queue) { setNotice('画布尚未加载'); return false }
      try { await flush(queue); canvasSession.revision = queue.base.revision; return true } catch (issue) { showError(issue); return false }
    },
    move: async targetId => {
      const ids = selectedCanvasNodeIds.filter(id => queueRef.current?.graph.nodes.find(node => node.id === id)?.type !== 'project_script_ref')
      if (!ids.length) { setNotice('请先选择要移动的节点'); return false }
      if (!await canvasLeaveRef.current!.leave()) return false
      const queue = queueRef.current!
      const selected = new Set(ids)
      const crossing = queue.graph.edges.filter(edge => selected.has(edge.source) !== selected.has(edge.target)).length
      if (crossing && !await confirm({ title: '移动所选节点', message: `所选节点之间的连线会保留，与留在当前画布的节点之间 ${crossing} 条连线将移除。`, confirmLabel: '移动节点' })) return false
      try {
        await flush(queue)
        const target = await api<CanvasGraph>(canvasGraphPath(detail.id, targetId))
        const result = await api<{ source: CanvasGraph }>(`/projects/${detail.id}/canvases/${canvas.id}/move-nodes`, json('POST', {
          target_canvas_id: targetId, node_ids: ids, revision: queue.base.revision, target_revision: target.revision,
        }))
        queue.graph = normalizeGraph(result.source); queue.base = queue.graph; queue.serial = 0; queue.savedSerial = 0
        clearDraft(storageId); setGraph(queue.graph); setSelectedNodeId(null); setSelectedNodeIds([]); setSelectedEdgeId(null)
        historyRef.current = { past: [], future: [] }; canvasSession.history = historyRef.current
        return true
      } catch (issue) { showError(issue); return false }
    },
  }
  useEffect(() => {
    registerCanvasActions({ revision: () => canvasLeaveRef.current!.revision(), leave: () => canvasLeaveRef.current!.leave(), move: target => canvasLeaveRef.current!.move(target) })
    return () => registerCanvasActions(null)
  }, [registerCanvasActions])

  const sidebarNodes = useMemo(() => {
    const query = sidebarSearch.trim().toLocaleLowerCase()
    return (graph?.nodes || [])
      .filter((node) => sidebarFilter === 'all' || node.type === sidebarFilter
        || (sidebarFilter === 'text' && (node.type === 'project_script_ref' || node.type === 'image_analysis' || node.type === 'video_analysis')))
      .filter((node) => {
        if (!query) return true
        const shotTitle = shotMap.get(node.shot_id || '')?.title || ''
        return `${node.title} ${node.text} ${shotTitle}`.toLocaleLowerCase().includes(query)
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
  }, [shotMap, graph?.nodes, sidebarFilter, sidebarSearch])
  const scopedSidebarProfiles = useMemo(() => (detail.visual_profiles || []).filter(profile =>
    profileScope === 'all' || (profile.design_id || null) === (canvas.design_id || null)),
  [detail.visual_profiles, canvas.design_id, profileScope])
  const sidebarProfiles = useMemo(() => scopedSidebarProfiles.filter(profile =>
    (profileFilter === 'all' || profile.kind === profileFilter)
    && `${profile.name} ${profile.variant}`.toLocaleLowerCase().includes(profileSearch.trim().toLocaleLowerCase())),
  [scopedSidebarProfiles, profileFilter, profileSearch])
  const availableSidebarAssets = useMemo(() => detail.assets.filter(asset =>
    (asset.saved || !!referenceTargetNodeId) && asset.source !== 'export'), [detail.assets, referenceTargetNodeId])
  const sidebarAssets = useMemo(() => {
    const query = sidebarAssetSearch.trim().toLocaleLowerCase()
    return availableSidebarAssets
      .filter((asset) => sidebarAssetFilter === 'all' || asset.kind === sidebarAssetFilter)
      .filter((asset) => {
        if (!query) return true
        const shotTitle = shotMap.get(asset.shot_id || '')?.title || ''
        return `${assetLabels.get(asset.id)?.title || ''} ${asset.filename} ${shotTitle}`.toLocaleLowerCase().includes(query)
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [availableSidebarAssets, shotMap, assetLabels, sidebarAssetFilter, sidebarAssetSearch])
  const contextNode = contextMenu?.nodeId ? graph?.nodes.find((node) => node.id === contextMenu.nodeId) : undefined
  const previewShot = nodeMediaPreview ? shotMap.get(nodeMediaPreview.shotId || nodeMediaPreview.asset.shot_id || '') : undefined
  const contextEdge = contextMenu?.edgeId ? graph?.edges.find((edge) => edge.id === contextMenu.edgeId) : undefined
  const contextSelectionCount = contextNode && selectedCanvasNodeIds.includes(contextNode.id) ? selectedCanvasNodeIds.length : 0

  useEffect(() => {
    if (!selectedNodeId) return
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.react-flow__node-toolbar, .react-flow__node, .react-flow__nodesselection, .react-flow__selection, .pc-text-editor-modal-root, .pc-context-menu, .pc-add-menu, [data-canvas-overlay], .mantine-Select-dropdown, .mantine-Combobox-dropdown, [role="listbox"], .mantine-Modal-root, .mantine-Drawer-root, [role="menu"]')) return
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
      if (event.target instanceof Element && event.target.closest('.mantine-Modal-root, .mantine-Drawer-root')) {
        // Mantine handles the focus loop on document; Tab must reach it.
        if (event.key !== 'Tab') event.stopPropagation()
        return
      }
      // Keep canvas shortcuts close to the interaction surface. Editing controls
      // own Backspace/Delete so removing a selected node never truncates text.
      if (event.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); event.stopPropagation(); return }
        if (addMenu) { setAddMenu(null); event.stopPropagation(); return }
        if (composerBindingsOpen) {
          closeComposerBindings()
          event.stopPropagation(); return
        }
        if (visualTool || inspectedProfile) { void closeVisualPanel(); event.stopPropagation(); return }
        setSelectedNodeId(null)
        setSelectedNodeIds([])
        setSelectedEdgeId(null)
        event.stopPropagation()
        return
      }
      if (isCanvasEditingTarget(event.target)) return
      if (viewMode === 'canvas' && event.target instanceof Element && event.target.closest('.pc-flow') &&
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        event.stopPropagation()
        selectAllCanvasNodes()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && selectedNodeId) {
        event.preventDefault()
        event.stopPropagation()
        duplicateSelection()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedCanvasNodeIds.length || selectedEdgeId)) {
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
    <FileButton ref={uploadInputRef} accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4" multiple onChange={files => { if (files.length) void uploadCanvasFiles(files) }}>{() => null}</FileButton>
    <FileButton ref={referenceUploadInputRef} accept="image/png,image/jpeg,image/webp" multiple onChange={files => { if (files.length && referenceUploadTargetId) void uploadCanvasFiles(files) }}>{() => null}</FileButton>
    <div className={`pc-toolbar ${viewMode === 'storyboard' ? 'pc-toolbar-storyboard' : ''}`}>
      <div className="pc-canvas-nav">
        <Tooltip label="项目"><ActionIcon variant="subtle" aria-label="返回项目" onClick={() => onNavigate('projects')}><FolderOpen size={18} /></ActionIcon></Tooltip>
        {projectNameEditing
          ? <TextInput ref={projectNameInputRef} className="pc-project-name-input" aria-label="编辑项目名称" value={projectNameDraft}
            onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
            onBlur={() => void saveProjectName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void saveProjectName() }
              if (event.key === 'Escape') { event.preventDefault(); cancelProjectNameEdit() }
            }} />
          : <UnstyledButton type="button" className="pc-project-name" title="编辑项目名称" onClick={() => setProjectNameEditing(true)}>{detail.name}</UnstyledButton>}
        <Menu shadow="md" width={172} position="bottom-start"><Menu.Target><ActionIcon variant="subtle" aria-label="切换创作页面"><ChevronDown size={16} /></ActionIcon></Menu.Target><Menu.Dropdown>
          <Menu.Item leftSection={<ScrollText size={15} />} onClick={() => openScriptDirector('all')}>剧本创作</Menu.Item>
          <Menu.Item leftSection={<ImageIcon size={15} />} onClick={openProfileSidebar}>视觉设定</Menu.Item>
          {onOpenSpeech && <Menu.Item leftSection={<Mic2 size={15} />} onClick={onOpenSpeech}>配音</Menu.Item>}
          <Menu.Item leftSection={<Film size={15} />} onClick={() => onNavigate('studio')}>成片工作台</Menu.Item>
        </Menu.Dropdown></Menu>
        {canvasMenu}
      </div>
      <Tabs value={viewMode} activateTabWithKeyboard={false} className="pc-mode-switch-root"><Tabs.List className="pc-mode-switch" aria-label="创作视图">
        <Tabs.Tab type="button"   className={viewMode === 'canvas' ? 'is-active' : ''}
          onClick={() => { setContextMenu(null); setAddMenu(null); setViewMode('canvas') }} value={'canvas'}><MousePointer2 size={15} />工作流</Tabs.Tab>
        <Tabs.Tab type="button"   className={viewMode === 'storyboard' ? 'is-active' : ''}
          disabled={visualPanelBusy} onClick={() => { void (async () => { if (!await leaveVisualPanel()) return; setProfileInspectorId(null); setVisualTool(null); setProfileDraftDirty(false); setContextMenu(null); setAddMenu(null); setViewMode('storyboard') })() }} value={'storyboard'}><LayoutGrid size={15} />故事板</Tabs.Tab>
      </Tabs.List></Tabs>
      <div className="pc-save-status" role="status">
        {saveState === 'saved' ? <><Check size={14} />已保存</>
          : saveState === 'saving' || saveState === 'pending' ? <><LoaderCircle size={14} className="pc-spin" />{saveState === 'saving' ? '保存中' : '待保存'}</>
            : <Button onClick={() => saveState === 'conflict' ? void inspectConflict() : queueRef.current && void flush(queueRef.current).catch(showError)} data-workspace-control="" variant="subtle"><CircleAlert size={14} />{saveState === 'conflict' ? '版本冲突 · 合并' : '保存失败 · 重试'}</Button>}
      </div>
      {viewMode === 'storyboard' && graph && <div className="pc-storyboard-tools">
        <TextInput className="pc-storyboard-search" aria-label="搜索故事板内容" placeholder="搜索文本、镜头或素材"
          leftSection={<Search size={16} />} leftSectionPointerEvents="none"
          rightSection={storyboardQuery ? <ActionIcon variant="subtle" size="sm" aria-label="清除故事板搜索" onClick={() => setStoryboardQuery('')}><X size={14} /></ActionIcon> : undefined}
          value={storyboardQuery} onChange={event => setStoryboardQuery(event.currentTarget.value)} />
        <Button className="pc-storyboard-director-button" type="button" onClick={() => openScriptDirector('all')} data-workspace-control="" variant="default" leftSection={<ScrollText size={15} />}>导演对话</Button>
      </div>}
      <div className="pc-theme-control"><ThemeToggle /></div>
    </div>
    <div className={`pc-body ${viewMode === 'storyboard' ? 'pc-body-storyboard' : sidebarOpen ? 'pc-body-sidebar-open' : ''}`}>
      {viewMode === 'canvas' && sidebarOpen && <aside className="pc-canvas-sidebar" aria-label="画布节点与素材" data-canvas-overlay>
        <Tabs value={sidebarTab} variant="pills" activateTabWithKeyboard={false} className="pc-sidebar-tabs-root"><Tabs.List className="pc-sidebar-tabs" aria-label="画布侧栏">
          <Tooltip label="当前画布的节点总数，包含项目剧本" openDelay={300}><Tabs.Tab type="button" className={sidebarTab === 'canvas' ? 'active' : ''}
            onClick={() => setSidebarTab('canvas')} value="canvas" leftSection={<Layers3 size={15} />}
            rightSection={<Badge className="pc-sidebar-tab-count" color="gray" size="xs">{graph?.nodes.length || 0}</Badge>}>画布</Tabs.Tab></Tooltip>
          <Tooltip label={referenceTargetNodeId ? '项目内可引用的素材，包含未保存候选' : '项目共享的已保存素材，不含成片导出'} openDelay={300}><Tabs.Tab type="button" className={sidebarTab === 'assets' ? 'active' : ''}
            onClick={() => setSidebarTab('assets')} value="assets" leftSection={<ImageIcon size={15} />}
            rightSection={<Badge className="pc-sidebar-tab-count" color="gray" size="xs">{availableSidebarAssets.length}</Badge>}>资产</Tabs.Tab></Tooltip>
          <Tooltip label={profileScope === 'all' ? '整个项目全部方案的设定总数，包含历史方案' : '当前方案的设定总数，不同状态分别计数'} openDelay={300}><Tabs.Tab type="button" className={sidebarTab === 'profiles' ? 'active' : ''}
            onClick={() => setSidebarTab('profiles')} value="profiles" leftSection={<LayoutDashboard size={15} />}
            rightSection={<Badge className="pc-sidebar-tab-count" color="gray" size="xs">{scopedSidebarProfiles.length}</Badge>}>设定</Tabs.Tab></Tooltip>
        </Tabs.List></Tabs>
        {sidebarTab === 'canvas' ? <>
          <div className="pc-sidebar-tools">
            <TextInput size="xs" aria-label="搜索画布节点" placeholder="搜索节点、镜头或内容" value={sidebarSearch}
              leftSection={<Search size={14} />} onChange={(event) => setSidebarSearch(event.currentTarget.value)} />
            <div className="pc-sidebar-filter-line"><SlidersHorizontal size={13} /><CanvasSelect aria-label="节点类型筛选" value={sidebarFilter}
              data={[{ value: 'all', label: '所有节点' }, { value: 'generation', label: '生成节点' }, { value: 'image_analysis', label: '图片反推提示词' }, { value: 'video_analysis', label: '视频反推提示词' }, { value: 'text', label: '文本节点' }, { value: 'project_script_ref', label: '项目剧本' }, { value: 'image', label: '图片节点' }, { value: 'video', label: '视频节点' }]}
              onChange={(value) => value && setSidebarFilter(value as typeof sidebarFilter)} /><span>{sidebarNodes.length}</span></div>
          </div>
          <div className="pc-sidebar-list">
            {sidebarNodes.map((node) => {
              const nodeAsset = assetMap.get(node.asset_id || '')
              const nodeShot = shotMap.get(node.shot_id || '')
              const icon = node.type === 'image_analysis' || node.type === 'video_analysis' ? <ScanEye size={15} /> : node.type === 'project_script_ref' ? <ScrollText size={15} /> : node.type === 'generation' ? <WandSparkles size={15} /> : node.type === 'image' ? <ImageIcon size={15} />
                : node.type === 'video' ? <Film size={15} /> : <FileText size={15} />
              return <div className={`pc-sidebar-node ${selectedNodeId === node.id ? 'is-selected' : ''}`} key={node.id}
                >
                <UnstyledButton className="pc-sidebar-node-main" onClick={() => focusSidebarNode(node.id)} onDoubleClick={() => focusSidebarNode(node.id)}><span className="pc-sidebar-node-icon">{icon}</span><span className="pc-sidebar-node-copy"><strong title={node.title || nodeAsset?.filename || '未命名节点'}>{node.title || nodeAsset?.filename || '未命名节点'}</strong>
                  <small>{node.type === 'project_script_ref' ? '项目级剧本' : node.type === 'generation' ? (nodeShot ? `镜头 ${String(nodeShot.position + 1).padStart(2, '0')} · ${nodeShot.title}` : '待配置生成') : node.type === 'video_analysis' ? '视频理解 / 逐镜提示词' : node.type === 'image_analysis' ? '图片理解 / 提示词' : node.type === 'text' ? '文本 / 提示词' : nodeAsset?.filename || '素材节点'}</small></span></UnstyledButton>
                <Menu shadow="md" width={150} position="right-start" classNames={{ dropdown: 'pc-sidebar-dropdown' }}><Menu.Target><ActionIcon variant="subtle" className="pc-sidebar-more" aria-label={`更多操作：${node.title || '节点'}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={16} /></ActionIcon></Menu.Target><Menu.Dropdown>
                  <Menu.Item leftSection={<LocateFixed size={14} />} onClick={() => focusSidebarNode(node.id)}>定位节点</Menu.Item>
                  <Menu.Item leftSection={<Settings2 size={14} />} onClick={() => selectNodeForView(node.id)}>选择节点</Menu.Item>
                  {node.type !== 'project_script_ref' && <>
                    <Menu.Item leftSection={<Plus size={14} />} onClick={() => duplicateSelection(node.id)}>复制节点</Menu.Item>
                    <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => deleteSelection(node.id, null)}>删除节点</Menu.Item>
                  </>}
                </Menu.Dropdown></Menu>
              </div>
            })}
            {!sidebarNodes.length && <div className="pc-sidebar-empty"><span className="pc-sidebar-empty-icon"><Layers3 size={22} /></span><strong>{sidebarSearch || sidebarFilter !== 'all' ? '没有匹配的节点' : '画布还没有节点'}</strong><p>{sidebarSearch || sidebarFilter !== 'all' ? '试试其他关键词或切换类型。' : '从剧本创作开始，或用底部工具添加节点。'}</p>{!graph?.nodes.length && <Button type="button" onClick={() => openScriptDirector('all')} data-workspace-control="" variant="subtle">剧本创作</Button>}</div>}
          </div>
        </> : sidebarTab === 'profiles' ? <>
          <div className="pc-sidebar-tools">
            <TextInput size="xs" aria-label="搜索视觉设定" placeholder="搜索名称或版本" value={profileSearch} leftSection={<Search size={14} />} onChange={event => setProfileSearch(event.currentTarget.value)} />
            <CanvasSelect aria-label="设定方案范围" value={profileScope} data={[{ value: 'canvas', label: '当前方案设定' }, { value: 'all', label: '全部方案（含历史）' }]}
              onChange={value => { if (value === 'canvas' || value === 'all') setProfileScope(value) }} />
            <div className="pc-sidebar-filter-row">
              <div className="pc-sidebar-filter-pills" role="group" aria-label="设定类型筛选">{(['all', 'character', 'location', 'prop'] as const).map(kind => <UnstyledButton type="button" key={kind} aria-pressed={profileFilter === kind} className={profileFilter === kind ? 'active' : ''} onClick={() => setProfileFilter(kind)}>{kind === 'all' ? '全部' : kind === 'character' ? '人物' : kind === 'location' ? '场景' : '道具'}</UnstyledButton>)}</div>
              <div className="pc-sidebar-profile-tools">
                <Tooltip label="新增设定"><ActionIcon variant="subtle" aria-label="新增视觉设定" disabled={visualPanelBusy} onClick={() => void openVisualTool('create')}><Plus size={15} /></ActionIcon></Tooltip>
                <Menu position="bottom-end" width={180} classNames={{ dropdown: 'pc-sidebar-dropdown' }}><Menu.Target><ActionIcon variant="subtle" aria-label="设定工具" title="批量整理与引用管理" disabled={visualPanelBusy}><MoreHorizontal size={16} /></ActionIcon></Menu.Target><Menu.Dropdown>
                  <Menu.Item leftSection={<WandSparkles size={14} />} onClick={() => void openVisualTool('organize')}>批量整理草稿</Menu.Item>
                  <Menu.Item leftSection={<Layers3 size={14} />} onClick={() => void openVisualTool('bindings', { target: selectedShot ? `shot:${selectedShot.id}` : undefined })}>场次 / 镜头引用</Menu.Item>
                </Menu.Dropdown></Menu>
              </div>
            </div>
            {referenceTargetNodeId && <span className="pc-profile-reference-target">为 {selectedNode?.title} 选择参考图</span>}
          </div>
          <div className="pc-sidebar-list">
            {sidebarProfiles.map(profile => {
              const board = assetMap.get(profile.board_asset_id || '')
              const inCanvas = graph?.nodes.some(node => node.settings.visual_profile_id === profile.id)
              return <div className={`pc-sidebar-node pc-sidebar-profile ${(profileInspectorId || selectedProfile?.id) === profile.id ? 'is-selected' : ''}`} key={profile.id}>
                <UnstyledButton type="button" className="pc-profile-list-open" aria-label={`查看设定：${profile.name} · ${profile.variant}`} onClick={() => openProfileInspector(profile)}>
                  <span className="pc-profile-list-thumb">{board ? <img src={board.url} alt={`${profile.name} 设定图`} /> : <ImageIcon size={18} />}</span>
                  <span className="pc-sidebar-node-copy"><strong>{profile.name}</strong><small>{profile.variant} · v{profile.revision}</small><small className="pc-profile-list-status">{profile.definition_status === 'draft' ? '设定草稿' : profile.board_style_status === 'needs_review' ? '画风待核对' : profile.board_asset_id ? '信息图已确认' : '待制作信息图'}{inCanvas ? ' · 已在画布' : ''}</small></span>
                </UnstyledButton>
                <Tooltip label={(profile.design_id || null) !== (canvas.design_id || null) ? '其他方案设定，可查看历史' : referenceTargetNodeId ? '添加为参考' : inCanvas ? '定位节点' : '加入画布'}><ActionIcon variant="subtle" aria-label={`${referenceTargetNodeId ? '添加设定参考' : inCanvas ? '定位设定节点' : '加入设定画布'}：${profile.name} · ${profile.variant}`} disabled={visualPanelBusy || (profile.design_id || null) !== (canvas.design_id || null)} onClick={() => void (async () => { if (await leaveVisualPanel()) { setVisualTool(null); addProfileToCanvas(profile) } })()}>{inCanvas && !referenceTargetNodeId ? <LocateFixed size={15} /> : <Plus size={15} />}</ActionIcon></Tooltip>
                <Tooltip label="管理候选"><ActionIcon variant="subtle" aria-label={`管理候选：${profile.name} · ${profile.variant}`} onClick={() => setCandidateProfileId(profile.id)}><Layers3 size={15} /></ActionIcon></Tooltip>
              </div>
            })}
            {!sidebarProfiles.length && <div className="pc-sidebar-empty"><span className="pc-sidebar-empty-icon"><ImageIcon size={24} /></span><strong>{scopedSidebarProfiles.length ? '没有匹配的设定' : profileScope === 'canvas' ? '当前方案暂无视觉设定' : '暂无视觉设定'}</strong><p>{scopedSidebarProfiles.length ? '试试其他关键词或切换类型。' : '剧本中点击「加入画布」，会自动整理人物、场景和道具设定。'}</p></div>}
          </div>
        </> : <>
          <div className="pc-sidebar-tools">
            <Text size="xs" className="pc-sidebar-scope-label">项目共享 · {referenceTargetNodeId ? '可引用素材（含未保存候选）' : '已保存素材'}</Text>
            <TextInput size="xs" aria-label="搜索资产" placeholder="搜索素材、镜头或文件名" value={sidebarAssetSearch}
              leftSection={<Search size={14} />} onChange={(event) => setSidebarAssetSearch(event.currentTarget.value)} />
            <div className="pc-sidebar-filter-pills" role="group" aria-label="资产类型筛选">
              {(['all', 'image', 'video', 'audio', 'text'] as const).map((kind) => <UnstyledButton type="button" key={kind} aria-pressed={sidebarAssetFilter === kind} className={sidebarAssetFilter === kind ? 'active' : ''}
                onClick={() => setSidebarAssetFilter(kind)}>{kind === 'all' ? '全部' : kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文本'}</UnstyledButton>)}
            </div>
          </div>
          <div className="pc-sidebar-list pc-sidebar-assets">
            {sidebarAssets.map((asset) => <div className="pc-sidebar-asset" key={asset.id} draggable onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-canvas-asset', asset.id)
            }}>
              <div className="pc-sidebar-asset-thumb">{asset.kind === 'audio' ? <Music2 size={18} /> : <NodeMedia asset={asset} />}</div>
              <div className="pc-sidebar-asset-copy"><strong title={assetLabels.get(asset.id)?.title || asset.filename}>{assetLabels.get(asset.id)?.title || asset.filename}</strong><small>{asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '文本'} · {asset.source === 'generated' ? '生成' : '导入'}</small></div>
              {asset.kind === 'audio' ? <Tooltip label="音频素材可在时间线中使用"><span className="pc-sidebar-audio-mark"><Music2 size={14} /></span></Tooltip> : <Tooltip label={referenceTargetNodeId ? '添加为当前节点的参考' : '添加到画布'}><ActionIcon variant="subtle" aria-label={`将 ${assetLabels.get(asset.id)?.title || asset.filename} ${referenceTargetNodeId ? '添加为参考' : '添加到画布'}`} onClick={() => addAssetNode(asset)}><Plus size={16} /></ActionIcon></Tooltip>}
            </div>)}
            {!sidebarAssets.length && <div className="pc-sidebar-empty"><span className="pc-sidebar-empty-icon"><ImageIcon size={24} /></span><strong>还没有匹配的素材</strong><p>{referenceTargetNodeId ? '试试其他关键词，或上传参考素材。' : '上传素材，或将生成结果保存到资产库后，可在各画布共享使用。'}</p><Button type="button" onClick={openCanvasUpload} data-workspace-control="" variant="subtle">上传素材</Button></div>}
          </div>
        </>}
      </aside>}
      {viewMode === 'canvas' && <div className="pc-flow" ref={viewportRef} tabIndex={-1} aria-label="工作流画布"
        onPointerDownCapture={onCanvasPointerDownCapture}
        onPointerMoveCapture={onCanvasPointerMoveCapture}
        onPointerUpCapture={onCanvasPointerUpCapture}
        onPointerCancelCapture={onCanvasPointerUpCapture}
        onPointerLeave={onCanvasPointerLeaveCapture}>
        {graph ? <CanvasEdgeMotionProvider><ReactFlow<FlowNode, Edge>
          nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onlyRenderVisibleElements={virtualizeCanvas}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} isValidConnection={isValidConnection}
          // Selection on pointer down also occurs for dragging. Only an
          // explicit click opens the composer; moving a card keeps it closed.
          onNodeClick={(event, node) => {
            setAddMenu(null); setContextMenu(null)
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            setComposerNodeId(node.id); setSelectedNodeId(node.id); setSelectedNodeIds([node.id]); setSelectedEdgeId(null)
          }}
          onNodeDoubleClick={(event, node) => {
            if (event.target instanceof Element && event.target.closest('button, input, textarea, [contenteditable="true"], .react-flow__handle, .studio-media-controls')) return
            const asset = node.data.asset
            if (!['image', 'video', 'generation'].includes(node.data.node.type) || !asset || !['image', 'video'].includes(asset.kind)) return
            event.preventDefault(); event.stopPropagation()
            setAddMenu(null); setContextMenu(null)
            setNodeMediaPreview({ asset, title: node.data.node.title || asset.filename, shotId: node.data.node.shot_id })
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
          onSelectionContextMenu={(event, nodes) => {
            if (nodes[0]) openContextMenu(event, { nodeId: nodes[0].id })
          }}
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
            })
          }}
          onMove={(_, viewport) => setViewportZoom(Math.round(viewport.zoom * 100))}
          onMoveEnd={(_, viewport) => {
            const next = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
            setViewportZoom(Math.round(next.zoom * 100))
            keepCanvasViewport(storageId, next)
            onCanvasViewport(next)
          }}
          panOnScroll panOnScrollMode={PanOnScrollMode.Free} panOnScrollSpeed={1}
          zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false} panOnDrag={[0, 1]}
          selectionOnDrag selectionKeyCode="Shift" multiSelectionKeyCode={["Meta", "Control", "Shift"]} panActivationKeyCode="Space" autoPanOnNodeDrag preventScrolling nodesDraggable nodesConnectable
          snapToGrid snapGrid={[12, 12]} deleteKeyCode={null}
          // A larger connection radius makes the small reference-inspired-style plus
          // buttons easy to catch on a trackpad without making the cards feel
          // cluttered. The preview line uses the same static treatment as
          // persisted edges while the pointer is choosing an endpoint.
          connectionRadius={42}
          // Start the preview as soon as a handle (including its magnetic
          // hit area) is pressed. React Flow otherwise waits for the first
          // mousemove before rendering the temporary connection.
          connectionDragThreshold={0}
          connectionLineComponent={StudioConnectionLine}
          defaultEdgeOptions={{ type: 'studio', animated: false }}
        >
          <Background color="var(--fc-grid)" gap={20} size={1} />
          {showMinimap && <div className="pc-minimap-dock" style={minimapPosition ? { left: `${minimapPosition.x}px`, top: `${minimapPosition.y}px`, right: 'auto', bottom: 'auto' } : undefined}>
            <UnstyledButton className="pc-minimap-drag-handle" aria-label="拖动小地图" title="拖动小地图" />
            <MiniMap pannable zoomable nodeColor={node => node.selected ? '#929292' : '#535353'} />
          </div>}
          <Tooltip label={sidebarOpen ? '收起节点列表' : '打开节点列表'}>
            <ActionIcon variant="subtle" className="pc-node-list-toggle" aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? '收起左侧节点列表' : '打开左侧节点列表'} onClick={() => setSidebarOpen(open => !open)}>
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </ActionIcon>
          </Tooltip>
          <div className="pc-flow-utility" aria-label="画布工具" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <CanvasNodeTypeFilter value={nodeTypeFilter} counts={nodeTypeCounts} onChange={changeNodeTypeFilter} />
            <Tooltip label={showMinimap ? '隐藏小地图' : '显示小地图'}><ActionIcon variant="subtle" aria-label={showMinimap ? '隐藏小地图' : '显示小地图'} aria-pressed={showMinimap} onClick={() => setShowMinimap(value => !value)}><MapIcon size={16} /></ActionIcon></Tooltip>
            <Tooltip label={showEdges ? '隐藏连线' : '显示连线'}><ActionIcon variant="subtle" className={showEdges ? '' : 'is-active'}
              aria-label={showEdges ? '隐藏连线' : '显示连线'} aria-pressed={!showEdges} onClick={() => setShowEdges((value) => !value)}>{showEdges ? <Eye size={16} /> : <EyeOff size={16} />}</ActionIcon></Tooltip>
            <Tooltip label="整理画布"><ActionIcon variant="subtle" aria-label="整理画布" onClick={organizeCanvas}><LayoutDashboard size={16} /></ActionIcon></Tooltip>
            <Tooltip label="重置到 100%"><Button type="button" className="pc-flow-zoom-label" aria-label="重置缩放到 100%" onClick={() => void zoomTo(1, { duration: 220 })} data-workspace-control="" variant="subtle">{viewportZoom}%</Button></Tooltip>
            <Tooltip label="清除视口记忆"><ActionIcon variant="subtle" aria-label="清除视口记忆并重置" onClick={() => {
              try { window.localStorage.removeItem(viewportKey(storageId)) } catch { /* Storage may be disabled. */ }
              setSavedViewport(null)
              setViewportZoom(100)
              void setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 240 })
            }}><RefreshCcw size={15} /></ActionIcon></Tooltip>
            <Menu position="top-end" width={250} classNames={{ dropdown: 'pc-sidebar-dropdown' }}>
              <Menu.Target><ActionIcon variant="subtle" aria-label="画布操作菜单" data-canvas-overlay><MoreHorizontal size={16} /></ActionIcon></Menu.Target>
              <Menu.Dropdown data-canvas-overlay>
                <Menu.Label>Shift 框选 · ⌘ / Ctrl 点击多选</Menu.Label>
                <Menu.Item leftSection={<Check size={14} />} disabled={!hasSelectableCanvasNodes} onClick={selectAllCanvasNodes}>{nodeTypeFilter === 'all' ? '全选节点' : '全选可见节点'}（⌘ / Ctrl + A）</Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<Trash2 size={14} />} disabled={!hasRemovableCanvasContent} onClick={() => void clearCanvas()}>清空画布</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
          {!visualTool && !inspectedProfile && selectedNode && composerNodeId === selectedNode.id && selectedNode.type !== 'text' && selectedNode.type !== 'image_analysis' && selectedNode.type !== 'video_analysis' && selectedNode.type !== 'project_script_ref' && selectedNodeIds.length === 1 && selectedNodeIds[0] === selectedNodeId && <CanvasComposerToolbar key={selectedNode.id} nodeId={selectedNode.id} expanded={composerExpanded} bottomInset={selectedProfile ? 26 : 0} onCollapse={() => {
            if (composerBindingsOpen) closeComposerBindings()
            else setComposerExpanded(false)
          }}>
            <div className={`pc-prompt-composer nowheel ${selectedProfile ? 'pc-profile-composer' : ''} ${composerExpanded ? 'is-expanded' : ''}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <div className="pc-prompt-composer-head">
                <div className="pc-prompt-composer-chips">
                  {referenceReturnNode && referenceReturnNode.id !== selectedNode.id && <UnstyledButton type="button" className="pc-composer-chip pc-reference-return" aria-label={`返回生成节点：${referenceReturnNode.title}`} onClick={() => {
                    focusSidebarNode(referenceReturnNode.id); setReferenceReturnNodeId(null)
                  }}><ArrowLeft size={14} /><span>返回 {referenceReturnNode.title || '原节点'}</span></UnstyledButton>}
                  <Menu withinPortal position="bottom-start">
                    <Menu.Target><Button type="button" className="pc-composer-chip" disabled={busy || !!selectedProfile && selectedNodeGenerating}
                      data-workspace-control="" variant="subtle" leftSection={<Plus size={15} />} rightSection={<ChevronDown size={12} />}>添加参考</Button></Menu.Target>
                    <Menu.Dropdown data-canvas-overlay>
                      <Menu.Item leftSection={<ImageIcon size={14} />} onClick={() => showSidebarAssets(selectedProfile ? 'image' : 'all', selectedNode.id)}>从素材库选择</Menu.Item>
                      <Menu.Item leftSection={<Layers3 size={14} />} onClick={() => {
                        setComposerExpanded(false); setSidebarOpen(true); setSidebarTab('profiles'); setReferenceTargetNodeId(selectedNode.id)
                      }}>从设定库选择</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  {selectedJob && canOptimizeImagePrompt(selectedJob, composerModality) && <Button type="button" className="pc-composer-chip" variant="light"
                    leftSection={<Sparkles size={14} />} disabled={busy || selectedNodeGenerating} onClick={() => setOptimizationNodeId(selectedNode.id)}>优化提示词</Button>}
                  {(composerModality === 'image' || composerModality === 'video') && <PromptSkillAction key={selectedNode.id} projectId={detail.id} nodeId={selectedNode.id}
                    modality={composerModality} prompt={composerPrompt} promptDocument promptSections={composerSections} promptReferences={promptEditorReferences} promptTemplate={legacyTemplate}
                    models={models.filter(model => model.modality === 'text' && model.enabled && providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))}
                    disabled={busy || selectedNodeGenerating || !!promptReferenceIssue || !!promptParameterConflicts.length || promptSourcePending || !!selectedProfile?.base_profile_id && !baseProfileReady} targetModelId={composerModelId} shotId={selectedNode.shot_id} profileId={selectedProfile?.id}
                    ratio={composerRatio} duration={composerDuration} mode={composerModality === 'image' ? promptImageMode : selectedMode} referenceAssetIds={preparedReferenceIds}
                    explicitReferenceAssetIds={explicitReferenceIds}
                    promptReferenceOverrides={promptOverrides}
                    resolution={composerModality === 'image' ? promptResolution : composerResolution} clarity={composerClarity} quality={composerQuality} background={composerBackground}
                    storyboardReferenceAssetId={selectedMode === 'reference' ? storyboardReferenceAssetId : null}
                    visualReferenceMode={visualReferenceMode} excludedVisualProfileIds={selectedNode.settings.excluded_visual_profile_ids}
                    videoReferenceUsages={activeVideoReferenceUsages}
                    onApply={(value, _body, document) => {
                      const draft = tokenizePromptReferenceNumbers(value, preparedReferenceIds)
                      saveComposerDocument(draft, document ? rewriteCanvasPromptSections(document,
                        text => tokenizePromptReferenceNumbers(text, preparedReferenceIds)) : undefined)
                      setNotice('已应用整理后的提示词')
                    }} />}
                  {!selectedProfile && selectedBoardAsset?.kind === 'image' && <>
                    <UnstyledButton type="button" className="pc-composer-chip" aria-label="以此图作为首帧生成" disabled={busy || selectedNodeGenerating}
                      onClick={() => void tryNodeAction(selectedNode.id, 'video-first-frame')}><Film size={15} /><span>首帧生成</span></UnstyledButton>
                    {availableModels.some(model => model.modality === 'video' && supportsVideoMultiReference(model.settings)) && <UnstyledButton type="button" className="pc-composer-chip" aria-label="作为参考设计视频" disabled={busy || selectedNodeGenerating}
                      onClick={() => void tryNodeAction(selectedNode.id, 'video-reference')}><ImageIcon size={15} /><span>多图参考</span></UnstyledButton>}
                  </>}
                  {selectedProfile && <Tooltip label="编辑设定"><ActionIcon type="button" className="pc-composer-chip" aria-label="编辑设定" onClick={() => { setComposerExpanded(false); openProfileInspector(selectedProfile) }} data-workspace-control=""><PenLine size={15} /></ActionIcon></Tooltip>}
                  {selectedProfile && <Tooltip label="上传设定图"><ActionIcon type="button" className="pc-composer-chip" aria-label="上传设定图" disabled={busy || selectedNodeGenerating} onClick={() => profileUploadInputRef.current?.click()} data-workspace-control=""><Upload size={15} /></ActionIcon></Tooltip>}
                </div>
                <ActionIcon size={30} type="button" className="pc-composer-expand" aria-label={composerExpanded ? '缩小创作区' : '放大创作区'} title={composerExpanded ? '缩小创作区' : '放大创作区'} aria-expanded={composerExpanded} onClick={() => setComposerExpanded((value) => !value)} data-workspace-control="" variant="subtle">{composerExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</ActionIcon>
              </div>
              <div className="pc-prompt-composer-body">
              {selectedShot && <div className="pc-visual-context">
                <Tooltip label="当前用途启用的设定，包含待确认和待更新项；实际传入的参考图片可查看生成信息。" multiline w={280}>
                  <Button ref={composerBindingsTriggerRef} type="button" className="pc-composer-chip pc-visual-context-button" aria-expanded={composerBindingsOpen} aria-controls="pc-composer-bindings"
                    disabled={visualPanelBusy} onClick={() => setComposerBindingsOpen(value => !value)} data-workspace-control="" variant="subtle"><ImageIcon size={14} />镜头引用 · {visualBindings.length}{staleVisualBindingCount > 0 && <span className="pc-binding-stale"> · {staleVisualBindingCount} 项需关注</span>}<ChevronDown size={13} className="pc-binding-toggle-chevron" /></Button>
                </Tooltip>
                {allVisualBindings.length !== visualBindings.length && <span className="pc-visual-context-status">本镜头关联 {allVisualBindings.length} 份设定</span>}
                {visualBindings.length > 0 && <><span className="pc-visual-context-status">{visualReferenceMode !== 'profiles' ? '文字设定已带入'
                  : visualBindings.filter(binding => binding.required && !visualBindingReferenceAssetIds(binding).length).length ? '必需参考图待确认' : '已绑定'}</span>
                  {composerModality !== 'video' && <CanvasSelect className="pc-visual-reference-select" size="xs" aria-label="视觉设定引用方式" value={visualReferenceMode}
                    disabled={busy}
                    onChange={value => { if (value) updateNodeSettingsById(selectedNode.id, { visual_reference_mode: value as VisualReferenceMode }) }}
                    data={[
                      { value: 'profiles', label: '设定信息图 + 文字' },
                      { value: 'text_only', label: '仅文字设定' },
                    ]} />}
                </>}
              </div>}
              <div className="pc-composer-workspace">
              <div className="pc-composer-writing">
              {selectedProfile?.base_profile_id && <CanvasProfileInheritance profile={selectedProfile} baseProfile={directBaseProfile}
                asset={assetMap.get(directBaseProfile?.board_asset_id || '')} waitingProfile={profileInheritance?.waitingProfile}
                error={profileInheritance?.error} baseReady={baseProfileReady} baseGenerating={baseProfileGenerating}
                busy={busy || visualPanelBusy} onLocateBase={() => {
                  if (!directBaseProfile) return
                  locateMissingReference({ profileId: directBaseProfile.id, name: directBaseProfile.name, variant: directBaseProfile.variant,
                    action: 'confirm', nodeId: graph?.nodes.find(node => node.settings.visual_profile_id === directBaseProfile.id)?.id })
                }} />}
              {missingReferences.length > 0 && <div className="pc-missing-references" role="group" aria-label="待补齐参考图">
                <div className="pc-missing-references-heading"><strong>待补齐参考图 · {missingReferences.length}</strong><span>新生成默认确认第一张，可随时更换</span>
                  {referencesToConfirm.length > 0 && <Button size="compact-xs" variant="default" className="pc-confirm-required-references"
                    leftSection={<Check size={13} />} aria-label="一键确认所需参考图" disabled={busy || visualPanelBusy || selectedNodeGenerating}
                    onClick={() => void confirmRequiredReferences()}>一键确认 · {referencesToConfirm.length}</Button>}
                  {missingReferences.some(reference => reference.action === 'generate') && <Button size="compact-xs" variant="default" className="pc-generate-required-references"
                    leftSection={<Sparkles size={13} />} aria-label="一键生成所需参考图" loading={referenceBatch?.targetId === selectedNode.id && referenceBatch.submitting}
                    disabled={busy || visualPanelBusy || selectedNodeGenerating || !referencesToGenerate.length}
                    onClick={() => void generateRequiredReferences()}>一键生成所需参考图{referencesToGenerate.length > 0 && ` · ${referencesToGenerate.length}`}</Button>}
                </div>
                <div className="pc-missing-references-list">{missingReferences.map(reference => <UnstyledButton key={reference.profileId} type="button"
                  aria-label={`${reference.action === 'bindings' ? '调整引用' : '定位参考设定'}：${reference.name} · ${reference.variant}`}
                  onClick={() => locateMissingReference(reference)}>
                  <LocateFixed size={14} /><span title={`${reference.name} · ${reference.variant}`}>{reference.name}{reference.variant && ` · ${reference.variant}`}</span>
                  <small>{referenceGenerating.get(reference.profileId) === 'running' ? '生成中' : referenceGenerating.get(reference.profileId) === 'queued' ? '排队中'
                    : reference.action === 'bindings' ? '调整引用' : reference.action === 'confirm' ? '去确认' : '去生成'}</small><ArrowRight size={13} />
                </UnstyledButton>)}</div>
                {persistentReferenceBatch?.targetId === selectedNode.id && referenceBatchDecision && <div className="pc-required-reference-result" role="status" aria-live="polite">
                  <p>{referenceBatch?.submitting ? '正在提交所需参考图…' : `已提交 ${persistentReferenceBatch.items.filter(item => item.status === 'submitted').length} 份设定图，已确认 ${referenceBatchDecision.completed.length} / ${persistentReferenceBatch.items.length}，基础图确认后自动继续生成后续状态。`}</p>
                  {referenceBatchDecision.waiting.map(item => <p key={item.profileId}>{profileMap.get(item.profileId)?.name}：{item.message}</p>)}
                  {referenceBatchDecision.blocked.map(item => <p key={item.profileId} className="pc-required-reference-error">{profileMap.get(item.profileId)?.name}：{item.message}</p>)}
                  <Button size="xs" variant="subtle" disabled={!!referenceBatch?.submitting} onClick={() => {
                    clearReferenceBatch(detail.id, canvas.id); referenceBatchPlanRef.current = null; setPersistentReferenceBatch(null); setReferenceBatch(null)
                  }}>停止自动续跑</Button>
                </div>}
                {referenceBatch?.targetId === selectedNode.id && !persistentReferenceBatch && <div className="pc-required-reference-result" role="status" aria-live="polite">
                  <p>{referenceBatch.submitting ? '正在提交所需参考图…' : referenceBatch.queued > 0 ? `已提交 ${referenceBatch.queued} 份设定图，生成完成后自动确认第一张可用候选。` : '所需参考图暂未提交，请处理以下问题。'}</p>
                  {referenceBatch.failures.map(failure => <p key={failure.profileId || failure.name} className="pc-required-reference-error"><strong>{failure.name}</strong>：{failure.message}</p>)}
                </div>}
                {referenceConfirmation?.targetId === selectedNode.id && <div className="pc-required-reference-result" role="status" aria-live="polite">
                  <p>已确认 {referenceConfirmation.confirmed} 份参考图。</p>
                  {referenceConfirmation.skipped.map(item => <p key={item.profile_id} className="pc-required-reference-error"><strong>{item.name}</strong>：{item.message}</p>)}
                </div>}
              </div>}
              {composerModality !== 'text' && detail.project_visual_style && detail.project_visual_style.source !== 'unspecified' && <p className="pc-project-style" role="status">
                项目画风：{detail.project_visual_style.label} · {detail.project_visual_style.source === 'confirmed_context' ? '继承已确认设定，可在剧本对话中规范化' : '统一用于设定图、分镜和视频'}
              </p>}
              {styleWarnings.length > 0 && <WorkspaceDisclosure className="pc-project-style" label={<>参考图画风需核对 · {styleWarnings.length}</>}>{styleWarnings.map(warning => <p key={warning}>{warning}</p>)}</WorkspaceDisclosure>}
              {selectedProfile && (selectedNodeGenerating && !submittedProfileReferences
                ? <p className="pc-profile-reference-notice" role="status">任务已提交，正在同步本次使用的参考与提示词…</p>
                : <CanvasReferenceList items={profileReferenceItems} generating={selectedNodeGenerating} disabled={busy}
                  onPreview={item => { if (item.asset) setReferencePreview(item.asset) }}
                  onLocate={item => {
                    const source = !submittedProfileReferences ? profileReferences?.sources.find(source => source.assetId === item.assetId) : undefined
                    const node = graph?.nodes.find(node => node.id === source?.nodeId)
                      || graph?.nodes.find(node => node.id !== selectedNode.id && visualNodeAsset(node, detail, true)?.id === item.assetId)
                    if (node) { setReferenceReturnNodeId(selectedNode.id); focusSidebarNode(node.id) }
                    else if (source?.profileId) {
                      const profile = profileMap.get(source.profileId)
                      if (profile) locateMissingReference({ profileId: profile.id, name: profile.name, variant: profile.variant, action: 'confirm' })
                    }
                  }}
                  onRemove={item => changeComposerPromptReference(item.assetId, null)} />)}
              {composerModality === 'video' && <VideoReferencePanel entries={videoReferences} assets={detail.assets}
                disabled={busy || selectedNodeGenerating}
                excludedBindings={selectedMode === 'reference' ? visualBindings.filter(binding => !binding.required && selectedNode.settings.excluded_visual_profile_ids?.includes(binding.profile_id)) : []}
                onPreview={setReferencePreview}
                onLocate={entry => {
                  const source = graph?.nodes.find(node => node.id !== selectedNode.id && (node.asset_id === entry.asset_id ||
                    graph.edges.some(edge => edge.target === selectedNode.id && edge.source === node.id && edge.reference_asset_id === entry.asset_id)))
                  if (source) { setReferenceReturnNodeId(selectedNode.id); focusSidebarNode(source.id) }
                  else if (entry.profile_ids[0]) {
                    const profile = detail.visual_profiles?.find(profile => profile.id === entry.profile_ids[0])
                    if (profile) { setReferenceReturnNodeId(selectedNode.id); addProfileToCanvas(profile, null) }
                  } else setNotice('该图片尚未加入画布，可先查看参考图')
                }}
                onExclude={id => excludeVideoReference(id)} onRestore={id => excludeVideoReference(id, true)}
                onChangeUsage={selectedMode === 'reference' ? (assetId, usage) => updateNodeSettingsById(selectedNode.id, {
                  video_reference_usages: [...activeVideoReferenceUsages.filter(item => item.asset_id !== assetId), ...(usage ? [{ asset_id: assetId, usage }] : [])],
                }) : undefined}
                onRemoveManual={id => { changeComposerPromptReference(id, null) }} />}
              {composerReferences.some(node => composerModality !== 'video' && !selectedProfile || visualNodeAsset(node, detail, true)?.kind !== 'image') && <div className="pc-composer-references" aria-label="已连接的参考">
                {composerReferences.filter(node => composerModality !== 'video' && !selectedProfile || visualNodeAsset(node, detail, true)?.kind !== 'image').map((node, index) => <div className="pc-composer-reference" key={`${node.id}:${node.asset_id || ''}`}>
                  <UnstyledButton type="button" title={node.title || '参考节点'} aria-label={`定位参考：${node.title || index + 1}`} onClick={() => focusSidebarNode(node.id)}>
                    {visualNodeAsset(node, detail, true)?.kind === 'image' ? <img src={visualNodeAsset(node, detail, true)!.url} alt={node.title} />
                      : node.type === 'project_script_ref' ? <ScrollText size={22} />
                        : node.type === 'text' || node.type === 'image_analysis' || node.type === 'video_analysis' ? <FileText size={22} /> : <Film size={22} />}
                    <span>{(() => {
                      const assetId = visualNodeAsset(node, detail, true)?.id
                      const resolvedId = assetId && (Object.hasOwn(resolvedPromptReplacements, assetId) ? resolvedPromptReplacements[assetId] : assetId)
                      const position = resolvedId ? preparedReferenceIds.indexOf(resolvedId) : -1
                      return position >= 0 ? position + 1 : '—'
                    })()}</span>
                  </UnstyledButton>
                  <ActionIcon type="button" className="pc-composer-reference-remove" aria-label={`移除参考：${node.title || index + 1}`}
                    onClick={() => changeGraph(current => {
                      const fixed = current.edges.some(edge => edge.source === node.id && edge.target === selectedNode.id && edge.reference_asset_id === node.asset_id)
                      return { ...current, edges: current.edges.filter(edge => !(edge.source === node.id && edge.target === selectedNode.id
                        && (fixed ? edge.reference_asset_id === node.asset_id : !edge.reference_asset_id))) }
                    })} data-workspace-control=""><X size={12} /></ActionIcon>
                </div>)}
              </div>}
              {composerModality === 'video' && ['reference', 'edit', 'extend'].includes(selectedMode) && <TextInput disabled={busy} label="参考视频" aria-label="参考视频地址"
                leftSection={<Film size={14} />} leftSectionPointerEvents="none"
                placeholder={composerModel?.settings.video_reference_profile === 'seedance_2_5' ? '公网视频 URL 或 asset:// 素材 ID' : '粘贴视频链接，或连接已生成视频'}
                description={composerModel?.settings.video_reference_profile === 'seedance_2_5' ? '使用可公开访问的视频链接，或火山素材库的 asset:// 地址。' : undefined}
                value={selectedNode.settings.reference_video_url || inputVideo?.remote_url || ''}
                onChange={event => updateNodeSettingsById(selectedNode.id, { reference_video_url: event.currentTarget.value })}
                styles={{ input: { borderColor: 'var(--pc-reference-video-border)', backgroundColor: 'var(--fc-surface-muted)' } }} className="pc-reference-video-input" />}
              {selectedProfile && <div className="pc-profile-board-review">
                <div><strong>{selectedProfile.name} · v{selectedProfile.revision}</strong><span role="status" aria-label="当前设定状态" aria-live="polite">{selectedProfileBoardStatus}</span>
                  {selectedBoardAsset && <a href={selectedBoardAsset.url} target="_blank" rel="noreferrer" title="查看信息图"><Maximize2 size={14} /></a>}
                  <Button className="pc-candidate-manager-entry" variant="default" size="xs" leftSection={<Layers3 size={13} />} onClick={() => setCandidateProfileId(selectedProfile.id)}>管理候选 · {visualCandidateAssets(selectedProfile, detail, selectedNode.asset_id).filter(asset => !selectedProfile.archived_candidate_asset_ids?.includes(asset.id)).length}</Button>
                  <Button variant="default" size="xs" onClick={() => openProfileInspector(selectedProfile)}>独立参考图 · {selectedProfile.reference_assets?.filter(reference => reference.status === 'confirmed' && reference.revision === selectedProfile.revision).length || 0}</Button>
                  {selectedBoardAsset && selectedBoardAsset.id !== selectedProfile.board_asset_id && <Button variant="default" size="xs" leftSection={<Check size={13} />} disabled={busy || selectedNodeGenerating} onClick={() => void confirmProfileBoard(selectedBoardAsset.id)}>确认使用</Button>}
                </div>
                {!!profileCandidates.length && <div className="pc-profile-candidates" aria-label="设定图候选">{profileCandidates.map((asset, index) => <Button key={asset.id} type="button" className={selectedBoardAsset?.id === asset.id ? 'active' : ''} aria-label={`查看设定图候选 ${profileCandidates.length - index}`} onClick={() => updateNodeById(selectedNode.id, { asset_id: asset.id })} data-workspace-control="" variant="subtle"><img src={asset.url} alt={`候选 ${profileCandidates.length - index}`} />{asset.id === selectedProfile.board_asset_id && <Check size={12} />}</Button>)}
                  {selectedProfile.board_asset_id && !profileCandidates.some(asset => asset.id === selectedProfile.board_asset_id) && assetMap.get(selectedProfile.board_asset_id) && <Button type="button" aria-label="查看已确认设定图" onClick={() => updateNodeById(selectedNode.id, { asset_id: selectedProfile.board_asset_id })} data-workspace-control="" variant="subtle"><img src={assetMap.get(selectedProfile.board_asset_id)!.url} alt="已确认设定图" /><Check size={12} /></Button>}
                </div>}
                {selectedJob?.error && <p role="alert">{selectedJob.error}</p>}
                {profileReferenceState?.status === 'changed' && <p className="pc-profile-reference-notice" role="status">{profileReferenceState.message}</p>}
                {selectedProfile?.board_style_status === 'needs_review' && <p role="status">项目画风已更新，原信息图需核对。<Button type="button" onClick={() => setCandidateProfileId(selectedProfile.id)} data-workspace-control="" variant="subtle">查看并重新确认</Button></p>}
              </div>}
              {!selectedProfile && selectedShot && selectedNode.type === 'generation' && (composerModality === 'image' || composerModality === 'video') && <ShotCandidateStrip
                key={`${selectedNode.id}:${shotCandidateModality}`} modality={shotCandidateModality} candidates={shotCandidates} archivedAssetIds={selectedShot.archived_candidate_asset_ids || []}
                displayedAssetId={selectedNode.asset_id} selectedAssetId={selectedShot.selected_asset_id} busy={busy} generating={selectedNodeGenerating}
                onUse={assetId => useShotCandidate(selectedNode.id, assetId)} onManage={() => setShotCandidateNodeId(selectedNode.id)} />}
              {!selectedProfile && <div className="pc-prompt-kind-label">{selectedTemplateKind ? `${visualSettingTemplates[selectedTemplateKind].label}提示词` : composerModality === 'video' ? '视频提示词' : '图片提示词'}</div>}
              {selectedTemplateKind && <p className="pc-prompt-system-note" role="status">{preparedReferenceIds.length
                ? `已接入 ${preparedReferenceIds.length} 张参考图片，按${visualSettingTemplates[selectedTemplateKind].label}模板生成，第一张为主参考。`
                : '连接图片节点，或从「添加参考」选择图片，即可组合设定图提示词。'}</p>}
              {!(selectedProfile && selectedNodeGenerating && !submittedProfileReferences) && <CanvasPromptEditor key={selectedNode.id} aria-label={selectedProfile ? '信息图提示词' : '创作提示词'}
                  expanded={composerExpanded} disabled={busy || !!selectedProfile && selectedNodeGenerating} minRows={6}
                  placeholder={selectedProfile || selectedTemplateKind ? '描述信息图内容与视图要求，输入 @ 引用图片' : '描述画面、动作与构图，输入 @ 引用图片'}
                  references={selectedProfile && submittedProfileReferences ? submittedPromptReferences : promptEditorReferences}
                  choices={selectedProfile && submittedProfileReferences ? submittedPromptReferences : promptReferenceChoices}
                  additionalChoices={selectedProfile && selectedNodeGenerating ? [] : promptAdditionalChoices}
                  value={selectedProfile && submittedProfileReferences ? displayedProfilePrompt : composerPrompt}
                  sectionDocument={selectedProfile && submittedProfileReferences ? undefined : composerSections}
                  onReferenceAdd={addComposerPromptReference} onReferenceChange={changeComposerPromptReference}
                  onChange={saveComposerDocument} />}
              {!selectedNodeGenerating && <CanvasPromptDocumentStatus document={composerSections} references={promptEditorReferences}
                disabled={busy} onResolve={resolveComposerSource} />}
              {promptParameterConflicts.length > 0 && <div className="pc-prompt-parameter-conflicts" role="alert">
                {promptParameterConflicts.map((conflict, index) => <p key={`${conflict.field}:${index}`}>{conflict.message}</p>)}
                <Button size="compact-xs" variant="light" disabled={busy || selectedNodeGenerating}
                  onClick={() => saveComposerDocument(synchronizePromptParameters(composerPrompt, composerParameters))}>按生成参数同步提示词</Button>
              </div>}
              {promptReferenceIssue && <p className="pc-required-reference-error" role="alert">{promptReferenceIssue}</p>}
              {!selectedProfile && selectedJobRecovery && selectedJob && !canOptimizeImagePrompt(selectedJob, selectedModel?.modality)
                && <p className="pc-required-reference-error" role="status" aria-label="原生成任务恢复提示">{selectedJobRecovery.guidance}</p>}
              {selectedGenerationSubmission && (selectedSubmissionPending || selectedGenerationSubmission.rejected) && <div className="pc-prompt-parameter-conflicts" role="status" aria-label="原生成提交状态">
                <p>原提交已接收 {selectedGenerationSubmission.candidates.filter(candidate => candidate.jobId).length}/{selectedGenerationSubmission.candidates.length} 个任务。
                  {selectedGenerationSubmission.rejected ? `其余任务已被拒绝：${selectedGenerationSubmission.rejected}。再次生成会创建全新一轮。`
                    : '检查已有任务只会找回记录；继续原提交沿用原参数，只提交尚未接收的候选。'}</p>
                {selectedSubmissionPending && <>
                  <p>如需更换原参数，可另建生成节点开始新一轮；原提交仍可能稍后出现，请先检查任务记录。</p>
                  <WorkspaceDisclosure label="查看原提交参数"><p>{String(selectedGenerationSubmission.request.prompt || '')}</p>
                    <p>{[selectedGenerationSubmission.request.model_id, selectedGenerationSubmission.request.ratio,
                      selectedGenerationSubmission.request.resolution, selectedGenerationSubmission.request.duration && `${selectedGenerationSubmission.request.duration} 秒`].filter(Boolean).join(' · ')}</p></WorkspaceDisclosure>
                  <Button size="compact-xs" variant="light" disabled={busy} aria-label="检查已有生成任务"
                    onClick={() => void resumeGenerationSubmission(selectedGenerationSubmission.nodeId, false)}>检查已有任务</Button>
                  <Button size="compact-xs" variant="light" disabled={busy} aria-label="继续原生成提交"
                    onClick={() => void resumeGenerationSubmission(selectedGenerationSubmission.nodeId, true)}>继续原提交</Button>
                </>}
              </div>}
              </div>
              </div>
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
                    disabled={busy || selectedNodeGenerating}
                    onChange={changeVideoMode} />}
                  {composerModel && composerModel.modality !== 'text' && <>
                    <span className="pc-composer-divider" />
                    <CanvasGenerationParameters key={`params:${selectedNode.id}:${composerModel.id}`} modality={composerModel.modality}
                      ratios={modelRatios(composerModel)} ratio={composerRatio} resolutions={composerResolutions} resolution={composerResolution}
                      clarities={composerClarities} clarity={composerClarity} qualities={composerQualities} quality={composerQuality} backgrounds={composerBackgrounds} background={composerBackground}
                      duration={composerDuration} editDuration={selectedShot?.duration} minDuration={durationMin} maxDuration={durationMax}
                      showDuration={composerModel.modality === 'video' && selectedMode !== 'edit'}
                      ratioFollowsSource={videoPolicy.ratioFollowsSource} durationFollowsSource={videoPolicy.durationFollowsSource}
                      draftSupported={composerModel.settings.video_reference_profile === 'seedance_2_5' && composerModel.settings.supports_draft === true} draft={composerDraft}
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
                      <p>{generationNodeCapabilityDescriptions.map(capability => capability.label).join(' · ')}</p>
                      {review ? <div className="pc-generation-info-content">
                        <dl>
                          <div><dt>{review.board ? '设定档案' : '目标镜头'}</dt><dd>{review.shot.title}</dd></div>
                          <div><dt>模型</dt><dd>{review.model.name} · {review.provider?.name || '未知服务商'}</dd></div>
                          <div><dt>当前任务</dt><dd>{selectedJob ? `${selectedJob.id} · ${selectedJob.status}` : selectedNodeGenerating ? '生成中' : '无关联任务'}</dd></div>
                          <div><dt>类型与模式</dt><dd>{review.board ? '设定信息图' : review.model.modality === 'video' ? videoModeLabel(review.request.mode) : review.model.modality === 'image' ? '生成图片' : '生成文本'}</dd></div>
                          <div><dt>参数</dt><dd>{review.model.modality === 'image'
                            ? [review.request.resolution, review.request.quality && `画质 ${review.request.quality}`, review.request.clarity, review.request.background && `背景 ${review.request.background}`].filter(Boolean).join(' · ')
                            : review.request.resolution || '默认'}{review.model.modality === 'video'
                              ? videoParameterPolicy(review.model, review.request.mode).durationFollowsSource ? ' · 原视频时长' : ` · ${review.request.duration} 秒` : ''}
                            {review.model.modality !== 'text' ? ` · ${review.request.ratio === 'adaptive' ? '自适应' : review.request.ratio}` : ''}{review.request.draft ? ' · 样片' : ''}</dd></div>
                          {review.model.modality === 'video' && <div><dt>生成声音</dt><dd>{review.request.generate_audio ? '开启' : '关闭'}</dd></div>}
                          <div><dt>参考图</dt><dd>{review.referenceNames.length ? review.referenceNames.map((name, index) => ['first_frame', 'first_last_frame'].includes(review.request.mode) ? `${index === 0 ? '首帧' : '尾帧'}：${name}` : name).join('、') : '无'}</dd></div>
                          {review.request.reference_video_url && <div><dt>参考视频</dt><dd>{review.request.reference_video_url}</dd></div>}
                          <div><dt>候选数量</dt><dd>{review.candidateCount} 个</dd></div>
                          <div><dt>总费用预估</dt><dd>{videoParameterPolicy(review.model, review.request.mode).durationFollowsSource ? '按原视频时长及厂商价格结算'
                            : generationCost(review.model, review.request, review.candidateCount) ? `约 ${generationCost(review.model, review.request, review.candidateCount)}` : '模型未配置费用，请核对厂商价格'}</dd></div>
                        </dl>
                        {!!review.request.reference_asset_ids.length && <div className="pc-visual-thumbnails">{review.request.reference_asset_ids.map(id => assetMap.get(id)).filter((asset): asset is Asset => !!asset).map(asset => <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={asset.filename} title={asset.filename} /></a>)}</div>}
                        {review.request.visual_signature && <p>{review.request.visual_reference_mode === 'text_only' ? '仅使用文字设定' : review.request.visual_reference_mode === 'keyframe' ? '使用关键帧与文字设定' : '使用镜头选定参考图与文字设定'}</p>}
                        {review.request.project_visual_style && review.request.project_visual_style.source !== 'unspecified' && <p>项目画风：{review.request.project_visual_style.label}</p>}
                        {review.request.style_warnings?.map(warning => <p key={warning} role="status">{warning}</p>)}
                        <div className="pc-generation-info-prompt"><span>实际提交提示词</span><p>{review.request.prompt}</p></div>
                      </div> : <div className="pc-generation-info-loading" role="status"><LoaderCircle size={16} className="pc-spin" />正在整理生成信息</div>}
                    </Popover.Dropdown>
                  </Popover>}
                  {selectedNode.type === 'generation' && onOpenDirectorPanel && <Tooltip label="添加节点配置快照到导演对话">
                    <ActionIcon type="button" variant="subtle" aria-label="添加到导演对话" title="添加到导演对话"
                      disabled={busy || selectedNodeGenerating || !composerModelId} onClick={() => void addGenerationToDirector()}><MessageSquare size={18} /></ActionIcon>
                  </Tooltip>}
                  <ActionIcon type="button" className="pc-composer-submit" aria-label={selectedNodeGenerating ? '生成中，请等待' : '开始生成'}
                    title={selectedNodeGenerating ? '生成中，请等待' : selectedProfile ? selectedBoardAsset ? '重新生成当前设定图' : '生成当前设定图' : '开始生成'}
                    disabled={busy || selectedNodeGenerating || !composerHasContent || (!selectedProfile && !compiledPrompt.trim() && !selectedNode.settings.prompt_is_final) || !composerModelId
                      || !!selectedTemplateKind && !preparedReferenceIds.length
                      || !!selectedProfile && (visualPanelBusy || !!promptReferenceIssue || !!missingReferences.length || !!selectedProfile.base_profile_id && !baseProfileReady)}
                    onClick={submitComposer} data-workspace-control="" variant="filled">{selectedNodeGenerating ? <LoaderCircle size={18} className="pc-spin" /> : <ArrowRight size={18} />}</ActionIcon>
                </div>
              </div>
            </div>
          </CanvasComposerToolbar>}
        </ReactFlow></CanvasEdgeMotionProvider> : <div className="pc-loading">{loadError ? <><CircleAlert size={20} />{loadError}<Button variant="default" size="xs" onClick={() => window.location.reload()} leftSection={<RefreshCcw size={14} />}>重新载入</Button></> : <><LoaderCircle size={20} className="pc-spin" />正在载入画布</>}</div>}
        {contextMenu && <Menu opened closeOnItemClick={false} onChange={opened => { if (!opened) setContextMenu(null) }} withinPortal={false} position="bottom-start" offset={0} zIndex={80}><Menu.Target><span className="pc-menu-anchor" style={{ left: contextMenu.x, top: contextMenu.y }} /></Menu.Target><Menu.Dropdown className="pc-context-menu" data-canvas-overlay onContextMenu={event => event.preventDefault()}>
          {contextNode && contextSelectionCount > 1 ? <>
            <div className="pc-context-heading"><span>批量操作</span><strong>已选 {contextSelectionCount} 个节点</strong></div>
            <Menu.Item className="is-danger" role="menuitem" onClick={() => void deleteSelection()} data-workspace-control=""><Trash2 size={16} />删除所选 {contextSelectionCount} 个节点</Menu.Item>
            <Menu.Item role="menuitem" onClick={cancelCanvasSelection} data-workspace-control=""><X size={16} />取消选择</Menu.Item>
          </> : contextNode ? <>
            <div className="pc-context-heading"><span>{contextNode.type === 'video_analysis' ? '视频反推提示词' : contextNode.type === 'image_analysis' ? '图片反推提示词' : contextNode.type === 'project_script_ref' ? '项目剧本' : contextNode.type === 'generation' ? '生成节点' : contextNode.type === 'text' ? '文本节点' : '素材节点'}</span><strong>{contextNode.title || '未命名节点'}</strong></div>
            {contextNode.type === 'project_script_ref'
              ? <Menu.Item role="menuitem" onClick={() => { setContextMenu(null); (detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length) ? onOpenScriptCreator() : openScriptDirector() }} data-workspace-control=""><ScrollText size={16} />{detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length ? '编辑剧本' : '开始剧本创作'}</Menu.Item>
              : <Menu.Item role="menuitem" onClick={() => { selectNodeForView(contextNode.id); setContextMenu(null) }} data-workspace-control=""><Settings2 size={16} />编辑节点</Menu.Item>}
            {contextNode.type !== 'image_analysis' && visualNodeAsset(contextNode, detail, true)?.kind === 'image' && <Menu.Item role="menuitem" onClick={() => addImageAnalysisFromSource(contextNode)} data-workspace-control=""><ScanEye size={16} />反推提示词</Menu.Item>}
            {visualNodeAsset(contextNode, detail)?.kind === 'video' && <>
              <Menu.Item role="menuitem" onClick={() => addVideoAnalysisFromSource(contextNode)} data-workspace-control=""><ScanEye size={16} />反推视频提示词</Menu.Item>
              <Menu.Item role="menuitem" onClick={() => { const asset = visualNodeAsset(contextNode, detail); if (asset) setNodeMediaPreview({ asset, title: contextNode.title || asset.filename, shotId: contextNode.shot_id, initialPanel: 'review' }); setContextMenu(null) }} data-workspace-control=""><ScanEye size={16} />成片复核</Menu.Item>
              <Menu.Item role="menuitem" onClick={() => { const asset = visualNodeAsset(contextNode, detail); if (asset) setNodeMediaPreview({ asset, title: contextNode.title || asset.filename, shotId: contextNode.shot_id, initialPanel: 'comparison' }); setContextMenu(null) }} data-workspace-control=""><ArrowLeftRight size={16} />动作对照</Menu.Item>
            </>}
            {contextNode.type !== 'image_analysis' && visualNodeAsset(contextNode, detail)?.kind === 'image' && <VisualSettingMenuItems fromImage onSelect={kind => addVisualSettingNode(kind, undefined, contextNode)} />}
            {contextNode.type === 'generation' && <Menu.Item role="menuitem" onClick={() => { setPendingRunNodeId(contextNode.id); setContextMenu(null) }} data-workspace-control=""><Sparkles size={16} />提交生成</Menu.Item>}
            {contextNode.type !== 'project_script_ref' && <Menu.Item role="menuitem" onClick={() => duplicateSelection(contextNode.id)} data-workspace-control=""><Plus size={16} />复制节点</Menu.Item>}
            {contextNode.type !== 'project_script_ref' && <>
              <div className="pc-context-divider" />
              <Menu.Item className="is-danger" role="menuitem" onClick={() => deleteSelection(contextNode.id, null)} data-workspace-control=""><Trash2 size={16} />删除节点</Menu.Item>
            </>}
          </> : contextEdge ? <>
            <div className="pc-context-heading"><span>节点连接</span><strong>参考或结果关系</strong></div>
            <Menu.Item className="is-danger" role="menuitem" onClick={() => deleteSelection(null, contextEdge.id)} data-workspace-control=""><Trash2 size={16} />删除连接</Menu.Item>
          </> : <>
            <div className="pc-context-heading"><span>画布操作</span><strong>在当前位置创建</strong></div>
            <Menu.Item role="menuitem" onClick={() => { addNode('text', undefined, contextMenu.position); setContextMenu(null) }} data-workspace-control=""><FileText size={16} />添加文本</Menu.Item>
            <Menu.Item role="menuitem" onClick={() => { addNode('image_analysis', undefined, contextMenu.position); setContextMenu(null) }} data-workspace-control=""><ScanEye size={16} />图片反推提示词</Menu.Item>
            <Menu.Item role="menuitem" onClick={() => { addNode('video_analysis', undefined, contextMenu.position); setContextMenu(null) }} data-workspace-control=""><Film size={16} />视频反推提示词</Menu.Item>
            <Menu.Item role="menuitem" onClick={() => { addNode('generation', 'image', contextMenu.position); setContextMenu(null) }} data-workspace-control=""><ImageIcon size={16} />图片生成</Menu.Item>
            <VisualSettingMenuItems onSelect={kind => addVisualSettingNode(kind, contextMenu.position)} />
            <Menu.Item role="menuitem" onClick={() => { addNode('generation', 'video', contextMenu.position); setContextMenu(null) }} data-workspace-control=""><Film size={16} />视频生成</Menu.Item>
            {canvasShots.length > 0 && <Menu.Item role="menuitem" onClick={() => { importShots(); setContextMenu(null) }} data-workspace-control=""><ScrollText size={16} />导入分镜</Menu.Item>}
            <div className="pc-context-divider" />
            <Menu.Item role="menuitem" onClick={() => { void fitView({ padding: 0.15, duration: 300 }); setContextMenu(null) }} data-workspace-control=""><MousePointer2 size={16} />适配全部节点</Menu.Item>
            <Menu.Item role="menuitem" disabled={!hasSelectableCanvasNodes} onClick={selectAllCanvasNodes} data-workspace-control=""><Check size={16} />{nodeTypeFilter === 'all' ? '全选节点' : '全选可见节点'}</Menu.Item>
            <Menu.Item className="is-danger" role="menuitem" disabled={!hasRemovableCanvasContent} onClick={() => void clearCanvas()} data-workspace-control=""><Trash2 size={16} />清空画布</Menu.Item>
          </>}
        </Menu.Dropdown></Menu>}
        {selectedCanvasNodeIds.length > 1 && <div className="pc-selection-toolbar" role="toolbar" aria-label="多选节点操作" data-canvas-overlay
          onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
          <span role="status">已选 <strong>{selectedCanvasNodeIds.length}</strong> 个节点</span>
          <Button size="xs" color="red" variant="light" leftSection={<Trash2 size={14} />}
            aria-label={`删除所选 ${selectedCanvasNodeIds.length} 个节点`} onClick={() => void deleteSelection()}>删除所选</Button>
          <Button size="xs" variant="subtle" color="gray" onClick={cancelCanvasSelection}>取消选择</Button>
        </div>}
        {graph && !graph.nodes.length && <div className="pc-empty">
          <div className="pc-empty-hint"><MousePointer2 size={16} />双击画布，自由生成节点</div>
          <div className="pc-empty-actions"><Button variant="default" onClick={() => addNode('text')} leftSection={<FileText size={16} />}>文本</Button><Button variant="default" onClick={() => addNode('generation', 'image')} leftSection={<ImageIcon size={16} />}>图片生成</Button><Button variant="default" onClick={() => addNode('generation', 'video')} leftSection={<Film size={16} />}>视频生成</Button><Button variant="default" onClick={() => openScriptDirector('all')} leftSection={<ScrollText size={16} />}>剧本生成</Button>{canvasShots.length > 0 && <Button variant="default" onClick={() => importShots()} leftSection={<Layers3 size={16} />}>导入分镜</Button>}</div>
        </div>}
        {graph && graph.nodes.length > 0 && !visibleNodeIds.size && <div className="pc-empty pc-type-filter-empty" role="status" data-canvas-overlay>
          <div className="pc-empty-hint">当前没有{nodeTypeFilter === 'image' ? '图片' : nodeTypeFilter === 'video' ? '视频' : nodeTypeFilter === 'text' ? '文本' : '剧本'}节点</div>
          <div><Button variant="default" size="xs" onClick={() => changeNodeTypeFilter('all')}>显示全部节点</Button></div>
        </div>}
        {scriptCanvasError ? <div className="pc-import-prompt pc-script-canvas-error" role="alert" data-canvas-overlay><span>{scriptCanvasError}</span><Button variant="default" size="xs" onClick={() => { scriptCanvasAttempt.current = null; setScriptCanvasRetry(value => value + 1) }}>重试加入画布</Button></div>
          : graph && graph.nodes.length > 0 && missingShotCount > 0 && <div className="pc-import-prompt"><span>{missingShotCount} 个分镜尚未加入画布</span><Button variant="default" size="xs" onClick={() => importShots()} leftSection={<Layers3 size={14} />}>导入分镜</Button></div>}
        </div>}
      {viewMode === 'storyboard' && (graph ? <StoryboardWorkspace
          detail={browsingDetail}
          graph={graph}
          models={models}
          query={storyboardQuery}
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
          onCreateVideo={(id, mode) => void tryNodeAction(id, mode === 'reference' ? 'video-reference' : 'video-first-frame')}
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
        <Tooltip label="图片反推提示词"><ActionIcon variant="subtle" aria-label="添加图片反推提示词节点" onClick={() => addNode('image_analysis')} disabled={!graph}><ScanEye size={19} /></ActionIcon></Tooltip>
        <Tooltip label="视频反推提示词"><ActionIcon variant="subtle" aria-label="添加视频反推提示词节点" onClick={() => addNode('video_analysis')} disabled={!graph}><Film size={19} /></ActionIcon></Tooltip>
        <Tooltip label="视频生成"><ActionIcon variant="subtle" aria-label="添加视频生成节点" onClick={() => addNode('generation', 'video')} disabled={!graph}><Film size={19} /></ActionIcon></Tooltip>
        <Tooltip label="上传素材"><ActionIcon variant="subtle" aria-label="上传素材到画布" onClick={openCanvasUpload}><Upload size={19} /></ActionIcon></Tooltip>
        <Tooltip label="浏览素材"><ActionIcon variant="subtle" aria-label="浏览画布素材" onClick={() => showSidebarAssets()}><Layers3 size={19} /></ActionIcon></Tooltip>
        {viewMode === 'canvas' && <Tooltip label={nodeTypeFilter === 'all' ? '适配画布' : '适配可见节点'}><ActionIcon variant="subtle" aria-label={nodeTypeFilter === 'all' ? '适配全部节点' : '适配可见节点'} disabled={!visibleNodeIds.size} onClick={() => void fitView({ padding: 0.15, duration: 300 })}><MousePointer2 size={18} /></ActionIcon></Tooltip>}
      </div>
      {addMenu && <Menu opened onChange={opened => { if (!opened) setAddMenu(null) }} withinPortal={false} position={addMenu.screen ? "bottom-start" : "top"} offset={8} zIndex={80}><Menu.Target><span className={`pc-menu-anchor ${addMenu.screen ? "" : "pc-add-anchor-dock"}`} style={addMenu.screen ? { left: addMenu.screen.x, top: addMenu.screen.y } : undefined} /></Menu.Target><Menu.Dropdown className={`pc-add-menu ${addMenu.screen ? 'pc-add-menu-canvas' : 'pc-add-menu-dock'}`} data-canvas-overlay>
        <Menu.Item role="menuitem" onClick={() => addNode('text', undefined, addMenu.position)} data-workspace-control=""><FileText size={17} />文本</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => addNode('image_analysis', undefined, addMenu.position)} data-workspace-control=""><ScanEye size={17} />图片反推提示词</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => addNode('video_analysis', undefined, addMenu.position)} data-workspace-control=""><Film size={17} />视频反推提示词</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => addNode('generation', 'image', addMenu.position)} data-workspace-control=""><ImageIcon size={17} />图片生成</Menu.Item>
        <VisualSettingMenuItems onSelect={kind => addVisualSettingNode(kind, addMenu.position)} />
        <Menu.Item role="menuitem" onClick={() => addNode('generation', 'video', addMenu.position)} data-workspace-control=""><Film size={17} />视频生成</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => showSidebarAssets('audio')} data-workspace-control=""><Music2 size={17} />音频素材</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => { setAddMenu(null); openCanvasUpload() }} data-workspace-control=""><Upload size={17} />上传素材</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => showSidebarAssets()} data-workspace-control=""><Layers3 size={17} />素材库</Menu.Item>
        <Menu.Item role="menuitem" onClick={() => { onNavigate('jobs'); setAddMenu(null) }} data-workspace-control=""><Clock3 size={17} />生成历史</Menu.Item>
        {canvasShots.length > 0 && <Menu.Item role="menuitem" onClick={() => { importShots(); setAddMenu(null) }} data-workspace-control=""><ScrollText size={17} />导入分镜</Menu.Item>}
        <Menu.Item role="menuitem" onClick={() => { organizeShotGroups(); setAddMenu(null) }} data-workspace-control=""><WandSparkles size={17} />按镜头整理生成器组</Menu.Item>
        {(selectedNode?.type !== 'project_script_ref' && selectedNodeId || selectedEdgeId) && <Menu.Item role="menuitem" onClick={() => { deleteSelection(); setAddMenu(null) }} data-workspace-control=""><Trash2 size={17} />移除所选</Menu.Item>}
      </Menu.Dropdown></Menu>}

    </div>
    {notice && <div className="pc-notice" role="status"><span>{notice.message}</span><ActionIcon aria-label="关闭提示" onClick={() => setNotice(null)} data-workspace-control=""><X size={14} /></ActionIcon></div>}
    <FileButton ref={profileUploadInputRef} accept="image/png,image/jpeg,image/webp"  onChange={file => { if (file) void uploadProfileBoard(file); if (profileUploadInputRef.current) profileUploadInputRef.current.value = '' }}>{() => null}</FileButton>
    {candidateProfile && <VisualCandidateManager key={candidateProfile.id} profile={candidateProfile} detail={detail} models={models} displayedAssetId={candidateNode?.asset_id} generating={candidateGenerating} onConfirm={assetId => useProfileBoard(candidateProfile, assetId)} onRefresh={onRefresh} onClose={() => setCandidateProfileId(null)} onError={showError} />}
    {candidateShot && shotCandidateNode && <ShotCandidateManager key={`${shotCandidateNode.id}:${managedShotModality}`} modality={managedShotModality} title={candidateShot.title}
      candidates={managedShotCandidates} archivedAssetIds={candidateShot.archived_candidate_asset_ids || []}
      displayedAssetId={shotCandidateNode.asset_id} selectedAssetId={candidateShot.selected_asset_id} protectedAssetIds={protectedShotCandidateIds} models={models}
      busy={busy} generating={managedShotGenerating} previewOpen={!!nodeMediaPreview} onUse={assetId => useShotCandidate(shotCandidateNode.id, assetId)}
      onArchive={(assetId, archived) => archiveShotCandidate(shotCandidateNode.id, assetId, archived)}
      onPreview={asset => setNodeMediaPreview({ asset, title: `${candidateShot.title} · ${managedShotModality === 'video' ? '分镜视频候选' : '分镜图候选'}`, shotId: candidateShot.id })}
      onClose={() => setShotCandidateNodeId(null)} />}
    {viewMode === 'canvas' && (inspectedProfile || visualTool === 'create') && <VisualProfileInspector key={inspectedProfile?.id || 'new'} profile={inspectedProfile} detail={browsingDetail} designId={canvas.design_id} models={models} providers={providers} generating={inspectedProfileGenerating}
      inCanvas={!!inspectedProfile && !!graph?.nodes.some(node => node.settings.visual_profile_id === inspectedProfile.id)} onRefresh={onRefresh} onClose={() => void closeVisualPanel()}
      onBindings={() => void openVisualTool('bindings', { profileId: inspectedProfile?.id })} onDirtyChange={setProfileDraftDirty} onBusyChange={setVisualPanelBusy}
      onSaved={profile => { setVisualTool(null); setProfileInspectorId(profile.id); setNotice('设定已保存') }} onDeleted={removeProfileNodes}
      onOpenCanvas={profile => { setVisualTool(null); addProfileToCanvas(profile, null) }} />}
    <Drawer opened={!!selectedShot && composerBindingsOpen} onClose={closeComposerBindings} position="right"
      size="min(760px, 100vw)" padding={0} withCloseButton={false} zIndex={230}
      closeOnEscape={!visualPanelBusy && !referencePreview} closeOnClickOutside={!visualPanelBusy && !referencePreview}
      transitionProps={{ duration: 0 }} overlayProps={{ backgroundOpacity: 0.3 }}
      portalProps={{ target: viewportRef.current?.closest<HTMLElement>('.project-canvas') || undefined }}
      attributes={{ content: { 'aria-label': '镜头引用' } }}
      classNames={{ root: 'pc-shot-references-root', content: 'pc-shot-references-content', body: 'pc-shot-references-body' }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
      {selectedShot && composerBindingsOpen && <VisualBindingEditor key={`${selectedShot.id}:${composerModality}`} id="pc-composer-bindings" presentation="drawer"
        detail={browsingDetail} context={{ target: `shot:${selectedShot.id}`, scope: composerModality === 'image' || composerModality === 'video' ? composerModality : undefined }} onRefresh={onRefresh} onClose={closeComposerBindings}
        onBusyChange={setVisualPanelBusy} onPreview={setReferencePreview}
        onLocate={profile => { setComposerBindingsOpen(false); addProfileToCanvas(profile, null) }} />}
    </Drawer>
    {viewMode === 'canvas' && visualTool === 'bindings' && <VisualBindingEditor key={JSON.stringify(visualBindingContext)} detail={browsingDetail} context={visualBindingContext} onRefresh={onRefresh}
      onClose={() => void closeVisualPanel()} onBusyChange={setVisualPanelBusy} onLocate={profile => { setVisualTool(null); addProfileToCanvas(profile, null) }} />}
    {viewMode === 'canvas' && visualTool === 'organize' && <VisualProfileOrganizer detail={browsingDetail} designId={canvas.design_id} models={models} providers={providers} onRefresh={onRefresh} onClose={() => void closeVisualPanel()} onBusyChange={setVisualPanelBusy} onDirtyChange={setProfileDraftDirty} />}
    <Modal opened={!!referencePreview} onClose={() => setReferencePreview(null)} title={referencePreview?.filename || '参考图'} centered size="min(960px, 90vw)" radius={18}
      classNames={{ content: 'pc-reference-preview', header: 'pc-reference-preview-header' }} zIndex={240}>
      {referencePreview && <img src={referencePreview.url} alt={referencePreview.filename} className="pc-reference-preview-image" />}
    </Modal>
    {selectedNode?.type === 'image_analysis' && composerNodeId === selectedNode.id && selectedNodeIds.length === 1 && (() => {
      const source = graph ? resolveCanvasImageAnalysisSource(selectedNode, graph, analysisDetail) : { issue: '画布未就绪' }
      const asset = analysisDetail.assets.find(asset => asset.id === source.assetId)
      const active = analysisRun?.nodeId === selectedNode.id
      const changed = selectedNode.settings.image_analysis_source_asset_id && source.assetId !== selectedNode.settings.image_analysis_source_asset_id
      return <Modal opened onClose={() => setComposerNodeId(null)} title="图片反推提示词" size="lg" centered zIndex={250}>
        <CanvasImageAnalysisPanel asset={asset ? { id: asset.id, url: asset.url, label: asset.filename } : undefined}
          models={visionModels.map(model => ({ id: model.id, label: model.name }))} modelId={selectedNode.model_id || ''}
          instructions={selectedNode.settings.image_analysis_instructions || ''} prompt={selectedNode.text}
          pending={active && analysisRun.phase === 'analyzing'} uploading={active && analysisRun.phase === 'uploading'}
          otherPending={!!analysisRun && !active}
          elapsedSeconds={active ? analysisElapsed : 0} error={analysisErrors[selectedNode.id] || ((selectedNode.asset_id || graph?.edges.some(edge => edge.target === selectedNode.id)) ? source.issue : '')
            || (changed ? '来源图片已更换，当前提示词仍为上次结果，可重新反推' : '')}
          onUpload={file => void uploadAnalysisImage(selectedNode.id, file)}
          onClearSource={() => clearAnalysisSource(selectedNode.id)}
          onModelChange={id => { updateNodeById(selectedNode.id, { model_id: id || null }); setAnalysisErrors(current => ({ ...current, [selectedNode.id]: '' })) }}
          onInstructionsChange={value => updateNodeSettingsById(selectedNode.id, { image_analysis_instructions: value })}
          onPromptChange={value => updateNodeById(selectedNode.id, { text: value })}
          onAnalyze={() => void analyzeCanvasImage(selectedNode.id)} onCancel={cancelImageAnalysis}
          onCreateGeneration={() => createGenerationFromAnalysis(selectedNode)} />
      </Modal>
    })()}
    {selectedNode?.type === 'video_analysis' && composerNodeId === selectedNode.id && selectedNodeIds.length === 1 && (() => {
      const source = graph ? resolveCanvasVideoAnalysisSource(selectedNode, graph, videoAnalysis.detail) : { issue: '画布未就绪' }
      const asset = videoAnalysis.detail.assets.find(item => item.id === source.assetId)
      const active = videoAnalysis.run?.nodeId === selectedNode.id
      return <Modal opened onClose={() => setComposerNodeId(null)} title="视频反推提示词" size="xl" centered zIndex={250}>
        <CanvasVideoAnalysisPanel asset={asset ? { id: asset.id, url: asset.url, label: asset.filename } : undefined}
          models={videoAnalysisOptions} modelId={selectedNode.model_id || ''}
          instructions={selectedNode.settings.video_analysis_instructions || ''}
          startMs={selectedNode.settings.video_analysis_start_ms || 0} endMs={selectedNode.settings.video_analysis_end_ms ?? null}
          fps={selectedNode.settings.video_analysis_fps ?? 2} durationMs={asset ? videoAnalysis.durations[asset.id] : undefined}
          result={selectedNode.settings.video_analysis_result}
          pending={active && videoAnalysis.run?.phase === 'analyzing'} uploading={active && videoAnalysis.run?.phase === 'uploading'}
          otherPending={!!videoAnalysis.run && !active} elapsedSeconds={active ? videoAnalysis.elapsed : 0}
          error={videoAnalysis.errors[selectedNode.id] || ((selectedNode.asset_id || graph?.edges.some(edge => edge.target === selectedNode.id)) ? source.issue : '')}
          onUpload={file => void videoAnalysis.upload(selectedNode.id, file)} onClearSource={() => videoAnalysis.clearSource(selectedNode.id)}
          onModelChange={id => { updateNodeById(selectedNode.id, { model_id: id || null }); videoAnalysis.clearError(selectedNode.id) }}
          onInstructionsChange={value => updateNodeSettingsById(selectedNode.id, { video_analysis_instructions: value })}
          onRangeChange={(start, end) => updateNodeSettingsById(selectedNode.id, { video_analysis_start_ms: start, video_analysis_end_ms: end })}
          onFpsChange={value => updateNodeSettingsById(selectedNode.id, { video_analysis_fps: value })}
          onDurationChange={value => { if (asset) videoAnalysis.setDuration(asset.id, value) }}
          onResultChange={value => updateNodeById(selectedNode.id, { text: videoAnalysisText(value), settings: { ...selectedNode.settings, video_analysis_result: value } })}
          onAnalyze={() => void videoAnalysis.analyze(selectedNode.id)} onCancel={videoAnalysis.cancel}
          onOpenModels={() => { setComposerNodeId(null); onOpenModels() }}
          onCreateGeneration={index => createGenerationFromVideoAnalysis(selectedNode, index)} />
      </Modal>
    })()}
    {nodeMediaPreview && <CanvasMediaPreview key={`${nodeMediaPreview.asset.id}:${nodeMediaPreview.initialPanel || ''}`} asset={nodeMediaPreview.asset} title={nodeMediaPreview.title}
      projectId={detail.id} reviewModels={reviewModels} shotId={nodeMediaPreview.shotId} initialPanel={nodeMediaPreview.initialPanel}
      generationDurationMs={videoGenerationDurationMs(nodeMediaPreview.asset.id, detail.jobs)}
      plannedDurationMs={previewShot ? previewShot.duration * 1000 : undefined}
      onClose={() => setNodeMediaPreview(null)} />}
    <Modal opened={!!conflictReview} onClose={() => setConflictReview(null)} title="画布版本冲突" centered size="md">
      {conflictReview && <div className="pc-conflict"><p>服务器上的画布已被其他编辑更新。本地修改仍保留。合并会保留双方独立新增的节点；同一内容同时修改时以本地版本为准。</p><strong>{conflictReview.conflicts} 处内容冲突</strong><div><Button variant="default" onClick={useServerVersion}>加载服务器版本</Button><Button onClick={() => void applyMerge()} leftSection={<Save size={15} />}>合并并保存</Button></div></div>}
    </Modal>
    {selectedNode && selectedNode.id === optimizationNodeId && selectedJob && canOptimizeImagePrompt(selectedJob, composerModality) &&
      <PromptOptimizationModal key={`${selectedNode.id}:${selectedJob.id}`} job={selectedJob} models={models} providers={providers}
        prompt={composerPrompt} sourceKey={generationInputKey} disabled={busy || selectedNodeGenerating} maxLength={80_000}
        onClose={() => setOptimizationNodeId(null)} onApply={value => {
          saveComposerDocument(value)
          setNotice('已应用优化后的提示词，请确认后手动生成')
        }} />}
    {dialog}
  </div>
}

const MemoProjectCanvasInner = memo(ProjectCanvasInner)

export default function ProjectCanvas(props: ProjectCanvasProps) {
  // Parent status updates recreate inline handlers. Keep the canvas isolated
  // from that noise while every action still uses the latest committed props.
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props })
  const locationRef = useRef(props.initialLocation)
  const hasRename = !!props.onRenameProject
  const hasDocument = !!props.onOpenScriptDocument
  const hasDirector = !!props.onOpenScriptDirector
  const hasLocation = !!props.onLocationChange
  const hasSpeech = !!props.onOpenSpeech
  const hasOptimizedDraftApplied = !!props.onOptimizedPromptDraftApplied
  const hasNodeProposalActions = !!props.registerNodeProposalActions
  const callbacks = useMemo(() => ({
    onRefresh: () => latest.current.onRefresh(),
    onOpenModels: () => latest.current.onOpenModels(),
    onNavigate: (destination: Parameters<ProjectCanvasProps['onNavigate']>[0]) => latest.current.onNavigate(destination),
    onOpenScriptCreator: () => latest.current.onOpenScriptCreator(),
    onOpenSpeech: hasSpeech ? () => latest.current.onOpenSpeech!() : undefined,
    onOptimizedPromptDraftApplied: hasOptimizedDraftApplied ? () => latest.current.onOptimizedPromptDraftApplied!() : undefined,
    onRenameProject: hasRename ? (name: string) => latest.current.onRenameProject!(name) : undefined,
    onOpenScriptDocument: hasDocument ? (artifact: ScriptArtifact) => latest.current.onOpenScriptDocument!(artifact) : undefined,
    onOpenScriptDirector: hasDirector ? (focus?: ScriptAction, context?: string, source?: CanvasNodeProposalSource) => latest.current.onOpenScriptDirector!(focus, context, source) : undefined,
    registerNodeProposalActions: hasNodeProposalActions ? (actions: CanvasNodeProposalActions | null) => latest.current.registerNodeProposalActions!(actions) : undefined,
    onLocationChange: (location: CanvasLocation) => { locationRef.current = location; if (hasLocation) latest.current.onLocationChange!(location) },
  }), [hasRename, hasDocument, hasDirector, hasLocation, hasSpeech, hasOptimizedDraftApplied, hasNodeProposalActions])
  const renderCanvas = useCallback((canvas: ProjectCanvasInfo, session: CanvasSession, menu: React.ReactNode, register: (actions: CanvasActions | null) => void, viewportChanged: (viewport: ProjectCanvasInfo['viewport']) => void) =>
    <ReactFlowProvider key={canvas.id}><MemoProjectCanvasInner detail={props.detail} models={props.models} providers={props.providers} {...callbacks} initialLocation={locationRef.current}
      optimizedPromptDraft={props.optimizedPromptDraft}
      canvas={canvas} canvasSession={session} canvasMenu={menu} registerCanvasActions={register} onCanvasViewport={viewportChanged} /></ReactFlowProvider>,
  [props.detail, props.models, props.providers, props.optimizedPromptDraft, callbacks])
  return <ProjectCanvasSwitcher projectId={props.detail.id}>{renderCanvas}</ProjectCanvasSwitcher>
}
