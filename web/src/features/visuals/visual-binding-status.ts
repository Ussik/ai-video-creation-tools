import type { ProjectDetail, ShotVisualBinding, VisualProfile } from '../../shared/api/api'

/** Whether the stored snapshot differs, even when the user has locked it. */
export function visualBindingSnapshotDiffers(snapshot: ShotVisualBinding, profile: VisualProfile,
  style?: ProjectDetail['project_visual_style']): boolean {
  const references = snapshot.reference_assets || []
  return snapshot.revision !== profile.revision || (references.length > 0
    ? references.some(reference => !!style && !!reference.style_version && reference.style_version !== style.version)
    : snapshot.board_asset_id !== profile.board_asset_id || snapshot.board_style_version !== profile.board_style_version)
}

export function visualBindingSyncStatus(snapshot: ShotVisualBinding, profile: VisualProfile,
  style?: ProjectDetail['project_visual_style']): ShotVisualBinding['sync_status'] | 'locked' {
  if (snapshot.sync_mode === 'locked') return 'locked'
  if (snapshot.sync_status) return snapshot.sync_status
  if (!visualBindingSnapshotDiffers(snapshot, profile, style)) return 'current'
  return snapshot.reference_selection === 'manual' ? 'manual_review' : 'waiting_confirmation'
}

/** Only unresolved automatic updates need attention; locked versions are intentional. */
export function visualBindingNeedsRefresh(snapshot: ShotVisualBinding, profile: VisualProfile,
  style?: ProjectDetail['project_visual_style']): boolean {
  const status = visualBindingSyncStatus(snapshot, profile, style)
  return status === 'waiting_confirmation' || status === 'manual_review'
}

export function visualBindingSyncLabel(snapshot: ShotVisualBinding, profile: VisualProfile,
  style?: ProjectDetail['project_visual_style']): string {
  switch (visualBindingSyncStatus(snapshot, profile, style)) {
    case 'locked': return `已锁定 v${snapshot.revision}`
    case 'waiting_confirmation': return '新版待确认'
    case 'manual_review': return '保留手选参考图 · 需处理'
    default: return snapshot.reference_selection === 'manual' ? '自动跟随 · 保留手选参考图' : '自动跟随最新设定'
  }
}
