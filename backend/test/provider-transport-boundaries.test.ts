import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createStreamScope, StreamWaitTimeoutError, textReasoningIdleTimeoutMs, textRequestTimeoutMs } from '@video-studio/shared/script/script-stream-policy'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createTextTransportBoundary, readTextErrorBody, textErrorBodyByteLimit, textHeadersTimeoutMs } from '../src/infrastructure/providers/text-transport-boundary.js'
import { textFrameByteLimit } from '../src/infrastructure/providers/text-frame-boundary.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { fetchModelCatalogSnapshot, modelCatalogTtlMs } from '../src/infrastructure/providers/model-catalog.js'
import type { Provider } from '../src/infrastructure/database/db.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'
import { runGenerationDeadline, withUnrestrictedScriptExecution } from '../src/modules/generation/model-execution.js'
import { createScriptRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { ModelWorkflowBudgetError, modelWorkflowBudgetKey, modelWorkflowBudgetDrainMs, runModelWorkflowBudget, type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const catalogConfig = { path: 'models', list_path: 'data', id_path: 'id', name_path: 'name', modality_path: '' }
const provider = { adapter: 'http' as const, base_url: 'https://phase.invalid/v1' }
const catalogProvider = (suffix: string) => ({ ...provider, id: suffix, base_url: `https://${suffix}.invalid/v1`, name: suffix,
  protocol: 'responses', auth_header: 'Authorization', auth_prefix: 'Bearer ', key_ciphertext: null } as Provider)
const contract = { name: 'bounded_test', schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
function model(protocol: 'responses' | 'chat_completions' | 'anthropic_messages'): GenerationModel {
  return { id: 'boundary-' + protocol, remote_id: 'actual', modality: 'text', protocol, settings: {
    text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192 }, structured_output_mode: 'prompt',
  } }
}

function reasoningModel(protocol: Parameters<typeof model>[0], stream = true): GenerationModel {
  return { ...model(protocol), settings: { stream, structured_output_mode: 'prompt',
    text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192, reasoning_effort: 'medium' } } }
}

function delayedHeaders(t: TestContext) {
  let release!: (response: Response) => void, wireSignal!: AbortSignal, body!: Record<string, unknown>, calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; wireSignal = init.signal!; body = JSON.parse(String(init.body))
    return new Promise<Response>((resolve, reject) => {
      release = resolve
      wireSignal.addEventListener('abort', () => reject(wireSignal.reason), { once: true })
    })
  })
  return { release: (response: Response) => release(response), signal: () => wireSignal, body: () => body, calls: () => calls }
}

function completedStream(protocol: Parameters<typeof model>[0]) {
  const events = protocol === 'responses' ? [
    { type: 'response.output_text.delta', delta: 'complete' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'complete' }] }] } },
  ] : protocol === 'chat_completions' ? [
    { choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }] },
  ] : [
    { type: 'message_start', message: { content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'complete' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}

function assertReasoningBody(protocol: Parameters<typeof model>[0], body: Record<string, unknown>) {
  assert.equal(body.stream, true)
  if (protocol === 'anthropic_messages') assert.deepEqual(body.thinking, { type: 'adaptive' })
  else if (protocol === 'responses') assert.deepEqual(body.reasoning, { effort: 'medium' })
  else assert.equal(body.reasoning_effort, 'medium')
}

test('catalog TTL, conditional refresh and deep copies preserve authoritative discovery freshness', async t => {
  let now = 100000, calls = 0
  t.mock.method(Date, 'now', () => now)
  const configured = catalogProvider('catalog-ttl')
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++
    if (calls === 2 || calls === 3) {
      assert.equal((init.headers as Record<string, string>)['If-None-Match'], '"models-v1"')
      return new Response(null, { status: 304 })
    }
    return Response.json({ data: [{ id: 'actual', name: 'Original', context_window: 100000 }] }, { headers: { etag: '"models-v1"' } })
  })
  const first = await fetchModelCatalogSnapshot(configured, catalogConfig, 'secret')
  assert.equal(first.freshness.source, 'network')
  first.models[0]!.name = 'draft-only edit'
  const cached = await fetchModelCatalogSnapshot(configured, catalogConfig, 'secret')
  assert.equal(cached.freshness.source, 'cache'); assert.equal(cached.models[0]!.name, 'Original'); assert.equal(calls, 1)
  now += modelCatalogTtlMs + 1
  const revalidated = await fetchModelCatalogSnapshot(configured, catalogConfig, 'secret')
  assert.equal(calls, 2); assert.equal(revalidated.freshness.source, 'revalidated')
  assert.equal(revalidated.freshness.fetched_at, first.freshness.fetched_at)
  assert.notEqual(revalidated.freshness.validated_at, first.freshness.validated_at)
  await fetchModelCatalogSnapshot(configured, catalogConfig, 'secret', { refresh: true })
  assert.equal(calls, 3, 'explicit refresh bypasses TTL and still uses conditional validation')
  await fetchModelCatalogSnapshot(configured, catalogConfig, 'different-account')
  await fetchModelCatalogSnapshot({ ...configured, protocol: 'chat_completions' }, catalogConfig, 'secret')
  assert.equal(calls, 5, 'credentials and protocol isolate cached channel capabilities')
})

