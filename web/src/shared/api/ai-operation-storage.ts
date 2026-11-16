/** Durable HTTP intent identities contain no prompt, candidate or model output.
 * Legacy keys stay readable until their exact identities have committed to IDB. */
export type AiOperationIntent = { id: string; fingerprint: string; route: string; created_at: string }
type Snapshot = { pending: AiOperationIntent | null; completed: AiOperationIntent | null }
type Stored = Snapshot & { version: 1 }
type Legacy = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const aiOperationIntentPrefix = 'ai-operation-intent:v1:'
export const aiOperationCompletedPrefix = 'ai-operation-completed:v1:'
// Old clients JSON.parse this key. A JSON version marker would silently grant
// them a new identity; this non-JSON marker makes them stop before dispatch.
export const aiOperationLegacyMarker = 'ai-operation:indexeddb:v2'
const databaseName = 'video-studio-ai-operations'
const storeName = 'intents'
const memory = new Map<string, string>()
const failure = () => new Error('浏览器无法保存本次请求身份，尚未发送新请求。请确认浏览器允许网站存储后刷新工作台；请保留已有浏览器数据。')
const conflict = () => new Error('请求身份记录冲突或损坏，已停止新的请求。请刷新所有工作台标签页并核对原任务；请保留浏览器数据。')
const quotaFailure = (issue: unknown) => {
  const value = issue as { name?: string; code?: number } | null
  return !!value && (value.name === 'QuotaExceededError' || value.name === 'NS_ERROR_DOM_QUOTA_REACHED' || value.code === 22 || value.code === 1014)
}
function intent(value: unknown, hash: string, route: string): AiOperationIntent {
  if (!value || typeof value !== 'object') throw conflict()
  const item = value as AiOperationIntent
  if (typeof item.id !== 'string' || !item.id || item.fingerprint !== hash || item.route !== route || typeof item.created_at !== 'string') throw conflict()
  return { id: item.id, fingerprint: hash, route, created_at: item.created_at }
}
function parseLegacy(raw: string | null, hash: string, route: string): AiOperationIntent | null {
  if (raw === null || raw === aiOperationLegacyMarker) return null
  try { return intent(JSON.parse(raw), hash, route) } catch { throw conflict() }
}
function snapshot(value: unknown, hash: string, route: string): Snapshot | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || (value as Stored).version !== 1) throw conflict()
  const row = value as Stored
  return { pending: row.pending === null ? null : intent(row.pending, hash, route),
    completed: row.completed === null ? null : intent(row.completed, hash, route) }
}
function reconcile(current: Snapshot | null, raw: { pending: string | null; completed: string | null }, hash: string, route: string): Snapshot {
  if (!current && (raw.pending === aiOperationLegacyMarker || raw.completed === aiOperationLegacyMarker)) throw conflict()
  const pending = parseLegacy(raw.pending, hash, route), completed = parseLegacy(raw.completed, hash, route)
  if (current?.pending && pending && current.pending.id !== pending.id) throw conflict()
  // A legacy copy can survive a failed compatibility write after completion.
  // A confirmed terminal identity does not become a new pending request.
  const legacyPending = pending?.id === current?.completed?.id ? null : pending
  return { pending: current?.pending || legacyPending, completed: current?.completed || completed }
}
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = factory.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
    request.onerror = () => { settled = true; reject(failure()) }
    request.onblocked = () => { settled = true; reject(new Error('请求身份存储被旧标签页阻塞，请刷新所有工作台标签页后重试。')) }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      if (settled) database.close()
      else { settled = true; resolve(database) }
    }
  })
}
export type AiOperationStorage = {
  prepare(hash: string, route: string, create: () => AiOperationIntent): Promise<{ intent: AiOperationIntent; existing: boolean }>
  read(hash: string, route: string): Promise<Snapshot>
  complete(hash: string, route: string, id: string): Promise<void>
}
export function aiOperationStorage(): AiOperationStorage {
  const legacy = (): Legacy => typeof window === 'undefined' ? {
    getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value) }, removeItem: key => { memory.delete(key) },
  } : window.localStorage
  // An absent API retains legacy support. An IDB access/open error must not
  // hide a previously saved identity by falling back to a different store.
  const factory = typeof window === 'undefined' ? undefined : window.indexedDB
  const legacyRaw = (hash: string) => ({ pending: legacy().getItem(aiOperationIntentPrefix + hash), completed: legacy().getItem(aiOperationCompletedPrefix + hash) })
  const markLegacy = (hash: string, expected: ReturnType<typeof legacyRaw>) => {
    for (const [prefix, value] of [[aiOperationIntentPrefix, expected.pending], [aiOperationCompletedPrefix, expected.completed]] as const) {
      if (prefix === aiOperationCompletedPrefix && value === null) continue
      const key = prefix + hash, current = legacy().getItem(key)
      if (current === aiOperationLegacyMarker) continue
      if (current !== value) throw conflict()
      try { legacy().setItem(key, aiOperationLegacyMarker) }
      catch (issue) {
        // No old identity was removed. While legacy quota is full an old tab
        // cannot persist its larger new intent either; modern tabs use IDB.
        // Refresh every old tab before freeing quota or mixing client versions.
        if (value === null && quotaFailure(issue)) continue
        throw failure()
      }
      if (legacy().getItem(key) !== aiOperationLegacyMarker) throw failure()
    }
  }
  async function transaction<T>(hash: string, route: string, update: ((state: Snapshot) => { state: Snapshot; result: T }) | undefined,
    read: (state: Snapshot) => T): Promise<{ result: T; raw: ReturnType<typeof legacyRaw> }> {
    const database = await openDatabase(factory!)
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = database.transaction(storeName, update ? 'readwrite' : 'readonly')
        const store = tx.objectStore(storeName), request = store.get(hash)
        let result: T, raw: ReturnType<typeof legacyRaw>, issue: unknown
        tx.oncomplete = () => { database.close(); resolve({ result, raw }) }
        tx.onabort = () => { database.close(); reject(issue || failure()) }
        request.onsuccess = () => {
          try {
            raw = legacyRaw(hash)
            const state = reconcile(snapshot(request.result, hash, route), raw, hash, route)
            if (update) {
              const next = update(state); result = next.result
              store.put({ version: 1, ...next.state } satisfies Stored, hash)
            } else result = read(state)
          } catch (error) { issue = error; tx.abort() }
        }
      } catch (error) { database.close(); reject(error) }
    })
  }
  return {
    async read(hash, route) {
      if (!factory) return reconcile(null, legacyRaw(hash), hash, route)
      return (await transaction(hash, route, undefined, state => state)).result
    },
    async prepare(hash, route, create) {
      if (!factory) {
        try {
          const state = reconcile(null, legacyRaw(hash), hash, route), selected = state.pending || create()
          legacy().setItem(aiOperationIntentPrefix + hash, JSON.stringify(selected))
          if (legacy().getItem(aiOperationIntentPrefix + hash) !== JSON.stringify(selected)) throw failure()
          return { intent: selected, existing: !!state.pending }
        } catch (issue) { if (issue instanceof Error && issue.message.includes('记录冲突')) throw issue; throw failure() }
      }
      const saved = await transaction(hash, route, state => {
        const selected = state.pending || create()
        return { state: { ...state, pending: selected }, result: { intent: selected, existing: !!state.pending } }
      }, () => { throw failure() })
      markLegacy(hash, saved.raw)
      return saved.result
    },
    async complete(hash, route, id) {
      if (!factory) {
        const state = reconcile(null, legacyRaw(hash), hash, route)
        if (state.pending?.id !== id) return
        legacy().setItem(aiOperationCompletedPrefix + hash, JSON.stringify(state.pending))
        legacy().removeItem(aiOperationIntentPrefix + hash)
        return
      }
      const saved = await transaction(hash, route, state => {
        const completed = state.pending?.id === id ? { pending: null, completed: state.pending } : state
        return { state: completed, result: undefined }
      }, () => undefined)
      markLegacy(hash, saved.raw)
    },
  }
}
