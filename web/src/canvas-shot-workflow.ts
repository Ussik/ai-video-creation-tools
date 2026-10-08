import type { Asset, Model, ProjectDetail } from './api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { shotVideoPrompt } from '../../backend/src/shot-prompts'
import { modelDefaultResolution } from './canvas-model-parameters'

function imageAsset(source: CanvasNode, detail: ProjectDetail) {
  const job = detail.jobs.find(job => job.id === source.job_id && job.status === 'succeeded')
  const asset = detail.assets.find(asset => asset.id === (source.asset_id || job?.result_asset_id))
  return asset?.kind === 'image' ? asset : undefined
}

function videoModel(models: Model[], mode: string, selectedId?: string | null) {
  const compatible = models.filter(model => model.modality === 'video'
    && Array.isArray(model.settings.supported_modes) && model.settings.supported_modes.includes(mode))
  return compatible.find(model => model.id === selectedId) || compatible[0]
}

function videoDuration(model: Model | undefined, requested: number) {
  const configuredMin = model?.settings.min_duration, configuredMax = model?.settings.max_duration
  const min = typeof configuredMin === 'number' && Number.isFinite(configuredMin) ? Math.max(1, Math.min(120, Math.ceil(configuredMin))) : 1
  const max = typeof configuredMax === 'number' && Number.isFinite(configuredMax) ? Math.max(min, Math.min(120, Math.floor(configuredMax))) : 120
  return Math.max(min, Math.min(max, Math.round(requested)))
}

/** Interpret an image/video drag by media roles, including a reversed drag. */
export function imageVideoConnection(first: CanvasNode, second: CanvasNode, detail: ProjectDetail, models: Model[]) {
  const isVideo = (node: CanvasNode) => node.type === 'generation' && !node.settings.visual_profile_id
    && (node.settings.modality === 'video' || models.some(model => model.id === node.model_id && model.modality === 'video'))
  const source = isVideo(second) ? first : isVideo(first) ? second : undefined
  const target = source === first ? second : source === second ? first : undefined
  if (!source || !target || source.id === target.id || source.settings.visual_profile_id
    || !['image', 'generation'].includes(source.type)) return undefined
  const asset = imageAsset(source, detail)
  return asset ? { source, target, asset } : undefined
}

/** Attach to an existing generator without losing its draft, geometry or history. */
export function connectImageVideoHandoff(graph: CanvasGraph, connection: NonNullable<ReturnType<typeof imageVideoConnection>>,
  detail: ProjectDetail, models: Model[], edgeId: string) {
  const { source, target, asset } = connection
  const existing = graph.edges.find(edge => edge.source === source.id && edge.target === target.id)
  if (existing?.reference_asset_id === asset.id) return graph
  const mode = target.settings.mode && !['text', 'first_frame'].includes(target.settings.mode) ? target.settings.mode : 'first_frame'
  const model = videoModel(models, mode, target.model_id)
  const shotId = target.shot_id || source.shot_id || asset.shot_id || null
  const shot = detail.shots.find(shot => shot.id === shotId)
  const hasDraft = target.settings.prompt_override || target.settings.prompt_is_final || target.text.trim() || target.prompt.trim()
  const resolutions = Array.isArray(model?.settings.resolutions) ? model.settings.resolutions as string[] : ['480p', '720p', '1080p']
  const node: CanvasNode = { ...target, shot_id: shotId, model_id: model?.id || null,
    prompt: hasDraft ? target.prompt : shotVideoPrompt(shot || { prompt: source.prompt || asset.prompt || source.title }),
    settings: { ...target.settings, modality: 'video', mode,
      ...(['first_frame', 'first_last_frame'].includes(mode) ? { visual_reference_mode: 'keyframe' as const } : {}),
      duration: videoDuration(model, target.settings.duration || shot?.duration || source.settings.duration || 5),
      ratio: mode === 'first_frame' ? source.settings.ratio || detail.ratio : target.settings.ratio || detail.ratio,
      resolution: model && target.model_id === model.id && resolutions.includes(target.settings.resolution || '')
        ? target.settings.resolution : modelDefaultResolution(model, resolutions) || null,
    } }
  // A single-frame mode replaces the previous image input. Text inputs and
  // outgoing edges remain; multi-frame/reference modes retain image order.
  const edges = graph.edges.filter(edge => {
    if (edge === existing) return true
    if (mode !== 'first_frame' || edge.target !== target.id) return true
    const input = graph.nodes.find(node => node.id === edge.source)
    return !(edge.reference_asset_id || input && (input.type === 'image' || input.type === 'generation'
      && (input.settings.modality === 'image' || imageAsset(input, detail))))
  }).map(edge => edge === existing ? { ...edge, reference_asset_id: asset.id } : edge)
  if (!existing) {
    if (edges.length >= 1000) throw new Error('画布连线已达到上限')
    edges.push({ id: edgeId, source: source.id, target: target.id, reference_asset_id: asset.id })
  }
  return { ...graph, nodes: graph.nodes.map(item => item.id === target.id ? node : item), edges }
}

export function pinnedCanvasReference(source: CanvasNode, assetId?: string): CanvasNode {
  return assetId ? { ...source, asset_id: assetId, job_id: null, settings: { ...source.settings, visual_profile_id: undefined } } : source
}

export function createImageVideoHandoff(graph: CanvasGraph, source: CanvasNode, detail: ProjectDetail, models: Model[], freshNode: CanvasNode, edgeId: string) {
  if (source.settings.visual_profile_id) throw new Error('设定信息图不能直接作为分镜首帧，请先生成分镜图')
  const asset = imageAsset(source, detail)
  if (!asset) throw new Error('请先生成或选择一张分镜图片')
  const shotId = source.shot_id || asset.shot_id || null
  const existing = graph.edges.find(edge => edge.source === source.id && edge.reference_asset_id === asset.id
    && graph.nodes.some(node => node.id === edge.target && node.type === 'generation' && node.settings.modality === 'video'
      && node.settings.mode === 'first_frame' && node.shot_id === shotId))
  if (existing) return { graph, nodeId: existing.target, created: false }
  if (graph.nodes.length >= 500 || graph.edges.length >= 1000) throw new Error('画布节点或连线已达到上限')
  const shot = detail.shots.find(shot => shot.id === shotId)
  const model = videoModel(models, 'first_frame')
  const duration = videoDuration(model, shot?.duration || source.settings.duration || 5)
  const prompt = shotVideoPrompt(shot || { prompt: source.prompt || asset.prompt || source.title })
  const node: CanvasNode = { ...freshNode, type: 'generation', shot_id: shotId, model_id: model?.id || null,
    title: `${shot?.title || source.title || asset.filename} · 视频`, prompt, text: '', asset_id: null, job_id: null,
    settings: { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', candidate_count: 1,
      duration,
      ratio: source.settings.ratio || detail.ratio, resolution: modelDefaultResolution(model, Array.isArray(model?.settings.resolutions) ? model.settings.resolutions as string[] : []) || null } }
  return { graph: { ...graph, nodes: [...graph.nodes, node], edges: [...graph.edges,
    { id: edgeId, source: source.id, target: node.id, reference_asset_id: asset.id }] }, nodeId: node.id, created: true }
}

export function fixedReferenceAsset(graph: CanvasGraph, targetId: string, assets: Asset[]) {
  return graph.edges.filter(edge => edge.target === targetId && edge.reference_asset_id)
    .map(edge => ({ edge, asset: assets.find(asset => asset.id === edge.reference_asset_id) }))
}
