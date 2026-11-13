import { validVideo } from './fixtures/valid-video.js'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import type { Job } from '../src/infrastructure/database/db.js'

const directory = await mkdtemp(join(tmpdir(), 'generation-restart-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp, startWorker } = await import('../src/app.js')
const { db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { encryptKey } = await import('../src/infrastructure/security/secrets.js')
const { prepareGenerationExecution } = await import('../src/modules/jobs/job-generation-recovery.js')
const { claimMediaJob, mediaJobExecution } = await import('../src/modules/jobs/job-local-results.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
beforeEach(() => { run('DELETE FROM projects'); run('DELETE FROM providers') })

const resultUrl = 'https://cdn.invalid/recovered.mp4?signature=private-video-result'
const complete = () => Response.json({ status: 'succeeded', output: { url: resultUrl } })
const jobRow = (id: string) => one<Job>('SELECT * FROM jobs WHERE id=?', id)!
const checkpoint = (id: string) => one<{ result_url_ciphertext: string }>('SELECT result_url_ciphertext FROM job_video_recovery WHERE job_id=?', id)
async function post(url: string, payload: unknown = {}) { return app.inject({ method: 'POST', url, payload }) }
async function create(url: string, payload: unknown) {
  const response = await post(url, payload)
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await create('/api/projects', { name: '隔离重启恢复测试' })
  const provider = await create('/api/providers', { name: 'mock', base_url: 'https://offline.invalid/v1' })
  const model = await create('/api/models', { provider_id: provider.id, name: 'video', remote_id: 'mock-video', modality: 'video', protocol: 'async_video',
    settings: { create_path: 'tasks', get_path: 'tasks/{id}', supported_modes: ['text'], request_template: { prompt: '{{prompt}}' },
      id_path: 'id', status_path: 'status', result_path: 'output.url', poll_seconds: 0.001 } })
  const shot = await create(`/api/projects/${project.id}/shots`, { title: '恢复镜头' })
  const job = await create(`/api/projects/${project.id}/generate`, { shot_id: shot.id, model_id: model.id, prompt: '街道上缓缓前进' })
  return { project, provider, model, shot, job }
}
async function publicJob(projectId: string, id: string) {
  const response = await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })
  assert.equal(response.statusCode, 200, response.body)
  return response.json().jobs.find((job: Job) => job.id === id)
}
function fastPoll(t: TestContext) {
  const schedule = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => schedule(callback, 0))
}
async function work() {
  const stop = startWorker()
  await new Promise<void>(resolve => setImmediate(resolve))
  await stop()
}
function saveUrl(id: string) {
  run('INSERT INTO job_video_recovery (job_id,result_url_ciphertext,created_at) VALUES (?,?,?)', id, encryptKey(resultUrl), now())
}

test('interrupted video with no trustworthy ID or URL becomes verification-only and cannot be retried', async t => {
  const state = await fixture()
  t.mock.method(globalThis, 'fetch', async () => assert.fail('uncertain jobs must never contact a provider'))
  for (const externalId of [null, '', '  ', 'undefined', 'null']) {
    run("UPDATE jobs SET status='running',external_id=? WHERE id=?", externalId, state.job.id)
    initDb()
    assert.equal(jobRow(state.job.id).status, 'failed')
    assert.match(jobRow(state.job.id).error!, /厂商可能已计费/)
    assert.equal((await publicJob(state.project.id, state.job.id)).recovery_action, 'verify')
    const retry = await post(`/api/jobs/${state.job.id}/retry`)
    assert.equal(retry.statusCode, 422, retry.body)
    await work()
    assert.equal(jobRow(state.job.id).status, 'failed')
  }
})

test('a never-started queued video submits once, checkpoints in order, and removes checkpoints only after success', async t => {
  const state = await fixture()
  fastPoll(t)
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') {
      calls.push('create')
      assert.ok(one('SELECT 1 FROM job_generation_attempts WHERE job_id=?', state.job.id))
      return Response.json({ id: 'accepted' })
    }
    if (String(url) === resultUrl) {
      calls.push('download')
      assert.ok(checkpoint(state.job.id), 'URL is durable before download')
      return new Response(validVideo)
    }
    calls.push('query')
    assert.equal(jobRow(state.job.id).external_id, 'accepted', 'ID is durable before query')
    return complete()
  })
  initDb()
  assert.equal(jobRow(state.job.id).status, 'queued')
  await work()
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.deepEqual(calls, ['create', 'query', 'download'])
  assert.equal(checkpoint(state.job.id), undefined)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?', jobRow(state.job.id).result_asset_id))
})

