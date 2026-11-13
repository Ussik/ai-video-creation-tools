import { z } from 'zod'
import type { StructuredGenerator } from '../generation/model-output.js'
import { generateStructuredOutput } from '../generation/model-output.js'
import type { StoryboardDirectingReview } from './storyboard-directing.js'

type Plan = { scenes: Array<{ scene_id: string; scene_duration?: number; shots: Array<{ shot_id?: string | null; duration: number; audio_plan?: unknown }> }> }
/** The application copies every untouched shot. A local defect never grants
 * permission to redesign scene setup, timing, speech or unrelated shots. */
export async function repairStoryboardTargets<T extends Plan>(input: {
  candidate: T; report: StoryboardDirectingReview; shotSchema: z.ZodType<T['scenes'][number]['shots'][number]>;
  generate: StructuredGenerator; prompt: string; signal?: AbortSignal; allowTimingChange?: boolean
}): Promise<T> {
  const targets = new Map<string, { scene_id: string; shot_index: number }>()
  for (const issue of input.report.issues.filter(issue => issue.severity === 'error')) {
    targets.set(`${issue.scene_id}:${issue.shot_index}`, { scene_id: issue.scene_id, shot_index: issue.shot_index })
    if (issue.related_scene_id !== null && issue.related_shot_index !== null) targets.set(`${issue.related_scene_id}:${issue.related_shot_index}`, { scene_id: issue.related_scene_id, shot_index: issue.related_shot_index })
  }
  if (!targets.size) return structuredClone(input.candidate)
  const schema = z.object({ patches: z.array(z.object({ scene_id: z.string(), shot_index: z.number().int().nonnegative(),
    shot: input.shotSchema }).strict()).length(targets.size) }).strict()
  const validate = (value: z.infer<typeof schema>) => {
    const seen = new Set<string>()
    for (const patch of value.patches) {
      const key = `${patch.scene_id}:${patch.shot_index}`, source = input.candidate.scenes.find(scene => scene.scene_id === patch.scene_id)?.shots[patch.shot_index]
      if (!targets.has(key) || seen.has(key) || !source) throw new Error('局部修复只能逐项返回已授权镜头，不得新增、遗漏、重复或改动其他镜头')
      seen.add(key)
      const timingAuthorized = input.allowTimingChange && input.report.issues.some(issue => issue.severity === 'error' && issue.timing_change === true && issue.scene_id === patch.scene_id && issue.shot_index === patch.shot_index)
      if ((patch.shot.shot_id ?? null) !== (source.shot_id ?? null) || !timingAuthorized && patch.shot.duration !== source.duration
        || JSON.stringify(patch.shot.audio_plan) !== JSON.stringify(source.audio_plan)) throw new Error('局部修复不得改变镜头身份、已确定时长或逐字声音计划；需要全局调整时须说明原因并由创作者重新规划')
    }
  }
  const result = await generateStructuredOutput('storyboard_targeted_repair', schema, input.generate,
    input.prompt + '\n【只修复有证据的镜头】\n' +
    '下方完整方案仅作为只读上下文。只按targets返回patches，每个目标一次；shot为该镜修复后的完整字段。' +
    (input.allowTimingChange ? '只有issues明确timing_change:true的目标主镜允许改时长，其他镜头时长保持不变。' : '') +
    '保持场次、镜头数量、镜头ID、顺序、时长、原有逐字台词与声音计划；不修改场面调度或其他镜头，不用新增剧情或删台词回避缺陷。' +
    '相邻镜头只供核对连接。不能局部解决的全局原因保留待创作者判断，不擅自重写完整方案。\n' +
    JSON.stringify({ targets: [...targets.values()], issues: input.report.issues, readonly_plan: input.candidate }),
  { signal: input.signal, validate })
  input.signal?.throwIfAborted()
  const candidate = structuredClone(input.candidate)
  for (const patch of result.patches) candidate.scenes.find(scene => scene.scene_id === patch.scene_id)!.shots[patch.shot_index] = patch.shot
  if (input.allowTimingChange) for (const scene of candidate.scenes) if (scene.scene_duration !== undefined) scene.scene_duration = scene.shots.reduce((sum, shot) => sum + shot.duration, 0)
  return candidate
}
