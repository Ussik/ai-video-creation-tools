import type { Asset, Job, Model, ProjectDetail, VisualProfile } from './api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'

export function requestVisualCanvas(projectId: string, profileIds: string[]) {
  window.sessionStorage.setItem(`visual-canvas-open:${projectId}`, JSON.stringify(profileIds))
  window.dispatchEvent(new Event('visual-canvas-open'))
}

export function visualJobRequest(job?: Job): Record<string, unknown> {
  try { return JSON.parse(job?.request || '{}') as Record<string, unknown> } catch { return {} }
}

export function visualBoardJobs(profile: VisualProfile, jobs: Job[]): Job[] {
  return jobs.filter(job => {
    const request = visualJobRequest(job)
    return request.visual_profile_id === profile.id && request.visual_profile_revision === profile.revision ||
      !!profile.asset_task_id && request.asset_task_id === profile.asset_task_id
  }).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function visualCandidateAssets(profile: VisualProfile, detail: ProjectDetail, displayedAssetId?: string | null): Asset[] {
  const jobs = detail.jobs.filter(job => {
    const request = visualJobRequest(job)
    return job.status === 'succeeded' && (request.visual_profile_id === profile.id || !!profile.asset_task_id && request.asset_task_id === profile.asset_task_id)
  })
  const ids = new Set([...jobs.map(job => job.result_asset_id), ...(profile.candidate_asset_ids || []), profile.board_asset_id, displayedAssetId])
  return detail.assets.filter(asset => asset.kind === 'image' && ids.has(asset.id)).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function visualNodeAsset(node: CanvasNode, detail: ProjectDetail, reference = false): Asset | undefined {
  const profile = detail.visual_profiles?.find(item => item.id === node.settings.visual_profile_id)
  const id = profile ? reference ? profile.board_asset_id : node.asset_id || profile.board_asset_id
    : node.settings.visual_profile_id ? null : node.asset_id
  return detail.assets.find(asset => asset.id === id)
}

/** Show backend-resolved shot references without turning them into manual inputs.
 * Bindings retain their own board snapshot, which may differ from today's profile.
 */
export function automaticVisualReferenceEdges(graph: CanvasGraph, detail: ProjectDetail, models: Pick<Model, 'id' | 'modality'>[] = []): CanvasGraph['edges'] {
  const modality = (node: CanvasNode) => models.find(model => model.id === node.model_id)?.modality || node.settings.modality
  const sources = graph.nodes.filter(node => node.type === 'image' || node.type === 'generation' && modality(node) === 'image')
    .map(node => ({ node, assetId: visualNodeAsset(node, detail, true)?.id }))
    .filter(source => source.assetId && detail.assets.some(asset => asset.id === source.assetId && asset.kind === 'image'))
  const edges: CanvasGraph['edges'] = []
  for (const target of graph.nodes) {
    if (target.type !== 'generation' || !target.shot_id || target.settings.visual_profile_id ||
      (target.settings.visual_reference_mode || 'profiles') !== 'profiles') continue
    const targetModality = modality(target)
    if (targetModality !== 'image' && !(targetModality === 'video' && target.settings.mode === 'reference')) continue
    const usedAssets = new Set(graph.edges.filter(edge => edge.target === target.id)
      .map(edge => sources.find(source => source.node.id === edge.source)?.assetId).filter(Boolean))
    for (const binding of detail.shot_visual_bindings || []) {
      const assetId = binding.board_asset_id
      if (binding.shot_id !== target.shot_id || !assetId || usedAssets.has(assetId)) continue
      const candidates = sources.filter(source => source.node.id !== target.id && source.assetId === assetId)
      // Prefer the bound profile, then a fixed image, then another image generator.
      const source = candidates.find(item => item.node.settings.visual_profile_id === binding.profile_id)
        || candidates.find(item => item.node.type === 'image') || candidates[0]
      if (!source) continue
      edges.push({ id: `auto-visual:${JSON.stringify([target.id, assetId])}`, source: source.node.id, target: target.id })
      usedAssets.add(assetId)
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
}

export function missingVisualReferences(graph: CanvasGraph, nodeId: string, detail: ProjectDetail, models: Pick<Model, 'id' | 'modality'>[] = []): MissingVisualReference[] {
  const target = graph.nodes.find(node => node.id === nodeId)
  if (!target || target.type !== 'generation') return []
  const missing = new Map<string, MissingVisualReference>()
  const add = (profileId: string, name: string, variant: string, staleBinding = false) => {
    const profile = detail.visual_profiles?.find(item => item.id === profileId)
    const node = graph.nodes.find(item => item.id !== target.id && item.settings.visual_profile_id === profileId)
    const candidates = profile && visualCandidateAssets(profile, detail, node?.asset_id)
      .filter(asset => !profile.archived_candidate_asset_ids?.includes(asset.id))
    missing.set(profileId, { profileId, name, variant, nodeId: node?.id,
      action: !profile || staleBinding ? 'bindings' : candidates?.length ? 'confirm' : 'generate' })
  }
  // Manual profile inputs remain required even when automatic shot boards are disabled.
  for (const edge of graph.edges.filter(edge => edge.target === target.id)) {
    const source = graph.nodes.find(node => node.id === edge.source)
    if (!source?.settings.visual_profile_id || visualNodeAsset(source, detail, true)?.kind === 'image') continue
    const profile = detail.visual_profiles?.find(item => item.id === source.settings.visual_profile_id)
    add(source.settings.visual_profile_id, profile?.name || source.title, profile?.variant || '')
  }
  const modality = models.find(model => model.id === target.model_id)?.modality || target.settings.modality
  if (!target.settings.visual_profile_id && target.shot_id && modality !== 'text' && (!target.settings.visual_reference_mode || target.settings.visual_reference_mode === 'profiles')) {
    for (const binding of detail.shot_visual_bindings || []) {
      if (binding.shot_id !== target.shot_id || !binding.required ||
        detail.assets.some(asset => asset.id === binding.board_asset_id && asset.kind === 'image')) continue
      const profile = detail.visual_profiles?.find(item => item.id === binding.profile_id)
      add(binding.profile_id, binding.name, binding.variant, !!profile && (binding.revision !== profile.revision || !!profile.board_asset_id))
    }
  }
  return [...missing.values()]
}

export function syncVisualProfileNode(node: CanvasNode, profile: VisualProfile, detail: ProjectDetail): CanvasNode {
  const task = detail.asset_tasks.find(item => item.id === profile.asset_task_id)
  const revisionChanged = node.settings.visual_profile_revision !== profile.revision
  // Board approval changes the revision, but must not replay an already applied job.
  const keepCompletion = !revisionChanged || task?.generation_job_id === node.job_id
  return { ...node, title: `${profile.name} · ${profile.variant}`, shot_id: null,
    job_id: task?.generation_job_id || (revisionChanged ? null : node.job_id),
    asset_id: revisionChanged || profile.archived_candidate_asset_ids?.includes(node.asset_id || '') ? profile.board_asset_id : node.asset_id,
    settings: { ...node.settings, modality: 'image', visual_profile_revision: profile.revision,
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
  const sources = graph.edges.filter(edge => edge.target === nodeId).map(edge => graph.nodes.find(node => node.id === edge.source)).filter((node): node is CanvasNode => !!node)
  const profileIds: string[] = [], assetIds: string[] = []
  for (const source of sources) {
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
