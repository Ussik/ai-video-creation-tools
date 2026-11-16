import { localRepairProgressSchema, syntaxRepairAuditSchema } from '../generation/model-output-checkpoints.js'
import { z } from 'zod'
import { withStructuredOutputCheckpoints, type StructuredOutputCheckpoint } from '../generation/model-output-checkpoints.js'
import { modelStepSignal } from '../generation/model-execution.js'
import { createStreamScope } from '@video-studio/shared/script/script-stream-policy'
import { createHash } from 'node:crypto'
import { isGenerationPrivateSlot, type SaveGenerationPrivateResponse, type GenerationPrivateWrite } from '../generation/generation-private-response.js'

const privateOutputSchema = z.object({ input_hash: z.string().optional(), raw: z.string().optional(), original_raw: z.string().optional(),
  correction: z.object({ input_hash: z.string(), raw: z.string() }).strict().optional(),
  initial_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(),
  correction_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(),
  syntax_repair: syntaxRepairAuditSchema.optional(),
  local_repair: localRepairProgressSchema.optional() }).strict()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export type GenerationCheckpoint = { prompt?: string; steps: Record<string, { input_hash: string; value: unknown; duration_ms?: number }> }
export type GenerationStepEvent = { id: string; parent_id?: string; label: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; reused?: boolean; duration_ms?: number }
export type GenerationSteps = Omit<ReturnType<typeof createGenerationSteps>, 'readStructuredResponse'> & {
  readStructuredResponse?: (id: string, input: unknown, name: string, prompt: string, schema: unknown) => StructuredOutputCheckpoint | undefined
}

/** Only validated results are saved. A new request/source/configuration owns a
 * separate checkpoint; each step additionally checks its precise input. */
