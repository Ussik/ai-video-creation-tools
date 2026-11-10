import { AsyncLocalStorage } from 'node:async_hooks'
import { createStreamScope, generationStepBudgets, maxModelStepAttempts } from '@video-studio/shared/script/script-stream-policy'

import { currentModelRequestContext } from './model-task-policy.js'

type Step = { signal: AbortSignal; attempts: number; deadline: number; name: string }
const executionDeadline = new AsyncLocalStorage<AbortSignal>()
const currentStep = new AsyncLocalStorage<Step>()
const unrestrictedScriptExecution = new AsyncLocalStorage<boolean>()
/** Script work ends on completion, cancellation or an actual execution error.
 * Other generation workflows retain their existing operational budgets. */
export function withUnrestrictedScriptExecution<T>(work: () => Promise<T>): Promise<T> {
  return unrestrictedScriptExecution.run(true, work)
}
export function isUnrestrictedScriptExecution() { return unrestrictedScriptExecution.getStore() === true }
export function modelStepBudget(name: string) {
  if (/completeness|review/.test(name)) return generationStepBudgets.review
  if (/source_map/.test(name)) return generationStepBudgets.reading
  if (/evidence_repair|selection|material|context/.test(name)) return generationStepBudgets.evidence
  if (/source_story|stage_plan/.test(name)) return generationStepBudgets.synthesis
  if (/intent|authorization|approval|classification|discussion/.test(name)) return generationStepBudgets.discussion
  return generationStepBudgets.generation
}
export const modelStepSignal = (fallback?: AbortSignal) => {
  const signals = [...new Set([currentStep.getStore()?.signal, executionDeadline.getStore(), currentModelRequestContext()?.signal, fallback].filter((item): item is AbortSignal => !!item))]
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0]
}
export function claimModelAttempt() {
  const step = currentStep.getStore()
  step?.signal.throwIfAborted()
  if (!isUnrestrictedScriptExecution() && step && step.attempts >= maxModelStepAttempts) throw Object.assign(new Error('当前步骤已达到模型请求上限（含网络重试与格式修正共 3 次），已保留完成部分，请检查后继续。'), { code: 'model_attempts_exhausted' })
  if (step) step.attempts++
}
export function modelAttemptNumber() { return currentStep.getStore()?.attempts }
export function remainingModelAttempts() { return isUnrestrictedScriptExecution() ? Infinity : maxModelStepAttempts - (currentStep.getStore()?.attempts || 0) }
export function remainingModelStepMs() { return (currentStep.getStore()?.deadline ?? Infinity) - Date.now() }

/** Nested formatting and transport retries share one step and attempt count.
 * Script steps retain the counter for diagnostics without a clock or quota. */
export async function runModelStep<T>(name: string, signal: AbortSignal | undefined, work: () => Promise<T>, totalMs = modelStepBudget(name),
  totalMessage = '当前步骤处理超时，已保留完成部分，可继续未完成步骤。'): Promise<T> {
  if (currentStep.getStore()) return work()
  const unrestricted = isUnrestrictedScriptExecution()
  const scope = createStreamScope(modelStepSignal(signal), { totalMs: unrestricted ? null : totalMs, totalMessage })
  try { return await currentStep.run({ signal: scope.signal, attempts: 0, deadline: unrestricted ? Infinity : Date.now() + totalMs, name }, () => scope.wait(work())) }
  finally { scope.close() }
}

/** Non-script business steps can share a deadline across model substeps.
 * Script execution uses the same cancellation scope without a deadline. */
export async function runGenerationDeadline<T>(signal: AbortSignal | undefined, totalMs: number, work: () => Promise<T>): Promise<T> {
  const scope = createStreamScope(modelStepSignal(signal), { totalMs: isUnrestrictedScriptExecution() ? null : totalMs, totalMessage: '当前步骤超时，已保留此前校验通过的结果，请继续未完成部分。' })
  try { return await executionDeadline.run(scope.signal, () => scope.wait(work())) }
  finally { scope.close() }
}
