import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { withModelAdmission } from '../src/modules/generation/model-admission.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { runCreativeWorkflowBudget } from '../src/modules/generation/creative-workflow-budget.js'
import { beginTextRequest, createScriptRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { ModelWorkflowBudgetError, modelWorkflowAllowance, modelWorkflowBudgetKey, runModelWorkflowBudget,
  type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

const request = () => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 2, reserved_output_tokens: 4 })
function fixture() {
  const checkpoint: ModelWorkflowBudgetCheckpoint = { version: 1, kind: 'script', grants: 1, active_ms: 0,
    allowance: { max_requests: 1, max_total_requests: 8, max_tokens: 100, max_active_ms: 60_000 }, usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [modelWorkflowBudgetKey]: checkpoint, prose: '已确认的完整正文' }
  const run = <T>(work: (signal: AbortSignal) => Promise<T>, explicitResume = false, signal = new AbortController().signal) =>
    runModelWorkflowBudget({ kind: 'script', scale: { units: 1, inputChars: 10 }, steps, signal, persist() {}, explicitResume }, work)
  return { steps, run, read: () => steps[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint }
}
test('long manuscripts and independent document units receive scaled allowances', () => {
  const short = modelWorkflowAllowance('script', { units: 1, inputChars: 1000 })
  const manuscript = modelWorkflowAllowance('script', { units: 9, inputChars: 100_000 })
  assert.ok(manuscript.max_requests > short.max_requests * 5)
  assert.ok(manuscript.max_tokens > short.max_tokens * 5)
  assert.ok(manuscript.max_active_ms > short.max_active_ms * 5)
  assert.ok(manuscript.max_total_requests > manuscript.max_requests)
  const inflated = modelWorkflowAllowance('script', { units: 10_000_000, inputChars: 10_000_000 })
  assert.ok(inflated.max_active_ms * 3 < 2 ** 31, 'all continuation grants fit a Node timer without one-millisecond overflow')
  assert.ok(inflated.max_requests < 100_000, 'inflated imported counts cannot grant arbitrary execution')
})
test('serialization, reconnect and explicit continuation preserve unknown dispatches and limit total grants', async () => {
  const f = fixture()
  for (let grant = 1; grant <= 3; grant++) {
    await assert.rejects(f.run(async () => { request(); request() }, grant > 1), error =>
      error instanceof ModelWorkflowBudgetError && error.reason === 'requests' && error.canResume === (grant < 3))
    assert.equal(f.read().usage.requests, grant)
    assert.equal(f.read().usage.uncertain_requests, grant)
    f.steps[modelWorkflowBudgetKey] = JSON.parse(JSON.stringify(f.read()))
    let calls = 0
    await assert.rejects(f.run(async () => { calls++ }), ModelWorkflowBudgetError)
    assert.equal(calls, 0)
  }
  await assert.rejects(f.run(async () => request(), true), ModelWorkflowBudgetError)
  assert.equal(f.read().grants, 3)
  assert.equal(f.steps.prose, '已确认的完整正文')
})
test('abandoned execution cannot admit detached work or persist late billing over a resumed ledger', async () => {
  const f = fixture(), controller = new AbortController()
  let completion!: ReturnType<typeof request>, detached!: () => void, began!: () => void
  const entered = new Promise<void>(resolve => { began = resolve })
  const pending = f.run(async () => {
    completion = request()
    await new Promise<void>(resolve => { detached = AsyncLocalStorage.bind(() => { request(); resolve() }); began() })
  }, false, controller.signal)
  await entered
  controller.abort(new Error('用户停止'))
  await assert.rejects(pending, /用户停止/)
  const before = structuredClone(f.read())
  await f.run(async () => {})
  completion.complete({ input_tokens: 1, output_tokens: 1 })
  assert.deepEqual(f.read().usage, before.usage)
  assert.throws(detached, /用户停止/)
})
test('corrupt ledgers reject without discarding a retained candidate or dispatching', async () => {
  const f = fixture(); (f.read().usage as unknown as Record<string, unknown>).requests = null
  let calls = 0
  await assert.rejects(f.run(async () => { calls++; request() }), /预算检查点无效/)
  assert.equal(calls, 0); assert.equal(f.steps.prose, '已确认的完整正文')
})
test('duration and token stops survive reconnect and cannot be cleared by a smaller restored clock', async () => {
  const timed = fixture(); timed.read().active_ms = timed.read().allowance.max_active_ms
  let calls = 0
  await assert.rejects(timed.run(async () => { calls++ }), error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  await assert.rejects(timed.run(async () => { calls++ }), ModelWorkflowBudgetError)
  assert.equal(calls, 0)
  await timed.run(async () => { calls++ }, true)
  assert.equal(calls, 1); assert.equal(timed.read().grants, 2)
  const token = fixture(); token.read().allowance.max_tokens = 3
  await assert.rejects(token.run(async () => { request(); calls++ }), error => error instanceof ModelWorkflowBudgetError && error.reason === 'tokens')
  assert.equal(token.read().usage.requests, 0)
  assert.equal(token.read().exhausted, 'tokens')
})
test('admission before reading checkpoint prevents later request completion from rolling back usage or units', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, release!: () => void, entered!: () => void, reads = 0, calls = 0
  const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const run = (first: boolean) => withModelAdmission('same-creative-input', undefined, async () => {
    reads++
    const steps = createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
    return runCreativeWorkflowBudget(steps, { kind: 'visual_organization', units: 1, inputChars: 1, signal: new AbortController().signal }, async () => {
      request(); calls++
      if (first) { entered(); await held }
      steps.retain(first ? 'first' : 'second', '完整单元', {}, first ? '已确认正文一' : '已确认正文二', value => value)
    })
  })
  const first = run(true); await started
  const second = run(false)
  assert.equal(reads, 1, 'the queued request must not clone a stale checkpoint')
  release(); await Promise.all([first, second])
  const budget = (checkpoint.steps[modelWorkflowBudgetKey]!.value as Record<string, ModelWorkflowBudgetCheckpoint>)[modelWorkflowBudgetKey]!
  assert.equal(calls, 2); assert.equal(budget.usage.requests, 2)
  assert.equal(checkpoint.steps.first!.value, '已确认正文一')
  assert.equal(checkpoint.steps.second!.value, '已确认正文二')
})
