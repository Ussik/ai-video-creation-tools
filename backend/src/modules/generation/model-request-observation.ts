import { randomUUID } from 'node:crypto'
import { getLangfuseTracer, type LangfuseTracer } from '../../infrastructure/observability/langfuse-tracing.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { all, db, now, required, type Project } from '../../infrastructure/database/db.js'
import { createScriptRequestUsage, withTextRequestUsage, type ScriptRequestUsage } from '../../infrastructure/providers/text-request-usage.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext, type ModelTaskPolicy, type ModelUnitProgress } from './model-task-policy.js'

type Owner = 'request' | 'job' | 'director'
type ObservationOptions = { taskId?: string; projectId?: string; modelId?: string; label: string; owner: Owner; signal?: AbortSignal; policy?: ModelTaskPolicy }
const active = new Map<string, AbortController>()
// Only a live observation may write a reusable durable task ID. Entries are
// removed on finish/abort, so historical task IDs do not accumulate here.
const observationOwners = new Map<string, symbol>()
// These auxiliary requests do not enter the text token-reservation ledger.
const mediaTransports = new Set(['media_create', 'media_poll', 'media_download', 'speech_create'])
/** Stops local execution only; provider cancellation/charging is independent. */
export function stopObservedModelTask(id: string): boolean {
  const controller = active.get(id)
  if (!controller) return false
  controller.abort(new DOMException('已请求停止本地处理，上游状态仍需核对提供商记录', 'AbortError'))
  return true
}
const numericFields = ['request_bytes', 'response_chars', 'first_event_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'output_limit',
  'cache_read_tokens', 'cache_write_tokens', 'estimated_input_tokens', 'context_window_tokens', 'reserved_output_tokens', 'http_status', 'framing_reserve_tokens']
const stringFields = ['kind', 'transport_kind', 'task_id', 'step_id', 'attempt_id', 'request_id', 'model_id', 'remote_id', 'failure_reason', 'raw_reason', 'delivery',
  'output_parameter', 'budget_mode', 'input_count_method', 'capacity_status', 'output_source', 'capability_source', 'request_purpose', 'upstream_request_id', 'output_limit_reason', 'output_limit_kind', 'estimate_source', 'context_source']
/** Store diagnostics only; prompts, media, API keys and private reasoning never
 * enter the task history. Unknown token use remains in the estimate ledger. */
