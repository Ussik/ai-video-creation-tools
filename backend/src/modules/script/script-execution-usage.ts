import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
import { createScriptRequestUsage, withTextRequestUsage, type ScriptRequestUsage,
  type ScriptRequestUsageLimits } from '../../infrastructure/providers/text-request-usage.js'

export const scriptExecutionUsageLabel = '本轮模型用量'
type ExecutionUsage = NonNullable<ScriptActivity['usage']>
type ExecutionUsageOptions = {
  activities?: readonly ScriptActivity[]
  /** Original source, candidate documents and necessary conversation text. */
  contextChars?: number
  /** Legacy callers may supply limits; only the unknown-output estimate is
   * retained. Creation is never stopped by a cumulative usage threshold. */
  limits?: ScriptRequestUsageLimits
  onUpdate?: (usage: ExecutionUsage) => void
}

/** A server-owned execution keeps its current ledger when resumed. Older
 * phase ledgers stay separate. Historical/environment cumulative caps are
 * ignored; actual per-request model capacity remains the provider's concern. */
export function createScriptExecutionUsage(options: ExecutionUsageOptions = {}) {
  const chars = options.contextChars ?? 0
  if (!Number.isSafeInteger(chars) || chars < 0) throw new Error('本轮处理资料长度无效')
  const saved = (options.activities || []).filter(entry => entry.usage)
    .reduce<ScriptActivity | undefined>((latest, entry) => {
      if (!latest) return entry
      if (entry.sequence !== undefined && latest.sequence !== undefined) return entry.sequence >= latest.sequence ? entry : latest
      return entry.started_at >= latest.started_at ? entry : latest
    }, undefined)?.usage
  const usage = saved ? structuredClone(saved.current) : createScriptRequestUsage()
  const limits: ScriptRequestUsageLimits = {
    unknown_output_tokens: options.limits?.unknown_output_tokens ?? saved?.limits?.unknown_output_tokens ?? 4096,
  }
  // Validate before exposing a persisted snapshot or allowing any provider call.
  withTextRequestUsage({ usage, limits }, () => {})
  function snapshot(cumulative?: ScriptRequestUsage): ExecutionUsage {
    return { current: structuredClone(usage), limits: { ...limits },
      ...(cumulative ? { cumulative: structuredClone(cumulative) } : {}) }
  }
  return {
    usage, limits, snapshot,
    run<T>(work: () => T): T {
      return withTextRequestUsage({ usage, limits, budgetLabel: '本轮创作', onUpdate: () => options.onUpdate?.(snapshot()) }, work)
    },
  }
}
