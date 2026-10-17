import type { ProjectDetail, ShotVisualBinding, VisualProfile } from '../../shared/api/api'

export function visualBindingNeedsRefresh(snapshot: ShotVisualBinding, profile: VisualProfile,
  style?: ProjectDetail['project_visual_style']): boolean {
  const references = snapshot.reference_assets || []
  return snapshot.revision !== profile.revision || (references.length > 0
    ? references.some(reference => !!style && !!reference.style_version && reference.style_version !== style.version)
    : snapshot.board_asset_id !== profile.board_asset_id || snapshot.board_style_version !== profile.board_style_version)
}
