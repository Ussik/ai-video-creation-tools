import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { fixedLocalRepair } from '../src/modules/generation/model-output-local-repair.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const schema = z.object({ kept: z.string(), value: z.string() }).strict()
const initial = { kept: '完整中文🦊\r\n  有效内容', value: 'invalid' }
const validate = (value: z.infer<typeof schema>) => { if (value.value !== 'valid') throw Object.assign(new Error('failed target'), { statusCode: 422 }) }
const plan = (candidate: unknown) => fixedLocalRepair({ candidate, prompt: '修正目标 value', targets: [{ key: 'value', path: ['value'], schema: z.string() }] })

test('every structured call inside an existing stage retains complete paid responses before validation without completing the stage', async () => {
  let durable: GenerationCheckpoint = { steps: {} }, calls = 0
  const steps = () => createGenerationSteps({ checkpoint: JSON.parse(JSON.stringify(durable)), save: state => { durable = structuredClone(state) } })
  const invoke = (generate: Parameters<typeof generateStructuredOutput>[2], identity = { model: 'a', channel: 'a' }) => steps().run('domain-stage', '业务阶段', identity,
    () => generateStructuredOutput('cross_domain_fixture', schema, generate, 'complete task', { validate, planLocalRepair: plan }), schema.parse)
  await assert.rejects(invoke(async (_text, contract) => {
    calls++
    if (calls === 1) return JSON.stringify(initial)
    assert.equal(contract!.name, 'cross_domain_fixture_local_repair')
    const privateOutput = Object.values(durable.steps)[0]!.value as any
    assert.deepEqual(JSON.parse(privateOutput.raw), initial, 'full response is durable before validation/correction')
    assert.ok(privateOutput.correction_started); assert.equal(durable.steps['domain-stage'], undefined)
    return JSON.stringify({ repairs: { value: 'still-invalid' } })
  }), /failed target/)
  assert.equal(calls, 2); assert.equal(durable.steps['domain-stage'], undefined)
  await assert.rejects(invoke(async () => assert.fail('restored responses may not be purchased again')), /failed target/)
  assert.equal(calls, 2)
  await invoke(async () => { calls++; return JSON.stringify({ ...initial, value: 'valid' }) }, { model: 'b', channel: 'b' })
  assert.equal(calls, 3); assert.ok(durable.steps['domain-stage'])
})

test('new shared stage scope does not change or repurchase exact historical completed business steps', async () => {
  let calls = 0
  const steps = createGenerationSteps()
  await steps.run('legacy-step', '历史成果', { source: 'unchanged' }, async () => initial, schema.parse)
  const before = structuredClone(steps.checkpoint), restored = createGenerationSteps({ checkpoint: before })
  assert.deepEqual(await restored.run('legacy-step', '历史成果', { source: 'unchanged' }, async () => { calls++; throw new Error('must reuse') }, schema.parse), initial)
  assert.equal(calls, 0); assert.deepEqual(restored.checkpoint, before)
})
