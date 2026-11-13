import { providerFailureReasons } from '../../infrastructure/providers/provider-failure.js'
import type { AiOperationError, AiOutcomeCertainty, AiRecoveryAction, AiFailureReason, AiFailureStage } from '@video-studio/shared/api/ai-operations'
const categories = new Set(['authentication', 'configuration', 'capacity', 'rate_limit', 'transport', 'refusal', 'output_limit', 'contract', 'source_conflict', 'quality', 'cancelled', 'unknown_result', 'media_validation', 'internal'])
const reasons = new Set<string>(providerFailureReasons)
const stages = new Set(['prepare', 'create', 'query', 'download', 'decode', 'validate', 'store'])
function failureFacts(issue: Record<string, unknown>) {
  return { ...(reasons.has(String(issue.reason)) ? { reason: issue.reason as AiFailureReason } : {}),
    ...(stages.has(String(issue.failure_stage)) ? { failure_stage: issue.failure_stage as AiFailureStage } : {}),
    ...(typeof issue.upstreamStatus === 'number' && Number.isInteger(issue.upstreamStatus) && issue.upstreamStatus >= 100 && issue.upstreamStatus <= 599 ? { upstream_status: issue.upstreamStatus } : {}),
    ...(typeof issue.upstreamCode === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(issue.upstreamCode) ? { upstream_code: issue.upstreamCode } : {}) }
}
const recoveries = new Set(['observe', 'edit_candidate', 'review_candidate', 'query_upstream', 'download_result', 'verify_upstream', 'none'])
export function aiOperationError(value: unknown, status: number, operationId?: string): AiOperationError {
  const issue = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const failure = typeof issue.failureReason === 'string' ? issue.failureReason : ''
  const upstream = typeof issue.upstreamStatus === 'number' ? issue.upstreamStatus : status
  const delivery = issue.delivery
  const mappedCategory = failure === 'context_overflow' ? 'capacity' : failure === 'output_limit' ? 'output_limit' : failure === 'refusal' ? 'refusal' : failure === 'cancelled' ? 'cancelled' : upstream === 429 ? 'rate_limit' : upstream === 401 || upstream === 403 ? 'authentication' : undefined
  const code = typeof issue.code === 'string' && /^[\w.:-]{1,160}$/.test(issue.code) ? issue.code : mappedCategory ? `ai_${mappedCategory}` : status === 409 ? 'ai_source_conflict' : status === 499 ? 'ai_cancelled' : status === 422 ? 'ai_output_contract' : status === 429 ? 'ai_rate_limit' : 'ai_execution_failed'
  const category = typeof issue.category === 'string' && categories.has(issue.category) ? issue.category
    : mappedCategory || (status === 409 ? 'source_conflict' : status === 499 ? 'cancelled' : status === 429 ? 'rate_limit'
      : status === 401 || status === 403 ? 'authentication' : status === 422 ? 'contract' : status === 500 ? 'internal' : status >= 500 ? 'transport' : 'configuration')
  const certainty: AiOutcomeCertainty = ['not_dispatched', 'unknown', 'accepted', 'completed'].includes(String(issue.outcome_certainty)) ? issue.outcome_certainty as AiOutcomeCertainty : delivery === 'not_sent' ? 'not_dispatched' : delivery === 'completed' || delivery === 'rejected' ? 'completed' : delivery === 'accepted' || delivery === 'output_started' ? 'accepted' : 'unknown'
  const rawRecovery = issue.recovery && typeof issue.recovery === 'object' ? issue.recovery as Record<string, unknown> : {}
  const recovery: AiRecoveryAction = { kind: recoveries.has(String(rawRecovery.kind)) ? rawRecovery.kind as AiRecoveryAction['kind'] : operationId ? 'observe' : 'none',
    ...(operationId ? { operation_id: operationId } : {}),
    ...(typeof rawRecovery.task_id === 'string' && /^[\w.:-]{1,160}$/.test(rawRecovery.task_id) ? { task_id: rawRecovery.task_id } : {}) }
  const message = typeof issue.detail === 'string' ? issue.detail : typeof issue.message === 'string' ? issue.message : status === 500 ? '服务器处理失败' : '模型处理未完成'
  return { code, category, message: status === 500 ? '服务器处理失败' : message.slice(0, 4000), retryable: issue.retryable === true, outcome_certainty: certainty, recovery, ...failureFacts(issue) }
}
/** Only machine fields are added. Provider raw text never becomes an action or
 * an arbitrary external URL, and credentials/private reasoning are not copied. */
export function aiErrorFields(value: unknown, status: number) {
  const error = aiOperationError(value, status)
  const issue = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { code: error.code, category: error.category, retryable: error.retryable, outcome_certainty: error.outcome_certainty, recovery: error.recovery, ...failureFacts(issue), ...(typeof issue.retryAfterMs === 'number' && Number.isFinite(issue.retryAfterMs) && issue.retryAfterMs >= 0 ? { retry_after_ms: Math.ceil(issue.retryAfterMs) } : {}) }
}
