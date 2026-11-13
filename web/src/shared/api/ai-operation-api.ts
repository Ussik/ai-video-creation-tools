/** Browser intent identity is saved before dispatch. Response recovery only
 * observes that identity; it never creates another paid request. */
import { aiOperationHeader, canonicalAiValue, type AiOperationRecord } from '@video-studio/shared/api/ai-operations'
type Intent = { id: string; fingerprint: string; route: string; created_at: string }
type Transport = (path: string, options?: RequestInit) => Promise<Response>
const prefix = 'ai-operation-intent:v1:'
const completedPrefix = 'ai-operation-completed:v1:'
const inFlight = new Map<string, Promise<Response>>()
const memory = new Map<string, string>()
function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  if (typeof window === 'undefined') return { getItem: key => memory.get(key) || null,
    setItem: (key, value) => { memory.set(key, value) }, removeItem: key => { memory.delete(key) } }
  return window.localStorage
}
async function fingerprint(path: string, options: RequestInit) {
  let body: unknown = options.body ?? null
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* Non-JSON body retains its exact bytes. */ } }
  const bytes = new TextEncoder().encode(canonicalAiValue([options.method?.toUpperCase() || 'GET', path, body]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function uncertain(intent: Intent, message = '本次处理结果尚未确认，请继续查询原请求。') {
  return new Response(JSON.stringify({ detail: message, code: 'ai_operation_uncertain', category: 'delivery',
    operation_id: intent.id, outcome_certainty: 'unknown', recovery: { kind: 'observe', operation_id: intent.id } }),
  { status: 409, headers: { 'Content-Type': 'application/json' } })
}
function terminal(snapshot: AiOperationRecord): Response | null {
  if (snapshot.state === 'running' || snapshot.state === 'interrupted') return null
  return new Response(JSON.stringify(snapshot.result ?? snapshot.error ?? {}), {
    status: snapshot.status_code || (snapshot.state === 'completed' ? 200 : 422), headers: { 'Content-Type': 'application/json' },
  })
}
function pause(signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, 1000)
    const abort = () => { clearTimeout(timer); reject(signal?.reason || new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
function readWithSignal<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function dispatch(transport: Transport, path: string, options: RequestInit): Promise<Response> {
  const signal = options.signal
  if (!signal) return transport(path, options)
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return transport(path, options) }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
async function observe(intent: Intent, transport: Transport, signal?: AbortSignal | null): Promise<Response | 'absent'> {
  while (true) {
    signal?.throwIfAborted()
    const response = await dispatch(transport, `/ai-operations/${encodeURIComponent(intent.id)}`, { signal })
    const value: unknown = await readWithSignal(response.json(), signal)
    if (response.status === 404 && value && typeof value === 'object' && 'code' in value && value.code === 'ai_operation_not_found') return 'absent'
    if (!response.ok || !value || typeof value !== 'object' || !('state' in value)) return uncertain(intent)
    const snapshot = value as AiOperationRecord
    if (snapshot.id !== intent.id || !['running', 'completed', 'failed', 'interrupted'].includes(snapshot.state)) return uncertain(intent)
    const result = terminal(snapshot)
    if (result) return result
    if (snapshot.state === 'interrupted') {
      // The original owner only checkpoints complete, hard-validated candidates;
      // their inconclusive quality still requires a fresh review before saving.
      if (snapshot.candidate !== undefined) return Response.json(snapshot.candidate)
      return uncertain(intent, '本次处理已中断，已有结果仍保留。请在任务记录核对后继续原功能。')
    }
    await pause(signal)
  }
}
async function executeOperation(path: string, options: RequestInit, transport: Transport, hash: string): Promise<Response> {
  const key = prefix + hash
  let intent: Intent, existing = false
  try {
    const saved = storage().getItem(key)
    const parsed = saved ? JSON.parse(saved) as Intent : undefined
    existing = !!parsed && parsed.fingerprint === hash && parsed.route === path && typeof parsed.id === 'string'
    intent = existing ? parsed! : { id: crypto.randomUUID(), fingerprint: hash, route: path, created_at: new Date().toISOString() }
    // Never dispatch if the browser cannot durably retain this identity.
    storage().setItem(key, JSON.stringify(intent))
  } catch { throw new Error('浏览器无法保存本次请求身份，请恢复本地存储后再开始处理。') }
  const clear = () => { options.signal?.throwIfAborted(); try { if (JSON.parse(storage().getItem(key) || '{}').id === intent.id) { storage().setItem(completedPrefix + hash, JSON.stringify(intent)); storage().removeItem(key) } } catch { /* A retained ID is safer than losing uncertain work. */ } }
  if (existing) {
    try {
      const recovered = await observe(intent, transport, options.signal)
      if (recovered !== 'absent') { if (recovered.status !== 409 || (await recovered.clone().json()).code !== 'ai_operation_uncertain') clear(); return recovered }
    } catch (error) { if (options.signal?.aborted) throw error; return uncertain(intent) }
    // An explicit retry after an authoritative absence keeps the exact same ID.
  }
  const headers = new Headers(options.headers); headers.set(aiOperationHeader, intent.id)
  try {
    const response = await dispatch(transport, path, { ...options, headers })
    const raw = await readWithSignal(response.text(), options.signal) // Buffer delivery before forgetting its recoverable identity.
    // HTML proxy pages and truncated JSON do not confirm delivery. Observe
    // the original operation before releasing its identity for an explicit retry.
    const body = JSON.parse(raw) as Record<string, unknown> | null
    if (body?.code === 'ai_operation_running') {
      const recovered = await observe(intent, transport, options.signal)
      if (recovered === 'absent') return uncertain(intent)
      if ((await recovered.clone().json()).code !== 'ai_operation_uncertain') clear()
      return recovered
    }
    if (body?.code !== 'ai_operation_interrupted' && body?.code !== 'ai_operation_uncertain') clear()
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    if (options.signal?.aborted) throw error
    try {
      const recovered = await observe(intent, transport, options.signal)
      if (recovered !== 'absent') {
        if ((await recovered.clone().json()).code !== 'ai_operation_uncertain') clear()
        return recovered
      }
    } catch { /* Keep the saved intent through observation outages. */ }
    return uncertain(intent)
  }
}

function callerResponse(task: Promise<Response>, signal?: AbortSignal | null): Promise<Response> {
  if (!signal) return task.then(response => response.clone())
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    task.then(response => response.clone()).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
/** Same-tab calls join before hashing yields; a queued browser-tab invocation
 * observes the original identity after the lock holder finishes. */
export function operationResponse(path: string, options: RequestInit, transport: Transport): Promise<Response> {
  let body: unknown = options.body ?? null
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* Retain exact non-JSON bytes. */ } }
  const key = canonicalAiValue([options.method?.toUpperCase() || 'GET', path, body])
  const active = inFlight.get(key)
  if (active) return callerResponse(active, options.signal)
  // Lock names need only coordinate contenders; the persisted SHA256 below
  // still verifies the full request identity.
  let lockHash = 2166136261
  for (let index = 0; index < key.length; index++) lockHash = Math.imul(lockHash ^ key.charCodeAt(index), 16777619)
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const run = async () => executeOperation(path, options, transport, await fingerprint(path, options))
  const task = (async () => {
    if (!locks) return run()
    const name = `ai-operation:${(lockHash >>> 0).toString(16)}`
    options.signal?.throwIfAborted()
    const immediate = await locks.request(name, { ifAvailable: true }, lock => lock ? run() : null)
    if (immediate) return immediate
    // The initial lock probe proved another invocation was active. Capture its
    // identity before queueing; completed metadata carries no creative content.
    const hash = await fingerprint(path, options)
    let prior: Intent | undefined
    try { prior = JSON.parse(storage().getItem(prefix + hash) || storage().getItem(completedPrefix + hash) || 'null') as Intent | undefined } catch { /* Execute still checks durable storage. */ }
    return locks.request(name, options.signal ? { signal: options.signal } : {}, async () => {
      let original = prior
      try { original ||= JSON.parse(storage().getItem(completedPrefix + hash) || 'null') as Intent | undefined } catch { /* Missing identity never authorizes blind replay. */ }
      if (original?.fingerprint === hash && original.route === path) {
        try { const response = await observe(original, transport, options.signal); return response === 'absent' ? uncertain(original) : response }
        catch (issue) { if (options.signal?.aborted) throw issue; return uncertain(original) }
      }
      // A lock-name collision belongs to another input; its lifecycle does not
      // authorize replaying or suppressing this distinct intent.
      return executeOperation(path, options, transport, hash)
    })
  })()
  inFlight.set(key, task)
  const release = () => { if (inFlight.get(key) === task) inFlight.delete(key) }
  task.then(release, release)
  return callerResponse(task, options.signal)
}
