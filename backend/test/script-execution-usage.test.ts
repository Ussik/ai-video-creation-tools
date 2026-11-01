import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
import { createScriptRequestUsage, scriptRequestUsageTokens } from '@video-studio/shared/script/script-request-usage'
import { beginTextRequest, settlePendingTextRequest } from '../src/infrastructure/providers/text-request-usage.js'
import { createScriptExecutionUsage } from '../src/modules/script/script-execution-usage.js'

function activity(usage: NonNullable<ScriptActivity['usage']>, sequence = 1): ScriptActivity {
  return { id: `usage-${sequence}`, scope: 'notice', kind: 'context', status: 'running', label: '本轮模型用量',
    summary: '本轮处理', started_at: sequence, sequence, usage }
}

test('new execution starts at zero despite a large historical phase ledger', () => {
  const historical = createScriptRequestUsage()
  historical.requests = 89
  historical.input_tokens = 3_000_000
  const current = createScriptExecutionUsage({ contextChars: 40_000 })
  const snapshot = current.snapshot(historical)
  assert.equal(snapshot.current.requests, 0)
  assert.equal(snapshot.cumulative?.requests, 89)
  assert.equal(current.limits.max_requests, undefined)
  assert.equal(current.limits.max_tokens, undefined)
  current.run(() => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 5, reserved_output_tokens: 10 })
    .complete({ input_tokens: 4, output_tokens: 3 }))
  assert.equal(current.usage.requests, 1)
  assert.equal(historical.requests, 89)
  assert.equal(snapshot.current.requests, 0)
  assert.equal(snapshot.cumulative?.requests, 89)
})

test('complete prepared context never creates a cumulative token or request cutoff', () => {
  for (const contextChars of [1, 100_000, 2_000_000]) {
    const current = createScriptExecutionUsage({ contextChars })
    assert.deepEqual(current.limits, { unknown_output_tokens: 4096 })
    current.run(() => {
      for (let request = 0; request < 40; request++) beginTextRequest({ request_bytes: 10, estimated_input_tokens: 200_000, reserved_output_tokens: 10 })
        .complete({ input_tokens: 200_000, output_tokens: 10 })
    })
    assert.equal(current.usage.requests, 40)
    assert.ok(scriptRequestUsageTokens(current.usage) > 4_000_000)
  }
  assert.throws(() => createScriptExecutionUsage({ contextChars: Number.NaN }), /长度无效/)
})

test('resume selects the most recently emitted snapshot rather than array insertion order', () => {
  const latest = createScriptRequestUsage(), old = createScriptRequestUsage(), historical = createScriptRequestUsage()
  latest.requests = 2
  latest.input_tokens = 50
  old.requests = 1
  historical.requests = 89
  const entries = [activity({ current: latest, cumulative: historical, limits: { max_requests: 2, max_tokens: 1000 } }, 9),
    activity({ current: old }, 4)]
  const resumed = createScriptExecutionUsage({ activities: entries, contextChars: 1_000_000 })
  assert.equal(resumed.usage.requests, 2)
  assert.equal(resumed.limits.max_requests, undefined)
  assert.equal(resumed.limits.max_tokens, undefined)
  resumed.run(() => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 5 })
    .complete({ input_tokens: 4, output_tokens: 3 }))
  assert.equal(resumed.usage.requests, 3)
  assert.equal(resumed.usage.input_tokens, 54)
  latest.requests = 9
  assert.equal(resumed.usage.requests, 3)
  assert.equal(historical.requests, 89)
})

test('execution updates retain immutable estimate and actual snapshots through response reconciliation', () => {
  const snapshots: NonNullable<ScriptActivity['usage']>[] = []
  const current = createScriptExecutionUsage({ onUpdate: usage => snapshots.push(usage) })
  current.run(() => {
    const request = beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10, reserved_output_tokens: 30 })
    request.identify('resp_execution')
    request.complete({ input_tokens: 7, output_tokens: 9, reasoning_tokens: 3 })
  })
  assert.equal(scriptRequestUsageTokens(snapshots[0]!.current), 40)
  assert.equal(snapshots[0]!.current.pending_requests.length, 0)
  assert.equal(snapshots[1]!.current.pending_requests.length, 1)
  assert.equal(scriptRequestUsageTokens(snapshots.at(-1)!.current), 16)
  assert.equal(current.usage.reasoning_tokens, 3)
})

test('obsolete environment and caller caps cannot stop an execution, including malformed old values', t => {
  const names = ['VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_REQUESTS', 'VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_TOKENS']
  const saved = names.map(name => process.env[name])
  t.after(() => names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index] }))
  for (const value of ['1', '', ' ', '1.5', 'no-limit']) {
    process.env[names[0]!] = value
    process.env[names[1]!] = value
    const current = createScriptExecutionUsage({ limits: { max_requests: 1, max_tokens: 1, unknown_output_tokens: 99 } })
    assert.deepEqual(current.limits, { unknown_output_tokens: 99 })
    current.run(() => {
      for (let request = 0; request < 3; request++) beginTextRequest({ request_bytes: 10, estimated_input_tokens: 5 })
    })
    assert.equal(current.usage.requests, 3)
    assert.equal(current.usage.estimated_output_tokens, 297)
  }
})

test('restoring an over-limit legacy execution preserves and settles its accepted response before more requests', () => {
  const first = createScriptExecutionUsage()
  first.run(() => {
    const pending = beginTextRequest({ request_bytes: 80, estimated_input_tokens: 30, reserved_output_tokens: 50 })
    pending.identify('resp_over_old_limit')
  })
  first.usage.requests = 176
  first.usage.input_tokens = 5_000_000
  const resumed = createScriptExecutionUsage({ activities: [activity({ ...first.snapshot(), limits: { max_requests: 32, max_tokens: 500_000 } })] })
  assert.equal(resumed.usage.requests, 176)
  assert.equal(resumed.usage.pending_requests[0]?.id, 'resp_over_old_limit')
  resumed.run(() => {
    assert.equal(settlePendingTextRequest('resp_over_old_limit', { input_tokens: 20, output_tokens: 40, reasoning_tokens: 10 }), true)
    beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 }).complete({ input_tokens: 1, output_tokens: 1 })
  })
  assert.equal(resumed.usage.requests, 177)
  assert.equal(resumed.usage.input_tokens, 5_000_021)
  assert.equal(resumed.usage.output_tokens, 41)
  assert.equal(resumed.usage.uncertain_requests, 0)
  assert.deepEqual(resumed.usage.pending_requests, [])
  assert.equal(resumed.snapshot().limits?.max_requests, undefined)
})

test('a malformed restored current ledger cannot be silently reset', () => {
  const malformed = createScriptRequestUsage()
  malformed.requests = Number.NaN
  assert.throws(() => createScriptExecutionUsage({ activities: [activity({ current: malformed })] }), /检查点无效/)
})
