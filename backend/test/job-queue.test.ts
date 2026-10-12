import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-job-queue-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/app.js')
const { db, run, one, now } = await import('../src/infrastructure/database/db.js')
const { initJobQueue, startJobQueue, jobQueueStatus } = await import('../src/modules/jobs/job-queue.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
beforeEach(() => {
  run('DELETE FROM projects')
  run('DELETE FROM providers')
  run('UPDATE job_queue_settings SET concurrency=3 WHERE id=1')
  for (const id of ['project-a', 'project-b']) run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now())
})

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function enqueue(id: string, kind = 'generation', project = 'project-a') {
  run('INSERT INTO jobs (id,project_id,job_type,request,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    id, project, kind, JSON.stringify({ prompt: id }), 'queued', '2026-10-11T10:00:00Z', now())
}
function status(id: string) { return one<{ status: string }>('SELECT status FROM jobs WHERE id=?', id)!.status }
async function limit(concurrency: number) {
  const response = await app.inject({ method: 'PUT', url: '/api/job-queue', payload: { concurrency } })
  assert.equal(response.statusCode, 200, response.body)
  await flush()
  return response.json()
}
function harness() {
  const started: string[] = []
  const gates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  const stops: Array<() => Promise<void>> = []
  let peak = 0
  function start() {
    const stop = startJobQueue(async job => {
      started.push(job.id)
      peak = Math.max(peak, jobQueueStatus().running)
      assert.equal(status(job.id), 'running', 'claimed before starting the processor')
      await new Promise<void>((resolve, reject) => gates.set(job.id, { resolve, reject }))
      run("UPDATE jobs SET status='succeeded' WHERE id=?", job.id)
    }, (job, error) => run("UPDATE jobs SET status='failed',error=? WHERE id=?", String(error), job.id))
    stops.push(stop)
    return stop
  }
  return { started, gates, start, get peak() { return peak },
    async close() {
      const drained = stops.map(stop => stop())
      for (const gate of gates.values()) gate.resolve()
      await Promise.all(drained)
    } }
}

test('three jobs overlap across projects and each success or failure refills its slot without waiting for slow peers', async () => {
  for (let index = 1; index <= 5; index++) enqueue(`job-${index}`, 'generation', index % 2 ? 'project-a' : 'project-b')
  const worker = harness()
  worker.start()
  try {
    await flush()
    assert.deepEqual(worker.started, ['job-1', 'job-2', 'job-3'])
    assert.equal(status('job-4'), 'queued')
    assert.equal(jobQueueStatus().running, 3)
    worker.gates.get('job-2')!.resolve()
    await flush()
    assert.deepEqual(worker.started, ['job-1', 'job-2', 'job-3', 'job-4'])
    assert.equal(status('job-1'), 'running')
    worker.gates.get('job-3')!.reject(new Error('mock provider failure'))
    await flush()
    assert.equal(status('job-3'), 'failed')
    assert.equal(status('job-5'), 'running')
    assert.equal(worker.peak, 3)
    assert.equal(one<{ request: string }>('SELECT request FROM jobs WHERE id=?', 'job-5')!.request, '{"prompt":"job-5"}')
  } finally { await worker.close() }
})

test('API settings persist across initialization and reject invalid or excessive limits', async () => {
  const initial = await app.inject({ method: 'GET', url: '/api/job-queue' })
  assert.deepEqual(initial.json(), { concurrency: 3, max_concurrency: 10, running: 0, queued: 0 })
  await limit(5)
  initJobQueue()
  assert.equal((await app.inject({ method: 'GET', url: '/api/job-queue' })).json().concurrency, 5)
  for (const payload of [{}, { concurrency: 0 }, { concurrency: 11 }, { concurrency: 1.5 }, { concurrency: '5' }, { concurrency: 3, extra: true }]) {
    const response = await app.inject({ method: 'PUT', url: '/api/job-queue', payload })
    assert.equal(response.statusCode, 422, response.body)
    assert.equal(jobQueueStatus().concurrency, 5)
  }
  await limit(1)
  await limit(10)
})

test('raising the limit immediately fills capacity; lowering it never interrupts running jobs', async () => {
  await limit(1)
  for (let index = 1; index <= 5; index++) enqueue(`job-${index}`)
  const worker = harness()
  worker.start()
  try {
    await flush()
    assert.deepEqual(worker.started, ['job-1'])
    await limit(3)
    assert.deepEqual(worker.started, ['job-1', 'job-2', 'job-3'])
    assert.equal((await limit(1)).running, 3)
    worker.gates.get('job-1')!.resolve(); await flush()
    worker.gates.get('job-2')!.resolve(); await flush()
    assert.equal(status('job-4'), 'queued')
    assert.equal(status('job-3'), 'running')
    worker.gates.get('job-3')!.resolve(); await flush()
    assert.equal(status('job-4'), 'running')
    assert.equal(status('job-5'), 'queued')
  } finally { await worker.close() }
})

test('multiple workers cannot duplicate claims or exceed global capacity', async () => {
  for (let index = 1; index <= 8; index++) enqueue(`job-${index}`)
  const worker = harness()
  worker.start(); worker.start()
  try {
    await flush()
    assert.equal(worker.started.length, 3)
    worker.gates.get('job-1')!.resolve(); await flush()
    worker.gates.get('job-2')!.resolve(); await flush()
    await limit(4)
    assert.equal(worker.started.length, 6)
    assert.equal(new Set(worker.started).size, worker.started.length)
    assert.equal(jobQueueStatus().running, 4)
    assert.equal(worker.peak, 4)
  } finally { await worker.close() }
})

test('exports run one at a time and a waiting export does not block generation', async () => {
  enqueue('export-1', 'export'); enqueue('export-2', 'export'); enqueue('image'); enqueue('speech'); enqueue('video')
  const worker = harness()
  worker.start()
  try {
    await flush()
    assert.deepEqual(worker.started, ['export-1', 'image', 'speech'])
    worker.gates.get('image')!.resolve(); await flush()
    assert.equal(status('video'), 'running')
    assert.equal(status('export-2'), 'queued')
    worker.gates.get('export-1')!.resolve(); await flush()
    assert.equal(status('export-2'), 'running')
    assert.equal(jobQueueStatus().running, 3)
  } finally { await worker.close() }
})

test('stop drains running work, does not claim queued jobs, and does not leave a polling timer', async () => {
  await limit(1)
  enqueue('running'); enqueue('waiting')
  const worker = harness()
  const stop = worker.start()
  try {
    await flush()
    let drained = false
    const stopping = stop().then(() => { drained = true })
    await flush()
    assert.equal(drained, false)
    worker.gates.get('running')!.resolve()
    await stopping
    assert.equal(status('waiting'), 'queued')
    await limit(10)
    assert.equal(status('waiting'), 'queued', 'stopped worker is removed from the wake list')
    assert.deepEqual(worker.started, ['running'])
  } finally { await worker.close() }
})

test('actual worker overlaps HTTP requests and writes each out-of-order result to the correct task', async t => {
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: 'mock', base_url: 'https://offline.invalid/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: {
    provider_id: provider.id, name: 'offline text', remote_id: 'text', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' },
  } })).json()
  assert.ok(model.id)
  const ids = ['first', 'second', 'third', 'fourth']
  for (const id of ids) {
    enqueue(id)
    run('UPDATE jobs SET model_id=? WHERE id=?', model.id, id)
  }
  const requests: string[] = [], gates = new Map<string, (response: Response) => void>()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const prompt = JSON.parse(String(options.body)).messages[0].content
    requests.push(prompt)
    return new Promise<Response>(resolve => gates.set(prompt, resolve))
  })
  const stop = startWorker()
  async function complete(id: string) {
    gates.get(id)!(Response.json({ choices: [{ message: { content: `result-${id}` } }] }))
    for (let attempt = 0; attempt < 100 && status(id) === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(status(id), 'succeeded')
  }
  try {
    await flush()
    assert.deepEqual(requests, ['first', 'second', 'third'])
    await complete('second')
    await flush()
    assert.deepEqual(requests, ['first', 'second', 'third', 'fourth'])
    await complete('fourth'); await complete('third'); await complete('first')
    const { readFile } = await import('node:fs/promises')
    for (const id of ids) {
      const result = one<{ id: string; path: string; prompt: string }>('SELECT assets.id,path,prompt FROM assets JOIN jobs ON jobs.result_asset_id=assets.id WHERE jobs.id=?', id)!
      assert.ok(result.id)
      assert.equal(result.prompt, id)
      assert.equal(await readFile(result.path, 'utf8'), `result-${id}`)
    }
    assert.equal(jobQueueStatus().running, 0)
  } finally {
    const drained = stop()
    for (const [id, resolve] of gates) resolve(Response.json({ choices: [{ message: { content: `result-${id}` } }] }))
    await drained
  }
})
