import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStoryboardPlanningBatches } from '../src/modules/storyboard/storyboard-planning-batches.js'
import { StoryboardPlanningBudgetError } from '../src/modules/storyboard/storyboard-planning-budget.js'
import { ensureStoryboardOutlineQuality } from '../src/modules/storyboard/storyboard-outline-quality.js'
import { storyboardValueSignature } from '../src/modules/storyboard/storyboard-review-scope.js'

const shotSchema = z.object({ shot_id: z.string(), title: z.string(), duration: z.number(), prompt: z.string(),
  start_state: z.string(), end_state: z.string(), cut_note: z.string() }).strict()
const schema = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number(),
  scene_direction: z.object({ axis: z.string() }).strict(), shots: z.array(shotSchema) }).strict()) }).strict()
const outline = () => ({ scenes: [{ scene_id: 'five-shot-scene', scene_duration: 30, scene_direction: { axis: '北侧' },
  shots: Array.from({ length: 5 }, (_, i) => ({ shot_id: `shot-${i}`, title: `镜头${i + 1}`, duration: 6,
    prompt: `动作${i}`, start_state: `起点${i}`, end_state: `终点${i}`, cut_note: `接镜${i}` })) }] })
const report = () => ({ issues: [
  { code: 'weak_cut', severity: 'warning', scene_id: 'five-shot-scene', shot_index: 4, related_scene_id: null,
    related_shot_index: null, message: '末镜可延长停留', evidence: '接镜4', repair: '可选择保持' },
  { code: 'action_mismatch', severity: 'warning', scene_id: 'five-shot-scene', shot_index: 0,
    related_scene_id: 'five-shot-scene', related_shot_index: 3, message: '前后镜交接需要确认', evidence: '终点0', repair: '核对交接动作',
    evidence_refs: [{ scene_id: 'five-shot-scene', shot_index: 0, field: 'end_state', quote: '终点0' }] },
] })
function ledger(steps: Record<string, unknown> = {}) { return { steps, signal: new AbortController().signal,
  retain(key: string, value: unknown) { steps[key] = structuredClone(value) } } }

test('five-shot outline corrects only issues[1] relation through the real outline review entry', async () => {
  const original = outline(), control = ledger(), calls: string[] = [], prompts: string[] = []
  const result = await ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema,
    validate() {}, control, context: {}, generate: async (prompt, contract) => {
      calls.push(contract!.name); prompts.push(prompt)
      if (contract!.name === 'storyboard_outline_relation_correction') return JSON.stringify({ repairs: { issue_1: { relation_id: 'neighbor_0' } } })
      return JSON.stringify(report())
    } })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_relation_correction'])
  assert.deepEqual(result, original)
  const accepted = control.steps[`five-shot:quality:v1:${storyboardValueSignature(original)}:report`] as ReturnType<typeof report>
  const expected = report(); expected.issues[1]!.related_shot_index = 1
  assert.deepEqual(accepted, expected, 'issue text and existing evidence stay unchanged')
  assert.match(prompts[0]!, /shot_index从0开始/)
  assert.match(prompts[0]!, /"pairs"/)
  const rejected = Object.entries(control.steps).find(([key]) => key.endsWith(':relation_rejected'))![1] as any
  assert.equal(rejected.report.issues[1].related_shot_index, 3)
  assert.equal(JSON.parse(rejected.diagnostics)[0].field_path, 'issues[1].related_shot_index')
})

const prefix = (value: ReturnType<typeof outline>) => `five-shot:quality:v1:${storyboardValueSignature(value)}`
const validPatch = () => JSON.stringify({ repairs: { issue_1: { relation_id: 'neighbor_0' } } })

test('a legacy saved outline report gets relation-only correction without another review generation', async () => {
  const original = outline(), originalReport = report(), control = ledger({ [`${prefix(original)}:report`]: originalReport }), calls: string[] = []
  await ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => { calls.push(contract!.name); return validPatch() } })
  assert.deepEqual(calls, ['storyboard_outline_relation_correction'])
  assert.equal(originalReport.issues[1]!.related_shot_index, 3, 'the original checkpoint object is not mutated')
  assert.equal((control.steps[`${prefix(original)}:report`] as any).issues[1].related_shot_index, 1)
})

test('a format-corrected outline review still receives the same bounded relation correction', async () => {
  const original = outline(), control = ledger(), calls: string[] = []
  let reviews = 0
  await ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'storyboard_outline_relation_correction') return validPatch()
      reviews++
      if (reviews === 1) { const value = report(); delete (value.issues[1] as any).evidence; return JSON.stringify(value) }
      return JSON.stringify(report())
    } })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_review', 'storyboard_outline_relation_correction'])
})

