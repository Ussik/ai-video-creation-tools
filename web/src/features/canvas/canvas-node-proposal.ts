import { canvasNodeProposalEditableParameters, canvasNodeProposalFingerprint, canvasNodeProposalSourceKey,
  type CanvasNodeProposal, type CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { extractPromptBody, validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { extractPromptReferenceIds, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { findPromptParameterConflicts } from '@video-studio/shared/visuals/prompt-parameter-conflicts'
import { visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { visualBindingsForModality } from '@video-studio/shared/visuals/visual-binding-usage'
import { videoRatioOptions, videoResolutionOptions } from '@video-studio/shared/media/video-parameters'
import { videoReferenceConfigError } from '@video-studio/shared/media/video-reference-config'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import { videoReferenceUsages, type VideoReferenceUsage } from '@video-studio/shared/media/video-reference-usage'
import type { Model, ProjectDetail, Provider } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { imagePreferencePrompt, imageRatioError, usesModelParameter, videoParameterPolicy } from './canvas-model-parameters'
import { videoPreferencePrompt } from './canvas-prompt-draft'
import { promptReferenceBindings } from './canvas-prompt-references'

export type CanvasNodeProposalApplyResult = { nodeId: string; referenceNodeCount: number; alreadyApplied: boolean }
export type CanvasNodeProposalActions = { apply: (proposal: CanvasNodeProposal) => Promise<CanvasNodeProposalApplyResult> }

const parameterKeys = ['ratio', 'resolution', 'duration', 'generate_audio', 'draft', 'clarity', 'quality', 'background', 'candidate_count']
const stale = () => new Error('来源节点或项目配置已变化，请重新添加节点快照并生成调整方案')

export function assertCanvasNodeProposalValues(proposal: CanvasNodeProposal) {
  const source = proposal.source
  if (!proposal.id || !proposal.created_node_id || proposal.created_node_id === source.source_node_id) throw new Error('调整方案的草稿标识无效')
  if (canvasNodeProposalSourceKey(proposal.before) !== canvasNodeProposalSourceKey({ prompt: source.prompt, parameters: source.parameters })) throw new Error('调整方案的原始配置不匹配')
  if (!proposal.after.prompt.trim() || proposal.after.prompt.length > 80000) throw new Error('调整后的提示词为空或超过 80000 字符')
  validateManagedPromptDocument(proposal.after.prompt)
  if (Object.keys(proposal.after.parameters).some(key => !parameterKeys.includes(key))) throw new Error('调整方案包含未允许的生成参数')
  for (const key of parameterKeys) {
    if (!(key in proposal.after.parameters)) throw new Error('调整方案缺少完整生成参数')
    if (!canvasNodeProposalEditableParameters.includes(key as typeof canvasNodeProposalEditableParameters[number])
      && proposal.after.parameters[key as keyof typeof source.parameters] !== source.parameters[key as keyof typeof source.parameters]) throw new Error('调整方案修改了锁定的生成参数')
  }
  const ids = source.reference_assets.map(reference => reference.asset_id)
  const prompt = tokenizePromptReferenceNumbers(proposal.after.prompt, ids)
  if (extractPromptReferenceIds(prompt).some(id => !ids.includes(id))) throw new Error('调整方案不能添加或替换参考图片')
  const parameters = proposal.after.parameters
  if (source.modality === 'image' && parameters.resolution !== source.parameters.resolution) throw new Error('图片分辨率与清晰度保持来源值，请在新草稿中手动调整')
  if (typeof parameters.ratio !== 'string' || parameters.resolution !== null && typeof parameters.resolution !== 'string'
    || !Number.isInteger(parameters.duration) || parameters.duration < 1 || parameters.duration > 120
    || typeof parameters.generate_audio !== 'boolean') throw new Error('调整方案的生成参数无效')
}

/** Recheck local edits as well as saved revisions; this function never writes. */
export async function assertCanvasNodeProposalCurrent(graph: CanvasGraph, proposal: CanvasNodeProposal, detail: ProjectDetail, models: Model[], providers: Provider[]) {
  assertCanvasNodeProposalValues(proposal)
  const source = proposal.source
  const node = graph.nodes.find(node => node.id === source.source_node_id)
  if (source.project_id !== detail.id || source.project_updated_at !== detail.updated_at
    || source.project_style_version !== (detail.project_visual_style?.version || null)
    || source.canvas_revision !== graph.revision || !node || node.type !== 'generation' || node.settings.visual_profile_id
    || node.model_id !== source.model_id || node.shot_id !== source.shot_id) throw stale()
  if (await canvasNodeProposalFingerprint(graph, source.source_node_id) !== source.source_fingerprint) throw stale()
  if (source.shot_id) {
    const shot = [...detail.shots, ...(detail.historical_shots || [])].find(shot => shot.id === source.shot_id)
    if (!shot || (shot.storyboard_revision || 0) !== (source.storyboard_revision || 0)) throw stale()
  }
  const model = models.find(model => model.id === source.model_id && model.enabled && model.modality === source.modality
    && providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))
  if (!model) throw new Error('来源模型或服务商已不可用，请重新选择模型')
  for (const reference of source.reference_assets) if (!detail.assets.some(asset => asset.id === reference.asset_id && asset.kind === 'image'
    && asset.project_id === detail.id)) throw new Error('来源的固定参考图片已不可用，请重新选择')
  if (source.reference_video_asset_id && !detail.assets.some(asset => asset.id === source.reference_video_asset_id && asset.kind === 'video'
    && asset.project_id === detail.id)) throw new Error('来源的固定参考视频已不可用，请重新选择')
  const parameters = proposal.after.parameters
  const policy = videoParameterPolicy(model, source.mode, parameters.draft)
  const fixed = { ...((model.settings.mode_variables as Record<string, Record<string, unknown>> | undefined)?.[source.mode] || {}),
    ...(source.parameters.draft ? model.settings.draft_variables as Record<string, unknown> | undefined : {}) }
  for (const key of canvasNodeProposalEditableParameters) {
    if (parameters[key] === source.parameters[key]) continue
    if (source.modality === 'image' && key !== 'ratio') throw new Error('当前图片模型只允许调整明确支持的原生画幅')
    if (key === 'ratio' && (!Array.isArray(model.settings.ratios) || !model.settings.ratios.includes(parameters.ratio))
      || key === 'resolution' && (!Array.isArray(model.settings.resolutions) || !model.settings.resolutions.includes(parameters.resolution))
      || key === 'duration' && (!Number.isInteger(model.settings.min_duration) || !Number.isInteger(model.settings.max_duration))
      || key === 'resolution' && Object.hasOwn(fixed, 'size')) throw new Error(`当前模型没有明确开放 ${key} 的取值`)
    if (!usesModelParameter(model, key, source.mode) || Object.hasOwn(fixed, key)
      || key === 'ratio' && policy.ratioFollowsSource || key === 'duration' && policy.durationFollowsSource
      || key === 'resolution' && !!policy.draftResolution) throw new Error(`当前模型模式不允许调整 ${key}`)
  }
  const configuredMin = model.settings.min_duration, configuredMax = model.settings.max_duration
  const minimum = typeof configuredMin === 'number' ? Math.max(1, Math.min(120, Math.ceil(configuredMin))) : 1
  const maximum = typeof configuredMax === 'number' ? Math.max(minimum, Math.min(120, Math.floor(configuredMax))) : 120
  if (source.modality === 'video') {
    if (parameters.duration < minimum || parameters.duration > maximum) throw new Error('调整时长不受当前模型支持')
    if (!videoRatioOptions(model.settings).includes(parameters.ratio) || parameters.resolution && !videoResolutionOptions(model.settings).includes(parameters.resolution)) throw new Error('调整画幅或分辨率不受当前模型支持')
  } else {
    const issue = imageRatioError(model, parameters.resolution || '', parameters.ratio, source.mode)
    if (issue) throw new Error(issue)
  }
  const referenceIssue = source.modality === 'video' ? videoReferenceConfigError(model.settings, source.reference_assets.length, source.mode)
    : imageReferenceConfigError(model.settings, source.reference_assets.length, source.mode)
  if (referenceIssue) throw new Error(referenceIssue)
  const conflict = findPromptParameterConflicts(proposal.after.prompt, { ...parameters, modality: source.modality, mode: source.mode,
    ...(policy.durationFollowsSource ? { duration: null } : {}) })[0]
  if (conflict) throw new Error(conflict.message)
  return model
}

function draftTemplate(proposal: CanvasNodeProposal, detail: ProjectDetail, model: Model, body: string, ids: string[], usages: Array<{ asset_id: string; usage: VideoReferenceUsage }>) {
  const source = proposal.source, parameters = proposal.after.parameters
  const bindings = visualBindingsForModality((detail.shot_visual_bindings || []).filter(binding => binding.shot_id === source.shot_id), source.modality)
  const promptBindings = promptReferenceBindings([...bindings].sort((a, b) => {
    const left = `${a.kind}\0${a.name}\0${a.profile_id}`, right = `${b.kind}\0${b.name}\0${b.profile_id}`
    return left < right ? -1 : left > right ? 1 : 0
  }), {})
  const preference = source.modality === 'image' ? imagePreferencePrompt(model, body, parameters, source.mode)
    : videoPreferencePrompt(body, source.mode, parameters.duration, { ...parameters,
      resolution: parameters.resolution || undefined, durationFollowsSource: videoParameterPolicy(model, source.mode, parameters.draft).durationFollowsSource })
  return tokenizePromptReferenceNumbers(withProjectStyle(visualGenerationPrompt(preference, promptBindings, ids, 'text_only',
    source.modality === 'video' ? { mode: source.mode, storyboard_reference_asset_id: source.storyboard_reference_asset_id, video_reference_usages: usages } : {}), detail.project_visual_style), ids)
}

function shortTitle(value: string, suffix = ''): string {
  const budget = 160 - suffix.length
  let title = ''
  for (const character of value) {
    if (title.length + character.length > budget) break
    title += character
  }
  return title + suffix
}

/** Exactly one generator; missing fixed image inputs become ordinary image cards. */
export function addCanvasNodeProposalDraft(graph: CanvasGraph, proposal: CanvasNodeProposal, detail: ProjectDetail, model: Model) {
  assertCanvasNodeProposalValues(proposal)
  const existing = graph.nodes.find(node => node.id === proposal.created_node_id)
  if (existing) {
    if (existing.type !== 'generation') throw new Error('调整草稿标识已被其他节点使用')
    return { graph, node: existing, referenceNodeCount: 0, alreadyApplied: true }
  }
  const original = graph.nodes.find(node => node.id === proposal.source.source_node_id)
  if (!original || original.type !== 'generation' || original.settings.visual_profile_id) throw stale()
  const source = proposal.source, parameters = proposal.after.parameters
  const ids = source.reference_assets.map(reference => reference.asset_id)
  const prompt = tokenizePromptReferenceNumbers(proposal.after.prompt, ids)
  const body = extractPromptBody({ prompt })
  const usages = source.reference_assets.flatMap(reference => reference.usage && videoReferenceUsages.includes(reference.usage as VideoReferenceUsage)
    ? [{ asset_id: reference.asset_id, usage: reference.usage as VideoReferenceUsage }] : [])
  const template = draftTemplate(proposal, detail, model, body, ids, usages)
  const templateSections = parsePromptSectionDocument(template, { sourceText: template })
  const node: CanvasNode = { id: proposal.created_node_id, type: 'generation', x: original.x + original.width + 120, y: original.y,
    width: 440, height: 420, title: shortTitle(original.title || '生成节点', ' · 导演调整草稿'), text: prompt, prompt: body,
    asset_id: null, job_id: null, shot_id: source.shot_id, model_id: source.model_id,
    settings: { modality: source.modality, mode: source.mode, ...parameters, visual_reference_mode: 'text_only', visual_dependencies: false,
      storyboard_revision: source.storyboard_revision ?? undefined, storyboard_reference_asset_id: source.storyboard_reference_asset_id,
      video_reference_usages: source.modality === 'video' && source.mode === 'reference' ? usages : [],
      reference_video_url: source.reference_video_asset_id ? `asset://${source.reference_video_asset_id}` : null,
      prompt_override: true, prompt_is_final: true, prompt_document: true, prompt_base: body, prompt_body: body,
      prompt_template: template, prompt_sections: parsePromptSectionDocument(prompt, { sourceText: template, previousDocument: templateSections }) } }
  const nodes = [...graph.nodes, node], edges = [...graph.edges]
  const usedSources = new Set<string>()
  let referenceNodeCount = 0
  const reserved = new Set([...nodes, ...edges].map(item => item.id))
  ids.forEach((id, index) => {
    const asset = detail.assets.find(asset => asset.id === id && asset.kind === 'image' && asset.project_id === detail.id)
    if (!asset) throw new Error('固定参考图片已不可用')
    let input = graph.nodes.find(candidate => !usedSources.has(candidate.id) && candidate.id !== node.id && candidate.asset_id === id
      && (candidate.type === 'image' || candidate.type === 'generation' && !candidate.settings.visual_profile_id && candidate.settings.modality === 'image'))
    if (!input) {
      const id = `${node.id}-ref-${index}`
      if (reserved.has(id)) throw new Error('调整草稿的参考节点标识已被使用')
      reserved.add(id)
      input = { id, type: 'image', x: node.x - 380, y: node.y + index * 300, width: 300, height: 240,
        title: shortTitle(asset.filename), text: '', prompt: '', asset_id: asset.id, shot_id: null, model_id: null, job_id: null, settings: {} }
      nodes.push(input); referenceNodeCount++
    }
    usedSources.add(input.id)
    const edgeId = `${node.id}-ref-edge-${index}`
    if (reserved.has(edgeId)) throw new Error('调整草稿的参考连线标识已被使用')
    reserved.add(edgeId)
    edges.push({ id: edgeId, source: input.id, target: node.id, reference_asset_id: asset.id })
  })
  if (nodes.filter(node => node.type !== 'project_script_ref').length > 500 || edges.length > 1000) throw new Error('画布节点或连线已达到上限')
  return { graph: { ...graph, nodes, edges }, node, referenceNodeCount, alreadyApplied: false }
}

export function canvasNodeProposalSourceMatches(source: CanvasNodeProposalSource, projectId: string, canvasId: string) {
  return source.project_id === projectId && source.canvas_id === canvasId
}
