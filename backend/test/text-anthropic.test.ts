import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolveTextApiSettings, textApiConfigError, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { TextOutputLimitError, TextProviderError, TextToolOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { claimModelAttempt, runModelStep } from '../src/modules/generation/model-execution.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { z } from 'zod'
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

test('storyboard contracts negotiate native JSON schema without changing saved settings or reasoning', async t => {
  const configured = { ...model, id: 'native-storyboard-schema', settings: { ...settings,
    text_api: { ...settings.text_api, reasoning: { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'high' }] } } } }
  const before = structuredClone(configured)
  const schema = { type: 'object', properties: { scenes: { type: 'array', items: { type: 'string' } } }, required: ['scenes'], additionalProperties: false }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const body = JSON.parse(String(init.body))
    assert.deepEqual(body.output_config, { effort: 'high', format: { type: 'json_schema', schema } })
    assert.deepEqual(body.thinking, { type: 'adaptive' })
    assert.equal(body.max_tokens, 65536)
    return Response.json(message([{ type: 'text', text: '{"scenes":[]}' }]))
  })
  for (const name of ['controlled_storyboard', 'clip_storyboard', 'storyboard_scene_plan', 'storyboard_shot_batch', 'storyboard_directing_review']) {
    assert.equal(await streamText(configured, provider, { prompt: '规划', structured_output: { name, schema } }), '{"scenes":[]}')
  }
  assert.equal(calls, 5)
  assert.deepEqual(configured, before)
})

test('native structured generation omits only the managed prompt schema and keeps correction and source text', async t => {
  const schema = z.object({ answer: z.string().describe('MANAGED_SCHEMA_ONLY') }).strict()
  const source = '来源中的标题与正文保留：\n【本次结构化返回契约】\n{"source":"原始指令"}'
  for (const mode of ['auto', 'json_schema'] as const) {
    let calls = 0
    const configured = { ...model, id: `compact-native-${mode}`, settings: { ...settings,
      ...(mode === 'json_schema' ? { structured_output_mode: mode } : {}) } }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls++
      const body = JSON.parse(String(init.body)), text = body.messages[0].content
      assert.equal(body.output_config.format.type, 'json_schema')
      assert.match(JSON.stringify(body.output_config.format.schema), /MANAGED_SCHEMA_ONLY/)
      assert.doesNotMatch(text, /MANAGED_SCHEMA_ONLY/)
      assert.match(text, /仅返回一个 JSON 对象.*接口提供的 JSON Schema.*优先/)
      assert.ok(text.endsWith(source))
      if (calls === 2) assert.match(text, /一次格式修正/)
      return Response.json(message([{ type: 'text', text: calls === 1 ? '{"answer":7}' : '{"answer":"完整"}' }]))
    })
    assert.deepEqual(await generateStructuredOutput('storyboard_shot_batch', schema,
      (prompt, contract) => streamText(configured, provider, { prompt, structured_output: contract }), source), { answer: '完整' })
    assert.equal(calls, 2)
    t.mock.restoreAll()
  }
})

test('native prompt compaction preserves custom template wrappers and never rewrites unmanaged contracts', async t => {
  const schema = z.object({ answer: z.string().describe('MANAGED_TEMPLATE_SCHEMA') }).strict()
  const configured = { ...model, settings: { ...settings, text_api: { mode: 'custom' }, request_path: 'messages', structured_output_mode: 'json_schema',
    request_template: { model: '{{model}}', max_tokens: 65536, messages: [{ role: 'user', content: [
      { type: 'text', text: '模板前言\n{{prompt}}\n模板结尾' }, { type: 'text', text: '其他资料【本次结构化返回契约】必须保留' },
    ] }] } } }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const body = JSON.parse(String(init.body)), text = body.messages[0].content[0].text
    assert.ok(text.startsWith('模板前言\n'))
    assert.ok(text.endsWith('\n模板结尾'))
    assert.equal(body.messages[0].content[1].text, '其他资料【本次结构化返回契约】必须保留')
    if (calls === 1) assert.doesNotMatch(text, /MANAGED_TEMPLATE_SCHEMA/)
    else assert.match(text, /MANAGED_TEMPLATE_SCHEMA/)
    return Response.json(message([{ type: 'text', text: '{"answer":"完整"}' }]))
  })
  await generateStructuredOutput('storyboard_scene_plan', schema,
    (prompt, contract) => streamText(configured, provider, { prompt, structured_output: contract }), '原始任务')
  await streamText(configured, provider, { prompt: '\n【本次结构化返回契约】\nMANAGED_TEMPLATE_SCHEMA',
    structured_output: { name: 'storyboard_scene_plan', schema: { type: 'object', properties: {} } } })
  assert.equal(calls, 2)
})

