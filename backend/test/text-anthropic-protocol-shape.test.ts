import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLangfuseTracer, readLangfuseConfig, type LangfuseBatch, type LangfuseSpan } from '../src/infrastructure/observability/langfuse-tracing.js'
import { currentModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const directory = await mkdtemp(join(tmpdir(), 'anthropic-protocol-shape-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { streamText, createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
const { initDb, db } = await import('../src/infrastructure/database/db.js')
const { initModelRequestObservation, createModelRequestObservation, safeModelMetrics } = await import('../src/modules/generation/model-request-observation.js')
initDb(); initModelRequestObservation()
after(async () => { db.close(); await rm(directory, { force: true, recursive: true }) })
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const model = { id: 'shape-fixture', remote_id: 'shape-fixture', modality: 'text' as const, protocol: 'anthropic_messages' as const,
  settings: { text_api: { mode: 'standard', max_output_tokens: 65536 } } }
const start = { type: 'message_start', message: { content: [], usage: { input_tokens: 10, output_tokens: 0 } } }
const end = (reason = 'end_turn') => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7 } }, { type: 'message_stop' }]
const block = (index: number, content: Record<string, unknown>) => [{ type: 'content_block_start', index, content_block: content }, { type: 'content_block_stop', index }]
const sse = (events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const message = (content: unknown[], stop_reason = 'end_turn') => Response.json({ type: 'message', content, stop_reason, usage: { input_tokens: 10, output_tokens: 7 } })
const fields = ['request_has_tools', 'request_tool_count', 'request_structured_mode', 'response_text_blocks', 'response_thinking_blocks',
  'response_tool_use_blocks', 'response_other_blocks', 'response_complete', 'response_blocks_closed', 'response_protocol_terminal']
const shape = (value: Record<string, unknown>) => Object.fromEntries(fields.map(key => [key, value[key]]))
const baseShape = { request_has_tools: false, request_tool_count: 0, request_structured_mode: 'none', response_text_blocks: 1,
  response_thinking_blocks: 0, response_tool_use_blocks: 0, response_other_blocks: 0, response_complete: true, response_blocks_closed: true, response_protocol_terminal: true }
const metadata = (span: LangfuseSpan) => Object.fromEntries(span.attributes.filter(item => item.key.startsWith('langfuse.observation.metadata.'))
  .map(item => [item.key.slice('langfuse.observation.metadata.'.length), JSON.parse(item.value.stringValue!)]))
function traceFixture() {
  const batches: LangfuseBatch[] = []
  const tracer = createLangfuseTracer(readLangfuseConfig({ LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: 'pk-fixture', LANGFUSE_SECRET_KEY: 'sk-fixture', LANGFUSE_BASE_URL: 'http://localhost:3035' }),
    { clientFactory: () => ({ async send(batch) { batches.push(batch) } }) })
  return { tracer, spans: () => batches.flatMap(batch => batch.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))) }
}

test('SSE terminal shape counts block types while leaving private content and signed thinking out of metrics', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse([start,
    ...block(0, { type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }),
    ...block(1, { type: 'text', text: 'VISIBLE_RESULT' }), ...block(2, { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' }), ...end()]))
  const metrics: any[] = []
  assert.equal(await streamText(model, provider, { prompt: 'PRIVATE_PROMPT' }, undefined, undefined, undefined, value => metrics.push(value)), 'VISIBLE_RESULT')
  assert.deepEqual(shape(metrics[0]), { ...baseShape, response_thinking_blocks: 1, response_other_blocks: 1 })
  assert.equal(metrics[0].delivery, 'completed'); assert.equal(metrics[0].raw_reason, 'end_turn')
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_THINKING|PRIVATE_SIGNATURE|PRIVATE_REDACTED|PRIVATE_PROMPT|VISIBLE_RESULT/)
})

test('nonstream JSON native schema request reports its actual tool absence and format without changing output', async t => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined)
    assert.equal(body.output_config.format.type, 'json_schema')
    return message([{ type: 'text', text: '{"ok":true}' }])
  })
  const metrics: any[] = [], dispatch: any[] = []
  assert.equal(await streamText({ ...model, settings: { ...model.settings, structured_output_mode: 'json_schema' } }, provider,
    { prompt: 'PRIVATE_PROMPT', structured_output: { name: 'shape', schema } }, undefined, undefined, undefined, value => metrics.push(value), value => dispatch.push(value)), '{"ok":true}')
  assert.deepEqual(shape(metrics[0]), { ...baseShape, request_structured_mode: 'json_schema' })
  assert.equal(dispatch[0].request_structured_mode, 'json_schema'); assert.equal(dispatch[0].request_has_tools, false)
})

