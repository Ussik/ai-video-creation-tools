import assert from 'node:assert/strict'
import test from 'node:test'
import { createLangfuseTracer, readLangfuseConfig, type LangfuseConfig, type LangfuseSpan, type LangfuseBatch } from '../src/infrastructure/observability/langfuse-tracing.js'
const enabled = (overrides: NodeJS.ProcessEnv = {}) => readLangfuseConfig({ LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'http://localhost:3035', ...overrides })
const spans = (batch: LangfuseBatch) => batch.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
function attribute(span: LangfuseSpan, key: string) { return span.attributes.find(item => item.key === key)?.value.stringValue }
function metadata(span: LangfuseSpan) {
  return Object.fromEntries(span.attributes.filter(item => item.key.startsWith('langfuse.observation.metadata.')).map(item => [item.key.slice('langfuse.observation.metadata.'.length), JSON.parse(item.value.stringValue!)]))
}
function capture(config: LangfuseConfig = enabled()) {
  const batches: LangfuseBatch[] = []; let clients = 0
  const tracer = createLangfuseTracer(config, { salt: 'test-only-salt', random: () => 0, now: () => 1770000000000,
    clientFactory: () => { clients++; return { async send(batch) { batches.push(structuredClone(batch)) } } } })
  return { tracer, batches, clients: () => clients, spans: () => batches.flatMap(spans) }
}

test('tracing requires explicit enablement, both credentials and a selected target', async () => {
  for (const config of [readLangfuseConfig({}), enabled({ LANGFUSE_TRACING: 'TRUE' }), enabled({ LANGFUSE_PUBLIC_KEY: '' }), enabled({ LANGFUSE_SECRET_KEY: '' }), enabled({ LANGFUSE_BASE_URL: '' })]) {
    assert.equal(config.enabled, false); const c = capture(config), o = c.tracer.observation({ taskId: 'secret', owner: 'request' })
    o.dispatch({ request_id: 'a' }); o.metrics({ request_id: 'a' }); o.finish('succeeded'); await c.tracer.flush()
    assert.equal(c.clients(), 0); assert.equal(c.tracer.status().pending, 0)
  }
})

