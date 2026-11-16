import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import type { GenerationModel, GenerationProvider, TextRequestMetrics } from '../src/infrastructure/providers/providers.js'

const { streamText } = await import('../src/infrastructure/providers/providers.js')

const provider: GenerationProvider = { adapter: 'http', base_url: 'https://tool-guard.invalid/v1' }

function model(protocol: 'responses' | 'chat_completions', settings: Record<string, unknown> = {}): GenerationModel {
  return { id: `tool-guard-${protocol}`, remote_id: 'fixture-model', modality: 'text', protocol, settings: {
    request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    request_template: protocol === 'responses'
      ? { model: '{{model}}', input: '{{prompt}}' }
      : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
    text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content',
    ...settings,
  } }
}

function assertUnexpectedToolCall(issue: unknown): boolean {
  assert.ok(issue instanceof TextProviderError)
  assert.equal(issue.upstreamCode, 'unexpected_tool_call')
  assert.equal(issue.failureReason, 'invalid_tool')
  assert.equal(issue.retryable, false)
  return true
}

test('chat completions stream tool calls are rejected for ordinary text requests', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{}' } }] } }] })}`,
    '',
  ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }))
  const metrics: TextRequestMetrics[] = []
  await assert.rejects(streamText(model('chat_completions', { stream_request_template: {
    model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], stream: true,
  } }), provider, { prompt: 'plain text' }, undefined, undefined, undefined, value => metrics.push(value)), assertUnexpectedToolCall)
  assert.equal(metrics.at(-1)?.request_has_tools, false)
  assert.equal(metrics.at(-1)?.request_tool_count, 0)
})

test('chat completions JSON tool calls are rejected for ordinary text requests', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }],
  }))
  await assert.rejects(streamText(model('chat_completions'), provider, { prompt: 'plain text' }), assertUnexpectedToolCall)
})

test('Responses function calls are rejected in both stream and JSON envelopes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response([
    `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call-1' } })}`,
    'data: [DONE]',
    '',
  ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(model('responses', { stream_request_template: { model: '{{model}}', input: '{{prompt}}', stream: true } }), provider, { prompt: 'plain text' }), assertUnexpectedToolCall)

  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ output: [{ type: 'function_call', call_id: 'call-2', name: 'lookup', arguments: '{}' }] }))
  await assert.rejects(streamText(model('responses'), provider, { prompt: 'plain text' }), assertUnexpectedToolCall)
})

test('a request with configured tools is marked as authorized and is not rejected by the guard', async t => {
  let sent: Record<string, unknown> | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>
    return Response.json({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })
  })
  const metrics: TextRequestMetrics[] = []
  const result = await streamText(model('chat_completions', { request_template: {
    model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
  } }), provider, { prompt: 'tool-enabled text' }, undefined, undefined, undefined, value => metrics.push(value))
  assert.equal(result, 'done')
  assert.equal(Array.isArray(sent?.tools), true)
  assert.equal(metrics.at(-1)?.request_has_tools, true)
  assert.equal(metrics.at(-1)?.request_tool_count, 1)
})
