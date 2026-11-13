import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { generateStoryboardPlanningBatches } from '../src/modules/storyboard/storyboard-planning-batches.js'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'

const compactShot = z.object({ shot_id: z.string().nullable(), title: z.string(), prompt: z.string(),
  duration: z.number().int().min(1).max(30), start_state: z.string(), end_state: z.string(), cut_note: z.string(),
  audio_plan: z.object({ speech: z.array(z.string()) }).strict(),
}).strict()
const outlineSchema = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number(),
  scene_direction: z.object({ axis: z.string() }).strict(), shots: z.array(compactShot).min(1),
}).strict()).min(1) }).strict()
const expansionSchema = z.object({ image_prompt: z.string(), video_prompt: z.string(),
  directing: z.object({ purpose: z.string() }).strict(),
}).strict()
const fullSchema = z.object({ scenes: z.array(outlineSchema.shape.scenes.element.extend({
  shots: z.array(compactShot.extend(expansionSchema.shape)).min(1),
})) })
const makeShot = (index: number) => ({ shot_id: index === 0 ? 'existing-shot' : null, title: `镜头${index}`,
  prompt: `动作节拍${index}`, duration: 5, start_state: `状态${index}`, end_state: `状态${index + 1}`, cut_note: `交接${index}`,
  audio_plan: { speech: [`台词${index}`] },
})
const sourceOutline = () => ({ scenes: [
  { scene_id: 'scene-a', scene_duration: 15, scene_direction: { axis: '北侧' }, shots: [makeShot(0), makeShot(1), makeShot(2)] },
  { scene_id: 'scene-b', scene_duration: 5, scene_direction: { axis: '南侧' }, shots: [makeShot(3)] },
] })
function fixture(steps: Record<string, unknown> = {}) {
  const controller = new AbortController(), calls: string[] = [], progress: unknown[] = []
  const control = { signal: controller.signal, steps,
    retain: (key: string, value: unknown) => { steps[key] = structuredClone(value) },
    progress: (value: unknown) => { progress.push(value) },
  }
  const reply = (prompt: string, contract?: { name: string }) => {
    if (contract?.name === 'storyboard_scene_plan') { calls.push('outline'); return sourceOutline() }
    assert.equal(contract?.name, 'storyboard_shot_batch')
    const batch = JSON.parse(prompt.split('本批：')[1]!) as { scene_id: string; shot_indexes: number[] }
    calls.push(`${batch.scene_id}:${batch.shot_indexes.join(',')}`)
    return { scene_id: batch.scene_id, shots: batch.shot_indexes.map(shot_index => ({ shot_index,
      expansion: { image_prompt: `首帧${shot_index}`, video_prompt: `连续动作${shot_index}`, directing: { purpose: `职责${shot_index}` } },
    })) }
  }
  const generate: StructuredGenerator = async (prompt, contract) => JSON.stringify(reply(prompt, contract))
  let finalized = 0
  const options = { namespace: 'initial' as const, prompt: '完整剧情与分镜/运动规则', outlinePrompt: '完整剧情与分镜规则',
    outlineSchema, expansionSchema, generate, control,
    validateOutline(value: z.infer<typeof outlineSchema>) {
      assert.deepEqual(value.scenes.map(scene => scene.scene_id), ['scene-a', 'scene-b'])
      for (const scene of value.scenes) assert.equal(scene.shots.reduce((sum, shot) => sum + shot.duration, 0), scene.scene_duration)
      assert.equal(value.scenes[0]!.shots[0]!.shot_id, 'existing-shot')
    },
    validateBatch(shots: Array<z.infer<typeof compactShot> & z.infer<typeof expansionSchema>>) {
      for (const shot of shots) assert.deepEqual(shot.audio_plan.speech, [`台词${shot.title.slice(2)}`])
    },
    finalize(value: unknown) { finalized++; return fullSchema.parse(value) },
  }
  return { options, calls, progress, reply, controller, steps, finalized: () => finalized }
}

test('a complete outline locks timing and dialogue while each expansion contains at most two shots', async () => {
  const f = fixture(), result = await generateStoryboardPlanningBatches(f.options)
  assert.deepEqual(f.calls, ['outline', 'scene-a:0,1', 'scene-a:2', 'scene-b:0'])
  assert.equal(f.finalized(), 1)
  assert.equal(Object.keys(f.steps).length, 4)
  assert.equal(result.scenes[0]!.shots[0]!.duration, 5)
  assert.equal(result.scenes[0]!.shots[0]!.shot_id, 'existing-shot')
  assert.deepEqual(result.scenes[0]!.shots[0]!.audio_plan, { speech: ['台词0'] })
  assert.equal(result.scenes[0]!.shots[0]!.image_prompt, '首帧0')
  assert.deepEqual(f.progress, [
    { phase: 'outline', completed_shots: 0, total_shots: 0 },
    { phase: 'shots', completed_shots: 0, total_shots: 4 },
    { phase: 'shots', completed_shots: 2, total_shots: 4 },
    { phase: 'shots', completed_shots: 3, total_shots: 4 },
    { phase: 'shots', completed_shots: 4, total_shots: 4 },
  ])
})

