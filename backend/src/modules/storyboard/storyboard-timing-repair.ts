import { z } from 'zod'
import { generateStructuredOutput, type StructuredGenerator } from '../generation/model-output.js'
import { reportModelResult, withModelOperationStage } from '../generation/model-result-observation.js'

export type TimingIssue = {
  code: 'timing_mismatch'
  scene_id: string
  scene_duration: number
  shot_duration_sum: number
  delta: number
  field_path: string
  statusCode: 422
  retryable: false
}

export type TimingShot = { shot_id?: string | null; duration: number; [key: string]: unknown }
export type TimingScene<T extends TimingShot = TimingShot> = { scene_id: string; scene_duration: number; shots: T[]; [key: string]: unknown }

export function timingMismatch(scene: TimingScene, sceneIndex: number): TimingIssue | null {
  const shotDurationSum = scene.shots.reduce((sum, shot) => sum + shot.duration, 0)
  const delta = scene.scene_duration - shotDurationSum
  if (delta === 0) return null
  return {
    code: 'timing_mismatch', scene_id: scene.scene_id, scene_duration: scene.scene_duration,
    shot_duration_sum: shotDurationSum, delta, field_path: `scenes.${sceneIndex}.shots`, statusCode: 422, retryable: false,
  }
}

function timingError(issue: TimingIssue): never {
  const amount = Math.abs(issue.delta)
  const direction = issue.delta > 0 ? `少 ${amount} 秒` : `多 ${amount} 秒`
  throw Object.assign(new Error(`本场 ${issue.scene_duration} 秒，镜头合计 ${issue.shot_duration_sum} 秒，${direction}`), issue)
}

/** Adjust only integer durations. Reverse order makes the last, least
 * consequential shot absorb the correction while preserving all boundaries. */
export function repairTimingDeterministically<S extends TimingScene<T>, T extends TimingShot>(scene: S, sceneIndex = 0): S | null {
  const issue = timingMismatch(scene, sceneIndex)
  if (!issue) return structuredClone(scene)
  if (Math.abs(issue.delta) > 9) return null
  const shots = scene.shots.map(shot => ({ ...shot }))
  let remaining = issue.delta
  for (let index = shots.length - 1; index >= 0 && remaining !== 0; index--) {
    const shot = shots[index]!
    const capacity = remaining > 0 ? 30 - shot.duration : shot.duration - 1
    if (capacity <= 0) continue
    const change = Math.sign(remaining) * Math.min(Math.abs(remaining), capacity)
    shot.duration += change
    remaining -= change
  }
  if (remaining !== 0 || shots.some(shot => !Number.isSafeInteger(shot.duration) || shot.duration < 1 || shot.duration > 30)) return null
  return { ...scene, shots } as S
}

const timingRepairSchema = z.object({ durations: z.array(z.object({ shot_id: z.string().min(1).max(120), duration: z.number().int().min(1).max(30) }).strict()) }).strict()
type TimingRepair = z.infer<typeof timingRepairSchema>

type RepairControl = { signal: AbortSignal; steps: Record<string, unknown>; retain(key: string, value: unknown): void }

/** One-shot, scene-local fallback. The model can only return durations; all
 * identity, bounds and sum checks remain code-owned. */
