import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { standardTextSettings } from '@video-studio/shared/models/text-api-settings'

const testData = await mkdtemp(join(tmpdir(), 'provider-configuration-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { decryptKey } = await import('../src/infrastructure/security/secrets.js')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'POST' | 'GET' | 'PUT' | 'PATCH', url: string, payload?: object) {
  const result = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
const textModel = (remote_id: string, extra: Record<string, unknown> = {}) => ({
  name: remote_id, remote_id, modality: 'text', protocol: 'responses', settings: standardTextSettings('responses'), ...extra,
})
async function fixture(models = [textModel('first'), textModel('second')]) {
  return call('POST', '/api/providers/configuration', {
    provider: { name: '整卡保存', base_url: 'https://saved.invalid/v1', api_key: 'saved-fixture-key', protocol: 'responses' }, models,
  })
}
const snapshot = (id: string) => ({ provider: one('SELECT * FROM providers WHERE id=?', id), models: all('SELECT * FROM models WHERE provider_id=? ORDER BY id', id) })

test('legacy provider protocols stay unset and individual provider APIs persist explicit defaults', async () => {
  const provider = await call('POST', '/api/providers', { name: '旧配置', base_url: 'https://fixture.invalid/v1' })
  assert.equal(provider.protocol, null)
  for (const protocol of ['chat_completions', 'responses', 'anthropic_messages', null]) {
    const changed = await call('PATCH', `/api/providers/${provider.id}`, { protocol })
    assert.equal(changed.protocol, protocol)
    assert.equal(one<{ protocol: string | null }>('SELECT protocol FROM providers WHERE id=?', provider.id)!.protocol, protocol)
  }
})

test('one create/save persists the entire catalog order, encrypts keys and retains untouched legacy model fields', async () => {
  const custom = { text_api: { mode: 'custom' }, request_path: 'custom/endpoint', text_path: 'answer',
    request_template: { prompt: '{{prompt}}', vendor: { retained: true }, max_tokens: 8192 },
    stream_request_template: { prompt: '{{prompt}}', max_tokens: 4096 }, pricing: { per_generation: 0.2 }, supports_vision: true }
  const created = await fixture([textModel('last', { settings: custom }), textModel('first'), textModel('removed')])
  assert.equal(created.provider.protocol, 'responses')
  assert.equal(created.provider.has_key, true)
  assert.ok(!JSON.stringify(created).includes('saved-fixture-key'))
  const ciphertext = one<{ key_ciphertext: string }>('SELECT key_ciphertext FROM providers WHERE id=?', created.provider.id)!.key_ciphertext
  assert.equal(decryptKey(ciphertext), 'saved-fixture-key')
  assert.deepEqual(created.models.map((model: { remote_id: string; sort_order: number }) => [model.remote_id, model.sort_order]), [['last', 0], ['first', 1], ['removed', 2]])
  await app.inject({ method: 'PUT', url: `/api/models/${created.models[0].id}/default` })
  const saved = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { name: '新名称', protocol: 'chat_completions' },
    models: [{ id: created.models[1].id, name: '重命名' }, { id: created.models[0].id }, textModel('new')],
  })
  assert.deepEqual(saved.models.map((model: { remote_id: string; sort_order: number }) => [model.remote_id, model.sort_order]), [['first', 0], ['last', 1], ['new', 2]])
  assert.equal(saved.models[0].name, '重命名')
  assert.deepEqual(saved.models[1].settings, custom)
  assert.equal(saved.models[1].protocol, 'responses', 'provider protocol is a default, not a bulk model rewrite')
  assert.equal(saved.models[1].is_default, true)
  assert.equal(one('SELECT id FROM models WHERE id=?', created.models[2].id), undefined)
  assert.equal(one<{ key_ciphertext: string }>('SELECT key_ciphertext FROM providers WHERE id=?', created.provider.id)!.key_ciphertext, ciphertext)
  const listed = (await call('GET', '/api/models')).filter((model: { provider_id: string }) => model.provider_id === created.provider.id)
  assert.deepEqual(listed.map((model: { id: string }) => model.id), saved.models.map((model: { id: string }) => model.id))
})

