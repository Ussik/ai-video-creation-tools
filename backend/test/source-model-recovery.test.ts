import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-source-request-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, hasSourceModelRun } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { backgroundTextResponse } = await import('../src/infrastructure/providers/text-background.js')
initDb(); db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'source recovery', now(), now())
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const call = (generate: ReturnType<typeof sourceModelRecovery>, prompt = '当前原稿完整证据') => generate('p', 'model', prompt, undefined, new AbortController().signal)

test('completed upstream output before business checkpoint survives process reconstruction, and explicit new run permits new intentional work', async () => {
  let calls = 0
  const generate = async () => { calls++; notifyTextRequest('dispatch', { delivery: 'unknown' }); return '{"sections":["完整结果"]}' }
  const identity = { source: 'v1', model: 'm' }
  const first = sourceModelRecovery('p', 'run-complete', identity, generate)
  const output = await call(first)
  assert.equal(hasSourceModelRun('p', 'run-complete'), true)
  const reconstructed = sourceModelRecovery('p', 'run-complete', identity, generate)
  assert.equal(await call(reconstructed), output); assert.equal(calls, 1)
  await call(sourceModelRecovery('p', 'run-intent-new', identity, generate))
  assert.equal(calls, 2)
})

test('unknown ordinary dispatch cannot be automatically resent after restart or a new analysis ID', async () => {
  let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; throw new Error('响应在受理后丢失') }
  const identity = { source: 'unknown-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-unknown', identity, generate)), /丢失/)
  for (const id of ['run-unknown', 'run-retry-new']) {
    await assert.rejects(call(sourceModelRecovery('p', id, identity, generate)), /不能自动重新生成/)
    assert.equal(posts, 1)
  }
})

test('local preparation failure and explicitly rejected delivery do not become uncertain paid outcomes', async () => {
  let calls = 0
  const identity = { source: 'local-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-local', identity, async () => { throw new Error('尚未派发的配置错误') })), /尚未派发/)
  const recovered = sourceModelRecovery('p', 'run-local', identity, async () => { calls++; return '本地修复后完整结果' })
  assert.equal(await call(recovered), '本地修复后完整结果'); assert.equal(calls, 1)
  const rejected = { source: 'rejected-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-rejected', rejected, async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); notifyTextRequest('metrics', { delivery: 'rejected' }); throw new Error('鉴权拒绝') })), /鉴权拒绝/)
  assert.equal(await call(sourceModelRecovery('p', 'run-rejected', rejected, async () => '修复认证后的结果')), '修复认证后的结果')
})

test('accepted background response resumes by GET under the original response identity without another POST', async t => {
  let posts = 0, gets = 0, failFirstPoll = true
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { posts++; return Response.json({ id: 'resp_source_saved', status: 'in_progress' }) }
    gets++
    if (failFirstPoll) { failFirstPoll = false; throw new Error('模拟查询断线') }
    return Response.json({ id: 'resp_source_saved', status: 'completed', output_text: '已完成的原请求结果' })
  })
  const generate = async (_p: string, _m: string, prompt: string, _contract: unknown, signal: AbortSignal) => {
    const response = await backgroundTextResponse('https://fixture.invalid/responses', { model: 'same', input: prompt }, {}, signal, promise => promise, () => {})
    return JSON.stringify(await response.json())
  }
  const identity = { source: 'background-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-background', identity, generate)), /查询断线/)
  const result = await call(sourceModelRecovery('p', 'run-background', identity, generate))
  assert.match(result, /已完成的原请求结果/); assert.equal(posts, 1); assert.equal(gets, 2)
})

test('journal persistence failure prevents actual paid dispatch', async () => {
  let posts = 0
  const generate = sourceModelRecovery('p', 'run-persist-fail', { source: 'persist-fail' }, async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; return '不应发生' })
  db.exec("CREATE TRIGGER reject_source_dispatch BEFORE UPDATE ON source_model_requests WHEN NEW.state='dispatched' AND NEW.run_id='run-persist-fail' BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END")
  try { await assert.rejects(call(generate), /journal failure/); assert.equal(posts, 0) }
  finally { db.exec('DROP TRIGGER reject_source_dispatch') }
})

test('completed output persistence failure retains dispatch barrier across a new run', async () => {
  let posts = 0
  const identity = { source: 'complete-write-fail' }
  const generate = async () => {
    notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++
    notifyTextRequest('metrics', { delivery: 'completed' })
    return '原请求已完成但本地写失败'
  }
  const first = sourceModelRecovery('p', 'run-complete-write-fail', identity, generate)
  db.exec("CREATE TRIGGER reject_source_complete BEFORE UPDATE ON source_model_requests WHEN NEW.state='completed' AND NEW.run_id='run-complete-write-fail' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END")
  try { await assert.rejects(call(first), /completion failure/) }
  finally { db.exec('DROP TRIGGER reject_source_complete') }
  await assert.rejects(call(sourceModelRecovery('p', 'run-after-write-fail', identity, generate)), /不能自动重新生成/)
  assert.equal(posts, 1)
})

test('cancellation after upstream completion retains the full result before aborting the consumer', async () => {
  const controller = new AbortController(); let posts = 0
  const identity = { source: 'cancel-after-complete' }
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; controller.abort(); return '已完成全文' }
  const first = sourceModelRecovery('p', 'run-complete-cancel', identity, generate)
  await assert.rejects(first('p', 'model', '当前原稿完整证据', undefined, controller.signal))
  const reconstructed = sourceModelRecovery('p', 'run-complete-cancel', identity, generate)
  assert.equal(await call(reconstructed), '已完成全文'); assert.equal(posts, 1)
})
