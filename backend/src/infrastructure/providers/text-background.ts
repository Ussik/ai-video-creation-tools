import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { estimateTextRequestTokens } from './text-context.js'
import { beginTextRequest, settlePendingTextRequest, type TextRequestUsageMetrics } from './text-request-usage.js'

export type BackgroundResponse = { id?: string; state: 'creating' | 'accepted'; sequence?: number }
type Recovery = { read: (key: string) => BackgroundResponse | undefined; save: (key: string, value?: BackgroundResponse) => void }
const recovery = new AsyncLocalStorage<Recovery>()
export function withTextResponseRecovery<T>(store: Recovery, work: () => T): T { return recovery.run(store, work) }
export const hasTextResponseRecovery = () => !!recovery.getStore()

function returnedUsage(payload: Record<string, unknown>): TextRequestUsageMetrics {
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : {}
  const details = (usage.output_tokens_details ?? usage.completion_tokens_details) as Record<string, unknown> | undefined
  const metric = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
  return { input_tokens: metric(usage.input_tokens ?? usage.prompt_tokens),
    output_tokens: metric(usage.output_tokens ?? usage.completion_tokens), reasoning_tokens: metric(details?.reasoning_tokens) }
}

async function failedUsage(response: Response, wait: <T>(value: Promise<T>) => Promise<T>) {
  try { return returnedUsage(await wait(response.clone().json()) as Record<string, unknown>) }
  catch { return {} }
}

/** Explicit capability opt-in only. Query the accepted response after a lost
 * connection/restart. Unknown POST outcomes are never blindly submitted again.
 * Polling deliberately avoids depending on a provider's stream cursor support. */
export async function backgroundTextResponse(url: string, body: Record<string, unknown>, headers: Record<string, string>,
  signal: AbortSignal, wait: <T>(value: Promise<T>) => Promise<T>, touch: () => void,
  reservedOutputTokens?: number): Promise<Response> {
  const store = recovery.getStore()!
  const requestBody: Record<string, unknown> = { ...body, stream: false, background: true }
  const key = createHash('sha256').update(JSON.stringify([url, requestBody])).digest('hex')
  let saved = store.read(key)
  if (saved && !saved.id) throw new Error('上次后台请求是否被接受尚不确定，已停止自动重发以避免重复生成。请核对提供商记录后重新发起。')
  if (!saved) {
    signal.throwIfAborted()
    const serialized = JSON.stringify(requestBody)
    const inputTokens = estimateTextRequestTokens(requestBody)
    const limit = requestBody.max_output_tokens ?? requestBody.max_completion_tokens ?? requestBody.max_tokens ?? reservedOutputTokens
    const generation = beginTextRequest({ request_bytes: Buffer.byteLength(serialized), estimated_input_tokens: inputTokens,
      ...(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? { reserved_output_tokens: limit } : {}) })
    store.save(key, { state: 'creating' })
    let response: Response
    try { response = await wait(fetch(url, { method: 'POST', headers, body: serialized, signal })) }
    catch (error) { generation.complete({}); throw error }
    touch()
    if (!response.ok) { store.save(key); generation.complete(await failedUsage(response, wait)); return response }
    let payload: Record<string, unknown>
    try { payload = await wait(response.json()) as Record<string, unknown> }
    catch (error) { generation.complete({}); throw error }
    if (typeof payload.id !== 'string' || !/^resp_[a-zA-Z0-9_-]+$/.test(payload.id)) {
      generation.complete(returnedUsage(payload))
      throw new Error('提供商未返回有效的后台响应 ID，请检查后台响应能力配置')
    }
    generation.identify(payload.id)
    generation.complete(['queued', 'in_progress'].includes(String(payload.status)) ? {} : returnedUsage(payload))
    saved = { state: 'accepted', id: payload.id }
    store.save(key, saved)
    if (!['queued', 'in_progress'].includes(String(payload.status))) {
      if (payload.status !== 'completed') store.save(key)
      return Response.json(payload)
    }
  }
  const responseUrl = `${url.replace(/\/$/, '')}/${encodeURIComponent(saved.id!)}`
  const cancel = AsyncLocalStorage.bind(() => { if (signal.reason?.name === 'AbortError') void cancelBackgroundTextResponses(url, saved!.id!, headers).catch(() => {}) })
  signal.addEventListener('abort', cancel, { once: true })
  try {
  for (;;) {
    signal.throwIfAborted()
    const poll = beginTextRequest({ kind: 'transport', request_bytes: Buffer.byteLength(responseUrl), estimated_input_tokens: 0 })
    let response: Response
    try { response = await wait(fetch(responseUrl, { headers, signal })) }
    catch (error) { poll.complete({}); throw error }
    touch()
    if (!response.ok) {
      poll.complete({})
      settlePendingTextRequest(saved.id!, await failedUsage(response, wait))
      if (response.status === 404 || response.status === 410) throw new Error('后台模型响应已过期或不可查询，已保留本地完成步骤。请核对提供商记录后重新发起未完成步骤。')
      return response
    }
    let payload: Record<string, unknown>
    try { payload = await wait(response.json()) as Record<string, unknown> }
    catch (error) { poll.complete({}); throw error }
    poll.complete({})
    const terminal = !['queued', 'in_progress'].includes(String(payload.status))
    if (terminal) {
      settlePendingTextRequest(saved.id!, returnedUsage(payload))
      if (payload.status !== 'completed') store.save(key)
      return Response.json(payload)
    }
    await wait(delay(2000, undefined, { signal }))
  }
  } finally { signal.removeEventListener('abort', cancel) }
}

export async function cancelBackgroundTextResponses(url: string, id: string, headers: Record<string, string>) {
  const cancelUrl = `${url.replace(/\/$/, '')}/${encodeURIComponent(id)}/cancel`
  const request = beginTextRequest({ kind: 'transport', request_bytes: Buffer.byteLength(cancelUrl), estimated_input_tokens: 0 })
  try { return await fetch(cancelUrl, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) }) }
  finally { request.complete({}) }
}
