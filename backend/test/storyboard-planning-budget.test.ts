import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginTextRequest, createScriptRequestUsage, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { claimModelAttempt, runModelStep } from '../src/modules/generation/model-execution.js'
import { isStoryboardPlanningBudgetError, runStoryboardPlanningBudget, storyboardPlanningAllowance,
  storyboardPlanningBudgetKey, storyboardPlanningBudgetPolicy, StoryboardPlanningBudgetError,
  type StoryboardPlanningBudgetCheckpoint } from '../src/modules/storyboard/storyboard-planning-budget.js'

const signal = () => new AbortController().signal
function fixture(requests = 2, totalRequests = 4, tokens = 100, activeMs = 60_000) {
  const checkpoint: StoryboardPlanningBudgetCheckpoint = { version: 1, grants: 1,
    allowance: { max_requests: requests, max_total_requests: totalRequests, max_tokens: tokens, max_active_ms: activeMs },
    usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [storyboardPlanningBudgetKey]: checkpoint, candidate: 'validated candidate' }
  return { steps, read: () => steps[storyboardPlanningBudgetKey] as StoryboardPlanningBudgetCheckpoint }
}
const generate = () => beginTextRequest({ request_bytes: 12, estimated_input_tokens: 4, reserved_output_tokens: 8 })
const poll = () => beginTextRequest({ kind: 'transport', request_bytes: 12, estimated_input_tokens: 0 })
const budgetError = (reason: string) => (issue: unknown) => issue instanceof StoryboardPlanningBudgetError && issue.reason === reason

test('single-shot batch scaling has separate generation and polling caps and fixed three-grant hard limit', () => {
  assert.equal(storyboardPlanningBudgetPolicy.maxGrants, 3)
  assert.deepEqual(storyboardPlanningAllowance({ scene_ids: ['scene'], shots_per_scene: 2 }), {
    max_requests: 27, max_total_requests: 507, max_tokens: 27 * 64_000, max_active_ms: 16 * 60_000,
  })
  const multiple = storyboardPlanningAllowance({ scene_ids: ['a', 'b'], shots_per_scene: 8 })
  assert.equal(multiple.max_requests, 12 + 6 * 16 + 3 * 2)
  assert.equal(multiple.max_active_ms, (10 + 2 * 16 + 2 * 2) * 60_000)
  assert.equal(storyboardPlanningAllowance({ scene_ids: ['s'], shots_per_scene: 999 }).max_requests, 12 + 6 * 30 + 3)
})

test('all real generation and transport dispatches stop before consumption and retain checkpoints', async () => {
  const { steps, read } = fixture(2, 3)
  let dispatches = 0, persistedReservations = 0
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), persist() {
    if (read().usage.requests + read().usage.transport_requests) persistedReservations++
  } }, async () => {
    for (const request of [generate, poll, generate]) { request().complete({ input_tokens: 2, output_tokens: 1 }); dispatches++ }
    poll(); dispatches++
  }), budgetError('requests'))
  assert.equal(dispatches, 3)
  assert.equal(read().usage.requests, 2); assert.equal(read().usage.transport_requests, 1)
  assert.equal(read().exhausted, 'requests'); assert.equal(read().grants, 1)
  assert.equal(steps.candidate, 'validated candidate'); assert.ok(persistedReservations >= 3)
})

test('token reservation rejection leaves every nested ledger unchanged and survives serialized recovery', async () => {
  const { steps, read } = fixture(8, 10, 10), observed = createScriptRequestUsage()
  await assert.rejects(withTextRequestUsage({ usage: observed }, () => runStoryboardPlanningBudget({ input: {}, steps,
    activeDurationMs: 0, signal: signal(), persist() {} }, async () => { generate() })), budgetError('tokens'))
  assert.equal(read().usage.requests, 0); assert.equal(observed.requests, 0)
  const restored = JSON.parse(JSON.stringify(steps)) as typeof steps
  let executions = 0
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps: restored, activeDurationMs: 0, signal: signal(),
    persist() {} }, async () => { executions++ }), budgetError('tokens'))
  assert.equal(executions, 0, 'non-resume calls cannot clear exhaustion and blind-dispatch')
})

test('ordinary reconnect preserves cumulative usage and frozen allowance without buying another grant', async () => {
  const { steps, read } = fixture(3)
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), persist() {} }, async () => {
    generate().complete({ input_tokens: 2, output_tokens: 1 })
    throw new Error('connection failed')
  }), /connection failed/)
  const allowance = structuredClone(read().allowance)
  await runStoryboardPlanningBudget({ input: { scene_ids: Array(10).fill('changed'), shots_per_scene: 30 }, steps,
    activeDurationMs: 12, signal: signal(), explicitResume: true, persist() {} }, async () => {
    generate().complete({ input_tokens: 3, output_tokens: 2 })
  })
  assert.equal(read().grants, 1); assert.equal(read().usage.requests, 2)
  assert.equal(read().usage.input_tokens, 5); assert.deepEqual(read().allowance, allowance)
})

test('explicit resumes after exhaustion add only two grants and never erase accumulated unknown requests', async () => {
  const { steps, read } = fixture(1, 8)
  for (let round = 1; round <= 3; round++) {
    await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(),
      explicitResume: round > 1, persist() {} }, async () => { generate().complete({}); generate() }), (issue: unknown) => {
      assert.ok(issue instanceof StoryboardPlanningBudgetError)
      assert.equal(issue.canResume, round < 3)
      return true
    })
    assert.equal(read().grants, round); assert.equal(read().usage.requests, round)
    assert.equal(read().usage.uncertain_requests, round)
  }
  let executions = 0
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), explicitResume: true,
    persist() {} }, async () => { executions++ }), budgetError('requests'))
  assert.equal(executions, 0); assert.equal(read().grants, 3)
})

