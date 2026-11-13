import { createScriptRequestUsage, scriptRequestUsageTokens, withTextRequestUsage, isTextRequestBudgetError } from '../src/infrastructure/providers/text-request-usage.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeProviderFetch } from '../src/infrastructure/providers/text-request-plan.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { textApiConfigError, resolveTextApiSettings } from '@video-studio/shared/models/text-api-settings'
const encoder = new TextEncoder()
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('auxiliary metrics settle on body EOF and retain identity and Response semantics', async () => {
  const dispatched: any[] = [], metrics: any[] = []
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined
  const response = await withModelRequestContext({ policy: modelTaskPolicies.paid, taskId: 't', onDispatch: value => dispatched.push(value), onMetrics: value => metrics.push(value) }, () =>
    observeProviderFetch('https://aux.invalid/generate?key=hidden', { method: 'POST', body: '{}' }, 'media_create', async () =>
      new Response(new ReadableStream({ start(controller) { writer = controller } }), { status: 201, headers: { 'x-request-id': 'actual-id' } }),
      { model_id: 'local-model', remote_id: 'wire-model' }))
  assert.equal(response.status, 201); assert.equal(dispatched.length, 1); assert.equal(metrics.length, 0)
  const content = response.text()
  writer!.enqueue(encoder.encode('body')); await flush(); assert.equal(metrics.length, 0)
  writer!.close(); assert.equal(await content, 'body')
  assert.equal(metrics.length, 1); assert.equal(metrics[0].delivery, 'completed')
  assert.equal(metrics[0].model_id, 'local-model'); assert.equal(metrics[0].remote_id, 'wire-model')
  assert.equal(metrics[0].request_id, dispatched[0].request_id); assert.equal(metrics[0].upstream_request_id, 'actual-id')
  assert.equal(metrics[0].endpoint, 'https://aux.invalid/generate')
})

test('a body disconnection replaces header acceptance with a single failure settlement', async () => {
  const metrics: any[] = []
  const reason = new TypeError('terminated')
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined
  const response = await withModelRequestContext({ policy: modelTaskPolicies.paid, onMetrics: value => metrics.push(value) }, () =>
    observeProviderFetch('https://aux.invalid/result', {}, 'media_download', async () => new Response(new ReadableStream({ start(controller) { writer = controller } }))))
  const content = response.text(), rejected = assert.rejects(content, issue => issue === reason)
  writer!.enqueue(encoder.encode('partial')); await flush(); writer!.error(reason)
  await rejected; assert.equal(metrics.length, 1); assert.equal(metrics[0].failure_reason, 'disconnected')
  assert.equal(metrics[0].raw_reason, 'stream_disconnected')
})

test('caller cancellation reaches the actual body and never turns a partial transfer into success', async () => {
  const controller = new AbortController(), reason = new Error('user stopped download'), metrics: any[] = []
  let cancelled = false
  const response = await withModelRequestContext({ policy: modelTaskPolicies.paid, onMetrics: value => metrics.push(value) }, () =>
    observeProviderFetch('https://aux.invalid/result', { signal: controller.signal }, 'media_download', async () => new Response(new ReadableStream({
      start(writer) { writer.enqueue(encoder.encode('partial')) }, cancel() { cancelled = true },
    }))))
  const content = response.text(), rejected = assert.rejects(content, issue => issue === reason)
  await flush(); controller.abort(reason); await rejected
  assert.equal(cancelled, true); assert.equal(metrics.length, 1); assert.equal(metrics[0].failure_reason, 'cancelled')
})

test('explicit body cancellation settles once and preserves accepted delivery without guessing token use', async () => {
  const metrics: any[] = [], controller = new AbortController()
  let cancelled = false
  const response = await withModelRequestContext({ policy: modelTaskPolicies.paid, onMetrics: value => metrics.push(value) }, () =>
    observeProviderFetch('https://aux.invalid/tts', { signal: controller.signal }, 'speech_create', async () => new Response(new ReadableStream({ cancel() { cancelled = true } }))))
  await response.body!.cancel(); controller.abort()
  assert.equal(cancelled, true); assert.equal(metrics.length, 1)
  assert.equal(metrics[0].delivery, 'accepted'); assert.equal(metrics[0].failure_reason, undefined)
  assert.equal(metrics[0].raw_reason, 'body_cancelled'); assert.equal(metrics[0].input_tokens, undefined)
})