test('a known task ID survives restart and recovers by GET only despite missing original reference assets', async t => {
  const state = await fixture()
  fastPoll(t)
  const calls: string[] = []
  run("UPDATE jobs SET status='running',external_id='known / task',request=? WHERE id=?",
    JSON.stringify({ ...JSON.parse(state.job.request), reference_asset_ids: ['deleted-reference'] }), state.job.id)
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    assert.notEqual(options?.method, 'POST')
    calls.push(String(url))
    return String(url) === resultUrl ? new Response(validVideo) : complete()
  })
  initDb()
  assert.equal(jobRow(state.job.id).status, 'queued')
  await work()
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.deepEqual(calls, ['https://offline.invalid/v1/tasks/known%20%2F%20task', resultUrl])
})

test('saved video URLs recover without models/providers, and changing a prompt cannot mutate a download task', async t => {
  const state = await fixture()
  saveUrl(state.job.id)
  run("UPDATE jobs SET status='failed' WHERE id=?", state.job.id)
  run('DELETE FROM providers WHERE id=?', state.provider.id)
  const shown = await publicJob(state.project.id, state.job.id)
  assert.equal(shown.recovery_action, 'download')
  assert.equal(shown.recovery_modality, 'video')
  assert.equal(shown.recovery_available, true)
  assert.equal(JSON.stringify(shown).includes('private-video-result'), false)
  assert.equal((await post(`/api/jobs/${state.job.id}/retry`, { prompt: '另一个提示词' })).statusCode, 422)
  assert.equal(jobRow(state.job.id).request, state.job.request)
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    assert.equal(String(url), resultUrl)
    assert.notEqual(options?.method, 'POST')
    return new Response(validVideo)
  })
  assert.equal((await post(`/api/jobs/${state.job.id}/retry`)).statusCode, 200)
  await work()
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.equal(checkpoint(state.job.id), undefined)
})

test('continuing an existing video task rejects prompt changes and preserves its ID', async t => {
  const state = await fixture()
  run("UPDATE jobs SET status='failed',external_id='existing' WHERE id=?", state.job.id)
  const shown = await publicJob(state.project.id, state.job.id)
  assert.equal(shown.recovery_action, 'query')
  const response = await post(`/api/jobs/${state.job.id}/retry`, { prompt: '新提示词' })
  assert.equal(response.statusCode, 422, response.body)
  assert.match(response.body, /不能修改提示词/)
  assert.equal(jobRow(state.job.id).request, state.job.request)
  assert.equal(jobRow(state.job.id).external_id, 'existing')
  assert.equal(jobRow(state.job.id).status, 'failed')
  t.mock.method(globalThis, 'fetch', async () => assert.fail('retry endpoint must not send a provider request'))
  const retry = await post(`/api/jobs/${state.job.id}/retry`)
  assert.equal(retry.statusCode, 200, retry.body)
})

test('task ID persistence failure after acceptance cannot query, download or create again, including after restart', async t => {
  const state = await fixture()
  let creates = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'POST')
    creates++
    return Response.json({ id: 'accepted-but-not-saved' })
  })
  db.exec("CREATE TEMP TRIGGER fail_task_id BEFORE UPDATE OF external_id ON jobs WHEN NEW.external_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'mock ID persistence failure'); END")
  try { await work() } finally { db.exec('DROP TRIGGER fail_task_id') }
  assert.equal(jobRow(state.job.id).status, 'failed')
  assert.equal(jobRow(state.job.id).external_id, null)
  assert.equal(creates, 1)
  assert.ok(one('SELECT 1 FROM job_generation_attempts WHERE job_id=?', state.job.id))
  assert.equal((await post(`/api/jobs/${state.job.id}/retry`)).statusCode, 422)
  run("UPDATE jobs SET status='running' WHERE id=?", state.job.id)
  initDb()
  await work()
  assert.equal(jobRow(state.job.id).status, 'failed')
  assert.equal(creates, 1)
})

