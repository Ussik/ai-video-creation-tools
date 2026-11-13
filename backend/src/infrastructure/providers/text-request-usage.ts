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
  budgetLabel?: string
  /** Prevent detached work from dispatching after its owning budget closes. */
  signal?: AbortSignal
  onUpdate?: (usage: ScriptRequestUsage, phase: 'reservation' | 'settlement') => void
}
// A phase ledger and the execution ledger can both observe the same HTTP
// dispatch. Keeping the complete chain prevents a nested phase from hiding
// intent, tool, compression or review requests from the execution budget.
const usageScope = new AsyncLocalStorage<readonly TextRequestUsageScope[]>()
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class TextRequestBudgetError extends Error {
  readonly code = 'text_request_budget_exceeded'
  readonly retryable = false
  readonly statusCode = 422
  constructor(public readonly reason: 'requests' | 'tokens', public readonly usage: ScriptRequestUsage,
    public readonly limits: ScriptRequestUsageLimits, public readonly budgetLabel = '本次任务') {
    const count = scriptRequestUsageTokens(usage)
    const totalLimited = limits.max_total_requests !== undefined && usage.requests + usage.transport_requests >= limits.max_total_requests
    super(reason === 'requests'
      ? `${budgetLabel}已达到模型请求预算（已发起 ${totalLimited ? usage.requests + usage.transport_requests : usage.requests} 次，上限 ${totalLimited ? limits.max_total_requests : limits.max_requests} 次），已保留完成部分。请检查用量后调整预算再继续。`
      : `下一次模型请求将超过${budgetLabel}的 token 预算（当前实际及保守估算合计 ${count}，上限 ${limits.max_tokens}），已保留完成部分。请检查用量后调整预算再继续。`)
    this.name = 'TextRequestBudgetError'
  }
}

export function isTextRequestBudgetError(issue: unknown): issue is TextRequestBudgetError {
  return issue instanceof TextRequestBudgetError || !!issue && typeof issue === 'object' &&
    (issue as { code?: unknown }).code === 'text_request_budget_exceeded'
}

/** Durable work has its own lifetime and must not charge an HTTP subscriber.
 * Nested phases inside that work still inherit its new execution ledger. */
