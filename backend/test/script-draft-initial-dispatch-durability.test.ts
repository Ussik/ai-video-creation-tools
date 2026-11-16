import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const directory = await mkdtemp(join(tmpdir(), 'initial-dispatch-durable-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'))
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { generateScriptDraftRepairWorksets } = await import('../src/modules/script/script-draft-repair-worksets.js')
const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const source = { key: 'outline', content: '冻结候选：代价未定。' }
const edit = { source_key: source.key, find: source.content, replace: '冻结候选：代价为当日记忆。', reason: '落实当前作者方案' }
const raw = JSON.stringify({ summary: '保留其他事实，仅落实当前问题。', edits: [edit] })
const base = { prompt: '完整原稿、作者要求、反馈与历史保持相同。', issueIds: ['issue'], sources: [source], sourceReadOnly: true,
  referenceIdentity: { candidate_id: 'same-candidate', candidate_version: 'same-version', source_version: 'same-source' },
  executionIdentity: { model: 'same-model', provider: 'same-provider' }, manualPlans: ['代价改为当日记忆，保留其他正文。'],
  candidateTransportIdentity: { version: 1, transport: 'anthropic_single_submit' } }
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const proposals = (state: GenerationCheckpoint) => Object.values(state.steps).map(step => step.value as {
  input_hash?: string; raw?: string; initial_started?: { input_hash: string }
}).filter(value => value && typeof value === 'object' && typeof value.input_hash === 'string')

test('initial intent precedes dispatch and survives JSON restart for unknown, accepted and output-started outcomes; only trusted nonacceptance releases it', async t => {
  for (const delivery of ['unknown', 'accepted', 'output_started', 'not_sent', 'rejected'] as const) await t.test(delivery, async () => {
    let durable: GenerationCheckpoint = { steps: {} }, calls = 0, adopted = 0
    const snapshots: GenerationCheckpoint[] = []
    const options = () => ({ ...base,
      steps: createGenerationSteps({ checkpoint: json(durable), save: state => { durable = json(state); snapshots.push(json(state)) } }),
      generate: async () => assert.fail('legacy transport is not a recovery route'),
      generateCandidate: async () => {
        calls++
        const pending = proposals(durable).find(value => value.initial_started && value.raw === undefined)
        assert.ok(pending, 'JSON-persisted initial intent must exist before entering the upstream generator')
        assert.match(pending.initial_started!.input_hash, /^[a-f0-9]{64}$/)
        if (calls === 1) {
          const failure = new TextProviderError('fixture upstream outcome: ' + delivery, false, 'connection_error')
          failure.delivery = delivery
          throw failure
        }
        return raw
      }, validate: () => { adopted++ } })
    await assert.rejects(generateScriptDraftRepairWorksets(options()))
    assert.equal(calls, 1, 'one initial generator entry, no hidden fallback')
    assert.equal(adopted, 0)
    assert.equal(durable.steps['repair:worksets:aggregate'], undefined)
    assert.ok(snapshots.some(snapshot => proposals(snapshot).some(value => value.initial_started)), 'intent was actually serialized')
    durable = json(durable)
    if (['unknown', 'accepted', 'output_started'].includes(delivery)) {
      for (let continuation = 0; continuation < 2; continuation++) await assert.rejects(generateScriptDraftRepairWorksets(options()))
      assert.equal(calls, 1, 'repeated exact continuations must never reenter an uncertain initial request')
      assert.equal(adopted, 0)
      assert.ok(proposals(durable).some(value => value.initial_started && value.raw === undefined))
      assert.equal(durable.steps['repair:worksets:aggregate'], undefined)
    } else {
      assert.ok(!proposals(durable).some(value => value.initial_started), 'only a trusted rejection/non-dispatch releases the intent')
      const result = await generateScriptDraftRepairWorksets(options())
      assert.deepEqual(result.edits, [edit]); assert.equal(calls, 2)
      const restored = await generateScriptDraftRepairWorksets(options())
      assert.deepEqual(restored.edits, [edit]); assert.equal(calls, 2, 'successful paid raw and business child are reused')
      assert.ok(proposals(durable).some(value => value.raw === raw))
      assert.ok(!proposals(durable).some(value => value.initial_started))
    }
  })
})

test('complete initial raw is privately durable after abort and cannot adopt business content until a fresh exact continuation validates it', async () => {
  let durable: GenerationCheckpoint = { steps: {} }, calls = 0, adopted = 0
  const controller = new AbortController()
  const steps = (signal?: AbortSignal) => createGenerationSteps({ checkpoint: json(durable), signal, save: state => { durable = json(state) } })
  await assert.rejects(generateScriptDraftRepairWorksets({ ...base, signal: controller.signal, steps: steps(controller.signal),
    generate: async () => assert.fail('legacy transport is not selected'), generateCandidate: async () => {
      calls++
      assert.ok(proposals(durable).some(value => value.initial_started && value.raw === undefined))
      controller.abort(new DOMException('fixture cancel after complete body', 'AbortError'))
      return raw
    }, validate: () => { adopted++ } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1); assert.equal(adopted, 0)
  assert.equal(durable.steps['repair:worksets:aggregate'], undefined)
  assert.ok(!Object.keys(durable.steps).some(id => id.startsWith('repair:worksets:candidate:')), 'no business child completed while aborted')
  assert.ok(proposals(durable).some(value => value.raw === raw && !value.initial_started), 'complete body is stored privately before cancellation propagates')
  durable = json(durable)
  const result = await generateScriptDraftRepairWorksets({ ...base, steps: steps(),
    generate: async () => assert.fail('no legacy request'), generateCandidate: async () => assert.fail('complete raw is replayed locally'),
    validate: result => { adopted++; assert.deepEqual(result.edits, [edit]) } })
  assert.deepEqual(result.edits, [edit]); assert.equal(calls, 1); assert.ok(adopted > 0)
  assert.ok(durable.steps['repair:worksets:aggregate'])
})
