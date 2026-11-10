import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeGenerationUnits } from '../src/modules/generation/generation-unit-execution.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

test('restart reuses validated units and only generates remaining work', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, fail = true
  const calls: string[] = []
  const run = (identity = 'v1') => executeGenerationUnits({ identity, units: ['a', 'b', 'c'],
    steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    label: id => id, generate: async id => { calls.push(id); if (id === 'c' && fail) throw new Error('disconnect'); return id },
    validate: (value, id) => { assert.equal(value, id); return value as string },
    validateAll: values => assert.equal(values.size, 3),
  })
  await assert.rejects(run(), /disconnect/); fail = false
  assert.deepEqual([...await run()], [['a','a'],['b','b'],['c','c']])
  assert.deepEqual(calls, ['a','b','c','c'])
  await run('v2'); assert.deepEqual(calls.slice(-3), ['a','b','c'])
})
test('incomplete values never persist and final validation never marks partial work complete', async () => {
  const steps = createGenerationSteps()
  await assert.rejects(executeGenerationUnits({ identity: 1, units: ['a'], steps, label: id => id,
    generate: async () => '{', validate: () => { throw new Error('incomplete') } }), /incomplete/)
  assert.deepEqual(steps.checkpoint.steps, {})
})
test('cancellation preserves complete units and never dispatches the next unit', async () => {
  const controller = new AbortController(), calls: string[] = [], steps = createGenerationSteps({ signal: controller.signal })
  await assert.rejects(executeGenerationUnits({ identity: 1, units: ['a','b'], steps, signal: controller.signal, label: id => id,
    generate: async id => { calls.push(id); return id }, validate: (value,id) => { if (id === 'a') queueMicrotask(() => controller.abort()); return value } }))
  assert.deepEqual(calls, ['a'])
})
