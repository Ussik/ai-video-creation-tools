import { z } from 'zod'
/** Only an exact, complete, unique identity set may change container shape.
 * Identity aliases become keys; every other field/value is copied verbatim.
 * This supplies no relation, reason, visibility, phase or evidence. */
export function normalizeAppearanceShape(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const rows = (value as any).decisions
  if (!Array.isArray(rows) || rows.length !== keys.length) return value
  const entries: Array<[string, unknown]> = [], seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return value
    const aliases = ['draft_key', 'object_key'].filter(key => Object.hasOwn(row, key))
    if (aliases.length !== 1 || typeof row[aliases[0]!] !== 'string') return value
    const key = row[aliases[0]!]
    if (!keys.includes(key) || seen.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return value
    seen.add(key)
    entries.push([key, Object.fromEntries(Object.entries(row).filter(([field]) => field !== aliases[0]))])
  }
  return { ...structuredClone(value), decisions: Object.fromEntries(entries) }
}
/** Derive leaf repair shapes from the same schema. Missing parents are owned
 * by the application; ambiguous arrays/unknown fields never get discarded. */
export function appearanceRepairTargets(schema: z.ZodObject, candidate: any, issues: readonly z.ZodIssue[]) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Array.isArray(candidate.decisions)) return []
  const targets: Array<{ key: string; path: string[]; schema: z.ZodType }> = []
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') return []
    const path = issue.path.map(String)
    if (path[0] !== 'decisions') return []
    let current: z.ZodType = schema
    for (const part of path) {
      if (!(current instanceof z.ZodObject) || !Object.hasOwn(current.shape, part)) return []
      current = current.shape[part]
    }
    if (targets.some(target => target.path.every((part, i) => path[i] === part))) continue
    for (let i = targets.length - 1; i >= 0; i--) if (path.every((part, n) => targets[i]!.path[n] === part)) targets.splice(i, 1)
    targets.push({ key: path.slice(1).join('__') || 'decisions', path, schema: current })
  }
  return targets
}
