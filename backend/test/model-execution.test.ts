import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { retryReadOnlyGeneration } from '../src/modules/generation/read-only-retry.js'
import { TextProviderError, textRetryAfter } from '../src/infrastructure/providers/text-errors.js'
import { claimModelAttempt, isUnrestrictedScriptExecution, modelAttemptNumber, modelStepSignal, remainingModelAttempts,
  remainingModelStepMs, runGenerationDeadline, runModelStep, withUnrestrictedScriptExecution } from '../src/modules/generation/model-execution.js'

test('network retries and contract correction together never exceed three actual calls', async () => {
  let calls = 0
  const generate = retryReadOnlyGeneration(async () => {
    calls++
    if (calls === 2) return '{"answer":42}'
    throw new TextProviderError('temporary', true)
  }, { wait: async () => {} })
  await assert.rejects(generateStructuredOutput('workflow_draft', z.object({ answer: z.string() }), generate, '保留故事要求'), /temporary/)
  assert.equal(calls, 3)
})

test('format correction inherits the remaining step budget instead of resetting its clock', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  let calls = 0, firstSignal: AbortSignal | undefined
  await assert.rejects(generateStructuredOutput('script_source_map', z.object({ answer: z.string() }), async () => {
    calls++
    const signal = modelStepSignal()!
    firstSignal ||= signal
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(calls === 1 ? 800 : 300)
    return calls === 1 ? '{}' : '{"answer":"late result"}'
  }, '原文不得省略', { budgetMs: 1000 }), /当前步骤处理超时/)
  assert.equal(calls, 2)
  assert.equal(firstSignal!.aborted, true)
})

test('provider Retry-After is honored and authorization failures are never retried', async () => {
  assert.equal(textRetryAfter('12'), 12000)
  assert.equal(textRetryAfter(new Date(20000).toUTCString(), 5000), 15000)
  let calls = 0
  const waits: number[] = []
  const generate = retryReadOnlyGeneration(async () => {
    if (++calls === 1) throw new TextProviderError('rate limited', true, undefined, 429, undefined, 12000)
    return 'complete'
  }, { wait: async ms => { waits.push(ms) }, random: () => 0 })
  assert.equal(await generate('test'), 'complete')
  assert.deepEqual(waits, [12000])
})

test('script execution removes cumulative attempt and business deadlines while preserving cancellation and isolation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const controller = new AbortController()
  await withUnrestrictedScriptExecution(() => runGenerationDeadline(controller.signal, 1, () =>
    runModelStep('script_review', controller.signal, async () => {
      assert.equal(isUnrestrictedScriptExecution(), true)
      for (let attempt = 0; attempt < 40; attempt++) claimModelAttempt()
      assert.equal(modelAttemptNumber(), 40)
      assert.equal(remainingModelAttempts(), Infinity)
      assert.equal(remainingModelStepMs(), Infinity)
      t.mock.timers.tick(181 * 60_000)
      assert.equal(modelStepSignal()!.aborted, false)
    }, 1)))
  assert.equal(isUnrestrictedScriptExecution(), false)
  await assert.rejects(runModelStep('ordinary_generation', undefined, async () => {
    for (let attempt = 0; attempt < 4; attempt++) claimModelAttempt()
  }), /模型请求上限/)
  const stopped = withUnrestrictedScriptExecution(() => runModelStep('script_review', controller.signal,
    () => new Promise<never>(() => {})))
  controller.abort(new Error('creator stopped'))
  await assert.rejects(stopped, /creator stopped/)
})