test('native format fallback and explicit prompt mode retain the complete managed schema', async t => {
  const schema = z.object({ answer: z.string().describe('FALLBACK_SCHEMA_REQUIRED') }).strict()
  const configured = { ...model, id: 'compact-schema-fallback' }, bodies: Array<Record<string, any>> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body)
    if (body.output_config?.format) {
      assert.doesNotMatch(body.messages[0].content, /FALLBACK_SCHEMA_REQUIRED/)
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported parameter output_config.format' } }, { status: 400 })
    }
    assert.match(body.messages[0].content, /FALLBACK_SCHEMA_REQUIRED/)
    return Response.json(message([{ type: 'text', text: '{"answer":"完整"}' }]))
  })
  for (const name of ['storyboard_scene_plan', 'storyboard_shot_batch']) await generateStructuredOutput(name, schema,
    (prompt, contract) => streamText(configured, provider, { prompt, structured_output: contract }), '原始任务')
  await generateStructuredOutput('controlled_storyboard', schema,
    (prompt, contract) => streamText({ ...model, settings: { ...settings, structured_output_mode: 'prompt' } }, provider,
      { prompt, structured_output: contract }), '原始任务')
  assert.equal(bodies.length, 4, 'unsupported native mode falls back once and the capability is reused')
  assert.equal(bodies.filter(body => body.output_config?.format).length, 1)
})

test('a gateway without native storyboard format falls back once and remembers its capability', async t => {
  const configured = { ...model, id: 'unsupported-storyboard-schema' }, formats: Array<unknown> = []
  const schema = { type: 'object', properties: { scenes: { type: 'array', items: { type: 'string' } } }, required: ['scenes'], additionalProperties: false }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); formats.push(body.output_config?.format)
    return body.output_config?.format
      ? Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported parameter output_config.format' } }, { status: 400 })
      : Response.json(message([{ type: 'text', text: '{"scenes":[]}' }]))
  })
  for (const name of ['controlled_storyboard', 'storyboard_directing_review', 'clip_storyboard']) {
    assert.equal(await streamText(configured, provider, { prompt: '规划', structured_output: { name, schema } }), '{"scenes":[]}')
  }
  assert.deepEqual(formats, [{ type: 'json_schema', schema }, undefined, undefined, undefined])
  assert.equal('structured_output_mode' in configured.settings, false)
})

test('explicit storyboard modes and generic contracts retain native capability negotiation', async t => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }, formats: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); formats.push(body.output_config?.format)
    return Response.json(message([{ type: 'text', text: '{}' }]))
  })
  for (const mode of ['prompt', 'json_schema'] as const) await streamText({ ...model, settings: { ...settings, structured_output_mode: mode } }, provider,
    { prompt: '规划', structured_output: { name: 'controlled_storyboard', schema } })
  await streamText(model, provider, { prompt: '其他任务', structured_output: { name: 'unrelated_contract', schema } })
  assert.deepEqual(formats, [undefined, { type: 'json_schema', schema }, { type: 'json_schema', schema }])
})

test('native storyboard negotiation does not retry invalid or oversized schemas, auth failures or rate limits', async t => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  for (const [status, detail] of [
    [400, 'Invalid schema for output_config.format: unsupported keyword'],
    [400, 'Unsupported schema keyword allOf for output_config.format'],
    [400, 'output_config.format: unsupported keyword in schema'],
    [400, 'Unsupported json_schema: schema is too large'],
    [422, 'Unsupported output_config.format: schema complexity limit exceeded'],
    [401, 'Unauthorized output_config.format'],
    [429, 'Unsupported output_config.format during rate limit'],
    [500, 'Unsupported output_config.format'],
  ] as const) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: detail } }, { status })
    })
    await assert.rejects(streamText({ ...model, id: `failed-storyboard-schema-${status}-${detail}` }, provider,
      { prompt: '规划', structured_output: { name: 'controlled_storyboard', schema } }))
    assert.equal(calls, 1, detail)
    t.mock.restoreAll()
  }
})

