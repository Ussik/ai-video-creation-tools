import { AsyncLocalStorage } from 'node:async_hooks'
import { createScriptRequestUsage, scriptRequestUsageTokens,
  type ScriptRequestUsage, type ScriptRequestUsageLimits } from '@video-studio/shared/script/script-request-usage'

export { createScriptRequestUsage, scriptRequestUsageTokens }
export type { ScriptRequestUsage, ScriptRequestUsageLimits }

export type TextRequestUsageScope = {
  /** Shared, serializable state. Reservations are written before dispatch, so
   * restoring a checkpoint cannot forget an unknown in-flight outcome. */
  usage: ScriptRequestUsage
  limits?: ScriptRequestUsageLimits
  onUpdate?: (usage: ScriptRequestUsage) => void
}
const usageScope = new AsyncLocalStorage<TextRequestUsageScope>()
const maxPendingRequests = 128
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class TextRequestBudgetError extends Error {
  readonly code = 'text_request_budget_exceeded'
  readonly retryable = false
  readonly statusCode = 422
  constructor(public readonly reason: 'requests' | 'tokens', public readonly usage: ScriptRequestUsage,
    public readonly limits: ScriptRequestUsageLimits) {
    const count = scriptRequestUsageTokens(usage)
    super(reason === 'requests'
      ? `本次任务已达到模型请求预算（已发起 ${usage.requests} 次，上限 ${limits.max_requests} 次），已保留完成部分。请检查用量后调整预算再继续。`
      : `下一次模型请求将超过本次任务的 token 预算（当前实际及保守估算合计 ${count}，上限 ${limits.max_tokens}），已保留完成部分。请检查用量后调整预算再继续。`)
    this.name = 'TextRequestBudgetError'
  }
}

export function isTextRequestBudgetError(issue: unknown): issue is TextRequestBudgetError {
  return issue instanceof TextRequestBudgetError || !!issue && typeof issue === 'object' &&
    (issue as { code?: unknown }).code === 'text_request_budget_exceeded'
}

export function withTextRequestUsage<T>(scope: TextRequestUsageScope, work: () => T): T {
  // Reject malformed restored counters instead of allowing NaN to bypass the
  // budget. Fill only genuinely absent fields for older saved task versions.
  for (const key of Object.keys(createScriptRequestUsage())) {
    if (key === 'pending_requests') continue
    const field = key as Exclude<keyof ScriptRequestUsage, 'pending_requests'>
    if (scope.usage[field] === undefined) scope.usage[field] = 0
    if (!integer(scope.usage[field])) throw new Error('任务模型用量检查点无效，不能自动重新计费')
  }
  scope.usage.pending_requests ??= []
  if (!Array.isArray(scope.usage.pending_requests) || scope.usage.pending_requests.length > maxPendingRequests ||
    scope.usage.pending_requests.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 160 || !integer(item.request_bytes) ||
      !integer(item.estimated_input_tokens) || !integer(item.estimated_output_tokens) || !integer(item.reasoning_tokens) ||
      typeof item.input_settled !== 'boolean' || typeof item.output_settled !== 'boolean')) {
    throw new Error('任务模型待核对用量检查点无效，不能自动重新计费')
  }
  if (new Set(scope.usage.pending_requests.map(item => item.id)).size !== scope.usage.pending_requests.length ||
    scope.usage.uncertain_requests > scope.usage.requests ||
    scope.usage.uncertain_requests < scope.usage.pending_requests.length ||
    scope.usage.pending_requests.reduce((sum, item) => sum + (item.input_settled ? 0 : item.estimated_input_tokens), 0) > scope.usage.estimated_input_tokens ||
    scope.usage.pending_requests.reduce((sum, item) => sum + (item.output_settled ? 0 : item.estimated_output_tokens), 0) > scope.usage.estimated_output_tokens) {
    throw new Error('任务模型用量聚合与待核对记录不一致，不能自动重新计费')
  }
  for (const value of Object.values(scope.limits || {})) {
    if (value !== undefined && (!integer(value) || value < 1)) throw new Error('任务模型预算必须为正整数')
  }
  return usageScope.run(scope, work)
}

export type TextRequestUsageDetails = {
  kind?: 'generation' | 'transport'
  request_bytes: number
  estimated_input_tokens: number
  reserved_output_tokens?: number
}
export type TextRequestUsageMetrics = {
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  response_chars?: number
}

/** Call once immediately before an actual generation HTTP request, never at a
 * model-step/format/retry wrapper. Missing scope keeps other tasks unchanged. */
