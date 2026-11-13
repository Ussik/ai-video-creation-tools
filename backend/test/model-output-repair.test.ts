import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, restoreOptionalNulls, type OutputContract } from '../src/modules/generation/model-output.js'
import { applyStructuralRepair, planStructuralRepair } from '../src/modules/generation/model-output-repair.js'
import { retryReadOnlyGeneration } from '../src/modules/generation/read-only-retry.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext, type ModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const nonempty = z.string().min(1)
const direction = z.object({ anchors: nonempty, blocking: nonempty, axis: nonempty, dramatic_progression: nonempty,
  sound: z.object({ ambience: nonempty, music_policy: z.enum(['timeline', 'source']) }).strict() }).strict()
const shot = z.object({ shot_id: nonempty, title: nonempty, audio_plan: z.object({ dialogue: z.array(z.string()), sound_effects: z.array(z.string()) }).strict(),
  directing: z.object({ cut: z.object({ type: z.enum(['continuity', 'ending']), cut_moment: nonempty, carry_over: nonempty, reason: nonempty }).strict() }).strict() }).strict()
const schema = z.object({ scenes: z.array(z.object({ scene_id: nonempty, scene_direction: direction, shots: z.array(shot) }).strict()) }).strict()
const goodDirection = { anchors: '门、桌与窗保持固定关系', blocking: '甲站门侧，乙坐窗侧', axis: '摄影机保持关系轴南侧', dramatic_progression: '从试探到确认',
  sound: { ambience: '室内低声底噪', music_policy: 'timeline' as const } }
const goodShot = (id: string, ending = false) => ({ shot_id: id, title: id + ' 不可重写正文', audio_plan: { dialogue: ['原对白，逐字保留。'], sound_effects: ['门锁轻响'] },
  directing: { cut: { type: ending ? 'ending' as const : 'continuity' as const, cut_moment: '甲停在门口', carry_over: ending ? '停留于门锁收束' : '下一镜接甲停步后的视线', reason: '给出乙的反应' } } })
const fixture = () => ({ scenes: [{ scene_id: 'scene-a', scene_direction: structuredClone(goodDirection), shots: [goodShot('shot-a'), goodShot('shot-b', true)] },
  { scene_id: 'scene-b', scene_direction: structuredClone(goodDirection), shots: [goodShot('shot-c', true)] }] })
const badFixture = () => {
  const candidate: any = fixture()
  candidate.scenes[0].scene_direction = { sound: structuredClone(goodDirection.sound), staging: '旧字段', emotional_arc: '旧推进字段' }
  candidate.scenes[0].shots[0].directing.cut.carry_over = ''
  return candidate
}
const repaired = () => ({ repairs: { repair_0: structuredClone(goodDirection), repair_1: '下一镜接甲停步后的视线' } })

test('structural correction fixes scene direction and one empty carry-over while preserving every other shot, ID and audio value', async () => {
  const candidate = badFixture(), before = structuredClone(candidate), contexts: Array<ModelRequestContext | undefined> = [], contracts: OutputContract[] = [], rounds: number[] = []
  let calls = 0, validated = 0
  const result = await generateStructuredOutput('storyboard_shot_batch', schema, async (prompt, contract, context) => {
    contexts.push(context); contracts.push(contract!)
    if (++calls === 1) return JSON.stringify(candidate)
    assert.equal(contract!.name, 'storyboard_shot_batch_structure_repair')
    assert.match(prompt, /一次结构定向修复/)
    assert.match(prompt, /scene_direction/)
    assert.match(prompt, /carry_over/)
    assert.ok(prompt.endsWith('原始选定场次资料'))
    const repairs = (contract!.schema.properties as any).repairs
    assert.deepEqual(repairs.required, ['repair_0', 'repair_1'])
    assert.equal(repairs.additionalProperties, false)
    assert.deepEqual(repairs.properties.repair_0.required, ['anchors', 'blocking', 'axis', 'dramatic_progression', 'sound'])
    assert.deepEqual(repairs.properties.repair_1, { type: 'string', minLength: 1 })
    const patch = repaired()
    patch.repairs.repair_0.sound.ambience = '模型未经授权改写原声音'
    return JSON.stringify(patch)
  }, '原始选定场次资料', { structuralRepair: true, onAttempt: round => rounds.push(round), validate: value => { validated++; schema.parse(value) } })
  assert.equal(calls, 2); assert.equal(validated, 1); assert.deepEqual(rounds, [1, 2])
  assert.equal(contexts[0]!.policy, contexts[1]!.policy, 'repair preserves the request policy')
  assert.equal(contexts[0]!.traceStage, 'generation'); assert.equal(contexts[1]!.traceStage, 'repair')
  assert.deepEqual(result, fixture())
  assert.deepEqual(candidate, before, 'the retained candidate is never mutated')
  assert.deepEqual(result.scenes[0]!.shots[1], before.scenes[0].shots[1])
  assert.deepEqual(result.scenes[1], before.scenes[1])
  assert.deepEqual(result.scenes[0]!.shots[0]!.audio_plan, before.scenes[0].shots[0].audio_plan)
  assert.notEqual(contracts[0], contracts[1])
})

