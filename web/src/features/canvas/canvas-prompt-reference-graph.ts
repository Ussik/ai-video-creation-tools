import type { Asset, Model, ProjectDetail, ShotVisualBinding } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { videoReferenceManifest, visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import { visualReferencePurposeLabels, visualReferenceViewLabels } from '@video-studio/shared/visuals/visual-reference-types'
import { resolvePromptReferences, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { pinnedCanvasReference } from './canvas-reference-snapshot'
import { visualNodeAsset } from './canvas-visual-profiles'
import { visualProfileBaseReadiness } from '../visuals/visual-profile-inheritance'
import { promptReferenceBindings } from './canvas-prompt-references'
import { resolveCanvasVisualBoardReferences } from './canvas-visual-board-references'
import { rewriteCanvasPromptSections } from './canvas-prompt-composition'
import { allProjectShots } from './canvas-design-scope'

export type PromptReferenceSource = {
  assetId: string
  nodeId?: string
  label: string
  description: string
  provenance: 'connection' | 'binding' | 'base' | 'explicit'
  required: boolean
}

export type PromptReferenceGraphOptions = {
  sourceNodeId?: string
  idFactory?: (kind: 'node' | 'edge') => string
}

function projectImage(detail: ProjectDetail, assetId: string): Asset | undefined {
  return detail.assets.find(asset => asset.id === assetId && asset.kind === 'image'
    && (!asset.project_id || !detail.id || asset.project_id === detail.id))
}

function modality(node: CanvasNode) {
  return node.settings.modality || (node.type === 'image' ? 'image' : node.type === 'video' ? 'video' : undefined)
}

function activeBindings(target: CanvasNode, detail: ProjectDetail) {
  return (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === target.shot_id
    && visualBindingApplies(binding, modality(target))
    && (binding.required || !target.settings.excluded_visual_profile_ids?.includes(binding.profile_id)))
}

/** A pin always takes precedence over a profile's newer board or shot snapshots. */
function edgeAssetIds(graph: CanvasGraph, edge: CanvasGraph['edges'][number], target: CanvasNode, detail: ProjectDetail): string[] {
  const source = graph.nodes.find(node => node.id === edge.source)
  if (!source || source.id === target.id || source.type === 'image_analysis' || source.type === 'video_analysis') return []
  if (edge.reference_asset_id) return [edge.reference_asset_id]
  const binding = (target.settings.visual_reference_mode || 'profiles') === 'profiles' && source.settings.visual_profile_id
    ? activeBindings(target, detail).find(binding => binding.profile_id === source.settings.visual_profile_id) : undefined
  const ids = binding ? visualBindingReferenceAssetIds(binding)
    : [visualNodeAsset(pinnedCanvasReference(source), detail, true)?.id].filter((id): id is string => !!id)
  return [...new Set(ids)]
}

function reusableSource(node: CanvasNode, targetId: string, assetId: string, detail: ProjectDetail) {
  if (node.id === targetId || !['image', 'generation'].includes(node.type)) return false
  if (node.type === 'generation' && node.settings.modality && node.settings.modality !== 'image') return false
  if (node.settings.visual_profile_id) {
    const profile = detail.visual_profiles?.find(profile => profile.id === node.settings.visual_profile_id)
    return !!profile && (profile.board_asset_id === assetId
      || !!profile.reference_assets?.some(reference => reference.asset_id === assetId && reference.status === 'confirmed'))
  }
  return visualNodeAsset(node, detail, true)?.id === assetId
}

function freshId(graph: CanvasGraph, kind: 'node' | 'edge', options: PromptReferenceGraphOptions) {
  const existing = new Set([...graph.nodes, ...graph.edges].map(item => item.id))
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = options.idFactory?.(kind) || crypto.randomUUID()
    if (id && !existing.has(id)) return id
  }
  throw new Error('无法创建唯一的参考节点或连线标识，请重试')
}

function assertCapacity(graph: CanvasGraph, nodes: number, edges: number) {
  // The shared screenplay node is system-owned and does not consume a user slot.
  if (graph.nodes.filter(node => node.type !== 'project_script_ref').length + nodes > 500 || graph.edges.length + edges > 1000) {
    throw new Error('画布节点或连线已达到上限')
  }
}

/** Add a visible connection for an explicit @ choice, pinning the chosen image. */
export function materializePromptReference(graph: CanvasGraph, targetId: string, assetId: string, detail: ProjectDetail,
  options: PromptReferenceGraphOptions = {}): CanvasGraph {
  const target = graph.nodes.find(node => node.id === targetId)
  if (!target) throw new Error('当前节点不存在，请重新选择')
  const asset = projectImage(detail, assetId)
  if (!asset) throw new Error('引用图片不存在或不属于当前项目')
  const existing = graph.edges.find(edge => edge.target === targetId && edge.source !== targetId && edge.reference_asset_id === assetId
    && graph.nodes.some(node => node.id === edge.source))
  if (existing) return graph
  const preferred = graph.nodes.find(node => node.id === options.sourceNodeId && reusableSource(node, targetId, assetId, detail))
  const source = preferred || graph.nodes.find(node => reusableSource(node, targetId, assetId, detail))
  const unpinned = source && graph.edges.find(edge => edge.source === source.id && edge.target === targetId && !edge.reference_asset_id
    && edgeAssetIds(graph, edge, target, detail).length === 1 && edgeAssetIds(graph, edge, target, detail)[0] === assetId)
  if (unpinned) return { ...graph, edges: graph.edges.map(edge => edge === unpinned ? { ...edge, reference_asset_id: assetId } : edge) }
  assertCapacity(graph, source ? 0 : 1, 1)
  let next = graph
  let sourceId = source?.id
  if (!sourceId) {
    sourceId = freshId(next, 'node', options)
    const node: CanvasNode = { id: sourceId, type: 'image', x: target.x - 380, y: target.y,
      width: 300, height: 240, title: asset.filename || '参考图片', text: '', prompt: '', asset_id: asset.id,
      shot_id: allProjectShots(detail).some(shot => shot.id === asset.shot_id) ? asset.shot_id : null,
      model_id: null, job_id: null, settings: {} }
    next = { ...next, nodes: [...next.nodes, node] }
  }
  const edge = { id: freshId(next, 'edge', options), source: sourceId, target: targetId, reference_asset_id: assetId }
  return { ...next, edges: [...next.edges, edge] }
}

/** Replace only this target's matching inputs, preserving every other snapshot. */
export function replaceConnectedPromptReference(graph: CanvasGraph, targetId: string, sourceAssetId: string,
  replacementAssetId: string | null, detail: ProjectDetail, options: PromptReferenceGraphOptions = {}): CanvasGraph {
  const target = graph.nodes.find(node => node.id === targetId)
  if (!target) throw new Error('当前节点不存在，请重新选择')
  if (replacementAssetId === sourceAssetId) return materializePromptReference(graph, targetId, sourceAssetId, detail, options)
  if (replacementAssetId && !projectImage(detail, replacementAssetId)) throw new Error('引用图片不存在或不属于当前项目')
  let matched = false
  let next = { ...graph, edges: [] as CanvasGraph['edges'] }
  for (const edge of graph.edges) {
    const ids = edge.target === targetId ? edgeAssetIds(graph, edge, target, detail) : []
    if (!ids.includes(sourceAssetId)) { next.edges.push(edge); continue }
    matched = true
    const remaining = ids.filter(id => id !== sourceAssetId)
    for (const [index, assetId] of remaining.entries()) {
      const fixed = { ...edge, id: index ? freshId({ ...graph, edges: [...graph.edges, ...next.edges] }, 'edge', options) : edge.id, reference_asset_id: assetId }
      next.edges.push(fixed)
    }
  }
  if (!matched) return replacementAssetId ? materializePromptReference(graph, targetId, replacementAssetId, detail, options) : graph
  assertCapacity(next, 0, 0)
  return replacementAssetId ? materializePromptReference(next, targetId, replacementAssetId, detail, options) : next
}

function referenceLabel(binding: Pick<ShotVisualBinding, 'name' | 'variant'>) {
  return [binding.name, binding.variant].filter(Boolean).join(' · ')
}

/** Metadata is derived from the final submitted IDs, never image positions. */
export function promptReferenceSources(graph: CanvasGraph, targetId: string, referenceAssetIds: string[], detail: ProjectDetail): PromptReferenceSource[] {
  const target = graph.nodes.find(node => node.id === targetId)
  if (!target) return []
  const sources = new Map<string, PromptReferenceSource>()
  const bindings = activeBindings(target, detail)
  for (const edge of graph.edges.filter(edge => edge.target === targetId)) {
    const source = graph.nodes.find(node => node.id === edge.source)
    if (!source) continue
    for (const assetId of edgeAssetIds(graph, edge, target, detail)) {
      sources.set(assetId, { assetId, nodeId: source.id, label: source.title || projectImage(detail, assetId)?.filename || '参考图片',
        description: edge.reference_asset_id ? '连线参考 · 已固定图片版本' : '连线参考', provenance: 'connection', required: false })
    }
  }
  if (!target.settings.visual_profile_id && (target.settings.visual_reference_mode || 'profiles') === 'profiles') {
    for (const binding of bindings) for (const assetId of visualBindingReferenceAssetIds(binding)) {
      const source = graph.nodes.find(node => node.id !== targetId && node.settings.visual_profile_id === binding.profile_id
        && node.settings.visual_profile_revision === binding.revision)
      const snapshot = binding.reference_assets?.find(reference => reference.asset_id === assetId)
      const description = snapshot ? [visualReferenceViewLabels[snapshot.view], visualReferencePurposeLabels[snapshot.purpose], snapshot.label].filter(Boolean).join(' · ')
        : '已绑定的设定图快照'
      const connected = sources.get(assetId)
      sources.set(assetId, { assetId, ...(connected?.nodeId || source?.id ? { nodeId: connected?.nodeId || source?.id } : {}),
        label: referenceLabel(binding), description: `镜头绑定 · ${description}`, provenance: 'binding', required: false })
    }
  }
  const profile = detail.visual_profiles?.find(profile => profile.id === target.settings.visual_profile_id)
  const base = profile?.base_profile_id ? detail.visual_profiles?.find(item => item.id === profile.base_profile_id) : undefined
  if (base?.board_asset_id) {
    const source = graph.nodes.find(node => node.id !== targetId && node.settings.visual_profile_id === base.id)
    sources.set(base.board_asset_id, { assetId: base.board_asset_id, ...(source ? { nodeId: source.id } : {}), label: referenceLabel(base),
      description: '基础设定 · 必须保留身份参考', provenance: 'base', required: true })
  }
  const overrides = target.settings.prompt_reference_overrides || {}
  const replacements = new Set<string>()
  for (const id of Object.keys(overrides)) {
    const seen = new Set<string>()
    let current: string | null = id
    while (current && Object.hasOwn(overrides, current) && !seen.has(current)) { seen.add(current); current = overrides[current] }
    if (current && !seen.has(current) && current !== id) replacements.add(current)
  }
  return [...new Set(referenceAssetIds)].flatMap(assetId => {
    const asset = projectImage(detail, assetId)
    if (!asset) return []
    let result = sources.get(assetId)
    if (replacements.has(assetId)) {
      const source = graph.nodes.find(node => reusableSource(node, targetId, assetId, detail))
      const nodeId = result?.nodeId || source?.id
      const sourceNode = graph.nodes.find(node => node.id === nodeId)
      result = { assetId, ...(nodeId ? { nodeId } : {}), label: sourceNode?.title || asset.filename,
        description: '本节点替换参考 · 已固定图片版本', provenance: result?.provenance || 'explicit', required: result?.required || false }
    }
    return [result || { assetId, label: asset.filename, description: '未连接的引用图片', provenance: 'explicit' as const, required: false }]
  })
}

/** Freeze old positional drafts before an edit changes an unselected node's
 * inputs. Ordinary prose and source prompts remain untouched. */
export function freezeLegacyPromptReferenceDrafts(graph: CanvasGraph, detail: ProjectDetail,
  models: Pick<Model, 'id' | 'modality'>[] = []): CanvasGraph {
  const legacyNumber = /(?:参考图\s*|图片\s*|图\s*)\d/
  const needsMigration = (node: CanvasNode) => node.type !== 'text' && node.type !== 'image_analysis' && node.type !== 'video_analysis' && [
    node.settings.prompt_is_final ? node.text : undefined,
    node.settings.prompt_body, node.settings.profile_prompt_override, node.settings.prompt_template,
    ...(node.settings.prompt_sections?.blocks || []).flatMap(block => [block.text, block.sourceText, block.pendingSourceText, block.mergeBaseText]),
  ].some(value => value && legacyNumber.test(value))
  if (!graph.nodes.some(needsMigration)) return graph
  const assets = new Map(detail.assets.map(asset => [asset.id, asset]))
  const modelModalities = new Map(models.map(model => [model.id, model.modality]))
  let changed = false
  const nodes = graph.nodes.map(node => {
    if (!needsMigration(node)) return node
    const profile = detail.visual_profiles?.find(profile => profile.id === node.settings.visual_profile_id)
    const boardReferences = profile ? resolveCanvasVisualBoardReferences(node, profile, graph, detail) : undefined
    // Unselected profile drafts must use the same backend order as their
    // composer and preview, including profiles before fixed image inputs.
    if (boardReferences?.error) return node
    const targetModality = node.settings.modality || modelModalities.get(node.model_id || '') || modality(node)
    const allBindings = (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === node.shot_id)
    const bindings = allBindings.filter(binding => visualBindingApplies(binding, targetModality))
    const mode = node.settings.mode || 'text', referenceMode = node.settings.visual_reference_mode || 'profiles'
    const incoming = graph.edges.filter(edge => edge.target === node.id).flatMap(edge => {
      const source = graph.nodes.find(source => source.id === edge.source)
      if (!source) return []
      const pinned = pinnedCanvasReference(source, edge.reference_asset_id)
      if (node.type !== 'generation' && pinned.type === 'generation') return []
      const binding = allBindings.find(binding => binding.profile_id === pinned.settings.visual_profile_id)
      return binding && !visualBindingApplies(binding, targetModality) ? [] : [pinned]
    })
    const connectedIds = [...new Set(incoming.flatMap(source => {
      const binding = referenceMode === 'profiles' && source.settings.visual_profile_id
        ? bindings.find(binding => binding.profile_id === source.settings.visual_profile_id) : undefined
      return binding ? visualBindingReferenceAssetIds(binding) : [visualNodeAsset(source, detail, true)?.id]
    }).filter((id): id is string => !!id && assets.get(id)?.kind === 'image'))]
    const inputIds = targetModality === 'video' && mode === 'first_frame' && node.settings.storyboard_reference_asset_id
      ? connectedIds.filter(id => id === node.settings.storyboard_reference_asset_id) : connectedIds
    const overrides = node.settings.prompt_reference_overrides || {}
    const orderedBindings = promptReferenceBindings([...bindings].sort((a, b) => {
      const left = `${a.kind}\0${a.name}\0${a.profile_id}`, right = `${b.kind}\0${b.name}\0${b.profile_id}`
      return left < right ? -1 : left > right ? 1 : 0
    }), overrides)
    const storyboard = node.settings.storyboard_reference_asset_id !== undefined ? node.settings.storyboard_reference_asset_id
      : targetModality === 'video' ? inputIds.find(id => assets.get(id)?.shot_id === node.shot_id) : undefined
    const ids = targetModality === 'video' ? videoReferenceManifest(inputIds, orderedBindings, {
      mode, visual_reference_mode: referenceMode, storyboard_reference_asset_id: storyboard && inputIds.includes(storyboard) ? storyboard : undefined,
      excluded_visual_profile_ids: node.settings.excluded_visual_profile_ids, video_reference_usages: node.settings.video_reference_usages,
    }).map(reference => reference.asset_id) : [...inputIds]
    if (targetModality !== 'video' && referenceMode === 'profiles') for (const binding of orderedBindings) {
      for (const id of visualBindingReferenceAssetIds(binding)) if (!ids.includes(id)) ids.push(id)
    }
    const base = profile ? visualProfileBaseReadiness(profile, detail).baseProfile : undefined
    if (base?.board_asset_id) {
      const index = ids.indexOf(base.board_asset_id)
      if (index >= 0) ids.splice(index, 1)
      ids.unshift(base.board_asset_id)
    }
    let finalIds: string[]
    try { finalIds = boardReferences?.assetIds || resolvePromptReferences({ prompt: '', referenceAssetIds: ids, overrides,
      requiredAssetIds: base?.board_asset_id ? [base.board_asset_id] : [] }).referenceAssetIds }
    catch { return node }
    const migrate = (value: string | undefined) => value === undefined ? value : tokenizePromptReferenceNumbers(value, finalIds)
    const text = node.settings.prompt_is_final ? migrate(node.text)! : node.text
    const template = migrate(node.settings.prompt_template)
    const profilePrompt = migrate(node.settings.profile_prompt_override)
    const body = migrate(node.settings.prompt_body)
    const sections = rewriteCanvasPromptSections(node.settings.prompt_sections, value => migrate(value)!)
    if (text === node.text && template === node.settings.prompt_template && profilePrompt === node.settings.profile_prompt_override && body === node.settings.prompt_body
      && JSON.stringify(sections) === JSON.stringify(node.settings.prompt_sections)) return node
    changed = true
    return { ...node, text, settings: { ...node.settings, prompt_sections: sections, prompt_body: body, prompt_template: template, profile_prompt_override: profilePrompt } }
  })
  return changed ? { ...graph, nodes } : graph
}
