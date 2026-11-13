import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textContextConfigError, textContextSettings } from '@video-studio/shared/models/text-context-settings'
import { assertTextRequestCapacity, estimateTextRequestTokens, TextContextCapacityError } from '../src/infrastructure/providers/text-context.js'
import { createTextToolTransport, generate, streamText, type GenerationModel, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import { retryReadOnlyGeneration } from '../src/modules/generation/read-only-retry.js'
import { validateSettings } from '../src/modules/models/validation.js'

const provider = { adapter: 'http' as const, base_url: 'https://context-fixture.invalid/v1' }
function model(protocol: 'responses' | 'chat_completions' = 'responses', extra: Record<string, unknown> = {}): GenerationModel {
  return { id: 'context-fixture', remote_id: 'unknown-custom-model', modality: 'text', protocol, settings: {
    request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
    text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content',
    request_template: protocol === 'responses' ? { model: '{{model}}', input: '{{prompt}}' } : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
    ...extra,
  } }
}
function capacityError(issue: unknown) {
  assert.ok(issue instanceof TextContextCapacityError)
  assert.equal(issue.retryable, false)
  assert.equal(issue.upstreamCode, 'context_capacity_exceeded')
  assert.match(issue.message, /容量|预算/)
  return true
}

test('capacity settings accept only explicit safe positive integers and preserve unknown capacity', () => {
  assert.deepEqual(textContextSettings({ custom: true }), {})
  assert.deepEqual(textContextSettings({ context_window_tokens: 128000, output_reserve_tokens: 16000 }), { context_window_tokens: 128000, output_reserve_tokens: 16000 })
  for (const value of [null, '', '128000', 0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(textContextConfigError({ context_window_tokens: value })!, /正整数/)
    assert.match(textContextConfigError({ output_reserve_tokens: value })!, /正整数/)
  }
  assert.match(textContextConfigError({ context_window_tokens: 1000, output_reserve_tokens: 1000 })!, /小于/)
  assert.equal(textContextConfigError({ output_reserve_tokens: 1000 }), null)
  const settings = model().settings as Record<string, unknown>
  assert.throws(() => validateSettings('text', { ...settings, context_window_tokens: '128000' }, 'responses'), /正整数/)
  assert.doesNotThrow(() => validateSettings('text', { ...settings, context_window_tokens: 128000, output_reserve_tokens: 16000 }, 'responses'))
})

test('Unicode estimates count code points, include CJK and astral text, and keep Latin estimates proportional', () => {
  const latin = estimateTextRequestTokens('a'.repeat(1000))
  const chinese = estimateTextRequestTokens('汉'.repeat(1000))
  const astralHan = estimateTextRequestTokens('𠀀'.repeat(1000))
  const emoji = estimateTextRequestTokens('😀'.repeat(1000))
  assert.ok(latin > 300 && latin < 500)
  assert.ok(chinese > 1500 && chinese < 1800)
  assert.equal(astralHan, chinese, 'astral Han has one code point, despite using two UTF-16 units')
  assert.ok(emoji > chinese && emoji < 3500)
  assert.ok(estimateTextRequestTokens({ messages: [{ role: 'system', content: '设定'.repeat(1000) }] }) > chinese)
  assert.doesNotThrow(() => assertTextRequestCapacity({ context_window_tokens: 1000, output_reserve_tokens: 100 }, { input: '简短请求' }, 'responses'))
})

test('output reservation follows the final protocol field before the fallback without mutating output or input', () => {
  const settings = { context_window_tokens: 10000, output_reserve_tokens: 50 }
  assert.equal(assertTextRequestCapacity(settings, { input: 'text', max_output_tokens: 2000 }, 'responses').reserved_output_tokens, 2000)
  assert.equal(assertTextRequestCapacity(settings, { messages: [], max_completion_tokens: 3000, max_tokens: 1000 }, 'chat_completions').reserved_output_tokens, 3000)
  assert.equal(assertTextRequestCapacity(settings, { messages: [], max_tokens: 1000 }, 'chat_completions').reserved_output_tokens, 1000)
  assert.equal(assertTextRequestCapacity(settings, { input: 'text' }, 'responses').reserved_output_tokens, 50)
  assert.equal(assertTextRequestCapacity({}, { input: 'text' }, 'responses').context_window_tokens, undefined)
  assert.throws(() => assertTextRequestCapacity({ context_window_tokens: 1000 }, { input: 'text' }, 'responses'), /未配置输出预留/)
  assert.throws(() => assertTextRequestCapacity(settings, { input: 'text', max_output_tokens: '2000' }, 'responses'), /输出上限必须为正整数/)
})

test('streaming and nonstreaming reject oversized full sources before fetch and never retry the capacity failure', async t => {
  let fetches = 0, attempts = 0, retries = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('must not fetch') })
  const configured = model('responses', { context_window_tokens: 1000, output_reserve_tokens: 100 })
  const source = '不能出现在诊断中的原稿'.repeat(1000)
  const request = retryReadOnlyGeneration(async prompt => { attempts++; return streamText(configured, provider, { prompt }) }, { onRetry: () => { retries++ } })
  await assert.rejects(request(source), issue => {
    capacityError(issue); assert.ok(!(issue as Error).message.includes(source.slice(0, 50)))
    assert.match((issue as Error).message, /估算|工具、历史|原稿和输出上限未被自动缩减/)
    return true
  })
  await assert.rejects(generate(configured, provider, { prompt: source }, [], 'capacity-fixture', () => {}), capacityError)
  assert.equal(fetches, 0); assert.equal(attempts, 1); assert.equal(retries, 0)
})

