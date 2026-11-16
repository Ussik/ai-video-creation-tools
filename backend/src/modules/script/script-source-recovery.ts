import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { isStructuredOutputError } from '../generation/model-output.js'

type Recovery = { kind: 'quality' | 'format'; attempt: number; message: string }
type FailureEnvelope = { code?: unknown; failure_stage?: unknown; message?: unknown; cause?: unknown }
const programRecoveryCodes = new Set(['source_request_recovery_conflict', 'source_request_unknown', 'source_request_sibling_pending',
  'structured_checkpoint_identity_mismatch', 'structured_initial_delivery_pending', 'model_workflow_budget_invalid', 'model_workflow_budget_exceeded'])

/** Dispatch, authorization and checkpoint guards are program failures, even
 * when an outer wrapper still carries the previous model validation result.
 * A correction-exhausted wrapper is different: its current_failure describes
 * the actual saved answer and keeps the more useful format/evidence layer. */
function programRecoveryFailure(issue: unknown): FailureEnvelope | undefined {
  const visited = new Set<unknown>()
  for (let current = issue; current && typeof current === 'object' && !visited.has(current);) {
    visited.add(current)
    const value = current as FailureEnvelope
    if (typeof value.code === 'string' && programRecoveryCodes.has(value.code) ||
      value.failure_stage === 'recovery' && value.code !== 'structured_correction_exhausted') return value
    current = value.cause
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]))
  return value
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex')
const orderedFindings = (state: ScriptSourceAnalysis) => state.quality?.findings
  // A review paraphrase over the same original evidence does not repair the
  // saved interpretation. Actual edits remain part of sections/story below.
  .map(finding => ({ kind: finding.kind, unit_ids: [...finding.unit_ids].sort((left, right) => left - right) }))
  .sort((left, right) => JSON.stringify(canonical(left)).localeCompare(JSON.stringify(canonical(right))))

/** Hash actual retained work, including a saved partial map or synthesis task.
 * Execution IDs, clocks, display text and retry/rebuild counters are deliberately
 * absent: recording another attempt is not progress on the manuscript. */
export function sourceAnalysisProgressFingerprint(state: ScriptSourceAnalysis): string {
  return fingerprint({ source_version: state.source_version, model_id: state.model_id,
    configuration_hash: state.configuration_hash, pipeline_version: state.pipeline_version,
    sections: state.sections, story: state.story,
    work: state.work?.map(({ offset, length, result, output_checkpoint, boundary_repair }) => ({ offset, length, result, output_checkpoint, boundary_repair })),
    story_work: state.story ? undefined : state.story_work && { input_hash: state.story_work.input_hash,
      tasks: state.story_work.tasks.map(({ key, result, recovery, context, output_checkpoint }) => ({ key, result, recovery, output_checkpoint,
        context: context && { strategy: context.strategy, input_hash: context.input_hash, fallback_from_hash: context.fallback_from_hash } })) },
    story_candidate: state.story ? undefined : state.story_candidate,
    synthesis: state.story ? undefined : state.synthesis,
    quality_work: state.quality_work,
    quality: state.quality && { input_hash: state.quality.input_hash, status: state.quality.status, findings: orderedFindings(state) },
  })
}

/** Reconstruction clears temporary work, so compare the actual completed
 * interpretation and evidence, not the transient directory being rebuilt. */
export function sourceAnalysisRebuildFingerprint(state: ScriptSourceAnalysis): string {
  return fingerprint([state.source_version, state.sections, state.story, orderedFindings(state)])
}

function diagnosis(issue: unknown): string {
  if (!(issue instanceof Error)) return String(issue)
  if ('diagnostics' in issue && typeof issue.diagnostics === 'string') return issue.diagnostics
  return issue.message
}

export function sourceAnalysisDiagnosisFingerprint(state: ScriptSourceAnalysis, issue: unknown): unknown {
  if (issue instanceof Error && 'sourceQualityIssues' in issue && issue.sourceQualityIssues === true && state.quality?.status === 'issues') {
    return orderedFindings(state)
  }
  // Successive invented evidence IDs fail the same field constraint. Preserve
  // the field path while ignoring the model's new invalid value and line order.
  return diagnosis(issue).replace(/unit_id=-?\d+/g, 'unit_id=<invalid>')
    .split('\n').map(line => {
      const text = line.trim()
      // Match complete program-owned templates, not a quoted diagnostic or
      // a line with appended prose. Normalize only the captured ID lists.
      const listed = text.match(/^((?:findings\[\d+\]|items\[\]\.finding)\.unit_ids必须引用真实且非空的原文句段，不能重复或编造证据ID；非法ID=)(\[(?:-?\d+(?:,-?\d+)*)?\])(，重复ID=)(\[(?:-?\d+(?:,-?\d+)*)?\])(。仅使用units\[\]\.id，不是字符偏移、目录ID或集数；不得猜测相邻ID。)$/)
      const ids = (value: string) => value === '[]' ? value : '[<invalid>]'
      if (listed) return listed[1]! + ids(listed[2]!) + listed[3]! + ids(listed[4]!) + listed[5]!
      const blank = text.match(/^((?:findings\[\d+\]|items\[\]\.finding)\.unit_ids必须引用真实且非空的原文句段；所引ID=)(\[-?\d+(?:,-?\d+)*\])(均无非空证据。仅使用units\[\]\.id，不是字符偏移；不得猜测或补造ID。)$/)
      return blank ? blank[1]! + ids(blank[2]!) + blank[3]! : text
    }).sort()
}

