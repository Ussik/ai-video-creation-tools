import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, createTextToolTransport, type GenerationModel, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextToolOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { withUnrestrictedScriptExecution } from '../src/modules/generation/model-execution.js'

const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid' }
const encoder = new TextEncoder()
const selected = (protocol: 'responses' | 'chat_completions'): GenerationModel => ({
  id: 'limit-diagnostic', remote_id: 'fixture', modality: 'text', protocol,
  settings: { request_path: protocol, context_window_tokens: 1_000_000, output_reserve_tokens: 128_000,
    request_template: protocol === 'responses' ? { model: '{{model}}', input: '{{prompt}}' }
      : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], stream_options: { include_usage: true } } },
})
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const footer = { choices: [], usage: { prompt_tokens: 17, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } } }
const limit = { choices: [{ delta: {}, finish_reason: 'length' }] }
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }

test('text truncation merges usage delivered before and after the finish frame without inventing an actual output cap', async t => {
  let metrics: TextRequestMetrics | undefined
  t.mock.method(globalThis, 'fetch', async () => new Response(frame({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 32 } })
    + frame(limit) + frame({ ping: true }) + frame(footer) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(selected('chat_completions'), provider, { prompt: 'private manuscript' }, undefined, undefined, undefined,
    value => { metrics = value }), issue => {
    assert.ok(issue instanceof TextOutputLimitError)
    assert.deepEqual(issue.usage, { input_tokens: 17, output_tokens: 64, reasoning_tokens: 64 })
    assert.match(issue.message, /推理已耗尽输出预算/)
    assert.equal((issue as unknown as { outputLimit?: number }).outputLimit, undefined)
    return true
  })
  assert.equal(metrics?.output_limit, undefined)
  assert.equal(metrics?.reserved_output_tokens, 128_000)
  assert.equal((metrics as unknown as { output_limit_reason?: string }).output_limit_reason, 'length')
  assert.equal((metrics as unknown as { output_limit_kind?: string }).output_limit_kind, 'reasoning')
})

test('tool truncation collects a later usage chunk and never exposes subsequent tool calls as executable', async t => {
  let cancelled = false, pulls = 0
  const visible: string[] = []
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'submit_document_review', arguments: '{' } }] }, finish_reason: 'length' }] }))) },
    pull(controller) {
      if (++pulls === 1) controller.enqueue(encoder.encode(frame(footer)
        + frame({ choices: [{ delta: { content: 'must not publish', tool_calls: [{ index: 0, id: 'unsafe', function: { name: 'save', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })))
    },
    cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(createTextToolTransport(selected('chat_completions'), provider, 'review', [], undefined, [], () => '', undefined,
    text => visible.push(text)), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.ok(!(issue instanceof TextOutputLimitError))
    assert.deepEqual((issue as unknown as { usage?: unknown }).usage, { input_tokens: 17, output_tokens: 64, reasoning_tokens: 64 })
    assert.match(issue.message, /推理已耗尽输出预算/)
    assert.equal(issue.retryable, false)
    return true
  })
  assert.equal(cancelled, true)
  assert.deepEqual(visible, [])
})

test('Responses exhaustion retains earlier cumulative token usage when its optional footer is missing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ usage: { input_tokens: 17, output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } })
      + frame({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }))) },
    cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const rejected = assert.rejects(streamText(selected('responses'), provider, { prompt: 'review' }), issue => {
    assert.ok(issue instanceof TextOutputLimitError)
    assert.deepEqual(issue.usage, { input_tokens: 17, output_tokens: 64, reasoning_tokens: 64 })
    return true
  })
  await settle()
  t.mock.timers.tick(1000)
  await rejected
  assert.equal(cancelled, true)
})

test('optional usage collection stops after one second even when the provider leaves the socket open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame(limit))) }, cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const rejected = assert.rejects(withUnrestrictedScriptExecution(() => streamText(selected('chat_completions'), provider, { prompt: 'review' })), issue => {
    assert.ok(issue instanceof TextOutputLimitError)
    assert.equal(issue.reason, 'length')
    assert.deepEqual(issue.usage, {})
    return true
  })
  await settle()
  t.mock.timers.tick(1000)
  await rejected
  assert.equal(cancelled, true)
})

test('cancellation interrupts optional usage collection and retains the user stop reason', async t => {
  const abort = new AbortController()
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame(limit))) }, cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const stopped = new Error('creator stopped while reading usage')
  const rejected = assert.rejects(streamText(selected('chat_completions'), provider, { prompt: 'review' }, undefined, undefined, abort.signal), issue => issue === stopped)
  await settle()
  abort.abort(stopped)
  await rejected
  assert.equal(cancelled, true)
})

test('content filtering ends immediately and remains distinct from an output-budget failure', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }))) },
    cancel() { cancelled = true },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(selected('chat_completions'), provider, { prompt: 'review' }), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.ok(!(issue instanceof TextOutputLimitError))
    assert.equal(issue.upstreamCode, 'content_filter')
    return true
  })
  assert.equal(cancelled, true)
})

test('a broken optional footer preserves the known output-limit reason and does not become a network retry', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame(limit))) },
    async pull(controller) { await new Promise(resolve => setTimeout(resolve, 1)); controller.error(new TypeError('terminated')) },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(selected('chat_completions'), provider, { prompt: 'review' }), issue => {
    assert.ok(issue instanceof TextOutputLimitError)
    assert.equal(issue.reason, 'length'); assert.equal(issue.retryable, false)
    return true
  })
})

test('truncated tool arguments report their type and actual configured cap with unknown reasoning left unknown', async t => {
  const model = selected('responses')
  model.settings = { ...model.settings as Record<string, unknown>, request_template: { input: '{{prompt}}', max_output_tokens: 4096 } }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'function_call', call_id: 'partial', name: 'submit_document_review', arguments: '{' }],
    usage: { input_tokens: 17, output_tokens: 64 } }))
  await assert.rejects(createTextToolTransport(model, provider, 'review', [], undefined, [], () => ''), issue => {
    assert.ok(issue instanceof TextToolOutputLimitError)
    assert.equal(issue.outputLimit, 4096)
    assert.equal(issue.outputLimitKind, 'tool_arguments')
    assert.equal(issue.usage?.reasoning_tokens, undefined)
    assert.ok(!(issue instanceof TextOutputLimitError))
    return true
  })
})

test('Responses gateways can supply usage on the event envelope and response without dropping either counter', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(frame({ type: 'response.incomplete', usage: { input_tokens: 17 },
    response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: { output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(selected('responses'), provider, { prompt: 'review' }), issue => {
    assert.ok(issue instanceof TextOutputLimitError)
    assert.deepEqual(issue.usage, { input_tokens: 17, output_tokens: 64, reasoning_tokens: 64 })
    return true
  })
})

test('a tool turn retains previously streamed text when its finish frame has an empty delta', async t => {
  let metrics: TextRequestMetrics | undefined
  const visible: string[] = []
  t.mock.method(globalThis, 'fetch', async () => new Response(frame({ choices: [{ delta: { content: '已有审读结论' } }] })
    + frame(limit) + frame(footer), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(createTextToolTransport(selected('chat_completions'), provider, 'review', [], undefined, [], () => '', undefined,
    text => visible.push(text), undefined, value => { metrics = value }), issue => {
    assert.ok(issue instanceof TextToolOutputLimitError)
    assert.equal(issue.outputLimitKind, 'tool_arguments', 'visible text prevents claiming no answer was returned')
    return true
  })
  assert.deepEqual(visible, ['已有审读结论'])
  assert.equal(metrics?.response_chars, '已有审读结论'.length)
})
