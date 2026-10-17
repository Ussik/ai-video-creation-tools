import { createHash } from 'node:crypto'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'

/** The full-work audit, creator answers and concrete repair decisions share one bound. */
export const scriptDraftFindingLimit = 200

const normalized = (value: string) => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
export function findingIdentity(finding: ScriptDraftFinding) {
  if (finding.issue_id) return finding.issue_id
  return createHash('sha256').update(JSON.stringify([finding.source_key,
    finding.topic?.trim() ? normalized(finding.topic) : [finding.kind, normalized(finding.quote), normalized(finding.explanation)],
  ])).digest('hex').slice(0, 24)
}

/** Topic is a specific unresolved proposition, never a generic category.
 * Keep every distinct location and suggestion when grouping duplicate reports. */
export function consolidateFindings(findings: ScriptDraftFinding[]): ScriptDraftFinding[] {
  const groups = new Map<string, ScriptDraftFinding>()
  for (const raw of findings) {
    const id = findingIdentity(raw), previous = groups.get(id)
    const current = { ...raw, id }
    if (!previous) { groups.set(id, current); continue }
    const related = [...(previous.related_findings || []), { source_key: raw.source_key, quote: raw.quote, explanation: raw.explanation, suggestion: raw.suggestion },
      ...(raw.related_findings || []).map(item => ({ ...item, source_key: item.source_key || raw.source_key }))]
    previous.related_findings = [...new Map(related.filter(item => (item.source_key || previous.source_key) !== previous.source_key || item.quote !== previous.quote || normalized(item.explanation) !== normalized(previous.explanation))
      .map(item => [JSON.stringify(item), item])).values()]
  }
  return [...groups.values()]
}

export type FindingResolutionRecord = {
  id: string; topic?: string; source_key: string; kind: ScriptDraftFinding['kind'];
  problem: string;
  strategy: 'manual' | 'ai'; answer: string; summary: string; attempts: number;
  decision?: string;
  status: 'addressed' | 'verified' | 'still_open';
}

export function rememberFindingResolutions(previous: FindingResolutionRecord[], findings: ScriptDraftFinding[],
  strategy: 'manual' | 'ai', answers: string[], summary: string, decisions?: string[]): FindingResolutionRecord[] {
  const records = new Map(previous.map(item => [item.id, item]))
  findings.forEach((finding, index) => {
    const id = findingIdentity(finding), old = records.get(id)
    records.set(id, { id, topic: finding.topic, source_key: finding.source_key, kind: finding.kind, problem: finding.explanation,
      strategy, answer: strategy === 'manual' ? answers[index]! : old?.answer || '', summary: summary.slice(0, 3000),
      ...(decisions?.[index] ? { decision: decisions[index]!.slice(0, 3000) } : old?.decision ? { decision: old.decision } : {}),
      attempts: (old?.attempts || 0) + 1, status: 'addressed' })
  })
  return [...records.values()]
}

/** A repair is not proof of resolution. The independent review decides which
 * issues remain open; previous answers are reused without hiding findings. */
export function reconcileFindingResolutions(records: FindingResolutionRecord[], findings: ScriptDraftFinding[]) {
  const open = new Set(findings.map(findingIdentity))
  return records.map(record => ({ ...record, status: open.has(record.id) ? 'still_open' as const : 'verified' as const }))
}

export function findingsWithHistory(findings: ScriptDraftFinding[], records: FindingResolutionRecord[]) {
  return consolidateFindings(findings).map(finding => {
    const record = records.find(item => item.id === finding.id)
    return record ? { ...finding, previous_answer: record.answer || undefined, delegated: record.strategy === 'ai', repair_attempts: record.attempts } : finding
  })
}

/** Several issues can share one batch repair summary. Send it once while
 * retaining each issue's exact answer, status and reference to that summary. */
export function resolutionContext(records: FindingResolutionRecord[]) {
  const summaries = new Map<string, string>()
  const decisions = records.map(({ summary, ...record }) => {
    const summary_id = createHash('sha256').update(summary).digest('hex').slice(0, 16)
    summaries.set(summary_id, summary)
    return { ...record, summary_id }
  })
  return { decisions, summaries: [...summaries].map(([id, text]) => ({ id, text })) }
}
