import { z } from 'zod'
import type { StructuredGenerator } from '../generation/model-output.js'
import { generateStructuredOutput } from '../generation/model-output.js'
import { validateStoryboardDirectingReview, type StoryboardDirectingReview } from './storyboard-directing.js'
import { storyboardField, validateStoryboardRepairEvidence, type ReviewSequence } from './storyboard-review-scope.js'
import { reportModelResult, withModelOperationStage } from '../generation/model-result-observation.js'

type Plan = { scenes: Array<{ scene_id: string; scene_duration?: number; shots: Array<{ shot_id?: string | null; duration: number; audio_plan?: unknown }> }> }
/** The application copies every untouched shot. A local defect never grants
 * permission to redesign scene setup, timing, speech or unrelated shots. */
export async function repairStoryboardTargets<T extends Plan>(input: {
  candidate: T; report: StoryboardDirectingReview; shotSchema: z.ZodType<T['scenes'][number]['shots'][number]>;
  generate: StructuredGenerator; prompt: string; signal?: AbortSignal; allowTimingChange?: boolean
  exactScope?: boolean; sourceTexts?: string[]; sceneDirectionSchema?: z.ZodType
}): Promise<T> {
  if (input.exactScope) return repairExactTargets(input)
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

async function repairExactTargets<T extends Plan>(input: {
  candidate: T; report: StoryboardDirectingReview; shotSchema: z.ZodType<T['scenes'][number]['shots'][number]>;
  generate: StructuredGenerator; prompt: string; signal?: AbortSignal; allowTimingChange?: boolean; sourceTexts?: string[]; sceneDirectionSchema?: z.ZodType
}): Promise<T> {
  const targets = new Map<string, { scene_id: string; shot_index: number | null; field: string }>()
  const sceneList = input.candidate.scenes as unknown as ReviewSequence
  validateStoryboardDirectingReview(input.report, input.candidate.scenes as Parameters<typeof validateStoryboardDirectingReview>[1], { strictEvidence: true, sourceTexts: input.sourceTexts })
  for (const issue of input.report.issues.filter(issue => issue.severity === 'error')) {
    validateStoryboardRepairEvidence(issue, sceneList, input.sourceTexts, true)
    const scopes = issue.repair_scope!
    for (const scope of scopes) for (const field of scope.fields) {
      if (field === 'duration' && !(input.allowTimingChange && issue.timing_change && scope.scene_id === issue.scene_id && scope.shot_index === issue.shot_index)) {
        throw new Error('当前问题没有获得镜头时长调整权限')
      }
      if (scope.shot_index === null && !issue.evidence_refs?.some(reference => reference.scene_id === scope.scene_id && reference.shot_index === null && reference.field === field)) {
        throw new Error('场面调度只能按精确原文证据修复')
      }
      targets.set(`${scope.scene_id}:${scope.shot_index}:${field}`, { scene_id: scope.scene_id, shot_index: scope.shot_index, field })
    }

  }
  if (!targets.size) return structuredClone(input.candidate)
  if (targets.size > 32) throw new Error('已核实问题超出局部字段修复上限，请缩小范围或重新规划')
  const entries = [...targets.values()].map((target, index) => ({ ...target, key: `field_${index}` }))
  const schemaFor = (field: string, scene: boolean) => {
    let schema = scene ? input.sceneDirectionSchema : input.shotSchema
    for (const part of (scene ? field.replace(/^scene_direction\./, '') : field).split('.')) {
      schema = (schema as z.ZodObject | undefined)?.shape?.[part]
    }
    if (!schema) throw new Error('修复字段不属于当前输出契约')
    return schema
  }
  const schema = z.object({ repairs: z.object(Object.fromEntries(entries.map(target => [target.key, schemaFor(target.field, target.shot_index === null)]))).strict() }).strict()
  const location = (target: typeof entries[number]) => {
    const scene = input.candidate.scenes.find(scene => scene.scene_id === target.scene_id)!
    return target.shot_index === null ? scene : scene.shots[target.shot_index]
  }
  const sequence = input.candidate.scenes.flatMap(scene => scene.shots.map((shot, shot_index) => ({ scene_id: scene.scene_id, shot_index, shot })))
  const selected = new Set<number>()
  for (const target of entries) for (let index = 0; index < sequence.length; index++) {
    const item = sequence[index]!
    if (item.scene_id === target.scene_id && (target.shot_index === null || item.shot_index === target.shot_index)) {
      for (const neighbour of [index - 1, index, index + 1]) if (neighbour >= 0 && neighbour < sequence.length) selected.add(neighbour)
    }
  }
  const context = input.candidate.scenes.flatMap(scene => {
    const shots = sequence.flatMap((item, index) => item.scene_id === scene.scene_id && selected.has(index) ? [{ shot_index: item.shot_index, ...item.shot }] : [])
    return shots.length ? [{ ...scene, shots }] : []
  })
  const patch = await withModelOperationStage('content_repair', () => generateStructuredOutput('storyboard_targeted_repair', schema, input.generate,
    input.prompt + '\n【只修复有证据的镜头】\n只返回repairs的固定key值，每个key对应程序指定的单一字段。不能删字段、改路径、返回完整方案或改未授权值。' +
    '只有issues明确timing_change:true且创作者选择重新估时的目标主镜允许改时长。保留原事实、身份、顺序、逐字声音和未授权时长；邻镜只读。修复场面调度时保持其他已接受决策。\n' +
    JSON.stringify({ targets: entries.map(target => ({ ...target, current: storyboardField(location(target), target.field) })),
      issues: input.report.issues.filter(issue => issue.severity === 'error'), readonly_plan: { scenes: context } }), { signal: input.signal }))
  input.signal?.throwIfAborted()
  const result = structuredClone(input.candidate)
  for (const target of entries) {
    const scene = result.scenes.find(scene => scene.scene_id === target.scene_id)!
    let current = (target.shot_index === null ? scene : scene.shots[target.shot_index]) as Record<string, unknown>
    const parts = target.field.split('.')
    for (const part of parts.slice(0, -1)) current = current[part] as Record<string, unknown>
    current[parts.at(-1)!] = patch.repairs[target.key]
  }
  for (const scene of result.scenes) {
    for (const shot of scene.shots) input.shotSchema.parse(shot)
    if (input.allowTimingChange && scene.scene_duration !== undefined) scene.scene_duration = scene.shots.reduce((sum, shot) => sum + shot.duration, 0)
  }
  reportModelResult({ stage: 'content_repair', phase: 'structure', status: 'valid', repaired: true })
  return result
}
