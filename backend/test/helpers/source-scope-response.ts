/** Mock the explicit scope contract without consuming a native tool turn. */
export function sourceScopeResponse(prompt: string, selection: { mode?: 'full' | 'targeted'; section_ids?: number[]; literal_queries?: string[] } = {}): string | undefined {
  const marker = '【范围判断资料】\n', start = prompt.lastIndexOf(marker)
  if (start < 0) return undefined
  const input = JSON.parse(prompt.slice(start + marker.length)) as { source_version: string }
  return JSON.stringify({ mode: selection.mode || 'full', source_version: input.source_version,
    section_ids: selection.section_ids || [], literal_queries: selection.literal_queries || [],
    reason: selection.mode === 'targeted' ? '明确的局部事实查询，按原文称呼检索。' : '本测试的对话需要完整原文并保留现有工具范围。' })
}
