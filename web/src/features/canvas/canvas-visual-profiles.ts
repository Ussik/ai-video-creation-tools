import type { Asset, Job, Model, ProjectDetail, VisualProfile } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import { visualProfileBaseChain, visualProfileBoardReady } from '../visuals/visual-profile-inheritance'

export function requestVisualCanvas(projectId: string, profileIds: string[], context?: { shotId?: string }) {
  window.sessionStorage.setItem(`visual-canvas-open:${projectId}`, JSON.stringify(context ? { profileIds, ...context } : profileIds))
  window.dispatchEvent(new Event('visual-canvas-open'))
}

export function visualJobRequest(job?: Job): Record<string, unknown> {
  try { return JSON.parse(job?.request || '{}') as Record<string, unknown> } catch { return {} }
}

export function visualBoardJobs(profile: VisualProfile, jobs: Job[]): Job[] {
  return jobs.filter(job => {
    const request = visualJobRequest(job)
    if (request.visual_reference_view) return false
    return request.visual_profile_id === profile.id && request.visual_profile_revision === profile.revision ||
      !!profile.asset_task_id && request.asset_task_id === profile.asset_task_id
  }).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function visualCandidateAssets(profile: VisualProfile, detail: ProjectDetail, displayedAssetId?: string | null): Asset[] {
  const jobs = detail.jobs.filter(job => {
    const request = visualJobRequest(job)
    if (request.visual_reference_view) return false
    return job.status === 'succeeded' && (request.visual_profile_id === profile.id || !!profile.asset_task_id && request.asset_task_id === profile.asset_task_id)
  })
  const ids = new Set([...jobs.map(job => job.result_asset_id), ...(profile.candidate_asset_ids || []), profile.board_asset_id, displayedAssetId])
  return detail.assets.filter(asset => asset.kind === 'image' && ids.has(asset.id)).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function visualNodeAsset(node: CanvasNode, detail: Pick<ProjectDetail, 'assets' | 'visual_profiles'>, reference = false): Asset | undefined {
  // An analysis card outputs text. Its preview image is input to the analysis,
  // and must not become an implicit reference of a downstream generator.
  if (node.type === 'video_analysis' || reference && node.type === 'image_analysis') return undefined
  const profile = detail.visual_profiles?.find(item => item.id === node.settings.visual_profile_id)
  const id = profile ? reference ? profile.board_asset_id : node.asset_id || profile.board_asset_id
    : node.settings.visual_profile_id ? null : node.asset_id
  return detail.assets.find(asset => asset.id === id)
}

/** Only explicit inheritance creates this execution dependency. Ordinary
 * reference lines remain reference inputs, even when they join two profiles. */
export function visualProfileDependencyEdges(graph: CanvasGraph, detail: Pick<ProjectDetail, 'visual_profiles' | 'assets' | 'project_visual_style'>): CanvasGraph['edges'] {
  const edges: CanvasGraph['edges'] = []
  for (const target of graph.nodes) {
    const profile = detail.visual_profiles?.find(item => item.id === target.settings.visual_profile_id)
    if (!profile?.base_profile_id || visualProfileBaseChain(profile, detail.visual_profiles || []).error) continue
    const base = detail.visual_profiles?.find(item => item.id === profile.base_profile_id)
    const source = graph.nodes.find(node => node.id !== target.id && node.settings.visual_profile_id === base?.id)
    if (!source || !base || graph.edges.some(edge => edge.source === source.id && edge.target === target.id)) continue
    edges.push({ id: `auto-visual-base:${JSON.stringify([target.id, base.id])}`, source: source.id, target: target.id,
      ...(visualProfileBoardReady(base, detail) ? { reference_asset_id: base.board_asset_id! } : {}) })
  }
  return edges
}

/** Show backend-resolved shot references without turning them into manual inputs.
 * Bindings retain their own board snapshot, which may differ from today's profile.
 */
export function automaticVisualReferenceEdges(graph: CanvasGraph, detail: ProjectDetail, models: Pick<Model, 'id' | 'modality'>[] = []): CanvasGraph['edges'] {
  const modality = (node: CanvasNode) => models.find(model => model.id === node.model_id)?.modality || node.settings.modality
  const sources = graph.nodes.filter(node => node.type === 'image' || node.type === 'generation' && modality(node) === 'image')
    .map(node => ({ node, assetId: visualNodeAsset(node, detail, true)?.id }))
    .filter(source => source.assetId && detail.assets.some(asset => asset.id === source.assetId && asset.kind === 'image'))
  const edges: CanvasGraph['edges'] = visualProfileDependencyEdges(graph, detail)
  for (const target of graph.nodes) {
    if (target.type !== 'generation' || !target.shot_id || target.settings.visual_profile_id ||
      (target.settings.visual_reference_mode || 'profiles') !== 'profiles') continue
    const targetModality = modality(target)
    if (targetModality !== 'image' && !(targetModality === 'video' && target.settings.mode === 'reference')) continue
    const replacements = target.settings.prompt_reference_overrides || {}
    const effectiveAsset = (assetId: string): string | null => {
      let current: string | null = assetId
      const visited = new Set<string>()
      while (current && Object.hasOwn(replacements, current) && replacements[current] !== current) {
        if (visited.has(current)) return null
        visited.add(current)
        current = replacements[current]!
      }
      return current
    }
    const usedAssets = new Set(graph.edges.filter(edge => edge.target === target.id).flatMap(edge => {
      if (edge.reference_asset_id) return [edge.reference_asset_id]
      const source = graph.nodes.find(node => node.id === edge.source)
      const binding = detail.shot_visual_bindings?.find(item => item.shot_id === target.shot_id
        && item.profile_id === source?.settings.visual_profile_id && visualBindingApplies(item, targetModality))
      return binding ? visualBindingReferenceAssetIds(binding) : sources.find(item => item.node.id === edge.source)?.assetId || []
    }).flatMap(assetId => effectiveAsset(assetId) || []))
    for (const binding of detail.shot_visual_bindings || []) {
      if (!visualBindingApplies(binding, targetModality)) continue
      if (!binding.required && target.settings.excluded_visual_profile_ids?.includes(binding.profile_id)) continue
      const assetIds = visualBindingReferenceAssetIds(binding)
      if (binding.shot_id === target.shot_id && !assetIds.length && binding.required && target.settings.visual_dependencies) {
        const source = graph.nodes.find(node => node.id !== target.id && node.settings.visual_profile_id === binding.profile_id
          && node.settings.visual_profile_revision === binding.revision && !graph.edges.some(edge => edge.source === node.id && edge.target === target.id))
        if (source) edges.push({ id: `auto-visual-dependency:${JSON.stringify([target.id, binding.profile_id])}`, source: source.id, target: target.id })
        continue
      }
      if (binding.shot_id !== target.shot_id) continue
      for (const originalAssetId of assetIds) {
        const assetId = effectiveAsset(originalAssetId)
        if (!assetId) continue
        if (usedAssets.has(assetId) || !detail.assets.some(asset => asset.id === assetId && asset.kind === 'image')) continue
        const candidates = sources.filter(source => source.node.id !== target.id && source.assetId === assetId)
        // The edge names the saved image explicitly. Its owning profile node
        // can therefore show an older snapshot while displaying a newer board.
        const profileSource = assetId === originalAssetId ? graph.nodes.find(node => node.id !== target.id
          && node.settings.visual_profile_id === binding.profile_id
          && (node.type === 'image' || node.type === 'generation' && modality(node) === 'image')) : undefined
        const source = candidates.find(item => item.node.settings.visual_profile_id === binding.profile_id)
          || candidates.find(item => item.node.type === 'image') || candidates[0] || (profileSource ? { node: profileSource } : undefined)
        if (!source) continue
        edges.push({ id: `auto-visual:${JSON.stringify([target.id, assetId])}`, source: source.node.id, target: target.id,
          reference_asset_id: assetId })
        usedAssets.add(assetId)
      }
    }
  }
  return edges
}

export type MissingVisualReference = {
  profileId: string
  name: string
  variant: string
  nodeId?: string
  action: 'generate' | 'confirm' | 'bindings'
  reason?: string
}

export function missingVisualReferences(graph: CanvasGraph, nodeId: string, detail: ProjectDetail, models: Pick<Model, 'id' | 'modality'>[] = []): MissingVisualReference[] {
  const target = graph.nodes.find(node => node.id === nodeId)
  if (!target || target.type !== 'generation') return []
  const modality = models.find(model => model.id === target.model_id)?.modality || target.settings.modality
  const missing = new Map<string, MissingVisualReference>()
  const add = (profileId: string, name: string, variant: string, staleBinding = false) => {
    const profile = detail.visual_profiles?.find(item => item.id === profileId)
    const node = graph.nodes.find(item => item.id !== target.id && item.settings.visual_profile_id === profileId)
    const candidates = profile && visualCandidateAssets(profile, detail, node?.asset_id)
      .filter(asset => !profile.archived_candidate_asset_ids?.includes(asset.id))
    missing.set(profileId, { profileId, name, variant, nodeId: node?.id,
      action: !profile || staleBinding ? 'bindings' : candidates?.length ? 'confirm' : 'generate' })
  }
  const addBases = (profile: VisualProfile) => {
    const chain = visualProfileBaseChain(profile, detail.visual_profiles || [])
    if (chain.error) {
      add(profile.id, profile.name, profile.variant, true)
      missing.set(profile.id, { ...missing.get(profile.id)!, reason: chain.error })
      return
    }
    for (const base of chain.ancestors) if (!visualProfileBoardReady(base, detail)) {
      add(base.id, base.name, base.variant)
      missing.set(base.id, { ...missing.get(base.id)!, reason: `请先确认 ${base.name} · ${base.variant} 的基础图` })
    }
  }
  const targetProfile = detail.visual_profiles?.find(profile => profile.id === target.settings.visual_profile_id)
  if (targetProfile) addBases(targetProfile)
  // Manual profile inputs remain required even when automatic shot boards are disabled.
  for (const edge of graph.edges.filter(edge => edge.target === target.id)) {
    const source = graph.nodes.find(node => node.id === edge.source)
    if (!source?.settings.visual_profile_id) continue
    if (modality === 'video' && target.settings.mode === 'first_frame' && target.settings.storyboard_reference_asset_id &&
      (edge.reference_asset_id || visualNodeAsset(source, detail, true)?.id) !== target.settings.storyboard_reference_asset_id) continue
    const profile = detail.visual_profiles?.find(item => item.id === source.settings.visual_profile_id)
    const binding = detail.shot_visual_bindings?.find(binding => binding.shot_id === target.shot_id && binding.profile_id === source.settings.visual_profile_id)
    if (binding && !visualBindingApplies(binding, modality)) continue
    const frozenReference = edge.reference_asset_id && binding?.reference_assets?.find(reference => reference.asset_id === edge.reference_asset_id)
    if (frozenReference) {
      const ready = detail.assets.some(asset => asset.id === frozenReference.asset_id && asset.kind === 'image')
        && (!detail.project_visual_style || !frozenReference.style_version || frozenReference.style_version === detail.project_visual_style.version)
      if (!ready) add(binding!.profile_id, binding!.name, binding!.variant, true)
      continue
    }
    if (!edge.reference_asset_id && binding && (target.settings.visual_reference_mode || 'profiles') === 'profiles') {
      const ids = visualBindingReferenceAssetIds(binding)
      const staleStyle = !!detail.project_visual_style && (binding.reference_assets?.length
        ? binding.reference_assets.some(reference => !!reference.style_version && reference.style_version !== detail.project_visual_style!.version)
        : !!binding.board_style_version && binding.board_style_version !== detail.project_visual_style.version)
      if (!ids.length || staleStyle || ids.some(id => !detail.assets.some(asset => asset.id === id && asset.kind === 'image'))) {
        add(binding.profile_id, binding.name, binding.variant, true)
      }
      continue
    }
    // Explicit canvas references keep the image chosen when connected. A newer
    // profile candidate/board must not change or invalidate that snapshot.
    if (edge.reference_asset_id && detail.assets.some(asset => asset.id === edge.reference_asset_id && asset.kind === 'image')) continue
    if (visualNodeAsset(source, detail, true)?.kind === 'image' && profile?.board_style_status !== 'needs_review') continue
    if (profile) addBases(profile)
    add(source.settings.visual_profile_id, profile?.name || source.title, profile?.variant || '')
  }
  if (!target.settings.visual_profile_id && target.shot_id && modality !== 'text' && (!target.settings.visual_reference_mode || target.settings.visual_reference_mode === 'profiles')) {
    for (const binding of detail.shot_visual_bindings || []) {
      if (!visualBindingApplies(binding, modality)) continue
      const profile = detail.visual_profiles?.find(item => item.id === binding.profile_id)
      const assetIds = visualBindingReferenceAssetIds(binding)
      const staleStyle = !!detail.project_visual_style && (binding.reference_assets?.length
        ? binding.reference_assets.some(reference => !!reference.style_version && reference.style_version !== detail.project_visual_style!.version)
        : !!binding.board_style_version && binding.board_style_version !== detail.project_visual_style.version)
      if (!binding.required && target.settings.excluded_visual_profile_ids?.includes(binding.profile_id)) continue
      if (binding.shot_id !== target.shot_id || !binding.required && !assetIds.length ||
        !staleStyle && assetIds.length > 0 && assetIds.every(id => detail.assets.some(asset => asset.id === id && asset.kind === 'image'))) continue
      if (profile) addBases(profile)
      add(binding.profile_id, binding.name, binding.variant, !!binding.reference_assets?.length || profile?.board_style_status !== 'needs_review' && !!profile && (staleStyle || binding.revision !== profile.revision || !!profile.board_asset_id))
    }
  }
  return [...missing.values()]
}

export function syncVisualProfileNode(node: CanvasNode, profile: VisualProfile, detail: Pick<ProjectDetail, 'asset_tasks'>): CanvasNode {
  const task = detail.asset_tasks.find(item => item.id === profile.asset_task_id)
  const revisionChanged = node.settings.visual_profile_revision !== profile.revision
  const keepDocument = node.settings.prompt_document === true || !!node.settings.prompt_sections
  // Board approval changes the revision, but must not replay an already applied job.
  const keepCompletion = !revisionChanged || task?.generation_job_id === node.job_id
  return { ...node, title: `${profile.name} · ${profile.variant}`, shot_id: null,
    job_id: task?.generation_job_id || (revisionChanged ? null : node.job_id),
    asset_id: revisionChanged || profile.archived_candidate_asset_ids?.includes(node.asset_id || '') ? profile.board_asset_id : node.asset_id || profile.board_asset_id,
    settings: { ...node.settings, modality: 'image', visual_profile_revision: profile.revision,
      profile_prompt_override: revisionChanged && !keepDocument ? undefined : node.settings.profile_prompt_override,
      prompt_document: revisionChanged && !keepDocument ? undefined : node.settings.prompt_document,
      prompt_sections: revisionChanged && !keepDocument ? undefined : node.settings.prompt_sections,
      prompt_body: revisionChanged && !keepDocument ? undefined : node.settings.prompt_body,
      visual_completed_job_id: keepCompletion ? node.settings.visual_completed_job_id : undefined } }
}

export function addVisualProfileNode(graph: CanvasGraph, profile: VisualProfile, node: CanvasNode): { graph: CanvasGraph; nodeId: string } {
  const existing = graph.nodes.find(item => item.settings.visual_profile_id === profile.id)
  if (existing) return { graph, nodeId: existing.id }
  return { graph: { ...graph, nodes: [...graph.nodes, { ...node, shot_id: null, type: 'generation',
    title: `${profile.name} · ${profile.variant}`, prompt: '', text: '', asset_id: profile.board_asset_id,
    settings: { ...node.settings, modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision },
  }] }, nodeId: node.id }
}

export function visualBoardReferences(graph: CanvasGraph, nodeId: string, detail: ProjectDetail) {
  const profileIds: string[] = [], assetIds: string[] = []
  for (const edge of graph.edges.filter(edge => edge.target === nodeId)) {
    const source = graph.nodes.find(node => node.id === edge.source)
    if (!source || source.type === 'image_analysis' || source.type === 'video_analysis') continue
    if (edge.reference_asset_id) {
      const asset = detail.assets.find(asset => asset.id === edge.reference_asset_id && asset.kind === 'image')
      if (!asset) throw new Error(`参考节点 ${source.title} 的固定图片已失效，请重新选择`)
      if (!assetIds.includes(asset.id)) assetIds.push(asset.id)
      continue
    }
    if (source.settings.visual_profile_id) {
      const profile = detail.visual_profiles?.find(item => item.id === source.settings.visual_profile_id)
      if (!profile?.board_asset_id) throw new Error(`请先确认 ${profile?.name || source.title} 的设定图`)
      if (!profileIds.includes(profile.id)) profileIds.push(profile.id)
    } else if (source.type !== 'text') {
      const asset = visualNodeAsset(source, detail, true)
      if (asset?.kind !== 'image') throw new Error(`参考节点 ${source.title} 尚无可用图片`)
      if (!assetIds.includes(asset.id)) assetIds.push(asset.id)
    }
  }
  return { reference_profile_ids: profileIds, reference_asset_ids: assetIds }
}
