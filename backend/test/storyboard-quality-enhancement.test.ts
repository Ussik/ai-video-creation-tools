import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { ensureStoryboardOutlineQuality } from '../src/modules/storyboard/storyboard-outline-quality.js'
import { repairStoryboardTargets } from '../src/modules/storyboard/storyboard-targeted-repair.js'
import { storyboardIssueFingerprint, storyboardRepairEffect, validateStoryboardRepairEvidence } from '../src/modules/storyboard/storyboard-review-scope.js'
import { currentModelRequestContext, withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import type { StoryboardDirectingReview } from '../src/modules/storyboard/storyboard-directing.js'

const direction = z.object({ anchors: z.string().min(1), blocking: z.string().min(1), axis: z.string().min(1), dramatic_progression: z.string().min(1) }).strict()
const shot = z.object({ shot_id: z.string(), prompt: z.string().min(1), start_state: z.string().min(1), end_state: z.string().min(1), cut_note: z.string().min(1), duration: z.number().int(), audio_plan: z.object({ text: z.string() }) }).strict()
const outlineSchema = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number(), scene_direction: direction, shots: z.array(shot) }).strict()) }).strict()
const outline = () => ({ scenes: [{ scene_id: 'scene', scene_duration: 10, scene_direction: { anchors: '门在走廊尽头', blocking: '人物在门前', axis: '走廊轴线同侧', dramatic_progression: '先到达再反应' }, shots: [
  { shot_id: 'a', prompt: '甲走向门口', start_state: '甲在走廊', end_state: '甲已到门前', cut_note: '动作完成切出', duration: 5, audio_plan: { text: '快走。' } },
  { shot_id: 'b', prompt: '甲停在门前反应', start_state: '甲在走廊重新走向门口', end_state: '甲站在门前', cut_note: '反应后收住', duration: 5, audio_plan: { text: '' } },
] }] })
const issue = (): StoryboardDirectingReview['issues'][number] => ({ code: 'repeated_action', scene_id: 'scene', shot_index: 1, related_scene_id: 'scene', related_shot_index: 0,
  severity: 'error', message: '前镜已到门口，后镜不应重走。', evidence: '甲在走廊重新走向门口', repair: '后镜从已到门前开始。',
  evidence_refs: [{ scene_id: 'scene', shot_index: 1, field: 'start_state', quote: '甲在走廊重新走向门口' }],
  repair_scope: [{ scene_id: 'scene', shot_index: 1, operation: 'replace', fields: ['start_state'] }] })
function ledger() { const steps: Record<string, unknown> = {}; return { steps, signal: new AbortController().signal, retain: (key: string, value: unknown) => { steps[key] = structuredClone(value) } } }
const validate = (value: ReturnType<typeof outline>) => assert.equal(value.scenes[0]!.scene_duration, value.scenes[0]!.shots.reduce((sum, item) => sum + item.duration, 0))

test('independent outline review repairs only evidenced state before expansion and resumes without paid calls', async () => {
  const original = outline(), control = ledger(), calls: string[] = [], events: any[] = []
  const run = () => withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => events.push(event) }, () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'outline', schema: outlineSchema, validate, control, context: { original_source: '甲走到门前停下。' },
    generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'storyboard_outline_repair') return JSON.stringify({ repairs: { field_0: '甲已到门前，保持站定' } })
      assert.equal(currentModelRequestContext()?.policy.purpose, 'review')
      return JSON.stringify({ issues: calls.length === 1 ? [issue()] : [] })
    } }))
  const revised = await run(), expected = outline(); expected.scenes[0]!.shots[1]!.start_state = '甲已到门前，保持站定'
  assert.deepEqual(revised, expected); assert.deepEqual(original, outline())
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_repair', 'storyboard_outline_review'])
  assert.deepEqual(events.filter(event => event.phase === 'quality').map(event => event.stage), ['outline_review', 'recheck', 'recheck'])
  events.length = 0
  assert.deepEqual(await run(), revised); assert.equal(calls.length, 3)
  assert.deepEqual(events.filter(event => event.phase === 'quality').map(event => event.stage), ['outline_review', 'recheck', 'recheck'])
})

