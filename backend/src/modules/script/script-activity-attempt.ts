/** Older request tracing copied the unclaimed counter (zero) into an optional
 * one-based attempt number. Preserve the activity; its attempt is unknown. */
export function normalizeScriptActivityAttempt<T>(entry: T): T {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('attempt' in entry) || entry.attempt !== 0) return entry
  const normalized: Record<string, unknown> = { ...entry }
  delete normalized.attempt
  return normalized as T
}

/** Events may carry their public activity in a live update or a final result.
 * Touch that named field only; nested model output is not an activity record. */
export function normalizeScriptEventActivities<T extends Record<string, unknown>>(event: T): T {
  if (Array.isArray(event.activity)) return { ...event, activity: event.activity.map(normalizeScriptActivityAttempt) }
  if (event.activity && typeof event.activity === 'object') return { ...event, activity: normalizeScriptActivityAttempt(event.activity) }
  return event
}
