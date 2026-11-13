import test from 'node:test'
import assert from 'node:assert/strict'
import { recommendVisualReferences } from '@video-studio/shared/visuals/visual-reference-selection'
import type { VisualReferenceAsset } from '@video-studio/shared/visuals/visual-reference-types'

const reference = (id: string, view: VisualReferenceAsset['view'], patch: Partial<VisualReferenceAsset> = {}): VisualReferenceAsset => ({
  id, asset_id: `asset-${id}`, profile_id: 'linwan', revision: 3, style_version: 'anime', view,
  purpose: view === 'face' ? 'identity' : 'costume', label: id, status: 'confirmed', is_default: false,
  source_asset_id: null, source_job_id: null, created_at: '', updated_at: '', ...patch,
})

test('structured preferences use approved current-angle references and a face crop, not a candidate or stale view', () => {
  const refs = [reference('front', 'front', { is_default: true }), reference('side', 'side'), reference('face', 'face'),
    reference('old', 'side', { revision: 2, is_default: true }), reference('candidate', 'side', { status: 'candidate', is_default: true }),
    reference('old-style', 'side', { style_version: 'realistic', is_default: true })]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, { view: 'side' }, 'anime').map(item => item.id), ['face', 'side'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, undefined, 'anime').map(item => item.id), ['face', 'front'])
})

test('approved face and body images are preferred without a default; character layouts and unneeded angles stay out', () => {
  const refs = [reference('layout', 'layout', { is_default: true }), reference('side', 'side'), reference('front', 'front'),
    reference('back', 'back'), reference('face', 'face')]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, undefined, 'anime').map(item => item.id), ['face', 'front'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, { view: 'back' }, 'anime').map(item => item.id), ['back'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('face', 'face')], undefined, 'anime').map(item => item.id), ['face'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('layout', 'layout', { is_default: true })], undefined, 'anime'), [])
})

test('default body and face choices are respected without adding a visible face to a default back view', () => {
  const refs = [reference('front', 'front'), reference('side', 'side', { is_default: true }),
    reference('face', 'face'), reference('face-default', 'face', { is_default: true })]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, undefined, 'anime').map(item => item.id), ['face-default', 'side'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('back', 'back', { is_default: true }), ...refs.map(item => ({ ...item, is_default: false }))], undefined, 'anime').map(item => item.id), ['back'])
})

test('back shots use the back view without adding a conflicting visible face', () => {
  const refs = [reference('back', 'back'), reference('face', 'face')]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, { view: 'back' }, 'anime').map(item => item.id), ['back'])
})

test('scene reverse angles and prop details are matched independently and unmatched views require a default or board fallback', () => {
  const refs = [reference('reverse', 'reverse', { purpose: 'space' }), reference('wide', 'wide', { purpose: 'space' }), reference('detail', 'detail', { purpose: 'detail' })]
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, { view: 'reverse' }, 'anime').map(item => item.id), ['reverse'])
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, { view: 'wide' }, 'anime').map(item => item.id), ['wide'])
  assert.deepEqual(recommendVisualReferences({ kind: 'prop', revision: 3 }, refs, { view: 'detail' }, 'anime').map(item => item.id), ['detail'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, { view: 'side' }, 'anime'), [])
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, undefined, 'anime'), [])
})


test('legacy prose and negated camera descriptions cannot override confirmed defaults', () => {
  const refs = [reference('front', 'front', { is_default: true }), reference('back', 'back'), reference('face', 'face')]
  for (const text of ['不要背面，正脸近景。', '镜中映出背影，实际镜头从正面拍。', '背面有一道划痕。']) {
    // A legacy caller may still supply prose at runtime; no semantic parser runs.
    const legacy = text as unknown as Parameters<typeof recommendVisualReferences>[2]
    assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, legacy, 'anime').map(item => item.id), ['face', 'front'])
  }
})
