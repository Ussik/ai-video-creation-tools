import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { StructuredOutputLocalRepair } from '../generation/model-output-local-repair.js'
export const sourceTimelineItemSchema = z.object({ summary: z.string().min(1).max(600),
  section_ids: z.array(z.number().int().min(0)).min(1).max(1000), primary_section_id: z.number().int().min(0).optional() }).strict()
type Task = { key: string; section_ids?: number[]; scope_version?: 2 }
type Item = z.infer<typeof sourceTimelineItemSchema>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function validateTimelineScope(task: Task, items: Item[], sectionCount: number) {
  for (const [index, item] of items.entries()) {
    if (item.section_ids.some(id => id >= sectionCount) || new Set(item.section_ids).size !== item.section_ids.length) throw new Error(`timeline[${index}].section_ids必须真实且不重复`)
    if (item.primary_section_id !== undefined && !item.section_ids.includes(item.primary_section_id)) throw new Error(`timeline[${index}].primary_section_id必须有实际section_ids依据`)
    if (task.scope_version === 2 && (item.primary_section_id === undefined || !task.section_ids?.includes(item.primary_section_id))) {
      throw Object.assign(new Error(`timeline[${index}].primary_section_id必须属于任务${task.key}负责章节；section_ids可跨章辅助，不改变主要归属`),
        { code: 'source_timeline_owner_out_of_scope', field_path: `timeline[${index}].primary_section_id` })
    }
    if (!item.section_ids.some(id => task.section_ids?.includes(id))) throw new Error(`timeline[${index}].section_ids与任务负责章节无关`)
  }
}
/** Fixed invalid entries only. Every other entry is retained byte-for-byte;
 * deletion is intentionally unsupported because overlap is not proof of redundancy. */
export function planTimelineLocalRepair(input: unknown, task: Task, sectionCount: number,
  source?: unknown): StructuredOutputLocalRepair | undefined {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { timeline?: unknown }).timeline)) return
  const candidate = structuredClone(input) as { timeline: unknown[]; covered_section_ids?: unknown }
  if (JSON.stringify(candidate.covered_section_ids) !== JSON.stringify(task.section_ids)) return
  const invalid = candidate.timeline.flatMap((item, index) => {
    try { validateTimelineScope(task, [sourceTimelineItemSchema.parse(item)], sectionCount); return [] }
    catch (error) { return [{ id: `timeline:${index}:${hash(item).slice(0, 16)}`, index, item, error: error instanceof Error ? error.message : String(error) }] }
  })
  if (!invalid.length || invalid.length > 200) return
  const candidateHash = hash(candidate)
  const schema = z.object({ candidate_hash: z.literal(candidateHash), repairs: z.object(Object.fromEntries(invalid.map(target =>
    [target.id, sourceTimelineItemSchema]))).strict() }).strict()
  return { schema,
    prompt: '仅纠正固定条目，不能删除、重排或重写合法兄弟条目。保留原始事件的限定、否定和关键事实；primary_section_id是主要发生/披露章节，section_ids是完整辅助依据。' +
      '不得为通过范围校验把其他章节独立事件虚构归到本章；无法在范围内保真修正则停止，原完整候选会保留。不声称已完成语义审核。\n【局部时间线资料】\n' +
      JSON.stringify({ candidate_hash: candidateHash, task, targets: invalid, source }),
    apply(patch) {
      const parsed = schema.parse(patch), merged = structuredClone(candidate)
      for (const target of invalid) {
        const item = parsed.repairs[target.id]!
        validateTimelineScope(task, [item], sectionCount)
        merged.timeline[target.index] = item
      }
      return merged
    },
  }
}
