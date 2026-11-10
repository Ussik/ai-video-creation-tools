import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTextCapabilities, scopeTextCapabilities, textCapabilitiesConfigError, type TextModelLimits } from '@video-studio/shared/models/text-capabilities'
import { resolveTextApiSettings, textApiConfigError, textOutputMode } from '@video-studio/shared/models/text-api-settings'
import { planTextRequest, textRequestInput, TextContextCapacityError } from '../src/infrastructure/providers/text-context.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'

const scope = { base_url: 'https://channel.invalid/v1', protocol: 'responses', remote_id: 'arbitrary-model' }
const discovered = { source: 'provider' as const, fetched_at: '2026-11-10T00:00:00.000Z', scope,
  limits: { budget_mode: 'separate' as const, input_tokens: 100000, output_tokens: 32768, output_includes_reasoning: true } }
const settings = (limits: TextModelLimits, api?: Record<string, unknown>) => ({ text_capabilities: { version: 1, override: limits }, ...(api ? { text_api: { mode: 'standard', ...api } } : {}) })

test('capability resolution preserves per-field discovery and overrides without guessing capacity', () => {
  const raw = { context_window_tokens: 1000, text_capabilities: { version: 1, discovered, override: { output_tokens: 16000 } } }
  const resolved = resolveTextCapabilities(raw)
  assert.deepEqual(resolved.limits, { budget_mode: 'separate', input_tokens: 100000, output_tokens: 16000, output_includes_reasoning: true })
  assert.equal(resolved.sources.output_tokens, 'override')
  assert.equal(resolved.sources.input_tokens, 'provider')
  assert.equal(resolved.source, 'override')
  assert.equal(resolved.configured, true)
  assert.deepEqual(resolveTextCapabilities({ context_window_tokens: 1000 }).limits, { budget_mode: 'shared', context_tokens: 1000 })
  assert.deepEqual(resolveTextCapabilities({ model: 'gemini-huge', protocol: 'responses' }).limits, { budget_mode: 'unknown' })
  assert.deepEqual(resolveTextCapabilities({ context_window_tokens: 1000, text_capabilities: { version: 1 } }).limits, { budget_mode: 'unknown' })
  assert.equal(raw.text_capabilities.discovered.limits.output_tokens, 32768)
})

test('channel discovery expires for changes of URL, protocol or model while overrides remain separate', () => {
  const raw = { text_capabilities: { version: 1, discovered, override: { output_tokens: 16000 } } }
  assert.equal(scopeTextCapabilities(raw, { ...scope, base_url: `${scope.base_url}/` }), raw)
  for (const next of [{ ...scope, base_url: 'https://other.invalid/v1' }, { ...scope, protocol: 'chat_completions' }, { ...scope, remote_id: 'other-model' }]) {
    const scoped = scopeTextCapabilities(raw, next)
    assert.deepEqual(resolveTextCapabilities(scoped).limits, { budget_mode: 'unknown', output_tokens: 16000 })
    assert.ok(raw.text_capabilities.discovered)
  }
})

test('capability configuration rejects invalid limits and evidence instead of accepting coercion', () => {
  for (const value of [0, -1, 0.5, '1000', Infinity, null]) assert.match(textCapabilitiesConfigError(settings({ budget_mode: 'unknown', input_tokens: value as number }))!, /正整数/)
  assert.match(textCapabilitiesConfigError({ text_capabilities: { version: 2 } })!, /版本/)
  assert.match(textCapabilitiesConfigError({ text_capabilities: { version: 1, discovered: { ...discovered, fetched_at: 'never' } } })!, /时间/)
  assert.match(textCapabilitiesConfigError(settings({ budget_mode: 'separate', output_includes_reasoning: 'yes' as unknown as boolean }))!, /布尔/)
  assert.equal(textCapabilitiesConfigError(settings({ budget_mode: 'unknown', input_tokens: 1000 })), null)
})

