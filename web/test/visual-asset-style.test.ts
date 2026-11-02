import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProjectDetail } from '../src/shared/api/api'
import { visualAssetStyleWarning } from '../src/features/visuals/visual-asset-style'

function fixture() {
  return {
    project_visual_style: { version: 'project-version', label: '水墨', source: 'settings', details: {} },
    jobs: [{ id: 'job', status: 'succeeded', result_asset_id: 'image', request: JSON.stringify({
      project_style_version: 'project-version', effective_visual_style: { origin: 'custom', fingerprint: 'a'.repeat(64) },
    }) }],
    visual_profiles: [{ id: 'profile', board_asset_id: 'image', board_style_version: 'project-version', board_style_status: 'needs_review', reference_assets: [] }],
  } as unknown as ProjectDetail
}

test('a matching project baseline cannot hide an unreviewed custom image', () => {
  const detail = fixture()
  assert.match(visualAssetStyleWarning(detail, 'image', 1)!, /参考图 2.*自定义画风/)
  detail.visual_profiles![0]!.board_style_status = 'current'
  assert.match(visualAssetStyleWarning(detail, 'image', 1)!, /自定义画风/, 'an old automatic approval still needs a human review')
})

test('only a matching owner and current-version human review clears the custom-style warning', () => {
  const detail = fixture(), job = detail.jobs[0]!, request = JSON.parse(job.request)
  detail.visual_profiles![0]!.board_style_status = 'current'
  for (const review of [{ profile_id: 'other', style_version: 'project-version' }, { profile_id: 'profile', style_version: 'old' }]) {
    job.request = JSON.stringify({ ...request, visual_style_reviews: [review] })
    assert.match(visualAssetStyleWarning(detail, 'image', 0)!, /自定义画风/)
  }
  job.request = JSON.stringify({ ...request, visual_style_reviews: [{ profile_id: 'profile', style_version: 'project-version' }] })
  assert.equal(visualAssetStyleWarning(detail, 'image', 0), null)
  assert.equal(JSON.parse(job.request).effective_visual_style.origin, 'custom', 'review does not erase generation provenance')
})

test('an unconfirmed independent view cannot clear a warning using a project version alone', () => {
  const detail = fixture(), profile = detail.visual_profiles![0]!
  profile.board_asset_id = null
  profile.reference_assets = [{ asset_id: 'image', status: 'candidate', style_version: 'project-version' }] as typeof profile.reference_assets
  assert.match(visualAssetStyleWarning(detail, 'image', 0)!, /自定义画风/)
  const request = JSON.parse(detail.jobs[0]!.request)
  detail.jobs[0]!.request = JSON.stringify({ ...request, visual_style_reviews: [{ profile_id: profile.id, style_version: 'project-version' }] })
  profile.reference_assets![0]!.status = 'confirmed'
  assert.equal(visualAssetStyleWarning(detail, 'image', 0), null)
})

test('a reviewed board retained by a locked binding stays reviewed after the profile switches boards', () => {
  const detail = fixture(), profile = detail.visual_profiles![0]!, job = detail.jobs[0]!
  profile.board_asset_id = 'new-board'
  profile.board_style_status = 'current'
  const binding = { profile_id: profile.id, board_asset_id: 'image', board_style_version: 'project-version', reference_assets: [] }
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [binding])!, /自定义画风/, 'the snapshot alone is not a human review')
  const request = JSON.parse(job.request)
  job.request = JSON.stringify({ ...request, visual_style_reviews: [{ profile_id: profile.id, style_version: 'project-version' }] })
  assert.equal(visualAssetStyleWarning(detail, 'image', 0, [binding]), null)
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [{ ...binding, board_style_version: 'old-version' }])!, /自定义画风/)
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [{ ...binding, profile_id: 'another-profile' }])!, /自定义画风/)
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [binding], 'another-profile')!, /自定义画风/)
})

test('a historical candidate needs a matching human review to remain reviewed after switching boards', () => {
  const detail = fixture(), profile = detail.visual_profiles![0]!, job = detail.jobs[0]!
  profile.board_asset_id = 'new-board'
  profile.candidate_asset_ids = ['image', 'new-board']
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [], profile.id)!, /自定义画风/)
  const request = JSON.parse(job.request)
  job.request = JSON.stringify({ ...request, visual_style_reviews: [{ profile_id: profile.id, style_version: 'project-version' }] })
  assert.equal(visualAssetStyleWarning(detail, 'image', 0, [], profile.id), null)
  assert.match(visualAssetStyleWarning(detail, 'image', 0, [], 'another-profile')!, /自定义画风/)
  job.request = JSON.stringify({ ...request, project_style_version: 'old-version', effective_visual_style: { origin: 'project', fingerprint: 'b'.repeat(64) } })
  assert.ok(visualAssetStyleWarning(detail, 'image', 0, [], profile.id), 'candidate ownership alone cannot clear an inherited old-version warning')
})
