/** Context expansion for evidence repair when initial context is insufficient */

import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceWork } from './script-source-map.js'

export interface EvidenceExpansionContext {
  original_range: { start_section: number; end_section: number }
  expanded_range: { start_section: number; end_section: number }
  expansion_reason: string
  attempt: number
}

/** Expand evidence context to include adjacent sections when repair fails due to insufficient context */
export function expandEvidenceContext(
  state: ScriptSourceAnalysis,
  currentSectionIds: number[],
  attempt: number = 1,
  maxAttempts: number = 3
): { expanded_section_ids: number[]; expansion_context: EvidenceExpansionContext } | null {
  if (attempt >= maxAttempts) return null
  if (currentSectionIds.length === 0) return null

  const minSection = Math.min(...currentSectionIds)
  const maxSection = Math.max(...currentSectionIds)

  // Expand range: include previous and next sections
  const expandedMin = Math.max(0, minSection - attempt)
  const expandedMax = Math.min(state.sections.length - 1, maxSection + attempt)

  const expanded_section_ids: number[] = []
  for (let i = expandedMin; i <= expandedMax; i++) {
    expanded_section_ids.push(i)
  }

  // Only expand if we actually added new sections
  if (expanded_section_ids.length === currentSectionIds.length) return null

  return {
    expanded_section_ids,
    expansion_context: {
      original_range: { start_section: minSection, end_section: maxSection },
      expanded_range: { start_section: expandedMin, end_section: expandedMax },
      expansion_reason: `修复失败（尝试 ${attempt}/${maxAttempts}），扩展证据范围到相邻章节`,
      attempt
    }
  }
}

/** Check if an error indicates insufficient context (resource shortage, not enough evidence) */
export function isInsufficientContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()

  // Patterns indicating insufficient context
  const patterns = [
    '资料不足',
    '证据不足',
    '信息不足',
    '无法确定',
    '需要更多',
    '标题无法',
    'insufficient',
    'not enough',
    'need more',
    'cannot determine from title alone'
  ]

  return patterns.some(pattern => message.includes(pattern))
}

/** Extract section IDs from evidence input */
export function extractEvidenceSectionIds(
  evidenceInput: { selected_section_ids?: number[] } | null | undefined
): number[] {
  if (!evidenceInput?.selected_section_ids) return []
  return [...new Set(evidenceInput.selected_section_ids)].sort((a, b) => a - b)
}
