import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScriptRequestUsage, scriptRequestUsageTokens } from '@video-studio/shared/script/script-request-usage'
import { beginTextRequest, isTextRequestBudgetError, settlePendingTextRequest, TextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { retryReadOnlyRequest } from '../src/modules/generation/read-only-retry.js'
import { withTextResponseRecovery, backgroundTextResponse, type BackgroundResponse } from '../src/infrastructure/providers/text-background.js'
import type { GenerationModel, GenerationProvider } from '../src/infrastructure/providers/providers.js'

const model: GenerationModel = { id: 'usage-model', remote_id: 'fixture', modality: 'text', protocol: 'responses', settings: {
  request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, text_path: 'output_text',
} }
const provider: GenerationProvider = { adapter: 'http', base_url: 'https://fixture.invalid/v1' }
const contract = { name: 'script_test', schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
async function stream(prompt = 'private source', signal?: AbortSignal) {
  const { streamText } = await import('../src/infrastructure/providers/providers.js')
  return streamText(model, provider, { prompt, structured_output: undefined }, undefined, () => {}, signal)
}

test('actual usage replaces estimates and reasoning remains an output subset', () => {
  const usage = createScriptRequestUsage(), updates: number[] = []
  withTextRequestUsage({ usage, limits: { max_requests: 2, max_tokens: 100 }, onUpdate: value => updates.push(scriptRequestUsageTokens(value)) }, () => {
    const request = begin()
    assert.equal(usage.requests, 1)
    assert.equal(usage.uncertain_requests, 1)
    assert.equal(usage.estimated_input_tokens, 40)
    assert.equal(usage.estimated_output_tokens, 60)
    request.complete({ input_tokens: 20, output_tokens: 30, reasoning_tokens: 10 })
    request.complete({ input_tokens: 999, output_tokens: 999, reasoning_tokens: 999 })
  })
  assert.equal(usage.input_tokens, 20)
  assert.equal(usage.output_tokens, 30)
  assert.equal(usage.reasoning_tokens, 10)
  assert.equal(scriptRequestUsageTokens(usage), 50)
  assert.equal(usage.estimated_input_tokens, 0)
  assert.equal(usage.estimated_output_tokens, 0)
  assert.equal(usage.uncertain_requests, 0)
  assert.ok(updates.length >= 2)
})

test('nested execution and phase scopes both count requests, with detached progress snapshots', async () => {
  const execution = createScriptRequestUsage(), phase = createScriptRequestUsage()
  const updates: typeof execution[] = []
  await withTextRequestUsage({ usage: execution, onUpdate: usage => updates.push(usage) }, async () => {
    begin().complete({ input_tokens: 3, output_tokens: 2 })
    await withTextRequestUsage({ usage: phase }, async () => {
      await Promise.resolve()
      begin().complete({ input_tokens: 11, output_tokens: 7, reasoning_tokens: 4 })
    })
    begin().complete({ input_tokens: 5, output_tokens: 3 })
  })
  assert.equal(execution.requests, 3)
  assert.equal(execution.input_tokens, 19)
  assert.equal(execution.output_tokens, 12)
  assert.equal(execution.reasoning_tokens, 4)
  assert.equal(phase.requests, 1)
  assert.equal(phase.input_tokens, 11)
  assert.equal(updates[0]!.requests, 1)
  assert.equal(updates[0]!.input_tokens, 0)
  assert.notEqual(updates[0], execution)
  assert.notEqual(updates[0]!.pending_requests, execution.pending_requests)
})

test('all nested limits are checked before any scope consumes a reservation', () => {
  const execution = createScriptRequestUsage(), phase = createScriptRequestUsage()
  withTextRequestUsage({ usage: execution, limits: { max_requests: 1 } }, () => {
    withTextRequestUsage({ usage: phase, limits: { max_tokens: 99 } }, () => {
      assert.throws(() => begin(), error => isTextRequestBudgetError(error) && error.reason === 'tokens')
    })
    assert.equal(execution.requests, 0)
    assert.equal(phase.requests, 0)
    begin().complete({ input_tokens: 1, output_tokens: 1 })
    withTextRequestUsage({ usage: phase }, () => {
      assert.throws(() => begin(), error => isTextRequestBudgetError(error) && error.reason === 'requests')
    })
  })
  assert.equal(execution.requests, 1)
  assert.equal(phase.requests, 0)
})

test('re-entering one ledger charges once but enforces both scopes and notifies each callback once', () => {
  const usage = createScriptRequestUsage()
  let updates = 0
  const onUpdate = () => { updates++ }
  withTextRequestUsage({ usage, limits: { max_requests: 3 }, onUpdate }, () =>
    withTextRequestUsage({ usage, limits: { max_requests: 1 }, onUpdate }, () => {
      begin().complete({ input_tokens: 4, output_tokens: 6 })
      assert.throws(() => begin(), isTextRequestBudgetError)
    }))
  assert.equal(usage.requests, 1)
  assert.equal(usage.input_tokens, 4)
  assert.equal(usage.output_tokens, 6)
  assert.equal(updates, 2)
})

test('nested pending responses retain conservative estimates and settle once after serialized recovery', () => {
  let execution = createScriptRequestUsage(), phase = createScriptRequestUsage()
  withTextRequestUsage({ usage: execution }, () => withTextRequestUsage({ usage: phase }, () => {
    const request = begin()
    assert.equal(request.identify('resp_nested'), true)
    request.complete({ input_tokens: 12, reasoning_tokens: 80, response_chars: 100 })
  }))
  for (const usage of [execution, phase]) {
    assert.equal(usage.requests, 1)
    assert.equal(usage.input_tokens, 12)
    assert.equal(usage.estimated_input_tokens, 0)
    assert.equal(usage.estimated_output_tokens, 200)
    assert.equal(usage.reasoning_tokens, 80)
  }
  execution = JSON.parse(JSON.stringify(execution)) as typeof execution
  phase = JSON.parse(JSON.stringify(phase)) as typeof phase
  withTextRequestUsage({ usage: execution, limits: { max_requests: 1 } }, () =>
    withTextRequestUsage({ usage: phase, limits: { max_requests: 1 } }, () => {
      beginTextRequest({ kind: 'transport', request_bytes: 31, estimated_input_tokens: 0 }).complete({})
      assert.equal(settlePendingTextRequest('resp_nested', { input_tokens: 12, output_tokens: 105, reasoning_tokens: 90 }), true)
      assert.equal(settlePendingTextRequest('resp_nested', { input_tokens: 12, output_tokens: 105, reasoning_tokens: 90 }), false)
    }))
  for (const usage of [execution, phase]) {
    assert.equal(usage.requests, 1)
    assert.equal(usage.transport_requests, 1)
    assert.equal(usage.transport_request_bytes, 31)
    assert.equal(usage.input_tokens, 12)
    assert.equal(usage.output_tokens, 105)
    assert.equal(usage.reasoning_tokens, 90)
    assert.equal(usage.estimated_output_tokens, 0)
    assert.equal(usage.uncertain_requests, 0)
    assert.deepEqual(usage.pending_requests, [])
  }
})

test('a failed request stays conservatively estimated and restored scopes share cumulative state', () => {
  const usage = createScriptRequestUsage()
  withTextRequestUsage({ usage, limits: { max_requests: 2, max_tokens: 500 } }, () => begin().complete({ response_chars: 120 }))
  assert.equal(usage.requests, 1)
  assert.equal(usage.uncertain_requests, 1)
  assert.equal(usage.estimated_input_tokens, 40)
  assert.equal(usage.estimated_output_tokens, 240)
  const restored = JSON.parse(JSON.stringify(usage)) as typeof usage
  withTextRequestUsage({ usage: restored, limits: { max_requests: 2, max_tokens: 500 } }, () => begin().complete({ input_tokens: 10, output_tokens: 8 }))
  assert.equal(restored.requests, 2)
  assert.equal(restored.input_tokens, 10)
  assert.equal(restored.output_tokens, 8)
  assert.equal(restored.estimated_input_tokens, 40)
  assert.equal(restored.estimated_output_tokens, 240)
  assert.equal(restored.uncertain_requests, 1)
})

test('request and token limits reject dispatch before starting another HTTP request', () => {
  const usage = createScriptRequestUsage()
  withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 100 } }, () => {
    begin().complete({})
    assert.throws(() => begin(), error => isTextRequestBudgetError(error) && error.reason === 'requests')
  })
  const tokenLimited = createScriptRequestUsage()
  withTextRequestUsage({ usage: tokenLimited, limits: { max_requests: 3, max_tokens: 99 } }, () => {
    assert.throws(() => begin(), error => error instanceof TextRequestBudgetError && error.reason === 'tokens')
  })
  assert.equal(tokenLimited.requests, 0)
})

