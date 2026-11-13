import type { ProjectDetail } from '../../shared/api/api'
import type { CanvasNode } from '../canvas/ProjectCanvas'
import { visualAssetStyleWarning } from '../visuals/visual-asset-style'

export type FinalCutAssetStatus = 'confirmed' | 'candidate' | 'other'
export type FinalCutAssetState = { status: FinalCutAssetStatus; label: string }
export type FinalCutAssetNode = Pick<CanvasNode, 'type' | 'asset_id' | 'settings'>

/** Selection and confirmation belong to their source records, not to asset.saved or review approval. */
export function finalCutAssetStates(detail: ProjectDetail, nodes: FinalCutAssetNode[] = []): Map<string, FinalCutAssetState> {
  const confirmed = new Set<string>()
  const archived = new Set<string>()
  const needsReview = new Set<string>()
  const historicalSpeech = new Set<string>()
  const oldReferences = new Set<string>()
  const currentReferences = new Set<string>()
  const assets = new Map(detail.assets.map(asset => [asset.id, asset]))
  for (const node of nodes) {
    if (node.settings.visual_profile_id || !['image', 'video', 'generation'].includes(node.type) || !node.asset_id) continue
    const asset = assets.get(node.asset_id)
    if (asset && (asset.kind === 'image' || asset.kind === 'video')) confirmed.add(asset.id)
  }
  const shots = new Map([...(detail.historical_shots || []), ...detail.shots].map(shot => [shot.id, shot]))
  for (const shot of shots.values()) {
    if (shot.selected_asset_id) confirmed.add(shot.selected_asset_id)
    for (const id of shot.archived_candidate_asset_ids || []) archived.add(id)
  }
  for (const line of detail.speech?.lines || []) {
    if (!line.selected_asset_id) continue
    if (line.source_status === 'removed') historicalSpeech.add(line.selected_asset_id)
    else if (line.selected_is_stale || line.source_status === 'changed') needsReview.add(line.selected_asset_id)
    else confirmed.add(line.selected_asset_id)
  }
  for (const profile of detail.visual_profiles || []) {
    const reviewBoard = profile.board_style_status === 'needs_review'
      || profile.base_reference_status === 'waiting' || profile.base_reference_status === 'needs_review'
    if (profile.board_asset_id) (reviewBoard ? needsReview : confirmed).add(profile.board_asset_id)
    for (const id of profile.archived_candidate_asset_ids || []) archived.add(id)
    for (const [index, reference] of (profile.reference_assets || []).entries()) {
      if (reference.status === 'archived') { archived.add(reference.asset_id); continue }
      if (reference.revision !== profile.revision) { oldReferences.add(reference.asset_id); continue }
      currentReferences.add(reference.asset_id)
      const styleVersion = detail.project_visual_style?.version
      const styleMismatch = !styleVersion || reference.style_version !== styleVersion
      const warning = visualAssetStyleWarning(detail, reference.asset_id, index, [], profile.id)
      if (styleMismatch || warning) needsReview.add(reference.asset_id)
      else if (reference.status === 'confirmed') confirmed.add(reference.asset_id)
    }
  }
  return new Map(detail.assets.map(asset => {
    let state: FinalCutAssetState
    if (confirmed.has(asset.id)) state = { status: 'confirmed', label: '已确认' }
    else if (archived.has(asset.id)) state = { status: 'other', label: '已归档' }
    else if (historicalSpeech.has(asset.id)) state = { status: 'other', label: '历史配音' }
    else if (needsReview.has(asset.id)) state = { status: 'candidate', label: '待复核' }
    else if (oldReferences.has(asset.id) && !currentReferences.has(asset.id)) state = { status: 'other', label: '旧版参考' }
    else if (asset.source === 'upload') state = { status: 'other', label: '已导入' }
    else if (asset.source === 'export') state = { status: 'other', label: '已导出' }
    else state = { status: 'candidate', label: '候选' }
    return [asset.id, state]
  }))
}
