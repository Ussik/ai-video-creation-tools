import { api, json } from '../../shared/api/api'
import type { StoryboardPlanningTask } from '@video-studio/shared/storyboard/storyboard-planning-types'

export type PlanningTaskInput = {
  signature: string; scene_ids: string[]; document_ids: string[]; model_id: string; skill_ids?: string[]
  mode: 'update' | 'redesign'; instructions: string; shots_per_scene?: number; target_duration?: number
  duration_mode?: 'reestimate'; target_video_model_id?: string
}
type RememberedTask = { input: PlanningTaskInput; request_id: string; task_id?: string }
const storageKey = (projectId: string) => `storyboard-planning-task:${projectId}`
const taskPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/script/storyboard/tasks`
const canonicalInput = (input: PlanningTaskInput) => JSON.stringify({
  signature: input.signature, scene_ids: [...input.scene_ids].sort(), document_ids: [...input.document_ids].sort(),
  model_id: input.model_id, skill_ids: input.skill_ids ?? null, mode: input.mode, instructions: input.instructions,
  shots_per_scene: input.shots_per_scene ?? null, target_duration: input.target_duration ?? null,
  duration_mode: input.duration_mode ?? 'preserve', target_video_model_id: input.target_video_model_id ?? null,
})

/** Local storage only remembers how to find server-owned work; it never proves a draft is current. */
export function rememberedPlanningTask(projectId: string, input?: PlanningTaskInput): RememberedTask | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey(projectId)) || 'null') as RememberedTask | null
    if (!value || typeof value.request_id !== 'string' || !value.input || typeof value.input.signature !== 'string'
      || !Array.isArray(value.input.scene_ids) || !value.input.scene_ids.every(id => typeof id === 'string')
      || !Array.isArray(value.input.document_ids) || !value.input.document_ids.every(id => typeof id === 'string')
      || typeof value.input.model_id !== 'string' || typeof value.input.instructions !== 'string'
      || !['update', 'redesign'].includes(value.input.mode)
      || value.input.skill_ids !== undefined && (!Array.isArray(value.input.skill_ids) || !value.input.skill_ids.every(id => typeof id === 'string'))
      || value.task_id !== undefined && typeof value.task_id !== 'string') return null
    return input && canonicalInput(value.input) !== canonicalInput(input) ? null : value
  } catch { return null }
}
function remember(projectId: string, value: RememberedTask) {
  try { window.sessionStorage.setItem(storageKey(projectId), JSON.stringify(value)) } catch { /* The server remains the source of truth. */ }
}
export function forgetPlanningTask(projectId: string) {
  try { window.sessionStorage.removeItem(storageKey(projectId)) } catch { /* Storage is optional. */ }
}
export function rememberObservedPlanningTask(projectId: string, input: PlanningTaskInput, taskId: string) {
  const previous = rememberedPlanningTask(projectId)
  remember(projectId, { input, task_id: taskId, request_id: previous && canonicalInput(previous.input) === canonicalInput(input)
    ? previous.request_id : crypto.randomUUID() })
}
export function lookupPlanningTask(projectId: string, input: PlanningTaskInput, signal?: AbortSignal) {
  return api<{ task: StoryboardPlanningTask | null }>(`${taskPath(projectId)}/lookup`, { ...json('POST', input), signal })
}
export async function startPlanningTask(projectId: string, input: PlanningTaskInput, fresh: boolean, signal: AbortSignal) {
  const previous = rememberedPlanningTask(projectId)
  const request = !fresh && previous && canonicalInput(previous.input) === canonicalInput(input)
    ? previous : { input, request_id: crypto.randomUUID() }
  // Persist before POST: retrying a lost acceptance response must not dispatch another generation.
  remember(projectId, request)
  const task = await api<StoryboardPlanningTask>(taskPath(projectId), {
    ...json('POST', { ...input, request_id: request.request_id, ...(fresh ? { fresh: true } : {}) }), signal,
  })
  remember(projectId, { ...request, task_id: task.id })
  return task
}
export function resumePlanningTask(projectId: string, taskId: string, signal: AbortSignal) {
  return api<StoryboardPlanningTask>(`${taskPath(projectId)}/${encodeURIComponent(taskId)}/resume`, { ...json('POST', {}), signal })
}
export function cancelPlanningTask(projectId: string, taskId: string) {
  return api<StoryboardPlanningTask>(`${taskPath(projectId)}/${encodeURIComponent(taskId)}/cancel`, json('POST', {}))
}
export function cancelPlanningRequest(projectId: string, input: PlanningTaskInput) {
  const saved = rememberedPlanningTask(projectId, input)
  if (!saved) return Promise.resolve({ cancelled: true as const, task: null })
  return api<{ cancelled: true; task: StoryboardPlanningTask | null }>(`${taskPath(projectId)}/cancel-request`, json('POST', { request_id: saved.request_id }))
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Polling failures only repeat GET, never the paid task-start request. */
export async function observePlanningTask(projectId: string, initial: StoryboardPlanningTask, options: {
  signal: AbortSignal; onUpdate: (task: StoryboardPlanningTask) => void; onConnectionChange: (message: string) => void
  intervalMs?: number
}): Promise<StoryboardPlanningTask> {
  let task = initial, failures = 0
  options.signal.throwIfAborted()
  options.onUpdate(task)
  while (task.status === 'running') {
    await pause(Math.min(5000, (options.intervalMs ?? 1500) * (failures + 1)), options.signal)
    try {
      const next = await api<StoryboardPlanningTask>(`${taskPath(projectId)}/${encodeURIComponent(task.id)}`, { signal: options.signal })
      options.signal.throwIfAborted()
      if (next.id !== task.id || next.project_id !== projectId) throw Object.assign(new Error('分镜任务身份不匹配，请重新打开规划。'), { status: 409 })
      task = next; failures = 0; options.onConnectionChange(''); options.onUpdate(task)
    } catch (issue) {
      options.signal.throwIfAborted()
      const status = (issue as { status?: number })?.status
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) throw issue
      failures++
      options.onConnectionChange('暂时无法连接，正在重新连接。后台任务会继续，已保存的草稿仍可恢复。')
    }
  }
  return task
}

export const planningTaskStageLabel: Record<StoryboardPlanningTask['stage'], string> = {
  preparing: '正在准备规划资料', generating: '正在生成分镜草稿', reviewing: '正在复核运镜与接镜',
  repairing: '正在修订分镜', rechecking: '正在复查修订结果', completed: '分镜规划已完成',
}
export function planningTaskProgressLabel(task: StoryboardPlanningTask): string {
  if (task.outline_checkpoint) {
    const scenes = task.outline_checkpoint.scenes
    return `已保留大纲 ${scenes.reduce((sum, scene) => sum + scene.shot_count, 0)} 镜 · 镜头合计 ${scenes.reduce((sum, scene) => sum + scene.shot_duration_sum, 0)} 秒 / 目标 ${scenes.reduce((sum, scene) => sum + scene.scene_duration, 0)} 秒 · ${task.outline_checkpoint.validated ? '大纲已校验' : '待校验恢复'}${task.progress?.phase === 'shots' ? ` · 已扩写 ${task.progress.completed_shots} / ${task.progress.total_shots} 镜` : ' · 尚未完成扩写'}`
  }
  if (!task.progress) return ''
  if (task.progress.phase === 'outline') return '正在设计镜头大纲'
  const location = task.progress.current_scene_id
    ? ` · 当前场次 ${task.progress.current_scene_id}${task.progress.current_shot_index === undefined ? '' : ` · 第 ${task.progress.current_shot_index + 1} 镜`}`
    : ''
  const recovery = task.progress.recovery === 'automatic' ? ' · 自动恢复中'
    : task.progress.recovery === 'manual_review' ? ' · 等待人工处理' : ''
  return `已完成 ${task.progress.completed_shots} / ${task.progress.total_shots} 镜${location}${recovery}`
}
export function planningTaskFailure(task: StoryboardPlanningTask): string {
  const stage = planningTaskStageLabel[task.error?.stage || task.stage].replace(/^正在/, '')
  const failureLabels: Record<string, string> = {
    invalid_json: 'JSON 无效', invalid_schema: '结构不符合契约', invalid_business: '业务校验失败', invalid_citation: '引用无效',
    dialogue_source_mismatch: '台词原文引用不匹配', dialogue_ref_wrong_scene: '台词引用跨场次', dialogue_ref_ambiguous: '台词引用存在歧义', dialogue_source_correction_contract: '台词纠正返回结构不符合契约', timing_mismatch: '场次时长与镜头合计不一致', timing_repair_contract: '时长校正返回结构不符合契约',
    transport: '连接或流式响应中断', budget_exhausted: '恢复预算耗尽', identity_conflict: '任务身份冲突', unknown: '未知错误',
  }
  const kind = task.error?.failure_type ? `【${failureLabels[task.error.failure_type] || task.error.failure_type}】` : ''
  const timing = task.error?.failure_type === 'timing_mismatch' && typeof task.error.scene_duration === 'number' && typeof task.error.shot_duration_sum === 'number' && typeof task.error.delta === 'number'
    ? `本场 ${task.error.scene_duration} 秒，镜头合计 ${task.error.shot_duration_sum} 秒，${task.error.delta > 0 ? `少 ${task.error.delta} 秒` : `多 ${Math.abs(task.error.delta)} 秒`}` : ''
  const reason = `${kind}${timing || task.error?.message || (task.status === 'cancelled' ? '任务已取消' : '任务已中断')}`
  const location = [task.error?.scene_id && `场次 ${task.error.scene_id}`, task.error?.shot_id && `镜头 ${task.error.shot_id}`,
    task.error?.field_path && `字段 ${task.error.field_path}`, task.error?.ref_id && `引用 ${task.error.ref_id}`].filter(Boolean).join(' · ')
  const recovery = task.can_resume ? task.progress && task.progress.completed_shots > 0 ? '已完成的镜头已保存，继续时从未完成部分重试。'
    : task.candidate ? '分镜草稿已保存，可继续完成剩余步骤。' : task.outline_checkpoint ? '大纲已保留，继续时校验并恢复该大纲，不重新生成。' : '可继续重试当前步骤。'
    : task.recovery_budget === 0 ? '自动恢复预算已耗尽，请人工处理或重新规划。'
    : task.candidate ? '分镜草稿已保存供查看，请重新规划。' : '请更新规划资料后重新规划。'
  return `${stage}未完成：${reason}${location ? `（定位：${location}）` : ''}。${recovery}`
}
