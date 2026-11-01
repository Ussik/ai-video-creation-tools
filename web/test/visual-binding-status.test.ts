import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectDetail, ShotVisualBinding, VisualProfile } from '../src/shared/api/api'
import { visualBindingNeedsRefresh, visualBindingSnapshotDiffers, visualBindingSyncLabel, visualBindingSyncStatus } from '../src/features/visuals/visual-binding-status'

const profile = { id: 'person', revision: 2, board_asset_id: 'new-board' } as VisualProfile
const snapshot = { profile_id: 'person', revision: 1, board_asset_id: 'old-board' } as ShotVisualBinding

test('locked old references keep their version without appearing as an unresolved automatic update', () => {
  const locked = { ...snapshot, sync_mode: 'locked' as const, sync_status: 'waiting_confirmation' as const }
  assert.equal(visualBindingSnapshotDiffers(locked, profile), true)
  assert.equal(visualBindingSyncStatus(locked, profile), 'locked')
  assert.equal(visualBindingNeedsRefresh(locked, profile), false)
  assert.equal(visualBindingSyncLabel(locked, profile), '已锁定 v1')
})

test('unconfirmed automatic updates and incompatible manual selections have distinct attention states', () => {
  assert.equal(visualBindingSyncStatus(snapshot, profile), 'waiting_confirmation')
  assert.equal(visualBindingSyncLabel(snapshot, profile), '新版待确认')
  const manual = { ...snapshot, reference_selection: 'manual' as const }
  assert.equal(visualBindingSyncStatus(manual, profile), 'manual_review')
  assert.equal(visualBindingNeedsRefresh(manual, profile), true)
  assert.equal(visualBindingSyncLabel(manual, profile), '保留手选参考图 · 需处理')
})

test('server resolution is authoritative for confirmed manual references and same revision board changes', () => {
  const current = { ...snapshot, reference_selection: 'manual' as const, sync_status: 'current' as const }
  assert.equal(visualBindingNeedsRefresh(current, profile), false)
  assert.equal(visualBindingSyncLabel(current, profile), '自动跟随 · 保留手选参考图')
  assert.equal(visualBindingSyncStatus({ ...snapshot, revision: profile.revision }, profile), 'waiting_confirmation')
})

test('style changes keep automatic references waiting until the new style is confirmed', () => {
  const bound = { ...snapshot, revision: profile.revision, reference_assets: [{ id: 'face', asset_id: 'face-image', style_version: 'old-style' }] } as ShotVisualBinding
  const style = { version: 'new-style' } as ProjectDetail['project_visual_style']
  assert.equal(visualBindingSnapshotDiffers(bound, profile, style), true)
  assert.equal(visualBindingSyncStatus(bound, profile, style), 'waiting_confirmation')
})
