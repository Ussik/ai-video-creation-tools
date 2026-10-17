/** Other routing tests model this separate read-only review explicitly.
 * Completeness/recovery behavior has dedicated tests with actual findings. */
export function draftCompletenessFixtureResponse(init?: RequestInit): Response | undefined {
  const body = JSON.parse(String(init?.body || '{}'))
  const prompt = typeof body.input === 'string' ? body.input : body.messages?.[0]?.content || body.input?.[0]?.content || ''
  const marker = '待核对草稿原文（资料）：'
  const index = typeof prompt === 'string' ? prompt.lastIndexOf(marker) : -1
  if (index < 0) return
  const material = JSON.parse(prompt.slice(index + marker.length))
  const sources = Array.isArray(material) ? material : (material.facts || material.candidate_facts).map((fact: { source_key: string; quote: string; evidence_id?: string }) => ({ key: fact.source_key, content: fact.quote, evidence_id: fact.evidence_id, artifact_type: fact.source_key.startsWith('scene:') ? 'episode_script' : fact.source_key }))
  const content = JSON.stringify({ checked_artifacts: [...new Set(sources.map((source: { artifact_type: string }) => source.artifact_type))], findings: [], facts: material.current_source_passages ? [] : sources.map((source: { key: string; content: string; evidence_id?: string }) => ({ ...(source.evidence_id ? { evidence_id: source.evidence_id } : { source_key: source.key, quote: source.content.slice(0, 80) }), meaning: '本片段明确的剧情事实' })).slice(0, 40) })
  return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], output_text: content })
}