test('missing, extra, wrong-type, free-path and unsafe repair envelopes fail within the existing two format rounds', async () => {
  const invalid: unknown[] = [
    { repairs: { repair_0: goodDirection } },
    { repairs: { ...repaired().repairs, repair_2: 'unauthorized' } },
    { repairs: { repair_0: 'wrong object type', repair_1: 'ok' } },
    { repairs: { repair_0: { ...goodDirection, extra: 'unauthorized' }, repair_1: 'ok' } },
    { repairs: repaired().repairs, path: ['scenes'] },
    { repairs: [{ path: ['scenes', 0], value: {} }] },
    { ignored: repaired() },
    JSON.parse('{"repairs":{"repair_0":{"__proto__":{"polluted":true}},"repair_1":"ok"}}'),
    JSON.parse('{"repairs":{"constructor":{"prototype":{"polluted":true}},"repair_0":{},"repair_1":"ok"}}'),
  ]
  for (const patch of invalid) {
    const candidate = badFixture()
    let calls = 0
    await assert.rejects(generateStructuredOutput('storyboard_shot_batch', schema, async () => JSON.stringify(++calls === 1 ? candidate : patch), '资料', { structuralRepair: true }), issue => {
      const error = issue as Error & { raw_output?: string; statusCode?: number }
      assert.equal(error.statusCode, 422)
      assert.deepEqual(JSON.parse(error.raw_output!), candidate, 'an invalid patch must retain the whole original candidate')
      return true
    })
    assert.equal(calls, 2)
  }
  assert.equal(({} as any).polluted, undefined)
})

test('unparseable JSON, recovered syntax and broad root errors retain the existing full-object correction', async () => {
  for (const initial of ['{"scenes":[', '{"scenes":null}', '{"scenes":[]', JSON.stringify(badFixture()).replace(/}$/, ',}')]) {
    let calls = 0
    const result = await generateStructuredOutput('storyboard_shot_batch', schema, async (prompt, contract) => {
      if (++calls === 1) return initial
      assert.equal(contract!.name, 'storyboard_shot_batch')
      assert.match(prompt, /一次格式修正/)
      assert.doesNotMatch(prompt, /一次结构定向修复/)
      return JSON.stringify(fixture())
    }, '资料', { structuralRepair: true })
    assert.equal(calls, 2); assert.deepEqual(result, fixture())
  }
})

test('default callers retain their original full-object repair behavior', async () => {
  let calls = 0
  const result = await generateStructuredOutput('storyboard_shot_batch', schema, async (prompt, contract) => {
    if (++calls === 1) return JSON.stringify(badFixture())
    assert.equal(contract!.name, 'storyboard_shot_batch')
    assert.match(prompt, /一次格式修正/)
    return JSON.stringify(fixture())
  }, '资料')
  assert.equal(calls, 2); assert.deepEqual(result, fixture())
})

test('patched candidates still run whole-schema and business validation without a third format round', async () => {
  for (const semanticFailure of [false, true]) {
    let calls = 0, validations = 0
    const patch = repaired()
    if (!semanticFailure) patch.repairs.repair_1 = ''
    await assert.rejects(generateStructuredOutput('storyboard_shot_batch', schema, async () => JSON.stringify(++calls === 1 ? badFixture() : patch), '资料', {
      structuralRepair: true, validate: () => { validations++; throw Object.assign(new Error('所选场次业务合同未通过'), { statusCode: 422 }) },
    }), /已修正一次/)
    assert.equal(calls, 2); assert.equal(validations, semanticFailure ? 1 : 0)
  }
})