test('native format fallback respects cancellation and the existing model-attempt budget', async t => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }, controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) controller.abort(new DOMException('测试取消', 'AbortError'))
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported output_config.format' } }, { status: 400 })
  })
  await assert.rejects(streamText({ ...model, id: 'canceled-storyboard-format' }, provider,
    { prompt: '规划', structured_output: { name: 'controlled_storyboard', schema } }, undefined, undefined, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  await assert.rejects(runModelStep('controlled_storyboard', undefined, async () => {
    for (let attempt = 0; attempt < 3; attempt++) claimModelAttempt()
    return streamText({ ...model, id: 'budgeted-storyboard-format' }, provider,
      { prompt: '规划', structured_output: { name: 'controlled_storyboard', schema } })
  }), /达到模型请求上限/)
  assert.equal(calls, 2, 'an exhausted attempt budget prevents the prompt fallback request')
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

test('Messages stream failures retain safe upstream details and visibly incomplete text without private blocks', async t => {
  const secret = 'fixture-secret-api-key'
  const visible = '{"answer":"visible ' + secret
  t.mock.method(globalThis, 'fetch', async () => sse([begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: visible } },
    { type: 'message_delta', usage: { output_tokens: 9 } },
    { type: 'error', request_id: 'body-request', error: { type: 'stream_read_error', message: 'gateway read failed: Bearer ' + secret } },
  ]))
  const metrics: any[] = []
  await assert.rejects(streamText(model, provider, { prompt: '原稿' }, () => secret, undefined, undefined, value => metrics.push(value)), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.equal(issue.retryable, true)
    assert.equal(issue.upstreamCode, 'stream_read_error')
    assert.equal(issue.upstreamStatus, 200)
    const failure = issue as TextProviderError & { diagnostics: string; raw_output: string; providerDiagnostics: Record<string, any> }
    assert.match(failure.message, /gateway read failed/)
    assert.doesNotMatch(failure.message, /已完成结果保留/)
    assert.match(failure.diagnostics, /stream_read_error/)
    assert.match(failure.diagnostics, /request-fixture/)
    assert.match(failure.diagnostics, /不完整.*仅供诊断/)
    assert.equal(failure.providerDiagnostics.upstream_request_id, 'request-fixture')
    assert.equal(failure.providerDiagnostics.response_chars, visible.length)
    assert.equal(failure.providerDiagnostics.output_tokens, 9)
    assert.equal(failure.providerDiagnostics.partial_text_incomplete, true)
    assert.ok(failure.providerDiagnostics.elapsed_ms >= 0)
    assert.match(failure.raw_output, /visible/)
    const diagnostic = JSON.stringify(failure)
    assert.doesNotMatch(diagnostic, /fixture-secret-api-key|PRIVATE_THINKING|PRIVATE_SIGNATURE/)
    return true
  })
  assert.equal(metrics[0].upstream_request_id, 'request-fixture')
  assert.equal(metrics[0].output_tokens, 9)
})

