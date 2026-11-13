export type CanvasGenerationStorage = {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  /** Called only after the ledger has validated the legacy record. */
  migrateItem?(key: string, value: string): Promise<void>
}

type LegacyStorage = Pick<Storage, 'getItem' | 'setItem'>
type StorageOptions = { indexedDB: IDBFactory; legacyStorage: () => LegacyStorage; notify?: () => void }
const databaseName = 'video-studio-generation'
const storeName = 'submissions'
const channelName = 'video-studio-generation-changes'
// Old clients reject version 2 instead of mistaking an absent key for a new
// operation. Keep this marker at the original key after migrating the payload.
export const canvasGenerationLegacyMarker = '{"version":2,"storage":"indexeddb"}'
const subscriptions = new WeakMap<Window, { channel: BroadcastChannel; listeners: Set<() => void> }>()

function conflict(): Error {
  return new Error('检测到旧标签页中的生成提交记录冲突，请刷新所有该网站标签页后检查已有任务；已停止新的生成提交')
}

function missingMigratedRecord(): Error {
  return new Error('生成提交记录已迁移但无法找到新副本，请保留浏览器数据并检查已有任务')
}

function quotaFailure(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown } | null
  return !!value && (value.name === 'QuotaExceededError' || value.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || value.code === 22 || value.code === 1014)
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 1)
    let settled = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
    }
    request.onerror = () => { settled = true; reject(request.error || new Error('无法打开生成提交记录数据库')) }
    request.onblocked = () => {
      settled = true
      reject(new Error('生成提交记录数据库升级被旧标签页阻塞，请关闭该网站的其他标签页后重试'))
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      if (settled) database.close()
      else { settled = true; resolve(database) }
    }
  })
}

async function databaseValue(factory: IDBFactory, key: string): Promise<string | null> {
  const database = await openDatabase(factory)
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).get(key)
      transaction.oncomplete = () => {
        database.close()
        if (request.result === undefined || request.result === null) resolve(null)
        else if (typeof request.result === 'string') resolve(request.result)
        else reject(new Error('生成提交记录格式异常，请保留浏览器数据并检查已有任务'))
      }
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error('读取生成提交记录事务已中止')) }
    } catch (error) { database.close(); reject(error) }
  })
}

async function commitValue(factory: IDBFactory, key: string, value: string, migrationGuard?: () => void): Promise<void> {
  const database = await openDatabase(factory)
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(storeName, 'readwrite')
      let failure: unknown
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(failure || transaction.error || new Error('保存生成提交记录事务已中止')) }
      const store = transaction.objectStore(storeName)
      if (!migrationGuard) store.put(value, key)
      else {
        // Compare in the write transaction as an additional guard against a
        // stale migration overwriting a newly advanced ledger.
        const request = store.get(key)
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && request.result !== value) throw conflict()
            migrationGuard()
            store.put(value, key)
          } catch (error) { failure = error; transaction.abort() }
        }
      }
    } catch (error) { database.close(); reject(error) }
  })
}

/** Migration and submission writes must hold the existing submission Web Lock. */
export function createCanvasGenerationStorage(options: StorageOptions): CanvasGenerationStorage {
  const legacyValue = (key: string) => options.legacyStorage().getItem(key)
  const markLegacy = (key: string, expected: string | null) => {
    const legacy = options.legacyStorage()
    const current = legacy.getItem(key)
    if (current === canvasGenerationLegacyMarker) return
    if (current !== expected) throw conflict()
    try { legacy.setItem(key, canvasGenerationLegacyMarker) } catch (error) {
      // A full legacy store must not block a brand-new IndexedDB intent. No
      // legacy identity is removed in this case, and an old client cannot fit
      // its much larger intent while the same quota remains exhausted.
      if (expected === null && quotaFailure(error)) return
      throw error
    }
    if (legacy.getItem(key) !== canvasGenerationLegacyMarker) throw new Error('无法迁移旧生成提交记录，请保留浏览器数据并检查已有任务')
  }
  return {
    async getItem(key) {
      const legacy = legacyValue(key)
      const current = await databaseValue(options.indexedDB, key)
      if (legacy === canvasGenerationLegacyMarker) {
        if (current === null) throw missingMigratedRecord()
        return current
      }
      if (legacy !== null && current !== null && legacy !== current) throw conflict()
      return current ?? legacy
    },
    async migrateItem(key, value) {
      const legacy = legacyValue(key)
      if (legacy === null) return
      const current = await databaseValue(options.indexedDB, key)
      if (legacy === canvasGenerationLegacyMarker) {
        if (current === null) throw missingMigratedRecord()
        if (current !== value) throw conflict()
        return
      }
      if (current !== null && current !== value || legacy !== null && legacy !== value) throw conflict()
      if (current === null) {
        await commitValue(options.indexedDB, key, value, () => {
          const latest = legacyValue(key)
          if (latest !== value && latest !== canvasGenerationLegacyMarker) throw conflict()
        })
      }
      // Only replace a validated, unchanged legacy snapshot after its complete
      // durable copy exists. Old clients now fail closed on version 2.
      markLegacy(key, value)
      options.notify?.()
    },
    async setItem(key, value) {
      const legacy = legacyValue(key)
      if (legacy !== null) {
        const current = await databaseValue(options.indexedDB, key)
        if (legacy === canvasGenerationLegacyMarker) {
          if (current === null) throw missingMigratedRecord()
        } else if (current !== legacy) throw conflict()
      }
      await commitValue(options.indexedDB, key, value)
      markLegacy(key, legacy)
      options.notify?.()
    },
  }
}

function notifyStorageChanged(): void {
  try {
    if (typeof window.BroadcastChannel !== 'function') return
    const active = subscriptions.get(window)
    // Reuse the listener's channel: BroadcastChannel does not echo to its own
    // sender, so a successful write cannot trigger a local recovery/write loop.
    if (active) { active.channel.postMessage('changed'); return }
    // A transient sender does not retain an otherwise unused channel.
    const channel = new window.BroadcastChannel(channelName)
    try { channel.postMessage('changed') } finally { channel.close() }
  } catch { /* Focus/online recovery remains available when messaging is disabled. */ }
}

export function canvasGenerationStorage(): CanvasGenerationStorage {
  if (typeof window === 'undefined') throw new Error('浏览器存储不可用')
  // Only an absent API permits the legacy fallback. An IDB access/open error
  // must not hide an existing ledger by starting over in another database.
  if (!window.indexedDB) return window.localStorage
  return createCanvasGenerationStorage({ indexedDB: window.indexedDB, legacyStorage: () => window.localStorage, notify: notifyStorageChanged })
}

export function subscribeCanvasGenerationStorage(listener: () => void): () => void {
  try {
    if (typeof window.BroadcastChannel !== 'function') return () => {}
    const owner = window
    let active = subscriptions.get(owner)
    if (!active) {
      const channel = new owner.BroadcastChannel(channelName)
      const listeners = new Set<() => void>()
      channel.onmessage = () => listeners.forEach(notify => notify())
      active = { channel, listeners }
      subscriptions.set(owner, active)
    }
    const current = active
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
      if (!current.listeners.size) { current.channel.close(); subscriptions.delete(owner) }
    }
  } catch { return () => {} }
}
