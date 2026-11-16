import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as usageModule from '../src/infrastructure/providers/text-request-usage.js'
import { beginTextRequest, beginProviderDispatch, createScriptRequestUsage, settlePendingTextRequest, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import * as budgetModule from '../src/modules/generation/model-workflow-budget.js'
import { ModelWorkflowBudgetError, modelWorkflowBudgetKey, runModelWorkflowBudget, type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

const drainMs = () => (budgetModule as Record<string, unknown>).modelWorkflowBudgetDrainMs as number || 300_000
const request = () => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 2, reserved_output_tokens: 4 })
const poll = (id: string) => (usageModule as unknown as { beginAcceptedTextResponsePoll(id: string, bytes: number): ReturnType<typeof request> }).beginAcceptedTextResponsePoll(id, 7)
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const checkpoint: ModelWorkflowBudgetCheckpoint = { version: 1, kind: 'script', grants: 1, active_ms: 80,
    allowance: { max_requests: 20, max_total_requests: 30, max_tokens: 1000, max_active_ms: 100 }, usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [modelWorkflowBudgetKey]: checkpoint, accepted_prose: '原有正文' }
  let persistCount = 0
  const run = <T>(work: (signal: AbortSignal) => Promise<T>, explicitResume = false, signal = new AbortController().signal) =>
    runModelWorkflowBudget({ kind: 'script', scale: { units: 1, inputChars: 10 }, steps, signal, persist() { persistCount++ }, explicitResume }, work)
  return { steps, run, read: () => steps[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint, persists: () => persistCount }
}

test('duration expiry drains the admitted response and persists complete output before finally closes the hard signal', async t => {
  const f = fixture(t)
  let hard!: AbortSignal, completions = 0
  const result = await f.run(async signal => {
    hard = signal
    const reservation = request(); reservation.identify('resp_accepted')
    t.mock.timers.tick(20)
    assert.equal(signal.aborted, false)
    assert.equal(f.read().exhausted, 'duration')
    t.mock.timers.tick(13)
    reservation.complete({ input_tokens: 3, output_tokens: 5 })
    signal.throwIfAborted()
    f.steps.accepted_prose = '真实完整回包及已校验正文'; completions++
    return 'saved'
  })
  assert.equal(result, 'saved'); assert.equal(completions, 1)
  assert.equal(hard.aborted, true, 'only the finished scope closes after the complete result is saved')
  assert.equal(f.steps.accepted_prose, '真实完整回包及已校验正文')
  assert.deepEqual(f.read().usage.pending_requests, []); assert.equal(f.read().usage.uncertain_requests, 0)
  assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.input_tokens, 3); assert.equal(f.read().usage.output_tokens, 5)
  assert.equal(f.read().active_ms, 113); assert.equal(f.read().grants, 1)
})