test('nested three-attempt steps remain bounded inside task-wide usage without resetting either counter', async () => {
  const { steps, read } = fixture(10, 12)
  let dispatches = 0
  await runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), persist() {} }, async scopeSignal => {
    await assert.rejects(runModelStep('generation', scopeSignal, async () => {
      for (let index = 0; index < 4; index++) await runModelStep('nested_format', scopeSignal, async () => {
        claimModelAttempt(); generate().complete({ input_tokens: 1, output_tokens: 1 }); dispatches++
      })
    }), (issue: unknown) => (issue as { code?: string }).code === 'model_attempts_exhausted')
    await runModelStep('review', scopeSignal, async () => { claimModelAttempt(); generate().complete({ input_tokens: 2, output_tokens: 1 }); dispatches++ })
  })
  assert.equal(dispatches, 4); assert.equal(read().usage.requests, 4)
})

test('active duration includes settled earlier runs and aborts the worker with a recognizable budget reason', async () => {
  const { steps, read } = fixture(3, 8, 100, 25)
  let inherited!: AbortSignal
  const keepAlive = setTimeout(() => {}, 2000)
  try {
    await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 20, signal: signal(), persist() {} }, async inner => {
      inherited = inner
      await new Promise(() => {})
    }), budgetError('duration'))
    assert.equal(inherited.aborted, true); assert.ok(isStoryboardPlanningBudgetError(inherited.reason))
    assert.equal(read().exhausted, 'duration'); assert.equal(steps.candidate, 'validated candidate')
    let executions = 0
    await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 25, signal: signal(), persist() {} }, async () => { executions++ }), budgetError('duration'))
    assert.equal(executions, 0)
  } finally { clearTimeout(keepAlive) }
})

test('the deadline also prevents an ignored detached worker from dispatching after the task has ended', async () => {
  const { steps, read } = fixture(3, 8, 100, 5)
  let release!: () => void, lateWork!: Promise<void>
  const gate = new Promise<void>(resolve => { release = resolve })
  const keepAlive = setTimeout(() => {}, 2000)
  try {
    await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), persist() {} }, async () => {
      lateWork = gate.then(() => { generate() })
      await lateWork
    }), budgetError('duration'))
    release()
    await assert.rejects(lateWork, budgetError('duration'))
    assert.equal(read().usage.requests, 0)
  } finally { clearTimeout(keepAlive) }
})

test('migration loads prior durable usage and corrupt counters never restart at zero', async () => {
  const legacy = createScriptRequestUsage(); legacy.requests = 5; legacy.input_tokens = 20; legacy.output_tokens = 10
  const steps: Record<string, unknown> = {}
  await runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), persist() {}, legacyUsage: legacy }, async () => {
    generate().complete({ input_tokens: 2, output_tokens: 1 })
  })
  const restored = steps[storyboardPlanningBudgetKey] as StoryboardPlanningBudgetCheckpoint
  assert.equal(restored.usage.requests, 6); assert.equal(restored.usage.input_tokens, 22)
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps: {}, activeDurationMs: 0, signal: signal(), persist() {},
    legacyUsage: { ...legacy, requests: -1 } }, async () => { throw new Error('must not execute') }), /预算检查点无效/)
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps: {}, activeDurationMs: 0, signal: signal(), persist() {},
    legacyUsage: {} }, async () => { throw new Error('must not execute') }), /预算检查点无效/)
})

test('reservation persistence failure blocks dispatch while completed-result diagnostics cannot create a retry', async () => {
  const first = fixture(); let dispatches = 0
  await assert.rejects(runStoryboardPlanningBudget({ input: {}, steps: first.steps, activeDurationMs: 0, signal: signal(), persist() {
    if (first.read().usage.requests) throw new Error('disk write failed')
  } }, async () => { generate(); dispatches++ }), /disk write failed/)
  assert.equal(dispatches, 0)
  const second = fixture()
  const originalError = console.error
  console.error = () => {}
  try {
    const value = await runStoryboardPlanningBudget({ input: {}, steps: second.steps, activeDurationMs: 0, signal: signal(), persist() {
      if (second.read().usage.input_tokens) throw new Error('settlement write failed')
    } }, async () => { generate().complete({ input_tokens: 2, output_tokens: 1 }); return 'completed' })
    assert.equal(value, 'completed')
  } finally { console.error = originalError }
})

test('parent cancellation preserves its reason without consuming duration or authorizing an extra grant', async () => {
  const { steps, read } = fixture()
  const parent = new AbortController(), reason = new Error('explicit user stop')
  let inherited!: AbortSignal
  const pending = runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: parent.signal, persist() {} }, async inner => {
    inherited = inner
    await new Promise(() => {})
  })
  parent.abort(reason)
  await assert.rejects(pending, issue => issue === reason)
  assert.equal(inherited.reason, reason); assert.equal(read().exhausted, undefined)
  await runStoryboardPlanningBudget({ input: {}, steps, activeDurationMs: 0, signal: signal(), explicitResume: true, persist() {} }, async () => {})
  assert.equal(read().grants, 1)
})