test('shared and separate budgets apply different boundaries to the exact same input and output', () => {
  const body = { input: '完整输入', max_output_tokens: 400 }
  assert.throws(() => planTextRequest(settings({ budget_mode: 'shared', context_tokens: 1000, input_tokens: 1000, output_tokens: 400 }), body, 'responses', { inputTokens: 800 }), /上下文预算不足/)
  const separate = planTextRequest(settings({ budget_mode: 'separate', input_tokens: 1000, output_tokens: 400 }), body, 'responses', { inputTokens: 800 })
  assert.equal(separate.capacity.capacity_status, 'validated')
  assert.equal(separate.capacity.reserved_output_tokens, 400)
  assert.deepEqual(body, { input: '完整输入', max_output_tokens: 400 })
  assert.throws(() => planTextRequest(settings({ budget_mode: 'separate', input_tokens: 799, output_tokens: 400 }), body, 'responses', { inputTokens: 800 }), /输入预算不足/)
  assert.throws(() => planTextRequest(settings({ budget_mode: 'separate', input_tokens: 1000, output_tokens: 399 }), body, 'responses', { inputTokens: 800 }), /生成预算超出能力/)
})

test('unknown budget relations enforce only independent confirmed bounds and remain partially validated', () => {
  const plan = planTextRequest(settings({ budget_mode: 'unknown', context_tokens: 100, input_tokens: 1000, output_tokens: 500 }), { input: 'x', max_output_tokens: 400 }, 'responses', { inputTokens: 800 })
  assert.equal(plan.capacity.capacity_status, 'partial')
  assert.equal(plan.capacity.budget_mode, 'unknown')
  assert.equal(planTextRequest({}, { input: 'x' }, 'responses').capacity.capacity_status, 'unknown')
  assert.throws(() => planTextRequest(settings({ budget_mode: 'unknown', input_tokens: 700 }), { input: 'x' }, 'responses', { inputTokens: 800 }), /输入预算不足/)
})

test('real outgoing output outranks fallback reserve and thinking is not counted twice', () => {
  const plan = planTextRequest({ ...settings({ budget_mode: 'shared', context_tokens: 100000, output_tokens: 65536, output_includes_reasoning: true }), output_reserve_tokens: 90000 },
    { input: 'x', max_output_tokens: 65536, reasoning: { effort: 'high' } }, 'responses', { inputTokens: 30000 })
  assert.equal(plan.capacity.reserved_output_tokens, 65536)
  assert.equal(plan.capacity.estimated_input_tokens, 30000)
  assert.equal(plan.capacity.capacity_status, 'validated')
  const largeLegacyReserve = { ...settings({ budget_mode: 'shared', context_tokens: 100000, output_tokens: 65536 }, { output_mode: 'fixed', max_output_tokens: 65536 }), output_reserve_tokens: 128000 }
  assert.equal(textApiConfigError(largeLegacyReserve, 'responses'), null)
  assert.equal(planTextRequest(largeLegacyReserve, { input: 'x', max_output_tokens: 65536 }, 'responses', { inputTokens: 1000 }).capacity.reserved_output_tokens, 65536)
  assert.equal(planTextRequest({ context_window_tokens: 100000, output_reserve_tokens: 128000 }, { input: 'x', max_output_tokens: 65536 }, 'responses', { inputTokens: 1000 }).capacity.reserved_output_tokens, 65536)
})

test('input counting includes messages, tools and schemas but excludes model and output controls', () => {
  const body = { model: 'id'.repeat(10000), input: '原稿', max_output_tokens: 99999, temperature: 1, reasoning: { effort: 'high' },
    text: { format: { type: 'json_schema', schema: { description: '完整结构'.repeat(100) } }, verbosity: 'high' }, tools: [{ name: 'read_source', description: '原文规则' }] }
  const baseline = planTextRequest({}, body, 'responses').capacity.estimated_input_tokens
  assert.equal(planTextRequest({}, { ...body, model: 'other', max_output_tokens: 1, temperature: 0 }, 'responses').capacity.estimated_input_tokens, baseline)
  assert.ok(planTextRequest({}, { input: '原稿' }, 'responses').capacity.estimated_input_tokens < baseline)
  assert.deepEqual(textRequestInput({ messages: [], output_config: { effort: 'high', format: { schema: { description: '规则' } } }, tool_choice: { type: 'tool', name: 'read_source' } }),
    { messages: [], output_config: { format: { schema: { description: '规则' } } }, tool_choice: { type: 'tool', name: 'read_source' } })
})

