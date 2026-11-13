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
  if (!task.progress) return ''
  return task.progress.phase === 'outline' ? '正在设计镜头大纲'
    : `已完成 ${task.progress.completed_shots} / ${task.progress.total_shots} 镜`
}
export function planningTaskFailure(task: StoryboardPlanningTask): string {
  const stage = planningTaskStageLabel[task.error?.stage || task.stage].replace(/^正在/, '')
  const reason = task.error?.message || (task.status === 'cancelled' ? '任务已取消' : '任务已中断')
  const recovery = task.can_resume ? task.progress && task.progress.completed_shots > 0 ? '已完成的镜头已保存，继续时从未完成部分重试。'
    : task.candidate ? '分镜草稿已保存，可继续完成剩余步骤。' : '可继续重试当前步骤。'
    : task.candidate ? '分镜草稿已保存供查看，请重新规划。' : '请更新规划资料后重新规划。'
  return `${stage}未完成：${reason}。${recovery}`
}