test('configuration updates reject malformed rows, duplicates, foreign IDs and unknown fields without partial writes', async () => {
  const created = await fixture()
  const foreign = await fixture([textModel('foreign')])
  const before = snapshot(created.provider.id)
  for (const body of [
    { provider: { name: '不应保存' }, models: [{ id: created.models[0].id }, { id: 'missing' }] },
    { provider: { name: '不应保存' }, models: [{ id: foreign.models[0].id }] },
    { provider: {}, models: [{ id: created.models[0].id }, { id: created.models[0].id }] },
    { provider: {}, models: [textModel('duplicate'), textModel('duplicate')] },
    { provider: {}, models: [{ name: 'incomplete' }] },
    { provider: {}, models: [textModel('invalid', { protocol: 'async_video' })] },
    { provider: {}, models: [textModel('invalid', { settings: { text_api: { mode: 'standard', max_output_tokens: -1 } } })] },
    { provider: { name: '不应保存', protocol: 'invalid' }, models: [] },
    { provider: { key_ciphertext: 'injected' }, models: [] },
    { provider: {}, models: [{ id: created.models[0].id, provider_id: foreign.provider.id }] },
    { provider: {}, models: [{ id: created.models[0].id, is_default: true }] },
    { provider: {}, models: [], unexpected: true },
  ]) {
    const rejected = await app.inject({ method: 'PUT', url: `/api/providers/${created.provider.id}/configuration`, payload: body })
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.deepEqual(snapshot(created.provider.id), before)
  }
})

test('a database write failure rolls back provider, key, deletions, updates and additions together', async () => {
  const created = await fixture()
  const before = snapshot(created.provider.id)
  db.exec("CREATE TEMP TRIGGER reject_configuration_fixture BEFORE INSERT ON models WHEN NEW.remote_id='rollback-fixture' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  try {
    const failed = await app.inject({ method: 'PUT', url: `/api/providers/${created.provider.id}/configuration`, payload: {
      provider: { name: '不应保存', api_key: 'replacement-fixture-key' },
      models: [{ id: created.models[0].id, name: '不应保存' }, textModel('rollback-fixture')],
    } })
    assert.equal(failed.statusCode, 500, failed.body)
    assert.deepEqual(snapshot(created.provider.id), before)
  } finally { db.exec('DROP TRIGGER reject_configuration_fixture') }
  const providerCount = all('SELECT id FROM providers').length
  const rejected = await app.inject({ method: 'POST', url: '/api/providers/configuration', payload: {
    provider: { name: '不应创建', base_url: 'https://fixture.invalid/v1' }, models: [textModel('broken', { settings: {} })],
  } })
  assert.equal(rejected.statusCode, 422, rejected.body)
  assert.equal(all('SELECT id FROM providers').length, providerCount)
})

test('running tasks block connection/model mutations and deletion while safe catalog ordering and provider naming remain usable', async () => {
  const created = await fixture()
  const project = await call('POST', '/api/projects', { name: '正在执行' })
  run('INSERT INTO jobs (id, project_id, model_id, job_type, request, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `configuration-job-${created.provider.id}`, project.id, created.models[0].id, 'generation', '{}', 'running', now(), now())
  const before = snapshot(created.provider.id)
  for (const body of [
    { provider: { base_url: 'https://changed.invalid/v1' }, models: created.models.map((model: { id: string }) => ({ id: model.id })) },
    { provider: { api_key: 'changed-key' }, models: created.models.map((model: { id: string }) => ({ id: model.id })) },
    { provider: {}, models: [{ id: created.models[0].id, name: '改动任务模型' }, { id: created.models[1].id }] },
    { provider: {}, models: [{ id: created.models[1].id }] },
  ]) {
    const rejected = await app.inject({ method: 'PUT', url: `/api/providers/${created.provider.id}/configuration`, payload: body })
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.deepEqual(snapshot(created.provider.id), before)
  }
  const safe = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { name: '可改显示名', base_url: created.provider.base_url, protocol: created.provider.protocol },
    models: [{ id: created.models[1].id }, { id: created.models[0].id }],
  })
  assert.equal(safe.provider.name, '可改显示名')
  assert.deepEqual(safe.models.map((model: { id: string }) => model.id), [created.models[1].id, created.models[0].id])
  assert.equal(one<{ status: string }>('SELECT status FROM jobs WHERE id=?', `configuration-job-${created.provider.id}`)!.status, 'running')
})

test('provider disabling clears defaults without altering preserved model settings', async () => {
  const created = await fixture()
  await call('PUT', `/api/models/${created.models[0].id}/default`)
  const saved = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { enabled: false }, models: created.models.map((model: { id: string }) => ({ id: model.id })),
  })
  assert.equal(saved.provider.enabled, false)
  assert.ok(saved.models.every((model: { is_default: boolean }) => !model.is_default))
  assert.deepEqual(saved.models[0].settings, created.models[0].settings)
})

