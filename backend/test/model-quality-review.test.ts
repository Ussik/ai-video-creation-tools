import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeModelQualityReview } from '../src/modules/generation/model-quality-review.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import type { ModelResultEvent } from '../src/infrastructure/observability/model-results.js'
import { ModelWorkflowBudgetError } from '../src/modules/generation/model-workflow-budget.js'

function scope(work: () => Promise<unknown>) {
  const results: ModelResultEvent[] = []
  const task = withModelRequestContext({ policy: modelTaskPolicies.review, onResult: event => results.push(event) }, work)
  return { task, results }
}
const issues = (error: unknown) => Array.isArray(error) ? error as string[] : undefined

test('a complete independent check passes while preserving its returned candidate', async () => {
  const candidate = { content: 'retained candidate' }
  const f = scope(() => observeModelQualityReview('script_review', async () => {
    assert.equal(currentModelRequestContext()?.operationStage, 'script_review'); return candidate
  }, { issues }))
  assert.equal(await f.task, candidate)
  assert.deepEqual(f.results.map(({ phase, status, stage, issue_count }) => ({ phase, status, stage, issue_count })),
    [{ phase: 'quality', status: 'passed', stage: 'script_review', issue_count: 0 }])
})

test('repair effectiveness uses exact issue identities and preserves blocking outcomes', async () => {
  for (const [after, effect] of [[['a'], 'improved'], [['a', 'b'], 'unchanged'], [['new'], 'regressed']] as const) {
    const f = scope(() => observeModelQualityReview('recheck', async () => { throw after }, { issues, previousIssues: ['a', 'b'] }))
    await assert.rejects(f.task, value => value === after)
    assert.equal(f.results[0]?.status, 'needs_work'); assert.equal(f.results[0]?.repaired, true)
    assert.equal(f.results[0]?.repair_effect, effect)
  }
})

test('budget exhaustion and provider interruption remain inconclusive and retain the original machine error', async () => {
  for (const issue of [new ModelWorkflowBudgetError('source_analysis', 'tokens', true), new Error('provider disconnected')]) {
    const f = scope(() => observeModelQualityReview('recheck', async () => { throw issue }, { issues, previousIssues: ['a'] }))
    await assert.rejects(f.task, value => value === issue)
    assert.equal(f.results[0]?.status, 'inconclusive'); assert.equal(f.results[0]?.repair_effect, undefined)
    assert.equal(f.results[0]?.issue_count, undefined)
  }
})
