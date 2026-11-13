import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderExecutionError } from '../src/infrastructure/providers/provider-failure.js'
import { aiErrorFields } from '../src/modules/generation/ai-operation-errors.js'
import { ModelWorkflowBudgetError } from '../src/modules/generation/model-workflow-budget.js'
import { observeModelQualityReview } from '../src/modules/generation/model-quality-review.js'
const testData = await mkdtemp(join(tmpdir(), 'script-review-machine-error-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { ScriptDraftReviewError } = await import('../src/modules/script/script-draft-completeness.js')
const { db } = await import('../src/infrastructure/database/db.js')
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

test('labeling a provider review failure preserves public machine facts and its original cause', () => {
  const original = new ProviderExecutionError('safe provider detail', { reason: 'authentication', stage: 'query', delivery: 'rejected',
    upstreamStatus: 401, upstreamCode: 'invalid_api_key', retryAfterMs: 1200, provider_request_id: 'request:1' })
  const error = new ScriptDraftReviewError(original, 'source_analysis')
  assert.equal(error.cause, original); assert.match(error.message, /^剧本来源分析未完成/)
  assert.deepEqual(aiErrorFields(error, error.statusCode), { code: 'provider_authentication', category: 'authentication', retryable: false,
    outcome_certainty: 'completed', recovery: { kind: 'none' }, reason: 'authentication', failure_stage: 'query',
    upstream_status: 401, upstream_code: 'invalid_api_key', retry_after_ms: 1200 })
  assert.equal((error as unknown as Record<string, unknown>).provider_request_id, 'request:1')
})

test('review labels retain only bounded machine fields and never promote private payloads', () => {
  const original = Object.assign(new Error('safe label'), { raw_output: 'private payload', rawReason: 'private reason',
    upstreamCode: 'unsafe\ncredential', reason: 'private reason', failure_stage: 'private stage', delivery: 'invented', retryAfterMs: Infinity })
  const error = new ScriptDraftReviewError(original)
  for (const key of ['raw_output', 'rawReason', 'upstreamCode', 'reason', 'failure_stage', 'delivery', 'retryAfterMs']) assert.equal(Object.hasOwn(error, key), false)
  assert.equal(error.cause, original)
})

test('budget exhaustion in an independent review remains the original stop and never becomes a review retry', async () => {
  const stop = new ModelWorkflowBudgetError('script', 'requests', false)
  await assert.rejects(observeModelQualityReview('recheck', async () => { throw stop }, { issues: () => undefined, previousIssues: ['old'] }),
    issue => issue === stop && issue.canResume === false && issue.retryable === false)
})
