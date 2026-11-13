import type { Asset, Model, ProjectDetail } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { isAutomaticShotVideoPrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { supportsVideoMultiReference } from '@video-studio/shared/media/video-reference-config'
import { modelDefaultResolution } from './canvas-model-parameters'
import { preferredModel } from '../models/model-defaults'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import { canvasJobMatchesStoryboard, storyboardRevision } from './canvas-storyboard-revision'
import { applyImageVideoContext, imageVideoContentSignature, imageVideoSourceContext,
  type ImageVideoSourceContext, type ImageVideoSemanticPlan } from './canvas-image-video-context'
import { materializePromptReference } from './canvas-prompt-reference-graph'
import { allProjectShots } from './canvas-design-scope'
export { pinnedCanvasReference } from './canvas-reference-snapshot'

function imageAsset(source: CanvasNode, detail: ProjectDetail) {
  if (source.type !== 'image' && source.type !== 'generation'
    || source.type === 'generation' && source.settings.modality && source.settings.modality !== 'image') return undefined
  const job = detail.jobs.find(job => job.id === source.job_id && job.status === 'succeeded' && canvasJobMatchesStoryboard(source, job))
  const asset = detail.assets.find(asset => asset.id === (source.asset_id || job?.result_asset_id))
  return asset?.kind === 'image' ? asset : undefined
}

function videoModel(models: Model[], mode: string, selectedId?: string | null) {
  const compatible = models.filter(model => model.modality === 'video'
    && Array.isArray(model.settings.supported_modes) && model.settings.supported_modes.includes(mode))
  return compatible.find(model => model.id === selectedId) || preferredModel(compatible)
}

function multiReferenceModel(models: Model[], selectedId?: string | null) {
  const compatible = models.filter(model => model.modality === 'video' && supportsVideoMultiReference(model.settings))
  return compatible.find(model => model.id === selectedId) || preferredModel(compatible)
}

function sourceShotId(source: CanvasNode, asset: Asset, detail: ProjectDetail) {
  if (source.shot_id && asset.shot_id && source.shot_id !== asset.shot_id) {
    throw new Error('分镜节点与所选图片属于不同镜头，请重新选择对应的分镜图')
  }
  const shotId = source.shot_id || asset.shot_id || null
  return allProjectShots(detail).some(shot => shot.id === shotId) ? shotId : null
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

/** Track only creative inputs: moving a node or completing a job is not a manual rewrite. */
function videoContentSignature(graph: CanvasGraph, node: CanvasNode) {
  const settings = node.settings
  return imageVideoContentSignature({ prompt: node.prompt, text: node.text,
    settings: { mode: settings.mode, visual_reference_mode: settings.visual_reference_mode,
      storyboard_reference_asset_id: settings.storyboard_reference_asset_id,
      prompt_override: settings.prompt_override, prompt_is_final: settings.prompt_is_final,
      prompt_document: settings.prompt_document, prompt_sections: settings.prompt_sections,
      prompt_body: settings.prompt_body, prompt_base: settings.prompt_base, prompt_template: settings.prompt_template,
      prompt_reference_overrides: settings.prompt_reference_overrides,
      excluded_visual_profile_ids: settings.excluded_visual_profile_ids, video_reference_usages: settings.video_reference_usages },
    inputs: graph.edges.filter(edge => edge.target === node.id).map(edge => {
      const source = graph.nodes.find(item => item.id === edge.source)
      return { source: edge.source, asset: edge.reference_asset_id || source?.asset_id,
        text: source?.type === 'text' ? source.text : undefined }
    }),
  })
}

function automaticVideo(graph: CanvasGraph, node: CanvasNode, detail: ProjectDetail, sourceId: string) {
  if (detail.jobs.some(job => job.id === node.job_id && ['queued', 'running'].includes(job.status))) return false
  const metadata = node.settings.image_video_handoff
  if (metadata) return metadata.applied_signature === videoContentSignature(graph, node)
  const settings = node.settings
  if (settings.prompt_override || settings.prompt_is_final || settings.prompt_document || settings.prompt_sections
    || settings.prompt_body !== undefined || node.text.trim() || Object.keys(settings.prompt_reference_overrides || {}).length
    || settings.excluded_visual_profile_ids?.length || settings.video_reference_usages?.length) return false
  const shot = allProjectShots(detail).find(shot => shot.id === node.shot_id)
  if (node.prompt.trim() && (!shot || !isAutomaticShotVideoPrompt(node.prompt, shot))) return false
  return !graph.edges.some(edge => edge.target === node.id && edge.source !== sourceId)
}

function inheritImageContext(graph: CanvasGraph, node: CanvasNode, source: CanvasNode, asset: Asset,
  detail: ProjectDetail, models: Model[], context: ImageVideoSourceContext, semanticPlan?: ImageVideoSemanticPlan): CanvasGraph {
  let next = graph
  // All inherited images are visible fixed inputs. The composer and generation
  // endpoint therefore resolve the same explicit choices, including usage:none.
  const inheritedIds = context.customized && node.settings.mode === 'reference'
    ? context.referenceAssetIds.filter(id => id !== asset.id) : []
  if (inheritedIds.length > 100) throw new Error('承接的参考图片超过上限，请先减少图片节点的参考')
  for (const id of inheritedIds) next = materializePromptReference(next, node.id, id, detail)
  let baseline = node
  if (!context.customized && node.settings.image_video_handoff) {
    const { prompt_override, prompt_is_final, prompt_document, prompt_sections, prompt_body, prompt_base, prompt_template,
      prompt_reference_overrides, excluded_visual_profile_ids, ...settings } = node.settings
    const shot = allProjectShots(detail).find(shot => shot.id === node.shot_id)
    baseline = { ...node, text: '', prompt: shotVideoPrompt(shot || { prompt: source.prompt || asset.prompt || source.title }), settings }
  }
  const plan = semanticPlan || (!context.customized && context.audioPlan
    ? { audio_plan: context.audioPlan, motion_prompt: context.audioSource.shotPrompt } : undefined)
  const applied = applyImageVideoContext(baseline, context, detail, models, plan)
  const stamped: CanvasNode = { ...applied, settings: { ...applied.settings, image_video_handoff: {
    source_node_id: source.id, source_asset_id: asset.id, source_signature: context.signature,
    applied_signature: videoContentSignature(next, applied), inherited_reference_asset_ids: inheritedIds,
    ...(plan ? { semantic_plan: plan, semantic_source_signature: context.signature } : {}),
  } } }
  return { ...next, nodes: next.nodes.map(item => item.id === node.id ? stamped : item) }
}

/** Attach to an existing generator without losing its draft, geometry or history. */
export function connectImageVideoHandoff(graph: CanvasGraph, connection: NonNullable<ReturnType<typeof imageVideoConnection>>,
  detail: ProjectDetail, models: Model[], edgeId: string, semanticPlan?: ImageVideoSemanticPlan) {
  const { source, asset } = connection
  const target = graph.nodes.find(node => node.id === connection.target.id) || connection.target
  const sourceId = sourceShotId(source, asset, detail)
  if (target.shot_id && sourceId && target.shot_id !== sourceId) {
    throw new Error('视频节点与分镜图属于不同镜头，请连接对应镜头的视频节点')
  }
  const shotId = target.shot_id || sourceId
  const shot = allProjectShots(detail).find(shot => shot.id === shotId)
  const revision = storyboardRevision(shot?.storyboard_revision)
  const existing = graph.edges.find(edge => edge.source === source.id && edge.target === target.id)
  // Adding a second composition/reference is not a request to replace the
  // creative design inherited from the primary image.
  const supplementalReference = target.settings.mode === 'reference' && target.settings.image_video_handoff
    && target.settings.image_video_handoff.source_asset_id !== asset.id
  const automatic = !supplementalReference && automaticVideo(graph, target, detail, source.id)
  const context = automatic ? imageVideoSourceContext(graph, source, detail, models) : undefined
  const sourceChanged = !!context && (context.customized || !!target.settings.image_video_handoff)
    && target.settings.image_video_handoff?.source_signature !== context.signature
  if (existing?.reference_asset_id === asset.id && target.shot_id === shotId && target.settings.mode
    && storyboardRevision(target.settings.storyboard_revision) === revision
    && target.settings.mode !== 'text' && (target.settings.mode !== 'reference' || target.settings.storyboard_reference_asset_id)
    && (target.settings.mode !== 'first_frame' || !target.settings.storyboard_reference_asset_id || target.settings.storyboard_reference_asset_id === asset.id)
    && !sourceChanged && (!semanticPlan || target.settings.image_video_handoff?.semantic_source_signature === context?.signature)) return graph
  const automaticModel = !target.settings.mode || target.settings.mode === 'text'
    ? hasShotVisualBindings(detail, shotId) && multiReferenceModel(models, target.model_id) : undefined
  const mode = target.settings.mode && target.settings.mode !== 'text' ? target.settings.mode : automaticModel ? 'reference' : 'first_frame'
  const model = automaticModel || videoModel(models, mode, target.model_id)
  const hasDraft = !automatic
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
  const previousInherited = new Set(sourceChanged ? target.settings.image_video_handoff?.inherited_reference_asset_ids : [])
  const edges = graph.edges.filter(edge => {
    if (edge === existing) return true
    if (edge.target === target.id && edge.reference_asset_id && previousInherited.has(edge.reference_asset_id)) return false
    if (mode !== 'first_frame' || edge.target !== target.id) return true
    const input = graph.nodes.find(node => node.id === edge.source)
    return !(edge.reference_asset_id || input && (input.type === 'image' || input.type === 'generation'
      && (input.settings.modality === 'image' || imageAsset(input, detail))))
  }).map(edge => edge === existing ? { ...edge, reference_asset_id: asset.id } : edge)
  if (!existing) {
    if (edges.length >= 1000) throw new Error('画布连线已达到上限')
    edges.push({ id: edgeId, source: source.id, target: target.id, reference_asset_id: asset.id })
  }
  const next = { ...graph, nodes: graph.nodes.map(item => item.id === target.id ? node : item), edges }
  return context && ['first_frame', 'reference'].includes(mode)
    ? inheritImageContext(next, node, source, asset, detail, models, context, semanticPlan) : next
}

export function createImageVideoHandoff(graph: CanvasGraph, source: CanvasNode, detail: ProjectDetail, models: Model[], freshNode: CanvasNode, edgeId: string,
  mode: 'first_frame' | 'reference' = 'first_frame', semanticPlan?: ImageVideoSemanticPlan) {
  if (source.settings.visual_profile_id) throw new Error('设定信息图不能直接作为分镜首帧，请先生成分镜图')
  const asset = imageAsset(source, detail)
  if (!asset) throw new Error('请先生成或选择一张分镜图片')
  const shotId = sourceShotId(source, asset, detail)
  const context = imageVideoSourceContext(graph, source, detail, models)
  const candidates = graph.nodes.filter(node => node.type === 'generation' && node.settings.modality === 'video'
    && node.settings.mode === mode && node.shot_id === shotId
    && (node.settings.storyboard_reference_asset_id === asset.id || graph.edges.some(edge => edge.target === node.id
      && edge.reference_asset_id === asset.id && (node.settings.mode === 'first_frame' || edge.source === source.id))))
  // Prefer the newest matching version so a preserved older draft never wins
  // over the automatic video created from the latest image changes.
  const ordered = [...candidates].reverse()
  const matching = ordered.find(node => node.settings.image_video_handoff?.source_signature === context.signature)
  if (matching && (!semanticPlan || matching.settings.image_video_handoff?.semantic_source_signature === context.signature
    || !automaticVideo(graph, matching, detail, source.id))) return { graph, nodeId: matching.id, created: false, updated: false, preserved: false }
  const existing = ordered.find(node => automaticVideo(graph, node, detail, source.id))
  if (existing) {
    if (!semanticPlan && !context.customized && !existing.settings.image_video_handoff) {
      return { graph, nodeId: existing.id, created: false, updated: false, preserved: false }
    }
    const oldIds = new Set(existing.settings.image_video_handoff?.inherited_reference_asset_ids || [])
    const next = { ...graph, edges: graph.edges.filter(edge => edge.target !== existing.id
      || !edge.reference_asset_id || !oldIds.has(edge.reference_asset_id) || edge.reference_asset_id === asset.id) }
    const updated = inheritImageContext(next, existing, source, asset, detail, models, context, semanticPlan)
    return { graph: updated, nodeId: existing.id, created: false, updated: true, preserved: false }
  }
  // An unchanged legacy draft is still the requested video. Once the source
  // has creative changes, preserve that draft and create a new version.
  if (!semanticPlan && ordered.length && !context.customized && !ordered[0].settings.image_video_handoff) {
    return { graph, nodeId: ordered[0].id, created: false, updated: false, preserved: false }
  }
  const nodeLimit = graph.nodes.filter(node => node.type === 'project_script_ref').length === 1 ? 501 : 500
  if (graph.nodes.length >= nodeLimit || graph.edges.length >= 1000) throw new Error('画布节点或连线已达到上限')
  const shot = allProjectShots(detail).find(shot => shot.id === shotId)
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
  const next = { ...graph, nodes: [...graph.nodes, node], edges: [...graph.edges,
    { id: edgeId, source: source.id, target: node.id, reference_asset_id: asset.id }] }
  return { graph: inheritImageContext(next, node, source, asset, detail, models, context, semanticPlan), nodeId: node.id,
    created: true, updated: false, preserved: candidates.length > 0 }
}

/** An unfinished semantic migration is explicit, never interpreted as silence. */
export function pendingImageVideoHandoff(graph: CanvasGraph, node: CanvasNode, detail: ProjectDetail, models: Model[]) {
  const handoff = node.settings.image_video_handoff
  if (node.type !== 'generation' || !(node.settings.modality === 'video' || models.some(model => model.id === node.model_id && model.modality === 'video'))) return undefined
  const legacyEdge = !handoff ? graph.edges.find(edge => edge.target === node.id
    && (!edge.reference_asset_id || !node.settings.storyboard_reference_asset_id || edge.reference_asset_id === node.settings.storyboard_reference_asset_id)
    && graph.nodes.some(item => item.id === edge.source && !item.settings.visual_profile_id
      && (item.type === 'image' || item.type === 'generation' && item.settings.modality === 'image'))) : undefined
  const sourceId = handoff?.source_node_id || legacyEdge?.source
  if (!sourceId || !automaticVideo(graph, node, detail, sourceId)) return undefined
  const source = graph.nodes.find(item => item.id === sourceId)
  if (!source) throw new Error('视频的来源图片节点已移除，请重新承接分镜并检查动作与台词')
  if (!['first_frame', 'reference'].includes(node.settings.mode || '')) return undefined
  const asset = imageAsset(source, detail)
  const expectedAsset = handoff?.source_asset_id || legacyEdge?.reference_asset_id || node.settings.storyboard_reference_asset_id
  if (!asset || expectedAsset && asset.id !== expectedAsset) throw new Error('视频的来源图片已变化，请从当前分镜图重新承接动作与台词')
  const context = imageVideoSourceContext(graph, source, detail, models)
  if (handoff?.semantic_plan && handoff.semantic_source_signature === context.signature) return undefined
  return { source, asset, context }
}

/** Apply a reviewed snapshot only while the source and automatic target still match. */
export function resolveImageVideoHandoff(graph: CanvasGraph, nodeId: string, signature: string,
  plan: ImageVideoSemanticPlan, detail: ProjectDetail, models: Model[]): CanvasGraph {
  const node = graph.nodes.find(item => item.id === nodeId)
  const pending = node && pendingImageVideoHandoff(graph, node, detail, models)
  if (!node || !pending || pending.context.signature !== signature) return graph
  const inherited = new Set(node.settings.image_video_handoff?.inherited_reference_asset_ids || [])
  const next = { ...graph, edges: graph.edges.filter(edge => edge.target !== nodeId || !edge.reference_asset_id
    || !inherited.has(edge.reference_asset_id) || edge.reference_asset_id === pending.asset.id) }
  return inheritImageContext(next, node, pending.source, pending.asset, detail, models, pending.context, plan)
}

export function fixedReferenceAsset(graph: CanvasGraph, targetId: string, assets: Asset[]) {
  return graph.edges.filter(edge => edge.target === targetId && edge.reference_asset_id
    && graph.nodes.some(node => node.id === edge.source && node.type !== 'image_analysis'))
    .map(edge => ({ edge, asset: assets.find(asset => asset.id === edge.reference_asset_id) }))
}
