import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-private-response-slot-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { generateStructuredOutput } = await import('../src/modules/generation/model-output.js')
assert.ok(db.name.startsWith(dataDir), 'private response tests must use the temporary database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
const factories = {
  generation: (id: string, identity: unknown) => generationCheckpointStore(id, identity),
  review: (id: string, identity: unknown) => generationCheckpointStore(id, identity, 'draft-review'),
  unit: (id: string, identity: unknown) => generationUnitStore(id, 'private-test', identity),
}
let serial = 0
const project = () => { const id = `private-${++serial}`; run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now()); return id }
const entry = (value: unknown) => ({ input_hash: 'a'.repeat(64), value })
const responseId = `response:owned:${'a'.repeat(64)}`
for (const [label, open] of Object.entries(factories)) {
  test(`${label}: cancelled late complete raw merges with a newer sibling without adopting business output`, async () => {
    const projectId = project(), identity = { task: 'late' }
    const pending = deferred<string>(), started = deferred<void>(), finished = deferred<void>()
    const controller = new AbortController()
    const oldStore = open(projectId, identity)
    const oldSteps = createGenerationSteps({ ...oldStore, signal: controller.signal })
    const work = oldSteps.run('old', '旧执行', { prompt: '相同输入' }, async () => {
      try { return await generateStructuredOutput('late_response', z.object({ value: z.number() }).strict(), async () => {
        started.resolve(); return pending.promise
      }, '完整原文', { signal: controller.signal }) }
      finally { finished.resolve() }
    }, value => value)
    await started.promise
    controller.abort(new DOMException('cancel old run', 'AbortError'))
    await assert.rejects(work, /cancel old run/)
    createGenerationSteps(open(projectId, identity)).retain('new-sibling', '新进度', {}, 7, value => value)
    const raw = '  {"value":42}\n'
    pending.resolve(raw)
    await finished.promise
    await new Promise(resolve => setImmediate(resolve))
    const durable = open(projectId, identity).checkpoint
    assert.equal(durable.steps['new-sibling']?.value, 7)
    assert.equal(durable.steps.old, undefined, 'a cancelled complete raw is not an adopted business step')
    const saved = Object.entries(durable.steps).filter(([id]) => id.startsWith('response:'))
    assert.equal(saved.length, 1)
    assert.equal((saved[0][1].value as { raw: string }).raw, raw)
    assert.equal((saved[0][1].value as { original_raw: string }).original_raw, raw)
  })

  test(`${label}: a later business save cannot erase complete private raw received after that writer opened`, async () => {
    const projectId = project(), identity = { task: 'reverse-order' }, store = open(projectId, identity)
    const claimed = entry({ input_hash: 'inner', initial_started: { input_hash: 'inner' } })
    store.savePrivateResponse(responseId, claimed)
    const staleStore = open(projectId, identity), pending = deferred<number>(), started = deferred<void>()
    const sibling = createGenerationSteps(staleStore).run('new-sibling', '新进度', {}, async () => { started.resolve(); return pending.promise }, value => value)
    await started.promise
    store.savePrivateResponse(responseId, entry({ input_hash: 'inner', raw: 'late original', original_raw: 'late original',
      correction_started: { input_hash: 'used' }, correction: { input_hash: 'used', raw: 'one correction' } }), claimed)
    pending.resolve(7)
    await sibling
    const durable = open(projectId, identity).checkpoint
    assert.equal(durable.steps['new-sibling']?.value, 7)
    assert.deepEqual(durable.steps[responseId].value, { input_hash: 'inner', raw: 'late original', original_raw: 'late original',
      correction: { input_hash: 'used', raw: 'one correction' }, correction_started: { input_hash: 'used' } })
  })

  test(`${label}: late writes stay in their identity after another identity becomes active`, async () => {
    const projectId = project(), a = { task: 'A' }, b = { task: 'B' }
    const old = open(projectId, a)
    const claimed = entry({ input_hash: 'inner', initial_started: { input_hash: 'inner' } })
    old.savePrivateResponse(responseId, claimed)
    const next = open(projectId, b)
    next.save({ steps: { sibling: { input_hash: 'b'.repeat(64), value: 'new identity' } } })
    const raw = entry({ input_hash: 'inner', raw: 'complete old bytes', original_raw: 'complete old bytes' })
    old.savePrivateResponse(responseId, raw, claimed)
    assert.equal(open(projectId, b).checkpoint.steps.sibling?.value, 'new identity')
    assert.equal((open(projectId, a).checkpoint.steps[responseId]?.value as { raw?: string })?.raw, 'complete old bytes')
    if (label !== 'unit') {
      const table = label === 'generation' ? 'script_generation_checkpoints' : 'script_step_checkpoints'
      const active = db.prepare(`SELECT payload FROM ${table} WHERE project_id=?${label === 'review' ? " AND namespace='draft-review'" : ''}`).get(projectId) as { payload: string }
      assert.equal(JSON.parse(active.payload).steps.sibling.value, 'new identity', 'late raw must not take the active identity back')
    }
  })

  test(`${label}: a stale private delta preserves newer correction intent and response; conflicts roll back`, () => {
    const projectId = project(), identity = { task: 'same-slot' }
    const first = open(projectId, identity), other = open(projectId, identity)
    const base = entry({ input_hash: 'inner', raw: '{"v":null}', original_raw: '  {"v":null}\n' })
    first.savePrivateResponse(responseId, base)
    const claim = entry({ ...base.value as object, correction_started: { input_hash: 'correction' } })
    other.savePrivateResponse(responseId, claim, base)
    // This writer only changes canonical replay; its old snapshot lacks the
    // concurrently persisted correction allowance and must not delete it.
    const canonical = entry({ ...base.value as object, raw: '{"v":1}' })
    first.savePrivateResponse(responseId, canonical, base)
    const withCorrection = entry({ ...claim.value as object, raw: '{"v":1}', correction: { input_hash: 'correction', raw: 'actual patch' } })
    other.savePrivateResponse(responseId, withCorrection, claim)
    const expected = open(projectId, identity).checkpoint
    assert.throws(() => first.savePrivateResponse(responseId, entry({ ...base.value as object, raw: 'stale old overwrite' }), base), /已有更新/)
    assert.deepEqual(open(projectId, identity).checkpoint, expected)
    assert.deepEqual((expected.steps[responseId].value as { correction_started: unknown }).correction_started, { input_hash: 'correction' })
    assert.equal((expected.steps[responseId].value as { correction: { raw: string } }).correction.raw, 'actual patch')
    assert.equal((expected.steps[responseId].value as { original_raw: string }).original_raw, '  {"v":null}\n')
  })

  test(`${label}: trusted nondelivery can release an unchanged intent; two stale claimants cannot both dispatch`, async () => {
    const projectId = project(), identity = { task: 'retry' }, store = open(projectId, identity)
    const baseline = entry({ input_hash: 'inner' }), claimed = entry({ input_hash: 'inner', initial_started: { input_hash: 'inner' } })
    store.savePrivateResponse(responseId, baseline)
    store.savePrivateResponse(responseId, claimed, baseline)
    assert.throws(() => store.savePrivateResponse(responseId, claimed, baseline), /已有更新/)
    store.savePrivateResponse(responseId, baseline, claimed)
    assert.deepEqual(store.savePrivateResponse(responseId, claimed, baseline).steps[responseId], claimed)

    const concurrentId = project(), old = createGenerationSteps(open(concurrentId, identity)), stale = createGenerationSteps(open(concurrentId, identity))
    const pending = deferred<string>(), started = deferred<void>()
    let calls = 0
    const output = () => generateStructuredOutput('concurrent', z.object({ v: z.number() }), async () => { calls++; started.resolve(); return pending.promise }, 'same prompt')
    const first = old.run('same', 'first', {}, output, value => value)
    await started.promise
    await assert.rejects(stale.run('same', 'second', {}, output, value => value), /上次初始请求已开始/)
    assert.equal(calls, 1)
    pending.resolve('{"v":1}')
    await first
    assert.equal(calls, 1)
  })
}

