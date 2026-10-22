import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { all, now, run, type Asset, type CanvasEdge, type CanvasNode, type Model, type Shot } from '../../infrastructure/database/db.js'

/** The caller owns the planning transaction. Media and jobs remain historical candidates. */
export function invalidateStoryboardShot(shot: Shot, revision: number): void {
  run('UPDATE shots SET storyboard_revision=?, selected_asset_id=NULL WHERE id=?', revision, shot.id)
  run('DELETE FROM timeline_clips WHERE shot_id=?', shot.id)
  const nodes = all<CanvasNode>('SELECT * FROM canvas_nodes WHERE project_id=?', shot.project_id)
  const settings = new Map(nodes.map(node => [node.id, JSON.parse(node.settings) as Record<string, unknown>]))
  const modalities = new Map(all<Pick<Model, 'id' | 'modality'>>('SELECT id, modality FROM models').map(model => [model.id, model.modality]))
  const modality = (node: CanvasNode) => modalities.get(node.model_id || '') || settings.get(node.id)!.modality || 'image'
  const affected = new Set(nodes.filter(node => node.type === 'generation' && node.shot_id === shot.id
    && !settings.get(node.id)!.visual_profile_id
    && modality(node) !== 'text').map(node => node.id))
  const oldAssets = all<Pick<Asset, 'id' | 'kind' | 'remote_url'>>('SELECT id, kind, remote_url FROM assets WHERE shot_id=? AND kind IN (\'image\', \'video\')', shot.id)
  const assets = new Set(oldAssets.map(asset => asset.id))
  const videoUrls = new Set(oldAssets.filter(asset => asset.kind === 'video').flatMap(asset =>
    [`/api/assets/${asset.id}/file`, ...(asset.remote_url ? [asset.remote_url] : [])]))
  const dependent = new Set<string>()
  for (const edge of all<CanvasEdge>('SELECT * FROM canvas_edges WHERE project_id=?', shot.project_id)) {
    const source = nodes.find(node => node.id === edge.source)
    if (source && settings.get(source.id)!.visual_profile_id) continue
    const target = settings.get(edge.target)
    const fixedInput = edge.reference_asset_id && assets.has(edge.reference_asset_id)
      || typeof target?.storyboard_reference_asset_id === 'string' && assets.has(target.storyboard_reference_asset_id)
      || typeof target?.reference_video_url === 'string' && videoUrls.has(target.reference_video_url)
      || Array.isArray(target?.video_reference_usages) && target.video_reference_usages.some(usage => assets.has(usage.asset_id))
    if (affected.has(edge.source) && fixedInput || affected.has(edge.target)
      && (edge.reference_asset_id && assets.has(edge.reference_asset_id) || source?.asset_id && assets.has(source.asset_id))) {
      run('DELETE FROM canvas_edges WHERE project_id=? AND id=?', shot.project_id, edge.id)
      dependent.add(edge.target)
    }
  }
  for (const node of nodes) {
    const next = { ...settings.get(node.id)! }
    const reset = affected.has(node.id)
    if (reset) {
      for (const field of ['prompt_override', 'prompt_is_final', 'prompt_document', 'prompt_sections', 'prompt_body', 'prompt_base', 'prompt_template', 'generation_completed_job_id',
        'storyboard_reference_asset_id', 'reference_video_url']) delete next[field]
      next.storyboard_revision = revision
      next.modality = modality(node)
      next.duration = shot.duration
      if (next.group_id === shot.id) next.group_title = `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}`
    }
    if (reset || dependent.has(node.id)) {
      if (typeof next.storyboard_reference_asset_id === 'string' && assets.has(next.storyboard_reference_asset_id)) delete next.storyboard_reference_asset_id
      if (typeof next.reference_video_url === 'string' && videoUrls.has(next.reference_video_url)) delete next.reference_video_url
      if (Array.isArray(next.video_reference_usages)) next.video_reference_usages = next.video_reference_usages.filter(usage => !assets.has(usage.asset_id))
    }
    if (reset) run('UPDATE canvas_nodes SET title=?, prompt=?, text=\'\', asset_id=NULL, job_id=NULL, settings=? WHERE project_id=? AND id=?',
      shot.title, next.modality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot), JSON.stringify(next), shot.project_id, node.id)
    else if (JSON.stringify(next) !== node.settings) run('UPDATE canvas_nodes SET settings=? WHERE project_id=? AND id=?', JSON.stringify(next), shot.project_id, node.id)
  }
  if (affected.size) run('UPDATE project_canvases SET updated_at=? WHERE project_id=?', now(), shot.project_id)
}
