import { createHash } from 'node:crypto'
import { modelStepSignal } from './model-execution.js'
import type { GenerationSteps } from '../script/script-generation-steps.js'
import { currentModelRequestContext, reportModelUnitProgress, withModelRequestContext } from './model-task-policy.js'
export type { GenerationSteps } from '../script/script-generation-steps.js'

/** Only complete validated business units become checkpoints. A business
 * merge remains a separate final validation and explicit commit operation. */
export async function executeGenerationUnits<T>(options: {
  identity: unknown; units: readonly string[]; steps: GenerationSteps; signal?: AbortSignal
  label: (id: string) => string
  generate: (id: string, completed: ReadonlyMap<string, T>) => Promise<unknown>
  validate: (value: unknown, id: string) => T
  validateAll?: (values: ReadonlyMap<string, T>) => void
  /** Keep validated siblings when one unit is deterministically blocked. */
  onUnitFailure?: (id: string, error: unknown) => void
}): Promise<Map<string, T>> {
  if (!options.units.length || options.units.some(id => !id.trim()) || new Set(options.units).size !== options.units.length) {
    throw new Error('生成单元必须非空且标识唯一')
  }
  const identity = createHash('sha256').update(JSON.stringify(options.identity)).digest('hex')
  const values = new Map<string, T>()
  const progress = (label: string) => reportModelUnitProgress({ phase_id: identity, label, completed_units: values.size, total_units: options.units.length })
  for (const id of options.units) {
    modelStepSignal(options.signal)?.throwIfAborted()
    progress(options.label(id))
    const stepId = `unit:${identity}:${id}`
    try {
      const value = await options.steps.run<T>(stepId, options.label(id), { identity: options.identity, id }, async () => {
        const context = currentModelRequestContext()
        const work = () => options.generate(id, values)
        return options.validate(await (context ? withModelRequestContext({ ...context, stepId }, work) : work()), id)
      }, value => options.validate(value, id))
      values.set(id, value)
      progress(options.label(id))
    } catch (error) {
      const failure = error as { retryable?: unknown; name?: string; code?: string; delivery?: string } | null
      const deterministic = failure?.retryable === false && failure.name !== 'AbortError' && failure.delivery !== 'unknown'
        && !/(?:delivery_(?:unknown|pending)|(?:initial|correction)_delivery_pending)$/.test(failure.code || '')
      // Partial preparation is only safe for a deterministic unit outcome.
      // Delivery uncertainty, cancellation and upstream failures must retain
      // the whole workflow's stop/recovery semantics.
      if (!options.onUnitFailure || !deterministic) throw error
      options.onUnitFailure(id, error)
    }
  }
  modelStepSignal(options.signal)?.throwIfAborted()
  options.validateAll?.(values)
  return values
}