test('a new generation after soft expiry is rejected before reservation counters, pending identity or dispatch change', async t => {
  const f = fixture(t)
  let dispatches = 0
  await assert.rejects(f.run(async signal => {
    const admitted = request(); dispatches++; admitted.identify('resp_complete')
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    admitted.complete({ input_tokens: 1, output_tokens: 2 })
    const before = structuredClone(f.read().usage)
    for (const attempt of [request, () => beginProviderDispatch({ kind: 'generation', request_bytes: 5 }),
      () => beginTextRequest({ kind: 'transport', request_bytes: 3, estimated_input_tokens: 0 })]) {
      assert.throws(() => { attempt(); dispatches++ }, error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
      assert.deepEqual(f.read().usage, before)
    }
    request()
  }), error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  assert.equal(dispatches, 1); assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.transport_requests, 0)
  assert.deepEqual(f.read().usage.pending_requests, [])
})

test('nested usage scopes and independent child signals cannot hide an expired parent admission', async t => {
  const f = fixture(t), child = createScriptRequestUsage(), childSignal = new AbortController().signal
  await f.run(async signal => {
    const admitted = request()
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    for (const options of [{ usage: child }, { usage: child, signal: childSignal }, { usage: f.read().usage, signal: childSignal }]) {
      assert.throws(() => withTextRequestUsage(options, request), ModelWorkflowBudgetError)
      assert.equal(child.requests, 0); assert.equal(f.read().usage.requests, 1)
      assert.deepEqual(child.pending_requests, []); assert.deepEqual(f.read().usage.pending_requests, [])
    }
    admitted.complete({ input_tokens: 1, output_tokens: 2 })
  })
})

for (const historical of [false, true]) test(`duration expiry without current work stops immediately, historical pending: ${historical}`, async t => {
  const f = fixture(t)
  if (historical) {
    const usage = f.read().usage
    usage.requests = 1; usage.uncertain_requests = 1; usage.estimated_input_tokens = 2; usage.estimated_output_tokens = 4
    usage.pending_requests.push({ id: 'resp_historical', request_bytes: 10, estimated_input_tokens: 2,
      estimated_output_tokens: 4, reasoning_tokens: 0, input_settled: false, output_settled: false })
  }
  let entered!: () => void, hard!: AbortSignal
  const started = new Promise<void>(resolve => { entered = resolve })
  const result = f.run(async signal => { hard = signal; entered(); await new Promise<void>(() => {}) })
  void result.catch(() => {})
  await started; t.mock.timers.tick(20)
  assert.equal(hard.aborted, true)
  await assert.rejects(result, error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  assert.equal(f.read().active_ms, 100); assert.equal(f.read().usage.requests, historical ? 1 : 0)
  assert.equal(f.read().usage.uncertain_requests, historical ? 1 : 0)
})

test('synchronous deadline check denies dispatch before mutation even if the duration timer has not run', async t => {
  const f = fixture(t)
  let dispatches = 0
  await assert.rejects(f.run(async () => {
    t.mock.method(Date, 'now', () => 1021)
    request(); dispatches++
  }), error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  assert.equal(dispatches, 0); assert.equal(f.read().usage.requests, 0)
  assert.equal(f.read().usage.uncertain_requests, 0); assert.deepEqual(f.read().usage.pending_requests, [])
})

test('an accepted historical response explicitly polled before deadline owns the gaps between GETs', async t => {
  const f = fixture(t), usage = f.read().usage
  usage.requests = 1; usage.uncertain_requests = 1; usage.estimated_input_tokens = 2; usage.estimated_output_tokens = 4
  usage.pending_requests.push({ id: 'resp_resumed', request_bytes: 10, estimated_input_tokens: 2,
    estimated_output_tokens: 4, reasoning_tokens: 0, input_settled: false, output_settled: false })
  await f.run(async signal => {
    poll('resp_resumed').complete({})
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    poll('resp_resumed').complete({})
    settlePendingTextRequest('resp_resumed', { input_tokens: 3, output_tokens: 5 })
    signal.throwIfAborted()
    f.steps.accepted_prose = '已恢复的后台响应完整保存'
  })
  assert.equal(f.steps.accepted_prose, '已恢复的后台响应完整保存')
  assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.transport_requests, 2)
  assert.deepEqual(f.read().usage.pending_requests, [])
})

test('a fully settled request does not give unrelated work a drain window', async t => {
  const f = fixture(t)
  let entered!: () => void, hard!: AbortSignal
  const started = new Promise<void>(resolve => { entered = resolve })
  const result = f.run(async signal => {
    hard = signal
    const admitted = request(); admitted.identify('resp_finished'); admitted.complete({ input_tokens: 3, output_tokens: 5 })
    entered(); await new Promise<void>(() => {})
  })
  void result.catch(() => {})
  await started; t.mock.timers.tick(20)
  assert.equal(hard.aborted, true)
  await assert.rejects(result, ModelWorkflowBudgetError)
  assert.equal(f.read().usage.uncertain_requests, 0)
})

test('a delayed deadline callback cannot extend the absolute drain deadline', async t => {
  const f = fixture(t)
  let dispatches = 0
  await assert.rejects(f.run(async signal => {
    request().identify('resp_active'); dispatches++
    t.mock.method(Date, 'now', () => 1020 + drainMs())
    assert.throws(request, ModelWorkflowBudgetError)
    assert.equal(signal.aborted, true)
    signal.throwIfAborted()
  }), ModelWorkflowBudgetError)
  assert.equal(dispatches, 1); assert.equal(f.read().usage.requests, 1)
  assert.equal(f.read().active_ms, 100 + drainMs()); assert.equal(f.read().grants, 1)
})

test('accepted GET cannot pass the absolute drain deadline while its hard timer is delayed', async t => {
  const f = fixture(t)
  await assert.rejects(f.run(async signal => {
    const admitted = request(); admitted.identify('resp_accepted'); admitted.complete({})
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    poll('resp_accepted').complete({})
    const before = structuredClone(f.read().usage)
    t.mock.method(Date, 'now', () => 1021 + drainMs())
    assert.throws(() => poll('resp_accepted'), ModelWorkflowBudgetError)
    assert.equal(signal.aborted, true)
    assert.deepEqual(f.read().usage, before, 'denied GET cannot consume another transport request')
    signal.throwIfAborted()
  }), error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  assert.equal(f.read().usage.transport_requests, 1); assert.equal(f.read().usage.uncertain_requests, 1)
  assert.equal(f.read().usage.pending_requests[0]?.id, 'resp_accepted')
})

test('only GET polling the already pending accepted response may continue during drain', async t => {
  const f = fixture(t)
  await f.run(async signal => {
    const generation = request(); generation.identify('resp_accepted'); generation.complete({})
    t.mock.timers.tick(20); assert.equal(signal.aborted, false)
    const before = structuredClone(f.read().usage)
    assert.throws(() => poll('resp_unknown'), ModelWorkflowBudgetError)
    assert.throws(() => poll('not-a-response-id'))
    assert.deepEqual(f.read().usage, before)
    poll('resp_accepted').complete({})
    assert.equal(f.read().usage.transport_requests, 1); assert.equal(f.read().usage.requests, 1)
    assert.equal(settlePendingTextRequest('resp_accepted', { input_tokens: 3, output_tokens: 5 }), true)
    assert.throws(() => poll('resp_accepted'), ModelWorkflowBudgetError, 'a settled identity cannot authorize arbitrary new transport')
    generation.complete({ input_tokens: 3, output_tokens: 5 })
  })
  assert.equal(f.read().usage.input_tokens, 3); assert.equal(f.read().usage.output_tokens, 5)
})

test('a child missing the accepted response identity cannot borrow the parent drain exception', async t => {
  const f = fixture(t), child = createScriptRequestUsage()
  await f.run(async () => {
    const generation = request(); generation.identify('resp_parent')
    t.mock.timers.tick(20)
    assert.throws(() => withTextRequestUsage({ usage: child }, () => poll('resp_parent')), ModelWorkflowBudgetError)
    assert.equal(child.transport_requests, 0); assert.equal(f.read().usage.transport_requests, 0)
    generation.complete({ input_tokens: 1, output_tokens: 2 })
  })
})

test('bounded drain hard-aborts incomplete work and retains its uncertain output reservation without granting or resetting usage', async t => {
  const f = fixture(t)
  let hard!: AbortSignal, reservation!: ReturnType<typeof request>, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = f.run(async signal => {
    hard = signal; reservation = request(); reservation.identify('resp_uncertain'); entered()
    await new Promise<void>(() => {})
  })
  void pending.catch(() => {})
  await started
  t.mock.timers.tick(20); assert.equal(hard.aborted, false)
  t.mock.timers.tick(drainMs() - 1); assert.equal(hard.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(pending, error => error instanceof ModelWorkflowBudgetError && error.reason === 'duration')
  assert.equal(hard.aborted, true); assert.equal(f.read().grants, 1)
  assert.equal(f.read().active_ms, 100 + drainMs())
  assert.equal(f.read().usage.requests, 1); assert.equal(f.read().usage.uncertain_requests, 1)
  assert.equal(f.read().usage.estimated_input_tokens, 2); assert.equal(f.read().usage.estimated_output_tokens, 4)
  assert.equal(f.read().usage.pending_requests[0]?.id, 'resp_uncertain')
  reservation.complete({ input_tokens: 3, response_chars: 9 })
  assert.equal(f.read().usage.uncertain_requests, 1, 'partial output does not become complete evidence')
})

test('parent cancellation during drain stops immediately and also denies accepted-response polling', async t => {
  const f = fixture(t), parent = new AbortController()
  let entered!: () => void, hard!: AbortSignal, latePoll!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = f.run(async signal => {
    hard = signal; request().identify('resp_cancelled')
    latePoll = AsyncLocalStorage.bind(() => { poll('resp_cancelled') })
    entered(); await new Promise<void>(() => {})
  }, false, parent.signal)
  void pending.catch(() => {})
  await started; t.mock.timers.tick(20); assert.equal(hard.aborted, false)
  parent.abort(new Error('真实用户取消'))
  await assert.rejects(pending, /真实用户取消/)
  assert.equal(hard.aborted, true); assert.throws(latePoll, /真实用户取消/)
  assert.equal(f.read().active_ms, 100); assert.equal(f.read().grants, 1)
})

test('only explicit continuation adds one bounded grant and retains accumulated drain time and exact usage', async t => {
  const f = fixture(t)
  await f.run(async () => {
    const admitted = request(); t.mock.timers.tick(25); admitted.complete({ input_tokens: 3, output_tokens: 5 })
  })
  const usage = structuredClone(f.read().usage)
  let calls = 0
  await assert.rejects(f.run(async () => { calls++ }), ModelWorkflowBudgetError)
  assert.equal(calls, 0); assert.equal(f.read().grants, 1); assert.equal(f.read().active_ms, 105)
  await f.run(async () => { calls++ }, true)
  assert.equal(calls, 1); assert.equal(f.read().grants, 2); assert.equal(f.read().active_ms, 105)
  assert.deepEqual(f.read().usage, usage)
})

test('detached old completion cannot persist over the resumed ledger after a drain timeout', async t => {
  const f = fixture(t)
  f.read().allowance.max_active_ms = 1_000_000; f.read().active_ms = 999_980
  let old!: ReturnType<typeof request>, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = f.run(async () => {
    old = request(); old.identify('resp_old'); entered(); await new Promise<void>(() => {})
  })
  void pending.catch(() => {})
  await started; t.mock.timers.tick(20); t.mock.timers.tick(drainMs())
  await assert.rejects(pending, ModelWorkflowBudgetError)
  f.steps[modelWorkflowBudgetKey] = JSON.parse(JSON.stringify(f.read()))
  // Test only the generic budget ledger. Source unknown recovery remains a
  // separate unchanged barrier and is deliberately not invoked here.
  await f.run(async () => {}, true)
  const current = structuredClone(f.read()), saves = f.persists()
  old.complete({ input_tokens: 9, output_tokens: 11 })
  assert.deepEqual(f.read(), current); assert.equal(f.persists(), saves)
})
