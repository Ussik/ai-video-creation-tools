const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Keep the effective manuscript and final whole-story understanding intact.
 * Analysis navigation, repeated evidence and resumable execution state add no
 * additional creator facts and need not be sent to the independent reviewer.
 * Project only the known source shape; other context and conversation turns
 * remain intact, including references needed to interpret creator replies. */
export function scriptDraftReviewContext(context: unknown): unknown {
  if (!record(context) || !record(context.uploaded_script) || typeof context.uploaded_script.content !== 'string') return context
  const source = context.uploaded_script
  const manuscript: Record<string, unknown> = {}
  for (const key of ['project_id', 'filename', 'content', 'updated_at', 'revision', 'source_version', 'source_kind'] as const) {
    if (Object.hasOwn(source, key)) manuscript[key] = source[key]
  }
  if (record(source.analysis)) {
    const analysis: Record<string, unknown> = {}
    for (const key of ['source_version', 'story'] as const) {
      if (Object.hasOwn(source.analysis, key)) analysis[key] = source.analysis[key]
    }
    if (Object.keys(analysis).length) manuscript.analysis = analysis
  }
  return { ...context, uploaded_script: manuscript }
}