test('without an active task scope, provider calls do not create task accounting', async t => {
  let calls = 0
  const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ status: 'completed', output_text: 'ok', usage: { input_tokens: 2, output_tokens: 1 } }) })
  const { streamText } = await import('../src/infrastructure/providers/providers.js')
  assert.equal(await streamText(model, provider, { prompt: 'background' }), 'ok')
  assert.equal(calls, 1)
})

test('provider failure and network retry count each actual attempt, retaining uncertainty for the failed call', async t => {
  let calls = 0
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) return Response.json({ error: { message: 'busy' } }, { status: 503 })
    return Response.json({ status: 'completed', output_text: 'ok', usage: { input_tokens: 11, output_tokens: 7 } })
  })
  const usage = createScriptRequestUsage()
  const result = await withTextRequestUsage({ usage, limits: { max_requests: 2, max_tokens: 10_000 } }, () =>
    retryReadOnlyRequest(() => stream(), { wait: async () => {}, random: () => 0 }))
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.equal(usage.requests, 2)
  assert.equal(usage.uncertain_requests, 1)
  assert.equal(usage.input_tokens, 11)
  assert.equal(usage.output_tokens, 7)
  assert.ok(usage.estimated_input_tokens > 0)
})

test('abort after dispatch records one uncertain request with its conservative input estimate', async t => {
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    markStarted()
    return new Promise<Response>(() => {})
  })
  const usage = createScriptRequestUsage(), controller = new AbortController()
  const pending = withTextRequestUsage({ usage }, () => stream('abort this request', controller.signal))
  await started
  controller.abort(new DOMException('aborted', 'AbortError'))
  await assert.rejects(pending)
  assert.equal(usage.requests, 1)
  assert.equal(usage.uncertain_requests, 1)
  assert.ok(usage.estimated_input_tokens > 0)
})