test('result URL persistence failure stops before download and preserves the ID for query-only recovery', async t => {
  const state = await fixture()
  fastPoll(t)
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { calls.push('create'); return Response.json({ id: 'accepted' }) }
    if (String(url) === resultUrl) { calls.push('download'); return new Response(validVideo) }
    calls.push('query')
    return complete()
  })
  db.exec("CREATE TEMP TRIGGER fail_video_url BEFORE INSERT ON job_video_recovery BEGIN SELECT RAISE(ABORT,'mock URL persistence failure'); END")
  try { await work() } finally { db.exec('DROP TRIGGER fail_video_url') }
  assert.equal(jobRow(state.job.id).status, 'failed')
  assert.equal(jobRow(state.job.id).external_id, 'accepted')
  assert.equal(checkpoint(state.job.id), undefined)
  assert.deepEqual(calls, ['create', 'query'])
  assert.equal((await publicJob(state.project.id, state.job.id)).recovery_action, 'query')
  assert.equal((await post(`/api/jobs/${state.job.id}/retry`)).statusCode, 200)
  await work()
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.deepEqual(calls, ['create', 'query', 'query', 'download'])
})

test('download failures keep an encrypted checkpoint and resume only downloading even if configuration is disabled', async t => {
  const state = await fixture()
  fastPoll(t)
  let downloads = 0, creates = 0, queries = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { creates++; return Response.json({ id: 'accepted' }) }
    if (String(url) !== resultUrl) { queries++; return complete() }
    downloads++
    if (downloads < 3) throw new Error(`mock disconnect: ${resultUrl}`)
    return new Response(validVideo)
  })
  await work()
  assert.equal(jobRow(state.job.id).status, 'failed')
  assert.ok(checkpoint(state.job.id))
  assert.equal(checkpoint(state.job.id)!.result_url_ciphertext.includes('private-video-result'), false)
  assert.equal(jobRow(state.job.id).error!.includes('private-video-result'), false)
  run('UPDATE models SET enabled=0,archived=1 WHERE id=?', state.model.id)
  run('UPDATE providers SET enabled=0,archived=1 WHERE id=?', state.provider.id)
  for (const status of ['running', 'failed']) {
    if (status === 'running') { run("UPDATE jobs SET status='running' WHERE id=?", state.job.id); initDb() }
    else assert.equal((await post(`/api/jobs/${state.job.id}/retry`)).statusCode, 200)
    await work()
  }
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.deepEqual({ creates, queries, downloads }, { creates: 1, queries: 1, downloads: 3 })
  assert.equal(checkpoint(state.job.id), undefined)
})

test('asset commit failure rolls back job success and checkpoint deletion, so the next attempt takes over the validated local file', async t => {
  const state = await fixture()
  saveUrl(state.job.id)
  let downloads = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(String(url), resultUrl)
    downloads++
    return new Response(validVideo)
  })
  db.exec("CREATE TEMP TRIGGER fail_success AFTER DELETE ON job_video_recovery BEGIN SELECT RAISE(ABORT,'mock commit failure'); END")
  try { await work() } finally { db.exec('DROP TRIGGER fail_success') }
  assert.equal(jobRow(state.job.id).status, 'failed')
  assert.equal(jobRow(state.job.id).result_asset_id, null)
  assert.equal(one('SELECT 1 FROM assets WHERE project_id=?', state.project.id), undefined)
  assert.ok(checkpoint(state.job.id))
  assert.equal((await post(`/api/jobs/${state.job.id}/retry`)).statusCode, 200)
  await work()
  assert.equal(jobRow(state.job.id).status, 'succeeded')
  assert.equal(downloads, 1)
  assert.equal(checkpoint(state.job.id), undefined)
})

