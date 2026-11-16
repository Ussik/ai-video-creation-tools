import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { repairStoryboardTargets } from '../src/modules/storyboard/storyboard-targeted-repair.js'
import type { StoryboardDirectingReview } from '../src/modules/storyboard/storyboard-directing.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const shot = z.object({ shot_id: z.string(), duration: z.number(), audio_plan: z.object({ text: z.string() }),
  prompt: z.string(), start_state: z.string(), end_state: z.string(), cut_note: z.string(), image_prompt: z.string(), video_prompt: z.string() }).strict()
const constrainedShot = shot.superRefine((value, context) => {
  if (value.end_state === '无效终态') context.addIssue({ code: 'custom', path: ['end_state'], message: '终态没有完成当前动作' })
})
const plan = () => ({ scenes: [{ scene_id: 'scene', scene_duration: 10, shots: [
  { shot_id: 'target', duration: 5, audio_plan: { text: '原话🚆。' }, prompt: '甲检查信封', start_state: '尚未检查',
    end_state: '原终态', cut_note: '原接镜', image_prompt: '原首帧', video_prompt: '原视频正文' },
  { shot_id: 'untouched', duration: 5, audio_plan: { text: '无关对白' }, prompt: '乙等待', start_state: '乙站定',
    end_state: '乙保持', cut_note: '无关接镜', image_prompt: '无关首帧', video_prompt: '无关视频正文' },
] }] })
const report = (): StoryboardDirectingReview => ({ issues: [{ code: 'repeated_action', scene_id: 'scene', shot_index: 0,
  related_scene_id: null, related_shot_index: null, severity: 'error', message: '终态和接镜需修正', evidence: '原终态', repair: '修正终态与接镜',
  evidence_refs: [{ scene_id: 'scene', shot_index: 0, field: 'end_state', quote: '原终态' }, { scene_id: 'scene', shot_index: 0, field: 'cut_note', quote: '原接镜' }],
  repair_scope: [{ scene_id: 'scene', shot_index: 0, operation: 'replace', fields: ['end_state', 'cut_note'] }] }] })
const run = (generate: Parameters<typeof repairStoryboardTargets>[0]['generate'], candidate = plan(), schema = constrainedShot) =>
  repairStoryboardTargets({ candidate, report: report(), shotSchema: schema, exactScope: true, prompt: 'LONG_CONTEXT_SENTINEL', generate })

test('complete field proposal failing whole-shot validation corrects only the failed key and retains the good sibling', async () => {
  const original = plan(), bytes = JSON.stringify(original), calls: string[] = []
  const result = await run(async (prompt, contract) => {
    calls.push(contract!.name)
    if (calls.length === 1) return JSON.stringify({ repairs: { field_0: '无效终态', field_1: '已确认的接镜🚆  ' } })
    assert.equal(contract!.name, 'storyboard_targeted_repair_local_repair')
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['field_0'])
    assert.ok(!prompt.includes('LONG_CONTEXT_SENTINEL'))
    assert.ok(prompt.includes('已确认的接镜🚆  '), 'local owner context must include the accepted sibling value')
    return JSON.stringify({ repairs: { field_0: '已完成检查' } })
  }, original)
  assert.deepEqual(calls, ['storyboard_targeted_repair', 'storyboard_targeted_repair_local_repair'])
  assert.equal(JSON.stringify(original), bytes)
  assert.equal(result.scenes[0]!.shots[0]!.end_state, '已完成检查')
  assert.equal(result.scenes[0]!.shots[0]!.cut_note, '已确认的接镜🚆  ')
  assert.deepEqual(result.scenes[0]!.shots[1], original.scenes[0]!.shots[1])
  assert.deepEqual(result.scenes[0]!.shots[0]!.audio_plan, original.scenes[0]!.shots[0]!.audio_plan)
  assert.equal(result.scenes[0]!.shots[0]!.duration, 5)
})

test('a local correction cannot resend valid siblings or use a nested patch, and never mutates the original', async t => {
  for (const variant of ['sibling', 'nested', 'still_invalid']) await t.test(variant, async () => {
    const original = plan(), bytes = JSON.stringify(original); let calls = 0
    await assert.rejects(run(async (_prompt, contract) => {
      calls++
      if (calls === 1) return JSON.stringify({ repairs: { field_0: '无效终态', field_1: '已确认的接镜' } })
      assert.equal(contract!.name, 'storyboard_targeted_repair_local_repair')
      if (variant === 'sibling') return JSON.stringify({ repairs: { field_0: '已完成检查', field_1: '偷改合法接镜' } })
      if (variant === 'nested') return JSON.stringify({ wrapper: { repairs: { field_0: '已完成检查' } } })
      return JSON.stringify({ repairs: { field_0: '无效终态' } })
    }, original))
    assert.equal(calls, 2); assert.equal(JSON.stringify(original), bytes)
  })
})

test('a complete root with a missing field corrects that fixed key while retaining its valid sibling', async () => {
  let calls = 0
  const result = await run(async (_prompt, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ repairs: { field_1: '已确认的接镜' } })
    assert.equal(contract!.name, 'storyboard_targeted_repair_local_repair')
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['field_0'])
    return JSON.stringify({ repairs: { field_0: '已完成检查' } })
  })
  assert.equal(calls, 2); assert.equal(result.scenes[0]!.shots[0]!.cut_note, '已确认的接镜')
})

test('a whole-shot root invariant with no field path keeps the existing bounded complete correction', async () => {
  const rootConstraint = shot.superRefine((value, context) => {
    if (value.end_state === '无效终态') context.addIssue({ code: 'custom', message: '整镜组合不符合当前契约' })
  })
  let calls = 0
  const result = await run(async (_prompt, contract) => {
    calls++; assert.equal(contract!.name, 'storyboard_targeted_repair')
    return JSON.stringify({ repairs: { field_0: calls === 1 ? '无效终态' : '已完成检查', field_1: '同一接镜' } })
  }, plan(), rootConstraint)
  assert.equal(calls, 2); assert.equal(result.scenes[0]!.shots[0]!.end_state, '已完成检查')
})

test('unknown headers and started partial output never become a local correction request', async () => {
  for (const error of [new TextProviderError('未确认响应', true, 'headers_timeout'),
    Object.assign(new TextProviderError('输出中断', true, 'connection_error'), { delivery: 'output_started' as const, outputStarted: true })]) {
    let calls = 0
    await assert.rejects(run(async () => { calls++; throw error }), issue => issue === error)
    assert.equal(calls, 1)
  }
})