test('an unchanged outline defect stops after one repair and one recheck, including after recovery', async () => {
  const control = ledger(); let calls = 0
  const run = () => ensureStoryboardOutlineQuality({ outline: outline(), outlineKey: 'outline', schema: outlineSchema, validate, control, context: {}, generate: async (_prompt, contract) => {
    calls++; return JSON.stringify(contract!.name === 'storyboard_outline_repair' ? { repairs: { field_0: '甲在走廊重新走向门口' } } : { issues: [issue()] })
  } })
  await assert.rejects(run(), { code: 'storyboard_outline_repeated_issues' }); assert.equal(calls, 3)
  await assert.rejects(run(), { code: 'storyboard_outline_repeated_issues' }); assert.equal(calls, 3)
})

test('false quotes, uncovered fields and required-field deletion never authorize an outline repair', async t => {
  for (const variant of ['false_quote', 'missing_scope', 'uncovered_field', 'delete_required'] as const) await t.test(variant, async () => {
    const defect = issue()
    if (variant === 'false_quote') defect.evidence_refs![0]!.quote = '原文没有的剑光'
    if (variant === 'missing_scope') delete defect.repair_scope
    if (variant === 'uncovered_field') defect.repair_scope![0]!.fields.push('end_state')
    if (variant === 'delete_required') defect.repair = '删除必填字段 directing.camera 与 cut.carry_over 即可通过'
    let repairs = 0
    await assert.rejects(ensureStoryboardOutlineQuality({ outline: outline(), outlineKey: 'outline', schema: outlineSchema, validate, control: ledger(), context: {}, generate: async (_prompt, contract) => {
      if (contract!.name === 'storyboard_outline_repair') repairs++
      return JSON.stringify({ issues: [defect] })
    } }))
    assert.equal(repairs, 0)
  })
})

const fullShot = shot.extend({ image_prompt: z.string().min(1), video_prompt: z.string().min(1) }).strict()
const fullPlan = () => ({ scenes: outline().scenes.map(scene => ({ ...scene, shots: scene.shots.map(item => ({ ...item, image_prompt: item.start_state, video_prompt: item.prompt })) })) })
test('field repair returns only application-owned keys and copies all unrelated facts exactly', async () => {
  const original = fullPlan(), bytes = JSON.stringify(original)
  const revised = await repairStoryboardTargets({ candidate: original, report: { issues: [issue()] }, shotSchema: fullShot, sceneDirectionSchema: direction, exactScope: true, prompt: '', generate: async (prompt, contract) => {
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
    assert.deepEqual(data.targets.map((item: any) => [item.scene_id, item.shot_index, item.field, item.key]), [['scene', 1, 'start_state', 'field_0']])
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['field_0'])
    return JSON.stringify({ repairs: { field_0: '甲已到门前，保持站定' } })
  } })
  const expected = fullPlan(); expected.scenes[0]!.shots[1]!.start_state = '甲已到门前，保持站定'
  assert.deepEqual(revised, expected); assert.equal(JSON.stringify(original), bytes)
})

test('scene-direction repair changes its evidenced field while keeping shot payloads and audio unchanged', async () => {
  const original = fullPlan(), defect = issue()
  defect.repair_scope = [{ scene_id: 'scene', shot_index: null, operation: 'replace', fields: ['scene_direction.blocking'] }]
  defect.evidence_refs = [{ scene_id: 'scene', shot_index: null, field: 'scene_direction.blocking', quote: '人物在门前' }]
  const revised = await repairStoryboardTargets({ candidate: original, report: { issues: [defect] }, shotSchema: fullShot, sceneDirectionSchema: direction, exactScope: true, prompt: '', generate: async () => JSON.stringify({ repairs: { field_0: '甲到达门前后保持站定' } }) })
  const expected = fullPlan(); expected.scenes[0]!.scene_direction.blocking = '甲到达门前后保持站定'
  assert.deepEqual(revised, expected)
})