test('a separate process resumes persisted running IDs/URLs, stops unknown submissions and starts pristine queued work once', async () => {
  const unknown = await fixture(), known = await fixture(), url = await fixture(), queued = await fixture()
  run("UPDATE jobs SET status='running' WHERE id IN (?,?,?)", unknown.job.id, known.job.id, url.job.id)
  run("UPDATE jobs SET external_id='existing' WHERE id=?", known.job.id)
  saveUrl(url.job.id)
  run('DELETE FROM providers WHERE id=?', url.provider.id)
  const code = `
    import assert from 'node:assert/strict'
import sharp from 'sharp';
    import { buildApp, startWorker } from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)};
    import { db, one } from ${JSON.stringify(new URL('../src/infrastructure/database/db.js', import.meta.url).href)};
    const validVideo = Buffer.from(${JSON.stringify(validVideo.toString('base64'))}, 'base64');
    const calls = { create:0, query:0, download:0 }, resultUrl = ${JSON.stringify(resultUrl)};
    globalThis.fetch = async (url, options) => {
      if (options?.method === 'POST') { calls.create++; return Response.json({id:'new-accepted'}); }
      if (String(url) === resultUrl) { calls.download++; return new Response(validVideo); }
      calls.query++; return Response.json({status:'succeeded', output:{url:resultUrl}});
    };
    const app = buildApp();
    assert.equal(one('SELECT status FROM jobs WHERE id=?',${JSON.stringify(unknown.job.id)}).status,'failed');
    const stop = startWorker(); await new Promise(resolve => setImmediate(resolve)); await stop();
    assert.equal(one('SELECT status FROM jobs WHERE id=?',${JSON.stringify(known.job.id)}).status,'succeeded');
    assert.equal(one('SELECT status FROM jobs WHERE id=?',${JSON.stringify(url.job.id)}).status,'succeeded');
    assert.equal(one('SELECT status FROM jobs WHERE id=?',${JSON.stringify(queued.job.id)}).status,'queued');
    const next = startWorker(); await new Promise(resolve => setImmediate(resolve)); await next();
    assert.equal(one('SELECT status FROM jobs WHERE id=?',${JSON.stringify(queued.job.id)}).status,'succeeded');
    assert.deepEqual(calls,{create:1,query:2,download:3});
    await app.close(); db.close(); process.stdout.write(JSON.stringify(calls));
  `
  // Two recovery jobs occupy the first pass; pristine queued work starts in the second pass.
  run('UPDATE job_queue_settings SET concurrency=2 WHERE id=1')
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, VIDEO_STUDIO_DATA_DIR: directory }, timeout: 30_000,
  })
  assert.deepEqual(JSON.parse(result.stdout), { create: 1, query: 2, download: 3 })
  run('UPDATE job_queue_settings SET concurrency=3 WHERE id=1')
})


test('an expired result URL queries the original task exactly once, retains the new URL, and never POSTs', async t => {
 const f = await fixture(), fresh = 'https://cdn.invalid/fresh.mp4?private=refresh'
 saveUrl(f.job.id); run("UPDATE jobs SET external_id='original-task' WHERE id=?", f.job.id)
 const calls: string[] = []
 t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
  assert.notEqual(init?.method, 'POST'); calls.push(String(url))
  if (String(url) === resultUrl) return new Response('expired private url', { status: 403 })
  if (String(url) === fresh) return new Response(validVideo)
  return Response.json({ status: 'succeeded', output: { url: fresh } })
 })
 await work()
 assert.equal(jobRow(f.job.id).status, 'succeeded', jobRow(f.job.id).error || '')
 assert.deepEqual(calls, [resultUrl, 'https://offline.invalid/v1/tasks/original-task', fresh])
 assert.equal(checkpoint(f.job.id), undefined)
})

test('a refreshed URL failure cannot loop into repeated task queries or paid creation', async t => {
 const f = await fixture(), fresh = 'https://cdn.invalid/new-expired.mp4?private=refresh'
 saveUrl(f.job.id); run("UPDATE jobs SET external_id='original-task' WHERE id=?", f.job.id)
 const calls: string[] = []
 t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
  assert.notEqual(init?.method, 'POST'); calls.push(String(url))
  return String(url).includes('/tasks/') ? Response.json({ status: 'succeeded', output: { url: fresh } }) : new Response('expired', { status: 403 })
 })
 await work()
 assert.equal(jobRow(f.job.id).status, 'failed')
 assert.deepEqual(calls, [resultUrl, 'https://offline.invalid/v1/tasks/original-task', fresh])
 assert.ok(checkpoint(f.job.id)); assert.equal(jobRow(f.job.id).error!.includes('private=refresh'), false)
})

