import type { CanvasDeletionPreview } from '@video-studio/shared/storyboard/shot-management'
import { all, now, one, run, type Asset, type Job, type Shot } from '../../infrastructure/database/db.js'
import { assetProtection, containsResource, managementResourceState, normalizedCanvasId, projectNodes, resourceHash, shotDeleteBlockers } from '../storyboard/shot-management.js'

interface Graph { revision: string; nodes: unknown[]; edges: unknown[] }
export function canvasDeletionPreview(projectId: string, canvasId: string, graph: Graph): CanvasDeletionPreview {
  const nodes = projectNodes(projectId).filter(node => normalizedCanvasId(projectId,node.canvas_id) === canvasId)
  const nodeJobs = new Set(nodes.flatMap(node => node.job_id ? [node.job_id] : []))
  const nodeShots = new Set(nodes.flatMap(node => node.shot_id ? [node.shot_id] : []))
  const designs = new Set(all<{ id: string }>('SELECT id FROM storyboard_designs WHERE project_id=? AND canvas_id=?',projectId,canvasId).map(design => design.id))
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL ORDER BY position,id',projectId)
    .filter(shot => nodeShots.has(shot.id) || !!shot.design_id && designs.has(shot.design_id))
  const exclusiveShots = shots.filter(shot => !shotDeleteBlockers(shot,canvasId).length)
  const jobs = all<Job>('SELECT * FROM jobs WHERE project_id=? ORDER BY id',projectId)
  const relatedJobs = jobs.filter(job => nodeJobs.has(job.id) || !!job.shot_id && shots.some(shot => shot.id === job.shot_id))
  const ownJobAssets = new Set(relatedJobs.flatMap(job => job.result_asset_id ? [job.result_asset_id] : []))
  const edges = all<{ canvas_id: string | null; reference_asset_id: string | null }>('SELECT canvas_id,reference_asset_id FROM canvas_edges WHERE project_id=?',projectId)
    .filter(edge => normalizedCanvasId(projectId,edge.canvas_id) === canvasId)
  const assets = all<Asset>('SELECT * FROM assets WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at,id',projectId)
    .filter(asset => ownJobAssets.has(asset.id) || !!asset.shot_id && shots.some(shot => shot.id === asset.shot_id)
      || nodes.some(node => containsResource(node,asset.id)) || edges.some(edge => edge.reference_asset_id === asset.id))
  const exclusiveAssets = assets.filter(asset => !assetProtection(projectId,asset,canvasId).length
    // Keep outputs of live jobs and assets owned by a shot still used elsewhere.
    && !relatedJobs.some(job => job.result_asset_id === asset.id && ['queued','running'].includes(job.status))
    && (!asset.shot_id || !shotDeleteBlockers(shots.find(shot => shot.id === asset.shot_id) || one<Shot>('SELECT * FROM shots WHERE id=?',asset.shot_id)!,canvasId).length))
  // Include reference rows without project_id as well, so a setting/selection
  // changed after preview cannot silently convert shared media into trash.
  const extra = ['visual_profile_candidates','visual_profile_reference_assets','shot_visual_bindings','asset_reviews','speech_placements'].flatMap(table =>
    one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",table) ? [[table,all(`SELECT * FROM ${table} ORDER BY rowid`)]] : [])
  return { revision: graph.revision, cleanup_revision: resourceHash([graph.revision,managementResourceState(projectId),extra]),
    node_count: graph.nodes.length, edge_count: graph.edges.length,
    exclusive_shots: exclusiveShots.map(({ id,title }) => ({ id,title })),
    exclusive_assets: exclusiveAssets.map(({ id,filename }) => ({ id,filename })),
    protected_asset_count: assets.length-exclusiveAssets.length,
    running_job_count: relatedJobs.filter(job => ['queued','running'].includes(job.status)).length }
}
export function recycleCanvasResources(preview: CanvasDeletionPreview, cleanupShots: boolean, cleanupAssets: boolean): void {
  const timestamp = now()
  if (cleanupShots) for (const shot of preview.exclusive_shots) run('UPDATE shots SET deleted_at=? WHERE id=?',timestamp,shot.id)
  if (cleanupAssets) for (const asset of preview.exclusive_assets) run('UPDATE assets SET deleted_at=? WHERE id=?',timestamp,asset.id)
}
