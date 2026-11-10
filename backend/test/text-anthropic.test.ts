import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolveTextApiSettings, textApiConfigError, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { TextOutputLimitError, TextToolOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
const directory = await mkdtemp(join(tmpdir(), 'anthropic-messages-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { createTextToolTransport, streamText, generate } = await import('../src/infrastructure/providers/providers.js')
const { textToolSession } = await import('../src/infrastructure/providers/text-tools.js')
after(() => rm(directory, { force: true, recursive: true }))
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1', auth_header: 'Authorization', auth_prefix: 'Bearer ' }
const settings = { text_api: { mode: 'standard', max_output_tokens: 65536 }, context_window_tokens: 1_000_000, supports_vision: true }
const model = { id: 'native', remote_id: 'claude-fixture', modality: 'text' as const, protocol: 'anthropic_messages' as const, settings }
const message = (content: unknown[] = [{ type: 'text', text: '完整答案' }], stop_reason = 'end_turn') => ({ type: 'message', role: 'assistant', id: 'msg-1', content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } })
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream', 'request-id': 'request-fixture' } })
const begin = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } }
const end = (reason = 'end_turn') => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7 } }, { type: 'message_stop' }]
const tools = [{ name: 'read_document', description: '读取来源', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }]

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as TextApiProtocol[]) test(`${protocol}: selected reasoning mapping controls the wire, off and disabled preserve data without effort`, () => {
  const input = { text_api: { mode: 'standard', max_output_tokens: 65536, reasoning_effort: 'old', thinking: 'enabled',
    reasoning: { enabled: true, default_level: 'high', levels: [{ level: 'off', api_value: '' }, { level: 'high', api_value: 'custom_effort' }] } } }
  const before = structuredClone(input)
  const body = resolveTextApiSettings(input, protocol).request_template as Record<string, any>
  assert.equal(protocol === 'responses' ? body.reasoning.effort : protocol === 'anthropic_messages' ? body.output_config.effort : body.reasoning_effort, 'custom_effort')
  if (protocol === 'anthropic_messages') assert.deepEqual(body.thinking, { type: 'adaptive' })
  input.text_api.reasoning.default_level = 'off'
  const off = resolveTextApiSettings(input, protocol).request_template as Record<string, any>
  if (protocol === 'anthropic_messages') { assert.deepEqual(off.thinking, { type: 'disabled' }); assert.equal(off.reasoning, undefined); assert.equal(off.reasoning_effort, undefined) }
  else if (protocol === 'responses') { assert.deepEqual(off.reasoning, { effort: 'none' }); assert.equal(off.thinking, undefined); assert.equal(off.reasoning_effort, undefined) }
  else { assert.equal(off.reasoning_effort, 'none'); assert.equal(off.thinking, undefined); assert.equal(off.reasoning, undefined) }
  assert.equal(off.output_config, undefined)
  input.text_api.reasoning.enabled = false
  const disabled = resolveTextApiSettings(input, protocol).request_template as Record<string, any>
  for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'output_config']) assert.equal(disabled[key], undefined)
  assert.deepEqual(input.text_api.reasoning.levels, before.text_api.reasoning.levels)
})

test('invalid reasoning mappings and missing Anthropic output cap are rejected before dispatch', async t => {
  assert.ok(textApiConfigError({ text_api: { mode: 'standard' } }, 'anthropic_messages'))
  for (const reasoning of [
    { enabled: true, default_level: 'high', levels: [] },
    { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: '' }] },
    { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'high' }, { level: 'high', api_value: 'low' }] },
    { enabled: true, default_level: 'bogus', levels: [{ level: 'high', api_value: 'high' }] },
  ]) assert.ok(textApiConfigError({ text_api: { ...settings.text_api, reasoning } }, 'anthropic_messages'))
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(message()) })
  await assert.rejects(streamText({ ...model, settings: { text_api: { mode: 'standard' } } }, provider, { prompt: '原稿' }), /必须明确/)
  assert.equal(calls, 0)
})

