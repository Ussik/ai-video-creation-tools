import { createHash } from 'node:crypto'
import type { GenerationSteps } from '../script/script-generation-steps.js'
import { modelWorkflowBudgetKey, runModelWorkflowBudget, type ModelWorkflowKind } from './model-workflow-budget.js'

/** Store the operational ledger inside the existing exact-identity generation
 * checkpoint. The caller must own its existing admission lane before reading
 * steps: serializing already cloned checkpoints cannot prevent stale writes.
 * It does not create a parallel persistence or retry system. */
export function runCreativeWorkflowBudget<T>(steps: GenerationSteps, options: {
  kind: ModelWorkflowKind; units: number; inputChars: number; signal: AbortSignal; explicitResume?: boolean
}, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const identity = { version: 1, kind: options.kind }
  const expected = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const saved = steps.checkpoint.steps[modelWorkflowBudgetKey]
  if (saved && saved.input_hash !== expected) throw Object.assign(new Error('模型任务预算身份不一致，已保留原检查点，请重新检查任务'), { statusCode: 409 })
  const ledger = saved ? structuredClone(saved.value) as Record<string, unknown> : {}
  return runModelWorkflowBudget({ ...options, scale: { units: options.units, inputChars: options.inputChars }, steps: ledger,
    persist() {
      if (options.signal.aborted) return
      steps.retain(modelWorkflowBudgetKey, '保留模型任务累计额度', identity, structuredClone(ledger), value => value)
    },
  }, work)
}