test('structured output compatibility fallback charges each provider dispatch only once', async t => {
  let calls = 0
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) return Response.json({ error: { message: 'json_schema is not supported' } }, { status: 400 })
    return Response.json({ status: 'completed', output_text: 'ok', usage: { input_tokens: 5, output_tokens: 4, output_tokens_details: { reasoning_tokens: 3 } } })
  })
  const usage = createScriptRequestUsage()
  const { streamText } = await import('../src/infrastructure/providers/providers.js')
  const result = await withTextRequestUsage({ usage, limits: { max_requests: 2, max_tokens: 10_000 } }, () =>
    streamText(model, provider, { prompt: 'schema fallback', structured_output: contract }))
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.equal(usage.requests, 2)
  assert.equal(usage.input_tokens, 5)
  assert.equal(usage.output_tokens, 4)
  assert.equal(usage.reasoning_tokens, 3)
  assert.equal(usage.uncertain_requests, 1)
})

test('a request budget error on retry is not retried or format-corrected', async t => {
  let calls = 0
  const mock = t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'busy' } }, { status: 503 }) })
  const usage = createScriptRequestUsage()
  await assert.rejects(withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 10_000 } }, () =>
    retryReadOnlyRequest(() => stream(), { wait: async () => {}, random: () => 0 })), isTextRequestBudgetError)
  assert.equal(calls, 1)
  assert.equal(usage.requests, 1)
  assert.equal(usage.uncertain_requests, 1)
})