test('confirmed reasoning modes and effort values constrain legacy and explicit settings', () => {
  const base = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192, reasoning_effort: 'high' },
    text_capabilities: { version: 1, override: { compatibility: { reasoning: { mode: 'fixed', minimum_budget_tokens: 1024 } } } } }
  assert.match(textApiConfigError(base, 'anthropic_messages')!, /显式推理模式/)
  const low = { ...base, text_capabilities: { version: 1, override: { compatibility: { reasoning: { mode: 'effort', effort_values: ['low'] } } } } }
  assert.match(textApiConfigError(low, 'responses')!, /支持值/)
  const explicit = { ...low, text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192,
    reasoning: { enabled: true, mode: 'effort', default_level: 'high', levels: [{ level: 'high', api_value: 'high' }] } } }
  assert.match(textApiConfigError(explicit, 'responses')!, /支持值/)
  const native = { ...explicit, text_api: { ...explicit.text_api, reasoning: { ...explicit.text_api.reasoning, levels: [{ level: 'high', api_value: 'low' }] } } }
  assert.deepEqual((resolveTextApiSettings(native, 'anthropic_messages').request_template as any).output_config, { effort: 'low' })
  assert.equal((resolveTextApiSettings(native, 'anthropic_messages').request_template as any).thinking, undefined)
})


test('body settlement stays with the original request when another task reads its response', async () => {
  const original: any[] = [], other: any[] = []
  const response = await withModelRequestContext({ policy: modelTaskPolicies.paid, taskId: 'original', onMetrics: value => original.push(value) }, () =>
    observeProviderFetch('https://aux.invalid/body', {}, 'media_download', async () => new Response('result')))
  assert.equal(await withModelRequestContext({ policy: modelTaskPolicies.paid, taskId: 'other', onMetrics: value => other.push(value) }, () => response.text()), 'result')
  assert.equal(original.length, 1); assert.equal(original[0].task_id, 'original'); assert.equal(other.length, 0)
})

test('omitting an explicit mode cannot bypass confirmed reasoning modes', () => {
  const settings = { text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192,
    reasoning: { enabled: true, default_level: 'high', levels: [{ level: 'high', api_value: 'low' }] } },
    text_capabilities: { version: 1, override: { compatibility: { reasoning: { mode: 'effort', effort_values: ['low'] } } } } }
  assert.match(textApiConfigError(settings, 'anthropic_messages')!, /推理模式/)
  assert.equal(textApiConfigError(settings, 'responses'), null)
  const legacy = { ...settings, text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192, reasoning_effort: 'low' },
    text_capabilities: { version: 1, override: { compatibility: { reasoning: { mode: 'adaptive', effort_values: ['low'] } } } } }
  assert.match(textApiConfigError(legacy, 'responses')!, /显式推理模式/)
  assert.equal(textApiConfigError(legacy, 'anthropic_messages'), null)
})


test('auxiliary dispatch admission shares nested budgets without inventing media tokens', async () => {
  const usage = createScriptRequestUsage(), inner = createScriptRequestUsage(), seen: any[] = []
  let calls = 0
  await withTextRequestUsage({ usage, limits: { max_requests: 1, max_total_requests: 2, max_tokens: 1 } }, () =>
    withTextRequestUsage({ usage: inner, limits: { max_requests: 2 } }, () =>
      withModelRequestContext({ policy: modelTaskPolicies.paid, onDispatch: value => seen.push(value) }, async () => {
        const fake: typeof fetch = async () => { calls++; return new Response('done') }
        await (await observeProviderFetch('https://aux.invalid/create', { method: 'POST', body: '123' }, 'media_create', fake)).text()
        await (await observeProviderFetch('https://aux.invalid/count', { method: 'POST', body: '12' }, 'input_count', fake)).text()
        await assert.rejects(observeProviderFetch('https://aux.invalid/poll', {}, 'media_poll', fake), isTextRequestBudgetError)
        assert.equal(calls, 2)
      })))
  assert.equal(usage.requests, 1); assert.equal(inner.requests, 1)
  assert.equal(usage.transport_requests, 1); assert.equal(inner.transport_requests, 1)
  assert.equal(scriptRequestUsageTokens(usage), 0); assert.equal(usage.uncertain_requests, 0)
  assert.deepEqual(usage.pending_requests, [])
  assert.deepEqual(seen.map(item => [item.kind, item.usage_admitted]), [['generation', true], ['transport', true]])
})

test('a request-cap rejection precedes paid dispatch ownership and wire access', async () => {
  const usage = createScriptRequestUsage(); usage.requests = 1
  let ownership = 0, calls = 0
  await withTextRequestUsage({ usage, limits: { max_requests: 1 } }, () =>
    assert.rejects(observeProviderFetch('https://aux.invalid/create', { method: 'POST' }, 'speech_create', async () => {
      calls++; return new Response('done')
    }, {}, () => { ownership++ }), isTextRequestBudgetError))
  assert.equal(ownership, 0); assert.equal(calls, 0); assert.equal(usage.requests, 1)
})
