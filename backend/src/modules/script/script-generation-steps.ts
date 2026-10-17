import { runGenerationDeadline, modelStepSignal } from '../generation/model-execution.js'
import { generationStepBudgets } from '@video-studio/shared/script/script-stream-policy'
import { createHash } from 'node:crypto'

export type GenerationCheckpoint = { prompt?: string; steps: Record<string, { input_hash: string; value: unknown; duration_ms: number }> }
export type GenerationStepEvent = { id: string; parent_id?: string; label: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; reused?: boolean; duration_ms?: number }
export type GenerationSteps = ReturnType<typeof createGenerationSteps>

/** Only validated results are saved. A new request/source/configuration owns a
 * separate checkpoint; each step additionally checks its precise input. */
export function createGenerationSteps(options: {
  checkpoint?: GenerationCheckpoint; save?: (state: GenerationCheckpoint) => void;
  onStep?: (event: GenerationStepEvent) => void; signal?: AbortSignal
} = {}) {
  const checkpoint = structuredClone(options.checkpoint || { steps: {} })
  return {
    checkpoint,
    /** Streaming checkpoints contain only complete, validated semantic units.
     * Keep this synchronous so a subsequent disconnect/cancellation cannot
     * race an unawaited save. These snapshots do not complete a business step. */
    retain<T>(id: string, _label: string, input: unknown, value: unknown, validate: (value: unknown) => T, _parentId?: string): T {
      const result = validate(structuredClone(value))
      const input_hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      checkpoint.steps[id] = { input_hash, value: structuredClone(result), duration_ms: 0 }
      options.save?.(checkpoint)
      return result
    },
    forget(id: string) {
      if (!(id in checkpoint.steps)) return
      delete checkpoint.steps[id]
      options.save?.(checkpoint)
    },
    async run<T>(id: string, label: string, input: unknown, work: () => Promise<T>, validate: (value: unknown) => T, parentId?: string): Promise<T> {
      modelStepSignal(options.signal)?.throwIfAborted()
      const input_hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const previous = checkpoint.steps[id]
      if (previous?.input_hash === input_hash) {
        let value: T
        try { value = validate(structuredClone(previous.value)) }
        catch { delete checkpoint.steps[id]; return this.run(id, label, input, work, validate, parentId) }
        options.onStep?.({ id, parent_id: parentId, label, status: 'succeeded', reused: true, duration_ms: previous.duration_ms })
        return value
      }
      const started = Date.now()
      options.onStep?.({ id, parent_id: parentId, label, status: 'running' })
      try {
        const budget = id.startsWith('review:') ? generationStepBudgets.review : id === 'plan' ? generationStepBudgets.synthesis : generationStepBudgets.generation
        const result = validate(await runGenerationDeadline(options.signal, budget, work))
        modelStepSignal(options.signal)?.throwIfAborted()
        const duration_ms = Math.max(0, Date.now() - started)
        checkpoint.steps[id] = { input_hash, value: structuredClone(result), duration_ms }
        options.save?.(checkpoint)
        options.onStep?.({ id, parent_id: parentId, label, status: 'succeeded', duration_ms })
        return result
      } catch (error) {
        options.onStep?.({ id, parent_id: parentId, label, status: options.signal?.aborted && options.signal.reason?.name === 'AbortError' ? 'cancelled' : 'failed', duration_ms: Math.max(0, Date.now() - started) })
        throw error
      }
    },
  }
}
