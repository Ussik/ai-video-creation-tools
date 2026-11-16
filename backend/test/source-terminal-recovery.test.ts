import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
const directory = await mkdtemp(join(tmpdir(), 'source-terminal-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { streamText } = await import('../src/infrastructure/providers/providers.js')
initDb(); db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'terminal recovery', now(), now())
after(async () => { db.close(); await rm(directory, { force: true, recursive: true }) })
const model = { id: 'terminal-source-fixture', remote_id: 'claude-fixture', modality: 'text' as const, protocol: 'anthropic_messages' as const,
  settings: { text_api: { mode: 'standard', max_output_tokens: 65536 }, context_window_tokens: 1_000_000 } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const schema = z.object({ ok: z.boolean() }).strict()
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const begin = { type: 'message_start', message: { content: [], usage: { input_tokens: 10, output_tokens: 0 } } }
const partial = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '{"ok":' } }
const terminal = { type: 'error', error: { type: 'stream_read_error', message: 'upstream connection reset by peer' } }
const complete = () => sse([begin, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '{"ok":true}' } },
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])
function wrapped(run: string, identity: string, metrics: unknown[] = []) {
  return sourceModelRecovery('p', run, { source: identity }, async (_project, _model, prompt, contract, signal) =>
    streamText(model, provider, { prompt, structured_output: contract }, undefined, undefined, signal, value => metrics.push(value)))
}
const execute = (run: string, identity: string) => {
  const generate = wrapped(run, identity)
  return generateStructuredOutput('script_source_story', schema,
    (prompt, contract) => generate('p', model.id, prompt, contract, new AbortController().signal), '完整原稿')
}
const rows = (run: string) => db.prepare('SELECT state,delivery,result FROM source_model_requests WHERE run_id=?').all(run) as Array<{ state: string; delivery: string; result: string | null }>

test('source structured generation retries one explicit terminal SSE failure after text, then retains the complete output', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => ++posts === 1 ? sse([begin, partial, terminal]) : complete())
  assert.deepEqual(await execute('terminal-success', 'terminal-success'), { ok: true })
  assert.equal(posts, 2)
  assert.deepEqual(rows('terminal-success').map(row => [row.state, row.delivery]), [['completed', 'completed']])
  assert.equal(rows('terminal-success')[0]?.result, '{"ok":true}')
})

test('two terminal failures exhaust one local retry, but an explicit compatible continuation remains possible', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => { posts++; return posts <= 2 ? sse([begin, partial, terminal]) : complete() })
  await assert.rejects(execute('terminal-failed', 'terminal-retry'), issue => issue instanceof TextProviderError && issue.upstreamCode === 'stream_read_error')
  assert.equal(posts, 2)
  assert.deepEqual(rows('terminal-failed').map(row => [row.state, row.delivery]), [['failed', 'output_started']])
  assert.equal(rows('terminal-failed')[0]?.result, null, 'partial JSON never becomes a saved result')
  assert.deepEqual(await execute('terminal-continued', 'terminal-retry'), { ok: true })
  assert.equal(posts, 3)
})

test('an unknown SSE EOF never replays, and blocked adapter not_sent metrics cannot erase its dispatch barrier', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => { posts++; return sse([begin, partial]) })
  await assert.rejects(execute('unknown-original', 'unknown-eof'), issue => issue instanceof TextProviderError && issue.upstreamCode === 'stream_disconnected')
  assert.equal(posts, 1)
  for (const run of ['unknown-continued-1', 'unknown-continued-2', 'unknown-continued-3']) {
    await assert.rejects(execute(run, 'unknown-eof'), { code: 'source_request_unknown' })
    assert.equal(posts, 1)
    assert.equal(rows('unknown-original')[0]?.state, 'dispatched')
  }
})

test('terminal marker never grants replay to a non-source contract', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => { posts++; return sse([begin, partial, terminal]) })
  const generate = wrapped('non-source-original', 'non-source')
  const contract = { name: 'unrelated_source_like_task', schema: { type: 'object' } }
  const invoke = (request = generate) => request('p', model.id, 'same', contract, new AbortController().signal)
  await assert.rejects(invoke(), issue => issue instanceof TextProviderError && issue.upstreamCode === 'stream_read_error')
  await assert.rejects(invoke(wrapped('non-source-continued', 'non-source')), { code: 'source_request_unknown' })
  assert.equal(posts, 1)
})

