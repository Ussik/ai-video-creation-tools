import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { one } from '../../infrastructure/database/db.js'
import { createGenerationSteps } from '../script/script-generation-steps.js'
import { generationUnitStore } from '../generation/generation-unit-store.js'

export const creativeInputHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Keep credentials/configuration out of prompts and checkpoints while binding
 * reuse to the effective model and channel, including manual configuration. */
export function creativeModelIdentity(modelId: string): string {
  const model = one<{ provider_id: string }>('SELECT * FROM models WHERE id=?', modelId)
  const provider = model ? one('SELECT * FROM providers WHERE id=?', model.provider_id) : undefined
  return creativeInputHash({ model_id: modelId, model, provider })
}

export function creativeGenerationSteps(projectId: string, namespace: string, identity: unknown, signal?: AbortSignal, restart = false) {
  const store = generationUnitStore(projectId, namespace, identity)
  if (restart) store.clear()
  return Object.assign(createGenerationSteps({ checkpoint: restart ? undefined : store.checkpoint, save: store.save, signal }), { clear: store.clear })
}

/** Request-driven work owns its cancellation. A disconnected request retains
 * completed units but must not keep dispatching new model requests. */
export async function withCreativeRequest<T>(request: FastifyRequest, reply: FastifyReply, label: string,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => { if (!reply.raw.writableEnded) controller.abort(new DOMException(`${label}已取消`, 'AbortError')) }
  request.raw.once('aborted', abort); reply.raw.once('close', abort)
  try {
    controller.signal.throwIfAborted()
    const value = await work(controller.signal)
    controller.signal.throwIfAborted()
    return value
  } catch (error) {
    if (controller.signal.aborted) throw Object.assign(new Error(`${label}已取消`), { statusCode: 499 })
    throw error
  } finally {
    request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort)
  }
}