test('concurrent catalog refresh shares one request while each caller retains independent cancellation', async t => {
  const configured = catalogProvider('catalog-inflight'), controller = new AbortController(), reason = new Error('close first editor')
  let calls = 0, release: ((response: Response) => void) | undefined, wireSignal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; wireSignal = init.signal!
    return new Promise<Response>(resolve => { release = resolve })
  })
  const first = fetchModelCatalogSnapshot(configured, catalogConfig, 'secret', { signal: controller.signal })
  const firstRejected = assert.rejects(first, issue => issue === reason)
  const second = fetchModelCatalogSnapshot(configured, catalogConfig, 'secret')
  controller.abort(reason); await firstRejected
  assert.equal(calls, 1); assert.equal(wireSignal!.aborted, false)
  release!(Response.json({ data: [{ id: 'one' }] }))
  assert.equal((await second).models[0]!.remote_id, 'one')
})

test('cancelling all catalog callers aborts the shared connection without caching a late result', async t => {
  const configured = catalogProvider('catalog-cancel'), controller = new AbortController(), reason = new Error('cancel editor')
  let wireSignal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    wireSignal = init.signal!
    return new Promise<Response>((_resolve, reject) => wireSignal!.addEventListener('abort', () => reject(wireSignal!.reason), { once: true }))
  })
  const pending = fetchModelCatalogSnapshot(configured, catalogConfig, 'secret', { signal: controller.signal })
  const rejected = assert.rejects(pending, issue => issue === reason)
  controller.abort(reason); await rejected; assert.equal(wireSignal!.aborted, true)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'new' }] }))
  assert.equal((await fetchModelCatalogSnapshot(configured, catalogConfig, 'secret')).freshness.source, 'network')
})

