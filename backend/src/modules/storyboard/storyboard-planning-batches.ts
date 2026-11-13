import { createHash } from 'node:crypto'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredGenerator } from '../generation/model-output.js'
import type { StoryboardPlanningControl } from './storyboard-planning-tasks.js'
import { withModelOperationStage } from '../generation/model-result-observation.js'

export type StoryboardOutlineShot = {
  shot_id?: string | null; title: string; prompt: string; duration: number
  start_state: string; end_state: string; cut_note: string
}
export type StoryboardPlanningOutline<Shot extends StoryboardOutlineShot, Direction> = {
  scenes: Array<{ scene_id: string; scene_duration: number; scene_direction: Direction; shots: Shot[] }>
}
type BatchControl = Pick<StoryboardPlanningControl, 'signal' | 'steps' | 'retain'> & {
  progress?(value: { phase: 'outline' | 'shots'; completed_shots: number; total_shots: number }): void
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 422 }) }

/** A full, validated outline locks the timing, dialogue and cut boundaries.
 * Expansion requests only add image/video/camera detail to at most two shots.
 * Each complete batch is durable before starting the next model request. */
export async function generateStoryboardPlanningBatches<Shot extends StoryboardOutlineShot, Direction, Expansion extends object, Result>(options: {
  namespace: 'initial' | 'repair'
  prompt: string; outlinePrompt?: string
  correctionInstructions?: string
  /** New planners use one shot; omitted only for compatible older callers. */
  batchSize?: 1 | 2
  structuralRepair?: boolean
  resolveOutline?(outline: StoryboardPlanningOutline<Shot, Direction>, outlineKey: string): Promise<StoryboardPlanningOutline<Shot, Direction>>
  expansionPrompt?(scene: StoryboardPlanningOutline<Shot, Direction>['scenes'][number], offset: number, count: number, outline: StoryboardPlanningOutline<Shot, Direction>): string
  outlineSchema: z.ZodType<StoryboardPlanningOutline<Shot, Direction>>
  expansionSchema: z.ZodType<Expansion>
  generate: StructuredGenerator; control: BatchControl
  validateOutline(value: StoryboardPlanningOutline<Shot, Direction>): void
  validateBatch?(shots: Array<Shot & Expansion>, scene: StoryboardPlanningOutline<Shot, Direction>['scenes'][number], offset: number): void
  finalize(value: StoryboardPlanningOutline<Shot & Expansion, Direction>): Result
}): Promise<Result> {
  const { control } = options
  const batchSize = options.batchSize ?? 2
  const assertActive = () => control.signal.throwIfAborted()
  const prefix = `storyboard_batches:v1:${options.namespace}:` + hash({
    prompt: options.prompt, outlinePrompt: options.outlinePrompt ?? options.prompt, correctionInstructions: options.correctionInstructions,
    outline: z.toJSONSchema(options.outlineSchema, { io: 'input', unrepresentable: 'any' }),
    expansion: z.toJSONSchema(options.expansionSchema, { io: 'input', unrepresentable: 'any' }),
  })
  const outlineKey = `${prefix}:outline`
  const validateOutline = (value: StoryboardPlanningOutline<Shot, Direction>) => {
    // Scope validation belongs to the caller; uniqueness is also required here
    // because scene identity forms the durable batch namespace.
    if (new Set(value.scenes.map(scene => scene.scene_id)).size !== value.scenes.length) invalid('场面大纲包含重复场次，不能开始镜头扩写')
    for (const scene of value.scenes) if (!scene.shots.length) invalid('场面大纲缺少镜头，不能开始镜头扩写')
    options.validateOutline(value)
  }
  assertActive()
  control.progress?.({ phase: 'outline', completed_shots: 0, total_shots: 0 })
  let outline: StoryboardPlanningOutline<Shot, Direction>
  if (Object.hasOwn(control.steps, outlineKey)) {
    outline = options.outlineSchema.parse(control.steps[outlineKey]); validateOutline(outline)
  } else {
    outline = await withModelOperationStage('outline_generation', () => generateStructuredOutput('storyboard_scene_plan', options.outlineSchema, options.generate,
      (options.outlinePrompt ?? options.prompt) + '\n【本次仅生成完整场面与镜头大纲】\n' +
      '这是分批分镜的第一阶段。先完整设计全部所选场次的调度、镜头顺序、叙事职责、起止状态、接镜和时长。' +
      '每镜prompt写完整动作与对白节拍，audio_plan把所有有来源的台词、旁白逐字分配到对应镜头，并明确共同声场和必要声音；不能把同一句台词重复分配到相邻镜头。' +
      'scene_direction仅包含anchors、blocking、axis、dramatic_progression、sound这五个精确字段；不使用staging、emotional_arc或其他同义键。' +
      '所有JSON字符串内的英文双引号必须转义，或在正文表达中使用中文引号；不要输出Markdown代码围栏。' +
      '本次不扩写image_prompt、video_prompt或逐镜directing；后续只会在此大纲上补充画面与摄影，不会重新分配台词或调整镜头边界。只按本次Schema返回完整大纲。',
    { signal: control.signal, validate: validateOutline, correctionInstructions: options.correctionInstructions, structuralRepair: options.structuralRepair }))
    assertActive(); control.retain(outlineKey, outline)
  }
  assertActive()
  const originalOutline = outline
  if (options.resolveOutline) { outline = await options.resolveOutline(outline, outlineKey); assertActive(); validateOutline(outline) }
  const outlineHash = hash(outline)
  const originalHash = hash(originalOutline)
  const totalShots = outline.scenes.reduce((sum, scene) => sum + scene.shots.length, 0)
  const checkpointKey = (sceneId: string, offset: number, single = false, sourceHash = outlineHash) =>
    `${prefix}:${sourceHash}:${hash(sceneId)}:${offset}${single ? ':single' : ''}`
  const compatible = (scene: typeof outline.scenes[number], offset: number) => {
    const previous = originalOutline.scenes.find(item => item.scene_id === scene.scene_id)
    if (!previous || offset >= previous.shots.length) return false
    // The actual expansion prompt is the dependency boundary. Custom prompts
    // may include cross-scene neighbours; the default sends the full outline.
    return options.expansionPrompt
      ? options.expansionPrompt(scene, offset, 1, outline) === options.expansionPrompt(previous, offset, 1, originalOutline)
      : originalHash === outlineHash
  }
  const batchSchemaFor = (sceneId: string, offset: number, count: number) => z.object({
    scene_id: z.literal(sceneId), shots: z.array(z.object({
      shot_index: z.number().int().min(offset).max(offset + count - 1), expansion: options.expansionSchema,
    }).strict()).length(count),
  }).strict()
  type Batch = z.infer<ReturnType<typeof batchSchemaFor>>
  const merge = (value: Batch, scene: typeof outline.scenes[number], offset: number) => {
    if (value.shots.some((item, index) => item.shot_index !== offset + index)) invalid('镜头扩写必须按本批指定的镜头序号各返回一次，不得重复、遗漏或调换顺序')
    const expanded = value.shots.map(({ shot_index, expansion }) => {
      const original = scene.shots[shot_index]!
      if (Object.keys(expansion).some(key => Object.hasOwn(original, key))) invalid('镜头扩写不能覆盖大纲中的镜头身份、叙事、台词、时长或接镜字段')
      // The outline stays authoritative even if an injected schema is
      // later relaxed. Expanded fields never override a locked value.
      return { ...expansion, ...original } as Shot & Expansion
    })
    options.validateBatch?.(expanded, scene, offset)
    return expanded
  }
  const legacySingles = new Map<string, Batch>()
  if (batchSize === 1) {
    if (originalHash !== outlineHash) for (const scene of outline.scenes) for (let offset = 0; offset < scene.shots.length; offset++) {
      const key = checkpointKey(scene.scene_id, offset, true), previous = checkpointKey(scene.scene_id, offset, true, originalHash)
      if (Object.hasOwn(control.steps, key) || !compatible(scene, offset) || !Object.hasOwn(control.steps, previous)) continue
      const batch = batchSchemaFor(scene.scene_id, offset, 1).parse(control.steps[previous]); merge(batch, scene, offset)
      legacySingles.set(key, batch)
    }
    // Validate every reusable legacy pair before dispatching new expansions.
    // A corrupt paid checkpoint must fail rather than silently be regenerated.
    for (const sourceHash of new Set([outlineHash, originalHash])) for (const scene of outline.scenes) for (let offset = 0; offset < scene.shots.length; offset += 2) {
      assertActive()
      const count = Math.min(2, scene.shots.length - offset)
      const missing = Array.from({ length: count }, (_, index) => offset + index)
        .filter(index => !Object.hasOwn(control.steps, checkpointKey(scene.scene_id, index, true))
          && !legacySingles.has(checkpointKey(scene.scene_id, index, true)) && (sourceHash === outlineHash || compatible(scene, index)))
      const legacyKey = checkpointKey(scene.scene_id, offset, false, sourceHash)
      if (!missing.length || !Object.hasOwn(control.steps, legacyKey)) continue
      const legacy = batchSchemaFor(scene.scene_id, offset, count).parse(control.steps[legacyKey])
      merge(legacy, scene, offset)
      assertActive()
      for (const index of missing) legacySingles.set(checkpointKey(scene.scene_id, index, true), {
        scene_id: scene.scene_id, shots: [legacy.shots[index - offset]!],
      })
    }
  }
  let completedShots = 0
  control.progress?.({ phase: 'shots', completed_shots: 0, total_shots: totalShots })
  const scenes: StoryboardPlanningOutline<Shot & Expansion, Direction>['scenes'] = []
  for (const scene of outline.scenes) {
    const shots: Array<Shot & Expansion> = []
    for (let offset = 0; offset < scene.shots.length; offset += batchSize) {
      assertActive()
      const count = Math.min(batchSize, scene.shots.length - offset)
      const indexes = Array.from({ length: count }, (_, index) => offset + index)
      const batchSchema = batchSchemaFor(scene.scene_id, offset, count)
      const key = checkpointKey(scene.scene_id, offset, batchSize === 1)
      let batch: Batch
      if (Object.hasOwn(control.steps, key)) {
        batch = batchSchema.parse(control.steps[key]); merge(batch, scene, offset)
      } else if (legacySingles.has(key)) {
        batch = batchSchema.parse(legacySingles.get(key)); merge(batch, scene, offset)
        assertActive(); control.retain(key, batch)
      } else {
        batch = await withModelOperationStage('shot_expansion', () => generateStructuredOutput('storyboard_shot_batch', batchSchema, options.generate,
          (options.expansionPrompt?.(scene, offset, count, outline) ?? options.prompt) + '\n【仅扩写本批镜头的画面与摄影】\n' +
          '整场大纲已通过校验，是本次镜头身份、时长、台词分配、动作起止与接镜的唯一边界。' +
          '只返回指定镜头序号的expansion字段；不能重新规划镜头、重分配台词或修改大纲。' +
          '参考完整大纲中的前后镜头，首帧、连续动作、摄影终点与接镜须相容，不重复相邻镜已经完成的动作。' +
          'audio_plan已锁定，video_prompt不重复下达台词、旁白、声场或音乐指令。' +
          'directing仅含purpose、camera、cut；cut.carry_over即使末镜ending也必须说明具体收束状态，不能留空。' +
          'JSON字符串内英文双引号必须转义，或使用中文引号；不输出Markdown代码围栏。\n' +
          (options.expansionPrompt ? '' : `完整大纲：${JSON.stringify(outline)}\n`) + `本批：${JSON.stringify({ scene_id: scene.scene_id, shot_indexes: indexes })}`,
        { signal: control.signal, validate: value => { merge(value, scene, offset) }, structuralRepair: options.structuralRepair }),
        { unit_index: completedShots, unit_count: totalShots })
        assertActive(); control.retain(key, batch)
      }
      assertActive(); shots.push(...merge(batch, scene, offset)); completedShots += count
      control.progress?.({ phase: 'shots', completed_shots: completedShots, total_shots: totalShots })
    }
    scenes.push({ ...scene, shots })
  }
  assertActive()
  return options.finalize({ scenes })
}
