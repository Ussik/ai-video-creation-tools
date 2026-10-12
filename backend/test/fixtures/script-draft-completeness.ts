/** Other routing tests model this separate read-only review explicitly.
 * Completeness/recovery behavior has dedicated tests with actual findings. */
export function draftCompletenessFixtureResponse(init?: RequestInit): Response | undefined {
  const body = JSON.parse(String(init?.body || '{}'))
  const prompt = typeof body.input === 'string' ? body.input : body.messages?.[0]?.content || body.input?.[0]?.content || ''
  const marker = '待核对草稿原文（资料）：'
  const index = typeof prompt === 'string' ? prompt.lastIndexOf(marker) : -1
  if (index < 0) return
  const sources = JSON.parse(prompt.slice(index + marker.length)) as Array<{ artifact_type: string }>
  const content = JSON.stringify({ checked_artifacts: [...new Set(sources.map(source => source.artifact_type))], findings: [] })
  return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], output_text: content })
}
