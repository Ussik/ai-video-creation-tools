import { setTimeout as delay } from 'node:timers/promises'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import type { StructuredGenerator } from './model-output.js'
import { claimModelAttempt, modelStepSignal, remainingModelAttempts, remainingModelStepMs } from './model-execution.js'

const managedRetry = Symbol('readOnlyRetry')
type RetryOptions = {
  signal?: AbortSignal; onRetry?: (attempt: number, delayMs: number) => void;
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
      if (attempt >= 2 || !remainingModelAttempts() || (!Number.isFinite(remainingModelStepMs()) && Date.now() - started > 10 * 60_000) || !(issue instanceof TextProviderError) || !issue.retryable) throw issue
      const jitter = 0.75 + (options.random || Math.random)() * 0.5
      const delayMs = Math.max(issue.retryAfterMs || 0, Math.round(2000 * jitter))
      if (delayMs >= remainingModelStepMs()) throw issue
      options.onRetry?.(attempt + 1, delayMs)
      await wait(delayMs, signal)
    }
  }
}

export function retryReadOnlyGeneration(generate: StructuredGenerator, options: RetryOptions = {}): StructuredGenerator {
  if ((generate as StructuredGenerator & { [managedRetry]?: boolean })[managedRetry]) return generate
  const wrapped: StructuredGenerator = (prompt, contract) => retryReadOnlyRequest(() => generate(prompt, contract), options)
  Object.assign(wrapped, { [managedRetry]: true })
  return wrapped
}