export function safeModelMetrics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>, result: Record<string, unknown> = {}
  for (const key of numericFields) if (typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key]
  for (const key of stringFields) if (typeof source[key] === 'string') result[key] = source[key].slice(0, 300)
  if (typeof source.output_started === 'boolean') result.output_started = source.output_started
  if (typeof source.endpoint === 'string') { try { const url = new URL(source.endpoint); result.endpoint = url.origin + url.pathname } catch { /* no arbitrary text */ } }
  return result
}
export function initModelRequestObservation() {
  db.exec(`CREATE TABLE IF NOT EXISTS model_request_tasks (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, model_id TEXT,
    label TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, usage TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS model_request_attempts (
    task_id TEXT NOT NULL REFERENCES model_request_tasks(id) ON DELETE CASCADE,
    id TEXT NOT NULL, state TEXT NOT NULL, metrics TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(task_id,id));
    CREATE INDEX IF NOT EXISTS idx_model_request_tasks_project ON model_request_tasks(project_id,created_at);`)
  if (!(db.prepare('PRAGMA table_info(model_request_tasks)').all() as Array<{ name: string }>).some(column => column.name === 'progress')) {
    db.exec("ALTER TABLE model_request_tasks ADD COLUMN progress TEXT NOT NULL DEFAULT '[]'")
  }
}
export function createModelRequestObservation(options: ObservationOptions, tracer: LangfuseTracer = getLangfuseTracer()) {
  const id = options.taskId || randomUUID()
  // Export is subordinate to the existing local observation. A failed client
  // or exporter cannot prevent dispatch, change its result or create a retry.
  const quietTrace = (work: () => void) => { try { work() } catch { /* Tracing never owns execution. */ } }
  let trace: ReturnType<LangfuseTracer['observation']> | undefined
  quietTrace(() => { trace = tracer.observation({ taskId: id, projectId: options.projectId, modelId: options.modelId, owner: options.owner, label: options.label }) })
  const previous = options.taskId ? db.prepare('SELECT usage,progress FROM model_request_tasks WHERE id=?').get(id) as {usage: string; progress: string} | undefined : undefined
  let usage = createScriptRequestUsage()
  if (previous) { try { usage = JSON.parse(previous.usage) as ScriptRequestUsage } catch { throw new Error('任务用量记录损坏，不能丢弃后重新派发') } }
  const countedMediaRequests = new Set(previous ? (db.prepare(`SELECT id FROM model_request_attempts WHERE task_id=?
    AND json_extract(metrics,'$.transport_kind') IN ('media_create','media_poll','media_download','speech_create')`)
    .all(id) as Array<{ id: string }>).map(row => row.id) : [])
  const progress = new Map<string, ModelUnitProgress>()
  if (previous) for (const item of JSON.parse(previous.progress) as ModelUnitProgress[]) progress.set(item.phase_id, item)
  const owner = Symbol(id)
  observationOwners.set(id, owner)
  const dispatchedRequests = new Set<string>()
  let state = 'running', recorded = false, closed = false
  const isCurrent = () => !closed && observationOwners.get(id) === owner
  const canObserve = () => isCurrent() && !options.signal?.aborted
  const persist = () => {
    if (!isCurrent()) return
    if (!recorded && !usage.requests && !usage.transport_requests) return
    recorded = true
    db.prepare(`INSERT INTO model_request_tasks (id,project_id,model_id,label,owner,state,usage,created_at,updated_at,progress) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,usage=excluded.usage,updated_at=excluded.updated_at,progress=excluded.progress`)
      .run(id, options.projectId || null, options.modelId || null, options.label, options.owner, state, JSON.stringify(usage), now(), now(), JSON.stringify([...progress.values()]))
  }
  const observe = (value: unknown, complete: boolean) => {
    if (!canObserve()) return
    const metrics = safeModelMetrics(value), requestId = typeof metrics.request_id === 'string' ? metrics.request_id : undefined
    if (!complete && requestId && mediaTransports.has(String(metrics.transport_kind)) && !countedMediaRequests.has(requestId)) {
      countedMediaRequests.add(requestId)
      const bytes = Number.isSafeInteger(metrics.request_bytes) ? Number(metrics.request_bytes) : 0
      if (metrics.kind === 'generation') { usage.requests++; usage.request_bytes += bytes }
      else { usage.transport_requests++; usage.transport_request_bytes += bytes }
      // A media request has no text-token reservation. Unknown media pricing
      // must not fabricate pending text requests or token estimates.
    }
    recorded = true; persist()
    if (!requestId) return
    db.prepare(`INSERT INTO model_request_attempts (task_id,id,state,metrics,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(task_id,id) DO UPDATE SET state=excluded.state,metrics=excluded.metrics,updated_at=excluded.updated_at`)
      .run(id, requestId, complete ? 'settled' : 'dispatched', JSON.stringify(metrics), now())
  }
  // Logging after a remote side effect must never turn a valid result into a
  // retryable failure. Reservations are persisted by onUpdate before dispatch.
  const safely = (work: () => void) => { try { work() } catch (error) { console.error('模型请求记录保存失败', error) } }
  const finish = (next: 'succeeded' | 'failed' | 'cancelled') => {
    if (closed) return
    state = next; safely(persist); quietTrace(() => trace?.finish(next)); closed = true
    if (observationOwners.get(id) === owner) observationOwners.delete(id)
    options.signal?.removeEventListener('abort', aborted)
  }
  const aborted = () => {
    const code = (options.signal?.reason as { code?: unknown } | undefined)?.code
    finish(code === 'storyboard_planning_budget_exceeded' || code === 'text_request_budget_exceeded' ? 'failed' : 'cancelled')
  }
  options.signal?.addEventListener('abort', aborted, { once: true })
  if (options.signal?.aborted) aborted()
  return {
    id,
    run<T>(work: () => T): T {
      options.signal?.throwIfAborted()
      return withModelRequestContext({ taskId: id, policy: options.policy || modelTaskPolicies.text, signal: options.signal,
        onProgress: value => { if (canObserve()) safely(() => { progress.set(value.phase_id, value); recorded = true; persist() }) },
        onDispatch: value => {
          if (!canObserve()) return
          const metrics = safeModelMetrics(value)
          if (typeof metrics.request_id === 'string') dispatchedRequests.add(metrics.request_id)
          safely(() => observe(value, false)); quietTrace(() => { const stage = currentModelRequestContext()?.traceStage; trace?.dispatch({ ...metrics, ...(stage ? { trace_stage: stage } : {}) }) })
        },
        onMetrics: value => {
          const metrics = safeModelMetrics(value)
          if (canObserve()) safely(() => observe(value, true))
          else {
            // A finished root may still receive a dispatched child's final
            // usage. Settle only that attempt; never save the stale aggregate
            // over a resumed execution or create a new rejected dispatch.
            if (typeof metrics.request_id !== 'string' || !dispatchedRequests.has(metrics.request_id)) return
            safely(() => db.prepare(`UPDATE model_request_attempts SET state='settled',metrics=?,updated_at=?
              WHERE task_id=? AND id=? AND (state='dispatched' OR json_extract(metrics,'$.delivery')='unknown')`)
              .run(JSON.stringify(metrics), now(), id, metrics.request_id))
          }
          quietTrace(() => trace?.metrics(metrics))
        } },
      () => withTextRequestUsage({ usage, signal: options.signal, onUpdate(_usage, phase) {
        if (!canObserve()) return
        if (phase === 'reservation') persist()
        else safely(persist)
      } }, work))
    },
    finish,
  }
}
export async function observeModelTask<T>(options: ObservationOptions, work: () => Promise<T>): Promise<T> {
  const controller = new AbortController(), parent = currentModelRequestContext()?.signal
  const signals = [options.signal, parent, controller.signal].filter((value): value is AbortSignal => !!value)
  const signal = AbortSignal.any(signals)
  const observation = createModelRequestObservation({ ...options, signal })
  active.set(observation.id, controller)
  const releaseActive = () => { if (active.get(observation.id) === controller) active.delete(observation.id) }
  signal.addEventListener('abort', releaseActive, { once: true })
  if (signal.aborted) releaseActive()
  try { const result = await observation.run(work); observation.finish('succeeded'); return result }
  catch (error) {
    // Execution guardrails abort their signal to stop the provider, but they
    // are failures rather than a creator's cancellation. Keep this generic
    // observer independent of the owning business workflow.
    const code = (signal.reason as { code?: unknown } | undefined)?.code
    const budgetStopped = code === 'storyboard_planning_budget_exceeded' || code === 'text_request_budget_exceeded'
    observation.finish(signal.aborted && !budgetStopped ? 'cancelled' : 'failed'); throw error
  }
  finally { signal.removeEventListener('abort', releaseActive); releaseActive() }
}
function requestLabel(path: string) {
  const names: Array<[string,string]> = [['plan-shots','场次分镜'], ['storyboard','分镜规划'], ['visual','视觉设定'], ['prepare','画布准备'], ['refine','提示词精炼'], ['optim','提示词优化'], ['video','视频分析'], ['image','图片分析'], ['source','原稿分析'], ['classif','回复分类'], ['continuity','连续性检查'], ['script','剧本处理'], ['skill','创作技能'], ['generate','素材生成']]
  return names.find(([part]) => path.includes(part))?.[1] || '模型处理'
}
function projectId(request: FastifyRequest) {
  const params = request.params as { id?: string } | undefined
  return request.routeOptions.url?.startsWith('/api/projects/:id/') ? params?.id : undefined
}
/** Check runtime ownership too: historical running rows after restart must
 * not permanently lock model settings. Include auxiliary model attempts. */