export function withDetachedTextRequestUsage<T>(work: () => T): T {
  return usageScope.run([], work)
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
  if (!Array.isArray(scope.usage.pending_requests) ||
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
  return usageScope.run([...(usageScope.getStore() || []), scope], work)
}

type UsageTarget = { usage: ScriptRequestUsage; scopes: TextRequestUsageScope[] }
function activeTargets(): UsageTarget[] {
  const targets = new Map<ScriptRequestUsage, UsageTarget>()
  for (const scope of usageScope.getStore() || []) {
    let target = targets.get(scope.usage)
    if (!target) { target = { usage: scope.usage, scopes: [] }; targets.set(scope.usage, target) }
    target.scopes.push(scope)
  }
  return [...targets.values()]
}
function notifyTarget(target: UsageTarget, phase: 'reservation' | 'settlement' = 'settlement') {
  // Re-entering the same ledger must neither charge nor persist it twice.
  const callbacks = new Set(target.scopes.map(scope => scope.onUpdate))
  for (const callback of callbacks) callback?.(structuredClone(target.usage), phase)
}

export type TextRequestUsageDetails = {
  /** Cancellation is transport that may finish after its execution aborts. */
  kind?: 'generation' | 'auxiliary_generation' | 'transport' | 'cancellation'
  request_bytes: number
  estimated_input_tokens: number
  reserved_output_tokens?: number
}
export type TextRequestUsageMetrics = {
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  response_chars?: number
}

/** Call once immediately before an actual generation HTTP request, never at a
 * model-step/format/retry wrapper. Missing scope keeps other tasks unchanged. */
export function beginTextRequest(details: TextRequestUsageDetails): {
  admitted: boolean
  identify: (id: string) => boolean
  complete: (metrics: TextRequestUsageMetrics) => void
} {
  const targets = activeTargets()
  if (!targets.length) return { admitted: false, identify: () => false, complete() {} }
  if (!integer(details.request_bytes) || !integer(details.estimated_input_tokens)) throw new Error('模型请求用量估算无效')
  const kind = details.kind === 'cancellation' ? 'transport' : details.kind ?? 'generation'
  // Only the explicit provider cancellation endpoint may outlive execution.
  // It still consumes the combined dispatch cap; ordinary polling never does.
  if (details.kind !== 'cancellation') for (const { scopes } of targets) for (const { signal } of scopes) signal?.throwIfAborted()
  const reservations = targets.map(target => {
    // Identical ledger objects share one conservative reservation while every
    // enclosing scope retains its independently configured limit.
    const reserve = kind !== 'generation' ? 0 : details.reserved_output_tokens ??
      Math.max(...target.scopes.map(scope => scope.limits?.unknown_output_tokens ?? 4096))
    if (!integer(reserve) || (kind === 'generation' && reserve < 1)) throw new Error('模型请求输出预留必须为正整数')
    return { target, reserve, requestId: undefined as string | undefined }
  })
  // Check every budget before mutating any ledger. A rejected phase request
  // must not consume an outer execution request, or vice versa.
  for (const { target: { usage, scopes }, reserve } of reservations) for (const { limits, budgetLabel } of scopes) {
    if (limits?.max_total_requests !== undefined && usage.requests + usage.transport_requests + 1 > limits.max_total_requests) {
      throw new TextRequestBudgetError('requests', structuredClone(usage), { ...limits }, budgetLabel)
    }
    if (kind !== 'transport' && limits?.max_requests !== undefined && usage.requests + 1 > limits.max_requests) {
      throw new TextRequestBudgetError('requests', structuredClone(usage), { ...limits }, budgetLabel)
    }
    if (kind === 'generation' && limits?.max_tokens !== undefined && scriptRequestUsageTokens(usage) + details.estimated_input_tokens + reserve > limits.max_tokens) {
      throw new TextRequestBudgetError('tokens', structuredClone(usage), { ...limits }, budgetLabel)
    }
  }
  for (const { target: { usage }, reserve } of reservations) {
    if (kind === 'transport') {
      usage.transport_requests++
      usage.transport_request_bytes += details.request_bytes
    } else {
      usage.requests++
      usage.request_bytes += details.request_bytes
      if (kind === 'generation') {
        usage.estimated_input_tokens += details.estimated_input_tokens
        usage.estimated_output_tokens += reserve
        usage.uncertain_requests++
      }
    }
  }
  for (const target of targets) notifyTarget(target, 'reservation')
  let completed = false
  return {
    admitted: true,
    identify(id) {
      if (kind !== 'generation' || !id || id.length > 160) return false
      let identified = true
      for (const reservation of reservations) {
        const { target, reserve, requestId } = reservation, { usage } = target
        if (requestId === id) continue
        if (requestId || usage.pending_requests.some(item => item.id === id)) {
          identified = false; continue
        }
        usage.pending_requests.push({ id, request_bytes: details.request_bytes, estimated_input_tokens: details.estimated_input_tokens,
          estimated_output_tokens: reserve, input_settled: false, output_settled: false, reasoning_tokens: 0 })
        reservation.requestId = id
        notifyTarget(target)
      }
      return identified
    },
    complete(metrics) {
      if (completed) return
      completed = true
      if (kind !== 'generation') { for (const target of targets) notifyTarget(target); return }
      for (const { target, reserve, requestId } of reservations) {
        const { usage } = target
        if (requestId && settlePending(target, requestId, metrics)) continue
        const actualInput = integer(metrics.input_tokens) ? metrics.input_tokens : undefined
        const actualOutput = integer(metrics.output_tokens) ? metrics.output_tokens : undefined
        if (actualInput !== undefined) {
          usage.estimated_input_tokens -= details.estimated_input_tokens
          usage.input_tokens += actualInput
          addCache(usage, metrics, actualInput)
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
        notifyTarget(target)
      }
    },
  }
}

/** Actual auxiliary dispatches share every enclosing task's request budget.
 * Media generation has request cost, but never invents text-token reservations
 * or a resumable text response. Dispatch ownership remains with its caller. */
export function beginProviderDispatch(details: { kind: 'generation' | 'transport' | 'cancellation'; request_bytes: number }) {
  const reservation = beginTextRequest({ ...details, kind: details.kind === 'generation' ? 'auxiliary_generation' : details.kind,
    estimated_input_tokens: 0 })
  return { admitted: reservation.admitted, complete: () => reservation.complete({}) }
}

export function settlePendingTextRequest(id: string, metrics: TextRequestUsageMetrics): boolean {
  let settled = false
  for (const target of activeTargets()) if (settlePending(target, id, metrics)) settled = true
  return settled
}

/** Called exactly once per request, when its input tokens are first settled,
 * so retries and resumed responses cannot count cache usage twice. */
function addCache(usage: ScriptRequestUsage, metrics: TextRequestUsageMetrics, input: number) {
  if (integer(metrics.cache_read_tokens)) {
    usage.cache_read_tokens += Math.min(metrics.cache_read_tokens, input)
    usage.cache_read_reported_requests++
  }
  if (integer(metrics.cache_write_tokens)) {
    usage.cache_write_tokens += metrics.cache_write_tokens
    usage.cache_write_reported_requests++
  }
}

function settlePending(target: UsageTarget, id: string, metrics: TextRequestUsageMetrics): boolean {
  const { usage } = target
  const pending = usage.pending_requests.find(item => item.id === id)
  if (!pending) return false
  if (integer(metrics.input_tokens) && !pending.input_settled) {
    usage.estimated_input_tokens -= pending.estimated_input_tokens
    usage.input_tokens += metrics.input_tokens
    addCache(usage, metrics, metrics.input_tokens)
    pending.input_settled = true
  }
  if (integer(metrics.output_tokens) && !pending.output_settled) {
    usage.estimated_output_tokens -= pending.estimated_output_tokens
    usage.output_tokens += metrics.output_tokens
    pending.output_settled = true
  } else if (!pending.output_settled && (integer(metrics.response_chars) || integer(metrics.reasoning_tokens))) {
    const observed = Math.max(Math.ceil((metrics.response_chars || 0) * 2), metrics.reasoning_tokens || 0)
    const increase = Math.max(0, observed - pending.estimated_output_tokens)
    usage.estimated_output_tokens += increase
    pending.estimated_output_tokens += increase
  }
  if (integer(metrics.reasoning_tokens)) {
    usage.reasoning_tokens += Math.max(0, metrics.reasoning_tokens - pending.reasoning_tokens)
    pending.reasoning_tokens = Math.max(pending.reasoning_tokens, metrics.reasoning_tokens)
  }
  if (pending.input_settled && pending.output_settled) {
    usage.pending_requests.splice(usage.pending_requests.indexOf(pending), 1)
    usage.uncertain_requests--
  }
  notifyTarget(target)
  return true
}