test('base URL permits HTTPS or loopback HTTP while rejecting ambiguous targets and invalid configuration', () => {
  for (const url of ['https://cloud.langfuse.com', 'https://us.cloud.langfuse.com', 'https://trace.example.test/base', 'http://localhost:3035', 'http://127.0.0.1:3035', 'http://[::1]:3035']) assert.equal(enabled({ LANGFUSE_BASE_URL: url }).enabled, true, url)
  for (const url of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?key=private', 'https://example.test/#private', 'file:///tmp/x']) assert.equal(enabled({ LANGFUSE_BASE_URL: url }).reason, 'invalid_endpoint', url)
  for (const env of [{ LANGFUSE_TRACING_SAMPLING_RATE: 'NaN' }, { LANGFUSE_TRACING_SAMPLING_RATE: '1.1' }, { VIDEO_STUDIO_LANGFUSE_MAX_PENDING: '257' }, { VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: '0' }, { LANGFUSE_PUBLIC_KEY: 'pk:header' }]) assert.equal(enabled(env).reason, 'invalid_configuration')
})

test('whole-trace sampling and lazy initialization avoid any traffic before a final observation exists', async () => {
  let clients = 0
  const tracer = createLangfuseTracer(enabled({ LANGFUSE_TRACING_SAMPLING_RATE: '0.5' }), { random: () => 0.8, clientFactory: () => { clients++; throw new Error('must not create') } })
  const o = tracer.observation({ taskId: 'a', owner: 'request' }); o.dispatch({ request_id: 'b' }); o.finish('succeeded'); await tracer.flush(); assert.equal(clients, 0)
  const c = capture(), unused = c.tracer.observation({ taskId: 'unused', owner: 'request' }); unused.finish('succeeded'); await c.tracer.flush(); assert.equal(c.clients(), 0)
  c.tracer.observation({ taskId: 'dispatched', owner: 'request' }).dispatch({ request_id: 'waiting' }); await c.tracer.flush(); assert.equal(c.clients(), 0)
})

test('concurrent and late settlements export each immutable child once under its original root', async () => {
  const c = capture(), first = c.tracer.observation({ taskId: 'first', owner: 'request' }), second = c.tracer.observation({ taskId: 'second', owner: 'job' })
  first.dispatch({ request_id: 'r1', request_purpose: 'generation' }); first.dispatch({ request_id: 'r2', request_purpose: 'review' })
  second.dispatch({ request_id: 'r1', request_purpose: 'prompt' })
  first.metrics({ request_id: 'r2', input_tokens: 8, output_tokens: 2, delivery: 'completed' }); second.metrics({ request_id: 'r1', input_tokens: 5, output_tokens: 1, delivery: 'completed' })
  first.finish('succeeded'); first.finish('failed'); second.finish('succeeded'); await c.tracer.flush()
  const roots = c.spans().filter(span => !span.parentSpanId), children = c.spans().filter(span => span.parentSpanId)
  assert.equal(roots.length, 2); assert.equal(children.length, 2)
  for (const child of children) assert.ok(roots.some(root => root.traceId === child.traceId && root.spanId === child.parentSpanId))
  assert.equal(c.spans().some(span => span.name === 'generation:text'), false, 'finish must not prematurely export an immutable child')
  const firstRoot = roots.find(span => metadata(span).incomplete_children === 1)!
  assert.ok(firstRoot); assert.equal(c.tracer.status().incomplete, 1)
  first.metrics({ request_id: 'r1', input_tokens: 10, output_tokens: 3, delivery: 'completed' }); first.metrics({ request_id: 'r1', delivery: 'unknown' }); await c.tracer.flush()
  const late = c.spans().filter(span => span.name === 'generation:text')
  assert.equal(late.length, 1); assert.equal(late[0]!.traceId, firstRoot.traceId); assert.equal(late[0]!.parentSpanId, firstRoot.spanId)
  assert.equal(late[0]!.status.code, 1); assert.deepEqual(JSON.parse(attribute(late[0]!, 'langfuse.observation.usage_details')!), { input: 10, output: 3, total: 13 })
  assert.equal(c.tracer.status().incomplete, 0); assert.equal(metadata(firstRoot).incomplete_children, 1, 'root records its finish-time snapshot without later mutation')
})

test('metadata excludes raw labels, URLs, identifiers, reasons and unknown usage', async () => {
  const c = capture(), secret = 'PRIVATE正文-token-https://secret.test', o = c.tracer.observation({ taskId: secret, projectId: secret, modelId: secret, label: secret, owner: secret })
  o.dispatch({ request_id: secret, model_id: secret, task_id: secret, step_id: secret, attempt_id: secret, remote_id: secret, raw_reason: secret,
    endpoint: secret, prompt: secret, request_purpose: secret, transport_kind: secret, failure_reason: secret, delivery: secret, request_bytes: 9, output_tokens: Infinity, input_tokens: -1 })
  o.metrics({ request_id: secret, model_id: secret, remote_id: secret, raw_reason: secret, error: secret, input_tokens: -1, output_tokens: NaN, delivery: 'unknown' }); o.finish('failed'); await c.tracer.flush()
  assert.equal(JSON.stringify(c.batches).includes(secret), false)
  const child = c.spans().find(span => span.parentSpanId)!, data = metadata(child)
  assert.equal(data.request_bytes, 9); assert.equal(data.input_tokens, undefined); assert.equal(data.output_tokens, undefined); assert.match(data.model_ref, /^[a-f0-9]{64}$/)
  assert.equal(data.model_ref, metadata(c.spans().find(span => !span.parentSpanId)!).model_ref)
  assert.equal(attribute(child, 'langfuse.observation.usage_details'), undefined); assert.equal(child.status.message, 'unknown_result')
})

test('HMAC references differ across process salts and overflow cannot become false total usage', async () => {
  const a = capture(), o = a.tracer.observation({ taskId: 'task', owner: 'request' }); o.dispatch({ request_id: 'r' }); o.metrics({ request_id: 'r', input_tokens: 1e308, output_tokens: 1e308 }); o.finish('succeeded'); await a.tracer.flush()
  const child = a.spans().find(span => span.parentSpanId)!
  assert.equal(JSON.parse(attribute(child, 'langfuse.observation.usage_details')!).total, undefined)
  const batches: LangfuseBatch[] = [], other = createLangfuseTracer(enabled(), { salt: 'different', clientFactory: () => ({ async send(batch) { batches.push(batch) } }) })
  const two = other.observation({ taskId: 'task', owner: 'request' }); two.dispatch({ request_id: 'r' }); two.finish('succeeded'); await other.flush()
  assert.notEqual(metadata(a.spans().find(span => !span.parentSpanId)!).task_ref, metadata(batches.flatMap(spans)[0]!).task_ref)
})

test('queue saturation drops a new trace and limits work without blocking business execution', async () => {
  let resolve!: () => void
  const work = new Promise<void>(done => { resolve = done }), batches: LangfuseBatch[] = []
  const tracer = createLangfuseTracer(enabled({ VIDEO_STUDIO_LANGFUSE_MAX_PENDING: '1' }), { clientFactory: () => ({ async send(batch) { batches.push(batch); await work } }) })
  const one = tracer.observation({ taskId: 'one', owner: 'request' }); one.dispatch({ request_id: 'r1' }); one.metrics({ request_id: 'r1' })
  const two = tracer.observation({ taskId: 'two', owner: 'request' }); two.dispatch({ request_id: 'r2' }); two.metrics({ request_id: 'r2' }); two.finish('succeeded')
  assert.equal(tracer.status().pending, 1); assert.equal(tracer.status().dropped, 1)
  await tracer.flush(1); assert.equal(tracer.status().pending, 1); resolve(); await tracer.flush(); assert.equal(batches.length, 1); assert.equal(tracer.status().pending, 0)
})

test('sync factory errors and export rejections remain isolated from business results', async () => {
  for (const clientFactory of [() => { throw new Error('private_key') }, () => ({ async send() { throw new Error('private body') } })]) {
    const tracer = createLangfuseTracer(enabled(), { clientFactory }), o = tracer.observation({ taskId: 'a', owner: 'request' })
    assert.doesNotThrow(() => { o.dispatch({ request_id: 'b' }); o.metrics({ request_id: 'b', http_status: 503 }); o.finish('failed') })
    await tracer.flush(); assert.ok(tracer.status().failed > 0); assert.equal(tracer.status().pending, 0)
  }
})

test('v4 OTLP JSON uses exact wire IDs, headers, parentage, metadata and real usage without environment baggage', async t => {
  const prior = process.env.LANGCHAIN_CUSTOM_HEADERS; process.env.LANGCHAIN_CUSTOM_HEADERS = 'x-private-baggage: PRIVATE_HEADER'
  t.after(() => { if (prior === undefined) delete process.env.LANGCHAIN_CUSTOM_HEADERS; else process.env.LANGCHAIN_CUSTOM_HEADERS = prior })
  const requests: Array<{ url: string; body: LangfuseBatch; headers: Headers }> = [], secret = 'PRIVATE_prompt'
  const tracer = createLangfuseTracer(enabled({ LANGFUSE_BASE_URL: 'https://trace.example.test/base' }), { fetch: async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }); assert.equal(init?.redirect, 'error'); return Response.json({})
  } })
  const o = tracer.observation({ taskId: secret, label: secret, owner: 'diagnostic' }); o.dispatch({ request_id: secret, trace_stage: 'repair', model_id: secret, prompt: secret })
  o.metrics({ request_id: secret, delivery: 'completed', input_tokens: 12, output_tokens: 4, reasoning_tokens: 2 }); o.finish('succeeded'); await tracer.flush()
  assert.equal(tracer.status().failed, 0); assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.url, 'https://trace.example.test/base/api/public/otel/v1/traces'); assert.equal(request.headers.get('authorization'), 'Basic ' + Buffer.from('pk-test:sk-test').toString('base64'))
    assert.deepEqual([...request.headers.keys()].sort(), ['accept', 'authorization', 'content-type', 'x-langfuse-ingestion-version']); assert.equal(request.headers.get('x-langfuse-ingestion-version'), '4'); assert.equal(JSON.stringify(request.body).includes(secret), false)
  }
  const child = spans(requests[0]!.body)[0]!, root = spans(requests[1]!.body)[0]!
  assert.match(root.traceId, /^[a-f0-9]{32}$/); assert.match(root.spanId, /^[a-f0-9]{16}$/); assert.match(child.spanId, /^[a-f0-9]{16}$/)
  assert.equal(child.parentSpanId, root.spanId); assert.equal(child.traceId, root.traceId); assert.equal(child.name, 'repair:text')
  assert.match(root.startTimeUnixNano, /^\d+$/); assert.match(root.endTimeUnixNano, /^\d+$/)
  assert.equal(attribute(child, 'langfuse.observation.type'), 'generation'); assert.deepEqual(JSON.parse(attribute(child, 'langfuse.observation.usage_details')!), { input: 12, output: 4, total: 16 })
  assert.equal(metadata(root).state, 'succeeded'); assert.equal(metadata(root).owner, 'diagnostic'); assert.equal(tracer.status().lastRootSpanId, root.spanId)
})

