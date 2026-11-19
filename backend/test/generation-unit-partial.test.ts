import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeGenerationUnits } from '../src/modules/generation/generation-unit-execution.js'

function steps() {
  const state: Record<string, unknown> = {}
  return {
    checkpoint: { steps: state },
    async run<T>(id: string, _label: string, _input: unknown, work: () => Promise<T>, validate: (value: unknown) => T) {
      const value = validate(await work())
      state[id] = value
      return value
    },
  } as any
}

test('partial visual preparation keeps validated siblings and reports only the blocked unit', async () => {
  const failed: string[] = []
  const values = await executeGenerationUnits({
    identity: { test: 'partial' }, units: ['ok', 'blocked', 'later'], steps: steps(), signal: undefined,
    label: id => id,
    generate: async id => {
      if (id === 'blocked') throw Object.assign(new Error('锁定字段冲突'), { code: 'visual_profile_locked_field_changed', retryable: false })
      return { draft_key: id }
    },
    validate: (value: any) => value,
    onUnitFailure: (id) => failed.push(id),
  })
  assert.deepEqual([...values.keys()], ['ok', 'later'])
  assert.deepEqual(failed, ['blocked'])
})

test('partial preparation never swallows delivery uncertainty or upstream retryable failures', async () => {
  await assert.rejects(() => executeGenerationUnits({
    identity: { test: 'unknown' }, units: ['unit'], steps: steps(),
    label: id => id, generate: async () => { throw Object.assign(new Error('连接中断'), { code: 'delivery_unknown', retryable: true }) },
    validate: (value: any) => value, onUnitFailure: () => { throw new Error('must not be called') },
  }), /连接中断/)
})

test('partial preparation propagates unclassified errors and cancellation even when retryable is false', async () => {
  for (const error of [new Error('unclassified failure'), Object.assign(new Error('cancelled'), { name: 'AbortError', retryable: false }),
    Object.assign(new Error('delivery unknown'), { code: 'model_delivery_unknown', retryable: false })]) {
    await assert.rejects(() => executeGenerationUnits({
      identity: { test: 'unsafe-partial' }, units: ['unit'], steps: steps(), label: id => id,
      generate: async () => { throw error }, validate: value => value, onUnitFailure: () => {},
    }), issue => issue === error)
  }
})


test('current unit progress changes before the next unit dispatch without inventing completion', async () => {
  const { withModelRequestContext, modelTaskPolicies } = await import('../src/modules/generation/model-task-policy.js')
  const events: Array<{label:string;completed_units:number;total_units:number|null}> = []
  await withModelRequestContext({ policy:modelTaskPolicies.text, onProgress:value=>events.push(value) }, () => executeGenerationUnits({
    identity:{test:'current-unit'}, units:['人物','场景','道具'], steps:steps(), label:id=>'整理'+id,
    generate:async id=>{
      assert.equal(events.at(-1)?.label,'整理'+id,'show actual in-flight unit before awaiting its response')
      assert.equal(events.at(-1)?.completed_units,['人物','场景','道具'].indexOf(id))
      return id
    },validate:value=>value,
  }))
  assert.equal(events.at(-1)?.completed_units,3)
})
