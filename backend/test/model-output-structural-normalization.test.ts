import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'

const schema = z.object({ scenes: z.array(z.object({ scene_duration: z.number().int().positive(), title: z.string().trim(),
  note: z.string().optional(), version: z.number().default(1) }).strict()) }).strict()
const candidate = () => ({ scenes: [{ scene_duration: '30', title: ' 镜头标题 ', note: null }] })
const patch = { repairs: { repair_0: 30 } }

test('real structured repair permits schema trim, defaults and wire optional nulls, then replays without dispatch', async () => {
  let calls = 0
  const checkpoint: StructuredOutputCheckpoint = {}, events: any[] = []
  const options = { structuralRepair: true, stopOnBusinessError: true, checkpoint, freezeCorrection: true,
    validate(value: z.infer<typeof schema>) { assert.equal(value.scenes[0]!.title, '镜头标题'); assert.equal(value.scenes[0]!.scene_duration, 30) } }
  const result = await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => events.push(event) }, () =>
    generateStructuredOutput('storyboard_scene_plan', schema, async () => JSON.stringify(++calls === 1 ? candidate() : patch), '原任务', options))
  assert.deepEqual(result, { scenes: [{ scene_duration: 30, title: '镜头标题', version: 1 }] })
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(checkpoint.original_raw!), candidate())
  assert.deepEqual(JSON.parse(checkpoint.correction!.raw), patch)
  const changes = events.flatMap(event => event.structural_changes || [])
  assert.ok(changes.some(change => change.source === 'schema_normalization' && change.field_path === '$.scenes[0].title'))
  assert.ok(changes.some(change => change.source === 'schema_normalization' && change.field_path === '$.scenes[0].version'))
  assert.deepEqual(await generateStructuredOutput('storyboard_scene_plan', schema, async () => assert.fail('local replay must not dispatch'), '原任务',
    { ...options, checkpoint: structuredClone(checkpoint) }), result)
})

test('business validator mutation is distinguished from legal schema normalization with exact paths and hashes', async () => {
  let calls = 0
  const checkpoint: StructuredOutputCheckpoint = {}, events: any[] = []
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => events.push(event) }, () =>
    generateStructuredOutput('storyboard_scene_plan', schema, async () => JSON.stringify(++calls === 1 ? candidate() : patch), '原任务',
      { structuralRepair: true, stopOnBusinessError: true, checkpoint, validate(value) { value.scenes[0]!.title = 'validator unauthorized rewrite' } })), (error: any) => {
    assert.equal(error.code, 'structural_validator_outside_targets')
    assert.equal(error.failure_stage, 'business_validation')
    assert.equal(error.field_path, '$.scenes[0].title')
    const changes = JSON.parse(error.diagnostics)
    assert.equal(changes[0].source, 'business_validation')
    assert.match(changes[0].before_hash, /^[a-f0-9]{64}$/)
    assert.match(changes[0].after_hash, /^[a-f0-9]{64}$/)
    assert.notEqual(changes[0].before_hash, changes[0].after_hash)
    assert.ok(!error.diagnostics.includes('unauthorized rewrite'))
    return true
  })
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(checkpoint.original_raw!), candidate())
  assert.deepEqual(JSON.parse(checkpoint.correction!.raw), patch)
  assert.ok(events.some(event => event.failure_code === 'structural_validator_outside_targets'))
})

test('extra model rewrite is rejected at patch merge, never hidden as schema normalization', async () => {
  let calls = 0, validated = false
  const checkpoint: StructuredOutputCheckpoint = {}
  const illegal = { ...patch, scenes: [{ title: 'model unauthorized rewrite' }] }
  await assert.rejects(generateStructuredOutput('storyboard_scene_plan', schema, async () => JSON.stringify(++calls === 1 ? candidate() : illegal), '原任务',
    { structuralRepair: true, stopOnBusinessError: true, checkpoint, validate() { validated = true } }), (error: any) => {
      assert.equal(error.code, 'structural_patch_contract')
      assert.equal(error.failure_stage, 'patch_merge')
      return true
    })
  assert.equal(calls, 2); assert.equal(validated, false)
  assert.deepEqual(JSON.parse(checkpoint.original_raw!), candidate())
  assert.deepEqual(JSON.parse(checkpoint.correction!.raw), illegal)
})


test('arbitrary schema transforms outside targets do not masquerade as safe normalization', async () => {
  const transformed = z.object({ keep: z.string().transform(() => 'unrelated rewritten content'), fix: z.number() }).strict()
  let calls = 0
  await assert.rejects(generateStructuredOutput('normalization_guard', transformed, async () => JSON.stringify(++calls === 1
    ? { keep: 'original', fix: '30' } : { repairs: { repair_0: 30 } }), '原任务', { structuralRepair: true, stopOnBusinessError: true }),
    (error: any) => error.code === 'structural_schema_outside_targets' && error.failure_stage === 'schema_normalization')
  assert.equal(calls, 2)
})


test('schema-added defaults and restored optional fields do not grant the validator permission to rewrite them', async () => {
  for (const field of ['version', 'note'] as const) {
    let calls = 0
    await assert.rejects(generateStructuredOutput('storyboard_scene_plan', schema, async () => JSON.stringify(++calls === 1 ? candidate() : patch), '原任务', {
      structuralRepair: true, stopOnBusinessError: true,
      validate(value) { if (field === 'version') value.scenes[0]!.version = 2; else value.scenes[0]!.note = 'injected optional field' },
    }), (error: any) => error.code === 'structural_validator_outside_targets' && error.field_path === `$.scenes[0].${field}`)
    assert.equal(calls, 2)
  }
})