test('explicit output modes preserve legacy behavior and produce exact protocol output fields', () => {
  assert.equal(textOutputMode({ text_api: { mode: 'standard', max_output_tokens: 4000 } }), 'fixed')
  assert.equal(textOutputMode({ text_api: { mode: 'standard' } }), 'upstream')
  for (const [protocol, field] of [['responses', 'max_output_tokens'], ['chat_completions', 'max_tokens'], ['anthropic_messages', 'max_tokens']] as const) {
    const config = settings({ budget_mode: 'separate', input_tokens: 100000, output_tokens: 32768 }, { output_mode: 'auto', max_output_tokens: 100, chat_output_field: 'max_tokens' })
    assert.equal(textApiConfigError(config, protocol), null)
    const template = resolveTextApiSettings(config, protocol).request_template as Record<string, unknown>
    assert.equal(template[field], undefined, 'auto is resolved after final input is known')
    const plan = planTextRequest(config, { ...template, [protocol === 'responses' ? 'input' : 'messages']: '完整输入' }, protocol, { purpose: 'review', inputTokens: 100 })
    assert.equal(plan.body[field], 32768)
    assert.equal(plan.capacity.output_source, 'auto')
  }
  const upstream = settings({ budget_mode: 'shared', context_tokens: 1000 }, { output_mode: 'upstream', max_output_tokens: 500 })
  const plan = planTextRequest(upstream, { input: 'x', max_output_tokens: 500, max_tokens: 500 }, 'responses', { inputTokens: 100 })
  assert.deepEqual(plan.body, { input: 'x' })
  assert.equal(plan.capacity.capacity_status, 'partial')
  assert.equal(planTextRequest({ ...upstream, output_reserve_tokens: 100 }, { input: 'x' }, 'responses', { inputTokens: 100 }).capacity.capacity_status, 'partial', 'a fallback reserve does not confirm the upstream maximum')
  assert.match(textApiConfigError(upstream, 'anthropic_messages')!, /Anthropic/)
  assert.match(textApiConfigError({ text_api: { mode: 'standard', output_mode: 'fixed' } }, 'responses')!, /固定/)
  const fixed = settings({ budget_mode: 'unknown' }, { output_mode: 'fixed', max_output_tokens: 65536 })
  const fixedPlan = planTextRequest(fixed, { input: 'x', max_output_tokens: 8192, max_tokens: 1000 }, 'responses')
  assert.deepEqual(fixedPlan.body, { input: 'x', max_output_tokens: 65536 })
  assert.equal(fixedPlan.capacity.reserved_output_tokens, 65536)
  assert.equal(fixedPlan.capacity.output_source, 'fixed')
})

