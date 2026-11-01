import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { isStructuredOutputError } from '../generation/model-output.js'

type Recovery = { kind: 'quality' | 'format'; attempt: number; message: string }

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
    work: state.work?.map(({ offset, length, result }) => ({ offset, length, result })),
    story_work: state.story ? undefined : state.story_work && { input_hash: state.story_work.input_hash,
      tasks: state.story_work.tasks.map(({ key, result, recovery, context }) => ({ key, result, recovery,
        context: context && { strategy: context.strategy, input_hash: context.input_hash, fallback_from_hash: context.fallback_from_hash } })) },
    synthesis: state.story ? undefined : state.synthesis,
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
    .split('\n').map(line => line.trim()).sort()
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