test('recheck and recheck checkpoint recovery share relation validation without repeating a content repair', async () => {
  const original = outline(), control = ledger(), calls: string[] = []
  const initial = { issues: [{ ...report().issues[1]!, severity: 'error', related_shot_index: 1,
    evidence: '起点0', evidence_refs: [{ scene_id: 'five-shot-scene', shot_index: 0, field: 'start_state', quote: '起点0' }],
    repair_scope: [{ scene_id: 'five-shot-scene', shot_index: 0, operation: 'replace', fields: ['start_state'] }] }] }
  let reviews = 0
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'storyboard_outline_repair') return JSON.stringify({ repairs: { field_0: '修正的起点0' } })
      if (contract!.name === 'storyboard_outline_relation_correction') return validPatch()
      return JSON.stringify(++reviews === 1 ? initial : report())
    } })
  const result = await run()
  assert.equal(result.scenes[0]!.shots[0]!.start_state, '修正的起点0')
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_repair', 'storyboard_outline_review', 'storyboard_outline_relation_correction'])
  const completed = [...calls]
  await run(); assert.deepEqual(calls, completed)
  // Legacy saved recheck reports must also use the same correction seam.
  const recheckKey = `${prefix(original)}:recheck`
  control.steps[recheckKey] = report()
  delete control.steps[`${recheckKey}:relation_correction`]
  delete control.steps[`${recheckKey}:relation_rejected`]
  await run()
  assert.deepEqual(calls, [...completed, 'storyboard_outline_relation_correction'])
})

test('illegal relation returned by a local correction stops once and preserves original report and outline', async () => {
  const original = outline(), bytes = JSON.stringify(original), control = ledger(), calls: string[] = []
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      return contract!.name === 'storyboard_outline_relation_correction'
        ? JSON.stringify({ repairs: { issue_1: { relation_id: 'nonadjacent_3' } } }) : JSON.stringify(report())
    } })
  await assert.rejects(run(), (error: any) => {
    assert.equal(error.code, 'storyboard_outline_relation_correction_failed')
    assert.equal(error.field_path, 'issues[1].related_shot_index')
    assert.equal(error.related_shot_index, 3)
    return true
  })
  await assert.rejects(run(), { code: 'storyboard_outline_relation_correction_exhausted' })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_relation_correction'])
  assert.deepEqual((control.steps[`${prefix(original)}:report:relation_rejected`] as any).report, report())
  assert.equal(JSON.stringify(original), bytes)
})

test('true nonadjacent evidence cannot be relabelled as a local or adjacent finding', async () => {
  const original = outline(), control = ledger(), calls: string[] = [], rejected = report()
  rejected.issues[1]!.evidence_refs = [{ scene_id: 'five-shot-scene', shot_index: 3, field: 'end_state', quote: '终点3' }]
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name !== 'storyboard_outline_relation_correction') return JSON.stringify(rejected)
      assert.match(prompt, /"choices":\[\]/)
      return JSON.stringify({ repairs: { issue_1: { relation_id: 'unresolved' } } })
    } })
  await assert.rejects(run(), { code: 'storyboard_outline_relation_correction_failed' })
  assert.deepEqual((control.steps[`${prefix(original)}:report:relation_rejected`] as any).report, rejected)
  assert.deepEqual(calls, ['storyboard_outline_review'], 'impossible corrections stop locally without a model request')
  await assert.rejects(run(), { code: 'storyboard_outline_relation_correction_exhausted' })
})

test('correcting a relation does not reconstruct missing strict outline evidence from repair_scope', async () => {
  const original = outline(), control = ledger(), rejected = report(), calls: string[] = []
  Object.assign(rejected.issues[1]!, { severity: 'error', evidence_refs: undefined,
    repair_scope: [{ scene_id: 'five-shot-scene', shot_index: 0, operation: 'replace', fields: ['end_state'] }] })
  await assert.rejects(ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      return contract!.name === 'storyboard_outline_relation_correction' ? validPatch() : JSON.stringify(rejected)
    } }), { code: 'storyboard_outline_relation_correction_failed' })
  assert.ok(!calls.includes('storyboard_outline_repair'))
})