test('active director work protects its model through atomic and individual routes without cancelling or rewriting the task', async () => {
  const created = await fixture()
  const project = await call('POST', '/api/projects', { name: '创作任务保护' })
  const tasks = createDirectorTasks()
  const taskId = `director-configuration-${created.provider.id}`
  const request = { model_id: created.models[0].id, messages: [{ role: 'user', text: '讨论人物' }], use_tools: false }
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let requestSignal: AbortSignal | undefined
  tasks.start(project.id, { id: taskId, conversation: { id: `conversation-${taskId}`, messages: [{ id: 'user-message', role: 'user', text: '讨论人物' }] },
    execution: { title: '人物讨论', request: '讨论人物', started_at: Date.now() } }, request, async signal => {
    requestSignal = signal; await held; return { reply: '测试创作已完成' }
  })
  const taskBefore = one('SELECT * FROM script_director_tasks WHERE id=?', taskId)
  const before = snapshot(created.provider.id)
  try {
    for (const [method, url, payload] of [
      ['PUT', `/api/providers/${created.provider.id}/configuration`, { provider: { protocol: 'chat_completions' }, models: created.models.map((model: { id: string }) => ({ id: model.id })) }],
      ['PUT', `/api/providers/${created.provider.id}/configuration`, { provider: {}, models: [{ id: created.models[1].id }] }],
      ['PUT', `/api/providers/${created.provider.id}/configuration`, { provider: {}, models: [{ id: created.models[0].id, settings: { text_api: { mode: 'standard', max_output_tokens: 16_000 } } }, { id: created.models[1].id }] }],
      ['PATCH', `/api/providers/${created.provider.id}`, { api_key: 'must-not-save' }],
      ['DELETE', `/api/providers/${created.provider.id}`, undefined],
      ['PATCH', `/api/models/${created.models[0].id}`, { enabled: false }],
      ['DELETE', `/api/models/${created.models[0].id}`, undefined],
    ] as const) {
      const rejected = await app.inject({ method, url, ...(payload ? { payload } : {}) })
      assert.equal(rejected.statusCode, 422, rejected.body)
      assert.deepEqual(snapshot(created.provider.id), before)
      assert.deepEqual(one('SELECT * FROM script_director_tasks WHERE id=?', taskId), taskBefore)
      assert.equal(requestSignal!.aborted, false)
    }
    const safe = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
      provider: { name: '显示名可修改' }, models: [{ id: created.models[1].id, name: '其他模型可修改' }, { id: created.models[0].id }],
    })
    assert.equal(safe.models[0].name, '其他模型可修改')
    assert.equal(requestSignal!.aborted, false)
    assert.deepEqual(tasks.request(project.id, taskId), request)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(tasks.read(project.id, taskId).status, 'succeeded')
    assert.equal((await call('PATCH', `/api/models/${created.models[0].id}`, { name: '完成后可以修改' })).name, '完成后可以修改')
  } finally { release(); await tasks.close() }
})

test('new text rows inherit the saved provider protocol and explicit null alone clears a saved key', async () => {
  const created = await fixture()
  const saved = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { protocol: 'chat_completions', api_key: '' },
    models: [...created.models.map((model: { id: string }) => ({ id: model.id })), {
      name: '继承协议', remote_id: 'inherited', modality: 'text', settings: standardTextSettings('chat_completions'),
    }],
  })
  assert.equal(saved.models[2].protocol, 'chat_completions')
  assert.equal(saved.provider.has_key, true)
  const cleared = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { api_key: null }, models: saved.models.map((model: { id: string }) => ({ id: model.id })),
  })
  assert.equal(cleared.provider.has_key, false)
  assert.equal(one<{ key_ciphertext: string | null }>('SELECT key_ciphertext FROM providers WHERE id=?', created.provider.id)!.key_ciphertext, null)
})

test('individual model creation and catalog import append after saved ordering and provider moves append to destination', async () => {
  const created = await fixture()
  const added = await call('POST', '/api/models', { provider_id: created.provider.id, ...textModel('added') })
  assert.equal(added.sort_order, 2)
  const imported = await call('POST', `/api/providers/${created.provider.id}/model-catalog/import`, { models: [textModel('import-a'), textModel('import-b')] })
  assert.deepEqual(imported.imported.map((model: { sort_order: number }) => model.sort_order), [3, 4])
  const destination = await fixture([textModel('destination')])
  const moved = await call('PATCH', `/api/models/${added.id}`, { provider_id: destination.provider.id })
  assert.equal(moved.sort_order, 1)
  assert.equal(moved.provider_id, destination.provider.id)
})

