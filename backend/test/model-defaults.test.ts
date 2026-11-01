import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

const directory = await mkdtemp(join(tmpdir(), 'model-defaults-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
// Start with a preceding release's model table so the test covers the additive migration.
const legacy = new Database(join(directory, 'studio.db'))
legacy.exec(`
  CREATE TABLE models (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL, remote_id TEXT NOT NULL, modality TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'responses', settings TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0
  );
`)
legacy.close()
const { buildApp } = await import('../src/app.js')
const { db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

type ModelResponse = { id: string; modality: string; enabled: boolean; is_default: boolean }
async function call<T = ModelResponse>(method: 'POST' | 'GET' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object): Promise<T> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function provider(enabled = true) {
  return call<{ id: string }>('POST', '/api/providers', { name: '测试提供商', base_url: 'https://example.invalid/v1', enabled })
}
const settings = {
  text: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text' },
  image: { request_path: 'images/generations', request_template: { model: '{{model}}', prompt: '{{prompt}}' }, image_url_path: 'data.0.url' },
  video: { create_path: 'tasks', get_path: 'tasks/{id}', request_template: { model: '{{model}}', prompt: '{{prompt}}' } },
}
const protocols = { text: 'responses', image: 'image_generations', video: 'async_video' }
async function model(providerId: string, modality: keyof typeof settings = 'text', enabled = true) {
  return call('POST', '/api/models', { provider_id: providerId, name: `测试${modality}`, remote_id: `${modality}-${Math.random()}`,
    modality, protocol: protocols[modality], settings: settings[modality], enabled })
}

test('defaults are unique across providers for each modality and survive reopening and startup migration', async () => {
  const first = await provider()
  const second = await provider()
  const text1 = await model(first.id)
  const text2 = await model(second.id)
  const image = await model(first.id, 'image')
  const video = await model(second.id, 'video')
  assert.equal(text1.is_default, false, 'migration and creation do not choose defaults for the user')
  await call('PUT', `/api/models/${text1.id}/default`)
  await call('PUT', `/api/models/${image.id}/default`)
  await call('PUT', `/api/models/${video.id}/default`)
  const selected = await call('PUT', `/api/models/${text2.id}/default`)
  assert.equal(selected.is_default, true)
  const list = await call<ModelResponse[]>('GET', '/api/models')
  assert.equal(list.find(item => item.id === text1.id)?.is_default, false)
  assert.deepEqual(list.filter(item => item.is_default).map(item => item.id).sort(), [text2.id, image.id, video.id].sort())
  assert.throws(() => run('UPDATE models SET is_default=1 WHERE id=?', text1.id), /UNIQUE constraint failed/)
  initDb()
  const reopened = new Database(join(directory, 'studio.db'), { readonly: true })
  try {
    assert.deepEqual(reopened.prepare('SELECT id FROM models WHERE is_default=1 ORDER BY id').all(),
      [text2.id, image.id, video.id].sort().map(id => ({ id })))
  } finally { reopened.close() }
  await call('DELETE', `/api/models/${text2.id}/default`)
  assert.equal((await call<ModelResponse[]>('GET', '/api/models')).find(item => item.id === text2.id)?.is_default, false)
})

test('setting defaults during active jobs preserves model configuration, connections and requests', async () => {
  const source = await provider()
  const target = await model(source.id)
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '默认模型任务' })
  const jobId = `job-${target.id}`
  run('INSERT INTO jobs (id,project_id,model_id,job_type,request,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    jobId, project.id, target.id, 'generation', '{"prompt":"保留任务"}', 'queued', now(), now())
  const before = one<Record<string, unknown>>('SELECT * FROM models WHERE id=?', target.id)!
  const connection = one('SELECT * FROM providers WHERE id=?', source.id)
  for (const status of ['queued', 'running']) {
    run('UPDATE jobs SET status=? WHERE id=?', status, jobId)
    assert.equal((await call('PUT', `/api/models/${target.id}/default`)).is_default, true)
    assert.deepEqual({ ...one<Record<string, unknown>>('SELECT * FROM models WHERE id=?', target.id), is_default: 0 }, before)
    assert.deepEqual(one('SELECT * FROM providers WHERE id=?', source.id), connection)
    assert.deepEqual(one('SELECT status, model_id, request FROM jobs WHERE id=?', jobId), { status, model_id: target.id, request: '{"prompt":"保留任务"}' })
    await call('DELETE', `/api/models/${target.id}/default`)
  }
})

test('disabled and archived models/providers cannot replace an existing default', async () => {
  const enabled = await provider()
  const current = await model(enabled.id)
  await call('PUT', `/api/models/${current.id}/default`)
  const disabledModel = await model(enabled.id, 'text', false)
  const disabledProvider = await provider(false)
  const unavailable = await model(disabledProvider.id)
  const archived = await model(enabled.id)
  run('UPDATE models SET archived=1 WHERE id=?', archived.id)
  const archivedProvider = await provider()
  const archivedProviderModel = await model(archivedProvider.id)
  run('UPDATE providers SET archived=1 WHERE id=?', archivedProvider.id)
  for (const id of [disabledModel.id, unavailable.id, archived.id, archivedProviderModel.id]) {
    const response = await app.inject({ method: 'PUT', url: `/api/models/${id}/default` })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.equal(one<{ is_default: number }>('SELECT is_default FROM models WHERE id=?', current.id)?.is_default, 1)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/models/missing/default' })).statusCode, 404)
})

test('disabling providers or models clears defaults and re-enabling does not silently restore them', async () => {
  const source = await provider()
  const text = await model(source.id)
  const image = await model(source.id, 'image')
  for (const item of [text, image]) await call('PUT', `/api/models/${item.id}/default`)
  await call('PATCH', `/api/providers/${source.id}`, { enabled: false })
  for (const item of [text, image]) assert.equal(one<{ is_default: number }>('SELECT is_default FROM models WHERE id=?', item.id)?.is_default, 0)
  await call('PATCH', `/api/providers/${source.id}`, { enabled: true })
  await call('PUT', `/api/models/${text.id}/default`)
  assert.equal((await call('PATCH', `/api/models/${text.id}`, { enabled: false })).is_default, false)
  assert.equal((await call('PATCH', `/api/models/${text.id}`, { enabled: true })).is_default, false)
})

test('changing modality or moving to a disabled provider clears defaults without displacing other modalities', async () => {
  const source = await provider()
  const text = await model(source.id)
  const image = await model(source.id, 'image')
  await call('PUT', `/api/models/${text.id}/default`)
  await call('PUT', `/api/models/${image.id}/default`)
  const changed = await call('PATCH', `/api/models/${text.id}`, { modality: 'image', protocol: 'image_generations', settings: settings.image })
  assert.equal(changed.is_default, false)
  assert.equal(one<{ is_default: number }>('SELECT is_default FROM models WHERE id=?', image.id)?.is_default, 1)
  const unavailable = await provider(false)
  assert.equal((await call('PATCH', `/api/models/${image.id}`, { provider_id: unavailable.id })).is_default, false)
})

test('deleting selected models or providers removes defaults and allows a replacement', async () => {
  const source = await provider()
  const removed = await model(source.id)
  await call('PUT', `/api/models/${removed.id}/default`)
  await call('DELETE', `/api/models/${removed.id}`)
  const replacement = await model(source.id)
  assert.equal((await call('PUT', `/api/models/${replacement.id}/default`)).is_default, true)
  await call('DELETE', `/api/providers/${source.id}`)
  assert.equal(one('SELECT id FROM models WHERE id=?', replacement.id), undefined)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