test('complete unsolicited SSE tool call remains rejected and never exposes its name or input through shape metrics', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return sse([start, ...block(0, { type: 'text', text: 'VISIBLE_DIAGNOSTIC' }),
      ...block(1, { type: 'tool_use', id: 'private-id', name: 'PRIVATE_TOOL_NAME', input: { value: 'PRIVATE_ARGUMENT' } }), ...end('tool_use')])
  })
  const metrics: any[] = []
  await assert.rejects(streamText(model, provider, { prompt: 'prompt' }, undefined, undefined, undefined, value => metrics.push(value)), error => {
    assert.ok(error instanceof TextProviderError); assert.equal(error.upstreamCode, 'tool_use'); assert.equal(error.retryable, false)
    assert.equal(error.delivery, 'output_started'); assert.equal(error.responseTerminated, false); return true
  })
  assert.equal(requests, 1); assert.deepEqual(shape(metrics[0]), { ...baseShape, response_tool_use_blocks: 1 })
  assert.equal(metrics[0].raw_reason, 'tool_use'); assert.equal(metrics[0].delivery, 'output_started')
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_TOOL_NAME|PRIVATE_ARGUMENT|private-id|VISIBLE_DIAGNOSTIC/)
})

test('JSON text-only content with tool_use stop reason is distinguishable from a real tool block and remains rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => message([{ type: 'text', text: 'not-json' }], 'tool_use'))
  const metrics: any[] = []
  await assert.rejects(streamText(model, provider, { prompt: 'prompt' }, undefined, undefined, undefined, value => metrics.push(value)), { upstreamCode: 'tool_use' })
  assert.deepEqual(shape(metrics[0]), baseShape); assert.equal(metrics[0].raw_reason, 'tool_use'); assert.equal(metrics[0].delivery, 'output_started')
})

test('EOF after a stop reason but without message_stop never claims a protocol terminal', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse([start, ...block(0, { type: 'text', text: 'partial' }),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }]))
  const metrics: any[] = []
  await assert.rejects(streamText(model, provider, { prompt: 'prompt' }, undefined, undefined, undefined, value => metrics.push(value)), { upstreamCode: 'stream_disconnected' })
  assert.deepEqual(shape(metrics[0]), { ...baseShape, response_complete: false, response_protocol_terminal: false })
  assert.equal(metrics[0].failure_reason, 'disconnected'); assert.equal(metrics[0].delivery, 'output_started')
})

test('message_stop with an unclosed content block records the exact boundary and still fails', async t => {
  t.mock.method(globalThis, 'fetch', async () => sse([start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } }, ...end()]))
  const metrics: any[] = []
  await assert.rejects(streamText(model, provider, { prompt: 'prompt' }, undefined, undefined, undefined, value => metrics.push(value)), { upstreamCode: 'bad_response_body' })
  assert.deepEqual(shape(metrics[0]), { ...baseShape, response_blocks_closed: false, response_protocol_terminal: false })
  assert.equal(metrics[0].delivery, 'output_started')
})

test('explicit native tools keep their complete calls and signed history while telemetry contains only shape', async t => {
  const tools = [{ name: 'submit_fixture', description: 'fixture', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }]
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); assert.equal(body.tools.length, 1)
    return message([{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'tool_use', id: 'call-1', name: 'submit_fixture', input: { value: 'PRIVATE_ARGUMENT' } }], 'tool_use')
  })
  const metrics: any[] = []
  const turn = await createTextToolTransport(model, provider, 'PRIVATE_PROMPT', tools, undefined, [], () => '', undefined, undefined, undefined, value => metrics.push(value))
  assert.deepEqual(turn.calls, [{ id: 'call-1', name: 'submit_fixture', arguments: '{"value":"PRIVATE_ARGUMENT"}' }])
  assert.match(JSON.stringify(turn.history), /PRIVATE_THINKING.*PRIVATE_SIGNATURE/)
  assert.deepEqual(shape(metrics[0]), { ...baseShape, request_has_tools: true, request_tool_count: 1, response_text_blocks: 0, response_thinking_blocks: 1, response_tool_use_blocks: 1 })
  assert.equal(metrics[0].delivery, 'completed'); assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_ARGUMENT|PRIVATE_SIGNATURE|PRIVATE_THINKING|submit_fixture/)
})

