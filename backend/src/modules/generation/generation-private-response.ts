import { localRepairProgressSchema, syntaxRepairAuditSchema } from './model-output-checkpoints.js'
import { z } from 'zod'
import type { GenerationCheckpoint } from '../script/script-generation-steps.js'

export type GenerationPrivateResponseEntry = GenerationCheckpoint['steps'][string]
export type GenerationPrivateWrite = { expected?: GenerationPrivateResponseEntry }
export type SaveGenerationPrivateResponse = (id: string, entry: GenerationPrivateResponseEntry,
  expected?: GenerationPrivateResponseEntry) => GenerationCheckpoint

const responseSchema = z.object({ input_hash: z.string().optional(), raw: z.string().optional(), original_raw: z.string().optional(),
  correction: z.object({ input_hash: z.string(), raw: z.string() }).strict().optional(),
  initial_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(),
  correction_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(),
  syntax_repair: syntaxRepairAuditSchema.optional(),
  local_repair: localRepairProgressSchema.optional() }).strict()
const proposalSchema = responseSchema.extend({ proposal_state: z.unknown().optional() }).strict()
const entrySchema = z.object({ input_hash: z.string().regex(/^[a-f0-9]{64}$/), value: z.unknown() }).strict()
const nativeSlot = (id: string) => id === 'repair:tools:operations' || id === 'repair:tools:batches'
export const isGenerationPrivateSlot = (id: string) => /^response:.+:[a-f0-9]{64}$/.test(id) ||
  /^repair:(?:structured|worksets:proposal):[a-f0-9]{24}$/.test(id) || nativeSlot(id)
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function conflict() {
  return Object.assign(new Error('同一私有响应已有更新，旧执行不能覆盖已保留响应或再次派发'), {
    statusCode: 409, code: 'generation_private_response_conflict',
  })
}
function privateEntry(id: string, value: GenerationPrivateResponseEntry): GenerationPrivateResponseEntry {
  if (!isGenerationPrivateSlot(id)) throw new Error('未登记的私有响应位置')
  const parsed = entrySchema.parse(value)
  if (id.startsWith('response:') && !id.endsWith(`:${parsed.input_hash}`)) throw new Error('私有响应位置与绑定不一致')
  if (nativeSlot(id)) return parsed // The ledger owns full domain validation; CAS owns concurrency.
  return { ...parsed, value: (id.startsWith('response:') ? responseSchema : proposalSchema).parse(parsed.value) }
}

/** Business snapshots do not own already durable private response slots. */
export function preserveGenerationPrivateResponses(state: GenerationCheckpoint, durable: GenerationCheckpoint): GenerationCheckpoint {
  const result = structuredClone(state)
  for (const [id, value] of Object.entries(durable.steps)) {
    if (isGenerationPrivateSlot(id)) result.steps[id] = privateEntry(id, value)
  }
  return result
}

/** Merge one response against its last observed value. Other business/response
 * slots are always read from durable state. Native ledgers require whole-entry
 * CAS; structured proposal deltas preserve newer disjoint response fields. */
export function mergeGenerationPrivateResponse(state: GenerationCheckpoint, id: string,
  incoming: GenerationPrivateResponseEntry, expected?: GenerationPrivateResponseEntry): GenerationCheckpoint {
  const next = privateEntry(id, incoming)
  const before = expected ? privateEntry(id, expected) : undefined
  const current = state.steps[id] ? privateEntry(id, state.steps[id]) : undefined
  const replace = () => { const result = structuredClone(state); result.steps[id] = structuredClone(next); return result }
  if (nativeSlot(id)) {
    if (!equal(current, before)) throw conflict()
    return replace()
  }
  if (current && current.input_hash !== next.input_hash || before && before.input_hash !== next.input_hash) {
    // Existing explicit IDs predate hash-suffixed default response slots.
    // A genuinely changed input can replace one only from its exact observed
    // prior value; a delayed callback from the old input cannot replace it back.
    if (id.startsWith('response:') || !equal(current, before)) throw conflict()
    return replace()
  }
  const original = proposalSchema.parse(before?.value || {}), durable = proposalSchema.parse(current?.value || before?.value || {})
  const proposed = proposalSchema.parse(next.value)
  // A concurrent claim is never a second dispatch permit, even when both
  // callers calculated exactly the same marker bytes.
  for (const [marker, response] of [['initial_started', 'raw'], ['correction_started', 'correction']] as const) {
    if (!original[marker] && proposed[marker] && current && (durable[marker] || durable[response] !== undefined)) throw conflict()
  }
  const merged = structuredClone(durable) as Record<string, unknown>
  for (const name of new Set([...Object.keys(original), ...Object.keys(proposed)])) {
    const key = name as keyof typeof original
    if (equal(original[key], proposed[key])) continue
    if (!equal(durable[key], original[key]) && !equal(durable[key], proposed[key])) throw conflict()
    if (proposed[key] === undefined) delete merged[key]
    else merged[key] = structuredClone(proposed[key])
  }
  const result = structuredClone(state)
  result.steps[id] = privateEntry(id, { input_hash: next.input_hash, value: merged })
  return result
}