export function activeModelRequestUsesModel(modelId: string): boolean {
  for (const taskId of active.keys()) {
    if (db.prepare(`SELECT 1 FROM model_request_tasks WHERE id=? AND model_id=?
      UNION ALL SELECT 1 FROM model_request_attempts WHERE task_id=? AND json_extract(metrics,'$.model_id')=? LIMIT 1`)
      .get(taskId, modelId, taskId, modelId)) return true
  }
  return false
}
export function registerModelRequestObservation(app: FastifyInstance, tracer: LangfuseTracer = getLangfuseTracer()) {
  initModelRequestObservation()
  const observations = new WeakMap<FastifyRequest, { observation: ReturnType<typeof createModelRequestObservation>; controller: AbortController; cleanup: () => void }>()
  app.addHook('preHandler', (request, reply, done) => {
    // Durable tasks own their controller. Losing an SSE subscriber must not
    // cancel a server-owned run or finish its usage ledger early.
    if (request.routeOptions.url?.includes('/script/director/tasks/') || request.routeOptions.url?.endsWith('/script/director/chat/stream') && !!(request.body as { task?: unknown } | undefined)?.task) { done(); return }
    const controller = new AbortController()
    const body = request.body as { model_id?: unknown } | undefined
    const observation = createModelRequestObservation({ projectId: projectId(request), modelId: typeof body?.model_id === 'string' ? body.model_id : undefined,
      label: requestLabel(request.routeOptions.url || request.url), owner: 'request', signal: controller.signal }, tracer)
    const abort = () => { if (!reply.raw.writableEnded) { controller.abort(new DOMException('请求已停止；远端计费结果仍以提供商记录为准', 'AbortError')); observation.finish('cancelled'); active.delete(observation.id) } }
    request.raw.once('aborted', abort); reply.raw.once('close', abort)
    active.set(observation.id, controller)
    observations.set(request, { observation, controller, cleanup: () => { request.raw.off('aborted', abort); reply.raw.off('close', abort); active.delete(observation.id) } })
    reply.header('x-model-task-id', observation.id)
    observation.run(done)
  })
  app.addHook('onResponse', (request, reply, done) => {
    const item = observations.get(request)
    if (item) { item.observation.finish(item.controller.signal.aborted ? 'cancelled' : reply.statusCode >= 400 ? 'failed' : 'succeeded'); item.cleanup() }
    done()
  })
  app.addHook('onError', (request, _reply, _error, done) => { const item = observations.get(request); if (item) item.observation.finish(item.controller.signal.aborted ? 'cancelled' : 'failed'); done() })
  app.get('/api/projects/:id/model-requests', async request => {
    const id = (request.params as { id: string }).id
    required<Project>('projects', id)
    return all<{ id: string; model_id: string | null; label: string; owner: Owner; state: string; usage: string; progress: string; created_at: string; updated_at: string }>(
      'SELECT * FROM model_request_tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 50', id).map(row => ({ ...row, usage: JSON.parse(row.usage) as ScriptRequestUsage, progress: JSON.parse(row.progress) as ModelUnitProgress[],
        state: row.state === 'running' && !active.has(row.id) ? 'interrupted' : row.state,
        can_cancel: active.has(row.id), attempts: all<{ id: string; state: string; metrics: string }>('SELECT id,state,metrics FROM model_request_attempts WHERE task_id=? ORDER BY updated_at,id', row.id)
          .map(attempt => ({ ...attempt, metrics: JSON.parse(attempt.metrics) as Record<string, unknown> })) }))
  })
  app.post('/api/projects/:id/model-requests/:taskId/stop', async (request, reply) => {
    const { id, taskId } = request.params as { id: string; taskId: string }
    const row = db.prepare('SELECT project_id,owner FROM model_request_tasks WHERE id=?').get(taskId) as { project_id: string; owner: Owner } | undefined
    if (!row || row.project_id !== id) return reply.code(404).send({ detail: '模型任务不存在' })
    if (row.owner === 'director') return reply.code(409).send({ detail: '请从剧本任务停止当前任务' })
    active.get(taskId)?.abort(new DOMException('本地已停止；远端是否计费仍需核对提供商记录', 'AbortError'))
    return { stopped: true, remote_cancelled: false }
  })
}
