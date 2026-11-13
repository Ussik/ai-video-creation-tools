import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'

export type ActivityOutputRecovery = 'continuing' | 'continued'
export type ActivityRecoveryOptions = { pending?: boolean; failed?: boolean }

/** Keep failed request history intact. A later request only establishes recovery
 * within its recorded owner, never through similar labels or nearby timestamps. */
export function activityOutputRecoveries(events: ScriptActivity[], { pending, failed }: ActivityRecoveryOptions = {}) {
  const recovered = new Map<string, ActivityOutputRecovery>()
  if (failed) return recovered
  const byId = new Map(events.map(event => [event.id, event]))
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.kind !== 'model' || event.status !== 'failed' || !['max_output_tokens', 'length'].includes(event.output_limit_reason || '')) continue
    const owner = event.parent_id ? byId.get(event.parent_id) : undefined
    if (!owner || owner.kind !== 'context' || owner.scope === 'notice') continue
    const seen = new Set([event.id])
    let ancestor: ScriptActivity | undefined = owner
    let valid = true
    while (ancestor) {
      if (seen.has(ancestor.id) || ancestor.status !== 'succeeded' && !(pending && ancestor.status === 'running')) { valid = false; break }
      seen.add(ancestor.id)
      if (!ancestor.parent_id) break
      ancestor = byId.get(ancestor.parent_id)
      if (!ancestor) valid = false
    }
    if (!valid) continue
    const next = events.slice(index + 1).filter(candidate => candidate.kind === 'model' && candidate.parent_id === owner.id &&
      candidate.name === event.name && candidate.step_id === event.step_id).at(-1)
    if (next?.status === 'succeeded') recovered.set(event.id, 'continued')
    else if (next?.status === 'running' && pending && owner.status === 'running') recovered.set(event.id, 'continuing')
  }
  return recovered
}
