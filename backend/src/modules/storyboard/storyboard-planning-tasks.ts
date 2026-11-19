import { generationScopeVersion } from '../generation/generation-scope-lifecycle.js'
import { storyboardOutlineExecution } from './storyboard-outline-execution.js'
import { z } from 'zod'
import { now, one, run } from '../../infrastructure/database/db.js'
import { withDetachedTextRequestUsage } from '../../infrastructure/providers/text-request-usage.js'
import { runStoryboardPlanningBudget, storyboardPlanningBudgetKey, StoryboardPlanningBudgetError } from './storyboard-planning-budget.js'
import { observeModelTask } from '../generation/model-request-observation.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from '../generation/model-task-policy.js'
import type { StoryboardFailureType, StoryboardPlanningProgress, StoryboardPlanningResult, StoryboardPlanningStage, StoryboardPlanningTask } from '@video-studio/shared/storyboard/storyboard-planning-types'

const prefix = 'storyboard-planning-task:'
const cancellationNamespace = (requestId: string) => `${prefix}cancel-request:${requestId}`
const statuses = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const
const stages = ['preparing', 'generating', 'reviewing', 'repairing', 'rechecking', 'completed'] as const
const progressSchema = z.object({ phase: z.enum(['outline', 'shots']), completed_shots: z.number().int().min(0),
  total_shots: z.number().int().min(0), current_scene_id: z.string().min(1).max(120).optional(),
  current_shot_index: z.number().int().min(0).max(1000).optional(), recovery: z.enum(['none', 'automatic', 'manual_review']).default('none') }).strict().refine(value => value.completed_shots <= value.total_shots,
  '已完成镜头数不能超过总镜头数')
const recordSchema = z.object({ version: z.literal(1), input: z.unknown(), request_ids: z.array(z.uuid()),
  snapshot: z.object({ id: z.uuid(), project_id: z.string(), input_key: z.string().length(64), status: z.enum(statuses),
    stage: z.enum(stages), started_at: z.number(), updated_at: z.number(), active_duration_ms: z.number(),
    stage_duration_ms: z.number(), timings: z.record(z.string(), z.number()), can_resume: z.boolean(),
    attempt: z.number().int().min(0).default(0), recovery_budget: z.number().int().min(0).default(3), checkpoint_version: z.number().int().min(1).default(1),
    progress: progressSchema.optional(), candidate: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough(),
  steps: z.record(z.string(), z.unknown()),
})
type RecordState = { version: 1; input: unknown; request_ids: string[]; snapshot: StoryboardPlanningTask; steps: Record<string, unknown> }
type Running = { state: RecordState; controller: AbortController; phaseStarted: number; promise: Promise<void>; background: boolean;
  timer?: ReturnType<typeof setInterval> }
// Shared across route registrations: sync and background callers cannot issue
// duplicate paid work even when multiple Fastify instances share this process.
const running = new Map<string, Running>()
const taskKey = (projectId: string, id: string) => `${projectId}:${id}`
const problem = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }) }
const legacyStructuralBoundaryFailure = (issue: unknown) => !!issue && typeof issue === 'object' && 'message' in issue &&
  typeof issue.message === 'string' && issue.message.includes('定向修复改变了授权目标之外的字段，结果未采用')
const stoppedStructuralCorrection = (issue: unknown) => legacyStructuralBoundaryFailure(issue) || !!issue && typeof issue === 'object' &&
  'code' in issue && typeof issue.code === 'string' && /^structural_(?:patch_|schema_|validator_|business_|boundary_)/.test(issue.code)