test('background generation counts the POST, excludes polling from token limits, and settles usage by response ID', async t => {
  let calls = 0
  const mock = t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    calls++
    if (init?.method === 'POST') return Response.json({ id: 'resp_usage_1', status: 'queued', usage: { input_tokens: 0, output_tokens: 0 } })
    if (calls === 2) return Response.json({ id: 'resp_usage_1', status: 'in_progress' })
    return Response.json({ id: 'resp_usage_1', status: 'completed', output_text: 'done',
      usage: { input_tokens: 21, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } })
  })
  const usage = createScriptRequestUsage()
  const saved = new Map<string, BackgroundResponse>()
  const result = await withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 100_000 } }, () =>
    withTextResponseRecovery({ read: key => saved.get(key), save: (key, value) => value ? saved.set(key, value) : void saved.delete(key) }, () =>
      backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: 'source', max_output_tokens: 100 },
        { 'Content-Type': 'application/json' }, new AbortController().signal, promise => promise, () => {})))
  assert.equal((await result.json() as { output_text: string }).output_text, 'done')
  assert.equal(calls, 3)
  assert.equal(usage.requests, 1)
  assert.equal(usage.transport_requests, 2)
  assert.ok(usage.transport_request_bytes > 0)
  assert.equal(usage.input_tokens, 21)
  assert.equal(usage.output_tokens, 9)
  assert.equal(usage.reasoning_tokens, 4)
  assert.equal(usage.estimated_input_tokens, 0)
  assert.equal(usage.estimated_output_tokens, 0)
  assert.equal(usage.pending_requests.length, 0)
  assert.equal(usage.uncertain_requests, 0)
})

test('nested provider background transport reconciles both execution and phase ledgers', async t => {
  const execution = createScriptRequestUsage(), phase = createScriptRequestUsage()
  let posts = 0, polls = 0
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return Response.json({ id: 'resp_nested_provider', status: 'queued' }) }
    polls++
    return Response.json({ id: 'resp_nested_provider', status: 'completed', output_text: 'done',
      usage: { input_tokens: 17, output_tokens: 13, output_tokens_details: { reasoning_tokens: 8 } } })
  })
  await withTextRequestUsage({ usage: execution, limits: { max_requests: 1 } }, () =>
    withTextRequestUsage({ usage: phase, limits: { max_requests: 1 } }, () =>
      withTextResponseRecovery({ read: () => undefined, save() {} }, () =>
        backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: 'source' }, {},
          new AbortController().signal, promise => promise, () => {}))))
  assert.equal(posts, 1)
  assert.equal(polls, 1)
  for (const usage of [execution, phase]) {
    assert.equal(usage.requests, 1)
    assert.equal(usage.transport_requests, 1)
    assert.equal(usage.input_tokens, 17)
    assert.equal(usage.output_tokens, 13)
    assert.equal(usage.reasoning_tokens, 8)
    assert.equal(usage.estimated_input_tokens, 0)
    assert.equal(usage.estimated_output_tokens, 0)
    assert.equal(usage.uncertain_requests, 0)
    assert.deepEqual(usage.pending_requests, [])
  }
})

test('a resumed background poll settles an existing estimate without consuming a generation request', async t => {
  const usage = createScriptRequestUsage()
  const responseId = 'resp_usage_resumed'
  withTextRequestUsage({ usage }, () => beginTextRequest({ request_bytes: 80, estimated_input_tokens: 40, reserved_output_tokens: 60 })
    .identify(responseId))
  assert.equal(usage.requests, 1)
  assert.equal(usage.pending_requests.length, 1)
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: responseId, status: 'completed',
    usage: { input_tokens: 24, output_tokens: 13, output_tokens_details: { reasoning_tokens: 5 } } }))
  const saved = new Map<string, BackgroundResponse>()
  const result = await withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 500 } }, () =>
    withTextResponseRecovery({ read: () => ({ state: 'accepted', id: responseId }), save: (key, value) => value ? saved.set(key, value) : void saved.delete(key) }, () =>
      backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: 'source' }, {},
        new AbortController().signal, promise => promise, () => {})))
  await result.json()
  assert.equal(mock.mock.callCount(), 1)
  assert.equal(usage.requests, 1)
  assert.equal(usage.transport_requests, 1)
  assert.equal(usage.input_tokens, 24)
  assert.equal(usage.output_tokens, 13)
  assert.equal(usage.reasoning_tokens, 5)
  assert.equal(usage.estimated_input_tokens, 0)
  assert.equal(usage.estimated_output_tokens, 0)
  assert.equal(usage.uncertain_requests, 0)
})

