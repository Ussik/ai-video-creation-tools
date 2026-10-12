import assert from 'node:assert/strict'
import { test } from 'node:test'
import { videoReferenceManifest, visualBindingReferenceAssetIds, type VideoReferenceBinding } from '@video-studio/shared/media/video-reference-manifest'
import type { VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'

const options = { mode: 'reference', visual_reference_mode: 'profiles', storyboard_reference_asset_id: 'shot' }
const binding = (profile_id: string, kind: VideoReferenceBinding['kind'], board_asset_id: string | null, overrides: Partial<VideoReferenceBinding> = {}): VideoReferenceBinding => ({
  profile_id, kind, board_asset_id, name: profile_id, variant: '默认', required: true, ...overrides,
})
const reference = (asset_id: string, view: VisualReferenceSnapshot['view'], purpose: VisualReferenceSnapshot['purpose']): VisualReferenceSnapshot => ({
  id: `${asset_id}-${view}`, asset_id, view, purpose, label: `${view}说明`, revision: 2, style_version: 'anime',
})

test('manual image order precedes stable character, location and prop bindings and uses the actual request numbering', () => {
  const bindings = [binding('key', 'prop', 'key-board'), binding('station', 'location', 'station-board'), binding('wan', 'character', 'wan-board')]
  const manifest = videoReferenceManifest(['shot', 'manual'], bindings, options)
  assert.deepEqual(manifest.map(entry => [entry.asset_id, entry.index, entry.purpose]), [
    ['shot', 1, 'storyboard'], ['manual', 2, 'manual'], ['wan-board', 3, 'character'], ['station-board', 4, 'location'], ['key-board', 5, 'prop'],
  ])
  assert.deepEqual(manifest, videoReferenceManifest(['shot', 'manual'], [...bindings].reverse(), options), 'API and UI may receive bindings in different orders')
})

test('deduplicating a shared image retains every bound name, variant, profile id and required flag', () => {
  const manifest = videoReferenceManifest(['shot', 'shared', 'shared'], [
    binding('b', 'character', 'shared', { name: 'B', variant: '外套', required: false }),
    binding('a', 'character', 'shared', { name: 'A', variant: '便装' }),
    binding('a', 'character', 'shared', { name: 'A', variant: '便装' }),
  ], options)
  assert.equal(manifest.length, 2)
  assert.deepEqual(manifest[1], {
    asset_id: 'shared', index: 2, purpose: 'character', name: 'A / B', variant: '便装 / 外套',
    profile_ids: ['a', 'b'], required: true,
  })
})

test('excluding optional profiles compacts image numbers, while required images remain available for validation', () => {
  const manifest = videoReferenceManifest(['shot'], [
    binding('hero', 'character', 'hero-board'), binding('crowd', 'character', 'crowd-board', { required: false }), binding('station', 'location', 'station-board'),
  ], { ...options, excluded_visual_profile_ids: ['hero', 'crowd'] })
  assert.deepEqual(manifest.map(entry => [entry.asset_id, entry.index]), [['shot', 1], ['hero-board', 2], ['station-board', 3]])
  assert.equal(manifest[1].required, true)
})

test('excluding a binding does not discard an independently connected manual image', () => {
  const manifest = videoReferenceManifest(['shot', 'crowd-board'], [binding('crowd', 'character', 'crowd-board', { required: false })], {
    ...options, excluded_visual_profile_ids: ['crowd'],
  })
  assert.equal(manifest[1].purpose, 'manual')
  assert.deepEqual(manifest[1].profile_ids, [])
})

test('first and last frames stay ordered and never mix additional profile boards into a keyframe request', () => {
  const boards = [binding('hero', 'character', 'hero-board')]
  const manifest = videoReferenceManifest(['opening', 'opening', 'ending'], boards, { mode: 'first_last_frame', visual_reference_mode: 'profiles' })
  assert.deepEqual(manifest.map(entry => [entry.asset_id, entry.index, entry.purpose]), [['opening', 1, 'first_frame'], ['ending', 2, 'last_frame']])
  const firstFrame = videoReferenceManifest(['opening'], boards, { mode: 'first_frame', visual_reference_mode: 'profiles' })
  assert.equal(firstFrame[0].purpose, 'first_frame')
  assert.equal(firstFrame.length, 1)
})

test('text-only and keyframe visual modes do not append profile image references', () => {
  const boards = [binding('hero', 'character', 'hero-board')]
  for (const visual_reference_mode of ['keyframe', 'text_only']) {
    assert.deepEqual(videoReferenceManifest(['shot'], boards, { ...options, visual_reference_mode }).map(entry => entry.asset_id), ['shot'])
  }
})

test('unconfirmed boards are omitted and long image lists are left intact for visible limit validation', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `image-${index}`)
  const manifest = videoReferenceManifest(ids, [binding('pending', 'character', null)], options)
  assert.equal(manifest.length, 10)
  assert.deepEqual(manifest.map(entry => entry.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('manifest construction leaves source arrays and binding objects unchanged', () => {
  const ids = ['shot', 'shared']
  const bindings = [binding('z', 'prop', 'shared'), binding('a', 'character', 'hero')]
  const expected = structuredClone({ ids, bindings })
  videoReferenceManifest(ids, bindings, options)
  assert.deepEqual({ ids, bindings }, expected)
})

test('each binding uses its frozen independent references instead of its board, preserving selected order and shared purposes', () => {
  const bindings = [binding('station', 'location', 'station-board', { reference_assets: [reference('reverse', 'reverse', 'space')] }),
    binding('hero', 'character', 'old-board', { reference_assets: [reference('face', 'face', 'identity'), reference('side', 'side', 'costume'), reference('face', 'detail', 'detail')] })]
  const before = structuredClone(bindings)
  const manifest = videoReferenceManifest(['shot', 'side'], bindings, options)
  assert.deepEqual(manifest.map(entry => [entry.asset_id, entry.index, entry.view, entry.reference_purpose]), [
    ['shot', 1, undefined, undefined], ['side', 2, 'side', 'costume'], ['face', 3, 'face', 'identity'], ['reverse', 4, 'reverse', 'space'],
  ])
  assert.deepEqual(manifest[2]!.reference_details!.map(detail => [detail.view, detail.purpose]), [['face', 'identity'], ['detail', 'detail']])
  assert.deepEqual(visualBindingReferenceAssetIds(bindings[1]!), ['face', 'side'])
  assert.deepEqual(manifest, videoReferenceManifest(['shot', 'side'], [...bindings].reverse(), options))
  assert.deepEqual(bindings, before)
})

test('only absent or empty snapshot selections fall back to legacy boards', () => {
  for (const reference_assets of [undefined, []]) {
    assert.deepEqual(visualBindingReferenceAssetIds(binding('hero', 'character', 'board', { reference_assets })), ['board'])
    assert.deepEqual(videoReferenceManifest([], [binding('hero', 'character', 'board', { reference_assets })], options).map(entry => entry.asset_id), ['board'])
  }
  assert.deepEqual(visualBindingReferenceAssetIds(binding('hero', 'character', null, { reference_assets: [reference('face', 'face', 'identity')] })), ['face'])
})

test('excluding a multi-image optional binding removes only its ownership and its unshared images', () => {
  const manifest = videoReferenceManifest(['shot', 'manual-shared'], [
    binding('required', 'character', null, { reference_assets: [reference('shared', 'face', 'identity')] }),
    binding('optional', 'prop', null, { required: false, reference_assets: [reference('shared', 'detail', 'structure'), reference('optional-only', 'detail', 'detail'), reference('manual-shared', 'front', 'structure')] }),
  ], { ...options, excluded_visual_profile_ids: ['optional', 'required'] })
  assert.deepEqual(manifest.map(entry => entry.asset_id), ['shot', 'manual-shared', 'shared'])
  assert.equal(manifest[1]!.purpose, 'manual')
  assert.deepEqual(manifest[1]!.profile_ids, [])
  assert.deepEqual(manifest[2]!.profile_ids, ['required'])
  assert.deepEqual(manifest[2]!.reference_details!.map(detail => detail.purpose), ['identity'])
  assert.equal(manifest[2]!.required, true)
})

test('annotating actual submitted images keeps their numbering and never appends unsubmitted snapshots or their legacy board', () => {
  const manifest = videoReferenceManifest(['side', 'legacy', 'shot'], [binding('hero', 'character', 'legacy', {
    reference_assets: [reference('face', 'face', 'identity'), reference('side', 'side', 'costume')],
  })], { ...options, append_profile_assets: false })
  assert.deepEqual(manifest.map(entry => [entry.asset_id, entry.index, entry.purpose]), [['side', 1, 'character'], ['legacy', 2, 'manual'], ['shot', 3, 'storyboard']])
  assert.equal(manifest[0]!.view, 'side')
  assert.equal(manifest[1]!.view, undefined)
  assert.deepEqual(manifest[1]!.profile_ids, [])
})

test('strict keyframe modes never attach independently selected profile images or their metadata', () => {
  const bindings = [binding('hero', 'character', 'old-board', { reference_assets: [reference('face', 'face', 'identity'), reference('side', 'side', 'costume')] })]
  for (const mode of ['first_frame', 'first_last_frame']) {
    const ids = mode === 'first_frame' ? ['face'] : ['face', 'ending']
    const manifest = videoReferenceManifest(ids, bindings, { mode, visual_reference_mode: 'profiles' })
    assert.deepEqual(manifest.map(entry => entry.asset_id), ids)
    assert.equal(manifest[0]!.purpose, 'first_frame')
    assert.equal(manifest[0]!.view, undefined)
    assert.deepEqual(manifest[0]!.profile_ids, [])
  }
})