function failureType(issue: unknown): StoryboardFailureType {
  const value = issue as { code?: string; upstreamCode?: string; statusCode?: number; retryable?: boolean }
  const code = String(value?.code || value?.upstreamCode || '')
  if (['dialogue_source_mismatch', 'dialogue_ref_wrong_scene', 'dialogue_ref_ambiguous', 'dialogue_source_correction_contract', 'timing_mismatch', 'timing_repair_contract'].includes(code)) return code as StoryboardFailureType
  if (code === 'storyboard_review_invalid' || legacyStructuralBoundaryFailure(issue)) return 'invalid_business'
  if (/json|syntax/i.test(code)) return 'invalid_json'
  if (/contract|schema|field/i.test(code)) return 'invalid_schema'
  if (/citation|evidence|ref/i.test(code)) return 'invalid_citation'
  if (/business|continuity|source|scene|shot|outline/i.test(code) || value?.statusCode === 422 && value?.retryable === false) return 'invalid_business'
  if (/budget|timeout/i.test(code) || value?.statusCode === 429) return 'budget_exhausted'
  if (value?.statusCode === 409) return 'identity_conflict'
  if (value?.retryable === true || /transport|stream|upstream|network|disconnect/i.test(code)) return 'transport'
  return 'unknown'
}
export type StoryboardPlanningControl = {
  signal: AbortSignal
  steps: Record<string, unknown>
  stage(stage: StoryboardPlanningStage): void
  retain(key: string, value: unknown, candidate?: StoryboardPlanningResult): void
  progress?(value: StoryboardPlanningProgress): void
}
type Options = {
  identity(projectId: string, input: unknown): string
  execute(projectId: string, input: unknown, control: StoryboardPlanningControl): Promise<StoryboardPlanningResult>
}
function findInput(projectId: string, key: string): RecordState | null {
  const row = one<{ payload: string }>(`SELECT payload FROM script_step_checkpoints
    WHERE project_id=? AND namespace LIKE ? AND cache_key=? ORDER BY updated_at DESC LIMIT 1`, projectId, `${prefix}%`, key)
  return row ? parse(row.payload) : null
}
function findRequest(projectId: string, requestId: string): RecordState | null {
  if(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purged_resource_ids'")&&one("SELECT 1 FROM purged_resource_ids WHERE project_id=? AND kind='storyboard_request' AND id=?",projectId,requestId))problem('原请求所属分镜已彻底删除，不能重放或恢复',410)
  // Filter inside SQLite: loading every historical prompt/plan into JavaScript
  // makes even an idempotency lookup slower as the project grows.
  const row = one<{ payload: string }>(`SELECT payload FROM script_step_checkpoints
    WHERE project_id=? AND namespace LIKE ? AND json_valid(payload)
    AND EXISTS(SELECT 1 FROM json_each(payload,'$.request_ids') WHERE value=?) LIMIT 1`, projectId, `${prefix}%`, requestId)
  return row ? parse(row.payload) : null
}
function cancellationRequested(projectId: string, requestId: string) {
  return !!one('SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, cancellationNamespace(requestId))
}
function parse(raw: string): RecordState | null {
  try { return recordSchema.parse(JSON.parse(raw)) as RecordState } catch { return null }
}
function persist(state: RecordState) {
  if(generationScopeVersion(state.snapshot.project_id,prefix+state.snapshot.id))problem('原分镜已彻底删除，此规划任务不能恢复或写回',410)
  run(`INSERT INTO script_step_checkpoints(project_id,namespace,cache_key,payload,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at`,
  state.snapshot.project_id, prefix + state.snapshot.id, state.snapshot.input_key, JSON.stringify(state), now())
}
function read(projectId: string, id: string): RecordState {
  if(generationScopeVersion(projectId,prefix+id))problem('原分镜已彻底删除，此规划任务不能恢复',410)
  const live = running.get(taskKey(projectId, id))
  if (live) return live.state
  const row = one<{ payload: string }>('SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, prefix + id)
  const state = row && parse(row.payload)
  if (!state || state.snapshot.project_id !== projectId || state.snapshot.id !== id) return problem('分镜规划任务不存在或断点无法校验', 404)
  if (state.snapshot.status === 'running') {
    state.snapshot.status = 'interrupted'; state.snapshot.can_resume = true
    state.snapshot.error = { message: '服务已重启，任务已中断；已验证草稿仍保留，请继续未完成阶段。', stage: state.snapshot.stage }
    state.snapshot.updated_at = Date.now(); persist(state)
  }
  return state
}
function snapshot(state: RecordState): StoryboardPlanningTask {
  const result = structuredClone(state.snapshot)
  // Historical errors had no stage/code or retained answer. Do not infer a culprit or buy a fresh outline.
  if (result.error && legacyStructuralBoundaryFailure(result.error)) {
    result.error.failure_type = 'invalid_business'
    result.error.code ||= 'structural_boundary_unattributed'
  }
  if (stoppedStructuralCorrection(result.error)) result.can_resume = false
  // Derive from durable steps on every read, including legacy failed tasks
  // whose progress was recorded as 0/0. Never promote an outline to candidate.
  const outlineExecution = state.snapshot.progress?.phase === 'shots' ? undefined : storyboardOutlineExecution(state.steps)
  if (!result.result && !result.candidate && (['generating', 'repairing'].includes(result.stage) || outlineExecution)) {
    const namespace = outlineExecution?.outlineKey.split(':')[2] || (result.stage === 'repairing' ? 'repair' : 'initial')
    const entries = Object.entries(state.steps).filter(([key]) => key.startsWith(`storyboard_batches:v1:${namespace}:`)
      && /:outline(?::unvalidated|:candidate)?$/.test(key))
    const latest = (outlineExecution?.outlineKey || entries.at(-1)?.[0])?.replace(/:outline(?::unvalidated|:candidate)?$/, ':outline')
    if (latest) {
      const key = Object.hasOwn(state.steps, latest) ? latest : Object.hasOwn(state.steps, latest + ':unvalidated') ? latest + ':unvalidated' : latest + ':candidate'
      const parsed = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number().finite().positive(),
        shots: z.array(z.object({ duration: z.number().finite().positive() })).min(1) })).min(1) }).safeParse(state.steps[key])
      if (parsed.success) result.outline_checkpoint = { validated: key === latest,
        ...(outlineExecution ? { stage: outlineExecution.stage, delivery_pending: outlineExecution.delivery_pending } : {}), scenes: parsed.data.scenes.map(scene => ({
        scene_id: scene.scene_id, shot_count: scene.shots.length, scene_duration: scene.scene_duration,
        shot_duration_sum: scene.shots.reduce((sum, shot) => sum + shot.duration, 0),
      })) }
    }
  }
  if (result.outline_checkpoint && outlineExecution && result.progress?.phase !== 'shots') {
    if (result.stage !== outlineExecution.stage) result.stage_duration_ms = result.timings[outlineExecution.stage] || 0
    result.stage = outlineExecution.stage
    if (result.error) result.error.stage = outlineExecution.stage
    if (outlineExecution.delivery_pending && result.status !== 'running') result.can_resume = false
  }
  const live = running.get(taskKey(result.project_id, result.id))
  if (live && result.status === 'running') {
    const elapsed = Math.max(0, Date.now() - live.phaseStarted)
    result.active_duration_ms += elapsed
    result.stage_duration_ms = (result.timings[result.stage] || 0) + elapsed
    result.timings[result.stage] = result.stage_duration_ms
  }
  return result
}
function settleTime(live: Running) {
  const elapsed = Math.max(0, Date.now() - live.phaseStarted), state = live.state.snapshot
  state.active_duration_ms += elapsed; state.timings[state.stage] = (state.timings[state.stage] || 0) + elapsed
  state.stage_duration_ms = state.timings[state.stage] || 0; live.phaseStarted = Date.now()
}

