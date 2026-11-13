import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { db, now } from '../../infrastructure/database/db.js'
import { withTextResponseRecovery, type BackgroundResponse } from '../../infrastructure/providers/text-background.js'
import { currentModelRequestContext, withModelRequestContext, modelTaskPolicies } from '../generation/model-task-policy.js'
import type { SourceAnalyzer } from './script-source-analysis.js'

type RequestRow = { state: string; run_id: string; result: string | null; delivery: string }
export function initSourceModelRecovery() {
  db.exec(`CREATE TABLE IF NOT EXISTS source_model_runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS source_model_requests (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,request_key TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,delivery TEXT NOT NULL,
    result TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,scope,request_key));
    CREATE TABLE IF NOT EXISTS source_model_responses (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,response_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,scope,response_key));`)
}
export function markSourceModelRun(projectId: string, id: string) {
  initSourceModelRecovery()
  db.prepare('INSERT OR IGNORE INTO source_model_runs (id,project_id) VALUES (?,?)').run(id, projectId)
}
export function hasSourceModelRun(projectId: string, id: string) {
  initSourceModelRecovery()
  return !!db.prepare('SELECT 1 FROM source_model_runs WHERE id=? AND project_id=?').get(id, projectId)
}
export function sourceModelRecovery(projectId: string, runId: string, identity: unknown, generate: SourceAnalyzer) {
  markSourceModelRun(projectId, runId)
  const scope = createHash('sha256').update(canonicalAiValue(identity)).digest('hex')
  const recovery = {
    read(key: string): BackgroundResponse | undefined {
      const row = db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').get(projectId, scope, key) as { payload: string } | undefined
      if (!row) return
      const value = JSON.parse(row.payload) as BackgroundResponse
      if (!['creating', 'accepted'].includes(value.state) || value.id !== undefined && !/^resp_[a-zA-Z0-9_-]+$/.test(value.id)) throw Object.assign(new Error('原稿分析的上游响应身份损坏，已停止自动派发'), { statusCode: 409 })
      return value
    },
    save(key: string, value?: BackgroundResponse) {
      if (!value) { db.prepare('DELETE FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').run(projectId, scope, key); return }
      db.prepare(`INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)
        ON CONFLICT(project_id,scope,response_key) DO UPDATE SET payload=excluded.payload`).run(projectId, scope, key, JSON.stringify(value))
    },
  }
  // A process reconstruction may consume the last complete upstream reply once.
  // Repeated semantic work inside the same live run remains intentional new work.
  const delivered = new Set<string>()
  const wrapped: SourceAnalyzer = async (...args) => {
    args[4].throwIfAborted()
    const key = createHash('sha256').update(canonicalAiValue([args[1], args[2], args[3]])).digest('hex')
    const row = db.prepare('SELECT state,run_id,result,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key) as RequestRow | undefined
    if (row?.state === 'completed' && row.run_id === runId && row.result !== null && !delivered.has(key)) { delivered.add(key); return row.result }
    const parent = currentModelRequestContext()
    const upsert = (state: string, delivery: string, result: string | null = null) => {
      db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,scope,request_key) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,delivery=excluded.delivery,result=excluded.result,updated_at=excluded.updated_at`)
        .run(projectId, scope, key, runId, state, delivery, result, now())
    }
    // Only a background identity for THIS exact request permits re-entry to
    // the provider wrapper; that wrapper then queries, never blindly POSTs.
    const requestRecovery = {
      read(responseKey: string) {
        const value = recovery.read(responseKey)
        if (row?.state === 'dispatched' && !value) throw Object.assign(new Error('上次原稿分析请求的受理结果未知，已保留完成步骤；请先核对提供商记录，不能自动重新生成。'), { statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown' })
        return value
      },
      save(responseKey: string, value?: BackgroundResponse) { recovery.save(responseKey, value) },
    }
    let dispatched = row?.state === 'dispatched', delivery = row?.delivery || 'not_sent'
    if (!row || row.state !== 'dispatched') upsert('prepared', 'not_sent')
    let enteredRecovery = false
    const scopedRecovery = { ...requestRecovery, read(key: string) { enteredRecovery = true; return requestRecovery.read(key) } }
    return withTextResponseRecovery(scopedRecovery, () => withModelRequestContext({ ...parent, policy: parent?.policy || modelTaskPolicies.generation,
      onDispatch: value => {
        const metric = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (metric.kind !== 'transport') {
          // A prior non-background request cannot safely be resent. This
          // synchronous check runs immediately before the actual fetch.
          if (row?.state === 'dispatched' && !enteredRecovery) throw Object.assign(new Error('上次原稿分析请求的受理结果未知，不能自动重新生成。'), { statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown' })
          dispatched = true; delivery = 'unknown'; upsert('dispatched', delivery)
        }
        parent?.onDispatch?.(value)
      },
      onMetrics: value => {
        const metric = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (metric.kind !== 'transport' && typeof metric.delivery === 'string') delivery = metric.delivery
        parent?.onMetrics?.(value)
      },
    }, async () => {
      let result: string
      try { result = await generate(...args) } catch (issue) {
        if (!dispatched || delivery === 'not_sent' || delivery === 'rejected' || delivery === 'completed') upsert('settled', delivery)
        // Unknown/accepted dispatch identity remains durable across automatic
        // startup recovery and an explicit retry with a new analyzer run ID.
        throw issue
      }
      // Completion persistence is outside the provider-failure catch. A failed
      // write must preserve the dispatch barrier even if upstream completed.
      upsert('completed', 'completed', result)
      delivered.add(key)
      args[4].throwIfAborted()
      return result
    }))
  }
  return wrapped
}
