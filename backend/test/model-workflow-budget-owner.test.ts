import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { beginTextRequest, beginAcceptedTextResponsePoll, createScriptRequestUsage, settlePendingTextRequest,
  withTextRequestUsage, type TextRequestUsageScope } from '../src/infrastructure/providers/text-request-usage.js'
import { modelWorkflowBudgetKey, runModelWorkflowBudget, type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const checkpoint: ModelWorkflowBudgetCheckpoint = { version: 1, kind: 'script', grants: 1, active_ms: 80,
    allowance: { max_requests: 20, max_total_requests: 3000, max_tokens: 1000, max_active_ms: 100 }, usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [modelWorkflowBudgetKey]: checkpoint }
  return { read: () => steps[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint,
    run: <T>(work: (signal: AbortSignal) => Promise<T>) => runModelWorkflowBudget({ kind: 'script', scale: { units: 1, inputChars: 10 },
      steps, signal: new AbortController().signal, persist() {} }, work) }
}
const generation = () => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 2, reserved_output_tokens: 4 })
const poll = (id: string) => beginAcceptedTextResponsePoll(id, 7)

function observedOwners(usage = createScriptRequestUsage()) {
  const owners = new Map<unknown, () => boolean>()
  let maximum = 0, registrations = 0
  // This observer checks the lifetime key contract used by the workflow's
  // private Map without exposing production state solely for a test.
  const scope = { usage, onRequestPending(owner: unknown, pending?: () => boolean) {
    for (const [key, previous] of owners) if (!previous()) owners.delete(key)
    owners.set(owner, pending ?? owner as () => boolean); maximum = Math.max(maximum, owners.size); registrations++
  } } as TextRequestUsageScope
  return { owners, scope, maximum: () => maximum, registrations: () => registrations }
}

test('one accepted response uses stable generation and remote owners across a thousand polls', async t => {
  const f = fixture(t), observed = observedOwners()
  await withTextRequestUsage(observed.scope, () => f.run(async signal => {
    const request = generation(); request.identify('resp_reused'); request.complete({})
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    for (let index = 0; index < 1000; index++) poll('resp_reused').complete({})
    assert.equal(observed.registrations(), 1001)
    assert.equal(observed.maximum(), 2, 'POST reservation and remote identity are separate stable owners')
    assert.equal(observed.owners.size, 2)
    assert.equal(observed.owners.has('resp_reused'), true)
    assert.equal(settlePendingTextRequest('resp_reused', { input_tokens: 3, output_tokens: 5 }), true)
    assert.equal([...observed.owners.values()].some(pending => pending()), false)
    signal.throwIfAborted()
  }))
  assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.transport_requests, 1000)
  assert.equal(observed.scope.usage.requests, 1); assert.equal(observed.scope.usage.transport_requests, 1000)
})

test('ordinary and different accepted requests never share an in-memory owner', () => {
  const observed = observedOwners()
  withTextRequestUsage(observed.scope, () => {
    const first = generation(), second = generation()
    assert.equal(observed.owners.size, 2)
    assert.equal([...observed.owners.keys()].every(owner => typeof owner === 'object' && owner !== null), true)
    first.identify('resp_first'); second.identify('resp_second'); first.complete({}); second.complete({})
    for (let index = 0; index < 50; index++) { poll('resp_first').complete({}); poll('resp_second').complete({}) }
    assert.equal(observed.owners.size, 4); assert.equal(observed.maximum(), 4)
    settlePendingTextRequest('resp_first', { input_tokens: 3, output_tokens: 5 })
    poll('resp_second').complete({})
    assert.equal(observed.owners.size, 2, 'settled generation and remote owner are pruned together on the next admission')
    assert.equal(observed.owners.has('resp_first'), false); assert.equal(observed.owners.has('resp_second'), true)
  })
})

test('same-ID remote ownership retains an earlier in-flight GET after a later GET has settled', async t => {
  const f = fixture(t)
  await f.run(async signal => {
    const create = generation(); create.identify('resp_concurrent'); create.complete({})
    const first = poll('resp_concurrent'), later = poll('resp_concurrent')
    later.complete({}); settlePendingTextRequest('resp_concurrent', { input_tokens: 3, output_tokens: 5 })
    t.mock.timers.tick(20)
    assert.equal(signal.aborted, false, 'the first admitted HTTP request still owns finite drain')
    first.complete({}); first.complete({})
    signal.throwIfAborted()
  })
  assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.transport_requests, 2)
  assert.equal(f.read().usage.uncertain_requests, 0)
})
