import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { streamText, createTextToolTransport, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextToolOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { withCompatibleStructuredSettings } from '../src/infrastructure/providers/text-output-capability.js'
import { retryReadOnlyGeneration } from '../src/modules/generation/read-only-retry.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'

const protocols = ['responses', 'chat_completions'] as const
type Protocol = typeof protocols[number]
const provider = { adapter: 'http' as const, base_url: 'https://offline-adaptation.invalid/v1' }
const encoder = new TextEncoder()
const schema = z.object({ ok: z.boolean() }).strict()
const selected = (protocol: Protocol, settings: Record<string, unknown> = {}): GenerationModel => ({
  id: 'adaptation-' + protocol, remote_id: 'offline-fixture', modality: 'text', protocol,
  settings: { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192 }, structured_output_mode: 'prompt', ...settings },
})
const delta = (protocol: Protocol, text: string) => protocol === 'responses'
  ? { type: 'response.output_text.delta', delta: text } : { choices: [{ delta: { content: text } }] }
const terminal = (protocol: Protocol, text?: string) => protocol === 'responses'
  ? { type: 'response.completed', response: { status: 'completed', ...(text === undefined ? {} : { output_text: text }) } }
  : { choices: [{ ...(text === undefined ? { delta: {} } : { message: { content: text } }), finish_reason: 'stop' }] }
function frame(value: unknown, eol = '\n', multiline = true) {
  return JSON.stringify(value, null, multiline ? 2 : undefined).split('\n').map(line => 'data: ' + line).join(eol) + eol + eol
}
function stream(raw: string, chunkBytes = 0, contentType = 'text/event-stream') {
  const bytes = encoder.encode(raw)
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (chunkBytes) for (let i = 0; i < bytes.length; i += chunkBytes) controller.enqueue(bytes.subarray(i, i + chunkBytes))
    else controller.enqueue(bytes)
    controller.close()
  } }), { headers: { 'Content-Type': contentType } })
}
const completed = (protocol: Protocol, text = '{"ok":true}') => protocol === 'responses'
  ? { status: 'completed', output_text: text } : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }

test('multiline SSE frames survive CRLF Unicode chunk boundaries metadata and full terminal snapshots', async t => {
  for (const protocol of protocols) for (const eol of ['\n', '\r\n']) await t.test(protocol + JSON.stringify(eol), async t => {
    const answer = '正文 😀 e\u0301\r\n保留空格 '
    const raw = ': heartbeat' + eol + eol + 'event: message' + eol + 'id: fixture' + eol +
      frame(delta(protocol, answer), eol) + frame(terminal(protocol, answer), eol) + 'data: [DONE]' + eol + eol
    const visible: string[] = []
    t.mock.method(globalThis, 'fetch', async () => stream(raw, 3))
    assert.equal(await streamText(selected(protocol), provider, { prompt: 'full source' }, undefined,
      event => { if (event.type === 'delta') visible.push(event.text) }), answer)
    assert.equal(visible.join(''), answer)
  })
})

test('text DONE and a complete final frame without a trailing blank preserve prior completion behavior', async t => {
  for (const protocol of protocols) for (const ending of ['done', 'terminal at EOF']) await t.test(protocol + ending, async t => {
    const raw = frame(delta(protocol, 'answer')) + (ending === 'done' ? 'data: [DONE]\r\n\r\n' : frame(terminal(protocol)).trimEnd())
    t.mock.method(globalThis, 'fetch', async () => stream(raw, 1))
    assert.equal(await streamText(selected(protocol), provider, { prompt: 'source' }), 'answer')
  })
})

test('multiline tool frames retain complete calls but DONE alone cannot authorize unfinished tools', async t => {
  for (const protocol of protocols) await t.test(protocol, async t => {
    const call = { name: 'read_document', arguments: '{"id":"one"}' }
    const payload = protocol === 'responses' ? { type: 'response.completed', response: { status: 'completed', output: [
      { type: 'function_call', call_id: 'call-1', ...call }] } }
      : { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: call }] }, finish_reason: 'tool_calls' }] }
    t.mock.method(globalThis, 'fetch', async () => stream(frame(payload, '\r\n'), 5))
    const result = await createTextToolTransport(selected(protocol), provider, 'source', [], undefined, [], () => '')
    assert.deepEqual(result.calls, [{ id: 'call-1', ...call }])
    t.mock.restoreAll()
    t.mock.method(globalThis, 'fetch', async () => stream('data: [DONE]\n\n'))
    await assert.rejects(createTextToolTransport(selected(protocol), provider, 'source', [], undefined, [], () => ''),
      issue => issue instanceof TextProviderError && issue.failureReason === 'disconnected')
  })
})

test('a malformed complete SSE data event cannot become success or trigger a format retry', async t => {
  for (const protocol of protocols) for (const tool of [false, true]) await t.test(protocol + String(tool), async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return stream('data: {"broken":\ndata: no}\n\ndata: [DONE]\n\n') })
    const work = tool ? () => createTextToolTransport(selected(protocol), provider, 'source', [], undefined, [], () => '')
      : () => generateStructuredOutput('offline_bad_frame', schema, (prompt, structured_output) =>
        streamText(selected(protocol), provider, { prompt, structured_output }), 'source')
    await assert.rejects(work(), issue => issue instanceof TextProviderError && issue.failureReason === 'invalid_response' && !issue.retryable)
    assert.equal(calls, 1)
  })
})

