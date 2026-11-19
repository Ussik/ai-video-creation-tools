import type { StructuralRepairPlan, StructuralRepairLocalContext } from '../generation/model-output-repair.js'
import { z } from 'zod'

type JsonSchema = { type?: unknown; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[];
  enum?: unknown[]; const?: unknown; additionalProperties?: unknown; anyOf?: JsonSchema[] }
/** Type hints come from the actual outline schema, so they cannot drift into a second contract. */
export function storyboardOutlineContractGuide(schema: z.ZodType): string {
  const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  const scene = root.properties?.scenes?.items
  const fields: Record<string, unknown> = {}
  const visit = (value: JsonSchema | undefined, path: string, depth: number) => {
    if (!value) return
    fields[path] = { type: value.type, ...(value.enum ? { enum: value.enum } : {}),
      ...(value.const !== undefined ? { const: value.const } : {}),
      ...(value.items ? { items_type: value.items.type } : {}),
      ...(value.properties ? { allowed_keys: Object.keys(value.properties), required: value.required || [], additionalProperties: value.additionalProperties } : {}) }
    if (depth > 0 && value.properties) for (const [key, child] of Object.entries(value.properties)) visit(child, `${path}.${key}`, depth - 1)
  }
  visit(scene?.properties?.scene_direction, 'scenes[].scene_direction', 2)
  visit(scene?.properties?.shots?.items?.properties?.title, 'scenes[].shots[].title', 0)
  visit(scene?.properties?.shots?.items?.properties?.audio_plan, 'scenes[].shots[].audio_plan', 1)
  return '\n【从本次最终Schema生成的字段类型指南】\n' +
    '严格使用allowed_keys，不能用同义字段替代；array字段必须返回数组，无内容用[]；string字段只返回字符串，不能返回对象。' +
    'scene_direction.sound是结构化声音对象，不能用一段声音描述字符串代替；title是标题字符串。\n' + JSON.stringify(fields)
}


/** Only a numeric string -> scene duration conversion is independent of source prose.
 * Other structural targets retain their existing full task/business context. */
export function storyboardOutlineStructuralContext(plan: StructuralRepairPlan): StructuralRepairLocalContext | undefined {
  const candidate = plan.candidate as { scenes?: Array<{ scene_id?: unknown; scene_duration?: unknown; shots?: Array<{ duration?: unknown }> }> }
  if (!plan.targets.length || !Array.isArray(candidate.scenes)) return
  const values = [], fixedValues: Record<string, number> = {}
  for (const target of plan.targets) {
    const [root, index, field] = target.path
    if (target.path.length !== 3 || root !== 'scenes' || typeof index !== 'number' || field !== 'scene_duration') return
    const scene = candidate.scenes[index], current = scene?.scene_duration
    if (typeof current !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(current.trim()) || !Number.isFinite(Number(current))) return
    fixedValues[target.key] = Number(current)
    values.push({ key: target.key, scene_id: scene?.scene_id, current, numeric_value: Number(current),
      shot_durations: scene?.shots?.map(shot => shot.duration) })
  }
  return { fixedValues, text: JSON.stringify({ policy: '仅把已给出的数值字符串转换成同值数字，不重新估时、不改变镜头或其他字段；完整合并结果仍必须通过原业务校验',
    selected_scene_ids: candidate.scenes.map(scene => scene.scene_id), targets: values }) }
}
