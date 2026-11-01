const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function referencesHistoricalText(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  // A nonempty decision can still mean only “option two”. Keep its complete
  // reference material rather than assuming the answer is self-contained.
  // Prefer retaining extra history when concrete rules also name an option.
  return [
    /(?:方案|选项)\s*[一二三四五六七八九十百零〇两\dA-Za-z]+/,
    /(?:采用|选择|选用|按|依照|按照|同意|确认|沿用)\s*第\s*[一二三四五六七八九十百零〇两\d]+\s*(?:项|条|个)|^\s*第\s*[一二三四五六七八九十百零〇两\d]+\s*(?:项|条|个)\s*(?:[。.!！,，;；]|$)/,
    /上述|前述|同上|同前|如上|上文|上面|照旧|原样|(?:按|按照|沿用|依照)以上/,
    /(?:原|原有|原来|之前|此前|先前|上次|旧)(?:的)?(?:方案|建议|约定|决定|规则|设定|答案)|(?:这个|该|这一|那一)(?:方案|选项|建议)/,
    /你(?:的)?(?:建议|方案|意见|决定)|(?:按|按照)你(?:说的|所说)|\b(?:option|plan)\s*[a-z\d]+\b/i,
  ].some(pattern => pattern.test(value))
}

export const scriptDraftReviewHistoryGuidance = '既有处理记录中的历史问题（problem）和批次修补摘要（summaries）只说明过去发现的问题与处理过程，不是当前仍存在缺陷的证据，也不代表所有旧方案继续生效。' +
  '已核实记录（status 为 verified）中的具体 decision 是该事项已经采用的规则，核对当前正文是否落实，不重新要求创作者作同一决定；没有具体 decision 的旧记录不能据此推定答案。' +
  '同一事项存在明确相互矛盾的决定时，按有明确采用时间依据的较晚具体决定核对；不能仅凭数组顺序推定先后，不能从旧问题或整批摘要重新发明事实。创作者原话、完整原稿与当前候选正文仍按本次要求作为依据。\n'

/** Only retired problem descriptions and their unreferenced batch summaries
 * are omitted from the wire context. Concrete decisions, unresolved records
 * and every other source of creator facts remain in their original form. */
export function scriptDraftReviewHistory(context: unknown): unknown {
  if (!record(context)) return context
  const history = context.resolved_findings
  if (!record(history) || !Array.isArray(history.decisions) || !Array.isArray(history.summaries)) return context
  // An unfamiliar reference or summary shape may carry semantics that this
  // projection cannot account for. Keep that history block intact.
  if (!history.decisions.every(item => record(item) &&
    (!Object.hasOwn(item, 'summary_id') || typeof item.summary_id === 'string')) ||
    !history.summaries.every(item => record(item) && typeof item.id === 'string' && typeof item.text === 'string')) return context
  const originalDecisions = history.decisions as Record<string, unknown>[]
  const decisions = originalDecisions.map(item => {
    if (item.status !== 'verified' || typeof item.decision !== 'string' || !item.decision.trim() ||
      referencesHistoricalText(item.decision) || referencesHistoricalText(item.answer) ||
      (!Object.hasOwn(item, 'problem') && !Object.hasOwn(item, 'summary_id'))) return item
    const { problem: _problem, summary_id: _summaryId, ...decision } = item
    return decision
  })
  const references = new Set(decisions.flatMap(item => typeof item.summary_id === 'string' ? [item.summary_id] : []))
  const summaries = history.summaries.filter(item => references.has((item as Record<string, unknown>).id as string))
  if (decisions.every((item, index) => item === originalDecisions[index]) && summaries.length === history.summaries.length) return context
  return { ...context, resolved_findings: { ...history, decisions, summaries } }
}