/** Private planning work survives browser connections; only explicit cancel
 * stops it. Restarted requests never dispatch until the creator resumes. */
export function createStoryboardPlanningTasks(options: Options) {
  const owned = new Set<string>()
  let closing = false
  function assertIdentity(state: RecordState) {
    if (options.identity(state.snapshot.project_id, state.input) !== state.snapshot.input_key) problem('规划资料、模型或技能配置已更新，不能继续旧任务，请重新规划')
  }
  function launch(state: RecordState, background: boolean, explicitResume = false) {
    if (closing) problem('服务正在关闭，请稍后继续', 503)
    const key = taskKey(state.snapshot.project_id, state.snapshot.id)
    const live: Running = { state, controller: new AbortController(), phaseStarted: Date.now(), background, promise: Promise.resolve() }
    state.snapshot.status = 'running'; state.snapshot.can_resume = false
    state.snapshot.attempt = (state.snapshot.attempt || 0) + (explicitResume ? 1 : 0)
    delete state.snapshot.error
    state.snapshot.updated_at = Date.now(); persist(state); running.set(key, live); owned.add(key)
    let launchActive = true
    const save = () => { if (!launchActive) return; state.snapshot.updated_at = Date.now(); persist(state) }
    live.timer = setInterval(() => { settleTime(live); save() }, 15_000)
    live.timer.unref()
    const control: StoryboardPlanningControl = { signal: live.controller.signal, steps: state.steps,
      stage(stage) { control.signal.throwIfAborted(); assertIdentity(state); settleTime(live)
        if (state.snapshot.stage !== stage || stage !== 'generating' && stage !== 'repairing') delete state.snapshot.progress
        state.snapshot.stage = stage; state.snapshot.stage_duration_ms = state.snapshot.timings[stage] || 0; save() },
      retain(name, value, candidate) { control.signal.throwIfAborted(); assertIdentity(state); state.steps[name] = value;
        if (candidate) state.snapshot.candidate = candidate; save() },
      progress(value) { control.signal.throwIfAborted(); assertIdentity(state)
        state.snapshot.progress = progressSchema.parse(value); save() },
    }
    live.promise = (async () => {
      try {
        assertIdentity(state)
        // The durable run owns its lifetime. Retain its inherited policy while
        // detaching the HTTP subscriber's identity, callbacks, abort signal
        // and usage ledger. Its admission/resume request owns no model calls.
        const policy = currentModelRequestContext()?.policy || modelTaskPolicies.generation
        const legacy = !(storyboardPlanningBudgetKey in state.steps)
          ? one<{ usage: string }>('SELECT usage FROM model_request_tasks WHERE id=?', `storyboard:${state.snapshot.id}`) : undefined
        let legacyUsage: unknown
        if (legacy) {
          try { legacyUsage = JSON.parse(legacy.usage) }
          catch { throw Object.assign(new Error('分镜规划历史用量记录损坏，不能清空后重新派发，请重新规划。'), { statusCode: 409 }) }
        }
        const result = await withDetachedTextRequestUsage(() => runStoryboardPlanningBudget({ input: state.input, steps: state.steps,
          activeDurationMs: state.snapshot.active_duration_ms, signal: live.controller.signal, persist: save, explicitResume, legacyUsage }, signal => {
          control.signal = signal
          return withModelRequestContext({ policy, signal }, () =>
            observeModelTask({ taskId: `storyboard:${state.snapshot.id}`, projectId: state.snapshot.project_id,
              label: '分镜规划', owner: 'request', signal, policy },
            () => options.execute(state.snapshot.project_id, state.input, control)))
        }))
        live.controller.signal.throwIfAborted(); assertIdentity(state); settleTime(live)
        state.snapshot.stage = 'completed'; state.snapshot.stage_duration_ms = 0
        state.snapshot.status = 'succeeded'; state.snapshot.can_resume = false
        state.snapshot.result = result; delete state.snapshot.candidate; delete state.snapshot.progress
        // Retain local review audit and original responses after success.
        // Other intermediate rules/plans can be released once no paid work remains.
        if (!['needs_work', 'inconclusive', 'review_inconclusive_needs_user', 'pending_review'].includes(result.directing_review?.status || '')) {
          state.steps = { [storyboardPlanningBudgetKey]: state.steps[storyboardPlanningBudgetKey],
            ...Object.fromEntries(Object.entries(state.steps).filter(([key]) => /:quality:v1:.*:(?:report|recheck|repair)(?::(?:relation_rejected|relation_correction|structured_output:v1))?$/.test(key))) }
        }
      } catch (issue) {
        settleTime(live)
        if (state.snapshot.status !== 'interrupted') state.snapshot.status = live.controller.signal.aborted ? 'cancelled' : 'failed'
        const error = issue as { message?: string; code?: string; upstreamCode?: string; retryable?: boolean; diagnostics?: string; raw_output?: string; statusCode?: number; scene_id?: string; field_path?: string; ref_id?: string; shot_id?: string; related_scene_id?: string | null; related_shot_index?: number | null; correction_error_code?: string; scene_duration?: number; shot_duration_sum?: number; delta?: number }
        const type = failureType(issue)
        if (type !== 'identity_conflict') state.snapshot.recovery_budget = Math.max(0, (state.snapshot.recovery_budget ?? 3) - 1)
        state.snapshot.error = { message: error?.message || String(issue), stage: state.snapshot.stage, failure_type: type,
          attempt: state.snapshot.attempt, recovery_budget: state.snapshot.recovery_budget,
          ...(error?.code || error?.upstreamCode ? { code: error.code || error.upstreamCode } : {}),
          ...(error?.correction_error_code ? { correction_error_code: error.correction_error_code } : {}),
          ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
          ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}), ...(error?.raw_output ? { raw_output: error.raw_output } : {}),
          ...(error?.scene_id ? { scene_id: error.scene_id } : {}), ...(error?.field_path ? { field_path: error.field_path } : {}),
          ...(error?.ref_id ? { ref_id: error.ref_id } : {}), ...(error?.shot_id ? { shot_id: error.shot_id } : {}),
          ...(error?.related_scene_id !== undefined ? { related_scene_id: error.related_scene_id } : {}),
          ...(error?.related_shot_index !== undefined ? { related_shot_index: error.related_shot_index } : {}),
          ...(typeof error?.scene_duration === 'number' ? { scene_duration: error.scene_duration } : {}),
          ...(typeof error?.shot_duration_sum === 'number' ? { shot_duration_sum: error.shot_duration_sum } : {}),
          ...(typeof error?.delta === 'number' ? { delta: error.delta } : {}),
          ...(error?.statusCode ? { status_code: error.statusCode } : {}) }
        state.snapshot.can_resume = issue instanceof StoryboardPlanningBudgetError ? issue.canResume
          : (state.snapshot.recovery_budget ?? 0) > 0 && error?.statusCode !== 409 && !('revised_report' in state.steps)
            && !/^storyboard_outline_(?:relation|evidence)_correction_(?:failed|exhausted)$/.test(error?.code || '')
            && !stoppedStructuralCorrection(error)
      } finally {
        clearInterval(live.timer); live.controller.abort(); save(); launchActive = false
        if (running.get(key) === live) { running.delete(key); owned.delete(key) }
      }
    })()
  }
  function active(projectId: string) { return [...running.values()].find(live => live.state.snapshot.project_id === projectId) }
  return {
    read(projectId: string, id: string) {
      let state: RecordState
      try { state = read(projectId, id) }
      catch (issue) {
        if ((issue as { statusCode?: number }).statusCode !== 404) throw issue
        const accepted = findRequest(projectId, id)
        if (!accepted) throw issue
        state = read(projectId, accepted.snapshot.id)
      }
      assertIdentity(state)
      return snapshot(state)
    },
    lookup(projectId: string, input: unknown) {
      const key = options.identity(projectId, input)
      const found = findInput(projectId, key)
      return found ? snapshot(read(projectId, found.snapshot.id)) : null
    },
    start(projectId: string, input: unknown, requestId: string, optionsInput: { fresh?: boolean; background?: boolean } = {}) {
      if (cancellationRequested(projectId, requestId)) problem('这次规划请求已取消，不会调用模型；如需重新规划，请重新开始')
      const key = options.identity(projectId, input), previous = findRequest(projectId, requestId)
      if (previous) {
        if (previous.snapshot.input_key !== key) problem('规划请求 ID 已用于另一组资料或设置，请重新开始')
        return snapshot(read(projectId, previous.snapshot.id))
      }
      const live = active(projectId)
      if (live) {
        if (live.state.snapshot.input_key !== key) problem('当前项目还有分镜规划任务正在运行，请先查看或停止它')
        live.background ||= optionsInput.background !== false; live.state.request_ids.push(requestId); persist(live.state)
        return snapshot(live.state)
      }
      if (!optionsInput.fresh) {
        const found = findInput(projectId, key)
        if (found) { found.request_ids.push(requestId); persist(found); return snapshot(read(projectId, found.snapshot.id)) }
      }
      const state: RecordState = { version: 1, input, request_ids: [requestId], steps: {}, snapshot: { id: requestId, project_id: projectId, input_key: key,
        status: 'running', stage: 'preparing', started_at: Date.now(), updated_at: Date.now(), active_duration_ms: 0,
        stage_duration_ms: 0, timings: {}, can_resume: false, attempt: 0, recovery_budget: 3, checkpoint_version: 1 } }
      launch(state, optionsInput.background !== false)
      return snapshot(state)
    },
    resume(projectId: string, id: string) {
      const state = read(projectId, id); assertIdentity(state)
      if (state.snapshot.status === 'running' || state.snapshot.status === 'succeeded') return snapshot(state)
      if (storyboardOutlineExecution(state.steps)?.delivery_pending) problem('大纲请求交付状态尚未确认，检查点已保留；不会自动重发。')
      if (stoppedStructuralCorrection(state.snapshot.error)) problem('本次结构纠正已停止；不能继续派发或从头生成。已保存的原回答和补丁仍保留供本地检查。')
      if (!state.snapshot.can_resume || (state.snapshot.recovery_budget ?? 0) <= 0) problem('自动恢复预算已耗尽，请重新规划或进入人工处理')
      if (active(projectId)) problem('当前项目还有分镜规划任务正在运行，请先查看或停止它')
      launch(state, true, true); return snapshot(state)
    },
    async cancel(projectId: string, id: string, synchronousOnly = false) {
      const state = read(projectId, id), live = running.get(taskKey(projectId, id))
      if (live && (!synchronousOnly || !live.background)) {
        live.controller.abort(Object.assign(new Error('分镜规划已取消，已验证草稿保留，可继续未完成阶段。'), { statusCode: 499 }))
        await live.promise
      }
      return snapshot(state)
    },
    async cancelRequest(projectId: string, requestId: string) {
      // Persist before looking for acceptance. A delayed POST bearing this ID
      // must stay cancelled even when its response was lost or arrives later.
      run(`INSERT INTO script_step_checkpoints(project_id,namespace,cache_key,payload,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(project_id,namespace) DO NOTHING`, projectId, cancellationNamespace(requestId), requestId,
      JSON.stringify({ version: 1, cancelled_request: requestId }), now())
      const found = findRequest(projectId, requestId)
      if (!found) return { cancelled: true as const, task: null }
      const state = read(projectId, found.snapshot.id), live = running.get(taskKey(projectId, state.snapshot.id))
      if (live) {
        live.controller.abort(Object.assign(new Error('分镜规划已取消，已验证草稿保留，可继续未完成阶段。'), { statusCode: 499 }))
        await live.promise
      }
      return { cancelled: true as const, task: snapshot(state) }
    },
    async wait(projectId: string, id: string): Promise<StoryboardPlanningResult> {
      const live = running.get(taskKey(projectId, id)); if (live) await live.promise
      const value = snapshot(read(projectId, id))
      if (value.status === 'succeeded' && value.result) return value.result
      throw Object.assign(new Error(value.error?.message || '分镜规划未完成'), { statusCode: value.error?.status_code || 502,
        ...value.error, raw_output: value.error?.raw_output, diagnostics: value.error?.diagnostics })
    },
    async close() {
      closing = true
      await Promise.all([...owned].map(async key => {
        const live = running.get(key); if (!live) return
        live.state.snapshot.status = 'interrupted'
        live.controller.abort(new Error('服务已关闭，已验证草稿保留，请继续未完成阶段。'))
        await live.promise
      }))
    },
  }
}
