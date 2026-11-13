import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { aiOperationHeader, isAiOperationRoute, canonicalAiValue, type AiOperationRecord } from '@video-studio/shared/api/ai-operations'
import { db, now, required, type Project } from '../../infrastructure/database/db.js'
import { stopObservedModelTask } from './model-request-observation.js'
import { aiOperationError } from './ai-operation-errors.js'

type Row = { id: string; project_id: string; route: string; fingerprint: string; state: 'running' | 'completed' | 'failed'; status_code: number | null; result: string | null; candidate: string | null; model_task_id: string | null; owner: string; lease_until: number; created_at: string; updated_at: string }
const operationIds = new WeakMap<FastifyRequest, string>()
const reservations = new WeakMap<FastifyRequest, { id: string; owner: string }>()
export const currentAiOperationId = (request: FastifyRequest) => operationIds.get(request)
const leaseMs = 30_000
export function initAiOperations() {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_operations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    route TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status_code INTEGER,
    result TEXT, candidate TEXT, model_task_id TEXT, owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ai_operations_project ON ai_operations(project_id,created_at);`)
  if (!(db.prepare('PRAGMA table_info(ai_operations)').all() as Array<{ name: string }>).some(column => column.name === 'candidate')) {
    db.exec('ALTER TABLE ai_operations ADD COLUMN candidate TEXT')
  }
}
/** A validated complete candidate is a subordinate artifact of this intent.
 * Save it before another paid review; it never grants apply approval. */
export function retainAiOperationCandidate(request: FastifyRequest, candidate: unknown): boolean {
  const reservation = reservations.get(request)
  if (!reservation) return false // Isolated legacy routers have no operation registry.
  let changes: number
  try { changes = db.prepare("UPDATE ai_operations SET candidate=?,updated_at=? WHERE id=? AND owner=? AND state='running'")
    .run(JSON.stringify(candidate), now(), reservation.id, reservation.owner).changes }
  catch (cause) { throw Object.assign(new Error('完整草稿登记失败，已停止后续模型请求，请核对原操作。', { cause }), { statusCode: 503, code: 'ai_candidate_persist_failed' }) }
  if (changes !== 1) throw Object.assign(new Error('操作归属已变化，未继续复核或保存。'), { statusCode: 409, code: 'ai_operation_ownership_lost' })
  return true
}
function projectFor(request: FastifyRequest): string | undefined {
  const path = request.url.split('?')[0]!, direct = /^\/api\/projects\/([^/]+)\//.exec(path)
  if (direct) return decodeURIComponent(direct[1]!)
  const indirect = /^\/api\/(visual-profiles|asset-tasks|jobs)\/([^/]+)\//.exec(path)
  const table = indirect?.[1] === 'visual-profiles' ? 'visual_profiles' : indirect?.[1] === 'asset-tasks' ? 'asset_tasks' : indirect?.[1] === 'jobs' ? 'jobs' : undefined
  return table ? (db.prepare(`SELECT project_id FROM ${table} WHERE id=?`).get(decodeURIComponent(indirect![2]!)) as { project_id: string } | undefined)?.project_id : undefined
}
function publicRecord(row: Row): AiOperationRecord {
  const result = row.result === null ? undefined : JSON.parse(row.result) as unknown
  const state = row.state === 'running' && row.lease_until < Date.now() ? 'interrupted' : row.state
  return { id: row.id, project_id: row.project_id, route: row.route, state, status_code: row.status_code,
    ...(result !== undefined ? { result } : {}), ...(row.candidate !== null ? { candidate: JSON.parse(row.candidate) as unknown } : {}), ...(row.model_task_id ? { model_task_id: row.model_task_id } : {}),
    ...(row.state === 'failed' ? { error: aiOperationError(result, row.status_code || 500, row.id) }
      : state === 'interrupted' ? { error: aiOperationError({ code: 'ai_operation_interrupted', category: 'unknown_result',
        detail: '请求执行已中断；已有成果和上游身份保留，请查看原任务，不能自动重新生成。' }, 409, row.id) } : {}),
    created_at: row.created_at, updated_at: row.updated_at }
}
/** Persist an intent before the handler and its JSON result before delivery.
 * Expired ownership permits observation only, never automatic paid replay. */
export function registerAiOperations(app: FastifyInstance) {
  initAiOperations()
  const owned = new WeakMap<FastifyRequest, { id: string; owner: string; timer: ReturnType<typeof setInterval>; onClose: () => void }>()
  app.addHook('preHandler', async (request, reply) => {
    if (!isAiOperationRoute(request.method, request.url)) return
    const projectId = projectFor(request)
    if (!projectId) return // The domain handler reports its ordinary missing resource.
    required<Project>('projects', projectId)
    const supplied = request.headers[aiOperationHeader]
    if (supplied !== undefined && (typeof supplied !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/.test(supplied))) {
      return reply.code(422).send({ detail: '操作身份格式无效', code: 'ai_operation_invalid_id' })
    }
    const id = typeof supplied === 'string' ? supplied : randomUUID(), owner = randomUUID()
    operationIds.set(request, id); reply.header(aiOperationHeader, id)
    const url = new URL(request.url, 'http://local'); url.searchParams.sort()
    const route = url.pathname + url.search
    const fingerprint = createHash('sha256').update(canonicalAiValue([projectId, request.method, route, request.body])).digest('hex')
    const reserve = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM ai_operations WHERE id=?').get(id) as Row | undefined
      if (existing) return existing
      const time = now()
      db.prepare(`INSERT INTO ai_operations (id,project_id,route,fingerprint,state,owner,lease_until,created_at,updated_at)
        VALUES (?,?,?,?,'running',?,?,?,?)`).run(id, projectId, route, fingerprint, owner, Date.now() + leaseMs, time, time)
    })
    const existing = reserve.immediate()
    if (existing) {
      if (existing.project_id !== projectId || existing.fingerprint !== fingerprint) return reply.code(409).send({ detail: '此操作身份已用于另一条请求，请先查看原操作。', code: 'ai_operation_conflict', operation_id: id, category: 'configuration', outcome_certainty: 'not_dispatched', recovery: { kind: 'observe', operation_id: id } })
      if (existing.result !== null && existing.status_code !== null) return reply.code(existing.status_code).send(JSON.parse(existing.result))
      return reply.code(409).send({ detail: existing.lease_until < Date.now() ? '原操作已中断，不能自动重复派发。请查看保留成果并核对上游结果。' : '原操作仍在处理，请继续查看原操作。',
        code: existing.lease_until < Date.now() ? 'ai_operation_interrupted' : 'ai_operation_running', operation_id: id, outcome_certainty: 'unknown', retryable: false, recovery: { kind: 'observe', operation_id: id } })
    }
    reservations.set(request, { id, owner })
    db.prepare('UPDATE ai_operations SET model_task_id=? WHERE id=? AND owner=?').run(String(reply.getHeader('x-model-task-id') || '') || null, id, owner)
    const timer = setInterval(() => {
      try { db.prepare("UPDATE ai_operations SET lease_until=? WHERE id=? AND owner=? AND state='running'").run(Date.now() + leaseMs, id, owner) }
      catch { /* No hidden replay or dispatch if a heartbeat cannot persist. */ }
    }, leaseMs / 3)
    const onClose = () => cleanup(request)
    timer.unref(); owned.set(request, { id, owner, timer, onClose }); reply.raw.once('close', onClose)
  })
  app.addHook('onSend', async (request, reply, payload) => {
    const item = owned.get(request)
    if (!item) return payload
    const contentType = String(reply.getHeader('content-type') || '')
    if (!contentType.includes('application/json') || typeof payload !== 'string') return payload
    let result: unknown
    try { result = JSON.parse(payload) } catch { return payload }
    if (reply.statusCode >= 400 && result && typeof result === 'object' && !Array.isArray(result)) {
      const error = aiOperationError(result, reply.statusCode, item.id)
      result = { ...result, code: error.code, category: error.category, retryable: error.retryable,
        outcome_certainty: error.outcome_certainty, recovery: error.recovery, operation_id: item.id }
      payload = JSON.stringify(result)
    }
    // A failed result write must not send a false success. Ownership remains
    // interrupted/unknown and the original identity cannot dispatch again.
    const saved = db.prepare(`UPDATE ai_operations SET state=?,status_code=?,result=?,model_task_id=?,updated_at=?,lease_until=?
      WHERE id=? AND owner=? AND state='running'`).run(reply.statusCode >= 400 ? 'failed' : 'completed', reply.statusCode,
      JSON.stringify(result), String(reply.getHeader('x-model-task-id') || '') || null, now(), Date.now(), item.id, item.owner)
    if (saved.changes !== 1) throw Object.assign(new Error('操作保存权限已变化，请核对原请求结果。'), { statusCode: 503, code: 'ai_operation_ownership_lost' })
    return payload
  })
  const cleanup = (request: FastifyRequest) => { const item = owned.get(request); if (item) { clearInterval(item.timer); owned.delete(request) } }
  app.addHook('onResponse', async request => cleanup(request))
  app.addHook('onRequestAbort', async request => cleanup(request))
  const read = (id: string, projectId?: string) => {
    const row = db.prepare('SELECT * FROM ai_operations WHERE id=?').get(id) as Row | undefined
    return row && (!projectId || row.project_id === projectId) ? row : undefined
  }
  const missing = { detail: '操作记录不存在', code: 'ai_operation_not_found' }
  app.get('/api/ai-operations/:operationId', async (request, reply) => {
    const row = read((request.params as { operationId: string }).operationId)
    return row ? publicRecord(row) : reply.code(404).send(missing)
  })
  app.get('/api/projects/:id/ai-operations/:operationId', async (request, reply) => {
    const { id, operationId } = request.params as { id: string; operationId: string }, row = read(operationId, id)
    return row ? publicRecord(row) : reply.code(404).send(missing)
  })
  app.get('/api/projects/:id/ai-operations', async request => {
    const { id } = request.params as { id: string }; required<Project>('projects', id)
    return (db.prepare('SELECT * FROM ai_operations WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(id) as Row[]).map(publicRecord)
  })
  const stop = (row: Row | undefined, reply: { code: (code: number) => { send: (value: unknown) => unknown } }) => {
    if (!row) return reply.code(404).send(missing)
    const stopped = row.model_task_id ? stopObservedModelTask(row.model_task_id) : false
    return { stopped, remote_cancelled: false, operation_id: row.id, detail: stopped ? '已请求停止本地处理，上游状态以提供商记录为准。' : '操作当前不可在此停止，请查看其关联任务。' }
  }
  app.post('/api/ai-operations/:operationId/stop', async (request, reply) => stop(read((request.params as { operationId: string }).operationId), reply))
  app.post('/api/projects/:id/ai-operations/:operationId/stop', async (request, reply) => {
    const { id, operationId } = request.params as { id: string; operationId: string }; return stop(read(operationId, id), reply)
  })
}