test('Messages streaming uses native authentication, text deltas, exact output cap, cached usage and hides signed thinking', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), 'https://fixture.invalid/v1/messages')
    const headers = new Headers(init.headers), body = JSON.parse(String(init.body))
    assert.equal(headers.get('x-api-key'), 'test-api-key'); assert.equal(headers.get('Authorization'), null)
    assert.equal(headers.get('anthropic-version'), '2023-06-01')
    assert.equal(body.max_tokens, 65536); assert.equal(body.max_output_tokens, undefined); assert.equal(body.stream, true)
    assert.deepEqual(body.messages, [{ role: 'user', content: '完整原稿' }])
    return sse([begin,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIGNED' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完整' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
      { type: 'content_block_stop', index: 1 }, ...end()])
  })
  const events: unknown[] = [], metrics: any[] = [], dispatch: any[] = []
  const result = await streamText(model, provider, { prompt: '完整原稿' }, () => 'test-api-key', event => { events.push(event) }, undefined, metric => metrics.push(metric), metric => dispatch.push(metric))
  assert.equal(result, '完整答案'); assert.deepEqual(events, [{ type: 'delta', text: '完整' }, { type: 'delta', text: '答案' }])
  assert.equal(metrics[0].input_tokens, 35); assert.equal(metrics[0].cache_read_tokens, 20); assert.equal(metrics[0].cache_write_tokens, 5)
  assert.equal(metrics[0].output_tokens, 7); assert.equal(metrics[0].upstream_request_id, 'request-fixture')
  assert.equal(dispatch[0].output_limit, 65536)
})

test('native nonstream JSON and persisted text generation use the same body and visible extraction', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body)); assert.equal(body.stream, calls === 1)
    assert.equal(body.max_tokens, 65536)
    return Response.json(message([{ type: 'thinking', thinking: 'PRIVATE', signature: 'SIGNED' }, { type: 'text', text: '完整答案' }]))
  })
  assert.equal(await streamText(model, provider, { prompt: '原稿' }), '完整答案')
  const result = await generate(model, provider, { prompt: '原稿' }, [], 'fixture', () => {})
  assert.equal(await readFile(result.path, 'utf8'), '完整答案'); assert.equal(calls, 2)
})

test('native image blocks and structured output format preserve configured reasoning effort', async t => {
  const reasoning = { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'high' }] }
  const configured = { ...model, settings: { ...settings, structured_output_mode: 'json_schema', text_api: { ...settings.text_api, reasoning } } }
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    assert.deepEqual(body.output_config, { effort: 'high', format: { type: 'json_schema', schema } })
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '原稿' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }])
    return Response.json(message([{ type: 'text', text: '{"ok":true}' }]))
  })
  assert.equal(await streamText(configured, provider, { prompt: '原稿', images: [{ data_url: 'data:image/png;base64,AQID' }], structured_output: { name: 'fixture', schema } }), '{"ok":true}')
})

test('Messages tools stream JSON arguments, relay exact signed history and native tool_result, then resume a text answer', async t => {
  let calls = 0
  const text: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body))
    assert.deepEqual(body.tools, [{ name: 'read_document', description: '读取来源', input_schema: tools[0]!.parameters }])
    assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
    assert.equal(body.parallel_tool_calls, undefined)
    if (calls === 2) {
      assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE', signature: 'SIGNED' }, { type: 'tool_use', id: 'call-1', name: 'read_document', input: { id: 'source' } }] })
      assert.deepEqual(body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"actual":"原文"}' }] })
      assert.deepEqual(body.messages[3], { role: 'user', content: '按原文继续' })
      return Response.json(message())
    }
    return sse([begin,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE', signature: 'SIGNED' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'read_document', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"source"}' } },
      { type: 'content_block_stop', index: 1 }, ...end('tool_use')])
  })
  const session = textToolSession(model, provider, '原稿', tools, () => '', undefined, value => text.push(value))
  const first = await session(); assert.deepEqual(first.calls, [{ id: 'call-1', name: 'read_document', arguments: '{"id":"source"}' }]); assert.equal(first.text, '')
  const second = await session([{ id: 'call-1', output: '{"actual":"原文"}' }], '按原文继续')
  assert.equal(second.text, '完整答案'); assert.equal(calls, 2); assert.deepEqual(text, ['完整答案'])
})

