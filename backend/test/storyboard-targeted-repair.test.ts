import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { repairStoryboardTargets } from '../src/modules/storyboard/storyboard-targeted-repair.js'
import type { StoryboardDirectingReview } from '../src/modules/storyboard/storyboard-directing.js'
const shotSchema = z.object({ shot_id: z.string(), duration: z.number(), audio_plan: z.object({ text: z.string() }), body: z.string() }).strict()
const plan = () => ({ scenes: [{ scene_id: 'scene', scene_duration: 15, scene_direction: { locked: '原样场面' }, shots: [
  { shot_id: 'first', duration: 5, audio_plan: { text: '逐字台词。' }, body: '开镜🚆\n保留空格  ' },
  { shot_id: 'target', duration: 5, audio_plan: { text: '第二句。' }, body: '需要修复的镜头' },
  { shot_id: 'untouched', duration: 5, audio_plan: { text: '第三句。' }, body: '原字节\n  不受影响。' },
] }] })
const report = (): StoryboardDirectingReview => ({ issues: [{ code: 'first_frame_conflict', scene_id: 'scene', shot_index: 1,
  related_scene_id: null, related_shot_index: null, severity: 'error', message: '第二镜首帧提前呈现动作。', evidence: '需要修复', repair: '只修第二镜。' }] })

test('local repair copies untouched shots and scene setup exactly and leaves the original candidate immutable', async () => {
  const original = plan(), bytes = JSON.stringify(original), target = { ...original.scenes[0]!.shots[1]!, body: '修复后的首帧' }
  let calls = 0
  const result = await repairStoryboardTargets({ candidate: original, report: report(), shotSchema, prompt: '创作者要求。',
    generate: async (prompt, contract) => {
      calls++; assert.equal(contract!.name, 'storyboard_targeted_repair')
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)); assert.deepEqual(data.targets, [{ scene_id: 'scene', shot_index: 1 }])
      return JSON.stringify({ patches: [{ scene_id: 'scene', shot_index: 1, shot: target }] })
    } })
  assert.equal(JSON.stringify(original), bytes); assert.equal(calls, 1)
  assert.equal(JSON.stringify(result.scenes[0]!.shots[0]), JSON.stringify(original.scenes[0]!.shots[0]))
  assert.equal(JSON.stringify(result.scenes[0]!.shots[2]), JSON.stringify(original.scenes[0]!.shots[2]))
  assert.deepEqual(result.scenes[0]!.scene_direction, original.scenes[0]!.scene_direction)
  assert.equal(result.scenes[0]!.shots[1]!.body, '修复后的首帧')
})

test('foreign targets and changes to locked identity, speech or timing never enter the candidate', async t => {
  for (const patch of [{ shot_index: 2 }, { shot_id: 'other' }, { audio_plan: { text: '偷换台词' } }, { duration: 8 }]) await t.test(JSON.stringify(patch), async () => {
    const original = plan(), bytes = JSON.stringify(original)
    await assert.rejects(repairStoryboardTargets({ candidate: original, report: report(), shotSchema, prompt: '', generate: async () => {
      const { shot_index, ...fields } = patch as { shot_index?: number; shot_id?: string; audio_plan?: { text: string }; duration?: number }
      return JSON.stringify({ patches: [{ scene_id: 'scene', shot_index: shot_index ?? 1, shot: { ...original.scenes[0]!.shots[1], ...fields } }] })
    } }))
    assert.equal(JSON.stringify(original), bytes)
  })
})

test('retiming requires both creator reestimation policy and explicit reviewer timing authority', async () => {
  const original = plan(), checked = report(); checked.issues[0]!.timing_change = true
  const generate = async () => JSON.stringify({ patches: [{ scene_id: 'scene', shot_index: 1, shot: { ...original.scenes[0]!.shots[1], duration: 8 } }] })
  await assert.rejects(repairStoryboardTargets({ candidate: original, report: checked, shotSchema, prompt: '', generate }))
  await assert.rejects(repairStoryboardTargets({ candidate: original, report: report(), shotSchema, prompt: '', generate, allowTimingChange: true }))
  const revised = await repairStoryboardTargets({ candidate: original, report: checked, shotSchema, prompt: '', generate, allowTimingChange: true })
  assert.equal(revised.scenes[0]!.scene_duration, 18); assert.equal(revised.scenes[0]!.shots[0]!.duration, 5)
})
