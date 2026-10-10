import type { ProjectDetail } from './api'

function shareJson(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next

  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    let unchanged = previous.length === next.length
    const shared = next.map((value, index) => {
      const item = shareJson(previous[index], value)
      if (!Object.is(item, previous[index])) unchanged = false
      return item
    })
    return unchanged ? previous : shared
  }
  if (Array.isArray(previous)) return next

  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  let unchanged = Object.keys(before).length === keys.length
  const shared = Object.fromEntries(keys.map(key => {
    const value = shareJson(before[key], after[key])
    if (!Object.hasOwn(before, key) || !Object.is(value, before[key])) unchanged = false
    return [key, value]
  }))
  return unchanged ? previous : shared
}

/** Keep the identities of unchanged JSON branches across polling responses. */
export function shareProjectSnapshot(previous: ProjectDetail | null, next: ProjectDetail): ProjectDetail {
  if (!previous || previous.id !== next.id) return next
  return shareJson(previous, next) as ProjectDetail
}