test('structure patches share the original three-attempt transport budget and two format rounds', async () => {
  let calls = 0
  const rounds: number[] = []
  const generate = retryReadOnlyGeneration(async () => {
    calls++
    if (calls === 1) throw new TextProviderError('temporary offline failure', true)
    return JSON.stringify(calls === 2 ? badFixture() : repaired())
  }, { wait: async () => {} })
  assert.deepEqual(await generateStructuredOutput('storyboard_shot_batch', schema, generate, '资料', { structuralRepair: true, onAttempt: round => rounds.push(round) }), fixture())
  assert.equal(calls, 3); assert.deepEqual(rounds, [1, 2])
  calls = 0
  const exhausted = retryReadOnlyGeneration(async () => {
    calls++
    if (calls === 2) return JSON.stringify(badFixture())
    throw new TextProviderError('persistent offline failure', true)
  }, { wait: async () => {} })
  await assert.rejects(generateStructuredOutput('storyboard_shot_batch', schema, exhausted, '资料', { structuralRepair: true }), /persistent offline failure/)
  assert.equal(calls, 3)
})

test('the planner bounds targets, retains source refs, restores nullable optionals and never accepts prototype paths', () => {
  const detail = z.object({ value: nonempty, note: z.string().optional() }).strict().meta({ id: 'repair_detail' })
  const referenced = z.object({ left: detail, right: detail }).strict(), source = z.toJSONSchema(referenced, { io: 'input' })
  const original = { left: { value: '' }, right: { value: 'keep' } }
  const parsed = referenced.safeParse(original)
  assert.ok(!parsed.success)
  const plan = planStructuralRepair(original, parsed.error.issues, source)!
  assert.deepEqual(plan.targets.map(target => target.path), [['left', 'value']])
  assert.deepEqual(referenced.parse(applyStructuralRepair(plan, { repairs: { repair_0: 'fixed' } })), { left: { value: 'fixed' }, right: { value: 'keep' } })

  const withExtra = { left: { value: 'ok', extra: true }, right: { value: 'keep' } }, failed = referenced.safeParse(withExtra)
  assert.ok(!failed.success)
  const objectPlan = planStructuralRepair(withExtra, failed.error.issues, source)!
  assert.ok(objectPlan.schema.$defs)
  const envelope = restoreOptionalNulls({ repairs: { repair_0: { value: 'fixed', note: null } } }, objectPlan.schema)
  assert.deepEqual(referenced.parse(applyStructuralRepair(objectPlan, envelope)), { left: { value: 'ok' }, right: { value: 'keep' } })
  assert.equal(planStructuralRepair({ constructor: { value: '' } }, [{ code: 'custom', path: ['constructor', 'value'], message: 'bad' }], {}), undefined)
  const manySchema = z.object(Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['field' + index, nonempty])))
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['field' + index, ''])), manyFailure = manySchema.safeParse(many)
  assert.ok(!manyFailure.success)
  assert.equal(planStructuralRepair(many, manyFailure.error.issues, z.toJSONSchema(manySchema, { io: 'input' })), undefined)
})

test('a structural patch cannot normalize or mutate unselected fields', async () => {
  const normalizing = z.object({ untouched: z.string().trim(), fix: nonempty }).strict()
  let calls = 0
  await assert.rejects(generateStructuredOutput('bounded_structure', normalizing, async () => JSON.stringify(++calls === 1
    ? { untouched: ' original spacing ', fix: '' } : { repairs: { repair_0: 'fixed' } }), '资料', { structuralRepair: true }), /授权目标之外/)
  assert.equal(calls, 2)
})

test('one missing nested field requests only its exact leaf schema', async () => {
  const missing = z.object({ keep: nonempty, details: z.object({ id: nonempty, label: nonempty }).strict() }).strict()
  let calls = 0
  const result = await generateStructuredOutput('bounded_structure', missing, async (_prompt, contract) => {
    if (++calls === 1) return JSON.stringify({ keep: 'unchanged', details: { id: 'stable-id' } })
    assert.deepEqual((contract!.schema.properties as any).repairs.properties.repair_0, { type: 'string', minLength: 1 })
    return JSON.stringify({ repairs: { repair_0: 'recovered label' } })
  }, '资料', { structuralRepair: true })
  assert.deepEqual(result, { keep: 'unchanged', details: { id: 'stable-id', label: 'recovered label' } })
  assert.equal(calls, 2)
})

