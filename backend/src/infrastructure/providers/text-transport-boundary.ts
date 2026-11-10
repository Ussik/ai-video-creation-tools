import { TextProviderError } from './text-errors.js'

export const textHeadersTimeoutMs = 2 * 60_000
export const textErrorBodyByteLimit = 64 * 1024
export type TextTransportScope = { signal: AbortSignal; wait<T>(work: Promise<T>): Promise<T> }

/** Transport phases have their own clocks. An SSE heartbeat or idle touch
 * cannot restart the headers or first parsed event deadline. */
export function createTextTransportBoundary(scope: TextTransportScope, options: { headersMs: number; firstEventMs: number; idleMs?: number; autoStart?: boolean }) {
  const controller = new AbortController()
  const signal = AbortSignal.any([scope.signal, controller.signal])
  let phaseTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let firstEvent = false
  let closed = false
  const arm = (kind: 'headers' | 'first_event', milliseconds: number) => {
    clearTimeout(phaseTimer)
    phaseTimer = setTimeout(() => controller.abort(new TextProviderError(kind === 'headers'
      ? '模型接口未及时返回响应头，本次连接已停止；已完成结果保留。'
      : '模型接口未及时返回首个有效事件，本次连接已停止；已完成结果保留。', true, `${kind}_timeout`)), milliseconds)
    ;(phaseTimer as unknown as { unref?: () => void }).unref?.()
  }
  const stop = () => { clearTimeout(phaseTimer); clearTimeout(idleTimer) }
  signal.addEventListener('abort', stop, { once: true })
  if (options.autoStart !== false) arm('headers', options.headersMs)
  return {
    signal, start() { if (!closed && !signal.aborted) arm('headers', options.headersMs) },
    headers() { clearTimeout(phaseTimer); if (!closed && !signal.aborted && !firstEvent) arm('first_event', options.firstEventMs) },
    event() {
      if (closed || signal.aborted) return
      if (!firstEvent) { firstEvent = true; clearTimeout(phaseTimer) }
      if (options.idleMs) {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(new TextProviderError('模型接口长时间没有返回事件，当前步骤已停止，已完成结果保留。', true, 'event_idle_timeout')), options.idleMs)
        ;(idleTimer as unknown as { unref?: () => void }).unref?.()
      }
    },
    wait<T>(work: Promise<T>): Promise<T> {
      return scope.wait(new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
        if (signal.aborted) { void work.catch(() => {}); reject(signal.reason); return }
        signal.addEventListener('abort', abort, { once: true })
        work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value) },
          issue => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : issue) })
      }))
    },
    close() { closed = true; stop(); signal.removeEventListener('abort', stop) },
  }
}

/** Preserve HTTP classification while bounding only its diagnostic error body.
 * Successful prose has no cumulative character limit here. */
export async function readTextErrorBody(response: Response, options: { wait?<T>(work: Promise<T>): Promise<T>; onChunk?: () => void } = {}): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0, truncated = false
  try {
    for (;;) {
      const next = await (options.wait ? options.wait(reader.read()) : reader.read())
      if (next.done) break
      options.onChunk?.()
      const remaining = textErrorBodyByteLimit - bytes
      if (remaining > 0) { const part = next.value.subarray(0, remaining); chunks.push(part); bytes += part.byteLength }
      if (next.value.byteLength > remaining || bytes >= textErrorBodyByteLimit) { truncated = true; break }
    }
    return Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[上游错误详情已按传输边界截断]' : '')
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Ordinary JSON/nonstream prose remains governed by the request scope. */
export async function readTextResponseBody(response: Response, options: { wait<T>(work: Promise<T>): Promise<T>; onChunk?: () => void }): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await options.wait(reader.read())
      if (next.done) break
      options.onChunk?.(); chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
