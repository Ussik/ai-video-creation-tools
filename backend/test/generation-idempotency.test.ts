import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'

const directory = await mkdtemp(join(tmpdir(), 'generation-idempotency-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { startJobQueue } = await import('../src/modules/jobs/job-queue.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
beforeEach(() => {
  run('DELETE FROM projects')
  run('DELETE FROM providers')
})

async function post(url: string, payload: unknown, key?: string) {
  return app.inject({ method: 'POST', url, payload, ...(key ? { headers: { 'Idempotency-Key': key } } : {}) })
}
async function create(url: string, payload: unknown) {
  const response = await post(url, payload)
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture(modality: 'image' | 'video' | 'text' = 'video') {
  const project = await create('/api/projects', { name: '隔离幂等测试' })
  const provider = await create('/api/providers', { name: 'mock', base_url: 'https://offline.invalid/v1' })
  const settings = modality === 'video'
    ? { create_path: 'tasks', get_path: 'tasks/{id}', supported_modes: ['text'], request_template: { prompt: '{{prompt}}' } }
    : modality === 'text'
      ? { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' }
      : { request_path: 'images/generations', request_template: { prompt: '{{prompt}}', images: '{{images}}' }, image_base64_path: 'data.0.b64_json' }
  const model = await create('/api/models', { provider_id: provider.id, name: modality, remote_id: `mock-${modality}`, modality,
    protocol: modality === 'video' ? 'async_video' : modality === 'text' ? 'chat_completions' : 'image_generations', settings })
  const shot = await create(`/api/projects/${project.id}/shots`, { title: '夜色' })
  return { project, provider, model, shot, url: `/api/projects/${project.id}/generate`,
    payload: { shot_id: shot.id, model_id: model.id, prompt: '夜晚的街道，镜头缓缓推近。' } }
}
const rows = (table: string) => one<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!.count
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('concurrent accepted requests create one persisted job and one key even across asynchronous video validation', async () => {
  const state = await fixture()
  const responses = await Promise.all(Array.from({ length: 24 }, () => post(state.url, state.payload, 'same-intent-001')))
  for (const response of responses) assert.equal(response.statusCode, 200, response.body)
  assert.equal(new Set(responses.map(response => response.json().id)).size, 1)
  assert.equal(rows('jobs'), 1)
  assert.equal(rows('resource_submissions'), 1)
  assert.equal(responses[0]!.json().idempotency_key, 'same-intent-001')
  assert.equal(responses[0]!.json().status, 'queued')
})

test('concurrent key reuse with different payloads accepts exactly one and reports conflict for the other', async () => {
  const state = await fixture()
  const responses = await Promise.all(['左转', '右转'].map(prompt => post(state.url, { ...state.payload, prompt }, 'conflicting-key')))
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409])
  assert.equal(rows('jobs'), 1)
  assert.equal(rows('resource_submissions'), 1)
})

test('input defaults and object key order have stable identity; prompt, model, shot and ordered references remain bound', async () => {
  const state = await fixture()
  const first = await post(state.url, state.payload, 'canonical-request')
  assert.equal(first.statusCode, 200, first.body)
  const equivalent = await post(state.url, { prompt: state.payload.prompt, model_id: state.model.id, shot_id: state.shot.id,
    reference_asset_ids: [], mode: 'text', duration: 5, ratio: '16:9', generate_audio: true, draft: false }, 'canonical-request')
  assert.equal(equivalent.statusCode, 200, equivalent.body)
  assert.equal(equivalent.json().id, first.json().id)
  for (const patch of [{ prompt: '新内容' }, { model_id: 'missing-model' }, { shot_id: 'missing-shot' },
    { reference_asset_ids: ['b', 'a'] }, { ratio: '9:16' }, { duration: 6 }, { project_style_version: 'a'.repeat(64) },
    { prompt_body: '新正文' }, { draft: true }, { video_reference_usages: [{ asset_id: 'a', usage: 'identity' }] }]) {
    const response = await post(state.url, { ...state.payload, ...patch }, 'canonical-request')
    assert.equal(response.statusCode, 409, response.body)
  }
  assert.equal(rows('jobs'), 1)
})

test('new keys and legacy requests create independent tasks even with identical prompts; keys are project scoped', async () => {
  const state = await fixture()
  const jobs = []
  for (const key of [undefined, undefined, 'candidate-0001', 'candidate-0002']) {
    const response = await post(state.url, state.payload, key)
    assert.equal(response.statusCode, 200, response.body)
    jobs.push(response.json())
  }
  assert.equal(new Set(jobs.map(job => job.id)).size, 4)
  assert.equal(jobs[0]!.idempotency_key, null)
  const second = await fixture()
  const response = await post(second.url, second.payload, 'candidate-0001')
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(rows('jobs'), 5)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${second.project.id}/generation-submissions/candidate-0002` })).json().job, null)
})

test('ordered effective references are part of the accepted identity', async () => {
  const state = await fixture('image')
  for (const id of ['reference-a', 'reference-b']) run(`INSERT INTO assets (id,project_id,kind,filename,path,source,created_at)
    VALUES (?,?,'image',?,'/tmp/unused-offline-reference.png','upload',?)`, id, state.project.id, `${id}.png`, now())
  const payload = { ...state.payload, reference_asset_ids: ['reference-a', 'reference-b'] }
  const accepted = await post(state.url, payload, 'reference-order-key')
  assert.equal(accepted.statusCode, 200, accepted.body)
  const replay = await post(state.url, payload, 'reference-order-key')
  assert.equal(replay.json().id, accepted.json().id)
  const reversed = await post(state.url, { ...payload, reference_asset_ids: ['reference-b', 'reference-a'] }, 'reference-order-key')
  assert.equal(reversed.statusCode, 409, reversed.body)
  assert.equal(rows('jobs'), 1)
})

test('lost acceptance responses are recoverable read-only; replay preserves failed/succeeded jobs after model and shot changes', async () => {
  const state = await fixture()
  const first = await post(state.url, state.payload, 'lost-response-key')
  assert.equal(first.statusCode, 200, first.body)
  const job = first.json()
  run('UPDATE models SET enabled=0,archived=1 WHERE id=?', state.model.id)
  run('UPDATE providers SET enabled=0 WHERE id=?', state.provider.id)
  run('UPDATE shots SET storyboard_revision=42 WHERE id=?', state.shot.id)
  // The retry API may edit request; the submission identity must stay independent.
  const edited = JSON.stringify({ ...JSON.parse(job.request), prompt: '修改后的历史任务正文' })
  for (const status of ['queued', 'running', 'failed', 'succeeded']) {
    run('UPDATE jobs SET request=?,status=?,error=?,updated_at=? WHERE id=?', edited, status, status === 'failed' ? '厂商可能已计费' : null, 'unchanged-timestamp', job.id)
    const snapshot = JSON.stringify(all('SELECT * FROM jobs'))
    const lookup = await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/generation-submissions/lost-response-key` })
    assert.equal(lookup.statusCode, 200, lookup.body)
    assert.equal(lookup.json().job.id, job.id)
    assert.equal(lookup.json().job.status, status)
    const replay = await post(state.url, state.payload, 'lost-response-key')
    assert.equal(replay.statusCode, 200, replay.body)
    assert.equal(replay.json().request, edited)
    assert.equal(replay.json().status, status)
    assert.equal(JSON.stringify(all('SELECT * FROM jobs')), snapshot, 'neither lookup nor replay resets status or request')
  }
  const detail = await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}` })
  assert.equal(detail.json().jobs[0].idempotency_key, 'lost-response-key')
  const before = JSON.stringify(all('SELECT * FROM resource_submissions'))
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/generation-submissions/never-submitted` })).json(), { job: null })
  assert.equal(JSON.stringify(all('SELECT * FROM resource_submissions')), before)
})

