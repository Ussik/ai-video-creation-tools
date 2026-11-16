/** One known equivalent envelope only. Do not guess aliases, repair JSON,
 * discard fields, truncate text or interpret whether the claims are true. */
export function normalizeSourceUncertainties(input: unknown, requested: readonly number[], sectionCount: number): unknown {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  if (!record(input) || !Array.isArray(input.uncertainties)) return input
  const keys = ['summary', 'source_section_ids', 'current_state_section_ids', 'explanation']
  const validIds = (value: unknown): value is number[] => Array.isArray(value) && new Set(value).size === value.length &&
    value.every(id => Number.isSafeInteger(id) && id >= 0 && id < sectionCount)
  return { ...input, uncertainties: input.uncertainties.map(item => {
    if (!record(item) || Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) ||
      typeof item.summary !== 'string' || !item.summary.trim() || typeof item.explanation !== 'string' || !item.explanation.trim() ||
      !validIds(item.source_section_ids) || !item.source_section_ids.some(id => requested.includes(id)) ||
      !validIds(item.current_state_section_ids)) return item
    // Retain both original strings and the evidence roles. The unchanged
    // canonical contract still rejects overlong text; no facts are dropped.
    return { description: `${item.summary}\n${item.explanation}\n来源章节ID：${item.source_section_ids.join('、')}；当前状态章节ID：${item.current_state_section_ids.join('、')}`,
      section_ids: [...new Set([...item.source_section_ids, ...item.current_state_section_ids])] }
  }) }
}
