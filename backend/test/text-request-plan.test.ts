import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { prepareTextRequest } from '../src/infrastructure/providers/text-request-plan.js'
import { TextContextCapacityError } from '../src/infrastructure/providers/text-context.js'
import { withTextResponseRecovery, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'
import { withTextRequestUsage, isTextRequestBudgetError } from '../src/infrastructure/providers/text-request-usage.js'
import type { GenerationModel, TextRequestMetrics } from '../src/infrastructure/providers/providers.js'

const directory = await mkdtemp(join(tmpdir(), 'text-capacity-plan-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { scriptActivitySchema } = await import('../src/modules/script/script-activity.js')
const { streamText, createTextToolTransport, generate } = await import('../src/infrastructure/providers/providers.js')
after(() => rm(directory, { force: true, recursive: true }))
const provider = { adapter: 'http' as const, base_url: 'https://channel.invalid/v1' }
const capabilities = (input = 1000, output = 65536) => ({ version: 1, override: { budget_mode: 'separate', input_tokens: input, output_tokens: output } })
const options = { purpose: 'generation', url: `${provider.base_url}/responses`, headers: { Authorization: 'Bearer private-key' } }
const settings = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 65536 }, text_capabilities: capabilities() }
const output = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完整答案' }] }], output_text: '完整答案', status: 'completed', usage: { input_tokens: 100, output_tokens: 4 } }
const model = (protocol: GenerationModel['protocol'], extra = {}): GenerationModel => ({ id: 'fixture', remote_id: 'gemini-proxy-fixture', modality: 'text', protocol,
  settings: { ...settings, ...extra } })

test('near-limit same-channel count rescues a conservative rejection without consuming a generation attempt', async t => {
  const body = { model: 'exact-model', input: '完整原稿'.repeat(170), tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], max_output_tokens: 65536 }
  const before = structuredClone(body), usage = createScriptRequestUsage()
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.equal(url, 'https://channel.invalid/v1/responses/input_tokens')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-key')
    assert.equal(init.redirect, 'error')
    const request = JSON.parse(String(init.body))
    assert.equal(request.model, body.model); assert.equal(request.input, body.input); assert.deepEqual(request.tools, body.tools)
    assert.equal(request.max_output_tokens, undefined)
    return Response.json({ input_tokens: 800 })
  })
  const result = await withTextRequestUsage({ usage }, () => prepareTextRequest({ ...settings, text_token_counter: 'responses' }, body, 'responses', options))
  assert.equal(result.capacity.estimated_input_tokens, 800); assert.equal(result.capacity.input_count_method, 'provider')
  assert.equal(result.body.max_output_tokens, 65536); assert.equal(usage.requests, 0); assert.equal(usage.transport_requests, 1)
  assert.deepEqual(body, before)
})

test('counter failures retain estimate diagnostics and parent cancellation never falls back', async t => {
  const body = { model: 'same', input: '汉'.repeat(500), max_output_tokens: 65536 }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'unavailable' }, { status: 404 }))
  const result = await prepareTextRequest({ ...settings, text_token_counter: 'responses' }, body, 'responses', options)
  assert.equal(result.capacity.input_count_method, 'estimated_fallback')
  t.mock.restoreAll()
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(new Error('User stopped counting')); throw new Error('network') })
  await assert.rejects(prepareTextRequest({ ...settings, text_token_counter: 'responses' }, body, 'responses', { ...options, signal: controller.signal }), /User stopped counting/)
})