test('shot creation response loss and concurrent replays return one shot, with independent namespace and immutable request identity', async () => {
  const project = await create('/api/projects', { name: '镜头提交恢复' })
  const url = `/api/projects/${project.id}/shots`
  const payload = { title: '  恢复镜头  ', prompt: '原镜头', duration: 5 }
  const responses = await Promise.all(Array.from({ length: 16 }, () => post(url, payload, 'shot-create-001')))
  for (const response of responses) assert.equal(response.statusCode, 200, response.body)
  const id = responses[0]!.json().id
  assert.equal(new Set(responses.map(response => response.json().id)).size, 1)
  assert.equal(rows('shots'), 1)
  const changed = await post(url, { ...payload, title: '改变' }, 'shot-create-001')
  assert.equal(changed.statusCode, 409, changed.body)
  run('UPDATE shots SET title=? WHERE id=?', '后来手动编辑', id)
  const replay = await post(url, { ...payload, source_scene_id: null, image_prompt: '', video_prompt: '', start_state: '', end_state: '', cut_note: '' }, 'shot-create-001')
  assert.equal(replay.statusCode, 200, replay.body)
  assert.equal(replay.json().title, '后来手动编辑')
  const found = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/shot-submissions/shot-create-001` })
  assert.equal(found.json().shot.id, id)
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/generation-submissions/shot-create-001` })).json(), { job: null })
})