test('unproved scope and creator-unapproved timing stop before invoking the repair model', async () => {
  for (const timing of [false, true]) {
    const defect = issue(); defect.repair_scope![0]!.fields = [timing ? 'duration' : 'end_state']
    if (timing) { defect.timing_change = true; defect.evidence_refs = [{ scene_id: 'scene', shot_index: 1, field: 'duration', quote: '5' }] }
    let calls = 0
    await assert.rejects(repairStoryboardTargets({ candidate: fullPlan(), report: { issues: [defect] }, shotSchema: fullShot, sceneDirectionSchema: direction, exactScope: true, prompt: '', generate: async () => { calls++; return '{}' } }))
    assert.equal(calls, 0)
  }
})

test('issue wording and quoted values cannot reset repeated-problem history; quality needs independent evidence', () => {
  const first = issue(), second = issue(); second.message = '同一问题的另一措辞'; second.evidence = '修改后的错误值'; second.evidence_refs![0]!.quote = '修改后的错误值'
  assert.equal(storyboardIssueFingerprint([first]), storyboardIssueFingerprint([second]))
  assert.equal(storyboardRepairEffect([first], [second]), 'unchanged')
  assert.equal(storyboardRepairEffect([first], []), 'improved')
  assert.equal(storyboardRepairEffect([], [first]), 'regressed')
  assert.throws(() => validateStoryboardRepairEvidence({ ...issue(), evidence_refs: undefined, repair_scope: undefined, evidence: '凭空伪造的原文' }, fullPlan().scenes, [], true))
})


test('removing repeated action text and saying not to delete fields remain valid replace repairs', () => {
  for (const repair of ['不要删除camera字段，替换不相容的状态。', '删除video_prompt里的重复动作，保留正确的起止状态。', '禁止删除必填字段，只替换错误值。']) {
    assert.doesNotThrow(() => validateStoryboardRepairEvidence({ ...issue(), repair }, fullPlan().scenes, [], true))
  }
  for (const repair of ['删除必填字段 directing.camera 与 cut.carry_over 即可通过', '删除 directing.camera 即可通过', 'remove required field camera']) {
    assert.throws(() => validateStoryboardRepairEvidence({ ...issue(), repair }, fullPlan().scenes, [], true))
  }
})

test('restored outline repair checkpoints cannot rewrite locked speech or timing', async () => {
  const control = ledger(); let calls = 0
  const run = () => ensureStoryboardOutlineQuality({ outline: outline(), outlineKey: 'outline', schema: outlineSchema, validate, control, context: {}, generate: async (_prompt, contract) => {
    calls++
    return JSON.stringify(contract!.name === 'storyboard_outline_repair' ? { repairs: { field_0: '甲已到门前，保持站定' } } : { issues: calls === 1 ? [issue()] : [] })
  } })
  await run()
  const key = Object.keys(control.steps).find(key => key.endsWith(':repair'))!
  ;(control.steps[key] as ReturnType<typeof outline>).scenes[0]!.shots[0]!.audio_plan.text = '被偷换的台词'
  await assert.rejects(run(), { code: 'storyboard_outline_review_invalid' }); assert.equal(calls, 3)
})

test('local repair reads real neighbours across scene boundaries without exposing the remaining sequence', async () => {
  const candidate = fullPlan(); candidate.scenes.push({ ...structuredClone(candidate.scenes[0]!), scene_id: 'next' })
  const defect = issue(); defect.related_scene_id = null; defect.related_shot_index = null
  await repairStoryboardTargets({ candidate, report: { issues: [defect] }, shotSchema: fullShot, exactScope: true, prompt: '', generate: async prompt => {
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
    assert.deepEqual(data.readonly_plan.scenes.map((scene: any) => [scene.scene_id, scene.shots.map((shot: any) => shot.shot_index)]), [['scene', [0, 1]], ['next', [0]]])
    return JSON.stringify({ repairs: { field_0: '甲已到门前，保持站定' } })
  } })
})