test('automatic output requires evidence or task allowance and refuses unusably small remaining budgets', () => {
  const auto = { text_api: { mode: 'standard', output_mode: 'auto' } }
  assert.throws(() => planTextRequest(auto, { input: 'x' }, 'responses'), /缺少配置/)
  assert.equal(planTextRequest(auto, { input: 'x' }, 'responses', { purpose: 'text' }).body.max_output_tokens, 8192)
  assert.equal(planTextRequest(auto, { input: 'x' }, 'responses', { purpose: 'repair' }).body.max_output_tokens, 65536)
  assert.equal(planTextRequest(auto, { input: 'x' }, 'responses', { outputTokens: 3000 }).body.max_output_tokens, 3000)
  const shared = settings({ budget_mode: 'shared', context_tokens: 70000, output_tokens: 65536 }, { output_mode: 'auto' })
  assert.equal(planTextRequest(shared, { input: 'x' }, 'responses', { purpose: 'generation', inputTokens: 10000 }).body.max_output_tokens, 59872)
  assert.throws(() => planTextRequest(shared, { input: 'x' }, 'responses', { purpose: 'generation', inputTokens: 69999 }), issue => {
    assert.ok(issue instanceof TextContextCapacityError)
    assert.equal(issue.estimate?.estimated_input_tokens, 69999)
    return /最低可用额度/.test(issue.message)
  })
  const fixed = settings({ budget_mode: 'shared', context_tokens: 70000, output_tokens: 65536 }, { output_mode: 'fixed', max_output_tokens: 65536 })
  assert.throws(() => planTextRequest(fixed, { input: 'x', max_output_tokens: 65536 }, 'responses', { inputTokens: 10000 }), /上下文预算不足/)
  const smallShared = settings({ budget_mode: 'shared', context_tokens: 10000 }, { output_mode: 'auto' })
  assert.throws(() => planTextRequest(smallShared, { input: 'x' }, 'responses', { purpose: 'generation', inputTokens: 3000, countMethod: 'estimate' }), issue => {
    assert.ok(issue instanceof TextContextCapacityError)
    assert.equal(issue.estimate?.reserved_output_tokens, 6872, 'failed allocation retains its attempted cap after framing reserve for near-boundary counting')
    return /最低可用额度/.test(issue.message)
  })
  const counted = planTextRequest(smallShared, { input: 'x' }, 'responses', { purpose: 'generation', inputTokens: 1000, countMethod: 'provider' })
  assert.equal(counted.body.max_output_tokens, 8872)
  assert.equal(counted.capacity.capacity_status, 'validated')
})

test('custom templates that render a scalar or array are rejected without rewriting their wire payload', () => {
  for (const value of ['custom scalar', 42, null, ['message'], undefined]) {
    assert.throws(() => planTextRequest({}, value, 'responses'), /请求模板必须生成 JSON 对象/)
  }
})

test('sanitized local estimates preserve the wire payload and full provider counts replace visual allowance', () => {
  const body = { input: 'base64'.repeat(10000), max_output_tokens: 100 }
  const local = planTextRequest({}, body, 'responses', { estimateBody: { input: '[pixels]' }, visualInputTokens: 1000, countMethod: 'estimated_fallback' })
  assert.equal(local.body.input, body.input)
  assert.equal(local.capacity.input_count_method, 'estimated_fallback')
  assert.ok(local.capacity.estimated_input_tokens > 1000 && local.capacity.estimated_input_tokens < 1100)
  const counted = planTextRequest({}, body, 'responses', { inputTokens: 400, countMethod: 'provider', visualInputTokens: 1000 })
  assert.equal(counted.capacity.estimated_input_tokens, 400)
})

test('native images in static templates and tool history reserve pixels once, independently of base64 length', () => {
  const staticImage = { type: 'image_url', image_url: { url: `data:image/png;base64,${'YQ=='.repeat(10000)}` } }
  const historyImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }
  const body = { messages: [{ role: 'user', content: [staticImage] }, { role: 'tool', content: [historyImage] }], max_tokens: 100 }
  const limits = settings({ budget_mode: 'shared', context_tokens: 20000 })
  const plan = planTextRequest(limits, body, 'chat_completions')
  assert.ok(plan.capacity.estimated_input_tokens >= 8192 && plan.capacity.estimated_input_tokens < 9000)
  assert.equal(plan.body.messages, body.messages, 'wire image bytes stay exact')
  assert.equal(planTextRequest(limits, body, 'chat_completions', { visualInputTokens: 8192 }).capacity.estimated_input_tokens, plan.capacity.estimated_input_tokens)
  const smallerBytes = { ...body, messages: [{ role: 'user', content: [{ ...staticImage, image_url: { url: 'data:image/png;base64,YQ==' } }] }, body.messages[1]] }
  assert.equal(planTextRequest(limits, smallerBytes, 'chat_completions').capacity.estimated_input_tokens, plan.capacity.estimated_input_tokens)
  assert.throws(() => planTextRequest(settings({ budget_mode: 'shared', context_tokens: 8000 }), body, 'chat_completions'), /上下文预算不足/)
  assert.equal(planTextRequest(limits, body, 'chat_completions', { inputTokens: 1200, countMethod: 'provider' }).capacity.estimated_input_tokens, 1200)
  const responses = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }], max_output_tokens: 100 }
  assert.ok(planTextRequest(limits, responses, 'responses').capacity.estimated_input_tokens >= 4096)
  const uploadedImage = { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file-remote-image' }] }], max_output_tokens: 100 }
  assert.ok(planTextRequest(limits, uploadedImage, 'responses').capacity.estimated_input_tokens >= 4096, 'file-backed native images use the same visual allowance')
  assert.equal(planTextRequest(limits, uploadedImage, 'responses', { inputTokens: 1000, countMethod: 'provider' }).capacity.estimated_input_tokens, 1000)
})

