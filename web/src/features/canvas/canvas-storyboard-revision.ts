import type { Asset, Job, Model, Shot } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'

/** Legacy shots, canvas nodes and jobs all belong to storyboard revision zero. */
export function storyboardRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Synchronize saved/local canvas snapshots without discarding historical media. */
export function syncCanvasStoryboardRevision(graph: CanvasGraph, shots: Shot[],
  models: Pick<Model, 'id' | 'modality'>[] = [],
  assets: Array<Pick<Asset, 'id' | 'kind'> & Partial<Pick<Asset, 'shot_id' | 'url' | 'remote_url'>>> = []): CanvasGraph {
  const currentShots = new Map(shots.map(shot => [shot.id, shot]))
  const affectedNodes = new Set<string>(), affectedShots = new Set<string>(), oldAssets = new Set<string>()
  const nodes = graph.nodes.map(node => {
    const shot = node.shot_id && currentShots.get(node.shot_id)
    if (node.type !== 'generation' || node.settings.visual_profile_id || !shot
      || storyboardRevision(shot.storyboard_revision) <= storyboardRevision(node.settings.storyboard_revision)) return node
    const modality = models.find(model => model.id === node.model_id)?.modality || node.settings.modality || 'image'
    if (modality !== 'image' && modality !== 'video') return node
    affectedNodes.add(node.id); affectedShots.add(shot.id)
    if (node.asset_id) oldAssets.add(node.asset_id)
    const { prompt_override, prompt_is_final, prompt_document, prompt_sections, prompt_body, prompt_base, prompt_template, generation_completed_job_id,
      storyboard_reference_asset_id, image_video_handoff, reference_video_url, ...settings } = node.settings
    return { ...node, title: shot.title, prompt: modality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot),
      text: '', asset_id: null, job_id: null,
      settings: { ...settings, modality, duration: shot.duration, storyboard_revision: storyboardRevision(shot.storyboard_revision),
        ...(settings.group_id === shot.id ? { group_title: `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}` } : {}) } }
  })
  if (!affectedNodes.size) return graph
  for (const asset of assets) {
    if (asset.shot_id && affectedShots.has(asset.shot_id) && (asset.kind === 'image' || asset.kind === 'video')) oldAssets.add(asset.id)
  }
  const oldVideoUrls = new Set([...oldAssets].map(id => `/api/assets/${id}/file`))
  for (const asset of assets) if (asset.kind === 'video' && oldAssets.has(asset.id)) {
    if (asset.url) oldVideoUrls.add(asset.url)
    if (asset.remote_url) oldVideoUrls.add(asset.remote_url)
  }
  const sources = new Map(graph.nodes.map(node => [node.id, node]))
  const downstreamNodes = new Set<string>()
  const edges = graph.edges.filter(edge => {
    const source = sources.get(edge.source), target = sources.get(edge.target)
    if (source?.settings.visual_profile_id) return true
    // A different shot may have pinned this generator's former result. Detach
    // only that old fixed input; keep an unpinned connection ready for new work.
    if (affectedNodes.has(edge.source) && (edge.reference_asset_id && oldAssets.has(edge.reference_asset_id)
      || target?.settings.storyboard_reference_asset_id && oldAssets.has(target.settings.storyboard_reference_asset_id)
      || target?.settings.reference_video_url && oldVideoUrls.has(target.settings.reference_video_url)
      || target?.settings.video_reference_usages?.some(usage => oldAssets.has(usage.asset_id)))) {
      downstreamNodes.add(edge.target)
      return false
    }
    // A deliberately added media card stays on the canvas; only its obsolete
    // pinned use is detached from the replanned shot's generator.
    return !(affectedNodes.has(edge.target) && (edge.reference_asset_id && oldAssets.has(edge.reference_asset_id)
      || source?.asset_id && oldAssets.has(source.asset_id)))
  })
  for (const [index, node] of nodes.entries()) {
    if ((!affectedNodes.has(node.id) && !downstreamNodes.has(node.id)) || node.type !== 'generation' || node.settings.visual_profile_id) continue
    const settings = { ...node.settings }
    let changed = false
    if (settings.storyboard_reference_asset_id && oldAssets.has(settings.storyboard_reference_asset_id)) {
      delete settings.storyboard_reference_asset_id; changed = true
    }
    if (settings.image_video_handoff && (affectedNodes.has(settings.image_video_handoff.source_node_id)
      || oldAssets.has(settings.image_video_handoff.source_asset_id))) {
      delete settings.image_video_handoff; changed = true
    }
    if (settings.reference_video_url && oldVideoUrls.has(settings.reference_video_url)) {
      delete settings.reference_video_url; changed = true
    }
    if (settings.video_reference_usages?.length) {
      const usages = settings.video_reference_usages.filter(usage => !oldAssets.has(usage.asset_id))
      if (usages.length !== settings.video_reference_usages.length) { settings.video_reference_usages = usages; changed = true }
    }
    if (changed) nodes[index] = { ...node, settings }
  }
  return { ...graph, nodes, edges: edges.length === graph.edges.length ? graph.edges : edges }
}

/** Automatic completion must not bring a previous storyboard's result back. */
export function canvasJobMatchesStoryboard(node: CanvasNode, job: Pick<Job, 'request' | 'shot_id'> | undefined): boolean {
  if (node.type !== 'generation' || !node.shot_id || node.settings.visual_profile_id) return true
  if (!job || job.shot_id !== node.shot_id) return false
  try {
    const metadata: unknown = JSON.parse(job.request)
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
    return storyboardRevision((metadata as Record<string, unknown>).storyboard_revision) === storyboardRevision(node.settings.storyboard_revision)
  } catch { return false }
}
