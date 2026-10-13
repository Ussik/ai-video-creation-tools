import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { imagesApiSettings } from '@video-studio/shared/models/images-api-settings'
import { documentedImageSettings } from '@video-studio/shared/models/documented-images-api'

const testData = await mkdtemp(join(tmpdir(), 'provider-settings-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'POST' | 'GET' | 'PATCH', url: string, payload?: object) {
  const result = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
async function setup() {
  const project = await call('POST', '/api/projects', { name: '提供商名称测试' })
  const provider = await call('POST', '/api/providers', { name: '原名称', base_url: 'https://example.invalid/v1', api_key: 'test-provider-key' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '文本模型', remote_id: 'text', modality: 'text', protocol: 'responses',
    settings: { request_path: 'responses', text_path: 'output_text', request_template: { model: '{{model}}', input: '{{prompt}}' } } })
  run('INSERT INTO jobs (id, project_id, model_id, job_type, request, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `job-${provider.id}`, project.id, model.id, 'generation', '{"prompt":"保留任务请求"}', 'queued', now(), now())
  return { provider, model, jobId: `job-${provider.id}` }
}

test('provider names can change during queued and running jobs without changing connection or model bindings', async () => {
  const { provider, model, jobId } = await setup()
  const before = one<Record<string, unknown>>('SELECT * FROM providers WHERE id=?', provider.id)!
  for (const status of ['queued', 'running']) {
    run('UPDATE jobs SET status=? WHERE id=?', status, jobId)
    const renamed = await call('PATCH', `/api/providers/${provider.id}`, { name: `  新名称-${status}  ` })
    assert.equal(renamed.name, `新名称-${status}`)
    assert.equal(renamed.id, provider.id)
    assert.equal(renamed.has_key, true)
    const after = one<Record<string, unknown>>('SELECT * FROM providers WHERE id=?', provider.id)!
    assert.deepEqual({ ...after, name: before.name }, before)
    assert.equal(one<{ provider_id: string }>('SELECT provider_id FROM models WHERE id=?', model.id)!.provider_id, provider.id)
    assert.deepEqual(one('SELECT status, request FROM jobs WHERE id=?', jobId), { status, request: '{"prompt":"保留任务请求"}' })
  }
  assert.equal((await call('GET', '/api/providers')).find((item: { id: string }) => item.id === provider.id).name, '新名称-running')
})

test('active-job connection restrictions and provider name validation still apply', async () => {
  const { provider } = await setup()
  const before = one<Record<string, unknown>>('SELECT * FROM providers WHERE id=?', provider.id)!
  for (const payload of [{ name: '' }, { name: 'x'.repeat(121) }, { name: '改名并改连接', base_url: 'https://changed.invalid/v1' }, { api_key: 'replacement' }, { enabled: false }]) {
    const response = await app.inject({ method: 'PATCH', url: `/api/providers/${provider.id}`, payload })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(one('SELECT * FROM providers WHERE id=?', provider.id), before)
  }
})

test('image settings validate upload transport, relative paths, timeout and pixel sizes before saving', async () => {
  const { provider } = await setup()
  const input = { provider_id: provider.id, name: '图片', remote_id: 'any-model', modality: 'image', protocol: 'image_generations' }
  const settings = imagesApiSettings()
  const created = await call('POST', '/api/models', { ...input, settings })
  assert.equal(created.settings.image_reference_transport, 'multipart')
  assert.equal(created.settings.request_timeout_seconds, 600)
  for (const patch of [{ request_timeout_seconds: 29 }, { request_timeout_seconds: 1801 }, { request_timeout_seconds: '600' },
    { image_reference_transport: 'invalid' }, { image_reference_path: 'https://other.invalid/images/edits' },
    { compress_reference_images: 'yes' }, { image_size_mode: 'pixels', resolutions: ['16:9'] }]) {
    const response = await app.inject({ method: 'PATCH', url: `/api/models/${created.id}`, payload: { settings: { ...settings, ...patch } } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(JSON.parse(one<{ settings: string }>('SELECT settings FROM models WHERE id=?', created.id)!.settings), settings)
  }
})

test('documented image models reject sync, auto sizes, incorrect task addresses and unsupported request fields', async () => {
  const { provider } = await setup()
  const settings = documentedImageSettings({}, provider.base_url)
  const created = await call('POST', '/api/models', { provider_id: provider.id, name: '文档图片', remote_id: 'free-model-id', modality: 'image', protocol: 'image_generations', settings })
  assert.equal(created.settings.api_base_url, 'https://example.invalid/draw/v1')
  assert.equal(created.settings.image_task_base_url, 'https://example.invalid/v1')
  for (const patch of [{ async_image: false }, { image_size_mode: 'auto' }, { get_path: 'images/tasks/{id}' },
    { image_reference_transport: 'multipart', image_reference_field: 'image[]' },
    { image_reference_transport: 'multipart', image_reference_path: 'images/generations' },
    { image_task_base_url: 'file:///tmp/tasks' }, { image_task_base_url: 'https://example.invalid/draw/v1' }, { image_task_base_url: 42 }, { image_base64_path: 'data.0.b64_json' },
    { image_clarity_parameter: true, default_clarity: '8K' }, { poll_seconds: 0 },
    { request_template: { ...(settings.request_template as object), mask: '{{image}}' } },
    { request_template: { ...(settings.request_template as object), async: false } }]) {
    const response = await app.inject({ method: 'PATCH', url: `/api/models/${created.id}`, payload: { settings: { ...settings, ...patch } } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(JSON.parse(one<{ settings: string }>('SELECT settings FROM models WHERE id=?', created.id)!.settings), settings)
  }
})
