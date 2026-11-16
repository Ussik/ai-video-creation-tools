import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { frozenSourceRequest } from './source-request-recovery.js'
import { db } from '../../infrastructure/database/db.js'

type Request = { scope: string; request_key: string; run_id: string; state: string; delivery: string; result: string | null; updated_at: string }
type Task = { project_id: string; model_id: string; state: string; created_at: string; updated_at: string }
type Attempt = { id: string; state: string; metrics: string; updated_at: string }
type Match = { scope: string; requestKey: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stamp = (value: string): number => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? Date.parse(value) : NaN
const near = (a: string, b: string) => Number.isFinite(stamp(a)) && Number.isFinite(stamp(b)) && Math.abs(stamp(a) - stamp(b)) <= 100
const parse = (value: string): Record<string, unknown> | undefined => { try { const result: unknown = JSON.parse(value); return record(result) ? result : undefined } catch { return } }
const tables = ['script_source_analyses', 'source_model_runs', 'source_model_requests', 'source_model_responses', 'model_request_tasks', 'model_request_attempts']

/** Older journals did not persist terminal-error markers or request IDs. Only
 * a unique, complete serial alignment with the local attempt history permits
 * classifying the final request as failed. Missing or ambiguous evidence keeps
 * the original dispatch barrier. This function never initializes or writes DB. */
export function legacyTerminatedSourceRequest(projectId: string, state: ScriptSourceAnalysis): Match | undefined {
  if (state.status !== 'failed' || !state.error?.includes('stream_read_error') || !Number.isFinite(stamp(state.updated_at))) return
  if (tables.some(name => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) return
  const analysis = db.prepare('SELECT id,status,source_version,snapshot,updated_at FROM script_source_analyses WHERE project_id=?').get(projectId) as
    { id: string; status: string; source_version: string; snapshot: string; updated_at: string } | undefined
  if (!analysis || analysis.id !== state.id || analysis.status !== 'failed' || analysis.source_version !== state.source_version || analysis.updated_at !== state.updated_at) return
  const snapshot = parse(analysis.snapshot)
  if (!snapshot || snapshot.id !== state.id || snapshot.model_id !== state.model_id || snapshot.error !== state.error || snapshot.status !== 'failed' || snapshot.updated_at !== state.updated_at) return
  if (!db.prepare('SELECT 1 FROM source_model_runs WHERE project_id=? AND id=?').get(projectId, state.id)) return
  const taskId = `source:${state.id}`
  const task = db.prepare('SELECT project_id,model_id,state,created_at,updated_at FROM model_request_tasks WHERE id=?').get(taskId) as Task | undefined
  if (!task || task.project_id !== projectId || task.model_id !== state.model_id || task.state !== 'failed' || !near(task.updated_at, state.updated_at)) return
  const requests = db.prepare('SELECT scope,request_key,run_id,state,delivery,result,updated_at FROM source_model_requests WHERE project_id=? AND run_id=? ORDER BY updated_at,request_key').all(projectId, state.id) as Request[]
  const attempts = db.prepare('SELECT id,state,metrics,updated_at FROM model_request_attempts WHERE task_id=? ORDER BY updated_at,id').all(taskId) as Attempt[]
  if (!requests.length || requests.length !== attempts.length || requests.filter(row => row.state === 'dispatched').length !== 1) return
  const last = requests.at(-1)!, lastAttempt = attempts.at(-1)!
  if (frozenSourceRequest(projectId, last.scope, last.request_key)) return
  if (last.state !== 'dispatched' || last.result !== null || !['unknown', 'accepted', 'output_started'].includes(last.delivery) ||
    requests.some(row => row.scope !== last.scope) || !Number.isFinite(stamp(task.created_at)) || stamp(task.created_at) > stamp(requests[0]!.updated_at)) return
  if (db.prepare('SELECT 1 FROM source_model_responses WHERE project_id=? LIMIT 1').get(projectId)) return
  const metrics = attempts.map(attempt => parse(attempt.metrics))
  if (metrics.some((metric, index) => !metric || attempts[index]!.state !== 'settled' || metric.task_id !== taskId || metric.request_id !== attempts[index]!.id ||
    metric.model_id !== state.model_id || metric.kind !== undefined || !['generation', 'review'].includes(String(metric.request_purpose)) ||
    !Number.isFinite(stamp(attempts[index]!.updated_at)))) return
  for (let index = 0; index < requests.length - 1; index++) {
    const request = requests[index]!, metric = metrics[index]!, attempt = attempts[index]!, next = requests[index + 1]!
    if (request.state !== 'completed' || request.delivery !== 'completed' || typeof request.result !== 'string' || metric.delivery !== 'completed' ||
      metric.failure_reason !== undefined || metric.response_chars !== request.result.length || !near(request.updated_at, attempt.updated_at) ||
      stamp(request.updated_at) >= stamp(next.updated_at) || stamp(attempt.updated_at) >= stamp(next.updated_at)) return
  }
  const final = metrics.at(-1)!
  if (final.raw_reason !== 'stream_read_error' || final.http_status !== 200 || !['accepted', 'output_started'].includes(String(final.delivery)) ||
    !['upstream_error', 'disconnected'].includes(String(final.failure_reason)) || !near(lastAttempt.updated_at, task.updated_at) ||
    !near(lastAttempt.updated_at, state.updated_at) || !Number.isFinite(stamp(last.updated_at)) || stamp(last.updated_at) > stamp(lastAttempt.updated_at)) return
  return { scope: last.scope, requestKey: last.request_key }
}

/** Called only by an explicit continuation. Recheck under a write transaction
 * and change only the precisely identified legacy row; no prompts/results or
 * business analysis checkpoints are modified. */
export function settleLegacyTerminatedSourceRequest(projectId: string, state: ScriptSourceAnalysis): boolean {
  return db.transaction(() => {
    const match = legacyTerminatedSourceRequest(projectId, state)
    if (!match) return false
    const original = db.prepare('SELECT updated_at FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=? AND run_id=?').get(projectId, match.scope, match.requestKey, state.id) as { updated_at: string }
    const changed = db.prepare("UPDATE source_model_requests SET state='failed' WHERE project_id=? AND scope=? AND request_key=? AND run_id=? AND state='dispatched' AND result IS NULL AND updated_at=?")
      .run(projectId, match.scope, match.requestKey, state.id, original.updated_at)
    return changed.changes === 1
  }).immediate()
}
