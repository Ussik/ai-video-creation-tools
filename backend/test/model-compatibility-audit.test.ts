import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { generateCompatibleStructuredText } from '../src/infrastructure/providers/text-output-capability.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const directory = await mkdtemp(join(tmpdir(), 'model-compatibility-audit-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { streamText } = await import('../src/infrastructure/providers/providers.js')
initDb()
db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'compatibility audit', now(), now())
after(async () => { db.close(); await rm(directory, { force: true, recursive: true }) })

const provider = { adapter: 'http' as const, base_url: 'https://compatibility-audit.invalid/v1' }
const contract = { name: 'script_source_story', schema: { type: 'object' } }
for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
  test(`${protocol} never downgrades or caches successful enforcement after a format rejection`, async () => {
    const model = { id: `cache-switch-${protocol}`, remote_id: 'remote-a', modality: 'text' as const, protocol, settings: '{}' }
    const before = JSON.stringify(model)
    const calls: Array<[string, string]> = []
    const generate = async (configured: typeof model) => {
      const mode = JSON.parse(configured.settings).structured_output_mode
      calls.push([configured.remote_id, mode])
      if (configured.remote_id === 'remote-a' && mode === 'json_schema') {
        throw new Error('文本模型返回 400: unsupported output_config.format json_schema')
      }
      return '{}'
    }
    await assert.rejects(generateCompatibleStructuredText(model, provider, 'first request', contract, undefined, generate), /unsupported/)
    await generateCompatibleStructuredText({ ...model, remote_id: 'remote-b' }, provider, 'new model', contract, undefined, generate)
    await assert.rejects(generateCompatibleStructuredText(model, provider, 'back to first model', contract, undefined, generate), /unsupported/)
    assert.deepEqual(calls, [
      ['remote-a', 'json_schema'], ['remote-b', 'json_schema'], ['remote-a', 'json_schema'],
    ])
    assert.equal(JSON.stringify(model), before, 'negotiation never mutates the saved model')
  })
}

const model = { id: 'chat-terminal-audit', remote_id: 'chat-fixture', modality: 'text' as const, protocol: 'chat_completions' as const,
  settings: { text_api: { mode: 'standard', max_output_tokens: 65536 }, context_window_tokens: 1_000_000 } }
const schema = z.object({ ok: z.boolean() }).strict()
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const partial = { choices: [{ delta: { content: '{"ok":' }, finish_reason: null }] }
const terminal = { error: { code: 'server_error', message: 'fixture terminal upstream failure' } }
const complete = () => sse([
  { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
])
const rows = (run: string) => db.prepare('SELECT state,delivery,result FROM source_model_requests WHERE run_id=?').all(run) as Array<{ state: string; delivery: string; result: string | null }>
function execute(run: string, identity: string, metrics: unknown[] = [], protocol: 'chat_completions' | 'responses' = 'chat_completions') {
  const generate = sourceModelRecovery('p', run, { source: identity }, async (_project, _model, prompt, output, signal) =>
    streamText({ ...model, protocol }, provider, { prompt, structured_output: output }, undefined, undefined, signal, value => metrics.push(value)))
  return generateStructuredOutput('script_source_story', schema,
    (prompt, output) => generate('p', model.id, prompt, output, new AbortController().signal), '完整原稿')
}

test('Chat Completions explicit terminal error after visible text retries once and only saves the completed response', async t => {
  let posts = 0
  const metrics: any[] = []
  t.mock.method(globalThis, 'fetch', async () => ++posts === 1 ? sse([partial, terminal]) : complete())
  assert.deepEqual(await execute('chat-terminal-success', 'chat-terminal-success', metrics), { ok: true })
  assert.equal(posts, 2)
  assert.equal(metrics.length, 2)
  assert.equal(metrics[0].response_terminated, true)
  assert.equal(metrics[0].delivery, 'output_started')
  assert.equal(metrics[0].raw_reason, 'server_error')
  assert.equal(metrics[0].response_chars, '{"ok":'.length)
  assert.equal(metrics[1].delivery, 'completed')
  assert.deepEqual(rows('chat-terminal-success').map(row => [row.state, row.delivery, row.result]), [['completed', 'completed', '{"ok":true}']])
})

test('Chat Completions explicit terminal errors exhaust one retry and allow only a later explicit continuation', async t => {
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => ++posts <= 2 ? sse([partial, terminal]) : complete())
  await assert.rejects(execute('chat-terminal-failed', 'chat-terminal-continue'), issue => issue instanceof TextProviderError && issue.upstreamCode === 'server_error')
  assert.equal(posts, 2)
  assert.deepEqual(rows('chat-terminal-failed').map(row => [row.state, row.result]), [['failed', null]])
  assert.deepEqual(await execute('chat-terminal-continued', 'chat-terminal-continue'), { ok: true })
  assert.equal(posts, 3)
})

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol} unknown EOF preserves machine-readable blocking across repeated continuations`, async t => {
  let posts = 0
  const identity = `${protocol}-unknown`
  t.mock.method(globalThis, 'fetch', async () => { posts++; return sse([protocol === 'chat_completions' ? partial : { type: 'response.output_text.delta', delta: '{"ok":' }]) })
  await assert.rejects(execute(`${identity}-original`, identity, [], protocol), issue => issue instanceof TextProviderError && issue.upstreamCode === 'stream_disconnected')
  assert.equal(posts, 1)
  for (const run of [`${identity}-continued-1`, `${identity}-continued-2`, `${identity}-continued-3`]) {
    await assert.rejects(execute(run, identity, [], protocol), { code: 'source_request_unknown', statusCode: 409, outcome_certainty: 'unknown' })
    assert.equal(posts, 1)
    assert.deepEqual(rows(`${identity}-original`).map(row => [row.state, row.result]), [['dispatched', null]])
  }
})

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
  test(`${protocol} preserves an authoritative dispatch-hook error without a fetch`, async t => {
    let posts = 0
    t.mock.method(globalThis, 'fetch', async () => { posts++; throw new Error('must not fetch') })
    const issue = Object.assign(new Error('fixture authoritative dispatch block'), { code: 'fixture_dispatch_block', statusCode: 409, outcome_certainty: 'unknown' })
    await assert.rejects(streamText({ ...model, protocol }, provider, { prompt: 'read-only fixture' }, undefined, undefined, undefined, undefined, () => { throw issue }), caught => caught === issue)
    assert.equal(posts, 0)
  })
  test(`${protocol} preserves cancellation without a fetch`, async t => {
    let posts = 0
    t.mock.method(globalThis, 'fetch', async () => { posts++; throw new Error('must not fetch') })
    const controller = new AbortController()
    const issue = Object.assign(new Error('fixture user cancelled'), { name: 'AbortError', code: 'fixture_cancelled' })
    controller.abort(issue)
    await assert.rejects(streamText({ ...model, protocol }, provider, { prompt: 'read-only fixture' }, undefined, undefined, controller.signal), caught => caught === issue)
    assert.equal(posts, 0)
  })
}
