import assert from 'node:assert/strict'
import test from 'node:test'
import { repairStoryboardTiming, repairTimingDeterministically, timingMismatch } from '../src/modules/storyboard/storyboard-timing-repair.js'

const scene = (scene_duration: number, durations: number[]) => ({ scene_id: 'scene-1', scene_duration,
  scene_direction: { axis: 'x' }, shots: durations.map((duration, index) => ({ shot_id: `shot-${index}`, duration, title: `镜头${index}` })) })

test('reports a structured one-second timing mismatch', () => {
  const issue = timingMismatch(scene(20, [9, 10]), 2)
  assert.deepEqual(issue && { code: issue.code, scene_id: issue.scene_id, scene_duration: issue.scene_duration,
    shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, field_path: issue.field_path },
  { code: 'timing_mismatch', scene_id: 'scene-1', scene_duration: 20, shot_duration_sum: 19, delta: 1, field_path: 'scenes.2.shots' })
})

test('allocates a small deficit from the last shot and preserves scene content', () => {
  const input = scene(120, [30, 30, 30, 21])
  const repaired = repairTimingDeterministically(input, 0)!
  assert.deepEqual(repaired.shots.map(shot => shot.duration), [30, 30, 30, 30])
  assert.equal(repaired.scene_duration, 120)
  assert.equal(repaired.shots[0]!.title, '镜头0')
})

test('allocates an overage without dropping a shot below one second', () => {
  const repaired = repairTimingDeterministically(scene(20, [10, 10, 9]), 0)!
  assert.deepEqual(repaired.shots.map(shot => shot.duration), [10, 9, 1])
})

test('defers a large or capacity-exceeding mismatch to the local repair contract', () => {
  assert.equal(repairTimingDeterministically(scene(100, [30, 30, 30]), 0), null)
  assert.equal(repairTimingDeterministically(scene(30, [1, 1, 1]), 0), null)
})

test('delta 18 uses one scene-local duration contract after deterministic allocation is unsafe', async () => {
  const input = scene(120, [30, 30, 30, 12])
  let calls = 0
  const steps: Record<string, unknown> = {}
  const result = await repairStoryboardTiming(input, 0, {
    key: 'outline-key',
    generate: async prompt => {
      calls++
      assert.match(prompt, /scene-1/)
      return JSON.stringify({ durations: input.shots.map(shot => ({ shot_id: shot.shot_id, duration: shot.shot_id === 'shot-3' ? 30 : shot.duration })) })
    },
    control: { signal: new AbortController().signal, steps, retain(key, value) { steps[key] = value } },
  })
  assert.equal(calls, 1)
  assert.equal(result.shots.reduce((sum, shot) => sum + shot.duration, 0), 120)
  assert.equal(result.shots.at(-1)!.duration, 30)
})
