import { transientTextStatus, textRetryAfter, type TextDeliveryState } from './text-errors.js'

export const providerFailureReasons = ['configuration', 'authentication', 'capacity', 'rate_limit', 'network', 'protocol', 'json_syntax', 'field_contract', 'business', 'quality', 'cancelled', 'unknown_result', 'media_validation'] as const
export type ProviderFailureReason = typeof providerFailureReasons[number]
export type ProviderFailureStage = 'prepare' | 'create' | 'query' | 'download' | 'decode' | 'validate' | 'store'
export type ProviderFailureFacts = {
  reason: ProviderFailureReason
  stage: ProviderFailureStage
  delivery: TextDeliveryState
  upstreamStatus?: number
  upstreamCode?: string
  retryAfterMs?: number
  provider_request_id?: string
  retryable?: boolean
}

/** Stable facts survive adapter wrapping. Raw payloads and signed URLs never
 * belong in this object; paid-create retry policy belongs to the job owner. */
export class ProviderExecutionError extends Error {
  readonly code: string
  readonly category: string
  readonly statusCode: number
  readonly reason: ProviderFailureReason
  readonly failure_stage: ProviderFailureStage
  readonly delivery: TextDeliveryState
  readonly upstreamStatus?: number
  readonly upstreamCode?: string
  readonly retryAfterMs?: number
  readonly provider_request_id?: string
  readonly retryable: boolean
  constructor(message: string, facts: ProviderFailureFacts, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderExecutionError'
    this.reason = facts.reason; this.failure_stage = facts.stage; this.delivery = facts.delivery
    this.upstreamStatus = facts.upstreamStatus; this.upstreamCode = typeof facts.upstreamCode === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(facts.upstreamCode) ? facts.upstreamCode : undefined
    this.retryAfterMs = typeof facts.retryAfterMs === 'number' && Number.isFinite(facts.retryAfterMs) && facts.retryAfterMs >= 0 ? Math.ceil(facts.retryAfterMs) : undefined
    this.provider_request_id = safeProviderRequestId(facts.provider_request_id)
    this.code = `provider_${facts.reason}`
    this.category = facts.reason === 'network' || facts.reason === 'protocol' ? 'transport'
      : facts.reason === 'json_syntax' || facts.reason === 'field_contract' || facts.reason === 'business' ? 'contract' : facts.reason
    this.statusCode = facts.reason === 'configuration' ? 422 : facts.reason === 'cancelled' ? 499 : 502
    // Only read-only work may use this flag to retry. A create with an unknown
    // outcome must always preserve evidence and ask its owner to recover it.
    this.retryable = facts.retryable === true && facts.stage !== 'create'
  }
}

export function providerHttpFailure(response: Response, stage: ProviderFailureStage, message: string, upstreamCode?: string) {
  const status = response.status
  const reason: ProviderFailureReason = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit'
    : status === 413 ? 'capacity' : status >= 500 || status === 408 ? 'protocol' : 'configuration'
  return new ProviderExecutionError(message, { reason, stage, delivery: 'rejected', upstreamStatus: status, upstreamCode,
    retryAfterMs: textRetryAfter(response.headers.get('retry-after')), retryable: transientTextStatus(status, upstreamCode),
    provider_request_id: safeProviderRequestId(response.headers.get('x-request-id') || response.headers.get('request-id')) })
}
export function safeProviderRequestId(value: string | null | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : undefined
}
export function isProviderExecutionError(value: unknown): value is ProviderExecutionError { return value instanceof ProviderExecutionError }
export function retryableProviderQuery(value: unknown): value is ProviderExecutionError {
  return value instanceof ProviderExecutionError && value.failure_stage === 'query' && value.retryable
}
export function providerFieldFailure(message: string, stage: ProviderFailureStage = 'decode', delivery: TextDeliveryState = 'accepted') {
  return new ProviderExecutionError(message, { reason: 'field_contract', stage, delivery })
}

export function providerFailureWithMessage(issue: ProviderExecutionError, message: string): ProviderExecutionError {
  return new ProviderExecutionError(message, { reason: issue.reason, stage: issue.failure_stage, delivery: issue.delivery,
    upstreamStatus: issue.upstreamStatus, upstreamCode: issue.upstreamCode, retryAfterMs: issue.retryAfterMs,
    provider_request_id: issue.provider_request_id, retryable: issue.retryable }, { cause: issue })
}