test('a compatible private activation consumes only its reused serializer alias before an explicit clear', () => {
  const projectId = project(), a = { task: 'alias', serializer: 1 }, b = { task: 'alias', serializer: 2 }
  generationCheckpointStore(projectId, a).save({ steps: { done: { input_hash: 'b'.repeat(64), value: 'accepted work' } } })
  const compatible = generationCheckpointStore(projectId, b, 'generation', [a])
  compatible.savePrivateResponse(responseId, entry({ input_hash: 'inner', initial_started: { input_hash: 'inner' } }))
  clearGenerationCheckpoint(projectId)
  assert.deepEqual(generationCheckpointStore(projectId, a).checkpoint.steps, {})
  assert.deepEqual(generationCheckpointStore(projectId, b).checkpoint.steps, {})
})

test('explicit clear deletes archived review private versions instead of reviving a discarded request', () => {
  const projectId = project(), a = { task: 'A' }, b = { task: 'B' }
  const old = generationCheckpointStore(projectId, a, 'draft-review')
  const initial = entry({ input_hash: 'inner', initial_started: { input_hash: 'inner' } })
  old.savePrivateResponse(responseId, initial)
  generationCheckpointStore(projectId, b, 'draft-review').save({ steps: {} })
  old.savePrivateResponse(responseId, entry({ input_hash: 'inner', raw: 'old complete' }), initial)
  assert.equal(Object.keys(generationCheckpointStore(projectId, a, 'draft-review').checkpoint.steps).length, 1)
  clearGenerationCheckpoint(projectId, { keepReview: true })
  assert.equal(Object.keys(generationCheckpointStore(projectId, a, 'draft-review').checkpoint.steps).length, 1)
  clearGenerationCheckpoint(projectId)
  assert.deepEqual(generationCheckpointStore(projectId, a, 'draft-review').checkpoint.steps, {})
})
