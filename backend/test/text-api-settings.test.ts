import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { applyStandardTextSettings, migrateStandardTextSettings, resolveTextApiSettings, standardTextSettings, textApiConfigError, textApiMode, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { seedance2VideoSettings } from '@video-studio/shared/models/seedance-video-settings'

const testData = await mkdtemp(join(tmpdir(), 'text-api-settings-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { generate, streamText, createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
const { supportsScriptReviewPolicy } = await import('../src/infrastructure/providers/text-script-review-policy.js')
after(async () => { await rm(testData, { recursive: true, force: true }) })
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const protocols = ['responses', 'chat_completions'] as const
function legacy(protocol: TextApiProtocol, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }), ...extras },
    ...(protocol === 'responses' ? { text_paths: ['output_text', 'output'] } : { text_path: 'choices.0.message.content' }),
    context_window_tokens: 100_000, output_reserve_tokens: 4000, supports_vision: true, pricing: { per_generation: 0.2 }, custom_extension: { keep: true } }
}
function answer(protocol: TextApiProtocol) { return protocol === 'responses'
  ? { status: 'completed', output_text: '完整答案', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完整答案' }] }] }
  : { choices: [{ message: { content: '完整答案' }, finish_reason: 'stop' }] } }

test('safe legacy forms migrate without losing limits, thinking, pricing or extensions and survive protocol round trips', () => {
  const original = legacy('chat_completions', { max_tokens: 4096, thinking: { type: 'disabled' }, reasoning_effort: 'high', temperature: 0.3 })
  const before = structuredClone(original)
  const migrated = migrateStandardTextSettings(original, 'chat_completions')!
  assert.equal(textApiMode(original, 'chat_completions'), 'standard')
  assert.equal(textApiConfigError(migrated, 'chat_completions'), null)
  assert.deepEqual(migrated.text_api, { mode: 'standard', max_output_tokens: 4096, chat_output_field: 'max_tokens', thinking: 'disabled', reasoning_effort: 'high', request_parameters: { temperature: 0.3 } })
  assert.equal(migrated.request_template, undefined)
  const responses = resolveTextApiSettings(migrated, 'responses')
  assert.deepEqual(responses.request_template, { temperature: 0.3, model: '{{model}}', input: '{{prompt}}', max_output_tokens: 4096, reasoning: { effort: 'high' }, thinking: { type: 'disabled' } })
  const restored = resolveTextApiSettings(migrated, 'chat_completions')
  assert.deepEqual(restored.request_template, original.request_template)
  for (const key of ['context_window_tokens', 'output_reserve_tokens', 'supports_vision', 'pricing', 'custom_extension']) assert.deepEqual(migrated[key], original[key])
  assert.deepEqual(original, before)
})

test('custom contracts and ambiguous legacy templates are not silently rebuilt', () => {
  const fixtures = [
    { ...legacy('responses'), request_path: 'custom/responses' },
    { ...legacy('responses'), stream_request_template: { input: '{{prompt}}' } },
    { ...legacy('responses'), stream_text_paths: ['delta.text'] },
    legacy('responses', { reasoning: { effort: 'high', summary: 'auto' } }),
    legacy('responses', { max_output_tokens: 9000, max_tokens: 4000 }),
    legacy('responses', { undocumented: 5 }),
    legacy('responses', { temperature: '{{temperature}}' }),
    { ...legacy('responses'), text_api: { mode: 'custom' } },
  ]
  for (const settings of fixtures) {
    const before = structuredClone(settings)
    assert.equal(migrateStandardTextSettings(settings, 'responses'), null)
    assert.equal(textApiMode(settings, 'responses'), 'custom')
    assert.deepEqual(resolveTextApiSettings(settings, 'responses'), before)
    assert.deepEqual(settings, before)
    const rebuilt = applyStandardTextSettings(settings, 'responses')
    assert.equal(textApiConfigError(rebuilt, 'responses'), null)
    assert.deepEqual(rebuilt.text_api, { mode: 'standard' })
    assert.deepEqual(rebuilt.pricing, before.pricing)
  }
})

test('standard settings reject duplicate output sources, malformed limits and reserved envelope parameters', () => {
  for (const api of [
    { max_output_tokens: 0 }, { max_output_tokens: '8K' }, { max_output_tokens: 1.5 }, { max_output_tokens: 100_000 },
    { chat_output_field: 'max_output_tokens' }, { reasoning_effort: '' }, { thinking: false },
    { request_parameters: { max_tokens: 8192 } }, { request_parameters: { input: 'override' } },
    { request_parameters: { reasoning: { effort: 'high' } } }, { request_parameters: { stream: false } },
    { request_parameters: { metadata: '{{prompt}}' } },
  ]) assert.ok(textApiConfigError({ context_window_tokens: 100_000, text_api: { mode: 'standard', ...api } }, 'responses'))
  assert.ok(textApiConfigError({ ...standardTextSettings(), request_template: {} }, 'responses'))
  assert.ok(textApiConfigError({ text_api: { mode: 'custom', max_output_tokens: 4000 } }, 'responses'))
  assert.ok(textApiConfigError(standardTextSettings(), 'image_generations'))
  assert.deepEqual(resolveTextApiSettings(standardTextSettings(), 'responses').request_template, { model: '{{model}}', input: '{{prompt}}' })
})

for (const protocol of protocols) for (const transport of ['stream', 'tools', 'nonstream'] as const) {
  test(`${protocol} ${transport}: form output, reasoning and compatible thinking reach the actual request`, async t => {
    let calls = 0
    const settings = { ...standardTextSettings(protocol), context_window_tokens: 100_000, output_reserve_tokens: 500,
      text_api: { mode: 'standard', max_output_tokens: 65_536, chat_output_field: 'max_tokens', reasoning_effort: 'high', thinking: 'disabled', request_parameters: { temperature: 0.2 } } }
    const before = structuredClone(settings)
    const model = { id: 'form-test', remote_id: 'selected-model', modality: 'text' as const, protocol, settings }
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      calls++
      assert.equal(String(url), `https://fixture.invalid/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
      const body = JSON.parse(String(init.body))
      assert.equal(body.model, 'selected-model'); assert.equal(body.temperature, 0.2)
      assert.equal(protocol === 'responses' ? body.max_output_tokens : body.max_tokens, 65_536)
      assert.equal(protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort, 'high')
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.equal(body.text_api, undefined); assert.equal(body.context_window_tokens, undefined)
      assert.equal(body.output_reserve_tokens, undefined)
      assert.equal(protocol === 'responses' ? typeof body.input === 'string' ? body.input : body.input[0].content : body.messages[0].content, '完整剧本')
      if (transport === 'stream') {
        const event = protocol === 'responses' ? { type: 'response.completed', response: answer(protocol) } : { choices: [{ delta: { content: '完整答案' }, finish_reason: 'stop' }] }
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return Response.json(answer(protocol))
    })
    if (transport === 'stream') {
      let cap = 0
      assert.equal(await streamText(model, provider, { prompt: '完整剧本' }, undefined, undefined, undefined, metrics => { cap = metrics.output_limit ?? 0 }), '完整答案')
      assert.equal(cap, 65_536)
    } else if (transport === 'tools') {
      const turn = await createTextToolTransport(model, provider, '完整剧本', [], undefined, [], () => '')
      assert.equal(turn.text, '完整答案'); assert.equal(turn.metrics.reserved_output_tokens, 65_536)
    } else {
      const result = await generate(model, provider, { prompt: '完整剧本' }, [], 'forms', () => {})
      assert.equal(await readFile(result.path, 'utf8'), '完整答案')
    }
    assert.equal(calls, 1); assert.deepEqual(settings, before)
  })
}

for (const protocol of protocols) test(`${protocol}: clearing managed output/reasoning uses the upstream default on every transport`, async t => {
  const old = legacy(protocol, { [protocol === 'responses' ? 'max_output_tokens' : 'max_completion_tokens']: 8192,
    ...(protocol === 'responses' ? { reasoning: { effort: 'high' } } : { reasoning_effort: 'high' }) })
  const migrated = migrateStandardTextSettings(old, protocol)!
  const settings = { ...migrated, text_api: { mode: 'standard' } }
  const model = { id: 'clear-test', remote_id: 'selected-model', modality: 'text' as const, protocol, settings }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const body = JSON.parse(String(init.body))
    for (const key of ['max_output_tokens', 'max_completion_tokens', 'max_tokens', 'reasoning_effort', 'reasoning', 'thinking']) assert.equal(body[key], undefined)
    return Response.json(answer(protocol))
  })
  await streamText(model, provider, { prompt: 'no forced limit' })
  await createTextToolTransport(model, provider, 'no forced limit', [], undefined, [], () => '')
  await generate(model, provider, { prompt: 'no forced limit' }, [], 'forms', () => {})
  assert.equal(calls, 3)
})

for (const protocol of protocols) test(`${protocol}: managed structured output and native tool history preserve the configured allowance`, async t => {
  const model = { id: 'structured-managed', remote_id: 'selected-model', modality: 'text' as const, protocol,
    settings: { text_api: { mode: 'standard', max_output_tokens: 16_384, reasoning_effort: 'low' }, structured_output_mode: 'json_schema', strict_tool_arguments: true } }
  const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }
  const tools = [{ name: 'read_document', description: '读取正文', parameters: schema }]
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    const body = JSON.parse(String(init.body))
    assert.equal(protocol === 'responses' ? body.max_output_tokens : body.max_completion_tokens, 16_384)
    if (calls === 1) {
      assert.deepEqual(protocol === 'responses' ? body.text.format.schema : body.response_format.json_schema.schema, schema)
      return Response.json(answer(protocol))
    }
    assert.equal(body.response_format, undefined)
    assert.equal(protocol === 'responses' ? body.tools[0].strict : body.tools[0].function.strict, true)
    if (calls === 2) return Response.json(protocol === 'responses'
      ? { status: 'completed', output: [{ type: 'function_call', call_id: 'call-1', name: 'read_document', arguments: '{"result":"source"}' }] }
      : { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_document', arguments: '{"result":"source"}' } }] }, finish_reason: 'tool_calls' }] })
    const history = protocol === 'responses' ? body.input : body.messages
    assert.deepEqual(history.at(-1), protocol === 'responses'
      ? { type: 'function_call_output', call_id: 'call-1', output: '{"result":"actual source"}' }
      : { role: 'tool', tool_call_id: 'call-1', content: '{"result":"actual source"}' })
    return Response.json(answer(protocol))
  })
  assert.equal(await streamText(model, provider, { prompt: 'script', structured_output: { name: 'script_form_test', schema } }), '完整答案')
  const first = await createTextToolTransport(model, provider, 'script', tools, undefined, [], () => '')
  assert.deepEqual(first.calls, [{ id: 'call-1', name: 'read_document', arguments: '{"result":"source"}' }])
  const second = await createTextToolTransport(model, provider, 'script', tools, first.history, [{ id: 'call-1', output: '{"result":"actual source"}' }], () => '')
  assert.equal(second.text, '完整答案'); assert.equal(calls, 3)
})

test('managed requests retain official endpoint review detection and shared capacity enforcement', async t => {
  const model = { id: 'policy', remote_id: 'deepseek-flash', modality: 'text' as const, protocol: 'responses' as const,
    settings: { text_api: { mode: 'standard', max_output_tokens: 4000 }, context_window_tokens: 5000, output_reserve_tokens: 1 } }
  assert.equal(supportsScriptReviewPolicy(model, { adapter: 'http', base_url: 'https://api.deepseek.com' }), true)
  assert.equal(supportsScriptReviewPolicy(model, provider), false)
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(answer('responses')) })
  await assert.rejects(streamText(model, provider, { prompt: '完整原文'.repeat(500) }), /上下文预算不足/)
  assert.equal(calls, 0)
})

test('video defaults reach create requests and explicit selections override them', async t => {
  const model = { id: 'video-default', remote_id: 'selected-video', modality: 'video' as const, protocol: 'async_video' as const,
    settings: { ...seedance2VideoSettings(), default_duration: 9, default_ratio: '9:16', default_resolution: '720p' } }
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body))); return Response.json({ id: 'fixture-task' })
  })
  // Stop after the accepted create request. Polling and downloads are outside this configuration contract.
  const stop = () => { throw new Error('test stop after create') }
  await assert.rejects(generate(model, provider, { prompt: 'video' }, [], 'forms', stop), /保存任务编号失败/)
  await assert.rejects(generate(model, provider, { prompt: 'video', duration: 12, ratio: '16:9', resolution: '1080p' }, [], 'forms', stop), /保存任务编号失败/)
  assert.deepEqual(bodies.map(({ duration, ratio, resolution }) => ({ duration, ratio, resolution })), [
    { duration: 9, ratio: '9:16', resolution: '720p' }, { duration: 12, ratio: '16:9', resolution: '1080p' },
  ])
})
