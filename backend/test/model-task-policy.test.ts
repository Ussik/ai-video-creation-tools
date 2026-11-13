import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext, resolveModelTaskPolicy } from '../src/modules/generation/model-task-policy.js'

test('all long business contracts have explicit generation policy rather than 8K fallback', () => {
  for (const name of ['controlled_storyboard', 'storyboard_scene_plan', 'storyboard_shot_batch', 'visual_profiles', 'shot_plan', 'complete_script']) {
    assert.equal(resolveModelTaskPolicy(name).outputTokens, 65536, name)
  }
  assert.equal(resolveModelTaskPolicy('reply_classification').recovery, 'atomic')
})
test('explicit policy is independent of contract spelling and survives nested async calls', async () => {
  const { z } = await import('zod')
  const seen: unknown[] = []
  for (const name of ['renamed_operation', 'renamed_again']) {
    await generateStructuredOutput(name, z.object({ value: z.string() }), async () => {
      await Promise.resolve(); seen.push(currentModelRequestContext()); return '{"value":"ok"}'
    }, 'source', { context: { policy: modelTaskPolicies.generation, taskId: 'task' } })
  }
  assert.equal((seen[0] as any).policy.outputTokens, 65536)
  assert.deepEqual(seen[0], seen[1])
  assert.equal(currentModelRequestContext(), undefined)
})
test('concurrent task scopes never leak identities', async () => {
  await Promise.all(['a', 'b'].map(taskId => withModelRequestContext({ taskId, policy: modelTaskPolicies.review }, async () => {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(currentModelRequestContext()?.taskId, taskId)
  })))
})


test('trace stages distinguish generation, review and repair without changing inherited execution policies', async () => {
  const { modelContextFor } = await import('../src/modules/generation/model-task-policy.js')
  const { textRequestTrace } = await import('../src/infrastructure/providers/text-request-plan.js')
  await withModelRequestContext({ taskId: 'same-operation', policy: modelTaskPolicies.generation }, async () => {
    for (const [name, expected] of [['controlled_storyboard', 'generation'], ['storyboard_directing_review', 'review'], ['storyboard_targeted_repair', 'repair']]) {
      const context = modelContextFor(name)
      assert.equal(context.traceStage, expected)
      assert.equal(context.taskId, 'same-operation')
      if (expected === 'repair') assert.equal(context.policy, modelTaskPolicies.generation)
      const trace = withModelRequestContext(context, textRequestTrace)
      assert.ok(!('trace_stage' in trace), 'trace-only stage must not extend strict public provider/activity metrics')
      assert.ok(!JSON.stringify(trace).includes(name))
    }
  })
})
