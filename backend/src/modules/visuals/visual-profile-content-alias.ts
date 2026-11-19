import { visualBindingUsages } from '@video-studio/shared/visuals/visual-binding-usage'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** An alias is lossless only when the canonical key is absent and the value
 * already belongs to the actual enum. No view/default/prose inference. */
export function normalizeVisualContentAliases(candidate: unknown) {
  const value = structuredClone(candidate), changes: Array<{ path: string; before: unknown; after: unknown }> = []
  if (record(value) && Array.isArray(value.shot_usage)) value.shot_usage.forEach((row, index) => {
    if (!record(row) || Object.hasOwn(row, 'usage') || !Object.hasOwn(row, 'usage_type') || !visualBindingUsages.includes(row.usage_type as any)) return
    const before = structuredClone(row)
    row.usage = row.usage_type; delete row.usage_type
    changes.push({ path: `$.shot_usage[${index}]`, before, after: structuredClone(row) })
  })
  return { value, changes }
}
