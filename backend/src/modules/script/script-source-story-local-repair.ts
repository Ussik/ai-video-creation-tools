import { z } from 'zod'
import { fixedLocalRepair, type StructuredOutputLocalPlanner } from '../generation/model-output-local-repair.js'
/** Only schema-addressed fields and explicitly invalid reference entries are
 * eligible. Coverage omissions/identity ambiguity cannot authorize wholesale
 * replacement of a valid array, silent deletion or a new semantic review. */
export function storyPartLocalRepair(schema: z.ZodType, sectionCount: number, evidence: unknown): StructuredOutputLocalPlanner {
  return (candidate, failure) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !(schema instanceof z.ZodObject)) return
    const input = candidate as Record<string, unknown>, targets = new Map<string, { key: string; path: Array<string | number>; schema: z.ZodType }>()
    for (const issue of failure.issues) {
      if (issue.path.length > 2) {
        let current: unknown = input, currentSchema: z.ZodType = schema; const path: Array<string | number> = []
        for (const key of issue.path) {
          if (typeof key !== 'string' && typeof key !== 'number' || !current || typeof current !== 'object' || !Object.hasOwn(current, key)) return
          if (currentSchema instanceof z.ZodObject && typeof key === 'string') currentSchema = currentSchema.shape[key]
          else if (currentSchema instanceof z.ZodArray && typeof key === 'number') currentSchema = currentSchema.element as z.ZodType
          else return
          path.push(key); current = (current as any)[key]
          if (typeof key === 'number' || path.length === issue.path.length) break
        }
        if (!currentSchema || Array.isArray(current) || currentSchema instanceof z.ZodObject && !path.some(key => typeof key === 'number')) return
        const key = path.join('_'); targets.set(key, { key, path, schema: currentSchema }); continue
      }
      const [field, index] = issue.path
      if (typeof field !== 'string' || !Object.hasOwn(input, field)) return
      const fieldSchema = schema.shape[field] as z.ZodType | undefined
      if (!fieldSchema) return
      if (typeof index === 'number' && fieldSchema instanceof z.ZodArray && Array.isArray(input[field]))
        targets.set(`${field}_${index}`, { key: `${field}_${index}`, path: [field, index], schema: fieldSchema.element as z.ZodType })
      else if (!Array.isArray(input[field])) targets.set(field, { key: field, path: [field], schema: fieldSchema })
      else return // no whole-list regeneration for a length/coverage error
    }
    for (const [field, items] of Object.entries(input)) {
      const fieldSchema = schema.shape[field]
      if (!(fieldSchema instanceof z.ZodArray) || !Array.isArray(items)) continue
      items.forEach((item, index) => {
        if (!item || typeof item !== 'object' || !Array.isArray(item.section_ids)) return
        if (item.section_ids.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 0 || Number(id) >= sectionCount) || new Set(item.section_ids).size !== item.section_ids.length)
          targets.set(`${field}_${index}`, { key: `${field}_${index}`, path: [field, index], schema: fieldSchema.element as z.ZodType })
      })
    }
    const evidenceIssue = (failure.error as { sourceEvidenceIssue?: { character_name: string } } | undefined)?.sourceEvidenceIssue
    if (evidenceIssue && Array.isArray(input.characters) && schema.shape.characters instanceof z.ZodArray) {
      const at = input.characters.findIndex(item => item?.name === evidenceIssue.character_name)
      if (at >= 0) targets.set(`characters_${at}`, { key: `characters_${at}`, path: ['characters', at], schema: schema.shape.characters.element as z.ZodType })
    }
    const fieldPath = (failure.error as { field_path?: string } | undefined)?.field_path
    const indexed = fieldPath?.match(/^([a-z_]+)\[(\d+)\]/)
    if (indexed && Array.isArray(input[indexed[1]!]) && schema.shape[indexed[1]!] instanceof z.ZodArray) {
      const field = indexed[1]!, at = Number(indexed[2]); if (at < (input[field] as unknown[]).length) targets.set(`${field}_${at}`, { key: `${field}_${at}`, path: [field, at], schema: schema.shape[field].element as z.ZodType })
    }
    if (!targets.size || targets.size > 200) return
    return fixedLocalRepair({ candidate, targets: [...targets.values()], prompt: JSON.stringify({
      targets: [...targets.values()].map(t => ({ key: t.key, value: t.path.reduce<any>((v, key) => v[key], input) })), evidence,
      constraints: '只纠正固定字段/引用，保留原事实、否定和前提，不删除事实或补写剧情。资料不足则停止。' }) })
  }
}