test('incomplete EOF and explicit refusal stay failed without accepting partial content', async t => {
  for (const protocol of protocols) for (const kind of ['eof', 'refusal', 'unknown finish']) await t.test(protocol + kind, async t => {
    let failure: unknown
    if (kind === 'refusal') failure = protocol === 'responses'
      ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] }] } }
      : { choices: [{ delta: {}, finish_reason: 'content_filter' }] }
    else if (kind === 'unknown finish') failure = protocol === 'responses'
      ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'unknown_gateway_reason' } } }
      : { choices: [{ delta: {}, finish_reason: 'unknown_gateway_reason' }] }
    t.mock.method(globalThis, 'fetch', async () => stream(frame(delta(protocol, 'partial')) + (failure ? frame(failure) : '')))
    await assert.rejects(streamText(selected(protocol), provider, { prompt: 'source' }), issue => {
      assert.ok(issue instanceof TextProviderError)
      assert.ok(!(issue instanceof TextOutputLimitError))
      assert.equal(issue.failureReason, kind === 'eof' ? 'disconnected' : kind === 'refusal' ? 'refusal' : 'upstream_error')
      return true
    })
  })
})

test('only recognized output-limit aliases share text and non-executable tool truncation types', async t => {
  for (const protocol of protocols) for (const reason of ['length', 'max_output_tokens', 'max_tokens', 'MAX_TOKENS']) await t.test(protocol + reason, async t => {
    const payload = protocol === 'responses' ? { status: 'incomplete', incomplete_details: { reason }, output_text: 'partial', usage: { output_tokens: 4 } }
      : { choices: [{ message: { content: 'partial' }, finish_reason: reason }], usage: { completion_tokens: 4 } }
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload))
    await assert.rejects(streamText(selected(protocol), provider, { prompt: 'source' }), issue => {
      assert.ok(issue instanceof TextOutputLimitError)
      assert.equal(issue.partialText, 'partial'); assert.equal(issue.retryable, false)
      assert.equal(issue.reason, reason === 'length' ? 'length' : 'max_output_tokens')
      assert.equal(issue.rawReason, reason, 'the original provider reason stays available for diagnostics')
      assert.equal(issue.outputLimit, 8192)
      return true
    })
    await assert.rejects(createTextToolTransport(selected(protocol), provider, 'source', [], undefined, [], () => ''),
      issue => issue instanceof TextToolOutputLimitError && !(issue instanceof TextOutputLimitError) && !issue.retryable)
  })
})

test('a malformed optional footer cannot hide an already known output limit', async t => {
  for (const protocol of protocols) await t.test(protocol, async t => {
    const payload = protocol === 'responses' ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'MAX_TOKENS' } } }
      : { choices: [{ delta: {}, finish_reason: 'MAX_TOKENS' }] }
    t.mock.method(globalThis, 'fetch', async () => stream(frame(payload) + 'data: not-json\n\ndata: [DONE]\n\n'))
    await assert.rejects(streamText(selected(protocol), provider, { prompt: 'source' }),
      issue => issue instanceof TextOutputLimitError && issue.rawReason === 'MAX_TOKENS')
  })
})

test('explicit json_object capability is used once and retains the complete schema task prompt', async t => {
  for (const protocol of protocols) await t.test(protocol, async t => {
    let calls = 0
    const configured = selected(protocol, { structured_output_mode: undefined,
      text_capabilities: { version: 1, override: { compatibility: { structured_output: ['json_object'] } } } })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body))
      assert.deepEqual(protocol === 'responses' ? body.text.format : body.response_format, { type: 'json_object' })
      const prompt = protocol === 'responses' ? body.input : body.messages[0].content
      assert.match(prompt, /【本次结构化返回契约】/)
      assert.match(prompt, /"ok":\{"type":"boolean"\}/)
      assert.match(prompt, /complete original source/)
      return Response.json(completed(protocol))
    })
    assert.deepEqual(await generateStructuredOutput('offline_json_object', schema, (prompt, structured_output) =>
      streamText(configured, provider, { prompt, structured_output }), 'complete original source'), { ok: true })
    assert.equal(calls, 1)
    assert.equal((configured.settings as Record<string, unknown>).structured_output_mode, undefined)
  })
})

