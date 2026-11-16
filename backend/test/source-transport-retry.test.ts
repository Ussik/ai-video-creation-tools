import assert from 'node:assert/strict'
import test from 'node:test'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { retryReadOnlyRequest } from '../src/modules/generation/read-only-retry.js'

function interrupted(terminal: boolean) {
  return Object.assign(new TextProviderError('interrupted stream', true, 'stream_read_error'), {
    responseTerminated: terminal, delivery: 'output_started' as const, outputStarted: true, partialText: '{"unfinished":',
  })
}

test('source read-only terminal output can be discarded for one bounded retry', async () => {
  let calls = 0, waits = 0
  const result = await retryReadOnlyRequest(async () => { if (++calls === 1) throw interrupted(true); return 'complete' },
    { retryTerminatedOutput: true, wait: async () => { waits++ } })
  assert.equal(result, 'complete'); assert.equal(calls, 2); assert.equal(waits, 1)
})

test('persistent terminal failures stop after the second request', async () => {
  let calls = 0
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw interrupted(true) },
    { retryTerminatedOutput: true, wait: async () => {} }), /interrupted stream/)
  assert.equal(calls, 2)
})

test('unknown partial output and non-source callers never acquire terminal replay implicitly', async () => {
  for (const [terminal, enabled] of [[false, true], [true, false]] as const) {
    let calls = 0
    await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw interrupted(terminal) },
      { retryTerminatedOutput: enabled, wait: async () => { throw new Error('must not wait') } }), /interrupted stream/)
    assert.equal(calls, 1)
  }
})

test('cancellation during the permitted backoff prevents the second dispatch', async () => {
  const controller = new AbortController(); let calls = 0
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw interrupted(true) }, {
    signal: controller.signal, retryTerminatedOutput: true,
    onRetry: () => controller.abort(), wait: async (_ms, signal) => { signal?.throwIfAborted() },
  }), /abort/i)
  assert.equal(calls, 1)
})

test('source retry requires known-safe delivery or explicit upstream termination even when no text arrived', async t => {
  for (const delivery of ['not_sent', 'rejected', 'accepted', 'unknown', 'output_started', 'completed'] as const) {
    for (const terminated of [false, true]) await t.test(`${delivery}, terminal=${terminated}`, async () => {
      let calls = 0, waits = 0, retries = 0
      const issue = Object.assign(new TextProviderError('original connection diagnostic', true, 'connection_error', 200), {
        delivery, responseTerminated: terminated, outputStarted: false, partialText: '',
        providerDiagnostics: { upstream_request_id: 'original-upstream', http_status: 200, elapsed_ms: 1234, response_chars: 0, partial_text_incomplete: true, input_tokens: 79637 },
      })
      const invoke = () => retryReadOnlyRequest(async () => { if (++calls === 1) throw issue; return 'complete' }, {
        retryTerminatedOutput: true, onRetry: () => { retries++ }, wait: async () => { waits++ },
      })
      if (!terminated && ['accepted', 'unknown', 'output_started'].includes(delivery)) {
        await assert.rejects(invoke(), error => error === issue)
        assert.equal(calls, 1); assert.equal(waits, 0); assert.equal(retries, 0)
        assert.equal(issue.upstreamCode, 'connection_error'); assert.equal(issue.responseTerminated, false)
        assert.equal(issue.providerDiagnostics.upstream_request_id, 'original-upstream')
        assert.equal((issue as unknown as { retryAt?: number }).retryAt, undefined)
      } else {
        assert.equal(await invoke(), 'complete'); assert.equal(calls, 2); assert.equal(waits, 1); assert.equal(retries, 1)
      }
    })
  }
})

test('source unknown-delivery protection also wins over discardIncompleteOutput and preserves the original error object', async () => {
  const issue = Object.assign(new TextProviderError('accepted before first text', true, 'connection_error', 200), { delivery: 'accepted' as const })
  let calls = 0
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw issue }, {
    retryTerminatedOutput: true, discardIncompleteOutput: true,
    onRetry: () => { throw new Error('must not hide original error with retry') }, wait: async () => {},
  }), error => error === issue)
  assert.equal(calls, 1)
})

test('non-source zero-text failures also preserve unknown delivery without retry', async () => {
  let calls = 0, waits = 0
  const issue = Object.assign(new TextProviderError('generic read-only network failure', true, 'connection_error'), { delivery: 'unknown' as const })
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw issue }, { wait: async () => { waits++ } }), error => error === issue)
  assert.equal(calls, 1); assert.equal(waits, 0)
})

test('global unknown barrier wins over every discard policy and retains diagnostics for every transient transport label', async () => {
  for (const delivery of ['accepted', 'unknown', 'output_started'] as const) {
    for (const rawReason of ['headers_timeout', 'first_event_timeout', 'event_idle_timeout', 'connection_error', 'server_error']) {
      for (const options of [{}, { discardIncompleteOutput: true }, { retryTerminatedOutput: true }, { discardIncompleteOutput: true, retryTerminatedOutput: true }]) {
        const issue = Object.assign(new TextProviderError('original unknown diagnostic', true, rawReason), {
          delivery, outputStarted: delivery === 'output_started', partialText: delivery === 'output_started' ? 'incomplete' : '',
          providerDiagnostics: { upstream_request_id: 'retained-request', elapsed_ms: 42, response_chars: 10, partial_text_incomplete: true },
        })
        let calls = 0, waits = 0, retries = 0
        await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw issue }, { ...options,
          wait: async () => { waits++ }, onRetry: () => { retries++ } }), error => error === issue)
        assert.equal(calls, 1); assert.equal(waits, 0); assert.equal(retries, 0)
        assert.equal(issue.providerDiagnostics.upstream_request_id, 'retained-request')
        assert.equal((issue as TextProviderError & { retryAt?: number }).retryAt, undefined)
      }
    }
  }
})
