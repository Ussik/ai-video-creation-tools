import type { Asset, Model } from '../../shared/api/api'
import type { CanvasNode } from './ProjectCanvas'

export type CanvasNodeTypeFilter = 'all' | 'image' | 'video' | 'text' | 'project_script_ref'

/** Generation cards belong to the media they produce, including unfinished cards. */
export function canvasNodeCategory(node: CanvasNode, models: ReadonlyMap<string, Model>, assets: ReadonlyMap<string, Asset>): Exclude<CanvasNodeTypeFilter, 'all'> {
  if (node.type !== 'generation') return node.type
  if (node.settings.visual_profile_id) return 'image'
  const modality = node.settings.modality || models.get(node.model_id || '')?.modality || assets.get(node.asset_id || '')?.kind
  if (modality === 'video' || modality === 'text') return modality
  // Unconfigured generators use the same image default as their canvas card.
  return 'image'
}
