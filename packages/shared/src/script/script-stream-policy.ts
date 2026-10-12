// Shared by the server and browser. Heartbeats distinguish a slow model from
// a dead connection; the total deadline bounds multiple model/tool rounds.
export const directorStreamHeartbeatMs = 15_000
export const directorStreamIdleTimeoutMs = 3 * 60_000
export const textRequestTimeoutMs = 20 * 60_000
export const directorStreamTotalTimeoutMs = 30 * 60_000

export class StreamWaitTimeoutError extends Error {
  constructor(public readonly kind: 'idle' | 'total', message: string) {
    super(message)
    this.name = 'StreamWaitTimeoutError'
  }
}

export function createStreamScope(parent?: AbortSignal, options: { totalMs?: number; idleMs?: number; totalMessage?: string } = {}) {
  const controller = new AbortController()
  const signal = controller.signal
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const abortParent = () => controller.abort(parent!.reason)
  if (parent?.aborted) abortParent()
  else parent?.addEventListener('abort', abortParent, { once: true })
  const totalTimer = setTimeout(() => controller.abort(new StreamWaitTimeoutError('total', options.totalMessage
    || `本轮对话处理超时（最长 ${Math.round(directorStreamTotalTimeoutMs / 60_000)} 分钟）。请检查草稿和已保存文档后重试。`)), options.totalMs ?? directorStreamTotalTimeoutMs)
  ;(totalTimer as unknown as { unref?: () => void }).unref?.()
  function touch() {
    if (!options.idleMs || closed || signal.aborted) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new StreamWaitTimeoutError('idle',
      `对话连接已中断：连续 ${Math.round(options.idleMs! / 1000)} 秒未收到服务响应。请检查后端服务，并检查草稿后重试。`)), options.idleMs)
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
