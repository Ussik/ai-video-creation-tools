import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTextRequestActivity } from '../src/infrastructure/providers/text-request-plan.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { beginTextRequest } from '../src/infrastructure/providers/text-request-usage.js'

const directory = await mkdtemp(join(tmpdir(), 'text-request-activity-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db } = await import('../src/infrastructure/database/db.js')
const { initModelRequestObservation, createModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
const { streamText, createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
initDb(); initModelRequestObservation()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('in-flight activity uses immediate milestones and throttled numeric metadata only', t => {
  let at = 1000
  t.mock.method(Date, 'now', () => at)
  const events: Record<string, unknown>[] = []
  const metrics = { request_id: 'request-1', http_status: 200, delivery: 'accepted', first_event_ms: 1,
    first_text_ms: 3, response_chars: 2, output_started: true, prompt: 'PRIVATE', reasoning: 'PRIVATE', output_tokens: 123 }
  const activity = withModelRequestContext({ policy: modelTaskPolicies.text, onActivity: value => events.push(value as Record<string, unknown>) },
    () => createTextRequestActivity(metrics, 1000))
  activity.headers(); activity.headers(); at = 1001; activity.event()
  for (let index = 0; index < 30; index++) { at++; activity.event() }
  at = 16001; activity.event(); activity.text(); activity.text()
  assert.deepEqual(events.map(event => event.activity), ['headers', 'first_event', 'event', 'first_text'])
  assert.equal(events[2]!.received_events, 32); assert.equal(events[2]!.last_event_ms, 15001)
  assert.equal(events[3]!.first_text_ms, 3); assert.equal(events[3]!.response_chars, 2)
  assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.ok(!('output_tokens' in events[3]!))
  const failing = withModelRequestContext({ policy: modelTaskPolicies.text, onActivity() { throw new Error('diagnostics unavailable') } },
    () => createTextRequestActivity(metrics, 1000))
  assert.doesNotThrow(() => { failing.headers(); failing.event(); failing.text() })
})

test('activity updates only a live dispatched attempt without settling usage or tracing', () => {
  const trace: string[] = []
  const observation = createModelRequestObservation({ taskId: 'activity-in-flight', owner: 'job', label: 'test' }, {
    observation: () => ({ dispatch: () => trace.push('dispatch'), metrics: () => trace.push('metrics'), finish: () => trace.push('finish') }),
  })
  const reservation = observation.run(() => {
    const context = currentModelRequestContext()!
    const pending = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 8, reserved_output_tokens: 100 })
    pending.identify('in-flight-request')
    context.onDispatch?.({ request_id: 'in-flight-request', request_bytes: 10, delivery: 'unknown' })
    context.onActivity?.({ request_id: 'unowned-request', activity: 'headers', http_status: 200 })
    context.onActivity?.({ request_id: 'in-flight-request', activity: 'first_text', http_status: 200, delivery: 'accepted',
      first_event_ms: 2, first_text_ms: 3, response_chars: 4, last_event_ms: 3, received_events: 2,
      prompt: 'PRIVATE', reasoning: 'PRIVATE', input_tokens: 900, output_tokens: 900, failure_reason: 'PRIVATE' })
    return pending
  })
  const attempt = db.prepare('SELECT state,metrics FROM model_request_attempts WHERE task_id=?').get(observation.id) as { state: string; metrics: string }
  const task = db.prepare('SELECT state,usage FROM model_request_tasks WHERE id=?').get(observation.id) as { state: string; usage: string }
  assert.equal(attempt.state, 'dispatched'); assert.equal(task.state, 'running')
  assert.equal(JSON.parse(attempt.metrics).first_text_ms, 3); assert.equal(JSON.parse(attempt.metrics).received_events, 2)
  assert.ok(!attempt.metrics.includes('PRIVATE')); assert.ok(!('output_tokens' in JSON.parse(attempt.metrics)))
  assert.equal(JSON.parse(task.usage).pending_requests.length, 1); assert.equal(JSON.parse(task.usage).requests, 1)
  assert.deepEqual(trace, ['dispatch'])
  observation.run(() => {
    const context = currentModelRequestContext()!
    reservation.complete({ input_tokens: 8, output_tokens: 4 })
    context.onMetrics?.({ request_id: 'in-flight-request', delivery: 'completed', input_tokens: 8, output_tokens: 4 })
    context.onActivity?.({ request_id: 'in-flight-request', activity: 'event', delivery: 'accepted', received_events: 999 })
  })
  const settled = db.prepare('SELECT state,metrics FROM model_request_attempts WHERE task_id=?').get(observation.id) as { state: string; metrics: string }
  assert.equal(settled.state, 'settled'); assert.equal(JSON.parse(settled.metrics).delivery, 'completed')
  assert.ok(!('received_events' in JSON.parse(settled.metrics)))
  observation.finish('succeeded'); assert.deepEqual(trace, ['dispatch', 'metrics', 'finish'])
})

test('a stale activity callback cannot overwrite a resumed observation or affect storage failures', () => {
  const old = createModelRequestObservation({ taskId: 'activity-resumed', owner: 'job', label: 'old' })
  let callback: ((value: unknown) => void) | undefined
  old.run(() => {
    const context = currentModelRequestContext()!
    context.onDispatch?.({ request_id: 'old-activity', request_bytes: 1 })
    callback = context.onActivity
  })
  const resumed = createModelRequestObservation({ taskId: old.id, owner: 'job', label: 'resumed' })
  callback?.({ request_id: 'old-activity', activity: 'event', received_events: 10 })
  const oldAttempt = db.prepare('SELECT metrics FROM model_request_attempts WHERE task_id=? AND id=?').get(old.id, 'old-activity') as { metrics: string }
  assert.ok(!('received_events' in JSON.parse(oldAttempt.metrics)))
  db.exec("CREATE TEMP TRIGGER fail_activity_update BEFORE UPDATE ON model_request_attempts WHEN NEW.task_id='activity-resumed' BEGIN SELECT RAISE(FAIL,'activity storage unavailable'); END")
  const original = console.error; console.error = () => {}
  try {
    assert.equal(resumed.run(() => {
      const context = currentModelRequestContext()!
      context.onDispatch?.({ request_id: 'new-activity', request_bytes: 1 })
      context.onActivity?.({ request_id: 'new-activity', activity: 'headers', http_status: 200 })
      return 'unchanged result'
    }), 'unchanged result')
  } finally { console.error = original; db.exec('DROP TRIGGER fail_activity_update') }
  old.finish('failed'); resumed.finish('succeeded')
})

const provider = { adapter: 'http' as const, base_url: 'https://activity.invalid/v1' }
const encoded = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
const model = (protocol: 'responses' | 'chat_completions' | 'anthropic_messages') => ({ id: `activity-${protocol}`, remote_id: 'fixture',
  modality: 'text' as const, protocol, settings: { text_api: { mode: 'standard', max_output_tokens: 65536 }, context_window_tokens: 1_000_000 } })

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol}: activity is available before a real stream settles and excludes reasoning`, async t => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let headersReady!: () => void, textReady!: () => void
  const headers = new Promise<void>(resolve => { headersReady = resolve })
  const text = new Promise<void>(resolve => { textReady = resolve })
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
    { headers: { 'content-type': 'text/event-stream' } }))
  const activities: Record<string, unknown>[] = [], settlements: unknown[] = []
  let finished = false
  const pending = withModelRequestContext({ policy: modelTaskPolicies.text, onActivity: value => {
    const activity = value as Record<string, unknown>; activities.push(activity)
    if (activity.activity === 'headers') headersReady()
    if (activity.activity === 'first_text') textReady()
  }, onMetrics: value => settlements.push(value) }, () => streamText(model(protocol), provider, { prompt: 'PRIVATE manuscript' }))
  void pending.then(() => { finished = true })
  await headers
  assert.equal(finished, false); assert.equal(settlements.length, 0); assert.equal(activities[0]!.http_status, 200)
  if (protocol === 'anthropic_messages') {
    controller.enqueue(encoded({ type: 'message_start', message: { content: [], usage: { input_tokens: 10 } } }))
    controller.enqueue(encoded({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }))
    controller.enqueue(encoded({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE reasoning' } }))
    controller.enqueue(encoded({ type: 'content_block_stop', index: 0 }))
    controller.enqueue(encoded({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    controller.enqueue(encoded({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完成' } }))
  } else if (protocol === 'chat_completions') {
    controller.enqueue(encoded({ choices: [{ delta: { role: 'assistant', reasoning_content: 'PRIVATE reasoning' } }] }))
    controller.enqueue(encoded({ choices: [{ delta: { content: '完成' } }] }))
  } else {
    controller.enqueue(encoded({ type: 'response.created', response: { status: 'in_progress' } }))
    controller.enqueue(encoded({ type: 'response.output_text.delta', delta: '完成' }))
  }
  await text
  assert.equal(finished, false); assert.equal(settlements.length, 0)
  assert.deepEqual(activities.map(activity => activity.activity), ['headers', 'first_event', 'first_text'])
  assert.ok(!JSON.stringify(activities).includes('PRIVATE'))
  assert.equal(activities[2]!.response_chars, 2)
  if (protocol === 'anthropic_messages') {
    controller.enqueue(encoded({ type: 'content_block_stop', index: 1 }))
    controller.enqueue(encoded({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }))
    controller.enqueue(encoded({ type: 'message_stop' }))
  } else if (protocol === 'chat_completions') controller.enqueue(encoded({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
  else controller.enqueue(encoded({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }], usage: { input_tokens: 10, output_tokens: 2 } } }))
  controller.close()
  assert.equal(await pending, '完成'); assert.equal(settlements.length, 1)
})

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol}: a failed activity observer cannot change text or tool result`, async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(protocol === 'responses'
    ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }] }
    : protocol === 'chat_completions' ? { choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] }
      : { type: 'message', content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }))
  await withModelRequestContext({ policy: modelTaskPolicies.text, onActivity() { throw new Error('diagnostics unavailable') } }, async () => {
    assert.equal(await streamText(model(protocol), provider, { prompt: 'private' }), '完成')
    const result = await createTextToolTransport(model(protocol), provider, 'private', [], undefined, [], () => '')
    assert.equal(result.text, '完成'); assert.deepEqual(result.calls, [])
  })
})
