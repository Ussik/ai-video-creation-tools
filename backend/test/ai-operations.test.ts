import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import { isAiOperationRoute, canonicalAiValue } from '@video-studio/shared/api/ai-operations'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-ai-operations-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { registerAiOperations, retainAiOperationCandidate } = await import('../src/modules/generation/ai-operations.js')
const { registerModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
initDb()
for (const id of ['p', 'other']) db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, now(), now())
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
async function fixture(work: (body: unknown, request: FastifyRequest) => Promise<unknown>) {
  const app = Fastify()
  registerModelRequestObservation(app); registerAiOperations(app)
  app.post('/api/projects/:id/skills/refine-prompt', request => work(request.body, request))
  return app
}
const path = '/api/projects/p/skills/refine-prompt'
const request = (id: string, body: unknown = { prompt: '保留完整候选' }) => ({ method: 'POST' as const, url: path, headers: { 'x-ai-operation-id': id }, payload: body })

test('lost response lookup and terminal replay return original candidate without regeneration; new identity permits intentional same input', async () => {
  let calls = 0
  const app = await fixture(async () => ({ prompt: `完整候选${++calls}`, quality: 'inconclusive' }))
  try {
    const first = await app.inject(request('intent-first'))
    assert.equal(first.statusCode, 200)
    const lookup = await app.inject({ method: 'GET', url: '/api/ai-operations/intent-first' })
    assert.equal(lookup.json().state, 'completed'); assert.deepEqual(lookup.json().result, first.json())
    const replay = await app.inject(request('intent-first'))
    assert.deepEqual(replay.json(), first.json()); assert.equal(calls, 1)
    const next = await app.inject(request('intent-new'))
    assert.equal(next.json().prompt, '完整候选2'); assert.equal(calls, 2)
    const otherProject = await app.inject({ method: 'GET', url: '/api/projects/other/ai-operations/intent-first' })
    assert.equal(otherProject.statusCode, 404); assert.equal(otherProject.json().code, 'ai_operation_not_found')
  } finally { await app.close() }
})

test('concurrent replay observes one owner and changed payload cannot reuse an intent', async () => {
  let calls = 0, started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const app = await fixture(async () => { calls++; started(); await gate; return { prompt: '原始成果' } })
  try {
    const first = app.inject(request('intent-concurrent')); await ready
    const second = await app.inject(request('intent-concurrent'))
    assert.equal(second.statusCode, 409); assert.equal(second.json().code, 'ai_operation_running'); assert.equal(calls, 1)
    const changed = await app.inject(request('intent-concurrent', { prompt: '另一份输入' }))
    assert.equal(changed.statusCode, 409); assert.equal(changed.json().code, 'ai_operation_conflict')
    release(); assert.equal((await first).statusCode, 200)
    const ordered = await app.inject(request('intent-order', { b: 2, a: 1 }))
    const canonical = await app.inject(request('intent-order', { a: 1, b: 2 }))
    assert.deepEqual(ordered.json(), canonical.json()); assert.equal(calls, 2)
  } finally { release(); await app.close() }
})

test('interrupted ownership does not automatically rerun, and malformed identities fail before handler', async () => {
  let calls = 0
  const app = await fixture(async () => { calls++; return { result: '保存' } })
  try {
    await app.inject(request('intent-interrupted'))
    db.prepare("UPDATE ai_operations SET state='running',result=NULL,status_code=NULL,lease_until=0 WHERE id=?").run('intent-interrupted')
    assert.equal((await app.inject({ method: 'GET', url: '/api/ai-operations/intent-interrupted' })).json().state, 'interrupted')
    const replay = await app.inject(request('intent-interrupted'))
    assert.equal(replay.statusCode, 409); assert.equal(replay.json().code, 'ai_operation_interrupted'); assert.equal(calls, 1)
    assert.equal((await app.inject(request('bad id'))).statusCode, 422); assert.equal(calls, 1)
    const missing = await app.inject({ method: 'GET', url: '/api/ai-operations/does-not-exist' })
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'ai_operation_not_found')
  } finally { await app.close() }
})

test('legacy requests receive generated identity and safe machine errors survive persisted replay', async () => {
  let calls = 0
  const app = await fixture(async () => { calls++; throw Object.assign(new Error('来源已变化'), { statusCode: 409, code: 'candidate_stale' }) })
  try {
    const first = await app.inject({ method: 'POST', url: path, payload: {} })
    const id = first.headers['x-ai-operation-id']
    assert.equal(typeof id, 'string'); assert.equal(first.statusCode, 409)
    assert.equal(first.json().code, 'candidate_stale'); assert.equal(first.json().category, 'source_conflict')
    assert.equal(first.json().operation_id, id); assert.equal(first.json().recovery.kind, 'observe')
    const replay = await app.inject(request(String(id), {}))
    assert.deepEqual(replay.json(), first.json()); assert.equal(calls, 1)
    assert.equal((await app.inject({ method: 'GET', url: `/api/ai-operations/${id}` })).json().error.code, 'candidate_stale')
  } finally { await app.close() }
})

