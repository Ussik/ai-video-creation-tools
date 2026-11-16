import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
import { retryReadOnlyRequest } from '../src/modules/generation/read-only-retry.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { textHeadersTimeoutMs } from '../src/infrastructure/providers/text-transport-boundary.js'

const directory = await mkdtemp(join(tmpdir(), 'unknown-headers-retry-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { streamText } = await import('../src/infrastructure/providers/providers.js')
after(() => rm(directory, { recursive: true, force: true }))
const model = { id: 'unknown-header-fixture', remote_id: 'fixture', modality: 'text' as const, protocol: 'anthropic_messages' as const,
  settings: { text_api: { mode: 'standard', max_output_tokens: 65536 }, structured_output_mode: 'json_schema' } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }

test('a workset structured request with no HTTP headers dispatches once and preserves unknown delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, dispatched = 0, wireSignal: AbortSignal | undefined
  const metrics: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++; wireSignal = init.signal!
    return new Promise<Response>((_resolve, reject) => wireSignal!.addEventListener('abort', () => reject(wireSignal!.reason), { once: true }))
  })
  const pending = generateStructuredOutput('script_draft_workset_candidate', z.object({ summary: z.string(), edits: z.array(z.unknown()) }).strict(),
    (prompt, contract) => streamText(model, provider, { prompt, structured_output: contract }, undefined, undefined, undefined,
      value => metrics.push(value), () => { dispatched++ }), 'same frozen workset')
  const rejected = assert.rejects(pending, error => {
    assert.ok(error instanceof TextProviderError)
    assert.equal(error.rawReason, 'headers_timeout'); assert.equal(error.delivery, 'unknown'); assert.equal(error.outputStarted, false)
    assert.equal(error.responseTerminated, false); assert.equal(error.retryable, true)
    return true
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  assert.equal(calls, 1); t.mock.timers.tick(textHeadersTimeoutMs); await rejected
  assert.equal(calls, 1); assert.equal(dispatched, 1); assert.equal(wireSignal!.aborted, true)
  assert.equal(metrics.length, 1); assert.equal(metrics[0].delivery, 'unknown'); assert.equal(metrics[0].http_status, undefined)
})

test('discarding an incomplete draft never turns an unknown headers timeout into retry authorization', async () => {
  const error = Object.assign(new TextProviderError('original headers diagnostic', true, 'headers_timeout'), { delivery: 'unknown' as const })
  let calls = 0, waits = 0, retries = 0
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw error }, { discardIncompleteOutput: true,
    wait: async () => { waits++ }, onRetry: () => { retries++ } }), issue => issue === error)
  assert.equal(calls, 1); assert.equal(waits, 0); assert.equal(retries, 0)
  assert.equal((error as TextProviderError & { retryAt?: number }).retryAt, undefined)
})

test('known not-sent or rejected delivery retains the existing bounded retry despite the timeout label', async () => {
  for (const delivery of ['not_sent', 'rejected'] as const) {
    let calls = 0, waits = 0
    const error = Object.assign(new TextProviderError('not an unknown dispatched request', true, 'headers_timeout'), { delivery })
    assert.equal(await retryReadOnlyRequest(async () => { if (++calls === 1) throw error; return 'complete' }, { wait: async () => { waits++ } }), 'complete')
    assert.equal(calls, 2); assert.equal(waits, 1)
  }
})

test('an explicitly terminated upstream error keeps its existing replay policy and one-retry bound', async () => {
  let calls = 0, waits = 0
  const error = Object.assign(new TextProviderError('explicit upstream terminal error', true, 'headers_timeout'), { delivery: 'unknown' as const, responseTerminated: true })
  assert.equal(await retryReadOnlyRequest(async () => { if (++calls === 1) throw error; return 'complete' },
    { retryTerminatedOutput: true, wait: async () => { waits++ } }), 'complete')
  assert.equal(calls, 2); assert.equal(waits, 1)
})

test('generic zero-text connection failure is also protected globally, not just headers timeouts', async () => {
  let calls = 0
  const error = Object.assign(new TextProviderError('different existing transport policy', true, 'connection_error'), { delivery: 'unknown' as const })
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw error }, { wait: async () => { assert.fail('unknown requests cannot back off') } }), issue => issue === error)
  assert.equal(calls, 1)
})


test('workset contracts retain any unterminated dispatched failure instead of automatically replaying it', async () => {
  for (const name of ['script_draft_workset_decisions', 'script_draft_workset_candidate', 'script_draft_workset_source']) {
    for (const delivery of ['unknown', 'accepted', 'output_started'] as const) {
      const error = Object.assign(new TextProviderError('uncertain processing', true, 'connection_error'), { delivery })
      let calls = 0, retries = 0
      await assert.rejects(generateStructuredOutput(name, z.object({ ok: z.boolean() }).strict(),
        async () => { calls++; throw error }, 'same bound workset', { onRetry: () => { retries++ } }), issue => issue === error)
      assert.equal(calls, 1, name + ':' + delivery); assert.equal(retries, 0)
    }
  }
})

test('workset contracts still retry explicitly terminated responses and safe unsent requests within the existing bound', async () => {
  for (const variant of ['not_sent', 'rejected', 'terminated'] as const) {
    const error = Object.assign(new TextProviderError('known failure', true, 'connection_error'), {
      delivery: variant === 'terminated' ? 'output_started' as const : variant, responseTerminated: variant === 'terminated' })
    let calls = 0
    const result = await generateStructuredOutput('script_draft_workset_source', z.object({ ok: z.boolean() }).strict(),
      async () => { if (++calls === 1) throw error; return '{"ok":true}' }, 'same source check')
    assert.deepEqual(result, { ok: true }); assert.equal(calls, 2)
  }
})
