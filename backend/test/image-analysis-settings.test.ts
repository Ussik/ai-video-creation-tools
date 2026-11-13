import assert from 'node:assert/strict'
import { test } from 'node:test'
import { geminiImageAnalysisConfig, imageAnalysisConfigError, supportsImagePromptAnalysis } from '@video-studio/shared/models/image-analysis-settings'
import { validateSettings } from '../src/modules/models/validation.js'

const config = { enabled: true, protocol: 'gemini_generate_content' }

test('analysis selection is capability based across text and image models, including persisted JSON settings', () => {
  for (const protocol of ['responses', 'chat_completions']) {
    assert.equal(supportsImagePromptAnalysis({ modality: 'text', protocol, settings: { supports_vision: true } }), true)
  }
  assert.equal(supportsImagePromptAnalysis({ modality: 'image', protocol: 'image_generations', settings: JSON.stringify({ image_analysis: config }) }), true)
  assert.deepEqual(geminiImageAnalysisConfig({ image_analysis: config }), { ...config, request_path: 'models/{model}:generateContent' })
  for (const settings of [{}, { supports_vision: true }, { image_analysis: { ...config, enabled: false } },
    { image_analysis: { enabled: true, protocol: 'images_api' } }, 'broken-json', '[]', 'null']) {
    assert.equal(supportsImagePromptAnalysis({ modality: 'image', protocol: 'image_generations', settings }), false)
  }
  assert.equal(supportsImagePromptAnalysis({ modality: 'text', protocol: 'image_generations', settings: { supports_vision: true } }), false)
  assert.equal(supportsImagePromptAnalysis({ modality: 'text', protocol: 'responses', settings: { supports_vision: 'true' } }), false)
  assert.equal(supportsImagePromptAnalysis({ modality: 'video', protocol: 'async_video', settings: { image_analysis: config } }), false)
})

test('Gemini analysis endpoints are separate from image generation endpoints and accept a fixed relative path', () => {
  const settings = { api_base_url: 'https://drawing.invalid/draw/v1', request_path: 'images/generations',
    image_analysis: { ...config, api_base_url: ' https://vision.invalid/v1beta/ ', remote_id: ' gemini-image ', request_path: 'models/fixed-model:generateContent' } }
  assert.equal(imageAnalysisConfigError(settings), null)
  assert.deepEqual(geminiImageAnalysisConfig(settings), { ...config, api_base_url: 'https://vision.invalid/v1beta/',
    remote_id: 'gemini-image', request_path: 'models/fixed-model:generateContent' })
  assert.equal(settings.api_base_url, 'https://drawing.invalid/draw/v1')
  assert.equal(settings.request_path, 'images/generations')
})

test('invalid analysis config cannot enable a model or save credential/query/path mistakes', () => {
  const invalid = [null, [], true, JSON.stringify(config), {}, { ...config, enabled: 'true' }, { enabled: true },
    { ...config, request_path: '' }, { ...config, remote_id: '' }, { ...config, api_base_url: 42 },
    { ...config, api_base_url: 'file:///tmp/vision' }, { ...config, api_base_url: 'https://user:password@vision.invalid/v1beta' },
    { ...config, api_base_url: 'https://vision.invalid/v1beta?key=secret' }, { ...config, api_base_url: 'https://vision.invalid/v1beta#fragment' },
    { ...config, request_path: '/models/{model}:generateContent' }, { ...config, request_path: '../outside' },
    { ...config, request_path: 'models/%2e%2e/endpoint' }, { ...config, request_path: 'https://other.invalid/api' },
    { ...config, request_path: 'models/{model}:generateContent?key=secret' }, { ...config, request_path: 'models/{unknown}:generateContent' },
    { ...config, unexpected: true }]
  for (const image_analysis of invalid) {
    const settings = { image_analysis }
    assert.ok(imageAnalysisConfigError(settings), JSON.stringify(image_analysis))
    assert.equal(geminiImageAnalysisConfig(settings), null)
    assert.equal(supportsImagePromptAnalysis({ modality: 'image', settings }), false)
  }
})

test('model validation preserves old settings and confines analysis config to image models', () => {
  const image = { request_path: 'images/generations', request_template: { prompt: '{{prompt}}' }, image_url_path: 'data.0.url' }
  const text = { request_path: 'responses', request_template: { input: '{{prompt}}' }, text_path: 'output_text' }
  const video = { create_path: 'tasks', get_path: 'tasks/{id}', request_template: { prompt: '{{prompt}}' } }
  assert.doesNotThrow(() => validateSettings('image', image, 'image_generations'))
  assert.doesNotThrow(() => validateSettings('image', { ...image, image_analysis: config }, 'image_generations'))
  assert.doesNotThrow(() => validateSettings('text', text, 'responses'))
  assert.doesNotThrow(() => validateSettings('video', video, 'async_video'))
  assert.throws(() => validateSettings('text', { ...text, image_analysis: config }, 'responses'), /仅适用于图片模型/)
  assert.throws(() => validateSettings('video', { ...video, image_analysis: config }, 'async_video'), /仅适用于图片模型/)
  assert.throws(() => validateSettings('image', { ...image, image_analysis: { ...config, enabled: 'true' } }, 'image_generations'), /布尔值/)
})