for (const transport of ['stream', 'nonstream', 'tool'] as const) test(`${transport}: max_tokens exposes truncation diagnostics and never executes partial tool arguments`, async t => {
  t.mock.method(globalThis, 'fetch', async () => transport === 'nonstream' ? Response.json(message([{ type: 'text', text: '已闭合正文。' }], 'max_tokens')) : sse([
    begin, { type: 'content_block_start', index: 0, content_block: transport === 'tool' ? { type: 'tool_use', id: 'call-1', name: 'read_document', input: {} } : { type: 'text', text: '已闭合正文。' } },
    ...(transport === 'tool' ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"half' } }] : []),
    ...end('max_tokens'), { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '不能在截断后继续采用' } },
  ]))
  const metrics: any[] = []
  await assert.rejects(transport === 'tool'
    ? createTextToolTransport(model, provider, '原稿', tools, undefined, [], () => '', undefined, undefined, undefined, value => metrics.push(value))
    : streamText(model, provider, { prompt: '原稿' }, undefined, undefined, undefined, value => metrics.push(value)), issue => {
    assert.ok(transport === 'tool' ? issue instanceof TextToolOutputLimitError : issue instanceof TextOutputLimitError)
    const error = issue as TextOutputLimitError; assert.equal(error.outputLimit, 65536); assert.equal(error.reason, 'max_output_tokens')
    if (transport !== 'tool') assert.equal(error.partialText, '已闭合正文。')
    return true
  })
  assert.equal(metrics[0].output_limit_reason, 'max_output_tokens')
})

test('disconnected, refused and malformed tool responses fail without executing incomplete calls', async t => {
  for (const [response, code] of [
    [() => sse([begin, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read_document', input: {} } }]), 'stream_disconnected'],
    [() => Response.json(message([{ type: 'text', text: '拒绝。' }], 'refusal')), 'content_filter'],
    [() => Response.json(message([{ type: 'tool_use', id: 'call-1', name: 'read_document', input: [] }], 'tool_use')), 'invalid_tool_call'],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => response())
    await assert.rejects(createTextToolTransport(model, provider, '原稿', tools, undefined, [], () => ''), { upstreamCode: code })
    t.mock.restoreAll()
  }
})

test('native HTTP errors redact API keys and respect retryability', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'fixture test-secret-api-key' } }, { status: 529 }))
  await assert.rejects(streamText(model, provider, { prompt: '原稿' }, () => 'test-secret-api-key'), issue => {
    assert.ok(issue instanceof Error); assert.ok(!issue.message.includes('test-secret-api-key'))
    assert.equal((issue as { retryable?: boolean }).retryable, true)
    assert.equal((issue as { upstreamCode?: string }).upstreamCode, 'overloaded_error'); return true
  })
})

test('unclosed streamed tool blocks and nonobject JSON arguments are rejected even after message_stop', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse([begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read_document', input: { id: 'source' } } },
    ...end('tool_use')]))
  await assert.rejects(createTextToolTransport(model, provider, '原稿', tools, undefined, [], () => ''), { upstreamCode: 'bad_response_body' })
})

for (const protocol of ['responses', 'chat_completions'] as const) for (const transport of ['stream', 'nonstream', 'tools'] as const) test(`${protocol}/${transport}: configured default reasoning API mapping reaches the actual HTTP request`, async t => {
  const configured = { ...model, protocol, settings: { text_api: { mode: 'standard', max_output_tokens: 65536,
    reasoning: { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'provider_high' }] } } } }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; const body = JSON.parse(String(init.body))
    assert.equal(protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort, 'provider_high')
    assert.equal(body.thinking, undefined)
    return Response.json(protocol === 'responses' ? { status: 'completed', output_text: '完整答案', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完整答案' }] }] }
      : { choices: [{ message: { role: 'assistant', content: '完整答案' }, finish_reason: 'stop' }] })
  })
  if (transport === 'tools') assert.equal((await createTextToolTransport(configured, provider, '原稿', tools, undefined, [], () => '')).text, '完整答案')
  else if (transport === 'nonstream') assert.equal(await readFile((await generate(configured, provider, { prompt: '原稿' }, [], 'mapped', () => {})).path, 'utf8'), '完整答案')
  else assert.equal(await streamText(configured, provider, { prompt: '原稿' }), '完整答案')
  assert.equal(calls, 1)
})