test('background cancellation tracks transport only and leaves uncertain generation estimate intact', async t => {
  let markPoll!: () => void
  const polling = new Promise<void>(resolve => { markPoll = resolve })
  const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') return Response.json({ id: 'resp_usage_cancel', status: 'queued' })
    if (url.endsWith('/cancel')) return Response.json({ id: 'resp_usage_cancel', status: 'cancelled' })
    markPoll()
    return new Promise<Response>(() => {})
  })
  const usage = createScriptRequestUsage(), controller = new AbortController()
  const saved = new Map<string, BackgroundResponse>()
  const pending = withTextRequestUsage({ usage, limits: { max_requests: 1, max_tokens: 100_000 } }, () =>
    withTextResponseRecovery({ read: key => saved.get(key), save: (key, value) => value ? saved.set(key, value) : void saved.delete(key) }, () =>
      backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: 'source', max_output_tokens: 100 },
        { 'Content-Type': 'application/json' }, controller.signal,
        promise => Promise.race([promise, new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))]), () => {})))
  await polling
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await assert.rejects(pending)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(mock.mock.callCount(), 3)
  assert.equal(usage.requests, 1)
  assert.equal(usage.transport_requests, 2)
  assert.equal(usage.uncertain_requests, 1)
  assert.ok(usage.estimated_input_tokens > 0)
  assert.ok(usage.estimated_output_tokens > 0)
})

test('simultaneous task scopes remain isolated and a pending reservation survives serialized restart', async () => {
  const first = createScriptRequestUsage(), second = createScriptRequestUsage()
  await Promise.all([
    withTextRequestUsage({ usage: first }, async () => { await Promise.resolve(); begin().complete({ input_tokens: 5, output_tokens: 7 }) }),
    withTextRequestUsage({ usage: second }, async () => { await Promise.resolve(); begin().complete({ input_tokens: 11, output_tokens: 13 }) }),
  ])
  assert.equal(first.requests, 1)
  assert.equal(first.input_tokens, 5)
  assert.equal(second.requests, 1)
  assert.equal(second.input_tokens, 11)
  withTextRequestUsage({ usage: first }, () => begin().identify('resp_after_crash'))
  const restored = JSON.parse(JSON.stringify(first)) as typeof first
  withTextRequestUsage({ usage: restored, limits: { max_requests: 2 } }, () => {
    assert.throws(() => begin(), isTextRequestBudgetError)
  })
  assert.equal(restored.pending_requests.length, 1)
  assert.equal(restored.estimated_input_tokens, 40)
})

test('malformed restored pending counters cannot bypass budget checks', () => {
  const usage = createScriptRequestUsage()
  usage.pending_requests = [{ id: 'resp_bad', request_bytes: 1, estimated_input_tokens: 10, estimated_output_tokens: 10,
    input_settled: false, output_settled: false, reasoning_tokens: 0 }]
  assert.throws(() => withTextRequestUsage({ usage }, () => {}), /不一致/)
  usage.pending_requests = []
  usage.requests = Number.NaN
  assert.throws(() => withTextRequestUsage({ usage }, () => {}), /检查点无效/)
})

test('more than 128 sequential pending responses retain identifiers and settle after checkpoint restoration', () => {
  const usage = createScriptRequestUsage()
  withTextRequestUsage({ usage }, () => {
    for (let index = 0; index < 160; index++) {
      const request = begin()
      assert.equal(request.identify(`resp_long_task_${index}`), true)
      request.complete({})
    }
  })
  assert.equal(usage.pending_requests.length, 160)
  assert.equal(usage.uncertain_requests, 160)
  const restored = JSON.parse(JSON.stringify(usage)) as typeof usage
  withTextRequestUsage({ usage: restored }, () => {
    for (let index = 0; index < 160; index++) assert.equal(settlePendingTextRequest(`resp_long_task_${index}`, {
      input_tokens: 3, output_tokens: 2, reasoning_tokens: 1,
    }), true)
    begin().complete({ input_tokens: 5, output_tokens: 7 })
  })
  assert.equal(restored.requests, 161)
  assert.equal(restored.input_tokens, 485)
  assert.equal(restored.output_tokens, 327)
  assert.equal(restored.reasoning_tokens, 160)
  assert.equal(restored.uncertain_requests, 0)
  assert.equal(restored.estimated_input_tokens, 0)
  assert.equal(restored.estimated_output_tokens, 0)
  assert.deepEqual(restored.pending_requests, [])
})