test('local durable observation and Langfuse both retain terminal protocol shape without promoting delivery or leaking content', async () => {
  const f = traceFixture(), observation = createModelRequestObservation({ taskId: 'shape-observation', label: 'fixture', owner: 'request' }, f.tracer)
  await observation.run(() => {
    const context = currentModelRequestContext()!
    context.onDispatch?.({ request_id: 'shape-request', request_bytes: 100, ...baseShape })
    context.onMetrics?.({ request_id: 'shape-request', request_bytes: 100, ...baseShape, response_tool_use_blocks: 1,
      raw_reason: 'tool_use', delivery: 'output_started', failure_reason: 'upstream_error', output_tokens: 7, prompt: 'PRIVATE_PROMPT', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' })
  })
  observation.finish('failed'); await f.tracer.flush()
  const local = JSON.parse((db.prepare('SELECT metrics FROM model_request_attempts WHERE task_id=? AND id=?').get(observation.id, 'shape-request') as any).metrics)
  const remote = metadata(f.spans().find(span => span.parentSpanId)!)
  for (const value of [local, remote]) {
    assert.deepEqual(shape(value), { ...baseShape, response_tool_use_blocks: 1 }); assert.equal(value.raw_reason, 'tool_use')
    assert.equal(value.delivery, 'output_started'); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_PROMPT|PRIVATE_THINKING|PRIVATE_SIGNATURE/)
  }
  assert.equal(remote.output_usage_complete, false)
})

test('shape whitelist drops arbitrary strings, objects, unsafe counts and nonbooleans at both sinks', async () => {
  const malicious = { request_has_tools: 'PRIVATE', request_tool_count: 1.5, request_structured_mode: { toString: () => 'json_schema', secret: 'PRIVATE' },
    response_complete: 'true', response_blocks_closed: 1, response_protocol_terminal: {}, response_text_blocks: -1, response_thinking_blocks: NaN,
    response_tool_use_blocks: Infinity, response_other_blocks: Number.MAX_SAFE_INTEGER + 1, block_types: 'PRIVATE', raw_reason: 'PRIVATE_REASON' }
  const local = safeModelMetrics(malicious)
  for (const key of fields) assert.equal(local[key], undefined)
  const f = traceFixture(), observation = f.tracer.observation({ taskId: 'invalid-shape', owner: 'request' })
  observation.dispatch({ request_id: 'invalid-shape-r' }); observation.metrics({ request_id: 'invalid-shape-r', ...malicious }); observation.finish('failed'); await f.tracer.flush()
  const remote = metadata(f.spans().find(span => span.parentSpanId)!)
  for (const key of fields) assert.equal(remote[key], undefined)
  assert.equal(remote.raw_reason, undefined); assert.doesNotMatch(JSON.stringify(remote), /PRIVATE/)
})

test('distinct correction prompts and transport bodies keep independent text, wire and request fingerprints', async t => {
  const { createHash } = await import('node:crypto')
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const bodies: string[] = [], outputs = ['{"summary":"unescaped"quote""}', '{"summary":"corrected"}']
  const responses: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    const text = outputs[bodies.length - 1]!
    const payload = JSON.stringify({ type: 'message', id: `msg_${bodies.length}`, content: [{ type: 'text', text }], stop_reason: 'end_turn' })
    responses.push(payload)
    return new Response(payload, { headers: { 'content-type': 'application/json' } })
  })
  const metrics: any[] = [], contract = { name: 'hash-fixture', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }
  for (const [index, prompt] of ['PRIVATE_INITIAL', 'PRIVATE_CORRECTION'].entries()) {
    const output = await streamText({ ...model, settings: { ...model.settings, structured_output_mode: 'json_schema' } }, provider,
      { prompt, structured_output: contract }, undefined, undefined, undefined, value => metrics.push(value))
    assert.equal(output, outputs[index]); assert.equal(metrics[index].request_prompt_hash, hash(prompt))
    assert.equal(metrics[index].request_body_hash, hash(bodies[index]!)); assert.equal(metrics[index].response_body_hash, hash(responses[index]!))
    assert.equal(metrics[index].response_text_hash, hash(output))
    assert.equal(metrics[index].response_json_valid, index === 1)
  }
  assert.notEqual(metrics[0].request_body_hash, metrics[1].request_body_hash)
  assert.notEqual(metrics[0].response_text_hash, metrics[1].response_text_hash)
  const safe = safeModelMetrics(metrics[0])
  assert.equal(safe.response_text_hash, metrics[0].response_text_hash)
  assert.equal(safe.response_json_valid, false)
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_INITIAL|unescaped|quote/)
  assert.equal(safeModelMetrics({ response_text_hash: 'PRIVATE_RAW', request_body_hash: 'bad', response_json_valid: 'yes' }).response_text_hash, undefined)
})

test('SSE body fingerprints cover received wire bytes independently of decoded text', async t => {
  const { createHash } = await import('node:crypto')
  const events = [start, ...block(0, { type: 'text', text: '正文🦊' }), ...end()]
  const wire = events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')
  t.mock.method(globalThis, 'fetch', async () => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }))
  const metrics: any[] = []
  const output = await streamText(model, provider, { prompt: 'initial' }, undefined, undefined, undefined, m => metrics.push(m))
  assert.equal(output, '正文🦊')
  assert.equal(metrics[0].response_body_hash, createHash('sha256').update(wire).digest('hex'))
  assert.equal(metrics[0].response_text_hash, createHash('sha256').update(output).digest('hex'))
})