export async function repairStoryboardTiming<S extends TimingScene<T>, T extends TimingShot>(scene: S, sceneIndex: number, options: {
  key: string; generate: StructuredGenerator; control: RepairControl; prompt?: string
}): Promise<S> {
  const issue = timingMismatch(scene, sceneIndex)
  if (!issue) return structuredClone(scene)
  const deterministic = repairTimingDeterministically(scene, sceneIndex)
  if (deterministic) {
    reportModelResult({ phase: 'structure', status: 'valid', stage: 'timing_repair', repair_strategy: 'deterministic_duration_allocation', repair_applied: true,
      repair_count: 0, repaired_units: [issue.field_path], failure_code: issue.code, scene_id: scene.scene_id, field_path: issue.field_path,
      scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, evidence_validation: 'passed' })
    return deterministic
  }
  const attemptKey = `${options.key}:timing:${scene.scene_id}`
  if (options.control.steps[attemptKey]) {
    throw Object.assign(new Error('本场时长无法安全分配，局部时长校正已使用；已保留原候选。'), { code: 'timing_repair_contract', correction_error_code: 'timing_repair_contract',
      scene_id: issue.scene_id, scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, field_path: issue.field_path, statusCode: 422, retryable: false })
  }
  options.control.retain(attemptKey, { attempted: true })
  const ids = scene.shots.map((shot, index) => shot.shot_id || `index:${index}`)
  const input = { scene_id: scene.scene_id, scene_duration: scene.scene_duration,
    shots: scene.shots.map((shot, index) => ({ shot_id: ids[index], duration: shot.duration, start_state: shot.start_state, end_state: shot.end_state, title: shot.title })) }
  try {
    const repaired = await withModelOperationStage('timing_repair', () => generateStructuredOutput('storyboard_timing_repair', timingRepairSchema, options.generate,
      `${options.prompt || '只修正当前场次镜头时长。'}\n只返回根对象 durations；每个 shot_id 必须逐字复制输入并且恰好返回一次，只能改变 duration。不得返回场次、镜头文本、台词或任何其他字段。${JSON.stringify(input)}`,
      { signal: options.control.signal, maxAttempts: 1, stopOnBusinessError: true, validate: value => {
        const expected = new Set(ids), received = value.durations.map(item => item.shot_id)
        if (value.durations.length !== ids.length || new Set(received).size !== received.length || received.some(id => !expected.has(id))) {
          throw Object.assign(new Error('局部时长校正必须完整且只返回当前场次的镜头 ID'), { code: 'timing_repair_contract' })
        }
        if (value.durations.reduce((sum, item) => sum + item.duration, 0) !== scene.scene_duration) {
          throw Object.assign(new Error('局部时长校正后的镜头合计仍不等于本场时长'), { code: 'timing_repair_contract' })
        }
      } }))
    const byId = new Map(repaired.durations.map(item => [item.shot_id, item.duration]))
    const result = { ...scene, shots: scene.shots.map((shot, index) => ({ ...shot, duration: byId.get(ids[index]!)! })) } as S
    const checked = timingMismatch(result, sceneIndex)
    if (checked) throw Object.assign(new Error('局部时长校正结果未通过总和校验'), { code: 'timing_repair_contract', scene_id: checked.scene_id,
      scene_duration: checked.scene_duration, shot_duration_sum: checked.shot_duration_sum, delta: checked.delta, field_path: checked.field_path, statusCode: 422, retryable: false })
    options.control.retain(attemptKey, { attempted: true, completed: true })
    reportModelResult({ phase: 'structure', status: 'valid', stage: 'timing_repair', repair_strategy: 'local_scene_duration_correction', repair_applied: true,
      repair_count: 1, repaired_units: [issue.field_path], failure_code: issue.code, scene_id: scene.scene_id, field_path: issue.field_path,
      scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, evidence_validation: 'passed' })
    return result
  } catch (error) {
    const code = (error as { code?: string }).code === 'timing_repair_contract' ? 'timing_repair_contract' : 'timing_repair_contract'
    reportModelResult({ phase: 'structure', status: 'invalid_contract', stage: 'timing_repair', repair_strategy: 'local_scene_duration_correction', repair_count: 1,
      repaired_units: [issue.field_path], failure_code: code, scene_id: scene.scene_id, field_path: issue.field_path,
      scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, evidence_validation: 'failed' })
    throw Object.assign(error as object, { correction_error_code: code, scene_id: scene.scene_id, field_path: issue.field_path,
      scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta,
      raw_output: JSON.stringify(scene), diagnostics: '局部时长校正未通过，已保留原候选和已完成镜头。' })
  }
}

export function throwTimingMismatch(scene: TimingScene, sceneIndex: number): never {
  const issue = timingMismatch(scene, sceneIndex)
  if (issue) {
    reportModelResult({ phase: 'structure', status: 'invalid_business', failure_code: issue.code, scene_id: issue.scene_id, field_path: issue.field_path,
      scene_duration: issue.scene_duration, shot_duration_sum: issue.shot_duration_sum, delta: issue.delta, evidence_validation: 'failed' })
    timingError(issue)
  }
  throw new Error('未发现时长不一致')
}