test('array count errors use one explicit full-unit correction instead of authorizing valid sibling rewrites', async () => {
  const bounded = z.object({ scenes: z.array(z.object({ scene_id: nonempty, shots: z.array(shot).min(1).max(2) }).strict()).length(1) }).strict()
  const good = { scenes: [{ scene_id: 'selected', shots: [goodShot('stable-id', true)] }] }
  const invalid = [
    { scenes: [...good.scenes, { scene_id: 'unselected', shots: [goodShot('foreign-id', true)] }] },
    { scenes: [] },
    { scenes: [{ ...good.scenes[0], shots: [goodShot('stable-id'), goodShot('second-id'), goodShot('extra-id', true)] }] },
    { scenes: [{ ...good.scenes[0], shots: [] }] },
  ]
  for (const candidate of invalid) {
    const failure = bounded.safeParse(candidate)
    assert.equal(failure.success, false)
    assert.equal(planStructuralRepair(candidate, failure.error!.issues, z.toJSONSchema(bounded, { io: 'input' })), undefined)
    let calls = 0
    const result = await generateStructuredOutput('storyboard_scene_plan', bounded, async (prompt, contract) => {
      if (++calls === 1) return JSON.stringify(candidate)
      assert.equal(contract!.name, 'storyboard_scene_plan')
      assert.match(prompt, /一次格式修正/)
      assert.doesNotMatch(prompt, /一次结构定向修复/)
      return JSON.stringify(good)
    }, '原始所选场次与声音资料', { structuralRepair: true })
    assert.equal(calls, 2)
    assert.deepEqual(result, good)
    assert.equal(result.scenes[0]!.shots[0]!.shot_id, 'stable-id')
    assert.deepEqual(result.scenes[0]!.shots[0]!.audio_plan, good.scenes[0]!.shots[0]!.audio_plan)
  }
})

test('array and object ancestor refinements cannot broaden local authority over already valid fields', async () => {
  const containerSchemas = [
    z.object({ items: z.array(nonempty).refine(value => value.length === 1, '数量必须恰好为一项') }).strict(),
    z.object({ details: z.object({ keep: nonempty, label: nonempty }).strict().refine(value => value.label === 'fixed', '对象级约束') }).strict(),
  ]
  const candidates = [{ items: ['legal original', 'extra'] }, { details: { keep: 'legal original', label: 'bad' } }]
  const corrected = [{ items: ['legal original'] }, { details: { keep: 'legal original', label: 'fixed' } }]
  for (let index = 0; index < containerSchemas.length; index++) {
    const contractSchema = containerSchemas[index]!, candidate = candidates[index], expected = corrected[index]
    const failure = contractSchema.safeParse(candidate)
    assert.equal(failure.success, false)
    assert.equal(planStructuralRepair(candidate, failure.error!.issues, z.toJSONSchema(contractSchema, { io: 'input' })), undefined)
    let calls = 0
    const result = await generateStructuredOutput('storyboard_shot_batch', contractSchema, async (prompt, contract) => {
      if (++calls === 1) return JSON.stringify(candidate)
      assert.equal(contract!.name, 'storyboard_shot_batch')
      assert.match(prompt, /一次格式修正/)
      return JSON.stringify(expected)
    }, '资料', { structuralRepair: true })
    assert.equal(calls, 2); assert.deepEqual(result, expected)
  }
})

test('structure repair labels both ALS and explicit generator context while restoring the caller on success or failure', async () => {
  for (const failRepair of [false, true]) {
    const controller = new AbortController(), onDispatch = () => {}
    const caller: ModelRequestContext = { policy: modelTaskPolicies.text, traceStage: 'text', taskId: 'same-durable-task',
      stepId: 'same-step', signal: controller.signal, onDispatch }
    let calls = 0
    const repairFailure = new Error('repair failed')
    await withModelRequestContext(caller, async () => {
      const pending = generateStructuredOutput('storyboard_shot_batch', schema, async (_prompt, contract, context) => {
        calls++
        const expectedStage = calls === 1 ? 'generation' : 'repair'
        assert.equal(contract!.name, calls === 1 ? 'storyboard_shot_batch' : 'storyboard_shot_batch_structure_repair')
        assert.equal(context!.traceStage, expectedStage)
        assert.equal(currentModelRequestContext(), context, 'provider callbacks observe the same stage as the explicit generator')
        assert.equal(currentModelRequestContext()!.traceStage, expectedStage)
        assert.equal(context!.policy, modelTaskPolicies.generation, 'a repair never selects a new generation/retry policy')
        assert.equal(context!.taskId, caller.taskId); assert.equal(context!.stepId, caller.stepId)
        assert.equal(context!.signal, caller.signal); assert.equal(context!.onDispatch, onDispatch)
        if (calls === 2 && failRepair) throw repairFailure
        return JSON.stringify(calls === 1 ? badFixture() : repaired())
      }, 'source', { structuralRepair: true })
      if (failRepair) await assert.rejects(pending, issue => issue === repairFailure)
      else assert.deepEqual(await pending, fixture())
      assert.equal(currentModelRequestContext(), caller, 'nested repair restores the calling ALS context')
    })
    assert.equal(calls, 2, 'stage labeling adds no generation calls')
    assert.equal(currentModelRequestContext(), undefined)
  }
})
