import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { streamText, createTextToolTransport, type GenerationModel, type GenerationProvider, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import { supportsScriptReviewPolicy } from '../src/infrastructure/providers/text-script-review-policy.js'
import { estimateTextRequestTokens, textRequestInput } from '../src/infrastructure/providers/text-context.js'
import { createScriptRequestUsage, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { withTextResponseRecovery, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'

type Protocol = 'responses' | 'chat_completions'
const provider: GenerationProvider = { adapter: 'http', base_url: 'https://api.deepseek.com' }
const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }
const contract = (policy: OutputContract['request_policy'] = 'script_review'): OutputContract => ({ name: 'script_test_review', schema, request_policy: policy })
function model(protocol: Protocol = 'responses', body: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, remoteId = 'deepseek-flash'): GenerationModel {
  return { id: 'script-review-policy-test', remote_id: remoteId, modality: 'text', protocol, settings: {
    request_path: protocol === 'responses' ? 'responses' : 'chat/completions', structured_output_mode: 'json_schema',
    text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content',
    request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }), ...body },
    ...settings,
  } }
}
function capture(t: TestContext, protocol: Protocol, inspect: (body: Record<string, any>, url: string, init: RequestInit) => void = () => {}) {
  const requests: Record<string, any>[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests.push(body); inspect(body, String(url), init)
    return Response.json(protocol === 'responses'
      ? { id: 'resp_policy', status: 'completed', output_text: '{"result":"reviewed"}',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"result":"reviewed"}' }] }], usage: { input_tokens: 7, output_tokens: 4 } }
      : { choices: [{ message: { content: '{"result":"reviewed"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } })
  })
  return requests
}

for (const protocol of ['responses', 'chat_completions'] as const) {
  for (const remoteId of ['deepseek-flash', 'deepseek-v4-pro']) test(`${protocol} ${remoteId}: semantic review preserves configured parameters and provider defaults`, async t => {
    const requests = capture(t, protocol)
    const configured = model(protocol, { stream: false, temperature: 0.3, ...(protocol === 'responses' ? { reasoning: { summary: 'auto' }, text: { verbosity: 'low' } } : {}) }, {}, remoteId)
    const before = structuredClone(configured)
    assert.equal(supportsScriptReviewPolicy(configured, provider), true)
    const output = await streamText(configured, provider, { prompt: '保留完整原文与全部任务', structured_output: contract() })
    assert.equal(output, '{"result":"reviewed"}')
    assert.equal(requests.length, 1)
    const body = requests[0]!
    assert.equal(body.model, remoteId); assert.equal(body.stream, false); assert.equal(body.temperature, 0.3)
    assert.equal(protocol === 'responses' ? body.input : body.messages[0].content, '保留完整原文与全部任务')
    assert.equal(protocol === 'responses' ? body.max_output_tokens : body.max_tokens, undefined)
    assert.equal(protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort, undefined)
    assert.deepEqual(protocol === 'responses' ? body.text.format.schema : body.response_format.json_schema.schema, schema)
    if (protocol === 'responses') { assert.equal(body.reasoning.summary, 'auto'); assert.equal(body.text.verbosity, 'low') }
    assert.ok(!JSON.stringify(body).includes('request_policy'))
    assert.deepEqual(configured, before)
  })

  test(`${protocol}: ordinary review retains explicit reasoning and every configured output allowance`, async t => {
    const requests = capture(t, protocol)
    for (const cap of [8192, 65_536]) await streamText(model(protocol, protocol === 'responses'
      ? { reasoning: { effort: 'high', summary: 'auto' }, max_output_tokens: cap }
      : { reasoning_effort: 'high', max_tokens: cap }), provider, { prompt: '复核', structured_output: contract() })
    assert.deepEqual(requests.map(body => protocol === 'responses' ? body.max_output_tokens : body.max_tokens), [8192, 65_536])
    assert.ok(requests.every(body => (protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort) === 'high'))
  })

  for (const policy of ['script_review_answer', 'script_evidence'] as const) test(`${protocol}: ${policy} disables reasoning explicitly and preserves the complete output allowance`, async t => {
    const requests = capture(t, protocol)
    for (const cap of [4096, 65_536]) await streamText(model(protocol, protocol === 'responses'
      ? { reasoning: { effort: 'high', summary: 'auto' }, max_output_tokens: cap }
      : { reasoning_effort: 'high', max_completion_tokens: cap }), provider, { prompt: '提交结论', structured_output: contract(policy) })
    assert.deepEqual(requests.map(body => protocol === 'responses' ? body.max_output_tokens : body.max_completion_tokens), [4096, 65_536])
    assert.ok(requests.every(body => (protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort) === 'none'))
    if (protocol === 'responses') assert.ok(requests.every(body => body.reasoning.summary === 'auto'))
    else assert.ok(requests.every(body => !Object.hasOwn(body, 'max_tokens')), 'do not add a conflicting cap alias')
  })

  test(`${protocol}: answer and evidence recovery leave unspecified output allowance at the provider default`, async t => {
    const requests = capture(t, protocol)
    for (const policy of ['script_review_answer', 'script_evidence'] as const) {
      await streamText(model(protocol), provider, { prompt: '恢复未完成核对', structured_output: contract(policy) })
    }
    assert.ok(requests.every(body => !Object.hasOwn(body, 'max_output_tokens') && !Object.hasOwn(body, 'max_completion_tokens') && !Object.hasOwn(body, 'max_tokens')))
    assert.ok(requests.every(body => (protocol === 'responses' ? body.reasoning.effort : body.reasoning_effort) === 'none'))
  })

  test(`${protocol}: capacity, pre-dispatch usage reservation and final metrics use the model's configured allowance`, async t => {
    const usage = createScriptRequestUsage()
    let metrics: TextRequestMetrics | undefined
    const requests = capture(t, protocol, (body, _url, init) => {
      assert.equal(usage.requests, 1); assert.equal(usage.estimated_output_tokens, 65_536)
      assert.equal(usage.estimated_input_tokens, estimateTextRequestTokens(textRequestInput(body)))
      assert.equal(usage.request_bytes, Buffer.byteLength(String(init.body)))
    })
    await withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 70_000 } }, () =>
      streamText(model(protocol, protocol === 'responses' ? { max_output_tokens: 65_536 } : { max_tokens: 65_536 },
        { context_window_tokens: 75_000, output_reserve_tokens: 100 }), provider,
        { prompt: '完整复核', structured_output: contract() }, undefined, undefined, undefined, value => { metrics = value }))
    assert.equal(metrics?.output_limit, 65_536); assert.equal(metrics?.reserved_output_tokens, 65_536)
    assert.equal(metrics?.estimated_input_tokens, estimateTextRequestTokens(textRequestInput(requests[0])))
    assert.equal(metrics?.request_bytes, Buffer.byteLength(JSON.stringify(requests[0])))
    assert.equal(usage.input_tokens, 7); assert.equal(usage.output_tokens, 4); assert.equal(usage.estimated_output_tokens, 0)
  })
}

test('only exact official models, HTTPS host and known protocol endpoint paths receive the policy', async t => {
  const fixtures = [
    { base_url: 'http://api.deepseek.com' }, { base_url: 'https://api.deepseek.com.evil.invalid' },
    { base_url: 'https://gateway.invalid/api.deepseek.com' }, { base_url: 'https://api.deepseek.com:8443' },
    { path: 'custom/responses' }, { path: 'v2/responses' }, { path: 'chat/completions' },
    { remoteId: 'deepseek-chat' }, { remoteId: 'deepseek-flash-latest' }, { remoteId: 'DeepSeek-flash' },
    { api_base_url: 'https://gateway.invalid' }, { api_base_url: 'https://api.deepseek.com.evil.invalid' },
  ]
  for (const [index, fixture] of fixtures.entries()) await t.test(`unrecognized destination or model ${index + 1}`, async t => {
    const requests = capture(t, 'responses')
    const configured = model('responses', {}, { ...(fixture.path ? { request_path: fixture.path } : {}),
      ...(fixture.api_base_url ? { api_base_url: fixture.api_base_url } : {}) }, fixture.remoteId)
    const target = { ...provider, ...(fixture.base_url ? { base_url: fixture.base_url } : {}) }
    assert.equal(supportsScriptReviewPolicy(configured, target), false)
    await streamText(configured, target, { prompt: '复核', structured_output: contract() })
    assert.equal(requests[0]!.reasoning, undefined); assert.equal(requests[0]!.max_output_tokens, undefined)
  })
})

test('capability detection and actual requests use model URL overrides and optional v1 consistently', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async t => {
    const requests = capture(t, protocol, (_body, url) => { assert.equal(url, `https://api.deepseek.com/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`) })
    const configured = model(protocol, {}, { api_base_url: 'https://api.deepseek.com/v1' })
    const gateway = { ...provider, base_url: 'https://gateway.invalid' }
    assert.equal(supportsScriptReviewPolicy(configured, gateway), true)
    await streamText(configured, gateway, { prompt: '复核', structured_output: contract() })
    assert.equal(protocol === 'responses' ? requests[0]!.reasoning?.effort : requests[0]!.reasoning_effort, undefined)
  })
})

