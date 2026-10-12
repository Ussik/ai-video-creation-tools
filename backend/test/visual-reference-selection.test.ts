import test from 'node:test'
import assert from 'node:assert/strict'
import { recommendVisualReferences } from '@video-studio/shared/visuals/visual-reference-selection'
import type { VisualReferenceAsset } from '@video-studio/shared/visuals/visual-reference-types'

const reference = (id: string, view: VisualReferenceAsset['view'], patch: Partial<VisualReferenceAsset> = {}): VisualReferenceAsset => ({
  id, asset_id: `asset-${id}`, profile_id: 'linwan', revision: 3, style_version: 'anime', view,
  purpose: view === 'face' ? 'identity' : 'costume', label: id, status: 'confirmed', is_default: false,
  source_asset_id: null, source_job_id: null, created_at: '', updated_at: '', ...patch,
})

test('camera suggestions use approved current-angle references and a face crop, not a candidate or stale view', () => {
  const refs = [reference('front', 'front', { is_default: true }), reference('side', 'side'), reference('face', 'face'),
    reference('old', 'side', { revision: 2, is_default: true }), reference('candidate', 'side', { status: 'candidate', is_default: true }),
    reference('old-style', 'side', { style_version: 'realistic', is_default: true })]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '林晚侧面近景', 'anime').map(item => item.id), ['face', 'side'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '林晚低头说话', 'anime').map(item => item.id), ['face', 'front'])
})

test('approved face and body images are preferred without a default; character layouts and unneeded angles stay out', () => {
  const refs = [reference('layout', 'layout', { is_default: true }), reference('side', 'side'), reference('front', 'front'),
    reference('back', 'back'), reference('face', 'face')]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '林晚低头说话', 'anime').map(item => item.id), ['face', 'front'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '林晚背影离开', 'anime').map(item => item.id), ['back'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('face', 'face')], '林晚低头说话', 'anime').map(item => item.id), ['face'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('layout', 'layout', { is_default: true })], '林晚低头说话', 'anime'), [])
})

test('default body and face choices are respected without adding a visible face to a default back view', () => {
  const refs = [reference('front', 'front'), reference('side', 'side', { is_default: true }),
    reference('face', 'face'), reference('face-default', 'face', { is_default: true })]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '林晚低头说话', 'anime').map(item => item.id), ['face-default', 'side'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, [reference('back', 'back', { is_default: true }), ...refs.map(item => ({ ...item, is_default: false }))], '林晚离开', 'anime').map(item => item.id), ['back'])
})

test('back shots use the back view without adding a conflicting visible face', () => {
  const refs = [reference('back', 'back'), reference('face', 'face')]
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '从背后拍摄林晚的背影', 'anime').map(item => item.id), ['back'])
})

test('scene reverse angles and prop details are matched independently and unmatched views require a default or board fallback', () => {
  const refs = [reference('reverse', 'reverse', { purpose: 'space' }), reference('wide', 'wide', { purpose: 'space' }), reference('detail', 'detail', { purpose: 'detail' })]
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, '切到客厅反打', 'anime').map(item => item.id), ['reverse'])
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, '场景全景', 'anime').map(item => item.id), ['wide'])
  assert.deepEqual(recommendVisualReferences({ kind: 'prop', revision: 3 }, refs, '给到项链细节特写', 'anime').map(item => item.id), ['detail'])
  assert.deepEqual(recommendVisualReferences({ kind: 'character', revision: 3 }, refs, '人物侧面', 'anime'), [])
  assert.deepEqual(recommendVisualReferences({ kind: 'location', revision: 3 }, refs, '室内', 'anime'), [])
})
