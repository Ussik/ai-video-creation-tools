import type { SourceUnit } from './script-source-map.js'

export type EvidenceReview = { unit_id: number; disposition: 'primary' | 'supporting_context' | 'not_supporting'; reason: string }
export type LinkedEvidence = { unit_id: number; occurrence_unit_id?: number; supporting_unit_ids?: number[] }

/** This is reference/ownership validation, never semantic approval. Only a
 * historical explicit review + unique exact name mention permits a lossless
 * occurrence migration. It never swaps the model's primary identity evidence. */
export function linkSourceEvidence(input: { kind: 'characters' | 'events'; name?: string; evidence: LinkedEvidence;
  review: EvidenceReview[]; references: number[]; used: Set<number>; allowed: Set<number>; units: Map<number, SourceUnit>; legacy?: boolean }): LinkedEvidence {
  const { kind, evidence, review, references, used, allowed, units } = input
  const reviewed = new Set<number>()
  for (const value of review) {
    if (!references.includes(value.unit_id) || reviewed.has(value.unit_id) || !units.get(value.unit_id)?.text.trim()) throw new Error('原证据处置缺失、重复或越权')
    if ((value.disposition === 'primary') !== used.has(value.unit_id)) throw new Error('primary必须与实际采用证据一致')
    reviewed.add(value.unit_id)
  }
  if (reviewed.size !== references.length) throw new Error('必须核对全部原证据')
  if (!units.get(evidence.unit_id)?.text.trim()) throw new Error('主证据必须引用真实非空原文')
  const result = structuredClone(evidence)
  const supports = new Set(result.supporting_unit_ids || [])
  if (supports.size !== (result.supporting_unit_ids || []).length || supports.has(evidence.unit_id)) throw new Error('辅助证据不能重复或重复主证据')
  // Explicit reviewed supporting context must not disappear from stored facts.
  for (const value of review) if (value.disposition === 'supporting_context' && value.unit_id !== evidence.unit_id) supports.add(value.unit_id)
  if ([...supports].some(id => !units.get(id)?.text.trim())) throw new Error('辅助证据必须引用真实非空原文')
  if (kind === 'events') {
    if (!allowed.has(evidence.unit_id) || evidence.occurrence_unit_id !== undefined) throw new Error(`事件证据编号不属于当前章节，不能以背景替代发生位置；当前编号=${evidence.unit_id}`)
  } else if (!allowed.has(evidence.unit_id) && result.occurrence_unit_id === undefined && input.legacy) {
    const occurrences = review.filter(value => value.disposition === 'supporting_context' && allowed.has(value.unit_id) &&
      !!input.name && units.get(value.unit_id)!.text.includes(input.name))
    if (occurrences.length === 1) result.occurrence_unit_id = occurrences[0]!.unit_id
  }
  if (kind === 'characters' && !allowed.has(result.occurrence_unit_id ?? result.unit_id)) throw new Error(
    `人物须有本章出场依据；当前主证据=${result.unit_id}；本章出场=${result.occurrence_unit_id ?? '未给出'}；不能把跨章身份当成本章出场`)
  if (result.occurrence_unit_id !== undefined && !units.get(result.occurrence_unit_id)?.text.trim()) throw new Error('本章出场证据必须真实非空')
  if (supports.size) result.supporting_unit_ids = [...supports]
  return result
}
