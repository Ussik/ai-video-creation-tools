import { createHash, randomUUID } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { db, now } from '../../infrastructure/database/db.js'
import type { StructuredOutputCheckpoint } from '../generation/model-output-checkpoints.js'
import { markLocalModelAdmissionDenied, type LocalModelAdmissionReason, type StructuredDispatchIntent } from '../generation/model-request-admission.js'

const hash = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
export function initSourceModelAdmission() {
  db.exec(`CREATE TABLE IF NOT EXISTS source_model_admission_events (
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,scope TEXT NOT NULL,request_key TEXT NOT NULL,
    intent_id TEXT NOT NULL,input_hash TEXT NOT NULL,initial_input_hash TEXT NOT NULL,phase TEXT NOT NULL,
    outcome TEXT NOT NULL,reason_code TEXT,error_code TEXT,ledger_binding TEXT NOT NULL,
    observed_at TEXT NOT NULL,evidence_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_source_model_admission_intent ON source_model_admission_events
    (project_id,intent_id,input_hash,phase,run_id);`)
}
/** Exact private ledger snapshot. No missing ledger is interpreted as proof. */
function ledgerSnapshot(projectId: string, scope: string, requestKey: string) {
  const base = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, requestKey)
  const epochs = exists('source_request_recovery_epochs') ? db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=? AND scope=? AND request_key=? ORDER BY sequence').all(projectId, scope, requestKey) : []
  const links = exists('source_request_dispatch_links') ? db.prepare('SELECT * FROM source_request_dispatch_links WHERE project_id=? AND scope=? AND request_key=? ORDER BY local_request_id').all(projectId, scope, requestKey) : []
  const late_events = exists('source_request_late_events') ? db.prepare('SELECT * FROM source_request_late_events WHERE project_id=? AND scope=? AND request_key=? ORDER BY id').all(projectId, scope, requestKey) : []
  const responses = db.prepare('SELECT scope,response_key,payload FROM source_model_responses WHERE project_id=? AND (scope=? OR scope LIKE ?) ORDER BY scope,response_key')
    .all(projectId, scope, scope + ':epoch:%')
  return { base: base || null, epochs, links, late_events, responses }
}
type Event = {
  id: string; project_id: string; run_id: string; scope: string; request_key: string
  intent_id: string; input_hash: string; initial_input_hash: string; phase: 'initial' | 'correction'
  outcome: 'denied' | 'dispatched'; reason_code: LocalModelAdmissionReason | null; error_code: string | null
  ledger_binding: string; observed_at: string; evidence_hash: string
}
const eventHash = ({ evidence_hash: _, ...event }: Event) => hash({ policy: 'source-local-admission-v1', ...event })
export function recordSourceModelAdmission(projectId: string, runId: string, scope: string, requestKey: string,
  intent: StructuredDispatchIntent | undefined, outcome: 'denied' | 'dispatched', reason: LocalModelAdmissionReason | null = null, issue?: unknown) {
  if (!intent) return
  const errorCode = issue && typeof issue === 'object' && 'code' in issue && typeof issue.code === 'string' ? issue.code : null
  const event: Event = { id: randomUUID(), project_id: projectId, run_id: runId, scope, request_key: requestKey,
    ...intent, outcome, reason_code: reason, error_code: errorCode,
    ledger_binding: hash(ledgerSnapshot(projectId, scope, requestKey)), observed_at: now(), evidence_hash: '' }
  event.evidence_hash = eventHash(event)
  db.prepare(`INSERT INTO source_model_admission_events
    (id,project_id,run_id,scope,request_key,intent_id,input_hash,initial_input_hash,phase,outcome,reason_code,error_code,ledger_binding,observed_at,evidence_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id, event.project_id, event.run_id, event.scope, event.request_key,
      event.intent_id, event.input_hash, event.initial_input_hash, event.phase, event.outcome, event.reason_code, event.error_code,
      event.ledger_binding, event.observed_at, event.evidence_hash)
  return event
}
export function sourceModelAdmissionDenied(projectId: string, runId: string, scope: string, requestKey: string,
  intent: StructuredDispatchIntent | undefined, reason: LocalModelAdmissionReason, issue: unknown): unknown {
  // Failure to save this proof fails closed: never brand an unjournaled denial.
  const event = recordSourceModelAdmission(projectId, runId, scope, requestKey, intent, 'denied', reason, issue)
  if (event && intent) return markLocalModelAdmissionDenied(issue, { intent, reason, evidence_hash: event.evidence_hash })
  return issue && typeof issue === 'object' ? Object.assign(issue, { delivery: 'not_sent', failure_stage: 'recovery' }) : issue
}
export type SourceModelAdmissionQuery = {
  run_ids: string[]; input_hash: string; phase: 'initial' | 'correction'; intent_id?: string; checkpoint_binding?: string
}
export type SourceModelAdmissionFact = {
  verdict: 'trusted_not_sent' | 'unknown' | 'dispatched' | 'accepted' | 'completed'
  version: string; input_hash: string; initial_input_hash?: string; phase: 'initial' | 'correction'; intent_id?: string
  evidence?: { id: string; run_id: string; scope: string; request_key: string; reason_code: string | null; evidence_hash: string; observed_at: string }
}
const trustedFacts = new WeakMap<SourceModelAdmissionFact, { projectId: string; query: SourceModelAdmissionQuery }>()
/** Read-only, exact-attempt proof. Legacy markers and an empty ledger remain
 * unknown. A new ledger change invalidates the old denial's CAS version. */
export function sourceModelAdmissionFact(projectId: string, query: SourceModelAdmissionQuery): SourceModelAdmissionFact {
  const runs = [...new Set(query.run_ids)].filter(Boolean).sort()
  const identity = { projectId, ...query, run_ids: runs }
  const unknown = (details: unknown = null): SourceModelAdmissionFact => ({ verdict: 'unknown', version: hash([identity, details]),
    input_hash: query.input_hash, phase: query.phase, ...(query.intent_id ? { intent_id: query.intent_id } : {}) })
  if (!query.intent_id || !runs.length || !/^[a-f0-9]{64}$/.test(query.input_hash) || !exists('source_model_admission_events')) return unknown()
  const events = db.prepare(`SELECT * FROM source_model_admission_events
    WHERE project_id=? AND input_hash=? AND phase=? AND intent_id=? ORDER BY observed_at,id`)
    .all(projectId, query.input_hash, query.phase, query.intent_id) as Event[]
  if (!events.length || events.some(event => !runs.includes(event.run_id))) return unknown(events)
  const denial = events.find(event => event.outcome === 'denied')
  const event = denial || events[0]!
  const snapshot = ledgerSnapshot(projectId, event.scope, event.request_key)
  const version = hash([identity, events, snapshot])
  const valid = events.every(item => item.evidence_hash === eventHash(item) && item.scope === event.scope &&
    item.request_key === event.request_key && item.run_id === event.run_id && item.initial_input_hash === event.initial_input_hash)
  const dispatched = events.some(item => item.outcome === 'dispatched')
  if (valid && dispatched) {
    const epoch = [...snapshot.epochs].reverse().find(row => (row as { run_id?: string }).run_id === event.run_id)
    const row = (epoch || snapshot.base) as { run_id: string; state: string; delivery: string } | null
    const verdict = row?.run_id === event.run_id && row.state === 'completed' && row.delivery === 'completed' ? 'completed'
      : row?.run_id === event.run_id && ['accepted', 'output_started'].includes(row.delivery) ? 'accepted' : 'dispatched'
    return { verdict, version, input_hash: event.input_hash, initial_input_hash: event.initial_input_hash,
      phase: event.phase, intent_id: event.intent_id }
  }
  if (!valid || !denial || dispatched || denial.ledger_binding !== hash(snapshot)) return { ...unknown([events, snapshot]), version }
  const fact: SourceModelAdmissionFact = { verdict: 'trusted_not_sent', version, input_hash: event.input_hash,
    initial_input_hash: event.initial_input_hash, phase: event.phase, intent_id: event.intent_id,
    evidence: { id: denial.id, run_id: denial.run_id, scope: denial.scope, request_key: denial.request_key,
      reason_code: denial.reason_code, evidence_hash: denial.evidence_hash, observed_at: denial.observed_at } }
  trustedFacts.set(fact, { projectId, query: structuredClone(query) })
  return fact
}
/** Uses the same exact persisted attempt identity as the live error path.
 * Only a fresh code-owned fact may authorize this local mutation. */
export function applyTrustedNotSentToCheckpoint(checkpoint: StructuredOutputCheckpoint, fact: SourceModelAdmissionFact): boolean {
  const trusted = trustedFacts.get(fact)
  if (!trusted || fact.verdict !== 'trusted_not_sent' || !fact.evidence || !fact.intent_id ||
    checkpoint.input_hash !== fact.initial_input_hash) return false
  const current = sourceModelAdmissionFact(trusted.projectId, trusted.query)
  if (current.verdict !== 'trusted_not_sent' || canonicalAiValue(current) !== canonicalAiValue(fact)) return false
  const field = fact.phase === 'initial' ? 'initial_started' : 'correction_started'
  const marker = checkpoint[field]
  if (!marker || marker.input_hash !== fact.input_hash || marker.intent_id !== fact.intent_id) return false
  delete checkpoint[field]
  return true
}