test('static video bytes are sanitized and unknown media or separate thinking costs stay partially checked', () => {
  const limits = settings({ budget_mode: 'shared', context_tokens: 20000, output_includes_reasoning: false })
  const body = { messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${'YWJjZA=='.repeat(10000)}` } }] }], max_tokens: 100 }
  const plan = planTextRequest(limits, body, 'chat_completions')
  assert.ok(plan.capacity.estimated_input_tokens < 500)
  assert.equal(plan.capacity.capacity_status, 'partial')
  assert.equal(plan.body.messages, body.messages)
  assert.equal(planTextRequest(limits, body, 'chat_completions', { inputTokens: 1000, countMethod: 'provider' }).capacity.capacity_status, 'validated')
  assert.equal(planTextRequest(limits, { input: 'x', max_output_tokens: 100, reasoning: { effort: 'high' } }, 'responses', { inputTokens: 100 }).capacity.capacity_status, 'partial')
  assert.equal(planTextRequest(limits, { input: 'x', max_output_tokens: 100, thinking: { type: 'adaptive' } }, 'responses', { inputTokens: 100 }).capacity.capacity_status, 'partial')
  assert.equal(planTextRequest(limits, { input: 'x', max_output_tokens: 100, reasoning: { effort: 'none' } }, 'responses', { inputTokens: 100 }).capacity.capacity_status, 'validated')
})

test('tool pressure uses shared output reservation while separate budgets preserve exact history', async t => {
  for (const mode of ['shared', 'separate'] as const) await t.test(mode, async t => {
    let requests = 0
    const provider = { adapter: 'http' as const, base_url: 'https://history-fixture.invalid/v1' }
    const model: GenerationModel = { id: 'pressure', remote_id: 'unknown-model', modality: 'text', protocol: 'responses', settings: {
      ...settings({ budget_mode: mode, context_tokens: 100000, input_tokens: 100000, output_tokens: 90000 }),
      tool_history_chars: 16000, request_path: 'responses', text_path: 'output_text',
      request_template: { model: '{{model}}', input: '{{prompt}}', max_output_tokens: 90000 },
    } }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      requests++
      if (requests === 4) {
        const history = JSON.stringify(body.input)
        assert.equal(history.includes('程序上下文检查点'), mode === 'shared')
        assert.equal(history.includes('早期精确正文'), mode === 'separate')
        assert.ok(history.includes('新鲜正文3'))
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] })
      }
      return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: `call-${requests}`, name: 'read_source', arguments: '{}' }] })
    })
    const session = textToolSession(model, provider, '完整原始要求', [{ name: 'read_source', description: '读取文稿', parameters: { type: 'object' } }], () => '')
    await session()
    await session([{ id: 'call-1', output: JSON.stringify({ ok: true, result: { id: 'doc', version: 'v1', content: '早期精确正文'.repeat(60) } }) }])
    await session([{ id: 'call-2', output: JSON.stringify({ ok: true, result: { id: 'doc', version: 'v2', content: '新鲜正文2'.repeat(60) } }) }])
    await session([{ id: 'call-3', output: JSON.stringify({ ok: true, result: { id: 'doc', version: 'v3', content: '新鲜正文3'.repeat(60) } }) }])
    assert.equal(requests, 4)
  })
})
