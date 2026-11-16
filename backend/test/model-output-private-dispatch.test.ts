import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { CompletedOutputReplayMiss, generateStructuredOutput, type StructuredGenerator, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'
import { beginAcceptedTextResponsePoll, beginTextRequest, TextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { withLocalModelReplayOnly } from '../src/modules/generation/model-request-admission.js'

const schema = z.object({ value: z.string() }).strict()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

test('admission budget refusal releases fresh dispatch intent while a blocked poll keeps accepted generation protected', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, usage = createScriptRequestUsage()
  const run = (generate: StructuredGenerator) => generateStructuredOutput('private_dispatch_fixture', schema, generate, 'budget fixture', {
    checkpoint, guardInitialDispatch: true, persistCheckpoint: () => {},
  })
  usage.requests = 1
  await withTextRequestUsage({ usage, limits: { max_requests: 1 } }, async () => {
    await assert.rejects(run(async () => {
      beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 })
      return assert.fail('admission rejected before dispatch')
    }), error => error instanceof TextRequestBudgetError && (error as TextRequestBudgetError & { delivery?: string }).delivery === 'not_sent')
  })
  assert.equal(checkpoint.initial_started, undefined)
  assert.deepEqual(await run(async () => '{"value":"after explicit budget adjustment"}'), { value: 'after explicit budget adjustment' })

  const pending = createScriptRequestUsage()
  withTextRequestUsage({ usage: pending }, () => {
    beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 }).identify('resp_accepted')
  })
  withTextRequestUsage({ usage: pending, limits: { max_total_requests: 1 } }, () => {
    assert.throws(() => beginAcceptedTextResponsePoll('resp_accepted', 12), error =>
      error instanceof TextRequestBudgetError && (error as TextRequestBudgetError & { delivery?: string }).delivery === 'accepted')
  })
})

test('trusted terminal initial failure releases only its dispatch intent; unknown and a lookalike remain protected', async () => {
  for (const kind of ['terminal', 'unknown', 'lookalike'] as const) {
    let checkpoint: StructuredOutputCheckpoint = {}, durable: StructuredOutputCheckpoint = {}, calls = 0
    const failure = kind === 'lookalike' ? Object.assign(new Error('untrusted terminal flag'), { responseTerminated: true, delivery: 'unknown' })
      : new TextProviderError('fixture upstream failure', false, 'server_error')
    if (failure instanceof TextProviderError) { failure.delivery = 'unknown'; failure.responseTerminated = kind === 'terminal' }
    const run = () => generateStructuredOutput('private_dispatch_fixture', schema, async () => {
      calls++
      assert.ok(durable.initial_started, 'dispatch intent is durable before the request')
      if (calls === 1) throw failure
      return '{"value":"retained"}'
    }, 'same prompt', { checkpoint, guardInitialDispatch: true, persistCheckpoint: () => { durable = clone(checkpoint) } })
    await assert.rejects(run(), error => error === failure)
    checkpoint = clone(durable)
    if (kind === 'terminal') {
      assert.equal(checkpoint.initial_started, undefined)
      assert.deepEqual(await run(), { value: 'retained' }); assert.equal(calls, 2)
    } else {
      await assert.rejects(run(), /上次初始请求/); assert.equal(calls, 1)
    }
  }
})

test('a terminated correction still consumes its one correction allowance across restart', async () => {
  let checkpoint: StructuredOutputCheckpoint = {}, durable: StructuredOutputCheckpoint = {}, calls = 0
  const run = () => generateStructuredOutput('private_dispatch_fixture', schema, async () => {
    if (++calls === 1) return '{"value":7}'
    const failure = new TextProviderError('known terminated correction', false, 'server_error')
    failure.delivery = 'accepted'; failure.responseTerminated = true
    throw failure
  }, 'same prompt', { checkpoint, guardInitialDispatch: true, persistCheckpoint: () => { durable = clone(checkpoint) } })
  await assert.rejects(run(), /known terminated correction/)
  assert.ok(durable.correction_started); assert.equal(durable.raw, '{"value":7}')
  checkpoint = clone(durable)
  await assert.rejects(run(), /一次纠正已使用/); assert.equal(calls, 2)
})

test('completed-only misses do not reserve initial or correction dispatch, and a later real request keeps its allowance', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}
  let calls = 0, lookups = 0
  const generate: StructuredGenerator = async () => { calls++; return '{"value":"real response"}' }
  generate.readCompleted = async () => { lookups++; return undefined }
  const options = { checkpoint, guardInitialDispatch: true, persistCheckpoint: () => {} }
  await assert.rejects(generateStructuredOutput('private_dispatch_fixture', schema, generate, 'same prompt', { ...options, completedOnly: true }), CompletedOutputReplayMiss)
  assert.equal(checkpoint.initial_started, undefined); assert.equal(checkpoint.correction_started, undefined)
  assert.equal(calls, 0); assert.equal(lookups, 1)
  assert.deepEqual(await generateStructuredOutput('private_dispatch_fixture', schema, generate, 'same prompt', options), { value: 'real response' })
  assert.equal(calls, 1)

  const correctionCheckpoint: StructuredOutputCheckpoint = {}
  generate.readCompleted = async () => { lookups++; return lookups === 2 ? '{"value":7}' : undefined }
  await assert.rejects(generateStructuredOutput('private_dispatch_fixture', schema, generate, 'other prompt', {
    ...options, checkpoint: correctionCheckpoint, completedOnly: true,
  }), CompletedOutputReplayMiss)
  assert.equal(correctionCheckpoint.raw, '{"value":7}')
  assert.equal(correctionCheckpoint.initial_started, undefined); assert.equal(correctionCheckpoint.correction_started, undefined)
  assert.equal(calls, 1)
})

test('local replay scope forces completed readers across structured branches without creating or clearing unknown intent', async () => {
  for (const hasOldMarker of [false, true]) {
    const checkpoint: StructuredOutputCheckpoint = {}
    let providerCalls = 0, lookups = 0
    const generate: StructuredGenerator = async () => { providerCalls++; return '{"value":"must not dispatch"}' }
    generate.readCompleted = async () => { lookups++; return undefined }
    const run = () => generateStructuredOutput('script_source_quality', schema, generate, 'local-only task', {
      checkpoint, completedOnly: false, guardInitialDispatch: true, preserveInputIdentity: true, persistCheckpoint: () => {},
    })
    await assert.rejects(withLocalModelReplayOnly(run), issue => issue instanceof CompletedOutputReplayMiss &&
      issue.code === 'source_local_model_required' && !('delivery' in issue))
    if (hasOldMarker) checkpoint.initial_started = { input_hash: checkpoint.input_hash!, intent_id: 'legacy-current-intent' }
    const before = clone(checkpoint)
    await assert.rejects(withLocalModelReplayOnly(run), CompletedOutputReplayMiss)
    assert.deepEqual(checkpoint, before)
    assert.equal(providerCalls, 0); assert.equal(lookups, 2)
  }
})
