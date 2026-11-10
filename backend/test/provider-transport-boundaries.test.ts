import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStreamScope } from '@video-studio/shared/script/script-stream-policy'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createTextTransportBoundary, readTextErrorBody, textErrorBodyByteLimit, textHeadersTimeoutMs } from '../src/infrastructure/providers/text-transport-boundary.js'
import { textFrameByteLimit } from '../src/infrastructure/providers/text-frame-boundary.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { fetchModelCatalogSnapshot, modelCatalogTtlMs } from '../src/infrastructure/providers/model-catalog.js'
import type { Provider } from '../src/infrastructure/database/db.js'

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