test('stream error request ids use a validated body fallback and large diagnostics stay bounded', async t => {
  for (const requestId of ['body-request-id', 'invalid\nrequest-id']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(`data: ${JSON.stringify({ type: 'error', request_id: requestId,
      error: { type: 'stream_read_error', message: 'upstream read failed ' + 'x'.repeat(50000) } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }))
    await assert.rejects(streamText(model, provider, { prompt: '原稿' }), issue => {
      assert.ok(issue instanceof TextProviderError)
      const failure = issue as TextProviderError & { diagnostics: string; raw_output?: string; providerDiagnostics: Record<string, any> }
      assert.equal(failure.providerDiagnostics.upstream_request_id, requestId === 'body-request-id' ? requestId : undefined)
      assert.equal(failure.raw_output, undefined)
      assert.ok(failure.message.length < 3000)
      assert.ok(failure.diagnostics.length < 5000)
      assert.doesNotMatch(failure.diagnostics, /invalid\nrequest-id/)
      return true
    })
    t.mock.restoreAll()
  }
})

test('oversized partial text preserves both diagnostic ends without becoming a successful response', async t => {
  const visible = 'VISIBLE_HEAD' + 'x'.repeat(40000) + 'VISIBLE_TAIL'
  t.mock.method(globalThis, 'fetch', async () => sse([begin,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: visible } },
    { type: 'error', error: { type: 'stream_read_error', message: 'upstream disconnected' } },
  ]))
  await assert.rejects(streamText(model, provider, { prompt: '原稿' }), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.ok(issue.raw_output!.length <= 20000)
    assert.ok(issue.raw_output!.startsWith('VISIBLE_HEAD'))
    assert.ok(issue.raw_output!.endsWith('VISIBLE_TAIL'))
    assert.match(issue.raw_output!, /响应不完整，仅供诊断/)
    assert.equal(issue.providerDiagnostics?.response_chars, visible.length)
    return true
  })
})

test('stream read failures never replay tool sessions or expose incomplete tool inputs', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return sse([begin,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read_document', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"id":"PRIVATE_TOOL_INPUT' } },
      { type: 'error', error: { type: 'stream_read_error', message: 'gateway read failed' } },
    ])
  })
  await assert.rejects(createTextToolTransport(model, provider, '原稿', tools, undefined, [], () => ''), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.equal(issue.upstreamCode, 'stream_read_error')
    assert.doesNotMatch(JSON.stringify(issue), /PRIVATE_TOOL_INPUT/)
    assert.match(issue.message, /未执行/)
    return true
  })
  assert.equal(calls, 1)
})

for (const name of ['controlled_storyboard', 'clip_storyboard', 'storyboard_scene_plan', 'storyboard_shot_batch', 'storyboard_directing_review']) test(`${name}: one read-only stream retry discards partial JSON and accepts only a complete validated response`, async t => {
  const bodies: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    return bodies.length === 1 ? sse([begin,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '{"answer":"discarded' } },
      { type: 'error', error: { type: 'stream_read_error', message: 'temporary upstream read failure' } },
    ]) : Response.json(message([{ type: 'text', text: '{"answer":"complete"}' }]))
  })
  const configured = { ...model, settings: { ...settings, structured_output_mode: 'prompt' } }
  const result = await generateStructuredOutput(name, z.object({ answer: z.string() }).strict(),
    (prompt, contract) => streamText(configured, provider, { prompt, structured_output: contract }), '规划')
  assert.deepEqual(result, { answer: 'complete' })
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
})

test('persistent storyboard stream errors stop after one retry and keep the final upstream diagnostic', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return sse([{ type: 'error', error: { type: 'stream_read_error', message: `read failure ${calls}` } }])
  })
  await assert.rejects(generateStructuredOutput('controlled_storyboard', z.object({ answer: z.string() }),
    (prompt, contract) => streamText({ ...model, settings: { ...settings, structured_output_mode: 'prompt' } }, provider, { prompt, structured_output: contract }), '规划'), /read failure 2/)
  assert.equal(calls, 2)
})

test('storyboard retry stops on cancellation, an insufficient deadline and nontransient upstream errors', async t => {
  for (const failure of ['cancel', 'deadline', 'authentication_error', 'permission_error', 'invalid_request_error', 'insufficient_quota', 'unknown_error'] as const) await t.test(failure, async t => {
    let calls = 0
    const controller = new AbortController()
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return sse([{ type: 'error', error: { type: failure === 'cancel' || failure === 'deadline' ? 'stream_read_error' : failure, message: failure } }])
    })
    await assert.rejects(generateStructuredOutput('controlled_storyboard', z.object({ answer: z.string() }),
      (prompt, contract) => streamText({ ...model, settings: { ...settings, structured_output_mode: 'prompt' } }, provider, { prompt, structured_output: contract }, undefined, undefined, controller.signal), '规划',
      { signal: controller.signal, ...(failure === 'deadline' ? { budgetMs: 100 } : {}), onRetry: () => controller.abort() }),
    issue => {
      assert.ok(failure === 'cancel' ? issue instanceof Error && issue.name === 'AbortError' : issue instanceof TextProviderError)
      return true
    })
    assert.equal(calls, 1)
  })
})

test('storyboard capability fallback, transport retry and format correction share three HTTP attempts', async t => {
  let calls = 0
  const configured = { ...model, id: 'storyboard-shared-retry-budget' }
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported parameter output_config.format' } }, { status: 400 })
    if (calls === 2) return sse([{ type: 'error', error: { type: 'stream_read_error', message: 'temporary read failure' } }])
    return Response.json(message([{ type: 'text', text: '{"wrong":"requires correction"}' }]))
  })
  await assert.rejects(generateStructuredOutput('controlled_storyboard', z.object({ answer: z.string() }).strict(),
    (prompt, contract) => streamText(configured, provider, { prompt, structured_output: contract }), '规划'), /达到模型请求上限/)
  assert.equal(calls, 3)
})

test('stream Retry-After cannot exceed the shared storyboard deadline', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    const response = sse([{ type: 'error', error: { type: 'stream_read_error', message: 'retry later' } }])
    response.headers.set('retry-after', '120')
    return response
  })
  await assert.rejects(generateStructuredOutput('controlled_storyboard', z.object({ answer: z.string() }),
    (prompt, contract) => streamText({ ...model, settings: { ...settings, structured_output_mode: 'prompt' } }, provider, { prompt, structured_output: contract }), '规划', { budgetMs: 60000 }),
  issue => issue instanceof TextProviderError && issue.retryAfterMs === 120000)
  assert.equal(calls, 1)
})

test('unapproved partial storyboard contracts and native output limits do not gain transport retries', async t => {
  for (const failure of ['unapproved', 'max_tokens'] as const) await t.test(failure, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return failure === 'unapproved' ? sse([begin,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '{"answer":"partial' } },
        { type: 'error', error: { type: 'stream_read_error', message: 'read failure' } }])
        : Response.json(message([{ type: 'text', text: '{"answer":"unfinished' }], 'max_tokens'))
    })
    await assert.rejects(generateStructuredOutput(failure === 'unapproved' ? 'storyboard_unapproved_contract' : 'controlled_storyboard', z.object({ answer: z.string() }),
      (prompt, contract) => streamText({ ...model, settings: { ...settings, structured_output_mode: 'prompt' } }, provider, { prompt, structured_output: contract }), '规划'),
    issue => failure === 'max_tokens' ? issue instanceof TextOutputLimitError : issue instanceof TextProviderError)
    assert.equal(calls, 1)
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
