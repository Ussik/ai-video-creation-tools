import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Model, Provider } from '../src/shared/api/api'
import { videoGenerationDurationMs, videoReviewModels, videoReviewTime } from '../src/features/canvas/canvas-video-review'

test('review model choices require explicitly configured visual capability and available provider', () => {
  const provider = { id: 'provider', adapter: 'http', enabled: true } as Provider
  const model = { id: 'native', name: '原生视频', provider_id: 'provider', modality: 'text', enabled: true, protocol: 'chat_completions', settings: { supports_video: true } } as Model
  assert.deepEqual(videoReviewModels([model], [provider]), [{ id: 'native', label: '原生视频 · 视频理解', inputMode: 'native_video' }])
  assert.deepEqual(videoReviewModels([{ ...model, protocol: 'responses' }], [provider]), [])
  assert.deepEqual(videoReviewModels([{ ...model, protocol: 'responses', settings: { supports_vision: true } }], [provider])[0].inputMode, 'sampled_frames')
  assert.deepEqual(videoReviewModels([{ ...model, settings: {} }], [provider]), [])
  assert.deepEqual(videoReviewModels([model], [{ ...provider, enabled: false }]), [])
  assert.deepEqual(videoReviewModels([model], [{ ...provider, adapter: 'demo' }]), [])
})

test('review choices carry the default flag only after capability and provider filtering', () => {
  const provider = { id: 'provider', adapter: 'http', enabled: true } as Provider
  const model = { id: 'default', name: '默认文本模型', provider_id: 'provider', modality: 'text', enabled: true,
    is_default: true, protocol: 'responses', settings: { supports_vision: true } } as Model
  assert.equal(videoReviewModels([model], [provider])[0].is_default, true)
  assert.deepEqual(videoReviewModels([{ ...model, settings: {} }], [provider]), [])
  assert.deepEqual(videoReviewModels([model], [{ ...provider, enabled: false }]), [])
})

test('explicit Doubao Responses video capability uses native media without inferring image support', () => {
  const provider = { id: 'provider', adapter: 'http', enabled: true } as Provider
  const model = { id: 'doubao', name: '豆包视频理解', provider_id: 'provider', modality: 'text', enabled: true, protocol: 'responses',
    settings: { supports_video: true, video_input_format: 'doubao_ark' } } as Model
  const expected = [{ id: model.id, label: `${model.name} · 视频理解`, inputMode: 'native_video' }]
  assert.deepEqual(videoReviewModels([model], [provider]), expected)
  assert.deepEqual(videoReviewModels([{ ...model, settings: { ...model.settings, supports_vision: true } }], [provider]), expected)
  assert.deepEqual(videoReviewModels([{ ...model, settings: { supports_video: true } }], [provider]), [])
})

test('evidence timestamps retain tenths and do not become negative', () => {
  assert.equal(videoReviewTime(1200), '0:01.2')
  assert.equal(videoReviewTime(62_500), '1:02.5')
  assert.equal(videoReviewTime(-3), '0:00.0')
})

test('generation duration comes from the matching recorded request independently of edit duration', () => {
  assert.equal(videoGenerationDurationMs('video', [{ result_asset_id: 'other', request: '{"duration":8}' }, { result_asset_id: 'video', request: '{"duration":4}' }]), 4000)
  assert.equal(videoGenerationDurationMs('video', [{ result_asset_id: 'video', request: '{broken' }]), undefined)
  assert.equal(videoGenerationDurationMs('video', [{ result_asset_id: 'video', request: '{"duration":"4"}' }]), undefined)
})