test('inventory covers every JSON AI family and excludes state edits, streams and existing task control', () => {
  for (const route of ['skills/refine-prompt', 'canvas/image-prompt-analysis', 'canvas/video-prompt-analysis', 'canvas/video-audio-plan', 'canvas/video-continuity-review', 'script/canvas/prepare', 'script/source/analysis', 'script/artifacts/generate', 'script/generate', 'script/director/chat', 'script/plan-shots', 'script/replies/classify', 'script/themes/visuals', 'script/director/asset-prompt', 'script/storyboard/plan', 'script/storyboard/review', 'script/storyboard/repair', 'storyboard/clip/plan', 'storyboard/clip/review', 'visual-profiles/analyze', 'speech/lines/line/generate', 'speech/batch/generate', 'assets/asset/video-reviews', 'canvases/canvas/node-proposals', 'jobs/job/optimize-prompt', 'generate', 'continuity/analyze', 'video-comparisons/comparison/start']) assert.equal(isAiOperationRoute('POST', `/api/projects/p/${route}`), true, route)
  for (const route of ['/visual-profiles/profile/reference-generate', '/visual-profiles/profile/generate', '/asset-tasks/task/generate', '/jobs/job/retry']) assert.equal(isAiOperationRoute('POST', route), true, route)
  for (const route of ['/projects/p/script/director/chat/stream', '/projects/p/script/director/tasks/task/continue', '/projects/p/script/storyboard/tasks', '/projects/p/script/storyboard/tasks/task/resume', '/projects/p/script/source/analysis/pause', '/projects/p/shots', '/projects/p/speech/lines', '/projects/p/script/generate/prompt']) assert.equal(isAiOperationRoute('POST', route), false, route)
  assert.equal(isAiOperationRoute('GET', '/projects/p/generate'), false)
  assert.equal(canonicalAiValue({ b: [1, undefined], a: { z: false, ignored: undefined } }), '{"a":{"z":false},"b":[1,null]}')
})

test('result persistence failure cannot report success or permit a second dispatch', async () => {
  let calls = 0
  const app = await fixture(async () => { calls++; return { prompt: '已完成的上游结果' } })
  db.exec(`CREATE TRIGGER fail_operation_result BEFORE UPDATE OF result ON ai_operations
    WHEN NEW.id='intent-write-failure' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END`)
  try {
    const response = await app.inject(request('intent-write-failure'))
    assert.ok(response.statusCode >= 500)
    const row = db.prepare('SELECT state,result FROM ai_operations WHERE id=?').get('intent-write-failure') as { state: string; result: string | null }
    assert.equal(row.state, 'running'); assert.equal(row.result, null)
    const replay = await app.inject(request('intent-write-failure'))
    assert.equal(replay.statusCode, 409); assert.equal(calls, 1)
  } finally { db.exec('DROP TRIGGER fail_operation_result'); await app.close() }
})

test('late response with changed ownership cannot publish a successful candidate', async () => {
  const app = await fixture(async () => {
    db.prepare('UPDATE ai_operations SET owner=? WHERE id=?').run('another-owner', 'intent-lost-owner')
    return { prompt: '过期执行者的结果' }
  })
  try {
    const response = await app.inject(request('intent-lost-owner'))
    assert.ok(response.statusCode >= 500)
    const record = (await app.inject({ method: 'GET', url: '/api/ai-operations/intent-lost-owner' })).json()
    assert.equal(record.state, 'running'); assert.equal(record.result, undefined)
  } finally { await app.close() }
})

test('operation stop cancels local context and accurately preserves remote uncertainty', async () => {
  const { currentModelRequestContext } = await import('../src/modules/generation/model-task-policy.js')
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const app = await fixture(async () => {
    const signal = currentModelRequestContext()!.signal!
    started()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('本地停止'), { statusCode: 499 })), { once: true }))
    return { prompt: '不应返回' }
  })
  try {
    const pending = app.inject(request('intent-local-stop')); await ready
    const stop = await app.inject({ method: 'POST', url: '/api/projects/p/ai-operations/intent-local-stop/stop' })
    assert.equal(stop.json().stopped, true); assert.equal(stop.json().remote_cancelled, false)
    assert.equal((await pending).statusCode, 499)
    const record = (await app.inject({ method: 'GET', url: '/api/ai-operations/intent-local-stop' })).json()
    assert.equal(record.state, 'failed'); assert.equal(record.error.category, 'cancelled')
  } finally { await app.close() }
})

test('a complete candidate retained before review survives interruption without permitting another dispatch', async () => {
  let calls = 0, started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const candidate = { shots: [{ title: '原片段完整镜头' }], directing_review: { status: 'inconclusive', issues: [] } }
  const app = await fixture(async (_body, request) => {
    calls++; assert.equal(retainAiOperationCandidate(request, candidate), true)
    started(); await gate
    return { ...candidate, reviewed: true }
  })
  try {
    const pending = app.inject(request('intent-retained-candidate')); await ready
    db.prepare('UPDATE ai_operations SET lease_until=0 WHERE id=?').run('intent-retained-candidate')
    const lookup = await app.inject({ method: 'GET', url: '/api/ai-operations/intent-retained-candidate' })
    assert.equal(lookup.json().state, 'interrupted'); assert.deepEqual(lookup.json().candidate, candidate)
    assert.equal(lookup.json().result, undefined); assert.equal(lookup.json().status_code, null)
    assert.equal((await app.inject(request('intent-retained-candidate'))).statusCode, 409)
    assert.equal(calls, 1)
    release(); assert.equal((await pending).statusCode, 200)
  } finally { release(); await app.close() }
})

test('candidate checkpoint failure prevents subsequent paid review', async () => {
  let reviews = 0
  const app = await fixture(async (_body, request) => {
    retainAiOperationCandidate(request, { shots: [{ title: '完整镜头' }] })
    reviews++; return { approved: true }
  })
  db.exec(`CREATE TRIGGER fail_candidate_checkpoint BEFORE UPDATE OF candidate ON ai_operations
    WHEN NEW.id='intent-checkpoint-fail' BEGIN SELECT RAISE(ABORT,'injected candidate checkpoint failure'); END`)
  try {
    const response = await app.inject(request('intent-checkpoint-fail'))
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'ai_candidate_persist_failed'); assert.equal(reviews, 0)
  } finally { db.exec('DROP TRIGGER fail_candidate_checkpoint'); await app.close() }
})
