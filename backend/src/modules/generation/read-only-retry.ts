import { setTimeout as delay } from 'node:timers/promises'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import type { StructuredGenerator } from './model-output.js'
import { claimModelAttempt, modelStepSignal, remainingModelAttempts, remainingModelStepMs } from './model-execution.js'

const managedRetry = Symbol('readOnlyRetry')

/** One local retry of a failed read-only model request. No schema/quality
 * errors, cancellations or function-call side effects are replayed. */
export function retryReadOnlyGeneration(generate: StructuredGenerator, options: {
  signal?: AbortSignal; onRetry?: (attempt: number, delayMs: number) => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
} = {}): StructuredGenerator {
  if ((generate as StructuredGenerator & { [managedRetry]?: boolean })[managedRetry]) return generate
  const wait = options.wait || (async (ms, signal) => { await delay(ms, undefined, { signal }) })
  const wrapped: StructuredGenerator = async (prompt, contract) => {
    const started = Date.now()
    for (let attempt = 1; ; attempt++) {
      const signal = modelStepSignal(options.signal)
      signal?.throwIfAborted()
      claimModelAttempt()
      try { return await generate(prompt, contract) }
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
  Object.assign(wrapped, { [managedRetry]: true })
  return wrapped
}
