import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { reportModelResult } from './model-result-observation.js'

export type AutomaticOutputRecovery = {
  version: 1; max_requests: number; max_task_requests: number; max_reserved_chars: number;
  requests: Array<{ key: string; task: string; error_type: 'format' | 'reference'; input_chars: number;
    reserved_chars: number; output_chars?: number; status: 'reserved' | 'completed' | 'failed' }>;
}
type RecoveryAction = (action: 'started' | 'response_saved' | 'stopped', reference: boolean) => void
const scopes = new AsyncLocalStorage<{ state: AutomaticOutputRecovery; persist: () => void; onAction?: RecoveryAction }>()
export const createAutomaticOutputRecovery = (): AutomaticOutputRecovery => ({ version: 1,
  max_requests: 12, max_task_requests: 2, max_reserved_chars: 1_000_000, requests: [] })
export function withAutomaticOutputRecovery<T>(state: AutomaticOutputRecovery, persist: () => void, work: () => T, onAction?: RecoveryAction): T {
  // A corrupt/edited journal cannot silently reset the paid allowance.
  if (state.version !== 1 || !Array.isArray(state.requests) ||
    ![state.max_requests, state.max_task_requests, state.max_reserved_chars].every(n => Number.isSafeInteger(n) && n > 0) ||
    state.requests.some(r => !/^[a-f0-9]{64}$/.test(r.key) || !r.task || !['format', 'reference'].includes(r.error_type) || !['reserved', 'completed', 'failed'].includes(r.status) || !Number.isSafeInteger(r.input_chars) || r.input_chars < 0 || !Number.isSafeInteger(r.reserved_chars) || r.reserved_chars < r.input_chars || r.output_chars !== undefined && (!Number.isSafeInteger(r.output_chars) || r.output_chars < 0))) {
    throw Object.assign(new Error('自动纠正预算记录无效；已有回答保留，未重新派发。'), { code: 'source_auto_recovery_budget_invalid', statusCode: 409 })
  }
  return scopes.run({ state, persist, onAction }, work)
}
export const automaticOutputRecoveryActive = () => scopes.getStore() !== undefined
export function automaticOutputRecoveryCompleted(task: string): boolean {
  return scopes.getStore()?.state.requests.some(r => r.task === task && r.status === 'completed') === true
}
export type AutomaticOutputRecoveryContext = { evidenceFingerprint?: unknown; upstreamVersions?: unknown }

/** Called only at a fresh dispatch, after exact completed-response replay and
 * before persisting its delivery intent. A reservation survives unknown delivery
 * and process restart; neither this module nor a refresh grants another send. */
export function reserveAutomaticOutputRecovery(task: string, text: string, contract: unknown, reference: boolean, context?: AutomaticOutputRecoveryContext) {
  const scope = scopes.getStore()
  if (!scope) return undefined
  const { state, persist } = scope
  // Include evidence range and upstream versions in fingerprint to detect context changes
  const request = [task, text, contract]
  const originalKey = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  const key = context ? createHash('sha256').update(JSON.stringify([...request, context.evidenceFingerprint, context.upstreamVersions])).digest('hex') : originalKey
  const reserved = text.length + 64_000
  if (state.requests.some(r => r.key === key || r.key === originalKey) || state.requests.length >= state.max_requests ||
    state.requests.filter(r => r.task === task).length >= state.max_task_requests ||
    state.requests.reduce((n, r) => n + r.reserved_chars, 0) + reserved > state.max_reserved_chars) {
    throw Object.assign(new Error('自动局部纠正已达预算或检测到相同纠正请求；成功结果和原回答已保留，未继续循环。'), {
      code: 'source_auto_recovery_exhausted', statusCode: 422, failure_stage: 'recovery', delivery: 'not_sent', retryable: false,
    })
  }
  const entry: AutomaticOutputRecovery['requests'][number] = { key, task,
    error_type: reference ? 'reference' : 'format', input_chars: text.length, reserved_chars: reserved, status: 'reserved' }
  state.requests.push(entry)
  scope.onAction?.('started', reference)
  try { persist() } catch (error) { state.requests.pop(); throw error }
  const observe = () => reportModelResult({ phase: 'structure', status: 'invalid_contract',
    recovery_action: entry.status === 'reserved' ? 'started' : entry.status === 'completed' ? 'response_saved' : 'stopped',
    recovery_attempts: state.requests.length, recovery_input_chars: text.length, recovery_output_chars: entry.output_chars || 0,
    recovery_error_type: entry.error_type, request_category: 'local_patch' })
  observe()
  return (raw?: string) => {
    entry.status = raw === undefined ? 'failed' : 'completed'
    if (raw !== undefined) { entry.output_chars = raw.length; entry.reserved_chars = Math.max(entry.reserved_chars, text.length + raw.length) }
    scope.onAction?.(raw === undefined ? 'stopped' : 'response_saved', reference)
    persist(); observe()
  }
}
/** Continue independent work only after a complete local validation failure.
 * Unknown delivery, admission, cancellation and budget errors stop scheduling. */
export function independentOutputFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const e = error as Error & { statusCode?: number; code?: string; delivery?: string; structuredOutputContract?: string }
  if (e.delivery === 'unknown' || /budget|exhausted|delivery|pending|admission|recovery|abort/i.test(e.code || e.name)) return false
  return e.delivery === undefined && (e.statusCode === 422 || !!e.structuredOutputContract)
}
