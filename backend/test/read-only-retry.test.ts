import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryReadOnlyGeneration } from '../src/modules/generation/read-only-retry.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { streamText } from '../src/infrastructure/providers/providers.js'
import { z } from 'zod'

const model = { id: 'test', remote_id: 'test', modality: 'text' as const, protocol: 'responses' as const,
  settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, structured_output_mode: 'json_schema' } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })

test('transient stream failure retries only the current read-only request and discards its partial JSON', async t => {
  const bodies: string[] = [], retries: number[] = [], waits: number[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return bodies.length === 1 ? sse([
      { type: 'response.output_text.delta', delta: '{"answer":"discarded' },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } },
    ]) : sse([{ type: 'response.output_text.delta', delta: '{"answer":"complete"}' }, { type: 'response.completed', response: { status: 'completed' } }])
  })
  const generate = retryReadOnlyGeneration((prompt, contract) => streamText(model, provider, { prompt, structured_output: contract }), {
    random: () => 0.5, onRetry: attempt => retries.push(attempt), wait: async ms => { waits.push(ms) },
  })
  const result = await generateStructuredOutput('test', z.object({ answer: z.string() }).strict(), generate, 'unchanged creative requirements')
  assert.deepEqual(result, { answer: 'complete' })
  assert.deepEqual(retries, [2]); assert.deepEqual(waits, [2000]); assert.equal(bodies[0], bodies[1])
})

test('HTTP gateway, rate limit and dropped connections recover, but never beyond one local retry', async t => {
  for (const failure of ['gateway', 'rate', 'network', 'eof', 'persistent'] as const) await t.test(failure, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls === 1 || failure === 'persistent') {
        if (failure === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) })
        if (failure === 'eof') return sse([{ type: 'response.output_text.delta', delta: 'partial' }])
        return Response.json({ error: { code: failure === 'rate' ? 'rate_limit_exceeded' : 'server_error' } }, { status: failure === 'rate' ? 429 : 502 })
      }
      return Response.json({ status: 'completed', output_text: 'complete' })
    })
    const generate = retryReadOnlyGeneration(prompt => streamText(model, provider, { prompt }), { wait: async () => {} })
    if (failure === 'persistent') await assert.rejects(generate('test'), issue => issue instanceof TextProviderError && issue.retryable)
    else assert.equal(await generate('test'), 'complete')
    assert.equal(calls, 2)
  })
})

test('auth, quota, schema, content limits, ordinary errors and cancellation do not trigger a transient retry', async t => {
  for (const failure of ['auth', 'quota', 'schema', 'length', 'filter', 'ordinary', 'cancel'] as const) await t.test(failure, async t => {
    let calls = 0, waits = 0
    const controller = new AbortController()
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      if (failure === 'ordinary') throw new Error('unknown implementation error')
      if (failure === 'cancel') { controller.abort(); throw controller.signal.reason }
      if (failure === 'length' || failure === 'filter') return sse([{ type: 'response.incomplete', response: { status: 'incomplete', output_text: 'retained partial', incomplete_details: { reason: failure === 'length' ? 'max_output_tokens' : 'content_filter' } } }])
      return Response.json({ error: { code: failure === 'quota' ? 'insufficient_quota' : 'invalid_request_error', message: 'denied' } }, { status: failure === 'auth' ? 401 : failure === 'quota' ? 429 : 400 })
    })
    const generate = retryReadOnlyGeneration(prompt => streamText(model, provider, { prompt }, undefined, undefined, controller.signal), { signal: controller.signal, wait: async () => { waits++ } })
    await assert.rejects(generate('test'), issue => {
      if (failure === 'length') { assert.ok(issue instanceof TextOutputLimitError); assert.equal(issue.partialText, 'retained partial') }
      if (failure === 'filter') { assert.ok(issue instanceof TextProviderError); assert.ok(!(issue instanceof TextOutputLimitError)); assert.equal(issue.upstreamCode, 'content_filter') }
      return true
    })
    assert.equal(calls, 1); assert.equal(waits, 0)
  })
})

test('abort during backoff and already slow requests stop without another provider call', async t => {
  let calls = 0
  const controller = new AbortController()
  const aborted = retryReadOnlyGeneration(async () => { calls++; throw new TextProviderError('temporary', true) }, { signal: controller.signal, onRetry: () => controller.abort() })
  await assert.rejects(aborted('test'), /abort/i); assert.equal(calls, 1)
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const slow = retryReadOnlyGeneration(async () => { calls++; t.mock.timers.tick(11 * 60_000); throw new TextProviderError('temporary', true) }, { wait: async () => { throw new Error('must not wait') } })
  await assert.rejects(slow('test'), /temporary/); assert.equal(calls, 2)
})
