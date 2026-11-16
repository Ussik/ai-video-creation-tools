import { AsyncLocalStorage } from 'node:async_hooks'

/** A persisted, exact structured-output attempt. This is internal execution
 * identity, not provider input or authority supplied by model output. */
export type StructuredDispatchIntent = Readonly<{
  intent_id: string
  input_hash: string
  initial_input_hash: string
  phase: 'initial' | 'correction'
}>
export type LocalModelAdmissionReason = 'source_admission_gate' | 'source_dispatch_journal'
type LocalAdmissionDenial = Readonly<{ intent: StructuredDispatchIntent; reason: LocalModelAdmissionReason; evidence_hash: string }>
const intents = new AsyncLocalStorage<StructuredDispatchIntent>()
const localReplayOnly = new AsyncLocalStorage<boolean>()
const localDenials = new WeakMap<object, LocalAdmissionDenial>()
const possibleDispatches = new WeakSet<StructuredDispatchIntent>()
export const currentStructuredDispatchIntent = () => intents.getStore()
export const isLocalModelReplayOnly = () => localReplayOnly.getStore() === true
/** The caller must supply a completed-only reader and prohibit provider entry.
 * Missing local bytes cannot reserve a fresh paid-request intent. */
export function withLocalModelReplayOnly<T>(work: () => T): T {
  return localReplayOnly.run(true, work)
}
export function withStructuredDispatchIntent<T>(intent: StructuredDispatchIntent | undefined, work: () => T): T {
  return intent ? intents.run(intent, work) : work()
}
export function protectStructuredDispatchIntent(intent: StructuredDispatchIntent | undefined): void {
  if (intent) possibleDispatches.add(intent)
}
export function structuredDispatchMayHaveSent(intent: StructuredDispatchIntent | undefined): boolean {
  return !!intent && possibleDispatches.has(intent)
}

/** Called only after a code-owned pre-dispatch gate has persisted its exact
 * denial proof. An arbitrary error.delivery or message never creates proof. */
export function markLocalModelAdmissionDenied(issue: unknown, denial: LocalAdmissionDenial): unknown {
  const error = issue && typeof issue === 'object' ? issue : new Error(String(issue), { cause: issue })
  localDenials.set(error, denial)
  Object.assign(error, { delivery: 'not_sent', failure_stage: 'recovery' })
  return error
}
export function isLocalModelAdmissionDenied(issue: unknown, intent: StructuredDispatchIntent | undefined): boolean {
  if (!intent || !issue || typeof issue !== 'object') return false
  const proof = localDenials.get(issue)
  return !!proof && proof.intent.intent_id === intent.intent_id && proof.intent.input_hash === intent.input_hash &&
    proof.intent.initial_input_hash === intent.initial_input_hash && proof.intent.phase === intent.phase
}
