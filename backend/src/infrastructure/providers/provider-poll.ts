import { ProviderExecutionError, providerFailureWithMessage, retryableProviderQuery } from './provider-failure.js'
export type ProviderPollOutcome<T> = { state: 'pending' } | { state: 'succeeded'; value: T }
  | { state: 'failed' | 'cancelled'; message: string }
/** This runner only accepts a query callback for an existing task. A create
 * callback is deliberately absent, including on timeout or an unknown outcome. */
export async function pollExistingProviderTask<P, T>(options: {
  taskId: string; label: string; intervalMs: number; immediate: boolean; signal?: AbortSignal
  query: () => Promise<P>; decode: (payload: P) => ProviderPollOutcome<T>
  wait: (milliseconds: number) => Promise<void>; timeoutMessage: string
}): Promise<T> {
  const deadline = Date.now() + 30 * 60_000
  let errors = 0, first = true, retryAfterMs = 0
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    if (!first || !options.immediate) await options.wait(Math.max(options.intervalMs, retryAfterMs))
    first = false
    let payload: P
    try { payload = await options.query(); errors = 0; retryAfterMs = 0 }
    catch (issue) {
      options.signal?.throwIfAborted()
      if (!retryableProviderQuery(issue)) throw issue
      retryAfterMs = Math.min(60_000, issue.retryAfterMs ?? 0)
      if (++errors < 3) continue
      throw providerFailureWithMessage(issue, `查询${options.label}任务 ${options.taskId} 失败，可继续查询原任务：${issue.message}`)
    }
    const result = options.decode(payload)
    if (result.state === 'succeeded') return result.value
    if (result.state === 'failed' || result.state === 'cancelled') throw new ProviderExecutionError(result.message,
      { reason: result.state === 'cancelled' ? 'cancelled' : 'business', stage: 'query', delivery: 'completed' })
  }
  throw new ProviderExecutionError(options.timeoutMessage, { reason: 'unknown_result', stage: 'query', delivery: 'accepted' })
}
