import assert from 'node:assert/strict'
import { test } from 'node:test'
import { videoReferenceManifest, type VideoReferenceBinding } from '../../backend/src/video-reference-manifest'

const options = { mode: 'reference', visual_reference_mode: 'profiles', storyboard_reference_asset_id: 'shot' }
const binding = (profile_id: string, kind: VideoReferenceBinding['kind'], board_asset_id: string | null, overrides: Partial<VideoReferenceBinding> = {}): VideoReferenceBinding => ({
  profile_id, kind, board_asset_id, name: profile_id, variant: '默认', required: true, ...overrides,
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