export function beginTextRequest(details: TextRequestUsageDetails): {
  identify: (id: string) => boolean
  complete: (metrics: TextRequestUsageMetrics) => void
} {
  const scope = usageScope.getStore()
  if (!scope) return { identify: () => false, complete() {} }
  if (!integer(details.request_bytes) || !integer(details.estimated_input_tokens)) throw new Error('模型请求用量估算无效')
  const kind = details.kind ?? 'generation'
  const reserve = kind === 'transport' ? 0 : details.reserved_output_tokens ?? scope.limits?.unknown_output_tokens ?? 4096
  if (!integer(reserve) || (kind === 'generation' && reserve < 1)) throw new Error('模型请求输出预留必须为正整数')
  const { usage, limits } = scope
  if (kind === 'generation' && limits?.max_requests !== undefined && usage.requests + 1 > limits.max_requests) {
    throw new TextRequestBudgetError('requests', { ...usage }, { ...limits })
  }
  if (kind === 'generation' && limits?.max_tokens !== undefined && scriptRequestUsageTokens(usage) + details.estimated_input_tokens + reserve > limits.max_tokens) {
    throw new TextRequestBudgetError('tokens', { ...usage }, { ...limits })
  }
  if (kind === 'transport') {
    usage.transport_requests++
    usage.transport_request_bytes += details.request_bytes
  } else {
    usage.requests++
    usage.request_bytes += details.request_bytes
    usage.estimated_input_tokens += details.estimated_input_tokens
    usage.estimated_output_tokens += reserve
    usage.uncertain_requests++
  }
  scope.onUpdate?.(usage)
  let completed = false
  let requestId: string | undefined
  return {
    identify(id) {
      if (kind !== 'generation' || !id || id.length > 160) return false
      if (requestId === id) return true
      if (usage.pending_requests.some(item => item.id === id)) return false
      if (!usage.pending_requests.some(item => item.id === id)) {
        if (usage.pending_requests.length >= maxPendingRequests) return false
        usage.pending_requests.push({ id, request_bytes: details.request_bytes, estimated_input_tokens: details.estimated_input_tokens,
          estimated_output_tokens: reserve, input_settled: false, output_settled: false, reasoning_tokens: 0 })
        scope.onUpdate?.(usage)
      }
      requestId = id
      return true
    },
    complete(metrics) {
      if (completed) return
      completed = true
      if (kind === 'transport') { scope.onUpdate?.(usage); return }
      if (requestId && settlePending(scope, requestId, metrics)) return
      const actualInput = integer(metrics.input_tokens) ? metrics.input_tokens : undefined
      const actualOutput = integer(metrics.output_tokens) ? metrics.output_tokens : undefined
      if (actualInput !== undefined) {
        usage.estimated_input_tokens -= details.estimated_input_tokens
        usage.input_tokens += actualInput
      }
      if (actualOutput !== undefined) {
        usage.estimated_output_tokens -= reserve
        usage.output_tokens += actualOutput
      } else if (integer(metrics.response_chars) || integer(metrics.reasoning_tokens)) {
        // Never lower the original reserve on a response without usage: an
        // interrupted or reasoning-heavy request may have generated more than
        // the locally visible text. Raise it if observed text already exceeds it.
        const observed = Math.max(Math.ceil((metrics.response_chars || 0) * 2), metrics.reasoning_tokens || 0)
        usage.estimated_output_tokens += Math.max(0, observed - reserve)
      }
      if (integer(metrics.reasoning_tokens)) usage.reasoning_tokens += metrics.reasoning_tokens
      if (actualInput !== undefined && actualOutput !== undefined) usage.uncertain_requests--
      scope.onUpdate?.(usage)
    },
  }
}

export function settlePendingTextRequest(id: string, metrics: TextRequestUsageMetrics): boolean {
  const scope = usageScope.getStore()
  return scope ? settlePending(scope, id, metrics) : false
}

function settlePending(scope: TextRequestUsageScope, id: string, metrics: TextRequestUsageMetrics): boolean {
  const pending = scope.usage.pending_requests.find(item => item.id === id)
  if (!pending) return false
  if (integer(metrics.input_tokens) && !pending.input_settled) {
    scope.usage.estimated_input_tokens -= pending.estimated_input_tokens
    scope.usage.input_tokens += metrics.input_tokens
    pending.input_settled = true
  }
  if (integer(metrics.output_tokens) && !pending.output_settled) {
    scope.usage.estimated_output_tokens -= pending.estimated_output_tokens
    scope.usage.output_tokens += metrics.output_tokens
    pending.output_settled = true
  }
  if (integer(metrics.reasoning_tokens)) {
    scope.usage.reasoning_tokens += Math.max(0, metrics.reasoning_tokens - pending.reasoning_tokens)
    pending.reasoning_tokens = Math.max(pending.reasoning_tokens, metrics.reasoning_tokens)
  }
  if (pending.input_settled && pending.output_settled) {
    scope.usage.pending_requests.splice(scope.usage.pending_requests.indexOf(pending), 1)
    scope.usage.uncertain_requests--
  }
  scope.onUpdate?.(scope.usage)
  return true
}
