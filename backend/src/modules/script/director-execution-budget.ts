import { createHash } from 'node:crypto'
import { generationUnitStore } from '../generation/generation-unit-store.js'
import { runCreativeWorkflowBudget } from '../generation/creative-workflow-budget.js'
import { createGenerationSteps } from './script-generation-steps.js'
const activeExecutions = new Map<string, Promise<unknown>>()

/** Legacy JSON/stream callers share the same exact-request ledger across
 * network retries. Server-owned tasks already supply their durable outer
 * budget and must not receive a second independent continuation allowance. */
export function runDirectorExecutionBudget<T>(options: {
  projectId: string; identity: unknown; units: number; inputChars: number; signal: AbortSignal;
  durableTask?: boolean; explicitResume?: boolean
}, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (options.durableTask) return work(options.signal)
  options.signal.throwIfAborted()
  const identity = { version: 1, request: options.identity }
  const hash = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const key = `${options.projectId}:${hash}`, active = activeExecutions.get(key)
  if (active) return active.then(value => { options.signal.throwIfAborted(); return value as T })
  const store = generationUnitStore(options.projectId, `director-execution:${hash}`, identity)
  const steps = createGenerationSteps({ checkpoint: store.checkpoint, save: store.save, signal: options.signal })
  const execution = runCreativeWorkflowBudget(steps, { kind: 'script', units: options.units, inputChars: options.inputChars,
    signal: options.signal, explicitResume: options.explicitResume }, work)
  activeExecutions.set(key, execution)
  return execution.finally(() => { if (activeExecutions.get(key) === execution) activeExecutions.delete(key) })
}
