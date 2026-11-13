import { setTimeout as delay } from 'node:timers/promises'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import type { StructuredGenerator } from './model-output.js'
import { claimModelAttempt, modelStepSignal, remainingModelAttempts, remainingModelStepMs } from './model-execution.js'

const managedRetry = Symbol('readOnlyRetry')
type RetryOptions = {
  signal?: AbortSignal; onRetry?: (attempt: number, delayMs: number) => void;
  /** Only validated atomic read-only output may discard an incomplete draft. */
  discardIncompleteOutput?: boolean;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** One local retry of a failed read-only model request. No schema/quality
 * errors, cancellations or function-call side effects are replayed. */
export async function retryReadOnlyRequest<T>(request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const wait = options.wait || (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    const signal = modelStepSignal(options.signal)
    signal?.throwIfAborted()
    claimModelAttempt()
    try { return await request() }
    catch (issue) {
      signal?.throwIfAborted()
      if (issue instanceof TextProviderError && ((!options.discardIncompleteOutput && (issue.outputStarted || issue.partialText)) || ['context_overflow', 'output_limit', 'refusal', 'invalid_tool', 'invalid_response', 'cancelled'].includes(issue.failureReason))) throw issue
      if (attempt >= 2 || !remainingModelAttempts() || (!Number.isFinite(remainingModelStepMs()) && Date.now() - started > 10 * 60_000) || !(issue instanceof TextProviderError) || !issue.retryable) throw issue
      const jitter = 0.75 + (options.random || Math.random)() * 0.5
      const delayMs = Math.max(issue.retryAfterMs || 0, Math.round(2000 * jitter))
      if (delayMs >= remainingModelStepMs() || delayMs > 60_000) {
        // Keep the provider's requested wait intact; the next explicit continue
        // may retry after this instant rather than spinning a hidden timer.
        Object.assign(issue, { retryAt: Date.now() + delayMs, code: 'model_retry_wait' })
        throw issue
      }
      options.onRetry?.(attempt + 1, delayMs)
      await wait(delayMs, signal)
    }
  }
}

export function retryReadOnlyGeneration(generate: StructuredGenerator, options: RetryOptions = {}): StructuredGenerator {
  if ((generate as StructuredGenerator & { [managedRetry]?: boolean })[managedRetry]) return generate
  const wrapped: StructuredGenerator = (prompt, contract, context) => retryReadOnlyRequest(() => generate(prompt, contract, context), options)
  Object.assign(wrapped, { [managedRetry]: true })
  return wrapped
}
