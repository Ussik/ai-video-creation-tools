import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { modelContractStage, type ModelResultEvent, type ModelOperationStage } from '../src/infrastructure/observability/model-results.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { withModelOperationStage } from '../src/modules/generation/model-result-observation.js'

test('only the explicit source quality repair contract gains the content repair mapping', () => {
  assert.equal(modelContractStage('script_source_quality_repair'), 'content_repair')
  assert.equal(modelContractStage('script_source_quality_repair_structure_repair'), 'content_repair')
  assert.equal(modelContractStage('script_source_quality'), 'source_review')
  assert.equal(modelContractStage('script_source_quality_structure_repair'), 'source_review')
  assert.equal(modelContractStage('script_source_quality_review'), 'source_review')
  assert.equal(modelContractStage('script_source_quality_repair_other'), 'source_review')
  assert.equal(modelContractStage('script_source_map'), 'source_directory')
  assert.equal(modelContractStage('script_source_story_timeline'), 'source_timeline')
  assert.equal(modelContractStage('unrelated_quality_repair'), undefined)
})

test('actual structured output reports content repair for initial quality repair and its structure repair contract', async t => {
  for (const name of ['script_source_quality_repair', 'script_source_quality_repair_structure_repair']) await t.test(name, async () => {
    const results: ModelResultEvent[] = []
    let calls = 0
    const value = await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: result => results.push(result) }, () =>
      generateStructuredOutput(name, z.object({ value: z.string() }), async (_prompt, contract, context) => {
        calls++
        assert.equal(contract!.name, name)
        assert.equal(context?.operationStage, 'content_repair')
        assert.equal(currentModelRequestContext()?.operationStage, 'content_repair')
        assert.equal(context?.traceStage, 'repair')
        assert.equal(context?.policy, modelTaskPolicies.generation)
        return '{"value":"retained"}'
      }, 'fixture source'))
    assert.deepEqual(value, { value: 'retained' })
    assert.equal(calls, 1)
    assert.deepEqual(results.map(({ phase, status, stage }) => ({ phase, status, stage })), [
      { phase: 'structure', status: 'valid', stage: 'content_repair' },
    ])
    assert.equal(currentModelRequestContext(), undefined)
  })
})

test('actual source quality review still reports source review with review policy', async () => {
  const results: ModelResultEvent[] = []
  await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: result => results.push(result) }, () =>
    generateStructuredOutput('script_source_quality', z.object({ value: z.string() }), async (_prompt, _contract, context) => {
      assert.equal(context?.operationStage, 'source_review')
      assert.equal(currentModelRequestContext()?.operationStage, 'source_review')
      assert.equal(context?.policy, modelTaskPolicies.review)
      return '{"value":"reviewed"}'
    }, 'fixture source'))
  assert.deepEqual(results.map(({ phase, status, stage }) => ({ phase, status, stage })), [
    { phase: 'structure', status: 'valid', stage: 'source_review' },
  ])
})

test('initial quality repair diagnostics change while second-round structure repair stays format correction', async () => {
  const results: ModelResultEvent[] = [], stages: unknown[] = []
  let calls = 0
  const value = await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: result => results.push(result) }, () =>
    generateStructuredOutput('script_source_quality_repair', z.object({ value: z.string().max(5) }), async (_prompt, contract, context) => {
      stages.push([contract!.name, context?.operationStage, currentModelRequestContext()?.operationStage, context?.traceStage])
      return ++calls === 1 ? '{"value":"too long"}' : '{"repairs":{"repair_0":"fixed"}}'
    }, 'fixture source', { structuralRepair: true }))
  assert.deepEqual(value, { value: 'fixed' })
  assert.deepEqual(stages, [
    ['script_source_quality_repair', 'content_repair', 'content_repair', 'repair'],
    ['script_source_quality_repair_structure_repair', 'format_correction', 'format_correction', 'repair'],
  ])
  assert.deepEqual(results.map(({ phase, status, stage }) => ({ phase, status, stage })), [
    { phase: 'structure', status: 'invalid_contract', stage: 'content_repair' },
    { phase: 'structure', status: 'valid', stage: 'format_correction' },
  ])
})

test('an inherited recheck remains recheck until any actual second format round', async t => {
  for (const correction of [false, true]) await t.test(correction ? 'with second format round' : 'valid initial response', async () => {
    const results: ModelResultEvent[] = [], stages: ModelOperationStage[] = []
    let calls = 0
    await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: result => results.push(result) }, () =>
      withModelOperationStage('recheck', () => generateStructuredOutput('script_source_quality_repair', z.object({ value: z.string() }),
        async (_prompt, _contract, context) => {
          stages.push(context!.operationStage!)
          assert.equal(currentModelRequestContext()?.operationStage, context?.operationStage)
          assert.equal(context?.policy, modelTaskPolicies.review, 'explicit policy is unchanged by a diagnostic mapping')
          return ++calls === 1 && correction ? '{"value":1}' : '{"value":"retained"}'
        }, 'fixture source', { context: { policy: modelTaskPolicies.review } })))
    assert.deepEqual(stages, correction ? ['recheck', 'format_correction'] : ['recheck'])
    assert.deepEqual(results.map(result => result.stage), stages)
    assert.equal(currentModelRequestContext(), undefined)
  })
})
