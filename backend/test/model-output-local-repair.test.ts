import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { fixedLocalRepair } from '../src/modules/generation/model-output-local-repair.js'
import { currentModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { isSourceAnalysisContract } from '../src/modules/generation/source-analysis-contracts.js'

const schema = z.object({ edits: z.array(z.object({ id: z.string(), value: z.string() }).strict()), summary: z.string() }).strict()
const initial = { edits: [{ id: 'kept', value: '中文🦊\r\n  完整有效提案' }, { id: 'failed', value: 'invalid' }], summary: '保留完整方案' }
const validate = (value: z.infer<typeof schema>) => {
  if (value.edits[1]?.value !== 'correct') throw Object.assign(new Error('$.edits[1].value: requires correction'), { statusCode: 422 })
}
const planner = (candidate: unknown) => fixedLocalRepair({ candidate, targets: [{ key: 'edit_1', path: ['edits', 1, 'value'], schema: z.string() }], prompt: '只纠正 edit_1；依据当前失败项与已冻结要求。' })

test('a complete business failure corrects one fixed target and retains valid siblings without replaying the long prompt', async () => {
  const before = structuredClone(initial), names: string[] = []
  const result = await generateStructuredOutput('local_fixture', schema, async (text, contract) => {
    names.push(contract!.name)
    if (names.length === 1) return JSON.stringify(initial)
    assert.equal(contract!.name, 'local_fixture_local_repair')
    assert.ok(!text.includes('HUGE_SOURCE_'.repeat(20)))
    assert.equal(currentModelRequestContext()?.operationStage, 'format_correction')
    assert.equal(currentModelRequestContext()?.traceStage, 'repair')
    return JSON.stringify({ repairs: { edit_1: 'correct' } })
  }, 'HUGE_SOURCE_'.repeat(1000), { validate, planLocalRepair: (candidate, failure) => {
    assert.equal(failure.issues.length, 0); assert.match(String(failure.error), /edits\[1\]/)
    return planner(candidate)
  } })
  assert.deepEqual(names, ['local_fixture', 'local_fixture_local_repair'])
  assert.deepEqual(result.edits[0], before.edits[0]); assert.equal(result.summary, before.summary)
  assert.equal(result.edits[1]!.value, 'correct'); assert.deepEqual(initial, before)
})

test('fixed target envelopes reject omissions, additions, overlap and prototype paths', async () => {
  const repair = planner(initial)
  for (const patch of [{ repairs: {} }, { repairs: { edit_1: 'correct', edit_0: 'changed' } }, { repairs: { edit_1: 'correct' }, summary: 'rewritten' }]) assert.throws(() => repair.apply(patch))
  assert.throws(() => fixedLocalRepair({ candidate: initial, prompt: '', targets: [{ key: 'a', path: ['edits', 1], schema: z.any() }, { key: 'b', path: ['edits', 1, 'value'], schema: z.any() }] }), /重叠/)
  assert.throws(() => fixedLocalRepair({ candidate: initial, prompt: '', targets: [{ key: 'a', path: ['__proto__'], schema: z.any() }] }), /路径/)
  assert.throws(() => fixedLocalRepair({ candidate: initial, prompt: '', targets: [{ key: 'a', path: ['edits', 99], schema: z.any() }] }), /冻结/)
})

test('the local correction is bounded and the full merged business validator remains authoritative', async () => {
  let calls = 0, plans = 0
  await assert.rejects(generateStructuredOutput('local_fixture', schema, async () => ++calls === 1 ? JSON.stringify(initial) : JSON.stringify({ repairs: { edit_1: 'still invalid' } }), '', {
    validate, planLocalRepair: candidate => { plans++; return planner(candidate) },
  }), /requires correction/)
  assert.equal(calls, 2); assert.equal(plans, 1)
})

test('unknown transport, version conflict and cancellation never invoke local correction or retransmit', async () => {
  for (const error of [Object.assign(new Error('unknown response'), { delivery: 'unknown', retryable: false }), Object.assign(new Error('stale'), { statusCode: 409 }), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    let calls = 0, plans = 0
    await assert.rejects(generateStructuredOutput('script_draft_workset_candidate', schema, async () => { calls++; throw error }, '', { planLocalRepair: candidate => { plans++; return planner(candidate) } }), actual => actual === error)
    assert.equal(calls, 1); assert.equal(plans, 0)
  }
  for (const error of [Object.assign(new Error('version changed'), { statusCode: 409 }), Object.assign(new Error('cancelled'), { name: 'AbortError' })]) {
    let calls = 0, plans = 0
    await assert.rejects(generateStructuredOutput('local_fixture', schema, async () => { calls++; return JSON.stringify(initial) }, '', { validate: () => { throw error }, planLocalRepair: candidate => { plans++; return planner(candidate) } }), actual => actual === error)
    assert.equal(calls, 1); assert.equal(plans, 0)
  }
})

test('incomplete, nested and syntax-recovered fragments never create a local plan', async () => {
  for (const raw of ['{"edits":', '{"wrapper":' + JSON.stringify(initial) + '}', JSON.stringify(initial).replace('"invalid"', '"invalid",')]) {
    let plans = 0
    await assert.rejects(generateStructuredOutput('local_fixture', schema, async () => raw, '', { validate, planLocalRepair: candidate => {
      plans++
      const parsed = schema.safeParse(candidate)
      return parsed.success ? planner(candidate) : undefined
    } }))
    assert.ok(plans <= 1)
    if (raw.endsWith(':') || raw.includes('"wrapper"') || raw.includes('"invalid",}')) assert.equal(plans, 0)
  }
})

test('complete initial and local correction checkpoints replay without new requests; changed input cannot reuse', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}
  let calls = 0
  const run = (prompt: string, generate: Parameters<typeof generateStructuredOutput>[2]) => generateStructuredOutput('local_fixture', schema, generate, prompt, { validate, planLocalRepair: planner, checkpoint, persistCheckpoint: () => {} })
  const first = await run('identity-a', async (_text, contract) => { calls++; return contract!.name.endsWith('_local_repair') ? JSON.stringify({ repairs: { edit_1: 'correct' } }) : JSON.stringify(initial) })
  assert.equal(calls, 2)
  assert.deepEqual(await run('identity-a', async () => assert.fail('no request')), first)
  await run('identity-b', async () => { calls++; return JSON.stringify({ ...initial, edits: [initial.edits[0], { id: 'failed', value: 'correct' }] }) })
  assert.equal(calls, 3)
})

test('local source correction contracts stay explicit source contracts without widening unrelated prefixes', () => {
  assert.equal(isSourceAnalysisContract('script_source_quality_repair_local_repair'), true)
  assert.equal(isSourceAnalysisContract('script_draft_workset_candidate_local_repair'), false)
  assert.equal(isSourceAnalysisContract('script_source_anything_local_repair'), false)
})
