import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { sourceQualityAccessBlockReason, type SourceQualityCreationScope } from '@video-studio/shared/script/script-source-quality-access'
import { sourceQualitySummary } from './script-source-quality.js'

/** Use only a server-derived source snapshot. This guard never starts analysis
 * or grants a model request; it restricts use of an existing quality result. */
export function assertSourceQualityCreationAccess(source: ScriptSourceDocument | null | undefined,
  scope: SourceQualityCreationScope = {}): void {
  const analysis = source?.analysis
  if (!analysis || analysis.analysis_mode === 'extract') return
  const summary = analysis.quality_summary || sourceQualitySummary(analysis)
  // A source with no completed quality decision keeps its normal analysis
  // path. A completed issue report or a durable stop must be handled before
  // buying writer output that depends on that report.
  // Initial analysis may continue through its ordinary analysis/review path.
  // A saved stale review is different: pending never erases its failed decision.
  if (!analysis.quality && !summary.stop_reason && analysis.status !== 'ready') return
  const reason = sourceQualityAccessBlockReason({ ...analysis, quality_summary: summary }, scope)
  if (reason) throw Object.assign(new Error(reason), {
    statusCode: 422, code: 'source_quality_creation_blocked', failure_stage: 'content',
    sourceOutputRecoveryBlocked: true, delivery: 'not_sent', retryable: false,
  })
}
