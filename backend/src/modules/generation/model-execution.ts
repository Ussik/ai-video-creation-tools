import { AsyncLocalStorage } from 'node:async_hooks'
import { createStreamScope, generationStepBudgets, maxModelStepAttempts } from '@video-studio/shared/script/script-stream-policy'

type Step = { signal: AbortSignal; attempts: number; deadline: number; name: string }
const executionDeadline = new AsyncLocalStorage<AbortSignal>()
const currentStep = new AsyncLocalStorage<Step>()
export function modelStepBudget(name: string) {
  if (/completeness|review/.test(name)) return generationStepBudgets.review
  if (/source_map/.test(name)) return generationStepBudgets.reading
  if (/evidence_repair|selection|material|context/.test(name)) return generationStepBudgets.evidence
  if (/source_story|stage_plan/.test(name)) return generationStepBudgets.synthesis
  if (/intent|authorization|approval|classification|discussion/.test(name)) return generationStepBudgets.discussion
  return generationStepBudgets.generation
}
export const modelStepSignal = (fallback?: AbortSignal) => {
  const signals = [...new Set([currentStep.getStore()?.signal, executionDeadline.getStore(), fallback].filter((item): item is AbortSignal => !!item))]
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0]
}
export function claimModelAttempt() {
  const step = currentStep.getStore()
  step?.signal.throwIfAborted()
  if (step && step.attempts >= maxModelStepAttempts) throw Object.assign(new Error('当前步骤已达到模型请求上限（含网络重试与格式修正共 3 次），已保留完成部分，请检查后继续。'), { code: 'model_attempts_exhausted' })
  if (step) step.attempts++
}
export function modelAttemptNumber() { return currentStep.getStore()?.attempts }
export function remainingModelAttempts() { return maxModelStepAttempts - (currentStep.getStore()?.attempts || 0) }
export function remainingModelStepMs() { return (currentStep.getStore()?.deadline ?? Infinity) - Date.now() }

/** Nested formatting and transport retries share one clock and one attempt
 * counter. Independent story/review batches each own their own step. */
export async function runModelStep<T>(name: string, signal: AbortSignal | undefined, work: () => Promise<T>, totalMs = modelStepBudget(name),
  totalMessage = '当前步骤处理超时，已保留完成部分，可继续未完成步骤。'): Promise<T> {
  if (currentStep.getStore()) return work()
  const scope = createStreamScope(modelStepSignal(signal), { totalMs, totalMessage })
  try { return await currentStep.run({ signal: scope.signal, attempts: 0, deadline: Date.now() + totalMs, name }, () => scope.wait(work())) }
  finally { scope.close() }
}

/** A business step can contain several independent model substeps. It shares
 * their deadline, while each substep retains its own bounded attempt counter. */
export async function runGenerationDeadline<T>(signal: AbortSignal | undefined, totalMs: number, work: () => Promise<T>): Promise<T> {
  const scope = createStreamScope(modelStepSignal(signal), { totalMs, totalMessage: '当前步骤超时，已保留此前校验通过的结果，请继续未完成部分。' })
  try { return await executionDeadline.run(scope.signal, () => scope.wait(work())) }
  finally { scope.close() }
}