test('counted over-capacity input rejects before generation; unknown/short inputs do not call counting', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ input_tokens: 1001 }) })
  await assert.rejects(prepareTextRequest({ ...settings, text_token_counter: 'responses' }, { input: '汉'.repeat(600), max_output_tokens: 65536 }, 'responses', options), TextContextCapacityError)
  assert.equal(calls, 1)
  await prepareTextRequest({ ...settings, text_token_counter: 'responses' }, { input: 'short', max_output_tokens: 65536 }, 'responses', options)
  await prepareTextRequest({ text_token_counter: 'responses' }, { input: '汉'.repeat(600), max_output_tokens: 65536 }, 'responses', options)
  assert.equal(calls, 1)
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol}: auto output reaches normal, tool and persisted requests with matching diagnostics`, async t => {
  const limits = capabilities(100000, 12000)
  const configured = model(protocol, { text_capabilities: limits, text_api: { mode: 'standard', output_mode: 'auto' } })
  const sent: Record<string, any>[] = [], metrics: TextRequestMetrics[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body)
    return Response.json(protocol === 'responses' ? output : protocol === 'chat_completions'
      ? { choices: [{ message: { role: 'assistant', content: '完整答案' }, finish_reason: 'stop' }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'text', text: '完整答案' }], stop_reason: 'end_turn' })
  })
  assert.equal(await streamText(configured, provider, { prompt: '保留原文' }, undefined, undefined, undefined, value => metrics.push(value)), '完整答案')
  assert.equal((await createTextToolTransport(configured, provider, '保留原文', [], undefined, [], () => '', undefined, undefined, undefined, value => metrics.push(value))).text, '完整答案')
  const stored = await generate(configured, provider, { prompt: '保留原文' }, [], 'capacity-fixture', () => {})
  assert.equal(await readFile(stored.path, 'utf8'), '完整答案')
  const field = protocol === 'responses' ? 'max_output_tokens' : protocol === 'chat_completions' ? 'max_completion_tokens' : 'max_tokens'
  assert.equal(sent.length, 3)
  for (const body of sent) assert.equal(body[field], 8192)
  for (const value of metrics) {
    assert.equal(value.output_limit, 8192); assert.equal(value.output_source, 'auto'); assert.equal(value.budget_mode, 'separate')
    assert.doesNotThrow(() => scriptActivitySchema.parse({ id: 'record', kind: 'model', status: 'succeeded', label: '生成', summary: '', started_at: 1, ...value }))
  }
})

test('native Messages count retains exact signed blocks, images, schema and native authentication', async t => {
  const configured = model('anthropic_messages', { text_token_counter: 'anthropic_messages', text_capabilities: capabilities(1000), supports_vision: true,
    structured_output_mode: 'json_schema' })
  const requests: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('x-api-key'), 'native-key'); assert.equal(headers.get('anthropic-version'), '2023-06-01')
    if (String(url).endsWith('/count_tokens')) {
      assert.equal(body.max_tokens, undefined); assert.equal(body.messages[0].content[1].type, 'image')
      assert.equal(body.output_config.format.schema.type, 'object')
      return Response.json({ input_tokens: 100 })
    }
    return Response.json({ type: 'message', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' })
  })
  assert.equal(await streamText(configured, provider, { prompt: '原文', images: [{ data_url: 'data:image/png;base64,AQID' }],
    structured_output: { name: 'fixture', schema: { type: 'object', properties: {} } } }, () => 'native-key'), '{}')
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].messages, requests[1].messages)
})

test('scope changes discard discovered evidence and preserve the real legacy fixed 65536', async t => {
  let sent: any
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json(output) })
  const configured = model('responses', { context_window_tokens: 1000000, output_reserve_tokens: 128000,
    text_capabilities: { version: 1, discovered: { limits: { budget_mode: 'separate', input_tokens: 1, output_tokens: 1 }, source: 'provider', fetched_at: new Date().toISOString(),
      scope: { base_url: 'https://old.invalid/v1', protocol: 'responses', remote_id: 'other' } } } })
  await streamText(configured, provider, { prompt: '完整原稿' })
  assert.equal(sent.max_output_tokens, 65536)
  assert.equal((configured.settings as any).output_reserve_tokens, 128000)
})

test('background Responses sends the planned cap and keeps generation accounting separate from polling', async t => {
  const saved = new Map<string, BackgroundResponse>(), usage = createScriptRequestUsage()
  const configured = model('responses', { background_responses: true, structured_output_mode: 'json_schema', text_api: { mode: 'standard', output_mode: 'auto' }, text_capabilities: capabilities(100000, 24000) })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    assert.equal(body.max_output_tokens, 24000); assert.equal(body.stream, false); assert.equal(body.background, true)
    return Response.json({ ...output, id: 'resp_capacity' })
  })
  await withTextRequestUsage({ usage }, () => withTextResponseRecovery({ read: key => saved.get(key), save: (key, value) => value ? saved.set(key, value) : saved.delete(key) },
    () => streamText(configured, provider, { prompt: '保留完整内容', structured_output: { name: 'script_stage_draft', schema: { type: 'object', properties: {} } } })))
  assert.equal(usage.requests, 1)
})


test('a literal custom wire model cannot reuse capability evidence for a different saved model ID', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not count or fetch') })
  const configured = { text_capabilities: { version: 1, discovered: { source: 'provider', fetched_at: new Date().toISOString(),
    scope: { base_url: provider.base_url, protocol: 'responses', remote_id: 'saved-alias' },
    limits: { budget_mode: 'separate', input_tokens: 1, output_tokens: 1 } } } }
  const plan = await prepareTextRequest(configured, { model: 'actual-different-model', input: '完整原稿', max_output_tokens: 65536 }, 'responses', options)
  assert.equal(plan.body.max_output_tokens, 65536); assert.equal(plan.capacity.capability_source, 'unknown')
  assert.equal(plan.capacity.capacity_status, 'unknown')
})

test('invalid counter configuration and unsafe endpoint shapes cannot trigger another endpoint', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected endpoint') })
  await assert.rejects(prepareTextRequest({ ...settings, text_token_counter: 'anthropic_messages' }, { input: '汉'.repeat(500) }, 'responses', options), /当前文本协议/)
  for (const url of ['https://channel.invalid/v1/custom', 'https://channel.invalid/v1/responses?route=other']) {
    const plan = await prepareTextRequest({ ...settings, text_token_counter: 'responses' }, { input: '汉'.repeat(500), max_output_tokens: 65536 }, 'responses', { ...options, url })
    assert.equal(plan.capacity.input_count_method, 'estimated_fallback')
  }
  assert.equal(calls, 0)
})


test('provider counting can recover automatic generation when only the minimum usable output causes local rejection', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ input_tokens: 1000 }) })
  const configured = { text_api: { mode: 'standard', output_mode: 'auto' }, text_token_counter: 'responses',
    text_capabilities: { version: 1, override: { budget_mode: 'shared', context_tokens: 10000, output_tokens: 10000 } } }
  const plan = await prepareTextRequest(configured, { model: 'exact', input: '汉'.repeat(1800) }, 'responses', options)
  assert.equal(calls, 1); assert.equal(plan.capacity.input_count_method, 'provider')
  assert.equal(plan.body.max_output_tokens, 8872)
  assert.equal(plan.capacity.framing_reserve_tokens, 128)
})


test('native input-count transport budgets cannot be swallowed as estimate fallback', async t => {
  const usage = createScriptRequestUsage(); usage.transport_requests = 1
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ input_tokens: 100 }) })
  await assert.rejects(withTextRequestUsage({ usage, limits: { max_total_requests: 1 } }, () =>
    prepareTextRequest({ ...settings, text_token_counter: 'responses' }, { model: 'same', input: '汉'.repeat(500), max_output_tokens: 65536 }, 'responses', options)), isTextRequestBudgetError)
  assert.equal(calls, 0); assert.equal(usage.transport_requests, 1); assert.equal(usage.requests, 0)
})
