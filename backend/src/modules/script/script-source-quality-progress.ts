import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceQualityInputHash } from './script-source-quality.js'
const findingsHash = (state: ScriptSourceAnalysis) => createHash('sha256').update(JSON.stringify(state.quality?.findings)).digest('hex')

/** A counter alone cannot authorize skipping a finding after reload. Bind it to
 * both the original review and the exact last committed analysis. */
export function sourceQualityRepairProgress(state: ScriptSourceAnalysis): number | null {
  const review = state.quality, repair = state.quality_repair
  if (review?.status !== 'issues' || !review.findings.length || !repair || repair.review_hash !== review.input_hash ||
    repair.findings_hash !== findingsHash(state) || repair.current_hash !== sourceQualityInputHash(state) ||
    !Number.isSafeInteger(repair.completed_findings) || repair.completed_findings < 0 || repair.completed_findings > review.findings.length) return null
  // Historical withdrawn never means retain_analysis. Keep the evidence but
  // do not let an old ambiguous counter advance a new protocol decision.
  if (repair.withdrawals?.length) return null
  if (repair.decisions) {
    const indexes = new Set<number>(), digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value)
    let previous: (typeof repair.decisions)[number] | undefined
    for (const decision of repair.decisions) {
      if (!Number.isSafeInteger(decision.finding_index) || decision.finding_index < 0 || decision.finding_index >= review.findings.length ||
        indexes.has(decision.finding_index) || decision.finding_hash !== digest(review.findings[decision.finding_index]) ||
        !validHash(decision.before_hash) || !validHash(decision.after_hash) || !decision.reason.trim() ||
        !['modify_analysis', 'retain_analysis', 'uncertain', 'requires_full_rebuild'].includes(decision.decision) ||
        decision.analysis_refs.some(ref => !ref.path || !validHash(ref.value_hash)) || decision.source_refs.some(ref => !Number.isSafeInteger(ref.unit_id) || ref.unit_id < 0 || !validHash(ref.text_hash)) ||
        new Set(decision.analysis_refs.map(ref => ref.path)).size !== decision.analysis_refs.length || new Set(decision.source_refs.map(ref => ref.unit_id)).size !== decision.source_refs.length ||
        previous && (decision.finding_index !== previous.finding_index + 1 || previous.after_hash !== decision.before_hash)) return null
      const completed = ['modify_analysis', 'retain_analysis'].includes(decision.decision)
      if (completed ? decision.finding_index >= repair.completed_findings : decision.finding_index !== repair.completed_findings) return null
      if (decision.decision === 'modify_analysis' ? decision.before_hash === decision.after_hash : decision.before_hash !== decision.after_hash) return null
      if (completed && (!decision.analysis_refs.length || !decision.source_refs.length)) return null
      indexes.add(decision.finding_index); previous = decision
    }
    if (previous && (previous.finding_index !== repair.completed_findings - 1 && previous.finding_index !== repair.completed_findings || previous.after_hash !== repair.current_hash)) return null
  }
  return repair.completed_findings
}

