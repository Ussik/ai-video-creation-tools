import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportsDoubaoVideoAnalysis, videoInputConfigError } from '@video-studio/shared/models/video-analysis-settings'
import { validateSettings } from '../src/modules/models/validation.js'

const settings = { supports_video: true, video_input_format: 'doubao_ark' }
test('Doubao video analysis is an explicit text-model transport capability, not a model-name guess', () => {
  for (const protocol of ['responses', 'chat_completions']) {
    assert.equal(supportsDoubaoVideoAnalysis({ modality: 'text', protocol, settings }), true)
    assert.equal(supportsDoubaoVideoAnalysis({ modality: 'text', protocol, settings: JSON.stringify(settings) }), true)
  }
  for (const model of [
    { modality: 'text', protocol: 'responses', settings: {} },
    { modality: 'text', protocol: 'responses', settings: { supports_vision: true } },
    { modality: 'text', protocol: 'responses', settings: { ...settings, supports_video: 'true' } },
    { modality: 'text', protocol: 'responses', settings: { ...settings, supports_video: false } },
    { modality: 'image', protocol: 'responses', settings },
    { modality: 'video', protocol: 'async_video', settings },
    { modality: 'text', protocol: 'unknown', settings },
    { modality: 'text', protocol: 'responses', settings: '{' },
  ]) assert.equal(supportsDoubaoVideoAnalysis(model), false)
})

test('video format settings reject unknown formats and preserve generic defaults', () => {
  assert.equal(videoInputConfigError({}), null)
  assert.equal(videoInputConfigError(settings), null)
  assert.equal(videoInputConfigError({ video_input_format: 'chat_video_url' }), null)
  for (const video_input_format of ['unknown', ['doubao_ark'], {}, null, 1]) assert.match(videoInputConfigError({ video_input_format })!, /视频输入格式/)
  assert.ok(videoInputConfigError('bad json'))
  const base = { request_path: 'responses', request_template: {}, text_path: 'output.0.content.0.text' }
  assert.doesNotThrow(() => validateSettings('text', { ...base, ...settings }))
  assert.throws(() => validateSettings('text', { ...base, video_input_format: 'unknown' }), /视频输入格式/)
  assert.throws(() => validateSettings('image', { ...base, video_input_format: 'doubao_ark' }), /仅适用于文本模型/)
})
