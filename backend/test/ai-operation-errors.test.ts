import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aiOperationError, aiErrorFields } from '../src/modules/generation/ai-operation-errors.js'

test('upstream cause and delivery remain distinct from the outer HTTP status', () => {
  for (const [value, category, certainty] of [
    [{ upstreamStatus: 429, delivery: 'rejected' }, 'rate_limit', 'completed'],
    [{ upstreamStatus: 401, delivery: 'not_sent' }, 'authentication', 'not_dispatched'],
    [{ failureReason: 'context_overflow', delivery: 'not_sent' }, 'capacity', 'not_dispatched'],
    [{ failureReason: 'output_limit', delivery: 'completed' }, 'output_limit', 'completed'],
    [{ failureReason: 'refusal', delivery: 'accepted' }, 'refusal', 'accepted'],
    [{ failureReason: 'cancelled', delivery: 'output_started' }, 'cancelled', 'accepted'],
  ] as const) {
    const result = aiOperationError(value, 502)
    assert.equal(result.category, category); assert.equal(result.outcome_certainty, certainty)
    assert.equal(result.retryable, false)
  }
})

test('recovery serialization only permits known actions and safe identity fields', () => {
  const result = aiOperationError({ code: 'secret\nvalue', category: 'made_up', detail: 'safe detail',
    recovery: { kind: 'open_url', url: 'https://untrusted.example', task_id: 'task:1', token: 'secret' } }, 500, 'op:1')
  assert.equal(result.message, '服务器处理失败'); assert.equal(result.category, 'internal')
  assert.equal(result.code, 'ai_execution_failed')
  assert.deepEqual(result.recovery, { kind: 'observe', operation_id: 'op:1', task_id: 'task:1' })
  assert.equal(aiErrorFields({ retryAfterMs: 1.2 }, 429).retry_after_ms, 2)
  assert.equal(aiErrorFields({ retryAfterMs: Infinity }, 429).retry_after_ms, undefined)
})


test('typed provider failure detail survives public mapping with a bounded machine vocabulary', () => {
  const error = aiOperationError({ reason: 'json_syntax', failure_stage: 'query', upstreamStatus: 502, upstreamCode: 'bad_response_body',
    category: 'contract', delivery: 'accepted' }, 502)
  assert.equal(error.reason, 'json_syntax'); assert.equal(error.failure_stage, 'query')
  assert.equal(error.upstream_status, 502); assert.equal(error.upstream_code, 'bad_response_body')
  assert.equal(error.outcome_certainty, 'accepted')
  const unsafe = aiErrorFields({ reason: 'private text', failure_stage: 'secret', upstreamStatus: 3.2, upstreamCode: 'echoed credential\nvalue' }, 502)
  assert.equal(unsafe.reason, undefined); assert.equal(unsafe.failure_stage, undefined)
  assert.equal(unsafe.upstream_status, undefined); assert.equal(unsafe.upstream_code, undefined)
})