test('aborted terminal source failure retains the dispatch barrier', async () => {
  const controller = new AbortController()
  const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
  const generate = sourceModelRecovery('p', 'terminal-cancel', { source: 'terminal-cancel' }, async () => {
    notifyTextRequest('dispatch', { delivery: 'unknown' })
    notifyTextRequest('metrics', { delivery: 'output_started' })
    controller.abort()
    const issue = new TextProviderError('终止但已取消', true, 'stream_read_error')
    Object.assign(issue, { responseTerminated: true, delivery: 'output_started' })
    throw issue
  })
  await assert.rejects(generate('p', model.id, 'cancel', { name: 'script_source_story', schema: {} }, controller.signal))
  assert.equal(rows('terminal-cancel')[0]?.state, 'dispatched')
})

test('terminal SSE diagnostics distinguish first text from first event and preserve unknown final usage', async t => {
  const metrics: any[] = []
  let time = 1000
  t.mock.method(Date, 'now', () => time++)
  t.mock.method(globalThis, 'fetch', async () => sse([begin, partial, terminal]))
  await assert.rejects(streamText(model, provider, { prompt: 'diagnostics' }, undefined, undefined, undefined, value => metrics.push(value)), issue => {
    assert.ok(issue instanceof TextProviderError)
    assert.equal(issue.responseTerminated, true)
    assert.equal(issue.failureReason, 'disconnected')
    assert.equal(issue.delivery, 'output_started')
    return true
  })
  assert.equal(metrics.length, 1)
  assert.equal(metrics[0].response_terminated, true)
  assert.ok(metrics[0].first_text_ms > metrics[0].first_event_ms)
  assert.equal(metrics[0].response_chars, '{"ok":'.length)
  assert.equal(metrics[0].delivery, 'output_started')
})

test('completed response persistence failure keeps the old dispatch blocked across adapter continuations', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => { posts++; return complete() })
  db.exec("CREATE TRIGGER terminal_completion_write_fail BEFORE UPDATE ON source_model_requests WHEN NEW.state='completed' AND NEW.run_id='terminal-complete-write-fail' BEGIN SELECT RAISE(ABORT,'fixture complete persistence error'); END")
  try { await assert.rejects(execute('terminal-complete-write-fail', 'terminal-write-fail'), /fixture complete persistence error/) }
  finally { db.exec('DROP TRIGGER terminal_completion_write_fail') }
  for (const run of ['terminal-complete-retry-1', 'terminal-complete-retry-2']) {
    await assert.rejects(execute(run, 'terminal-write-fail'), { code: 'source_request_unknown' })
    assert.equal(rows('terminal-complete-write-fail')[0]?.state, 'dispatched')
  }
  assert.equal(posts, 1)
})

test('accepted background response keeps its exact response identity and continues by GET after a failed poll', async t => {
  const backgroundModel = { ...model, id: 'background-source-fixture', protocol: 'responses' as const,
    settings: { ...model.settings, background_responses: true } }
  const contract = { name: 'script_source_story', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }
  let posts = 0, gets = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++
      return Response.json({ id: 'resp_source_terminal_background', status: 'in_progress' })
    }
    gets++
    assert.equal(String(url), 'https://fixture.invalid/v1/responses/resp_source_terminal_background')
    if (gets === 1) throw new Error('fixture background poll disconnected')
    return Response.json({ id: 'resp_source_terminal_background', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 5 } })
  })
  const request = (run: string) => sourceModelRecovery('p', run, { source: 'background-exact-identity' }, async (_project, _model, prompt, output, signal) =>
    streamText(backgroundModel, provider, { prompt, structured_output: output }, undefined, undefined, signal))
  const call = (run: string) => request(run)('p', backgroundModel.id, 'complete source background', contract, new AbortController().signal)
  await assert.rejects(call('background-original'), /fixture background poll disconnected/)
  assert.equal(await call('background-continued'), '{"ok":true}')
  assert.equal(posts, 1)
  assert.equal(gets, 2)
})

