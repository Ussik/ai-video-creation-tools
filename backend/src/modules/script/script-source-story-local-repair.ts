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
    const evidenceIssue = (failure.error as { sourceEvidenceIssue?: unknown } | undefined)?.sourceEvidenceIssue
    if (evidenceIssue && typeof evidenceIssue === 'object' && 'character_name' in evidenceIssue && Array.isArray(input.characters) && schema.shape.characters instanceof z.ZodArray) {
      const at = input.characters.findIndex(item => item?.name === (evidenceIssue as { character_name: string }).character_name)
      if (at >= 0) targets.set(`characters_${at}`, { key: `characters_${at}`, path: ['characters', at], schema: schema.shape.characters.element as z.ZodType })
    }
    const rangeIssue = (failure.error as { sourceEvidenceRangeIssue?: { field: string; indices: number[] } } | undefined)?.sourceEvidenceRangeIssue
    if (rangeIssue && Array.isArray(input[rangeIssue.field]) && schema.shape[rangeIssue.field] instanceof z.ZodArray) {
      rangeIssue.indices.forEach(at => {
        if (at >= 0 && at < (input[rangeIssue.field] as unknown[]).length) {
          targets.set(`${rangeIssue.field}_${at}`, { key: `${rangeIssue.field}_${at}`, path: [rangeIssue.field, at], schema: schema.shape[rangeIssue.field].element as z.ZodType })
        }
      })
    }
    const scopeIssue = (failure.error as { sourceScopeIssue?: { field: string; indices: number[] } } | undefined)?.sourceScopeIssue
    if (scopeIssue && Array.isArray(input[scopeIssue.field]) && schema.shape[scopeIssue.field] instanceof z.ZodArray) {
      scopeIssue.indices.forEach(at => {
        if (at >= 0 && at < (input[scopeIssue.field] as unknown[]).length) {
          targets.set(`${scopeIssue.field}_${at}`, { key: `${scopeIssue.field}_${at}`, path: [scopeIssue.field, at], schema: schema.shape[scopeIssue.field].element as z.ZodType })
        }
      })
    }
    if (!targets.size || targets.size > 200) return
    const promptData: { targets: unknown[]; evidence: unknown; constraints: string; validation_errors?: unknown[] } = {
      targets: [...targets.values()].map(t => ({ key: t.key, value: t.path.reduce<any>((v, key) => v[key], input) })),
      evidence,
      constraints: '只纠正固定字段/引用，保留原事实、否定和前提，不删除事实或补写剧情。资料不足则停止。'
    }
    const errors: unknown[] = []
    if (evidenceIssue) errors.push({ type: 'character_evidence', ...evidenceIssue })
    if (rangeIssue) errors.push({ type: 'evidence_out_of_range', ...rangeIssue })
    if (scopeIssue) errors.push({ type: 'scope_ambiguous', ...scopeIssue })
    if (errors.length) promptData.validation_errors = errors
    return fixedLocalRepair({ candidate, targets: [...targets.values()], prompt: JSON.stringify(promptData) })
  }
}