test('recovering a lost preliminary shot response and then lost candidate responses keeps one shot and the intended two candidates', async () => {
  const state = await fixture()
  run('DELETE FROM shots WHERE id=?', state.shot.id)
  const shotBody = { title: '普通画布镜头', prompt: '冻结镜头来源', duration: 5 }
  const shotUrl = `/api/projects/${state.project.id}/shots`
  // Discard the first response as a client would after losing its connection.
  assert.equal((await post(shotUrl, shotBody, 'intent-shot-key')).statusCode, 200)
  const recovered = await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/shot-submissions/intent-shot-key` })
  const shot = recovered.json().shot
  assert.ok(shot.id)
  assert.equal((await post(shotUrl, shotBody, 'intent-shot-key')).json().id, shot.id)
  const payload = { ...state.payload, shot_id: shot.id }
  for (const key of ['intent-candidate-0', 'intent-candidate-1']) {
    assert.equal((await post(state.url, payload, key)).statusCode, 200)
    const lookup = await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/generation-submissions/${key}` })
    assert.equal((await post(state.url, payload, key)).json().id, lookup.json().job.id)
  }
  assert.equal(rows('shots'), 1)
  assert.equal(rows('jobs'), 2)
  assert.equal(rows('resource_submissions'), 3)
})

test('deleted accepted resources retain tombstones; lookup and replay cannot recreate jobs or shots', async () => {
  const state = await fixture()
  const job = (await post(state.url, state.payload, 'deleted-job-key')).json()
  run('DELETE FROM jobs WHERE id=?', job.id)
  for (const response of [await post(state.url, state.payload, 'deleted-job-key'),
    await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/generation-submissions/deleted-job-key` })]) {
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /已删除/)
  }
  const url = `/api/projects/${state.project.id}/shots`, body = { title: '可删除镜头' }
  const shot = (await post(url, body, 'deleted-shot-key')).json()
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/shots/${shot.id}` })).statusCode, 200)
  assert.equal((await post(url, body, 'deleted-shot-key')).statusCode, 409)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${state.project.id}/shot-submissions/deleted-shot-key` })).statusCode, 409)
  assert.equal(rows('jobs'), 0)
  assert.equal(rows('shots'), 1)
  assert.equal(rows('resource_submissions'), 2)
})

test('invalid keys and invalid requests never reserve a key or create tasks; a corrected request can reuse its unaccepted key', async () => {
  const state = await fixture()
  for (const key of ['short', 'x'.repeat(129), 'spaces are invalid']) {
    const response = await post(state.url, state.payload, key)
    assert.equal(response.statusCode, 422, response.body)
  }
  const invalid = await post(state.url, { ...state.payload, model_id: 'unknown' }, 'unaccepted-key')
  assert.equal(invalid.statusCode, 404, invalid.body)
  assert.equal(rows('jobs'), 0)
  assert.equal(rows('resource_submissions'), 0)
  assert.equal((await post(state.url, state.payload, 'unaccepted-key')).statusCode, 200)
})

test('registry write failure rolls back task creation and shot creation plus project touch atomically', async t => {
  const state = await fixture()
  t.mock.method(console, 'error', () => {})
  const projectBefore = JSON.stringify(one('SELECT * FROM projects WHERE id=?', state.project.id))
  db.exec("CREATE TEMP TRIGGER fail_submission BEFORE INSERT ON resource_submissions BEGIN SELECT RAISE(ABORT, 'mock registry write failure'); END")
  try {
    const response = await post(state.url, state.payload, 'rollback-job-key')
    assert.equal(response.statusCode, 500, response.body)
    const shotResponse = await post(`/api/projects/${state.project.id}/shots`, { title: '回滚镜头' }, 'rollback-shot-key')
    assert.equal(shotResponse.statusCode, 500, shotResponse.body)
    assert.equal(rows('jobs'), 0)
    assert.equal(rows('shots'), 1)
    assert.equal(rows('resource_submissions'), 0)
    assert.equal(JSON.stringify(one('SELECT * FROM projects WHERE id=?', state.project.id)), projectBefore)
  } finally { db.exec('DROP TRIGGER fail_submission') }
  assert.equal((await post(state.url, state.payload, 'rollback-job-key')).statusCode, 200)
})

test('queued submissions persist across a real process restart, are claimed once, and failed jobs never automatically enqueue', async () => {
  const state = await fixture()
  const queued = (await post(state.url, state.payload, 'restart-queued-key')).json()
  const failed = (await post(state.url, state.payload, 'restart-failed-key')).json()
  run("UPDATE jobs SET status='failed',error='mock uncertain provider result' WHERE id=?", failed.id)
  const code = `
    import assert from 'node:assert/strict';
    import { buildApp } from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)};
    import { db, run } from ${JSON.stringify(new URL('../src/infrastructure/database/db.js', import.meta.url).href)};
    import { startJobQueue } from ${JSON.stringify(new URL('../src/modules/jobs/job-queue.js', import.meta.url).href)};
    globalThis.fetch = async () => { throw new Error('network forbidden in restart test') };
    const app = buildApp(), started = [];
    const lookup = await app.inject({ method:'GET', url:${JSON.stringify(`/api/projects/${state.project.id}/generation-submissions/restart-queued-key`)} });
    assert.equal(lookup.json().job.id, ${JSON.stringify(queued.id)});
    const replay = await app.inject({ method:'POST', url:${JSON.stringify(state.url)}, headers:{'Idempotency-Key':'restart-queued-key'}, payload:${JSON.stringify(state.payload)} });
    assert.equal(replay.json().id, ${JSON.stringify(queued.id)});
    const stop = startJobQueue(async job => { started.push(job.id); run("UPDATE jobs SET status='succeeded' WHERE id=?",job.id) }, () => { throw new Error('unexpected failure') });
    await new Promise(resolve => setImmediate(resolve));
    await stop();
    assert.deepEqual(started,[${JSON.stringify(queued.id)}]);
    await app.close(); db.close();
    process.stdout.write(JSON.stringify({started}));
  `
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, VIDEO_STUDIO_DATA_DIR: directory }, timeout: 30_000,
  })
  assert.deepEqual(JSON.parse(result.stdout).started, [queued.id])
  assert.equal(rows('jobs'), 2)
  assert.equal(rows('resource_submissions'), 2)
  assert.equal(one<{ status: string }>('SELECT status FROM jobs WHERE id=?', failed.id)!.status, 'failed')
})

test('legacy startup safety for interrupted images is preserved and replay never causes another paid attempt', async () => {
  const state = await fixture('image')
  const accepted = (await post(state.url, state.payload, 'interrupted-image-key')).json()
  run("UPDATE jobs SET status='running' WHERE id=?", accepted.id)
  initDb()
  const recovered = await post(state.url, state.payload, 'interrupted-image-key')
  assert.equal(recovered.statusCode, 200, recovered.body)
  assert.equal(recovered.json().status, 'failed')
  assert.match(recovered.json().error, /可能已计费/)
  const started: string[] = []
  const stop = startJobQueue(async job => { started.push(job.id) }, () => {})
  await flush(); await stop()
  assert.deepEqual(started, [])
  assert.equal(rows('jobs'), 1)
})

test('one API submission produces only one mocked provider call despite response loss, duplicate POSTs, and two workers', async t => {
  const state = await fixture('text')
  const accepted = await post(state.url, state.payload, 'provider-single-call')
  assert.equal(accepted.statusCode, 200, accepted.body)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ choices: [{ message: { content: 'mock generated text' } }] })
  })
  const workers = [startWorker(), startWorker()]
  try {
    const replays = await Promise.all(Array.from({ length: 10 }, () => post(state.url, state.payload, 'provider-single-call')))
    for (const replay of replays) assert.equal(replay.json().id, accepted.json().id)
    for (let count = 0; count < 100 && one<{ status: string }>('SELECT status FROM jobs')!.status === 'running'; count++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(one<{ status: string }>('SELECT status FROM jobs')!.status, 'succeeded')
    assert.equal(calls, 1)
    assert.equal(rows('jobs'), 1)
    assert.equal(rows('assets'), 1)
  } finally { await Promise.all(workers.map(stop => stop())) }
})