test('HTTP 200 partial rejection and malformed confirmations fail without retries or logs', async t => {
  const errors = t.mock.method(console, 'error', () => {}), warnings = t.mock.method(console, 'warn', () => {})
  for (const body of [{ partialSuccess: { rejectedSpans: '1', errorMessage: 'PRIVATE' } }, { partialSuccess: { rejectedSpans: 0, errorMessage: 'PRIVATE' } }, { partialSuccess: 'bad' }, [], null, undefined]) {
    let attempts = 0
    const tracer = createLangfuseTracer(enabled(), { fetch: async () => { attempts++; return body === undefined ? new Response('PRIVATE', { status: 503 }) : Response.json(body) } })
    const o = tracer.observation({ taskId: 'a', owner: 'request' }); o.dispatch({ request_id: 'b' }); o.finish('succeeded'); await tracer.flush()
    assert.equal(attempts, 1); assert.equal(tracer.status().failed, 1); assert.equal(tracer.status().sent, 0)
  }
  assert.equal(errors.mock.calls.length, 0); assert.equal(warnings.mock.calls.length, 0)
})

test('HTTP errors and TTFT map to fixed status and official completion attribute', async () => {
  let at = 1770000000000; const batches: LangfuseBatch[] = []
  const tracer = createLangfuseTracer(enabled(), { now: () => at, clientFactory: () => ({ async send(batch) { batches.push(batch) } }) })
  const o = tracer.observation({ taskId: 'task', owner: 'request' }); o.dispatch({ request_id: 'r' }); at += 100
  o.metrics({ request_id: 'r', first_event_ms: 30, http_status: 503, raw_reason: 'PRIVATE' }); await tracer.flush()
  const child = batches.flatMap(spans)[0]!
  assert.equal(child.status.message, 'http_error'); assert.equal(child.status.code, 2); assert.equal(attribute(child, 'langfuse.observation.completion_start_time'), new Date(1770000000030).toISOString())
})

test('stuck transport aborts and shutdown remains bounded', async () => {
  let signal: AbortSignal | undefined
  const tracer = createLangfuseTracer(enabled({ VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: '50' }), { fetch: async (_input, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}) } })
  const o = tracer.observation({ taskId: 'task', owner: 'request' }); o.dispatch({ request_id: 'r' }); o.finish('succeeded'); await tracer.flush(5)
  assert.equal(tracer.status().pending, 1); await tracer.flush(100); assert.equal(signal?.aborted, true); assert.equal(tracer.status().failed, 1); assert.equal(tracer.status().pending, 0)
})

test('stuck confirmation stream is cancelled at the export deadline', async () => {
  let signal: AbortSignal | undefined, cancelled = false
  const tracer = createLangfuseTracer(enabled({ VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: '50' }), { fetch: async (_input, init) => { signal = init?.signal as AbortSignal; return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true } })) } })
  const o = tracer.observation({ taskId: 'task', owner: 'request' }); o.dispatch({ request_id: 'r' }); o.finish('succeeded'); await tracer.flush(100)
  assert.equal(signal?.aborted, true); assert.equal(cancelled, true); assert.equal(tracer.status().failed, 1); assert.equal(tracer.status().pending, 0)
})
