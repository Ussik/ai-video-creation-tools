import { createHash } from 'node:crypto'
import { TextProviderError, textRetryAfter } from './text-errors.js'

/** A channel may have several model IDs. Coordinate its open generation
 * requests, without imposing a task/request-count quota or replaying work. */
export const modelChannelConcurrency = 4
export const modelChannelAutomaticWaitMs = 60_000
const defaultRateLimitWaitMs = 2000
export function modelChannelIdentity(baseUrl: string, protocol: string, authHeader: string, authValue: string): string {
  const base = new URL(baseUrl)
  return createHash('sha256').update(JSON.stringify([base.origin + base.pathname.replace(/\/+$/, ''), protocol,
    authHeader.toLowerCase(), authValue])).digest('hex')
}

type Waiter = { resolve: (lease: ModelChannelLease) => void; reject: (issue: unknown) => void;
  signal?: AbortSignal; abort?: () => void; cooldownSince?: number }
type Lane = { key: string; active: number; waiting: Waiter[]; cooldownUntil: number; timer?: ReturnType<typeof setTimeout> }
const lanes = new Map<string, Lane>()
export type ModelChannelLease = { response(response: Response): void; failure(issue: unknown): void; release(): void }

function cooldownError(until: number): TextProviderError {
  const remaining = Math.max(0, until - Date.now())
  const issue = new TextProviderError('当前模型渠道正在限流等待，尚未发送本次请求；请在等待结束后继续当前任务。', false, 'channel_cooldown', 429, undefined, remaining)
  issue.delivery = 'not_sent'
  return Object.assign(issue, { code: 'model_retry_wait', retryAt: until })
}
function settle(waiter: Waiter, issue: unknown) {
  waiter.signal?.removeEventListener('abort', waiter.abort!)
  waiter.reject(issue)
}
function lease(lane: Lane): ModelChannelLease {
  let released = false
  return {
    response(response) {
      if (released || response.status !== 429) return
      lane.cooldownUntil = Math.max(lane.cooldownUntil, Date.now() + (textRetryAfter(response.headers.get('retry-after')) ?? defaultRateLimitWaitMs))
      drain(lane)
    },
    failure(issue) {
      if (issue instanceof TextProviderError && issue.upstreamStatus === 429 && lane.cooldownUntil - Date.now() > modelChannelAutomaticWaitMs) {
        Object.assign(issue, { code: 'model_retry_wait', retryAt: lane.cooldownUntil })
      }
    },
    release() {
      if (released) return
      released = true; lane.active--; drain(lane)
    },
  }
}
function drain(lane: Lane) {
  clearTimeout(lane.timer); lane.timer = undefined
  lane.waiting = lane.waiting.filter(waiter => {
    if (!waiter.signal?.aborted) return true
    settle(waiter, waiter.signal.reason); return false
  })
  const now = Date.now(), remaining = lane.cooldownUntil - now
  if (remaining > 0) {
    lane.waiting = lane.waiting.filter(waiter => {
      waiter.cooldownSince ??= now
      if (remaining <= modelChannelAutomaticWaitMs && now - waiter.cooldownSince + remaining <= modelChannelAutomaticWaitMs) return true
      settle(waiter, cooldownError(lane.cooldownUntil)); return false
    })
    // Retain the cooldown even when all callers explicitly hand back control.
    // The timer is shared and unreferenced; no hidden retry is scheduled.
    lane.timer = setTimeout(() => drain(lane), Math.min(remaining, 2_147_483_647))
    if (!lane.waiting.length) (lane.timer as unknown as { unref?: () => void }).unref?.()
    return
  }
  while (lane.active < modelChannelConcurrency && lane.waiting.length) {
    const waiter = lane.waiting.shift()!
    waiter.signal?.removeEventListener('abort', waiter.abort!)
    if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue }
    lane.active++; waiter.resolve(lease(lane))
  }
  if (!lane.active && !lane.waiting.length && lanes.get(lane.key) === lane) lanes.delete(lane.key)
}

/** Queued cancellation removes only that waiter; it never releases a slot
 * belonging to another task. No request is dispatched by this coordinator. */
export async function acquireModelChannel(identity: string, signal?: AbortSignal): Promise<ModelChannelLease> {
  signal?.throwIfAborted()
  let lane = lanes.get(identity)
  if (!lane) { lane = { key: identity, active: 0, waiting: [], cooldownUntil: 0 }; lanes.set(identity, lane) }
  const owned = lane
  return new Promise<ModelChannelLease>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, signal }
    waiter.abort = () => {
      const index = owned.waiting.indexOf(waiter)
      if (index < 0) return
      owned.waiting.splice(index, 1); settle(waiter, signal?.reason); drain(owned)
    }
    signal?.addEventListener('abort', waiter.abort, { once: true })
    owned.waiting.push(waiter); drain(owned)
  })
}
