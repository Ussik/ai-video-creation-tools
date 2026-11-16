type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

/** Rename only a known scalar alias. Conflicting or unknown data remains for
 * the original contract/business validation; no fact is silently discarded. */
function alias(value: unknown, from: string, to: string): unknown {
  if (!record(value) || !Object.hasOwn(value, from) || typeof value[from] !== 'string' ||
    Object.hasOwn(value, to) && value[to] !== value[from]) return value
  const result = { ...value, [to]: value[from] }
  delete result[from]
  return result
}

/** Apply only the directory contract's existing trim semantics. Keep invalid
 * types and unknown fields intact for the strict contract and repair planner. */
function trimFields(value: unknown, fields: readonly string[]): unknown {
  if (!record(value)) return value
  const result = { ...value }
  for (const field of fields) if (typeof result[field] === 'string') result[field] = result[field].trim()
  return result
}

/** A character-only occurrence alias equal to an event's primary evidence
 * carries no extra location. Remove only this exact numeric duplicate, never
 * a differing location that could hide an out-of-chapter event. Original wire
 * bytes remain in the request ledger; all support references stay intact. */
function normalizeEventEvidence(value: unknown): unknown {
  if (!record(value) || !record(value.evidence)) return value
  const evidence = value.evidence
  if (!Number.isSafeInteger(evidence.unit_id) || (evidence.unit_id as number) < 0 || evidence.occurrence_unit_id !== evidence.unit_id) return value
  const { occurrence_unit_id: _duplicate, ...retained } = evidence
  return { ...value, evidence: retained }
}

/** Normalize directory wire values before selecting repair targets, so Zod's
 * existing trim/default behavior cannot appear to change unrelated fields
 * after a valid patch. This code-owned path allowlist never relaxes schemas. */
export function normalizeSourceOutput(name: string, value: unknown): unknown {
  if (!record(value)) return value
  if (name === 'script_source_map_boundary_repair') {
    // A missing operation list means no operation of that kind. This is not a
    // missing source fact: preserve explicit null, conflicting actions and all
    // unknown fields for the unchanged schema and boundary checks to reject.
    if (!Object.hasOwn(value, 'prefix_sections') && Array.isArray(value.starts)) return { ...value, prefix_sections: [] }
    if (!Object.hasOwn(value, 'starts') && Array.isArray(value.prefix_sections)) return { ...value, starts: [] }
    return value
  }
  const key = name === 'script_source_map' ? 'sections' : name === 'script_source_map_page' ? 'items' : undefined
  if (!key || !Array.isArray(value[key])) return value
  return { ...value, [key]: value[key].map(section => {
    if (!record(section)) return section
    return { ...trimFields(section, ['title', 'summary']) as RecordValue,
      // These are the only optional defaulted directory fields. Wire null is
      // already treated as omitted by restoreOptionalNulls, then defaulted by
      // Zod; perform that same deterministic step before repair comparison.
      ...(section.continues_previous == null ? { continues_previous: false } : {}),
      ...(section.open_threads == null ? { open_threads: [] }
        : Array.isArray(section.open_threads) ? { open_threads: section.open_threads.map(thread => typeof thread === 'string' ? thread.trim() : thread) } : {}),
      ...(Array.isArray(section.characters) ? { characters: section.characters.map(character =>
        trimFields(alias(character, 'details', 'description'), ['name', 'description'])) } : {}),
      ...(Array.isArray(section.events) ? { events: section.events.map(event =>
        normalizeEventEvidence(trimFields(alias(event, 'description', 'summary'), ['summary']))) } : {}),
    }
  }) }
}