test('an expired URL with changed model identity cannot query or dispatch', async t => {
 const f = await fixture()
 saveUrl(f.job.id); run("UPDATE jobs SET external_id='original-task' WHERE id=?", f.job.id)
 prepareGenerationExecution(jobRow(f.job.id), one<any>('SELECT * FROM models WHERE id=?', f.model.id)!, one<any>('SELECT * FROM providers WHERE id=?', f.provider.id)!)
 run("UPDATE models SET remote_id='changed' WHERE id=?", f.model.id)
 const calls: string[] = []
 t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
  assert.notEqual(init?.method, 'POST'); calls.push(String(url)); return new Response('expired', { status: 403 })
 })
 await work()
 assert.equal(jobRow(f.job.id).status, 'failed'); assert.deepEqual(calls, [resultUrl]); assert.ok(checkpoint(f.job.id))
})

async function imageFixture() {
 const f = await fixture()
 run("UPDATE models SET modality='image',protocol='image_generations',settings=? WHERE id=?", JSON.stringify({ request_path: 'images', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}' } }), f.model.id)
 const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#114455' } }).png().toBuffer()
 return { ...f, bytes }
}

test('a Base64 image survives final DB rollback and restarts from its validated local file with no second POST', async t => {
 const f = await imageFixture(); let requests = 0
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { requests++; assert.equal(init?.method, 'POST'); return Response.json({ data: [{ b64_json: f.bytes.toString('base64') }] }) })
 db.exec("CREATE TEMP TRIGGER fail_image_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'mock image commit failure'); END")
 try { await work() } finally { db.exec('DROP TRIGGER fail_image_asset') }
 assert.equal(jobRow(f.job.id).status, 'failed'); assert.equal(requests, 1)
 assert.equal((await publicJob(f.project.id, f.job.id)).recovery_action, 'local')
 run('DELETE FROM providers WHERE id=?', f.provider.id)
 assert.equal((await publicJob(f.project.id, f.job.id)).recovery_modality, 'image')
 assert.equal((await post(`/api/jobs/${f.job.id}/retry`)).statusCode, 200)
 await work()
 assert.equal(jobRow(f.job.id).status, 'succeeded', jobRow(f.job.id).error || ''); assert.equal(requests, 1)
})

test('local completion after a changed status cannot commit an asset or overwrite that status', async t => {
 const f = await imageFixture()
 t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: f.bytes.toString('base64') }] }))
 db.exec("CREATE TEMP TRIGGER stop_after_local AFTER UPDATE OF state ON job_local_results WHEN NEW.state='ready' BEGIN UPDATE jobs SET status='failed',error='cancelled after local output' WHERE id=NEW.job_id; END")
 try { await work() } finally { db.exec('DROP TRIGGER stop_after_local') }
 assert.equal(jobRow(f.job.id).status, 'failed'); assert.equal(jobRow(f.job.id).error, 'cancelled after local output')
 assert.equal(one('SELECT 1 FROM assets WHERE project_id=?', f.project.id), undefined)
 assert.equal((await publicJob(f.project.id, f.job.id)).recovery_action, 'local')
})

test('a late prior worker failure cannot fail a job claimed by a newer worker', async t => {
 const f = await imageFixture()
 let rejectOld: ((reason: Error) => void) | undefined
 t.mock.method(globalThis, 'fetch', async () => new Promise<Response>((_resolve, reject) => { rejectOld = reject }))
 const stop = startWorker()
 try {
  for (let i=0; i<50 && !rejectOld; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(rejectOld)
  const old = mediaJobExecution(f.job.id)!.owner; claimMediaJob(jobRow(f.job.id))
  assert.notEqual(mediaJobExecution(f.job.id)!.owner, old)
  rejectOld(new Error('late old connection error')); await stop()
  assert.equal(jobRow(f.job.id).status, 'running'); assert.equal(jobRow(f.job.id).error, null)
  assert.equal(one('SELECT 1 FROM assets WHERE project_id=?', f.project.id), undefined)
 } finally { await stop() }
})
