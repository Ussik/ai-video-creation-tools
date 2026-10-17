import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export type BackgroundResponse = { id?: string; state: 'creating' | 'accepted'; sequence?: number }
type Recovery = { read: (key: string) => BackgroundResponse | undefined; save: (key: string, value?: BackgroundResponse) => void }
const recovery = new AsyncLocalStorage<Recovery>()
export function withTextResponseRecovery<T>(store: Recovery, work: () => T): T { return recovery.run(store, work) }
export const hasTextResponseRecovery = () => !!recovery.getStore()

/** Explicit capability opt-in only. Query the accepted response after a lost
 * connection/restart. Unknown POST outcomes are never blindly submitted again.
 * Polling deliberately avoids depending on a provider's stream cursor support. */
export async function backgroundTextResponse(url: string, body: Record<string, unknown>, headers: Record<string, string>,
  signal: AbortSignal, wait: <T>(value: Promise<T>) => Promise<T>, touch: () => void): Promise<Response> {
  const store = recovery.getStore()!
  const requestBody = { ...body, stream: false, background: true }
  const key = createHash('sha256').update(JSON.stringify([url, requestBody])).digest('hex')
  let saved = store.read(key)
  if (saved && !saved.id) throw new Error('上次后台请求是否被接受尚不确定，已停止自动重发以避免重复生成。请核对提供商记录后重新发起。')
  if (!saved) {
    store.save(key, { state: 'creating' })
    const response = await wait(fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody), signal }))
    touch()
    if (!response.ok) { store.save(key); return response }
    const payload = await wait(response.json()) as Record<string, unknown>
    if (typeof payload.id !== 'string' || !/^resp_[a-zA-Z0-9_-]+$/.test(payload.id)) throw new Error('提供商未返回有效的后台响应 ID，请检查后台响应能力配置')
    saved = { state: 'accepted', id: payload.id }
    store.save(key, saved)
    if (!['queued', 'in_progress'].includes(String(payload.status))) {
      if (payload.status !== 'completed') store.save(key)
      return Response.json(payload)
    }
  }
  const responseUrl = `${url.replace(/\/$/, '')}/${encodeURIComponent(saved.id!)}`
  const cancel = () => { if (signal.reason?.name === 'AbortError') void cancelBackgroundTextResponses(url, saved!.id!, headers).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
  for (;;) {
    signal.throwIfAborted()
    const response = await wait(fetch(responseUrl, { headers, signal }))
    touch()
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) throw new Error('后台模型响应已过期或不可查询，已保留本地完成步骤。请核对提供商记录后重新发起未完成步骤。')
      return response
    }
    const payload = await wait(response.json()) as Record<string, unknown>
    if (!['queued', 'in_progress'].includes(String(payload.status))) {
      if (payload.status !== 'completed') store.save(key)
      return Response.json(payload)
    }
    await wait(delay(2000, undefined, { signal }))
  }
  } finally { signal.removeEventListener('abort', cancel) }
}

export async function cancelBackgroundTextResponses(url: string, id: string, headers: Record<string, string>) {
  return fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) })
}