test('a stream reset retries only its batch, then explicit recovery reuses the validated outline and earlier shots', async () => {
  const f = fixture()
  f.options.generate = async (prompt, contract) => {
    const value = f.reply(prompt, contract)
    if (f.calls.at(-1) === 'scene-a:2') {
      const error = new TextProviderError('upstream stream disconnected', true, 'stream_read_error', 200)
      error.raw_output = '{"scene_id":"scene-a","shots":['
      throw error
    }
    return JSON.stringify(value)
  }
  await assert.rejects(generateStoryboardPlanningBatches(f.options), /upstream stream disconnected/)
  assert.deepEqual(f.calls, ['outline', 'scene-a:0,1', 'scene-a:2', 'scene-a:2'])
  assert.equal(Object.keys(f.steps).length, 2, 'incomplete transport text is never checkpointed')
  assert.equal(f.finalized(), 0)
  const resumed = fixture(structuredClone(f.steps))
  const result = await generateStoryboardPlanningBatches(resumed.options)
  assert.deepEqual(resumed.calls, ['scene-a:2', 'scene-b:0'])
  assert.equal(result.scenes.flatMap(scene => scene.shots).length, 4)
  assert.equal(resumed.finalized(), 1)
})

test('invalid duplicate, reordered and foreign-scene batches never become checkpoints', async t => {
  for (const mode of ['duplicate', 'reordered', 'foreign'] as const) await t.test(mode, async () => {
    const f = fixture()
    f.options.generate = async (prompt, contract) => {
      const value = f.reply(prompt, contract)
      if ('shots' in value) {
        if (mode === 'foreign') value.scene_id = 'unselected-scene'
        else if (mode === 'duplicate') value.shots[1]!.shot_index = value.shots[0]!.shot_index
        else value.shots.reverse()
      }
      return JSON.stringify(value)
    }
    await assert.rejects(generateStoryboardPlanningBatches(f.options), /不符合 storyboard_shot_batch 契约/)
    assert.equal(Object.keys(f.steps).length, 1)
    assert.equal(f.finalized(), 0)
    assert.equal(f.calls.length, 3, 'one format correction is bounded to the rejected batch')
  })
})

test('even a relaxed expansion schema cannot overwrite locked outline fields', async () => {
  const f = fixture()
  await assert.rejects(generateStoryboardPlanningBatches({ ...f.options, expansionSchema: expansionSchema.passthrough(),
    generate: async (prompt, contract) => {
      const value = f.reply(prompt, contract)
      if ('shots' in value) Object.assign(value.shots[0]!.expansion, { duration: 30, audio_plan: { speech: ['新增台词'] } })
      return JSON.stringify(value)
    },
  }), /扩写不能覆盖大纲/)
  assert.equal(Object.keys(f.steps).length, 1)
})

test('semantic source validation rejects the outline before expansion and revalidates saved outlines', async () => {
  const f = fixture()
  await assert.rejects(generateStoryboardPlanningBatches({ ...f.options,
    validateOutline: () => { throw new Error('台词没有原文来源') },
  }), /台词没有原文来源/)
  assert.deepEqual(f.calls, ['outline', 'outline'])
  assert.equal(Object.keys(f.steps).length, 0)
  const accepted = fixture()
  await generateStoryboardPlanningBatches(accepted.options)
  const restored = fixture(accepted.steps)
  await assert.rejects(generateStoryboardPlanningBatches({ ...restored.options,
    validateOutline: () => { throw new Error('恢复时来源校验失败') },
  }), /恢复时来源校验失败/)
  assert.deepEqual(restored.calls, [], 'saved source failures cannot dispatch more model requests')
})

test('saved batches receive semantic validation again before later batches can run', async () => {
  const f = fixture()
  f.options.generate = async (prompt, contract) => {
    const value = f.reply(prompt, contract)
    if (f.calls.at(-1) === 'scene-a:2') throw new Error('interrupted')
    return JSON.stringify(value)
  }
  await assert.rejects(generateStoryboardPlanningBatches(f.options), /interrupted/)
  const resumed = fixture(f.steps)
  await assert.rejects(generateStoryboardPlanningBatches({ ...resumed.options,
    validateBatch: () => { throw new Error('已保存镜头不满足来源契约') },
  }), /已保存镜头不满足来源契约/)
  assert.deepEqual(resumed.calls, [])
})

test('cancellation retains only complete batches and recovery does not repeat them', async () => {
  const f = fixture()
  const retain = f.options.control.retain
  f.options.control.retain = (key, value) => {
    retain(key, value)
    if (Object.keys(f.steps).length === 2) f.controller.abort(new Error('creator cancelled'))
  }
  await assert.rejects(generateStoryboardPlanningBatches(f.options), /creator cancelled/)
  assert.deepEqual(f.calls, ['outline', 'scene-a:0,1'])
  const resumed = fixture(f.steps)
  await generateStoryboardPlanningBatches(resumed.options)
  assert.deepEqual(resumed.calls, ['scene-a:2', 'scene-b:0'])
})

test('repair, task prompt, outline prompt and schema changes never borrow initial batch checkpoints', async () => {
  const f = fixture()
  await generateStoryboardPlanningBatches(f.options)
  for (const changed of [
    { namespace: 'repair' as const }, { prompt: '已修订运动规则' }, { outlinePrompt: '已修订分镜规则' },
    { expansionSchema: expansionSchema.describe('new contract revision') },
  ]) {
    const resumed = fixture(structuredClone(f.steps))
    await generateStoryboardPlanningBatches({ ...resumed.options, ...changed })
    assert.deepEqual(resumed.calls, ['outline', 'scene-a:0,1', 'scene-a:2', 'scene-b:0'])
  }
})

test('full-plan validation remains mandatory after all batches complete', async () => {
  const f = fixture()
  await assert.rejects(generateStoryboardPlanningBatches({ ...f.options,
    finalize: () => { throw new Error('最终完整方案未通过连续性约束') },
  }), /最终完整方案未通过连续性约束/)
  assert.equal(Object.keys(f.steps).length, 4, 'complete batches survive a final validation failure for diagnosis')
  assert.equal(f.calls.length, 4)
})
