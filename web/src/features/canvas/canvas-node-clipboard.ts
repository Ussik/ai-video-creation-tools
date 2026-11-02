import type { Asset, ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { isPromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import { videoReferenceUsages } from '@video-studio/shared/media/video-reference-usage'
import { freeCanvasPosition } from './canvas-node-placement'
import { visualNodeAsset } from './canvas-visual-profiles'

const clipboardPrefix = 'VIDEO_STUDIO_CANVAS_NODES_V1\n'
type ClipboardDetail = Pick<ProjectDetail, 'assets' | 'visual_profiles'>
export type CanvasNodeClipboard = {
  kind: 'video-studio/canvas-nodes'
  version: 1
  projectId: string
  canvasId: string
  nodeIds: string[]
  nodes: CanvasNode[]
  edges: CanvasGraph['edges']
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100
const text = (value: unknown, max = 80_000): value is string => typeof value === 'string' && value.length <= max
const nullableId = (value: unknown) => value === null || id(value)
const finite = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

function independentNode(source: CanvasNode, detail?: ClipboardDetail): CanvasNode {
  const node = clone(source), settings = node.settings
  const profile = detail?.visual_profiles?.find(profile => profile.id === settings.visual_profile_id)
  if (profile) {
    settings.visual_template_kind = profile.kind
    settings.visual_template_reference_required = false
  }
  if ((node.type === 'image' || node.type === 'video') && (node.job_id || settings.generation_completed_job_id || settings.visual_completed_job_id)) {
    settings.modality ||= node.type
    node.type = 'generation'
  }
  if (node.type === 'project_script_ref') { node.type = 'text'; delete settings.role }
  node.job_id = null
  node.shot_id = null
  if (node.type === 'generation' || node.type === 'text') node.asset_id = null
  if (node.type === 'image_analysis' || node.type === 'video_analysis') node.text = ''
  delete settings.visual_profile_id
  delete settings.visual_profile_revision
  delete settings.visual_dependencies
  delete settings.visual_completed_job_id
  delete settings.generation_completed_job_id
  delete settings.storyboard_revision
  delete settings.image_video_handoff
  delete settings.video_analysis_result
  delete settings.group_id
  delete settings.group_title
  return node
}

function fixedInput(asset: Asset, target: CanvasNode, source?: CanvasNode): CanvasNode {
  return { id: `input:${asset.id}`, type: asset.kind === 'video' ? 'video' : 'image',
    x: source?.x ?? target.x - 380, y: source?.y ?? target.y,
    width: 300, height: 240, title: source?.title || asset.filename || '参考素材',
    text: '', prompt: '', asset_id: asset.id, shot_id: null, model_id: null, job_id: null, settings: {} }
}

/** Snapshot inputs as fixed resources, so their old producers cannot update the pasted node. */
export function createCanvasNodeClipboard(input: {
  projectId: string
  canvasId: string
  graph: CanvasGraph
  nodeIds: string[]
  detail: ClipboardDetail
  referenceAssetIds?: Record<string, string[]>
}): CanvasNodeClipboard {
  const selected = input.graph.nodes.filter(node => input.nodeIds.includes(node.id) && node.type !== 'project_script_ref')
  if (!selected.length) throw new Error('请先选择要复制的节点')
  const nodes = selected.map(node => independentNode(node, input.detail))
  const edges: CanvasGraph['edges'] = []
  const assetInputs = new Map<string, CanvasNode>()
  const textInputs = new Map<string, CanvasNode>()
  const localIds = new Set(nodes.map(node => node.id))
  function localId(prefix: string) {
    let counter = localIds.size
    while (localIds.has(`${prefix}:${counter}`)) counter++
    const result = `${prefix}:${counter}`
    localIds.add(result)
    return result
  }
  const assets = new Map(input.detail.assets.filter(asset => !asset.project_id || asset.project_id === input.projectId).map(asset => [asset.id, asset]))
  for (const target of selected) {
    const incoming = input.graph.edges.filter(edge => edge.target === target.id)
    const mediaIds: string[] = []
    for (const edge of incoming) {
      const source = input.graph.nodes.find(node => node.id === edge.source)
      if (!source || source.id === target.id) continue
      const assetId = edge.reference_asset_id || visualNodeAsset(source, input.detail, true)?.id
      if (assetId && assets.get(assetId)?.kind !== 'text') { mediaIds.push(assetId); continue }
      if (source.type !== 'text' && source.type !== 'project_script_ref' && source.type !== 'image_analysis' && source.type !== 'video_analysis') continue
      // Analysis results are prose inputs here, rather than fresh analysis jobs.
      let fixed = nodes.find(node => node.id === source.id && node.type === 'text') || textInputs.get(source.id)
      if (!fixed) {
        fixed = { ...independentNode(source), id: localId('text-input'), type: 'text', asset_id: null, model_id: null, text: source.text,
          settings: source.type === 'text' ? independentNode(source).settings : { text_mode: 'write' } }
        textInputs.set(source.id, fixed)
      }
      edges.push({ id: `text:${edges.length}`, source: fixed.id, target: target.id })
    }
    const requested = input.referenceAssetIds?.[target.id]
    const referenceIds = [...(requested || []), ...resolvePromptReferences({ prompt: '', referenceAssetIds: mediaIds,
      overrides: target.settings.prompt_reference_overrides }).referenceAssetIds]
    for (const assetId of [...new Set(referenceIds)]) {
      const asset = assets.get(assetId)
      if (!asset || !['image', 'video'].includes(asset.kind)) throw new Error('引用素材已失效，请重新选择后复制')
      let source = assetInputs.get(asset.id)
      if (!source) {
        const original = incoming.map(edge => input.graph.nodes.find(node => node.id === edge.source))
          .find(node => node && (node.asset_id === asset.id || visualNodeAsset(node, input.detail, true)?.id === asset.id))
        source = fixedInput(asset, target, original)
        source.id = localId('asset-input')
        assetInputs.set(asset.id, source)
      }
      edges.push({ id: `asset:${edges.length}`, source: source.id, target: target.id,
        ...(asset.kind === 'image' ? { reference_asset_id: asset.id } : {}) })
    }
  }
  return { kind: 'video-studio/canvas-nodes', version: 1, projectId: input.projectId, canvasId: input.canvasId,
    nodeIds: selected.map(node => node.id), nodes: [...nodes, ...textInputs.values(), ...assetInputs.values()], edges }
}

export function serializeCanvasNodeClipboard(payload: CanvasNodeClipboard): string {
  return clipboardPrefix + JSON.stringify(payload)
}

const settingStrings: Record<string, number> = {
  image_analysis_instructions: 4000, video_analysis_instructions: 4000, profile_prompt_override: 80_000,
  prompt_body: 80_000, prompt_base: 80_000, prompt_template: 80_000, group_id: 100, group_title: 160,
  resolution: 100, clarity: 80, quality: 80, background: 80, ratio: 20, reference_video_url: 2048,
}
const nullableSettings = new Set(['group_id', 'group_title', 'resolution', 'clarity', 'quality', 'background', 'reference_video_url'])
const booleanSettings = new Set(['visual_dependencies', 'visual_template_reference_required', 'generate_audio', 'draft', 'prompt_override', 'prompt_is_final', 'prompt_document'])
const enumSettings: Record<string, readonly string[]> = {
  visual_template_kind: ['character', 'location', 'prop'], visual_reference_mode: ['profiles', 'keyframe', 'text_only'],
  role: ['script'], text_mode: ['choose', 'write', 'video'], modality: ['text', 'image', 'video'],
  mode: ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend'],
}
function validTextDocument(value: unknown, depth = 0): boolean {
  if (!record(value) || depth > 16 || !['doc', 'paragraph', 'text', 'hardBreak', 'blockquote', 'heading', 'bulletList', 'orderedList', 'listItem', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader'].includes(String(value.type))) return false
  if (value.text !== undefined && !text(value.text)) return false
  if (value.attrs !== undefined && !record(value.attrs)) return false
  if (value.content !== undefined && (!Array.isArray(value.content) || value.content.length > 10_000 || !value.content.every(child => validTextDocument(child, depth + 1)))) return false
  return value.marks === undefined || Array.isArray(value.marks) && value.marks.every(mark => record(mark) && ['bold', 'italic', 'strike'].includes(String(mark.type)) && (mark.attrs === undefined || record(mark.attrs)))
}
function validSettings(settings: unknown): settings is CanvasNode['settings'] {
  if (!record(settings)) return false
  return Object.entries(settings).every(([key, value]) => {
    if (Object.hasOwn(settingStrings, key)) return nullableSettings.has(key) && value === null || text(value, settingStrings[key])
    if (booleanSettings.has(key)) return typeof value === 'boolean'
    if (Object.hasOwn(enumSettings, key)) return typeof value === 'string' && enumSettings[key].includes(value)
    if (['visual_profile_id', 'visual_completed_job_id', 'generation_completed_job_id'].includes(key)) return id(value)
    if (['image_analysis_source_asset_id', 'storyboard_reference_asset_id'].includes(key)) return nullableId(value)
    if (['visual_profile_revision', 'storyboard_revision', 'video_analysis_start_ms', 'video_analysis_end_ms'].includes(key)) return key === 'video_analysis_end_ms' && value === null || finite(value, key === 'visual_profile_revision' ? 1 : 0, Number.MAX_SAFE_INTEGER) && Number.isInteger(value)
    if (key === 'duration') return finite(value, 1, 120) && Number.isInteger(value)
    if (key === 'candidate_count') return finite(value, 1, 4) && Number.isInteger(value)
    if (key === 'video_analysis_fps') return finite(value, 0.2, 5)
    if (key === 'prompt_sections') return isPromptSectionDocument(value) && value.blocks.length <= 1000 && value.blocks.every(block => id(block.id))
      && (['text', 'sourceText', 'pendingSourceText', 'mergeBaseText'] as const).every(field => value.blocks.reduce((length, block) => length + (block[field]?.length || 0), 0) <= 80_000)
    if (key === 'text_document') return value === null || record(value) && value.type === 'doc' && validTextDocument(value)
    if (key === 'excluded_visual_profile_ids') return Array.isArray(value) && value.length <= 50 && value.every(id)
    if (key === 'prompt_reference_overrides') return record(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([key, replacement]) => id(key) && nullableId(replacement))
    if (key === 'video_reference_usages') return Array.isArray(value) && value.length <= 100 && value.every(item => record(item) && id(item.asset_id) && videoReferenceUsages.includes(item.usage as typeof videoReferenceUsages[number]))
    // These are removed before serializing a snapshot; never trust task state from a clipboard.
    return false
  })
}
function validNode(value: unknown): value is CanvasNode {
  if (!record(value) || !id(value.id) || !['text', 'image', 'video', 'generation', 'image_analysis', 'video_analysis'].includes(String(value.type))) return false
  if (Object.keys(value).some(key => !['id', 'type', 'x', 'y', 'width', 'height', 'title', 'text', 'prompt', 'asset_id', 'shot_id', 'model_id', 'job_id', 'settings'].includes(key))) return false
  return finite(value.x, -1_000_000, 1_000_000) && finite(value.y, -1_000_000, 1_000_000)
    && finite(value.width, 1, 5000) && finite(value.height, 1, 5000)
    && text(value.title, 160) && text(value.text) && text(value.prompt)
    && nullableId(value.asset_id) && nullableId(value.shot_id) && nullableId(value.job_id) && nullableId(value.model_id)
    && validSettings(value.settings)
}

/** Unrelated text and incomplete/corrupt snapshots do not become canvas edits. */
export function parseCanvasNodeClipboard(value: string): CanvasNodeClipboard | null {
  if (!value.startsWith(clipboardPrefix) || value.length > 20_000_000) return null
  try {
    const payload: unknown = JSON.parse(value.slice(clipboardPrefix.length))
    if (!record(payload) || payload.kind !== 'video-studio/canvas-nodes' || payload.version !== 1 || !id(payload.projectId) || !id(payload.canvasId)
      || !Array.isArray(payload.nodes) || !payload.nodes.length || payload.nodes.length > 500 || !payload.nodes.every(validNode)
      || !Array.isArray(payload.nodeIds) || !payload.nodeIds.length || !payload.nodeIds.every(id)
      || !Array.isArray(payload.edges) || payload.edges.length > 1000
      || Object.keys(payload).some(key => !['kind', 'version', 'projectId', 'canvasId', 'nodeIds', 'nodes', 'edges'].includes(key))) return null
    const ids = new Set(payload.nodes.map(node => node.id))
    if (ids.size !== payload.nodes.length || new Set(payload.nodeIds).size !== payload.nodeIds.length || !payload.nodeIds.every(nodeId => ids.has(nodeId))) return null
    const edgeIds = new Set<string>()
    if (!payload.edges.every(edge => {
      if (!record(edge) || !id(edge.id) || edgeIds.has(edge.id) || !id(edge.source) || !id(edge.target)
        || edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target) || edge.reference_asset_id !== undefined && !id(edge.reference_asset_id)
        || Object.keys(edge).some(key => !['id', 'source', 'target', 'reference_asset_id'].includes(key))) return false
      edgeIds.add(edge.id); return true
    })) return null
    return payload as CanvasNodeClipboard
  } catch { return null }
}

export function pasteCanvasNodeClipboard(input: {
  projectId: string
  graph: CanvasGraph
  payload: CanvasNodeClipboard
  position?: { x: number; y: number }
  detail?: ClipboardDetail
  idFactory?: () => string
}): { graph: CanvasGraph; nodeIds: string[] } {
  if (input.payload.projectId !== input.projectId) throw new Error('暂只支持在同一项目的画布之间粘贴节点')
  const payload = parseCanvasNodeClipboard(serializeCanvasNodeClipboard(input.payload))
  if (!payload) throw new Error('节点剪贴板内容已损坏，请重新复制')
  if (input.graph.nodes.filter(node => node.type !== 'project_script_ref').length + payload.nodes.length > 500 || input.graph.edges.length + payload.edges.length > 1000) throw new Error('画布节点或连线已达到上限')
  if (input.detail) {
    const assets = new Set(input.detail.assets.filter(asset => !asset.project_id || asset.project_id === input.projectId).map(asset => asset.id))
    if (payload.nodes.some(node => [node.asset_id, node.settings.image_analysis_source_asset_id, node.settings.storyboard_reference_asset_id]
      .some(assetId => assetId && !assets.has(assetId))) || payload.edges.some(edge => edge.reference_asset_id && !assets.has(edge.reference_asset_id))) throw new Error('复制的引用素材已失效，请重新选择后复制')
  }
  const reserved = new Set([...input.graph.nodes, ...input.graph.edges].map(item => item.id))
  function freshId() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = input.idFactory?.() || crypto.randomUUID()
      if (id(candidate) && !reserved.has(candidate)) { reserved.add(candidate); return candidate }
    }
    throw new Error('无法创建唯一节点标识，请重试')
  }
  const replacements = new Map(payload.nodes.map(node => [node.id, freshId()]))
  const primary = payload.nodes.filter(node => payload.nodeIds.includes(node.id))
  const minX = Math.min(...payload.nodes.map(node => node.x)), minY = Math.min(...payload.nodes.map(node => node.y))
  const primaryX = Math.min(...primary.map(node => node.x)), primaryY = Math.min(...primary.map(node => node.y))
  const requested = input.position || { x: primaryX + 48, y: primaryY + 48 }
  const bounds = { x: requested.x + minX - primaryX, y: requested.y + minY - primaryY,
    width: Math.max(...payload.nodes.map(node => node.x + node.width)) - minX,
    height: Math.max(...payload.nodes.map(node => node.y + node.height)) - minY }
  const position = freeCanvasPosition(bounds, input.graph.nodes)
  const nodes = payload.nodes.map(source => ({ ...independentNode(source), id: replacements.get(source.id)!,
    x: source.x + position.x - minX, y: source.y + position.y - minY }))
  if (nodes.some(node => !finite(node.x, -1_000_000, 1_000_000) || !finite(node.y, -1_000_000, 1_000_000))) throw new Error('粘贴位置超出画布范围，请调整画布后重试')
  const edges = payload.edges.map(edge => ({ ...edge, id: freshId(), source: replacements.get(edge.source)!, target: replacements.get(edge.target)! }))
  return { graph: { ...input.graph, nodes: [...input.graph.nodes, ...nodes], edges: [...input.graph.edges, ...edges] },
    nodeIds: payload.nodeIds.map(nodeId => replacements.get(nodeId)!) }
}
