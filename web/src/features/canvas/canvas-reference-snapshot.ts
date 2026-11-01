import type { CanvasNode } from './ProjectCanvas'

/** Resolve a fixed edge against its saved image, independent of later generation. */
export function pinnedCanvasReference(source: CanvasNode, assetId?: string): CanvasNode {
  return assetId ? { ...source, asset_id: assetId, job_id: null, settings: { ...source.settings, visual_profile_id: undefined } } : source
}