export function sourceAnalysisStalledError(issue: unknown): Error {
  return Object.assign(new Error('分析在相同已保存结果上重复遇到同一问题，自动修复未取得新进展，已停止重复请求。' +
    '原稿和已保存的分析结果均已保留；可手动继续分析当前步骤，或更换模型后重试。具体问题：' + diagnosis(issue), { cause: issue }),
  { statusCode: 422, code: 'script_source_analysis_stalled', sourceAnalysisStalled: true })
}

/** Useful progress has no round or time ceiling. Stop only when an automatic
 * recovery revisits the same saved work with the same diagnosis, including
 * A→B→A cycles. An explicit resume starts a new recovery execution. */
export async function withSourceAnalysisRecovery<T>(work: () => Promise<T>, options: {
  signal: AbortSignal; progressFingerprint?: () => unknown; diagnosisFingerprint?: (issue: unknown) => unknown
  onRecovery: (recovery: Recovery) => void
}): Promise<T> {
  let quality = 0, format = 0
  const failures = new Set<string>()
  for (;;) {
    options.signal.throwIfAborted()
    try { return await work() }
    catch (issue) {
      options.signal.throwIfAborted()
      if (programRecoveryFailure(issue)) throw issue
      if (issue && typeof issue === 'object' && 'sourceOutputRecoveryBlocked' in issue && issue.sourceOutputRecoveryBlocked) throw issue
      const qualityIssue = issue instanceof Error && 'sourceQualityIssues' in issue && issue.sourceQualityIssues === true
      const formatIssue = isStructuredOutputError(issue) && issue.structuredOutputContract.startsWith('script_source_')
      if (!qualityIssue && !formatIssue) throw issue
      const kind = qualityIssue ? 'quality' : 'format'
      const signature = fingerprint([options.progressFingerprint?.(), kind,
        formatIssue ? issue.structuredOutputContract : null, options.diagnosisFingerprint?.(issue) ?? diagnosis(issue)])
      if (failures.has(signature)) throw sourceAnalysisStalledError(issue)
      failures.add(signature)
      const attempt = qualityIssue ? ++quality : ++format
      options.onRecovery({ kind, attempt, message: qualityIssue
        ? '核对发现资料理解遗漏，正在修补具体问题并重新复核；已完成分析保留，可随时停止'
        : '当前分析步骤的输出格式未通过校验，正在恢复当前步骤；此前完成结果保持有效，可随时停止' })
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}

/** Prefer the newest structured failure even when a recovery wrapper retains
 * long initial diagnostics. Old candidate failures remain in raw checkpoints. */
export function sourceAnalysisFailureMessage(issue: unknown): string {
  const visited = new Set<unknown>()
  for (let current = issue; current && typeof current === 'object' && !visited.has(current);) {
    visited.add(current)
    const value = current as { current_failure?: { stage?: unknown; message?: unknown }; cause?: unknown }
    if (value.current_failure?.stage === 'local_correction' && typeof value.current_failure.message === 'string') {
      return '当前局部纠正未通过：' + value.current_failure.message
    }
    current = value.cause
  }
  return issue instanceof Error ? issue.message : String(issue)
}

export function sourceAnalysisFailureDetails(issue: unknown): NonNullable<ScriptSourceAnalysis['failure']> {
  const programFailure = programRecoveryFailure(issue)
  if (programFailure) return { stage: 'recovery', message: typeof programFailure.message === 'string' ? programFailure.message : sourceAnalysisFailureMessage(issue) }
  const visited = new Set<unknown>()
  for (let current = issue; current && typeof current === 'object' && !visited.has(current);) {
    visited.add(current)
    const value = current as { current_failure?: { status?: string; message?: string; layer?: 'format' | 'evidence' | 'content' };
      diagnostics?: string; code?: string; failure_stage?: string; structuredOutputContract?: string; cause?: unknown }
    if (value.current_failure?.message) return {
      stage: value.current_failure.layer || (['invalid_json', 'invalid_contract'].includes(value.current_failure.status || '') ? 'format' : 'evidence'),
      message: value.current_failure.message,
      ...(value.diagnostics?.includes('【初始候选问题（历史诊断）】') ? { historical_diagnostics: value.diagnostics.split('【初始候选问题（历史诊断）】')[1]!.trim() } : {}),
    }
    if (value.failure_stage === 'recovery' || value.code === 'structured_checkpoint_identity_mismatch' || value.code === 'structured_correction_exhausted') return { stage: 'recovery', message: sourceAnalysisFailureMessage(issue) }
    if (value.code === 'model_json_syntax' || value.code === 'model_field_contract') return { stage: 'format', message: sourceAnalysisFailureMessage(current) }
    if (value.code === 'model_business_validation' && value.structuredOutputContract === 'script_source_evidence_repair') return { stage: 'evidence', message: sourceAnalysisFailureMessage(current) }
    current = value.cause
  }
  return { stage: 'content', message: sourceAnalysisFailureMessage(issue) }
}
