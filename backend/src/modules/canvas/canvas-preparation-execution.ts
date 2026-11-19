import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { currentModelRequestContext } from '../generation/model-task-policy.js'

const instance = randomUUID(), host = hostname()
export type CanvasExecution = { instance: string; host: string; pid: number; started_at: string; heartbeat_at: string; task_id?: string; cancel_requested?: boolean }
export function canvasExecution(): CanvasExecution {
  const time = new Date().toISOString()
  return { instance, host, pid: process.pid, started_at: time, heartbeat_at: time, task_id: currentModelRequestContext()?.taskId }
}
/** Heartbeat age never grants takeover. A live foreign process is fenced until
 * it exits; EPERM and another host are conservatively treated as live. */
export function canvasExternalExecutor(execution?: CanvasExecution): boolean {
  if (!execution || execution.instance === instance) return false
  if (execution.host !== host) return true
  try { process.kill(execution.pid, 0); return true }
  catch (issue) { return (issue as NodeJS.ErrnoException).code !== 'ESRCH' }
}
