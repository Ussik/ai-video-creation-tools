import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import { withTextRequestUsage, createScriptRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { TextProviderError, TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { resolveTextApiSettings, textApiConfigError } from '@video-studio/shared/models/text-api-settings'
import { planTextRequest } from '../src/infrastructure/providers/text-context.js'
import { discoverCatalogCapabilities } from '../src/infrastructure/providers/model-catalog-capabilities.js'
import { resolveTextCapabilities, scopeTextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { withTextResponseRecovery, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'
import { textFrameByteLimit } from '../src/infrastructure/providers/text-frame-boundary.js'
const directory = await mkdtemp(join(tmpdir(), 'provider-foundation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { streamText, generate, createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
const { analyzeGeminiImage } = await import('../src/infrastructure/providers/gemini-image-analysis.js')
import type { GenerationModel, TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
after(() => rm(directory, { recursive: true, force: true }))
const provider = { adapter: 'http' as const, base_url: 'https://integration.invalid/v1' }
const policy = { purpose: 'explicit_long_output', outputTokens: 24000, minimumOutputTokens: 2000, readOnly: true, recovery: 'units' as const }
function model(protocol: 'responses' | 'chat_completions' | 'anthropic_messages' = 'responses', settings: Record<string, unknown> = {}): GenerationModel {
  return { id: 'foundation-' + protocol, remote_id: 'wire-model', protocol, modality: 'text', settings: {
    text_api: { mode: 'standard', output_mode: 'auto' },
    text_capabilities: { version: 1, override: { budget_mode: 'separate', input_tokens: 100000, output_tokens: 65536 } }, ...settings,
  } }
}
const contract = { name: 'renamed_business_contract', schema: { type: 'object', properties: {}, additionalProperties: false } }
function result(protocol = 'responses', text = '{}') {
  return protocol === 'anthropic_messages' ? Response.json({ type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
    : protocol === 'chat_completions' ? Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      : Response.json({ status: 'completed', output_text: text, usage: { input_tokens: 10, output_tokens: 5 } })
}
for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol}: explicit task budget and one correlated dispatch survive a renamed contract`, async t => {
  let sent: any
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return result(protocol) })
  const dispatch: TextRequestMetrics[] = [], metrics: TextRequestMetrics[] = []
  const onDispatch = (value: unknown) => dispatch.push(value as TextRequestMetrics)
  const onMetrics = (value: unknown) => metrics.push(value as TextRequestMetrics)
  await withModelRequestContext({ policy, taskId: 'task', stepId: 'step', attemptId: 'attempt', onDispatch, onMetrics }, () =>
    streamText(model(protocol), provider, { prompt: 'full source', structured_output: contract }, undefined, undefined, undefined, onMetrics, onDispatch))
  const field = protocol === 'responses' ? 'max_output_tokens' : protocol === 'chat_completions' ? 'max_completion_tokens' : 'max_tokens'
  assert.equal(sent[field], 24000)
  assert.equal(dispatch.length, 1); assert.equal(metrics.length, 1)
  assert.equal(metrics[0]!.request_id, dispatch[0]!.request_id)
  assert.equal(metrics[0]!.task_id, 'task'); assert.equal(metrics[0]!.request_purpose, policy.purpose)
  assert.equal(metrics[0]!.output_parameter, field)
  assert.equal(metrics[0]!.delivery, 'completed')
})

test('auto shared allocation retains framing; fixed and separate budgets remain exact', () => {
  const settings = { text_api: { mode: 'standard', output_mode: 'auto' }, text_capabilities: { version: 1, override: { budget_mode: 'shared', context_tokens: 10000, output_tokens: 10000 } } }
  const automatic = planTextRequest(settings, { input: 'source' }, 'responses', { inputTokens: 1000, outputTokens: 10000, minimumOutputTokens: 1000 })
  assert.equal(automatic.body.max_output_tokens, 8872); assert.equal(automatic.capacity.framing_reserve_tokens, 128)
  const fixed = planTextRequest({ ...settings, text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 9000 } }, { input: 'source' }, 'responses', { inputTokens: 1000 })
  assert.equal(fixed.body.max_output_tokens, 9000); assert.equal(fixed.capacity.framing_reserve_tokens, undefined)
})

test('a disconnected stream carries partial evidence rather than a successful result', async t => {
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"完整第一单元"}\n\n')); controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(model(), provider, { prompt: 'source' }), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.equal(issue.failureReason, 'disconnected'); assert.equal(issue.delivery, 'output_started')
    assert.equal(issue.partialText, '完整第一单元'); assert.equal(issue.outputStarted, true)
    return true
  })
})

test('native fixed thinking budget stays fixed and unsupported modes fail before dispatch', () => {
  const fixed = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 12000,
    reasoning: { enabled: true, mode: 'fixed', budget_tokens: 2048, default_level: 'high', levels: [] } } }
  const body = resolveTextApiSettings(fixed, 'anthropic_messages').request_template as any
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 }); assert.equal(body.output_config, undefined)
  assert.match(textApiConfigError({ ...fixed, text_api: { ...fixed.text_api, max_output_tokens: 2000 } }, 'anthropic_messages')!, /小于最大输出/)
  assert.match(textApiConfigError({ ...fixed, text_api: { ...fixed.text_api, reasoning: { ...fixed.text_api.reasoning, budget_tokens: 100 } } }, 'anthropic_messages')!, /最低值/)
})

test('all structured entry families negotiate native Messages format on explicit rejection only', async t => {
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body)
    return bodies.length === 1 ? Response.json({ error: { type: 'invalid_request_error', message: 'output_config.format json_schema unsupported' } }, { status: 400 }) : result('anthropic_messages')
  })
  assert.equal(await streamText({ ...model('anthropic_messages'), id: 'native-negotiation' }, provider, { prompt: 'source', structured_output: contract }), '{}')
  assert.equal(bodies.length, 2); assert.equal(bodies[0].output_config.format.type, 'json_schema'); assert.equal(bodies[1].output_config, undefined)
})

test('invalid schema is not mistaken for unsupported format and generic input overflow is normalized', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 'invalid_request_error', message: 'invalid schema in response_format json_schema' } }, { status: 400 }) })
  await assert.rejects(streamText({ ...model(), id: 'invalid-schema' }, provider, { prompt: 'source', structured_output: contract }))
  assert.equal(calls, 1)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { type: 'invalid_request_error', message: 'prompt is too long for the maximum context length' } }, { status: 400 }))
  await assert.rejects(streamText(model(), provider, { prompt: 'source' }), issue => issue instanceof TextProviderError && issue.failureReason === 'context_overflow' && !issue.retryable)
})

test('malformed complete tool arguments are rejected before returning executable calls', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call', name: 'read', arguments: '{"id":' }] }))
  await assert.rejects(createTextToolTransport(model(), provider, 'source', [{ name: 'read', description: '', parameters: { type: 'object' } }], undefined, [], () => ''),
    issue => issue instanceof TextProviderError && issue.failureReason === 'invalid_tool' && issue.partialText === undefined)
})

test('nonstream jobs preserve custom per-mode variables and inherit parent cancellation', async t => {
  let sent: any
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }) })
  const configured: GenerationModel = { id: 'custom', remote_id: 'alias', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'custom', text_path: 'choices.0.message.content', request_template: { ignored: true }, stream_request_template: { wrong_stream_template: true },
    request_templates: { text: { model: 'literal-model', messages: [{ role: 'user', content: '{{prompt}}' }], duration: '{{duration}}' } },
  } }
  const saved = await generate(configured, provider, { prompt: '原稿{{literal}}', mode: 'text', duration: 7 }, [], 'project', () => {})
  assert.equal(await readFile(saved.path, 'utf8'), '正文'); assert.equal(sent.duration, 7)
  assert.equal(sent.messages[0].content, '原稿{{literal}}'); assert.equal(sent.wrong_stream_template, undefined); assert.equal(sent.stream, undefined)
  t.mock.restoreAll()
  const controller = new AbortController(), reason = new DOMException('user stop', 'AbortError')
  let fetchStarted = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    fetchStarted = true
    queueMicrotask(() => controller.abort(reason))
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
  })
  await assert.rejects(withModelRequestContext({ policy, signal: controller.signal }, () => generate(model(), provider, { prompt: 'source' }, [], 'project', () => {})), issue => issue === reason)
  assert.equal(fetchStarted, true)
})

test('native Gemini text analysis records its own model, usage and output limit without borrowing image limits', async t => {
  const metrics: TextRequestMetrics[] = [], usage = createScriptRequestUsage()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.deepEqual(body.generationConfig, { responseModalities: ['TEXT'] })
    return Response.json({ candidates: [{ content: { parts: [{ text: '完整单元' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 8, cachedContentTokenCount: 20 } }, { headers: { 'x-request-id': 'native-request' } })
  })
  const image: GenerationModel = { id: 'image', remote_id: 'image-generation', modality: 'image', protocol: 'image_generations', settings: {
    max_output_tokens: 1, image_analysis: { enabled: true, protocol: 'gemini_generate_content', remote_id: 'actual-analysis' },
  } }
  const request = { prompt: 'analyze', images: [{ data_url: 'data:image/png;base64,AQID' }] }
  await assert.rejects(withTextRequestUsage({ usage }, () => withModelRequestContext({ policy, onMetrics: value => metrics.push(value as TextRequestMetrics) }, () =>
    analyzeGeminiImage(image, provider, request))), issue => issue instanceof TextOutputLimitError && issue.partialText === '完整单元' && issue.rawReason === 'MAX_TOKENS')
  assert.equal(metrics.length, 1); assert.equal(metrics[0]!.remote_id, 'actual-analysis'); assert.equal(metrics[0]!.output_limit, undefined)
  assert.equal(metrics[0]!.output_tokens, 20); assert.equal(metrics[0]!.reasoning_tokens, 8); assert.equal(metrics[0]!.upstream_request_id, 'native-request')
  assert.equal(usage.requests, 1); assert.equal(usage.output_tokens, 20); assert.equal(usage.cache_read_tokens, 20)
})

test('background create and accepted-ID polling each have one unique actual dispatch trace', async t => {
  const rows = new Map<string, BackgroundResponse>(), dispatch: any[] = [], usage = createScriptRequestUsage()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => init.method === 'POST'
    ? Response.json({ id: 'resp_persisted', status: 'queued' })
    : Response.json({ id: 'resp_persisted', status: 'completed', output_text: '{}', usage: { input_tokens: 10, output_tokens: 5 } }))
  await withTextRequestUsage({ usage }, () => withModelRequestContext({ policy, onDispatch: value => dispatch.push(value) }, () =>
    withTextResponseRecovery({ read: key => rows.get(key), save: (key, value) => { if (value) rows.set(key, value); else rows.delete(key) } }, () =>
      streamText(model('responses', { background_responses: true }), provider, { prompt: 'source', structured_output: contract }))))
  assert.deepEqual(dispatch.map(value => value.transport_kind), ['background_create', 'background_poll'])
  assert.equal(new Set(dispatch.map(value => value.request_id)).size, 2)
  assert.equal(usage.requests, 1); assert.equal(usage.transport_requests, 1)
})

test('catalog compatibility evidence is scoped and unsupported tools never dispatch', async t => {
  const discovery = discoverCatalogCapabilities({ id: 'actual', compatibility: { tools: false, encrypted_reasoning: true } }, 'actual', { base_url: provider.base_url, protocol: 'responses', fetched_at: new Date().toISOString() })!
  assert.equal(discovery.compatibility!.tools, false)
  const settings = { text_api: { mode: 'standard' }, text_capabilities: { version: 1, discovered: discovery } }
  assert.equal(resolveTextCapabilities(scopeTextCapabilities(settings, { ...discovery.scope, remote_id: 'other' })).compatibility.tools, undefined)
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return result() })
  await assert.rejects(createTextToolTransport({ ...model('responses', settings), remote_id: 'actual' }, provider, 'source', [], undefined, [], () => ''), /不支持工具调用/)
  assert.equal(calls, 0)
})

test('one unparsed oversized SSE event is bounded separately from long cumulative content', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: ' + 'x'.repeat(textFrameByteLimit + 1), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(model(), provider, { prompt: 'source' }), issue => issue instanceof TextProviderError && issue.rawReason === 'response_frame_too_large')
})

test('a cancelled paid-media poll preserves the user reason and never creates a replacement task', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('cancelled polling must not reach the provider') })
  const controller = new AbortController(), reason = new Error('user stopped this paid task')
  const pending = withModelRequestContext({ policy: { purpose: 'video_generation', readOnly: false, recovery: 'paid' }, signal: controller.signal }, () =>
    generate({ id: 'existing-video', remote_id: 'video-model', modality: 'video', settings: { get_path: 'tasks/{id}', poll_seconds: 60 } },
      provider, { prompt: 'original source', _external_id: 'accepted-task' }, [], 'project', () => assert.fail('cannot create another paid task')))
  await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort(reason)
  await assert.rejects(pending, issue => issue === reason)
  assert.equal(requests, 0)
})