test('five-shot batch restart reuses outline and rejected review before expanding preserved shots', async () => {
  const original = outline(), calls: string[] = [], abort = new AbortController()
  const first = { ...ledger(), signal: abort.signal, retain(key: string, value: unknown) {
    this.steps[key] = structuredClone(value)
    if (key.endsWith(':relation_rejected')) abort.abort(new Error('simulated restart before correction'))
  } }
  const options = (control: ReturnType<typeof ledger>) => ({ namespace: 'initial' as const, prompt: 'five shots thirty seconds',
    outlineSchema: schema, expansionSchema: z.object({ image_prompt: z.string() }).strict(), batchSize: 1 as const,
    control, validateOutline() {}, finalize: (value: any) => value,
    resolveOutline: (value: any, key: string) => ensureStoryboardOutlineQuality({ outline: value, outlineKey: key, schema,
      validate() {}, control, context: {}, generate }), generate })
  const generate = async (_prompt: string, contract?: { name: string; schema: any }) => {
    calls.push(contract!.name)
    if (contract!.name === 'storyboard_scene_plan') return JSON.stringify(original)
    if (contract!.name === 'storyboard_outline_review') return JSON.stringify(report())
    if (contract!.name === 'storyboard_outline_relation_correction') return validPatch()
    const props = contract!.schema.properties
    const shot = props.shots.items.properties.shot_index
    return JSON.stringify({ scene_id: props.scene_id.const, shots: [{ shot_index: shot.minimum, expansion: { image_prompt: '保留原动作' } }] })
  }
  await assert.rejects(generateStoryboardPlanningBatches(options(first)), /simulated restart/)
  assert.deepEqual(calls, ['storyboard_scene_plan', 'storyboard_outline_review'])
  const key = Object.keys(first.steps).find(key => key.endsWith(':outline'))!
  assert.deepEqual(first.steps[key], original)
  assert.ok(Object.keys(first.steps).some(key => key.endsWith(':relation_rejected')))
  const second = ledger(structuredClone(first.steps))
  const result = await generateStoryboardPlanningBatches(options(second))
  assert.equal(result.scenes[0].shots.length, 5)
  assert.equal(result.scenes[0].shots.reduce((sum: number, shot: any) => sum + shot.duration, 0), 30)
  assert.deepEqual(second.steps[key], original)
  assert.equal(calls.filter(name => name === 'storyboard_scene_plan').length, 1)
  assert.equal(calls.filter(name => name === 'storyboard_outline_review').length, 1)
  assert.equal(calls.filter(name => name === 'storyboard_outline_relation_correction').length, 1)
  assert.equal(calls.filter(name => name === 'storyboard_shot_batch').length, 5)
  const done = [...calls]
  await generateStoryboardPlanningBatches(options(ledger(structuredClone(second.steps))))
  assert.deepEqual(calls, done, 'a later restart never regenerates completed work')
})

test('relation correction preserves a budget stop and never dispatches it again', async () => {
  const original = outline(), control = ledger(), budget = new StoryboardPlanningBudgetError('requests', true), calls: string[] = []
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'storyboard_outline_relation_correction') throw budget
      return JSON.stringify(report())
    } })
  await assert.rejects(run(), error => error === budget)
  await assert.rejects(run(), { code: 'storyboard_outline_relation_correction_exhausted' })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_relation_correction'])
})


test('a disconnected relation correction is not replayed after a fresh controller restores its ledger', async () => {
  const original = outline(), abort = new AbortController(), first = { ...ledger(), signal: abort.signal }, calls: string[] = []
  const generate = async (_prompt: string, contract?: { name: string }) => {
    calls.push(contract!.name)
    if (contract!.name === 'storyboard_outline_relation_correction') {
      abort.abort(new Error('unknown correction outcome')); throw abort.signal.reason
    }
    return JSON.stringify(report())
  }
  const run = (control: ReturnType<typeof ledger>) => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema,
    validate() {}, control, context: {}, generate })
  await assert.rejects(run(first), /unknown correction outcome/)
  await assert.rejects(run(ledger(structuredClone(first.steps))), { code: 'storyboard_outline_relation_correction_exhausted' })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_relation_correction'])
  assert.deepEqual((first.steps[`${prefix(original)}:report:relation_rejected`] as any).report, report())
})


test('relation-only correction preserves original finding prose and reference bytes on acceptance and reuse', async () => {
  const original = outline(), rejected = report(), control = ledger(), calls: string[] = []
  rejected.issues[1]!.evidence = '原报告对交接状态的解释，不能被字段原文替换'
  rejected.issues[1]!.evidence_refs![0]!.quote = '终点'
  const expected = structuredClone(rejected); expected.issues[1]!.related_shot_index = 1
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'five-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      return contract!.name === 'storyboard_outline_relation_correction' ? validPatch() : JSON.stringify(rejected)
    } })
  await run()
  assert.deepEqual(control.steps[`${prefix(original)}:report`], expected)
  await run()
  assert.deepEqual(control.steps[`${prefix(original)}:report`], expected)
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_relation_correction'])
})
