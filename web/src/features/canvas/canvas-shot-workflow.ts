import type { Asset, Model, ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { supportsVideoMultiReference } from '@video-studio/shared/media/video-reference-config'
import { modelDefaultResolution } from './canvas-model-parameters'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import { canvasJobMatchesStoryboard, storyboardRevision } from './canvas-storyboard-revision'

function imageAsset(source: CanvasNode, detail: ProjectDetail) {
  const job = detail.jobs.find(job => job.id === source.job_id && job.status === 'succeeded' && canvasJobMatchesStoryboard(source, job))
  const asset = detail.assets.find(asset => asset.id === (source.asset_id || job?.result_asset_id))
  return asset?.kind === 'image' ? asset : undefined
}

function videoModel(models: Model[], mode: string, selectedId?: string | null) {
  const compatible = models.filter(model => model.modality === 'video'
    && Array.isArray(model.settings.supported_modes) && model.settings.supported_modes.includes(mode))
  return compatible.find(model => model.id === selectedId) || compatible[0]
}

function multiReferenceModel(models: Model[], selectedId?: string | null) {
  const compatible = models.filter(model => model.modality === 'video' && supportsVideoMultiReference(model.settings))
  return compatible.find(model => model.id === selectedId) || compatible[0]
}

function sourceShotId(source: CanvasNode, asset: Asset) {
  if (source.shot_id && asset.shot_id && source.shot_id !== asset.shot_id) {
    throw new Error('分镜节点与所选图片属于不同镜头，请重新选择对应的分镜图')
  }
  return source.shot_id || asset.shot_id || null
}

function hasShotVisualBindings(detail: ProjectDetail, shotId: string | null) {
  return !!shotId && !!detail.shot_visual_bindings?.some(binding => binding.shot_id === shotId && visualBindingApplies(binding, 'video'))
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
  const { source, asset } = connection
  const target = graph.nodes.find(node => node.id === connection.target.id) || connection.target
  const sourceId = sourceShotId(source, asset)
  if (target.shot_id && sourceId && target.shot_id !== sourceId) {
    throw new Error('视频节点与分镜图属于不同镜头，请连接对应镜头的视频节点')
  }
  const shotId = target.shot_id || sourceId
  const shot = detail.shots.find(shot => shot.id === shotId)
  const revision = storyboardRevision(shot?.storyboard_revision)
  const existing = graph.edges.find(edge => edge.source === source.id && edge.target === target.id)
  if (existing?.reference_asset_id === asset.id && target.shot_id === shotId && target.settings.mode
    && storyboardRevision(target.settings.storyboard_revision) === revision
    && target.settings.mode !== 'text' && (target.settings.mode !== 'reference' || target.settings.storyboard_reference_asset_id)
    && (target.settings.mode !== 'first_frame' || !target.settings.storyboard_reference_asset_id || target.settings.storyboard_reference_asset_id === asset.id)) return graph
  const automaticModel = !target.settings.mode || target.settings.mode === 'text'
    ? hasShotVisualBindings(detail, shotId) && multiReferenceModel(models, target.model_id) : undefined
  const mode = target.settings.mode && target.settings.mode !== 'text' ? target.settings.mode : automaticModel ? 'reference' : 'first_frame'
  const model = automaticModel || videoModel(models, mode, target.model_id)
  const hasDraft = target.settings.prompt_override || target.settings.prompt_is_final || target.text.trim() || target.prompt.trim()
  const resolutions = videoResolutionOptions(model?.settings)
  const node: CanvasNode = { ...target, shot_id: shotId, model_id: model?.id || null,
    prompt: hasDraft ? target.prompt : shotVideoPrompt(shot || { prompt: source.prompt || asset.prompt || source.title }),
    settings: { ...target.settings, modality: 'video', mode, storyboard_revision: revision,
      ...(['first_frame', 'first_last_frame'].includes(mode) ? { visual_reference_mode: 'keyframe' as const } : {}),
      ...(mode === 'first_frame' && target.settings.storyboard_reference_asset_id
        ? { storyboard_reference_asset_id: asset.id } : {}),
      ...(mode === 'reference' ? {
        visual_reference_mode: automaticModel ? 'profiles' as const : target.settings.visual_reference_mode || 'profiles' as const,
        storyboard_reference_asset_id: target.settings.storyboard_reference_asset_id || asset.id,
      } : {}),
      duration: target.settings.duration ?? videoDuration(model, shot?.duration || source.settings.duration || 5),
      ratio: target.settings.ratio || 'adaptive',
      resolution: target.settings.resolution
        ? resolutions.find(value => value.toLowerCase() === target.settings.resolution?.toLowerCase()) || target.settings.resolution
        : model ? modelDefaultResolution(model, resolutions) || null : '480p',
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

export function createImageVideoHandoff(graph: CanvasGraph, source: CanvasNode, detail: ProjectDetail, models: Model[], freshNode: CanvasNode, edgeId: string,
  mode: 'first_frame' | 'reference' = 'first_frame') {
  if (source.settings.visual_profile_id) throw new Error('设定信息图不能直接作为分镜首帧，请先生成分镜图')
  const asset = imageAsset(source, detail)
  if (!asset) throw new Error('请先生成或选择一张分镜图片')
  const shotId = sourceShotId(source, asset)
  const existing = graph.nodes.find(node => node.type === 'generation' && node.settings.modality === 'video'
    && node.settings.mode === mode && node.shot_id === shotId
    && (node.settings.storyboard_reference_asset_id === asset.id || graph.edges.some(edge => edge.target === node.id
      && edge.reference_asset_id === asset.id && (node.settings.mode === 'first_frame' || edge.source === source.id))))
  if (existing) return { graph, nodeId: existing.id, created: false }
  const nodeLimit = graph.nodes.filter(node => node.type === 'project_script_ref').length === 1 ? 501 : 500
  if (graph.nodes.length >= nodeLimit || graph.edges.length >= 1000) throw new Error('画布节点或连线已达到上限')
  const shot = detail.shots.find(shot => shot.id === shotId)
  const referenceModel = mode === 'reference' ? multiReferenceModel(models, freshNode.model_id) : undefined
  if (mode === 'reference' && !referenceModel) throw new Error('没有支持多图参考的可用视频模型，请先配置模型')
  const model = referenceModel || videoModel(models, 'first_frame', freshNode.model_id)
  const duration = videoDuration(model, shot?.duration || source.settings.duration || 5)
  const prompt = shotVideoPrompt(shot || { prompt: source.prompt || asset.prompt || source.title })
  const node: CanvasNode = { ...freshNode, type: 'generation', shot_id: shotId, model_id: model?.id || null,
    title: `${shot?.title || source.title || asset.filename} · 视频`, prompt, text: '', asset_id: null, job_id: null,
    settings: { modality: 'video', mode, visual_reference_mode: referenceModel ? 'profiles' : 'keyframe', candidate_count: 1,
      storyboard_revision: storyboardRevision(shot?.storyboard_revision),
      storyboard_reference_asset_id: asset.id,
      duration,
      ratio: 'adaptive', resolution: model ? modelDefaultResolution(model, videoResolutionOptions(model.settings)) || null : '480p' } }
  return { graph: { ...graph, nodes: [...graph.nodes, node], edges: [...graph.edges,
    { id: edgeId, source: source.id, target: node.id, reference_asset_id: asset.id }] }, nodeId: node.id, created: true }
}

export function fixedReferenceAsset(graph: CanvasGraph, targetId: string, assets: Asset[]) {
  return graph.edges.filter(edge => edge.target === targetId && edge.reference_asset_id)
    .map(edge => ({ edge, asset: assets.find(asset => asset.id === edge.reference_asset_id) }))
}
