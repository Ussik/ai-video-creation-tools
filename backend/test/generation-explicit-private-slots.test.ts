import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
import type { GenerationPrivateWrite } from '../src/modules/generation/generation-private-response.js'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-explicit-private-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now } = await import('../src/infrastructure/database/db.js')
const { generationCheckpointStore } = await import('../src/modules/script/script-generation-checkpoints.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { createRepairBatchLedger } = await import('../src/modules/script/script-draft-repair-batches.js')
const { generateScriptDraftRepairOutput } = await import('../src/modules/script/script-draft-repair-generation.js')
const { generateScriptDraftRepairWorksets } = await import('../src/modules/script/script-draft-repair-worksets.js')
assert.ok(db.name.startsWith(dataDir), 'tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
const settleLate = () => new Promise(resolve => setImmediate(resolve))
const factories = {
  repair: (id: string, identity: unknown) => generationCheckpointStore(id, identity, 'repair'),
  generation: (id: string, identity: unknown) => generationCheckpointStore(id, identity),
  unit: (id: string, identity: unknown) => generationUnitStore(id, 'repair-private', identity),
}
let serial = 0
const project = () => { const id = `explicit-private-${++serial}`; run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, id, now(), now()); return id }
const proposalSchema = z.object({ input_hash: z.string().optional(), raw: z.string().optional(), original_raw: z.string().optional(),
  initial_started: z.object({ input_hash: z.string() }).optional(), correction_started: z.object({ input_hash: z.string() }).optional(),
  correction: z.object({ input_hash: z.string(), raw: z.string() }).optional(), proposal_state: z.unknown().optional() }).strict()
for (const [label, open] of Object.entries(factories)) {
  for (const mode of ['structured', 'workset'] as const) {
    test(`${label}/${mode}: late raw merges with new progress and stays in the original identity`, async () => {
      const projectId = project(), identity = { task: 'A' }, b = { task: 'B' }
      const pending = deferred<string>(), started = deferred<void>(), controller = new AbortController()
      const store = open(projectId, identity), steps = createGenerationSteps({ ...store, signal: controller.signal })
      let calls = 0
      const generate = async () => { calls++; started.resolve(); return pending.promise }
      const promise = mode === 'structured'
        ? generateScriptDraftRepairOutput('精确完整修订', ['issue'], generate, { steps, signal: controller.signal })
        : generateScriptDraftRepairWorksets({ prompt: '完整授权范围', issueIds: ['issue'], manualPlans: ['保持其他原文，落实本项'],
          sources: [{ key: 'doc:a', content: '冻结原文。' }], referenceIdentity: { candidate_id: 'candidate', candidate_version: 'v1', source_version: 'source' },
          executionIdentity: { model: 'fake' }, generate, steps, signal: controller.signal, validate: () => {} })
      await started.promise
      controller.abort(new DOMException('cancel old request', 'AbortError'))
      await assert.rejects(promise)
      createGenerationSteps(open(projectId, identity)).retain('new-sibling', '后续进度', {}, 7, value => value)
      open(projectId, b).save({ steps: { other: { input_hash: 'b'.repeat(64), value: 'active B' } } })
      const raw = '  {"summary":"完整迟到响应","decisions":["决定"],"edits":[],"source_edits":[]}\n'
      pending.resolve(raw)
      await settleLate()
      const durable = open(projectId, identity).checkpoint
      assert.equal(durable.steps['new-sibling']?.value, 7)
      const prefix = mode === 'structured' ? 'repair:structured:' : 'repair:worksets:proposal:'
      const entries = Object.entries(durable.steps).filter(([id]) => id.startsWith(prefix))
      assert.equal(entries.length, 1)
      assert.equal((entries[0][1].value as { raw?: string }).raw, raw)
      assert.equal((entries[0][1].value as { original_raw?: string }).original_raw, raw)
      assert.equal(open(projectId, b).checkpoint.steps.other?.value, 'active B')
      assert.equal(calls, 1)
      if (label !== 'unit') {
        const table = label === 'generation' ? 'script_generation_checkpoints' : 'script_step_checkpoints'
        const row = db.prepare(`SELECT payload FROM ${table} WHERE project_id=?${label === 'repair' ? " AND namespace='repair'" : ''}`).get(projectId) as { payload: string }
        assert.equal(JSON.parse(row.payload).steps.other.value, 'active B')
      }
    })
  }

  test(`${label}: business snapshots cannot erase either proposal or native turn slots`, async () => {
    const projectId = project(), identity = {}, store = open(projectId, identity)
    const proposalId = `repair:worksets:proposal:${'a'.repeat(24)}`
    const before = createGenerationSteps(store)
    const pending = deferred<number>(), started = deferred<void>()
    const business = before.run('new-sibling', '稍后完成', {}, async () => { started.resolve(); return pending.promise }, value => value)
    await started.promise
    const fresh = createGenerationSteps(open(projectId, identity))
    fresh.retain(proposalId, '完整提案', { input: 1 }, { raw: 'complete raw', original_raw: 'complete raw', correction_started: { input_hash: 'used' }, proposal_state: { retained_indices: [0] } }, proposalSchema.parse)
    const ledger = createRepairBatchLedger(['i'], { native: 1 }, fresh)
    ledger.claimTurn('request-1')
    ledger.recordTurn({ text: 'complete native turn', calls: [] })
    pending.resolve(7); await business
    const durable = open(projectId, identity).checkpoint
    assert.equal(durable.steps['new-sibling']?.value, 7)
    assert.equal((durable.steps[proposalId].value as { raw: string }).raw, 'complete raw')
    assert.deepEqual((durable.steps[proposalId].value as { proposal_state: unknown }).proposal_state, { retained_indices: [0] })
    const resumed = createRepairBatchLedger(['i'], { native: 1 }, createGenerationSteps(open(projectId, identity)))
    assert.deepEqual(resumed.unprocessedTurn(), { text: 'complete native turn', calls: [] })
    assert.equal(resumed.hasPendingRequest(), false)
  })

  test(`${label}: native late turn preserves a newer sibling and never takes the active identity back`, () => {
    const projectId = project(), identity = { task: 'A' }, other = { task: 'B' }
    const old = createRepairBatchLedger(['i'], { native: 1 }, createGenerationSteps(open(projectId, identity)))
    old.claimTurn('native-request')
    createGenerationSteps(open(projectId, identity)).retain('new-sibling', '后续成功', {}, 7, value => value)
    open(projectId, other).save({ steps: { other: { input_hash: 'b'.repeat(64), value: 'active B' } } })
    const raw = { text: '原生完整回包', calls: [{ id: 'call-1', name: 'submit_repair_batch', arguments: { complete: false } }] }
    old.recordTurn(raw)
    const durable = open(projectId, identity).checkpoint
    assert.equal(durable.steps['new-sibling']?.value, 7)
    assert.deepEqual(createRepairBatchLedger(['i'], { native: 1 }, createGenerationSteps(open(projectId, identity))).unprocessedTurn(), raw)
    assert.equal(open(projectId, other).checkpoint.steps.other?.value, 'active B')
  })

  test(`${label}: independently created native ledgers on one steps instance cannot both claim a paid request`, () => {
    const projectId = project(), identity = {}, steps = createGenerationSteps(open(projectId, identity))
    const a = createRepairBatchLedger(['i'], { native: 1 }, steps)
    const b = createRepairBatchLedger(['i'], { native: 1 }, steps)
    a.claimTurn('same-request')
    assert.throws(() => b.claimTurn('same-request'), /已有更新/)
    a.recordTurn({ text: 'the one paid raw', calls: [] })
    const durable = open(projectId, identity).checkpoint
    assert.equal((durable.steps['repair:tools:batches'].value as { last_turn: { raw: { text: string } } }).last_turn.raw.text, 'the one paid raw')
  })

  test(`${label}: an older proposal cannot clear newer correction consumption or overwrite a newly bound input`, () => {
    const projectId = project(), identity = {}, store = open(projectId, identity), id = `repair:structured:${'c'.repeat(24)}`
    const first = createGenerationSteps(store), oldWrite: GenerationPrivateWrite = {}, otherWrite: GenerationPrivateWrite = {}
    first.retain(id, 'bind', { task: 'first' }, { input_hash: 'inner' }, proposalSchema.parse, undefined, oldWrite)
    otherWrite.expected = structuredClone(oldWrite.expected)
    const other = createGenerationSteps(open(projectId, identity))
    other.retain(id, 'use correction', { task: 'first' }, { input_hash: 'inner', correction_started: { input_hash: 'used' },
      correction: { input_hash: 'used', raw: 'actual correction' }, proposal_state: { failed: ['edit_0'] } }, proposalSchema.parse, undefined, otherWrite)
    first.retain(id, 'late initial', { task: 'first' }, { input_hash: 'inner', raw: 'late initial', original_raw: 'late initial' }, proposalSchema.parse, undefined, oldWrite)
    const value = open(projectId, identity).checkpoint.steps[id].value as z.infer<typeof proposalSchema>
    assert.equal(value.correction?.raw, 'actual correction')
    assert.deepEqual(value.proposal_state, { failed: ['edit_0'] })
    const snapshot = structuredClone(open(projectId, identity).checkpoint.steps[id])
    const newOwner = createGenerationSteps(open(projectId, identity)), newWrite = { expected: snapshot }
    newOwner.retain(id, 'new authorized context', { task: 'second' }, { input_hash: 'new-inner', initial_started: { input_hash: 'new-inner' } }, proposalSchema.parse, undefined, newWrite)
    const before = open(projectId, identity).checkpoint
    assert.throws(() => first.retain(id, 'old callback', { task: 'first' }, { input_hash: 'inner', raw: 'old overwrite' }, proposalSchema.parse, undefined, oldWrite), /已有更新/)
    assert.deepEqual(open(projectId, identity).checkpoint, before)
  })
}