test('a request output cap can exhaust the budget even when the prompt and fallback reserve are small', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('must not fetch') })
  for (const [protocol, output] of [['responses', { max_output_tokens: 2000 }], ['chat_completions', { max_completion_tokens: 2000 }], ['chat_completions', { max_tokens: 2000 }]] as const) {
    const configured = model(protocol, { context_window_tokens: 1000, output_reserve_tokens: 10 })
    const settings = configured.settings as Record<string, unknown>
    settings.request_template = { ...settings.request_template as object, ...output }
    await assert.rejects(streamText(configured, provider, { prompt: 'short' }), issue => {
      capacityError(issue); assert.equal((issue as TextContextCapacityError).estimate?.reserved_output_tokens, 2000); return true
    })
  }
  assert.equal(fetches, 0)
})

test('structured compatibility requests budget the final Schema and fail without capability-probe fetches', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('must not fetch') })
  await assert.rejects(streamText(model('responses', { context_window_tokens: 1000, output_reserve_tokens: 100 }), provider, { prompt: 'short',
    structured_output: { name: 'script_large_contract', schema: { type: 'object', properties: { story: { type: 'string', description: '完整保留全部约束'.repeat(1000) } }, required: ['story'], additionalProperties: false } } }), capacityError)
  assert.equal(fetches, 0)
})

test('tool definitions and explicit continuation text are included before the first fetch', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('must not fetch') })
  const configured = model('responses', { context_window_tokens: 1000, output_reserve_tokens: 100 })
  const tools = [{ name: 'read_source', description: '原稿详细读取规则'.repeat(1000), parameters: { type: 'object' } }]
  await assert.rejects(createTextToolTransport(configured, provider, 'short', tools, undefined, [], () => ''), capacityError)
  await assert.rejects(createTextToolTransport(configured, provider, 'short', [], undefined, [], () => '', undefined, undefined, '保留此前完整结果并继续'.repeat(1000)), capacityError)
  assert.equal(fetches, 0)
})

test('each native tool turn checks growing history and results for Responses and Chat Completions', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    let fetches = 0
    t.mock.method(globalThis, 'fetch', async () => {
      fetches++
      return Response.json(protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'function_call', call_id: 'source-call', name: 'read_source', arguments: '{}' }] }
        : { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'source-call', type: 'function', function: { name: 'read_source', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
    })
    const session = textToolSession(model(protocol, { context_window_tokens: 1500, output_reserve_tokens: 100 }), provider, 'full original request',
      [{ name: 'read_source', description: '读取原稿', parameters: { type: 'object' } }], () => '')
    const first = await session()
    assert.equal(first.calls[0].id, 'source-call')
    await assert.rejects(session([{ id: 'source-call', output: '完整剧本内容'.repeat(1000) }]), capacityError)
    assert.equal(fetches, 1, 'the tool result is checked before a second request reaches the provider')
  })
})

test('unknown capacities do not reject based on model names; successful requests retain full input and caps', async t => {
  let sent: Record<string, unknown> = {}, metrics: TextRequestMetrics | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)); return Response.json({ status: 'completed', output_text: '完成' })
  })
  const source = '剧本完整内容'.repeat(1000)
  const configured = model('responses', { request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 4096 } })
  assert.equal(await streamText(configured, provider, { prompt: source }, undefined, undefined, undefined, value => { metrics = value }), '完成')
  assert.equal(sent.input, source); assert.equal(sent.max_output_tokens, 4096)
  assert.ok(metrics!.estimated_input_tokens! > 1000)
  assert.equal(metrics!.context_window_tokens, undefined)
  assert.equal(metrics!.reserved_output_tokens, 4096)
  assert.equal(sent.context_window_tokens, undefined)
  assert.equal(sent.output_reserve_tokens, undefined)
})