export function createGenerationSteps(options: {
  checkpoint?: GenerationCheckpoint; save?: (state: GenerationCheckpoint) => void;
  savePrivateResponse?: SaveGenerationPrivateResponse;
  onStep?: (event: GenerationStepEvent) => void; signal?: AbortSignal;
  /** Complete business steps whose outer identity was proved equivalent by an
   * explicit model migration or exact historical serialization hash. */
  migratedStepIds?: readonly string[]
} = {}) {
  const checkpoint = structuredClone(options.checkpoint || { steps: {} })
  const migratedInputs = new Set(options.migratedStepIds || [])
  const privateExpected = new Map(Object.entries(checkpoint.steps).filter(([id]) => isGenerationPrivateSlot(id))
    .map(([id, entry]) => [id, structuredClone(entry)]))
  const adopt = (latest: GenerationCheckpoint) => {
    checkpoint.steps = structuredClone(latest.steps)
    if (latest.prompt === undefined) delete checkpoint.prompt
    else checkpoint.prompt = latest.prompt
  }
  return {
    checkpoint,
    /** Streaming checkpoints contain only complete, validated semantic units.
     * Keep this synchronous so a subsequent disconnect/cancellation cannot
     * race an unawaited save. These snapshots do not complete a business step. */
    retain<T>(id: string, _label: string, input: unknown, value: unknown, validate: (value: unknown) => T, _parentId?: string, privateWrite?: GenerationPrivateWrite): T {
      const result = validate(structuredClone(value))
      const input_hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const entry = { input_hash, value: structuredClone(result) }
      if (options.savePrivateResponse && isGenerationPrivateSlot(id)) {
        const latest = options.savePrivateResponse(id, entry, privateWrite ? privateWrite.expected : privateExpected.get(id))
        adopt(latest)
        const retained = structuredClone(checkpoint.steps[id]!)
        privateExpected.set(id, retained)
        if (privateWrite) privateWrite.expected = structuredClone(retained)
        return validate(structuredClone(retained.value))
      }
      checkpoint.steps[id] = entry
      options.save?.(checkpoint)
      return result
    },
    forget(id: string) {
      if (!(id in checkpoint.steps)) return
      delete checkpoint.steps[id]
      options.save?.(checkpoint)
    },
    /** Read only one factory response proved by all original binding inputs.
     * A cache miss never dispatches and never consumes or rewrites private work. */
    readStructuredResponse(id: string, input: unknown, name: string, prompt: string, schema: unknown): StructuredOutputCheckpoint | undefined {
      const parent_input_hash = digest(input)
      const bindingHash = digest({ parent_input_hash, name, prompt, schema })
      const previous = checkpoint.steps[`response:${id}:${bindingHash}`]
      if (!previous) return undefined
      if (previous.input_hash !== bindingHash) throw Object.assign(new Error('私有响应检查点身份不一致，不能迁移或重新请求'), { statusCode: 409 })
      return privateOutputSchema.parse(structuredClone(previous.value))
    },
    async run<T>(id: string, label: string, input: unknown, work: () => Promise<T>, validate: (value: unknown) => T, parentId?: string): Promise<T> {
      modelStepSignal(options.signal)?.throwIfAborted()
      const input_hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const previous = checkpoint.steps[id]
      const rebindInput = migratedInputs.delete(id)
      if (previous && (previous.input_hash === input_hash || rebindInput)) {
        let value: T
        try { value = validate(structuredClone(previous.value)) }
        catch { delete checkpoint.steps[id]; return this.run(id, label, input, work, validate, parentId) }
        if (previous.input_hash !== input_hash) {
          checkpoint.steps[id] = { ...previous, input_hash }
          options.save?.(checkpoint)
        }
        options.onStep?.({ id, parent_id: parentId, label, status: 'succeeded', reused: true, duration_ms: previous.duration_ms })
        return value
      }
      const started = Date.now()
      options.onStep?.({ id, parent_id: parentId, label, status: 'running' })
      const scope = createStreamScope(modelStepSignal(options.signal), { totalMs: null })
      try {
        const result = validate(await scope.wait(withStructuredOutputCheckpoints((name, prompt, schema) => {
          const binding = { parent_input_hash: input_hash, name, prompt, schema }
          const bindingHash = digest(binding), outputId = `response:${id}:${bindingHash}`
          const previous = checkpoint.steps[outputId]
          // Do not convert a corrupt response record into another paid call.
          const output: StructuredOutputCheckpoint = previous ? privateOutputSchema.parse(structuredClone(previous.value)) : {}
          let persisted = previous && structuredClone(previous)
          if (previous && previous.input_hash !== bindingHash) throw Object.assign(new Error('私有响应检查点身份不一致，不能重新请求'), { statusCode: 409 })
          return { checkpoint: output, guardInitialDispatch: true, persistCheckpoint: () => {
            const entry = { input_hash: bindingHash, value: structuredClone(privateOutputSchema.parse(output)) }
            if (options.savePrivateResponse) {
              const latest = options.savePrivateResponse(outputId, entry, persisted)
              adopt(latest)
              persisted = structuredClone(checkpoint.steps[outputId])
              // A concurrent complete response or intent discovered during the
              // initial bind must also control this execution's dispatch gate.
              for (const key of Object.keys(output)) delete output[key as keyof StructuredOutputCheckpoint]
              Object.assign(output, privateOutputSchema.parse(checkpoint.steps[outputId]!.value))
            } else {
              checkpoint.steps[outputId] = entry
              options.save?.(checkpoint)
              persisted = structuredClone(entry)
            }
          } }
        }, work)))
        modelStepSignal(options.signal)?.throwIfAborted()
        const duration_ms = Math.max(0, Date.now() - started)
        checkpoint.steps[id] = { input_hash, value: structuredClone(result), duration_ms }
        options.save?.(checkpoint)
        options.onStep?.({ id, parent_id: parentId, label, status: 'succeeded', duration_ms })
        return result
      } catch (error) {
        options.onStep?.({ id, parent_id: parentId, label, status: options.signal?.aborted && options.signal.reason?.name === 'AbortError' ? 'cancelled' : 'failed', duration_ms: Math.max(0, Date.now() - started) })
        throw error
      } finally { scope.close() }
    },
  }
}
