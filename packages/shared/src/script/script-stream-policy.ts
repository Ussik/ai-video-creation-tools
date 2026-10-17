// Shared by the server and browser. Heartbeats distinguish a slow model from
// a dead connection; the total deadline bounds multiple model/tool rounds.
export const directorStreamHeartbeatMs = 15_000
export const directorStreamIdleTimeoutMs = 60_000
export const textStreamIdleTimeoutMs = 5 * 60_000
export const textReasoningIdleTimeoutMs = 10 * 60_000
export const textRequestTimeoutMs = 30 * 60_000
export const directorTaskSoftTimeoutMs = 120 * 60_000
export const directorStreamTotalTimeoutMs = 180 * 60_000
export const generationStepBudgets = {
  discussion: 5 * 60_000, reading: 15 * 60_000, evidence: 10 * 60_000,
  synthesis: 20 * 60_000, generation: 30 * 60_000, review: 20 * 60_000,
} as const
export const maxModelStepAttempts = 3

export function directorReconnectDelay(attempt: number, random = Math.random()) {
  return Math.round(Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, attempt - 1))) * (0.75 + random * 0.5))
}

export class StreamWaitTimeoutError extends Error {
  constructor(public readonly kind: 'idle' | 'total', message: string) {
    super(message)
    this.name = 'StreamWaitTimeoutError'
  }
}

export function createStreamScope(parent?: AbortSignal, options: { totalMs?: number | null; idleMs?: number; totalMessage?: string; idleMessage?: string } = {}) {
  const controller = new AbortController()
  const signal = controller.signal
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const abortParent = () => controller.abort(parent!.reason)
  if (parent?.aborted) abortParent()
  else parent?.addEventListener('abort', abortParent, { once: true })
  const totalTimer = options.totalMs === null ? undefined : setTimeout(() => controller.abort(new StreamWaitTimeoutError('total', options.totalMessage
    || `本轮对话处理超时（最长 ${Math.round((options.totalMs ?? directorStreamTotalTimeoutMs) / 60_000)} 分钟）。请检查草稿和已保存文档后重试。`)), options.totalMs ?? directorStreamTotalTimeoutMs)
  ;(totalTimer as unknown as { unref?: () => void } | undefined)?.unref?.()
  function touch() {
    if (!options.idleMs || closed || signal.aborted) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new StreamWaitTimeoutError('idle',
      options.idleMessage || `连续 ${Math.round(options.idleMs! / 1000)} 秒未收到服务事件，正在重新连接当前任务。`)), options.idleMs)
    ;(idleTimer as unknown as { unref?: () => void }).unref?.()
  }
  touch()
  return {
    signal, touch,
    wait<T>(work: Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
        if (signal.aborted) { void work.catch(() => {}); reject(signal.reason); return }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        }, issue => {
          signal.removeEventListener('abort', abort)
          reject(signal.aborted ? signal.reason : issue)
        })
      })
    },
    close() {
      closed = true
      clearTimeout(totalTimer); clearTimeout(idleTimer)
      parent?.removeEventListener('abort', abortParent)
    },
  }
}