test('ordinary requests and unmarked script contracts retain configured reasoning and output defaults', async t => {
  const requests = capture(t, 'responses')
  const configured = model('responses', { reasoning: { effort: 'high' }, max_output_tokens: 65_536 })
  await streamText(configured, provider, { prompt: '创作' })
  const unmarked = contract(); delete unmarked.request_policy
  await streamText(configured, provider, { prompt: '复核', structured_output: unmarked })
  assert.ok(requests.every(body => body.reasoning.effort === 'high' && body.max_output_tokens === 65_536))
  assert.equal(supportsScriptReviewPolicy({ ...configured, protocol: undefined }, provider), false)
  assert.equal(supportsScriptReviewPolicy({ ...configured, settings: '{invalid' }, provider), false)
})

test('the full configured output allowance still rejects insufficient context capacity before a charge or fetch', async t => {
  let fetched = 0
  t.mock.method(globalThis, 'fetch', async () => { fetched++; throw new Error('must not send oversized review') })
  const usage = createScriptRequestUsage()
  await assert.rejects(withTextRequestUsage({ usage }, () => streamText(model('responses', { max_output_tokens: 65_536 },
    { context_window_tokens: 33_000, output_reserve_tokens: 100 }), provider,
  { prompt: '字'.repeat(1000), structured_output: contract() })), /上下文预算不足/)
  assert.equal(fetched, 0); assert.equal(usage.requests, 0)
})

