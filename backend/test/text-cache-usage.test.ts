import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTextUsage } from '../src/infrastructure/providers/text-usage-parse.js'
import { beginTextRequest, createScriptRequestUsage, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'

test('only documented cache fields are interpreted, and absent fields stay unknown', () => {
  assert.deepEqual(parseTextUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } }),
    { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cache_read_tokens: 60 })
  assert.deepEqual(parseTextUsage({ input_tokens: 80, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 30 } }),
    { input_tokens: 80, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 30 })
  assert.deepEqual(parseTextUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 }),
    { input_tokens: 100, output_tokens: 1, cache_read_tokens: 70, cache_miss_tokens: 30 })
  const none = parseTextUsage({ prompt_tokens: 100, completion_tokens: 20 })
  assert.equal('cache_read_tokens' in none, false, 'a provider without cache fields is not reported as zero cache hits')
  assert.deepEqual(parseTextUsage(undefined), {})
  assert.equal(parseTextUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } }).cache_read_tokens, 10, 'cached input cannot exceed input')
  assert.equal('cache_read_tokens' in parseTextUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: -1 } }), false)
})

test('the execution ledger counts cache once per request and distinguishes zero from unknown', () => {
  const usage = createScriptRequestUsage()
  withTextRequestUsage({ usage }, () => {
    const hit = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 50, reserved_output_tokens: 100 })
    hit.identify('r1')
    hit.complete({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 60 })
    hit.complete({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 60 })
    const zero = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 50, reserved_output_tokens: 100 })
    zero.complete({ input_tokens: 40, output_tokens: 5, cache_read_tokens: 0 })
    const unknown = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 50, reserved_output_tokens: 100 })
    unknown.complete({ input_tokens: 30, output_tokens: 5 })
  })
  assert.equal(usage.requests, 3)
  assert.equal(usage.input_tokens, 170, 'cache is a subset of input and is never added again')
  assert.equal(usage.cache_read_tokens, 60)
  assert.equal(usage.cache_read_reported_requests, 2, 'a zero hit is reported; the request without a field is unknown')
  assert.equal(usage.cache_write_reported_requests, 0)
})

test('a checkpoint saved before cache counters existed restores with unknown cache usage', () => {
  const legacy: Record<string, unknown> = { ...createScriptRequestUsage(), requests: 2, input_tokens: 50, output_tokens: 5 }
  for (const key of ['cache_read_tokens', 'cache_read_reported_requests', 'cache_write_tokens', 'cache_write_reported_requests']) delete legacy[key]
  const usage = legacy as ReturnType<typeof createScriptRequestUsage>
  withTextRequestUsage({ usage }, () => {})
  assert.equal(usage.cache_read_reported_requests, 0)
  assert.equal(usage.requests, 2)
})