test('tool HTTP requests and explicit Chat usage footers contribute actual usage exactly once', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    const events = [
      { choices: [{ delta: { content: 'done' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 } } },
    ]
    return new Response(events.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const configured: GenerationModel = { ...model, protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], stream_options: { include_usage: true } },
    text_path: 'choices.0.message.content',
  } }
  const { streamText, createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
  const usage = createScriptRequestUsage()
  await withTextRequestUsage({ usage }, async () => {
    assert.equal(await streamText(configured, provider, { prompt: 'footer' }), 'done')
    const result = await createTextToolTransport(configured, provider, 'tool footer', [], undefined, [], () => '')
    assert.equal(result.text, 'done')
  })
  assert.equal(calls, 2)
  assert.equal(usage.requests, 2)
  assert.equal(usage.input_tokens, 24)
  assert.equal(usage.output_tokens, 14)
  assert.equal(usage.reasoning_tokens, 6)
  assert.equal(usage.uncertain_requests, 0)
  assert.equal(usage.estimated_input_tokens, 0)
})

test('a pre-aborted request never consumes generation budget or dispatches HTTP', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ output_text: 'unexpected' }))
  const usage = createScriptRequestUsage(), controller = new AbortController()
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await assert.rejects(withTextRequestUsage({ usage }, () => stream('aborted', controller.signal)))
  assert.equal(mock.mock.callCount(), 0)
  assert.equal(usage.requests, 0)
})

test('failed provider responses retain returned usage instead of estimates when billing usage is available', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'failed after generation' },
    usage: { input_tokens: 13, output_tokens: 17, output_tokens_details: { reasoning_tokens: 6 } } }, { status: 500 }))
  const usage = createScriptRequestUsage()
  await assert.rejects(withTextRequestUsage({ usage }, () => stream()))
  assert.equal(usage.requests, 1)
  assert.equal(usage.input_tokens, 13)
  assert.equal(usage.output_tokens, 17)
  assert.equal(usage.reasoning_tokens, 6)
  assert.equal(usage.uncertain_requests, 0)
  assert.equal(usage.estimated_input_tokens, 0)
  assert.equal(usage.estimated_output_tokens, 0)
})

function begin() {
  return beginTextRequest({ request_bytes: 120, estimated_input_tokens: 40, reserved_output_tokens: 60 })
}

test('combined dispatch limit includes transport and rejects every nested reservation atomically', () => {
  const outer = createScriptRequestUsage(), inner = createScriptRequestUsage()
  withTextRequestUsage({ usage: outer, limits: { max_total_requests: 1 } }, () => {
    beginTextRequest({ kind: 'transport', request_bytes: 15, estimated_input_tokens: 0 }).complete({})
    withTextRequestUsage({ usage: inner }, () => {
      assert.throws(() => beginTextRequest({ kind: 'transport', request_bytes: 15, estimated_input_tokens: 0 }), isTextRequestBudgetError)
      assert.throws(() => begin(), isTextRequestBudgetError)
    })
  })
  assert.equal(outer.transport_requests, 1); assert.equal(outer.requests, 0)
  assert.equal(inner.transport_requests, 0); assert.equal(inner.requests, 0)
})

test('only explicit provider cancellation may dispatch after scope abort and it still consumes the combined cap', async t => {
  const { cancelBackgroundTextResponses } = await import('../src/infrastructure/providers/text-background.js')
  const usage = createScriptRequestUsage(), controller = new AbortController()
  let dispatches = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://fixture.invalid/responses/resp_cancel_test/cancel')
    assert.equal(init?.method, 'POST'); assert.equal(init?.signal?.aborted, false)
    dispatches++
    return Response.json({ status: 'cancelled' })
  })
  await withTextRequestUsage({ usage, limits: { max_requests: 1, max_total_requests: 2 }, signal: controller.signal }, async () => {
    begin().complete({})
    const reason = new DOMException('creator stopped work', 'AbortError')
    controller.abort(reason)
    assert.throws(() => begin(), issue => issue === reason)
    assert.throws(() => beginTextRequest({ kind: 'transport', request_bytes: 12, estimated_input_tokens: 0 }), issue => issue === reason)
    await cancelBackgroundTextResponses('https://fixture.invalid/responses', 'resp_cancel_test', {})
    await assert.rejects(cancelBackgroundTextResponses('https://fixture.invalid/responses', 'resp_cancel_test', {}), isTextRequestBudgetError)
  })
  assert.equal(dispatches, 1); assert.equal(usage.requests, 1); assert.equal(usage.transport_requests, 1)
  assert.equal(usage.uncertain_requests, 1, 'cancellation never erases the unresolved generation cost')
})