test('draft catalog preview uses draft connection/key or saved key without saving any data', async () => {
  const created = await fixture([textModel('catalog-existing')])
  const before = snapshot(created.provider.id)
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; authorization: string | null }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') })
    return Response.json({ data: [{ id: 'catalog-existing' }, { id: 'catalog-new' }] })
  }
  try {
    for (const api_key of ['', 'draft-key']) {
      const preview = await call('POST', '/api/providers/model-catalog/preview', {
        provider_id: created.provider.id, base_url: 'https://draft.invalid/api', protocol: 'chat_completions', api_key,
      })
      assert.equal(preview.total, 2)
      assert.deepEqual(preview.models.map((model: { existing: boolean }) => model.existing), [true, false])
      assert.ok(!JSON.stringify(preview).includes('key'))
      assert.deepEqual(snapshot(created.provider.id), before)
    }
    assert.deepEqual(requests, [
      { url: 'https://draft.invalid/api/models', authorization: 'Bearer saved-fixture-key' },
      { url: 'https://draft.invalid/api/models', authorization: 'Bearer draft-key' },
    ])
    const count = all('SELECT id FROM providers').length
    await call('POST', '/api/providers/model-catalog/preview', { base_url: 'https://new.invalid/v1', api_key: 'unsaved-key' })
    assert.equal(all('SELECT id FROM providers').length, count)
    assert.equal(requests.at(-1)!.authorization, 'Bearer unsaved-key')
    await call('POST', '/api/providers/model-catalog/preview', {
      provider_id: created.provider.id, base_url: 'https://draft.invalid/v1', clear_key: true,
    })
    assert.equal(requests.at(-1)!.authorization, null)
    assert.deepEqual(snapshot(created.provider.id), before)
    const rejected = await app.inject({ method: 'POST', url: '/api/providers/model-catalog/preview', payload: { base_url: 'file:///tmp/models' } })
    assert.equal(rejected.statusCode, 422)
    assert.equal(requests.length, 4)
  } finally { globalThis.fetch = originalFetch }
})

test('Anthropic draft catalog defaults to native authentication and respects explicit custom headers', async () => {
  const originalFetch = globalThis.fetch
  const requests: Headers[] = []
  globalThis.fetch = async (_input, init) => { requests.push(new Headers(init?.headers)); return Response.json({ data: [] }) }
  try {
    await call('POST', '/api/providers/model-catalog/preview', { base_url: 'https://fixture.invalid/v1', protocol: 'anthropic_messages', api_key: 'native-key' })
    assert.equal(requests[0]!.get('x-api-key'), 'native-key')
    assert.equal(requests[0]!.get('authorization'), null)
    assert.equal(requests[0]!.get('anthropic-version'), '2023-06-01')
    await call('POST', '/api/providers/model-catalog/preview', { base_url: 'https://fixture.invalid/v1', protocol: 'anthropic_messages', api_key: 'custom-key', auth_header: 'X-Gateway-Key', auth_prefix: '' })
    assert.equal(requests[1]!.get('X-Gateway-Key'), 'custom-key')
    assert.equal(requests[1]!.get('x-api-key'), null)
  } finally { globalThis.fetch = originalFetch }
})


test('capacity validation binds catalog evidence to the current URL, protocol and remote ID on every save API', async () => {
  const discovered = { version: 1, discovered: { limits: { budget_mode: 'separate', input_tokens: 100000, output_tokens: 8192 }, source: 'provider', fetched_at: new Date().toISOString(),
    scope: { base_url: 'https://saved.invalid/v1', protocol: 'responses', remote_id: 'scoped-model' } } }
  const initial = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 4096 }, text_capabilities: discovered }
  const created = await fixture([textModel('scoped-model', { settings: initial })])
  const fixed = { ...initial, text_api: { ...initial.text_api, max_output_tokens: 65536 } }
  const invalidSameChannel = await app.inject({ method: 'PATCH', url: `/api/models/${created.models[0].id}`, payload: { settings: fixed } })
  assert.equal(invalidSameChannel.statusCode, 422)
  const changedRemote = await call('PATCH', `/api/models/${created.models[0].id}`, { remote_id: 'different-model', settings: fixed })
  assert.equal(changedRemote.settings.text_api.max_output_tokens, 65536)
  const restored = await call('PATCH', `/api/models/${created.models[0].id}`, { remote_id: 'scoped-model', settings: initial })
  const changedChannel = await call('PUT', `/api/providers/${created.provider.id}/configuration`, {
    provider: { base_url: 'https://new-channel.invalid/v1' }, models: [{ id: restored.id, settings: fixed }],
  })
  assert.equal(changedChannel.models[0].settings.text_api.max_output_tokens, 65536)
  const added = await call('POST', '/api/models', { provider_id: created.provider.id, ...textModel('added-model', { settings: fixed }) })
  assert.equal(added.settings.text_api.max_output_tokens, 65536)
})


test('stale catalog evidence must still be structurally valid before it can be stored', async () => {
  const created = await fixture([textModel('valid')])
  const rejected = await app.inject({ method: 'PATCH', url: `/api/models/${created.models[0].id}`, payload: { settings: {
    text_api: { mode: 'standard', max_output_tokens: 65536 }, text_capabilities: { version: 1, discovered: { source: 'provider', fetched_at: new Date().toISOString(),
      scope: { base_url: 'https://old.invalid/v1', protocol: 'responses', remote_id: 'old' }, limits: { budget_mode: 'separate', output_tokens: -1 } } },
  } } })
  assert.equal(rejected.statusCode, 422)
})