test('headers, first event and idle clocks are independent and parent cancellation keeps its reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parent = new AbortController(), scope = createStreamScope(parent.signal, { totalMs: 100000 })
  const boundary = createTextTransportBoundary(scope, { headersMs: 100, firstEventMs: 200, idleMs: 50 })
  try {
    t.mock.timers.tick(80); boundary.headers()
    t.mock.timers.tick(150); assert.equal(boundary.signal.aborted, false, 'the headers clock was removed, idle is not active before the first event')
    boundary.event(); t.mock.timers.tick(40); boundary.event(); t.mock.timers.tick(40)
    assert.equal(boundary.signal.aborted, false, 'events reset only idle after the first event')
    t.mock.timers.tick(11)
    assert.equal((boundary.signal.reason as TextProviderError).upstreamCode, 'event_idle_timeout')
  } finally { boundary.close(); scope.close() }
  const nextScope = createStreamScope(parent.signal, { totalMs: 100000 })
  const next = createTextTransportBoundary(nextScope, { headersMs: 100, firstEventMs: 200 })
  const reason = new Error('user cancellation')
  parent.abort(reason)
  await assert.rejects(next.wait(new Promise<never>(() => {})), issue => issue === reason)
  next.close(); nextScope.close()
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
  test(`${protocol}: a stalled headers phase aborts the wire request and preserves typed diagnostics`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let wireSignal: AbortSignal | undefined
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      wireSignal = init.signal!
      return new Promise<Response>((_resolve, reject) => wireSignal!.addEventListener('abort', () => reject(wireSignal!.reason), { once: true }))
    })
    const pending = streamText(model(protocol), provider, { prompt: 'full source', structured_output: contract })
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError && issue.failureReason === 'disconnected' && issue.upstreamCode === 'headers_timeout')
    await flush(); t.mock.timers.tick(textHeadersTimeoutMs); await rejected
    assert.equal(wireSignal!.aborted, true)
  })

  test(`${protocol}: comment heartbeats cannot postpone the first valid event deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let writer: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; controller.enqueue(encoder.encode(': keepalive\n\n')) } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    const pending = streamText(model(protocol), provider, { prompt: 'full source', structured_output: contract })
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError && issue.upstreamCode === 'first_event_timeout')
    await flush(); t.mock.timers.tick(200000); writer!.enqueue(encoder.encode(': still waiting\n\n')); await flush()
    t.mock.timers.tick(100000); await rejected
  })

  test(`${protocol}: one unclosed SSE event is bounded across individually small lines`, async t => {
    let cancelled = false
    const encoder = new TextEncoder(), line = ':' + 'x'.repeat(1022) + '\n'
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(line.repeat(Math.ceil(textFrameByteLimit / line.length) + 1)))
    }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    await assert.rejects(streamText(model(protocol), provider, { prompt: 'source', structured_output: contract }), issue => issue instanceof TextProviderError && issue.upstreamCode === 'response_frame_too_large')
    assert.equal(cancelled, true)
  })
}

test('HTTP diagnostic reads are bounded and cancel the remaining body', async () => {
  let pulls = 0, cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(32768).fill(120)) }, cancel() { cancelled = true } }), { status: 429 })
  const raw = await readTextErrorBody(response)
  assert.ok(Buffer.byteLength(raw) < textErrorBodyByteLimit + 100)
  assert.equal(cancelled, true); assert.ok(pulls <= 3)
})

test('valid long prose may span many small SSE events without a cumulative response cap', async t => {
  const piece = '中'.repeat(1024), count = Math.ceil(textFrameByteLimit / Buffer.byteLength(piece)) + 10
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < count; index++) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`))
    controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const result = await streamText(model('responses'), provider, { prompt: 'full source', structured_output: contract })
  assert.equal(result.length, piece.length * count); assert.ok(Buffer.byteLength(result) > textFrameByteLimit)
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol}: oversized HTTP errors retain their status and stop reading diagnostics`, async t => {
  let cancelled = false, pulls = 0
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32768).fill(120)) }, cancel() { cancelled = true },
  }), { status: 429, headers: { 'Retry-After': '4' } }))
  await assert.rejects(streamText(model(protocol), provider, { prompt: 'private source', structured_output: contract }), issue =>
    issue instanceof TextProviderError && issue.upstreamStatus === 429 && issue.retryable && issue.retryAfterMs === 4000)
  assert.equal(cancelled, true); assert.ok(pulls <= 3)
})

test('successful nonstream prose has no cumulative response cap', async t => {
  const prose = 'v'.repeat(textFrameByteLimit + 1000)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: prose }, finish_reason: 'stop' }] }))
  const result = await streamText(model('chat_completions'), provider, { prompt: 'source', structured_output: contract })
  assert.equal(result, prose)
})

test('an unclosed SSE event stops before a trailing partial line receives its newline or EOF', async t => {
  const encoder = new TextEncoder()
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(':' + 'x'.repeat(3 * 1024 * 1024) + '\n'))
    controller.enqueue(encoder.encode('data:' + 'x'.repeat(2 * 1024 * 1024)))
  }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  await assert.rejects(streamText(model('responses'), provider, { prompt: 'source', structured_output: contract }), issue => issue instanceof TextProviderError && issue.upstreamCode === 'response_frame_too_large')
  assert.equal(cancelled, true)
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
  test(`${protocol}: source analysis waits ten minutes for headers`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    const pending = streamText(model(protocol), provider, {
      prompt: 'source', structured_output: { ...contract, name: 'script_source_map_page' },
    })
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError &&
      issue.upstreamCode === 'headers_timeout' && issue.delivery === 'unknown')
    await flush()
    t.mock.timers.tick(10 * 60_000 - 1)
    assert.equal(wire.signal().aborted, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: reasoning stream accepts late headers beyond two minutes and completes normally`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    const pending = streamText(reasoningModel(protocol), provider, { prompt: 'source', structured_output: contract })
    await flush(); assertReasoningBody(protocol, wire.body())
    t.mock.timers.tick(textHeadersTimeoutMs + 60_000)
    assert.equal(wire.signal().aborted, false)
    wire.release(completedStream(protocol))
    assert.equal(await pending, 'complete'); assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: reasoning headers still stop at ten minutes with one unknown dispatch`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    const pending = streamText(reasoningModel(protocol), provider, { prompt: 'source', structured_output: contract })
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError &&
      issue.upstreamCode === 'headers_timeout' && issue.delivery === 'unknown' && issue.responseTerminated !== true)
    await flush(); assertReasoningBody(protocol, wire.body())
    t.mock.timers.tick(textReasoningIdleTimeoutMs - 1); assert.equal(wire.signal().aborted, false)
    t.mock.timers.tick(1); await rejected
    assert.equal(wire.signal().aborted, true); assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: nonstream headers retain their thirty-minute boundary`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    // Remove only the outer script clock so the transport's own nonstream
    // boundary is observable rather than racing the equal request deadline.
    const pending = withUnrestrictedScriptExecution(() => streamText(reasoningModel(protocol, false), provider,
      { prompt: 'source', structured_output: contract }))
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError && issue.upstreamCode === 'headers_timeout')
    await flush(); assert.notEqual(wire.body().stream, true)
    t.mock.timers.tick(textRequestTimeoutMs - 1); assert.equal(wire.signal().aborted, false)
    t.mock.timers.tick(1); await rejected; assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: parent cancellation interrupts the extended reasoning headers wait immediately`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t), controller = new AbortController(), reason = new Error('author cancelled')
    const pending = streamText(reasoningModel(protocol), provider, { prompt: 'source', structured_output: contract }, undefined, undefined, controller.signal)
    const rejected = assert.rejects(pending, issue => issue === reason)
    await flush(); t.mock.timers.tick(textHeadersTimeoutMs + 1); assert.equal(wire.signal().aborted, false)
    controller.abort(reason); await rejected
    assert.equal(wire.signal().reason, reason); assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: a shorter workflow deadline still wins over reasoning headers`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t), deadline = textHeadersTimeoutMs + 60_000
    const pending = runGenerationDeadline(undefined, deadline, () => streamText(reasoningModel(protocol), provider,
      { prompt: 'source', structured_output: contract }))
    const rejected = assert.rejects(pending, issue => issue instanceof StreamWaitTimeoutError && issue.kind === 'total')
    await flush(); t.mock.timers.tick(deadline - 1); assert.equal(wire.signal().aborted, false)
    t.mock.timers.tick(1); await rejected
    assert.equal(wire.signal().aborted, true); assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: native tool decisions use the same reasoning headers allowance`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    const pending = withUnrestrictedScriptExecution(() => textToolSession(reasoningModel(protocol), provider, 'source',
      [{ name: 'submit', description: 'submit result', parameters: contract.schema }], () => '')())
    await flush(); assertReasoningBody(protocol, wire.body()); assert.equal((wire.body().tools as unknown[]).length, 1)
    t.mock.timers.tick(textHeadersTimeoutMs + 60_000); assert.equal(wire.signal().aborted, false)
    wire.release(completedStream(protocol))
    const result = await pending
    assert.equal(result.text, 'complete'); assert.deepEqual(result.calls, []); assert.equal(wire.calls(), 1)
  })

  test(`${protocol}: native reasoning tool headers retain a finite ten-minute deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const wire = delayedHeaders(t)
    const pending = withUnrestrictedScriptExecution(() => textToolSession(reasoningModel(protocol), provider, 'source',
      [{ name: 'submit', description: 'submit result', parameters: contract.schema }], () => '')())
    const rejected = assert.rejects(pending, issue => issue instanceof TextProviderError &&
      issue.upstreamCode === 'headers_timeout' && issue.delivery === 'unknown' && issue.responseTerminated !== true)
    await flush(); t.mock.timers.tick(textReasoningIdleTimeoutMs - 1); assert.equal(wire.signal().aborted, false)
    t.mock.timers.tick(1); await rejected
    assert.equal(wire.signal().aborted, true); assert.equal(wire.calls(), 1)
  })
}

