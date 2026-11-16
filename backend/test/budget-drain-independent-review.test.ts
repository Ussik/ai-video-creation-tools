import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginAcceptedTextResponsePoll, beginTextRequest, createScriptRequestUsage, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { backgroundTextResponse, withTextResponseRecovery, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'
import { modelWorkflowBudgetDrainMs, modelWorkflowBudgetKey, runModelWorkflowBudget, ModelWorkflowBudgetError, type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

function reserve() { return beginTextRequest({ request_bytes: 11, estimated_input_tokens: 3, reserved_output_tokens: 5 }) }
function pendingScope(id: string) {
  const usage = createScriptRequestUsage(), hard = new AbortController(), admission = new AbortController()
  const scope = { usage, signal: hard.signal, admissionSignal: admission.signal }
  withTextRequestUsage(scope, () => reserve().identify(id))
  return { usage, hard, admission, scope }
}

test('independent: accepted drain exception never bypasses a child hard cancellation or combined cap', () => {
  const outer = pendingScope('resp_same'), inner = pendingScope('resp_same')
  outer.admission.abort(new Error('duration'))
  inner.hard.abort(new Error('child cancelled'))
  const before = [structuredClone(outer.usage), structuredClone(inner.usage)]
  assert.throws(() => withTextRequestUsage(outer.scope, () => withTextRequestUsage(inner.scope, () => beginAcceptedTextResponsePoll('resp_same', 9))), /child cancelled/)
  assert.deepEqual([outer.usage, inner.usage], before)
  const capped = pendingScope('resp_cap'); capped.admission.abort(new Error('duration'))
  assert.throws(() => withTextRequestUsage({ ...capped.scope, limits: { max_total_requests: 1 } }, () => beginAcceptedTextResponsePoll('resp_cap', 9)), /模型请求预算/)
  assert.equal(capped.usage.requests, 1); assert.equal(capped.usage.transport_requests, 0)
})

test('independent: mismatched pending identities reject atomically even when both ledgers have an accepted response', () => {
  const outer = pendingScope('resp_outer'), inner = pendingScope('resp_inner')
  outer.admission.abort(new Error('outer admission closed'))
  const before = [structuredClone(outer.usage), structuredClone(inner.usage)]
  assert.throws(() => withTextRequestUsage(outer.scope, () => withTextRequestUsage(inner.scope, () => beginAcceptedTextResponsePoll('resp_outer', 7))), /outer admission closed/)
  assert.deepEqual([outer.usage, inner.usage], before)
})

test('independent: real background wrapper drains only its pending GET and settles both nested ledgers', async t => {
  const admission = new AbortController(), signal = new AbortController().signal
  const outer = createScriptRequestUsage(), inner = createScriptRequestUsage(), saved = new Map<string, BackgroundResponse>(), methods: string[] = []
  t.mock.method(globalThis, 'fetch', async (_target: unknown, init?: RequestInit) => {
    methods.push(init?.method || 'GET')
    if (init?.method === 'POST') {
      admission.abort(new Error('duration before POST response parses'))
      return Response.json({ id: 'resp_accepted_at_boundary', status: 'queued' })
    }
    return Response.json({ id: 'resp_accepted_at_boundary', status: 'completed', output_text: 'verified full response', usage: { input_tokens: 4, output_tokens: 6 } })
  })
  const response = await withTextRequestUsage({ usage: outer, signal, admissionSignal: admission.signal }, () =>
    withTextRequestUsage({ usage: inner, signal }, () =>
      withTextResponseRecovery({ read: key => saved.get(key), save: (key, value) => { if (value) saved.set(key, value); else saved.delete(key) } }, () =>
        backgroundTextResponse('https://offline.invalid/v1/responses', { input: 'fixture' }, {}, signal, promise => promise, () => {}, 5, 3))))
  assert.equal((await response.json()).output_text, 'verified full response')
  assert.deepEqual(methods, ['POST', 'GET'])
  for (const usage of [outer, inner]) {
    assert.equal(usage.requests, 1); assert.equal(usage.transport_requests, 1)
    assert.equal(usage.input_tokens, 4); assert.equal(usage.output_tokens, 6)
    assert.equal(usage.uncertain_requests, 0); assert.deepEqual(usage.pending_requests, [])
  }
})

test('independent: drain absolute timer survives progress and rejects at exact hard boundary', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10_000 })
  const checkpoint: ModelWorkflowBudgetCheckpoint = { version: 1, kind: 'script', grants: 1, active_ms: 999,
    allowance: { max_requests: 10, max_total_requests: 1000, max_tokens: 1000, max_active_ms: 1000 }, usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [modelWorkflowBudgetKey]: checkpoint }
  let entered!: () => void, localPoll!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const run = runModelWorkflowBudget({ kind: 'script', scale: { units: 1, inputChars: 1 }, steps, signal: new AbortController().signal, persist() {} }, async () => {
    reserve().identify('resp_absolute')
    const { AsyncLocalStorage } = await import('node:async_hooks')
    localPoll = AsyncLocalStorage.bind(() => beginAcceptedTextResponsePoll('resp_absolute', 9).complete({}))
    entered(); await new Promise<never>(() => {})
  })
  void run.catch(() => {})
  await started
  t.mock.timers.tick(1)
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(modelWorkflowBudgetDrainMs / 5); localPoll() }
  t.mock.timers.tick(modelWorkflowBudgetDrainMs / 5 - 1); localPoll()
  t.mock.timers.tick(1)
  await assert.rejects(run, issue => issue instanceof ModelWorkflowBudgetError && issue.reason === 'duration')
  assert.throws(localPoll, ModelWorkflowBudgetError)
  const current = steps[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint
  assert.equal(current.active_ms, 1000 + modelWorkflowBudgetDrainMs)
  assert.equal(current.usage.transport_requests, 5); assert.equal(current.grants, 1)
})
