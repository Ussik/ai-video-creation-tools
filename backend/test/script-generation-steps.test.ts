import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGenerationSteps, type GenerationCheckpoint, type GenerationStepEvent } from '../src/modules/script/script-generation-steps.js'

function number(value: unknown) { assert.equal(typeof value, 'number'); return value as number }

test('steps stay running until validated work finishes and persist their actual elapsed time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const events: GenerationStepEvent[] = []; let finish!: (value: number) => void
  let saved: GenerationCheckpoint | undefined
  const steps = createGenerationSteps({ save: state => { saved = structuredClone(state) }, onStep: event => events.push(event) })
  const pending = steps.run('a', '生成栏目', {}, () => new Promise<number>(resolve => { finish = resolve }), number)
  t.mock.timers.tick(12_345)
  assert.deepEqual(events.map(event => event.status), ['running']); assert.equal(saved, undefined)
  finish(42); assert.equal(await pending, 42)
  assert.deepEqual(events.map(event => event.status), ['running', 'succeeded'])
  assert.equal(events[1].duration_ms, 12_345); assert.equal(saved!.steps.a.value, 42)
})

test('business steps have no default elapsed-time cutoff and pending work can still be cancelled', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const controller = new AbortController(), events: GenerationStepEvent[] = []
  const steps = createGenerationSteps({ signal: controller.signal, onStep: event => events.push(event) })
  const pending = steps.run('draft', '生成栏目', {}, () => new Promise<number>(() => {}), number)
  t.mock.timers.tick(181 * 60_000)
  await Promise.resolve()
  assert.deepEqual(events.map(event => event.status), ['running'])
  const reason = new DOMException('用户停止', 'AbortError')
  controller.abort(reason)
  await assert.rejects(pending, issue => issue === reason)
  assert.equal(events.at(-1)!.status, 'cancelled')
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('restart reuses only exact inputs and revalidates saved results', async () => {
  let calls = 0, saved: GenerationCheckpoint = { steps: {} }
  const save = (state: GenerationCheckpoint) => { saved = structuredClone(state) }
  const work = async () => ++calls
  await createGenerationSteps({ save }).run('a', '栏目', { source: 'v1' }, work, number)
  const events: GenerationStepEvent[] = []
  const restored = createGenerationSteps({ checkpoint: saved, save, onStep: event => events.push(event) })
  assert.equal(await restored.run('a', '栏目', { source: 'v1' }, work, number), 1)
  assert.equal(calls, 1); assert.equal(events[0].reused, true)
  assert.equal(await restored.run('a', '栏目', { source: 'v2' }, work, number), 2)
  saved.steps.a.value = 'damaged'
  assert.equal(await createGenerationSteps({ checkpoint: saved, save }).run('a', '栏目', { source: 'v2' }, work, number), 3)
  assert.equal(calls, 3)
})

test('failed, invalid and cancelled work never becomes a reusable result', async () => {
  for (const failure of ['transport', 'validation', 'cancel', 'timeout']) {
    const controller = new AbortController(), events: GenerationStepEvent[] = []
    let saves = 0
    const steps = createGenerationSteps({ signal: controller.signal, save: () => { saves++ }, onStep: event => events.push(event) })
    await assert.rejects(steps.run('a', '栏目', {}, async () => {
      if (failure === 'transport') throw new Error('upstream failed')
      if (failure === 'cancel') controller.abort(new DOMException('stopped', 'AbortError'))
      if (failure === 'timeout') controller.abort(new Error('deadline reached'))
      return failure === 'validation' ? 'invalid' : 1
    }, number))
    assert.equal(saves, 0); assert.deepEqual(steps.checkpoint.steps, {})
    assert.equal(events.at(-1)!.status, failure === 'cancel' ? 'cancelled' : 'failed')
  }
})

test('logical parents survive normal, reused, invalidated and failed step notifications', async () => {
  const events: GenerationStepEvent[] = []
  const steps = createGenerationSteps({ onStep: event => events.push(event) })
  await steps.run('evidence', '选取证据', {}, async () => 1, number, 'artifact:synopsis')
  await steps.run('evidence', '选取证据', {}, async () => { throw new Error('must reuse') }, number, 'artifact:synopsis')
  steps.checkpoint.steps.evidence.value = 'invalid'
  await steps.run('evidence', '选取证据', {}, async () => 2, number, 'artifact:synopsis')
  await assert.rejects(steps.run('directory', '筛选目录', {}, async () => { throw new Error('failed') }, number, 'artifact:synopsis'))
  assert.deepEqual(events.map(event => event.status), ['running', 'succeeded', 'succeeded', 'running', 'succeeded', 'running', 'failed'])
  assert.ok(events.every(event => event.parent_id === 'artifact:synopsis'))
  assert.equal(events[2].reused, true)
})