test('a workflow active-time budget still drains then aborts an in-flight reasoning headers wait before ten minutes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const wire = delayedHeaders(t), activeMs = textHeadersTimeoutMs + 60_000
  const checkpoint: ModelWorkflowBudgetCheckpoint = { version: 1, kind: 'script', grants: 1, active_ms: 0,
    allowance: { max_requests: 20, max_total_requests: 100, max_tokens: 1000000, max_active_ms: activeMs }, usage: createScriptRequestUsage() }
  const steps: Record<string, unknown> = { [modelWorkflowBudgetKey]: checkpoint }
  const pending = runModelWorkflowBudget({ kind: 'script', scale: { units: 1, inputChars: 10 }, steps,
    signal: new AbortController().signal, persist() {} }, signal => streamText(reasoningModel('anthropic_messages'), provider,
    { prompt: 'source', structured_output: contract }, undefined, undefined, signal))
  const rejected = assert.rejects(pending, issue => issue instanceof ModelWorkflowBudgetError && issue.reason === 'duration')
  await flush(); t.mock.timers.tick(activeMs); assert.equal(wire.signal().aborted, false, 'admitted work keeps its existing bounded drain')
  t.mock.timers.tick(modelWorkflowBudgetDrainMs - 1); assert.equal(wire.signal().aborted, false)
  t.mock.timers.tick(1); await rejected
  assert.equal(wire.signal().aborted, true); assert.equal(wire.calls(), 1)
  const saved = steps[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint
  assert.equal(saved.exhausted, 'duration'); assert.equal(saved.grants, 1)
  assert.equal(saved.usage.requests, 1); assert.equal(saved.usage.uncertain_requests, 1)
})
