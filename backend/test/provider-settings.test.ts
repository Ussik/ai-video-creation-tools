import { seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { imagesApiSettings } from '@video-studio/shared/models/images-api-settings'
import { documentedImageSettings } from '@video-studio/shared/models/documented-images-api'
import { standardTextSettings } from '@video-studio/shared/models/text-api-settings'
import { semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'

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


test('standard model settings reach shared creative entrypoints and ignore discovery from another channel', async t => {
  const provider = await call('POST', '/api/providers', { name: '标准创作渠道', base_url: 'https://standard-creative.invalid/v1' })
  const project = await call('POST', '/api/projects', { name: '标准接口真实入口' })
  const settings = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 4096 },
    text_capabilities: { version: 1, discovered: { source: 'provider', scope: { base_url: 'https://old-channel.invalid/v1', protocol: 'chat_completions', remote_id: 'actual' },
      fetched_at: new Date().toISOString(), limits: { budget_mode: 'separate', output_tokens: 1000 } } } }
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '标准创作', remote_id: 'actual', modality: 'text', protocol: 'chat_completions', settings })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls++; assert.equal(String(url), 'https://standard-creative.invalid/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    assert.equal(body.model, 'actual'); assert.equal(body.max_completion_tokens, 4096)
    const value = body.response_format?.json_schema?.name === 'prompt_refinement_semantic_review'
      ? semanticReviewFixture() : { prompt: '主角在雨后的走廊等待门开。' }
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
  })
  const result = await call('POST', `/api/projects/${project.id}/skills/refine-prompt`, { model_id: model.id,
    stage: 'image_prompt', prompt: '主角在走廊等待门开。', adjustment_request: '补充雨后环境', skill_ids: [] })
  assert.equal(calls, 2, 'generation and semantic review both use the configured standard channel'); assert.match(result.prompt, /雨后/)
})

test('standard text forms persist canonical options through create, PATCH protocol switches and catalog import', async () => {
  const provider = await call('POST', '/api/providers', { name: '标准表单', base_url: 'https://fixture.invalid/v1' })
  const settings = { text_api: { mode: 'standard', max_output_tokens: 65_536, chat_output_field: 'max_tokens', reasoning_effort: 'high', thinking: 'disabled' },
    context_window_tokens: 1_000_000, output_reserve_tokens: 1000, pricing: { per_generation: 0.1 }, supports_vision: true }
  const created = await call('POST', '/api/models', { provider_id: provider.id, name: '标准文本', remote_id: 'arbitrary-model', modality: 'text', protocol: 'responses', settings })
  assert.deepEqual(created.settings, settings)
  const switched = await call('PATCH', `/api/models/${created.id}`, { protocol: 'chat_completions' })
  assert.deepEqual(switched.settings, settings)
  const restored = await call('PATCH', `/api/models/${created.id}`, { protocol: 'responses', name: '标准文本改名' })
  assert.deepEqual(restored.settings, settings)
  const cleared = { ...settings, ...standardTextSettings('responses') }
  assert.deepEqual((await call('PATCH', `/api/models/${created.id}`, { settings: cleared })).settings, cleared)
  const imported = await call('POST', `/api/providers/${provider.id}/model-catalog/import`, { models: [
    { remote_id: 'catalog-chat', modality: 'text', protocol: 'chat_completions', enabled: true, settings: standardTextSettings('chat_completions') },
    { remote_id: 'catalog-responses', modality: 'text', protocol: 'responses', enabled: true, settings: standardTextSettings('responses') },
  ] })
  assert.equal(imported.imported.length, 2)
  for (const model of imported.imported) assert.deepEqual(model.settings, { text_api: { mode: 'standard' } })
})


test('invalid managed options are rejected before model persistence; custom templates remain editable', async () => {
  const provider = await call('POST', '/api/providers', { name: '校验', base_url: 'https://fixture.invalid/v1' })
  const settings = standardTextSettings('responses')
  const created = await call('POST', '/api/models', { provider_id: provider.id, name: '校验文本', remote_id: 'fixture', modality: 'text', protocol: 'responses', settings })
  for (const settings of [
    { text_api: { mode: 'standard', max_output_tokens: -1 } },
    { text_api: { mode: 'standard', request_parameters: { max_tokens: 4000 } } },
    { text_api: { mode: 'standard' }, request_path: 'override' },
    { text_api: { mode: 'standard', max_output_tokens: 1000 }, context_window_tokens: 1000 },
  ]) {
    const rejected = await app.inject({ method: 'PATCH', url: `/api/models/${created.id}`, payload: { settings } })
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.deepEqual(JSON.parse(one<{ settings: string }>('SELECT settings FROM models WHERE id=?', created.id)!.settings), { text_api: { mode: 'standard' } })
  }
  const custom = { text_api: { mode: 'custom' }, request_path: 'custom/text', request_template: { prompt: '{{prompt}}', max_tokens: 8000 }, text_path: 'answer' }
  assert.deepEqual((await call('PATCH', `/api/models/${created.id}`, { settings: custom })).settings, custom)
  const video = { ...seedance2VideoSettings(), default_duration: 12, default_ratio: '9:16', default_resolution: '720p' }
  const videoModel = await call('POST', '/api/models', { provider_id: provider.id, name: '视频默认参数', remote_id: 'video', modality: 'video', protocol: 'async_video', settings: video })
  for (const patch of [{ default_duration: 200 }, { default_duration: 3 }, { default_ratio: 'invalid' }, { default_resolution: '4K' }]) {
    const rejected = await app.inject({ method: 'PATCH', url: `/api/models/${videoModel.id}`, payload: { settings: { ...video, ...patch } } })
    assert.equal(rejected.statusCode, 422, rejected.body)
  }
})