test('json_schema stays preferred Messages never selects json_object and downgrade conditions do not expand', async t => {
  const contract = { name: 'offline_mode', schema: { type: 'object', properties: {} } }
  for (const [protocol, declared, expected] of [
    ['responses', ['json_schema', 'json_object'], 'json_schema'], ['anthropic_messages', ['json_object'], 'prompt'],
  ] as const) await t.test(protocol, async () => {
    const model = { ...selected('responses'), id: 'mode-' + protocol, protocol, settings: { text_api: { mode: 'standard', max_output_tokens: 8192 },
      text_capabilities: { version: 1, override: { compatibility: { structured_output: declared } } } } } as GenerationModel
    await withCompatibleStructuredSettings(model, provider, contract, undefined, async configured => {
      assert.equal(JSON.parse(String(configured.settings)).structured_output_mode, expected); return ''
    })
  })
  for (const [mode, issue, expectedCalls] of [
    ['json_schema', 'HTTP 400 json_schema unsupported', 1],
    ['json_schema', 'HTTP 400 invalid schema response_format json_schema', 1],
    ['json_schema', 'HTTP 401 json_schema unsupported', 1],
    ['json_object', 'HTTP 400 json_object response_format unsupported', 1],
  ] as const) await t.test(issue, async () => {
    const modes: unknown[] = []
    const model = selected('chat_completions', { structured_output_mode: undefined,
      text_capabilities: { version: 1, override: { compatibility: { structured_output: [mode] } } } })
    const work = withCompatibleStructuredSettings(model, provider, contract, undefined, async configured => {
      modes.push(JSON.parse(String(configured.settings)).structured_output_mode)
      if (modes.length === 1) throw new Error(issue)
      return 'retained'
    })
    if (expectedCalls === 1) await assert.rejects(work)
    else assert.equal(await work, 'retained')
    assert.deepEqual(modes, expectedCalls === 1 ? [mode] : ['json_schema', 'prompt'])
  })
})

test('an unknown-dispatch observer barrier still blocks before fetch without compatibility or format replay', async t => {
  for (const protocol of protocols) await t.test(protocol, async t => {
    let calls = 0, dispatch = 0
    const blocked = Object.assign(new Error('unknown prior dispatch'), { code: 'source_request_unknown', outcome_certainty: 'unknown', statusCode: 409 })
    t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(completed(protocol)) })
    await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onDispatch() { dispatch++; throw blocked } }, () =>
      generateStructuredOutput('script_source_quality_repair', schema, (prompt, structured_output) => streamText(
        selected(protocol, { structured_output_mode: undefined }), provider, { prompt, structured_output }), 'source')), issue => issue === blocked)
    assert.equal(calls, 0); assert.equal(dispatch, 1)
  })
})

test('ordinary NDJSON line parsing remains available outside SSE', async t => {
  t.mock.method(globalThis, 'fetch', async () => stream(JSON.stringify(delta('responses', 'answer')) + '\n' +
    JSON.stringify(terminal('responses')) + '\n', 2, 'application/x-ndjson'))
  assert.equal(await streamText(selected('responses'), provider, { prompt: 'source' }), 'answer')
})


test('all three model protocols preserve unknown dispatches without transport or format replay, even for discardable atomic work', async t => {
  for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
    for (const failure of ['network', 'accepted empty EOF', 'partial EOF'] as const) await t.test(protocol + ':' + failure, async t => {
      let calls = 0, waits = 0, retries = 0
      const configured: GenerationModel = { ...selected('responses'), id: 'unknown-' + protocol, protocol }
      t.mock.method(globalThis, 'fetch', async () => {
        calls++
        if (failure === 'network') throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket lost'), { code: 'ECONNRESET' }) })
        const partial = protocol === 'anthropic_messages'
          ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"ok":' } }
          : delta(protocol, '{"ok":')
        return stream(failure === 'partial EOF' ? frame(partial) : ': keepalive\n\n')
      })
      const generate = retryReadOnlyGeneration((prompt, structured_output) => streamText(configured, provider, { prompt, structured_output }), {
        discardIncompleteOutput: true, wait: async () => { waits++ }, onRetry: () => { retries++ },
      })
      await assert.rejects(generateStructuredOutput('storyboard_shot_batch', schema, generate, 'complete original source and creator requirements'), error => {
        assert.ok(error instanceof TextProviderError)
        assert.ok(['unknown', 'accepted', 'output_started'].includes(error.delivery))
        assert.equal(error.responseTerminated, false)
        return true
      })
      assert.equal(calls, 1); assert.equal(waits, 0); assert.equal(retries, 0)
    })
  }
})

test('all three model protocols retain the existing one-retry boundary for explicit HTTP 503 rejection', async t => {
  for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) await t.test(protocol, async t => {
    let calls = 0, waits = 0
    const configured: GenerationModel = { ...selected('responses'), id: 'rejected-' + protocol, protocol }
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls === 1) return Response.json({ error: { type: 'overloaded_error', code: 'service_unavailable', message: 'retryable refusal' } }, { status: 503 })
      return Response.json(protocol === 'anthropic_messages'
        ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }
        : completed(protocol))
    })
    const generate = retryReadOnlyGeneration((prompt, structured_output) => streamText(configured, provider, { prompt, structured_output }), { wait: async () => { waits++ } })
    assert.deepEqual(await generateStructuredOutput('cross_protocol_known_rejection', schema, generate, 'full unchanged task'), { ok: true })
    assert.equal(calls, 2); assert.equal(waits, 1)
  })
})
