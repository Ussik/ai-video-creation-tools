import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { videoRatioOptions, videoResolutionOptions, videoRatios, videoResolutions } from '../src/video-parameters.js'

const testData = await mkdtemp(join(tmpdir(), 'video-generation-parameters-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

test('video presets include all requested choices and preserve configured spelling and custom values', () => {
  assert.deepEqual(videoResolutionOptions(), videoResolutions)
  assert.deepEqual(videoRatioOptions(), videoRatios)
  assert.deepEqual(videoResolutionOptions({ resolutions: ['720P', '4K', '4k', ' 8K ', '8k', null, 480] }),
    ['480p', '720P', '1080p', '4K', '8K'])
  assert.deepEqual(videoRatioOptions({ ratios: ['16:9', '32:9', '32:9', ' ', false] }), [...videoRatios, '32:9'])
})

test('video preview allows selected standard options beyond old local lists and retains image validation', async () => {
  async function create(url: string, payload: unknown) {
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { id: string }
  }
  const provider = await create('/api/providers', { name: '测试提供商', adapter: 'http', base_url: 'https://provider.invalid/v1' })
  const project = await create('/api/projects', { name: '视频参数测试' })
  const video = await create('/api/models', { provider_id: provider.id, name: '旧配置视频', remote_id: 'configured-video',
    modality: 'video', protocol: 'async_video', settings: {
      create_path: 'tasks', get_path: 'tasks/{id}',
      supported_modes: ['text'], ratios: ['16:9', '32:9'], resolutions: ['480p', '720p', '8K'],
      request_template: { prompt: '{{prompt}}', ratio: '{{ratio}}', resolution: '{{resolution}}' },
    } })
  const preview = (model_id: string, resolution: string, ratio: string) => app.inject({ method: 'POST',
    url: `/api/projects/${project.id}/generate/preview`, payload: { model_id, prompt: '夜晚的街道', resolution, ratio } })
  for (const ratio of videoRatios) {
    const response = await preview(video.id, '1080p', ratio)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().ratio, ratio)
    assert.equal(response.json().resolution, '1080p')
  }
  for (const resolution of ['4k', '4K', '8K']) {
    const response = await preview(video.id, resolution, '32:9')
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().resolution, resolution)
    assert.equal(response.json().ratio, '32:9')
  }
  assert.equal((await preview(video.id, 'unconfigured', '16:9')).statusCode, 422)
  assert.equal((await preview(video.id, '480p', '7:5')).statusCode, 422)
  const image = await create('/api/models', { provider_id: provider.id, name: '图片', remote_id: 'configured-image',
    modality: 'image', protocol: 'image_generations', settings: { request_path: 'images/generations', image_base64_path: 'data.0.b64_json',
      ratios: ['16:9'], resolutions: ['1K'], request_template: { prompt: '{{prompt}}' } } })
  assert.equal((await preview(image.id, '1080p', '16:9')).statusCode, 422)
  assert.equal((await preview(image.id, '1K', '9:16')).statusCode, 422)
})