for (const policy of [
  { purpose: 'media_generation', readOnly: false, recovery: 'paid' as const },
  { purpose: 'tool_decision', readOnly: true, recovery: 'tool' as const },
]) test(`${policy.recovery} policy cannot settle or retry a source-named terminal failure`, async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => { posts++; return sse([begin, partial, terminal]) })
  const run = `excluded-policy-${policy.recovery}`
  const invoke = (runId: string) => {
    const configured = policy.readOnly ? { ...model, settings: { ...model.settings, structured_output_mode: 'json_schema' } } : model
    const request = sourceModelRecovery('p', runId, { source: run }, async (_project, _model, prompt, contract, signal) =>
      streamText(configured, provider, { prompt, structured_output: contract }, undefined, undefined, signal))
    return generateStructuredOutput('script_source_story', schema,
      (prompt, contract) => request('p', model.id, prompt, contract, new AbortController().signal), '完整原稿', { context: { policy } })
  }
  await assert.rejects(invoke(run), issue => issue instanceof TextProviderError && issue.responseTerminated)
  assert.equal(posts, 1)
  assert.equal(rows(run)[0]?.state, 'dispatched')
  await assert.rejects(invoke(`${run}-continued`), { code: 'source_request_unknown' })
  assert.equal(posts, 1)
  assert.equal(rows(run)[0]?.state, 'dispatched')
})

test('Responses response.failed after visible delta retries once and records terminal and first-text diagnostics', async t => {
  const responseModel = { ...model, id: 'responses-terminal-source-fixture', protocol: 'responses' as const }
  const metrics: any[] = []
  let posts = 0, time = 20000
  t.mock.method(Date, 'now', () => time++)
  t.mock.method(globalThis, 'fetch', async () => {
    posts++
    if (posts === 1) return sse([
      { type: 'response.created', response: { id: 'resp_terminal_1', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: '{"ok":' },
      { type: 'response.failed', response: { id: 'resp_terminal_1', status: 'failed', error: { code: 'server_error', message: 'fixture upstream failure' } } },
    ])
    return sse([
      { type: 'response.created', response: { id: 'resp_terminal_2', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: '{"ok":true}' },
      { type: 'response.completed', response: { id: 'resp_terminal_2', status: 'completed', output_text: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  })
  const request = sourceModelRecovery('p', 'responses-terminal-success', { source: 'responses-terminal' }, async (_project, _model, prompt, contract, signal) =>
    streamText(responseModel, provider, { prompt, structured_output: contract }, undefined, undefined, signal, metric => metrics.push(metric)))
  assert.deepEqual(await generateStructuredOutput('script_source_story', schema,
    (prompt, contract) => request('p', responseModel.id, prompt, contract, new AbortController().signal), '完整原稿'), { ok: true })
  assert.equal(posts, 2)
  assert.equal(metrics.length, 2)
  assert.equal(metrics[0].response_terminated, true)
  assert.equal(metrics[0].raw_reason, 'server_error')
  assert.equal(metrics[0].delivery, 'output_started')
  assert.equal(metrics[0].response_chars, '{"ok":'.length)
  assert.ok(metrics[0].first_text_ms > metrics[0].first_event_ms)
  assert.equal(metrics[1].delivery, 'completed')
  assert.ok(metrics[1].first_text_ms > metrics[1].first_event_ms)
  assert.deepEqual(rows('responses-terminal-success').map(row => [row.state, row.delivery]), [['completed', 'completed']])
})

test('accepted Messages connection failure before any visible text preserves its first diagnostic without a blocked retry attempt', async t => {
  let posts = 0, chunks = 0
  const metrics: Array<Record<string, unknown>> = []
  const encoder = new TextEncoder()
  t.mock.method(globalThis, 'fetch', async () => {
    posts++
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ === 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify(begin)}\n\n`))
        else controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }))
      },
    }), { headers: { 'Content-Type': 'text/event-stream', 'request-id': 'exact-upstream-before-first-text' } })
  })
  const request = wrapped('accepted-no-text', 'accepted-no-text', metrics)
  await assert.rejects(generateStructuredOutput('script_source_story', schema,
    (prompt, contract) => request('p', model.id, prompt, contract, new AbortController().signal), '完整原稿'), issue => {
      assert.ok(issue instanceof TextProviderError)
      assert.equal(issue.upstreamCode, 'connection_error'); assert.equal(issue.delivery, 'accepted'); assert.equal(issue.responseTerminated, false)
      assert.equal(issue.providerDiagnostics?.upstream_request_id, 'exact-upstream-before-first-text')
      assert.equal(issue.partialText, ''); return true
    })
  assert.equal(posts, 1); assert.equal(metrics.length, 1, 'no second not_sent adapter attempt may obscure the original accepted failure')
  assert.equal(metrics[0]?.delivery, 'accepted'); assert.equal(metrics[0]?.upstream_request_id, 'exact-upstream-before-first-text')
  assert.deepEqual(rows('accepted-no-text').map(row => [row.state, row.result]), [['dispatched', null]])
})