test('background answer recovery sends and reserves the full configured allowance before dispatch', async t => {
  const usage = createScriptRequestUsage(), saved = new Map<string, BackgroundResponse>()
  let metrics: TextRequestMetrics | undefined
  const requests = capture(t, 'responses', (body, _url, init) => {
    assert.equal(body.stream, false); assert.equal(body.background, true)
    assert.equal(body.reasoning.effort, 'none'); assert.equal(body.max_output_tokens, 65_536)
    assert.equal(usage.requests, 1); assert.equal(usage.estimated_output_tokens, 65_536)
    assert.equal(usage.estimated_input_tokens, estimateTextRequestTokens(textRequestInput(body)))
    assert.equal(usage.request_bytes, Buffer.byteLength(String(init.body)))
  })
  await withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 70_000 } }, () =>
    withTextResponseRecovery({ read: key => saved.get(key), save: (key, value) => { if (value) saved.set(key, value); else saved.delete(key) } }, () =>
      streamText(model('responses', { stream: true, reasoning: { effort: 'high' }, max_output_tokens: 65_536 }, { background_responses: true }), provider,
        { prompt: '复核结论', structured_output: contract('script_review_answer') }, undefined, undefined, undefined, value => { metrics = value })))
  assert.equal(requests.length, 1); assert.equal(metrics?.output_limit, 65_536); assert.equal(metrics?.reserved_output_tokens, 65_536)
  assert.equal(metrics?.request_bytes, Buffer.byteLength(JSON.stringify(requests[0])))
  assert.equal(usage.input_tokens, 7); assert.equal(usage.output_tokens, 4)
})

test('policy preserves actual multipart image inputs and structured format', async t => {
  const requests = capture(t, 'responses')
  const image = 'data:image/jpeg;base64,' + Buffer.from('pixels').toString('base64')
  await streamText(model('responses', {}, { supports_vision: true }), provider,
    { prompt: '复核图文', images: [{ data_url: image, detail: 'high' }], structured_output: contract() })
  assert.deepEqual(requests[0]!.input[0].content, [{ type: 'input_text', text: '复核图文' }, { type: 'input_image', image_url: image, detail: 'high' }])
  assert.deepEqual(requests[0]!.text.format.schema, schema)
})

test('native tool transport retains its configured reasoning and output allowance', async t => {
  const requests = capture(t, 'responses')
  const output = await createTextToolTransport(model('responses', { reasoning: { effort: 'high' }, max_output_tokens: 65_536 }), provider,
    '工具任务', [], undefined, [], () => '')
  assert.equal(output.text, '{"result":"reviewed"}')
  assert.equal(requests[0]!.reasoning.effort, 'high'); assert.equal(requests[0]!.max_output_tokens, 65_536)
})
