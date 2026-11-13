import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { canvasGenerationLegacyMarker, canvasGenerationStorage, createCanvasGenerationStorage, subscribeCanvasGenerationStorage } from '../src/features/canvas/canvas-generation-storage'
import { canvasGenerationSubmissionStorageKey, createCanvasGenerationSubmission, readCanvasGenerationSubmission,
  recoverCanvasGenerationSubmission } from '../src/features/canvas/canvas-generation-submission'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
function legacyStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const scope = { projectId: 'project', canvasId: 'canvas', nodeId: 'node' }
const input = { ...scope, sourceSignature: 'original input', baselineJobId: null, candidateCount: 1,
  request: { prompt: '完整提示词', shot_id: 'shot' } }
function browser(value: object) { Object.defineProperty(globalThis, 'window', { configurable: true, value }) }

test('a full localStorage does not block a durable generation submission in IndexedDB', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  legacy.values.set('script-director-draft:project', 'unsynced draft')
  browser({ indexedDB: factory, localStorage: { ...legacy, setItem() { throw new DOMException('full', 'QuotaExceededError') } } })
  const item = await createCanvasGenerationSubmission(input)
  let posts = 0
  await recoverCanvasGenerationSubmission(item, { allowSubmit: true, api: async <T>(_path: string, init?: RequestInit) => {
    if (!init?.method) return { job: null } as T
    posts++
    assert.equal((await readCanvasGenerationSubmission(scope))?.inFlightKey, item.candidates[0].key,
      'the in-flight identity is committed before any paid POST')
    return { id: 'accepted' } as T
  } })
  assert.equal(posts, 1)
  assert.equal((await readCanvasGenerationSubmission(scope))?.candidates[0].jobId, 'accepted')
  assert.equal(legacy.getItem('script-director-draft:project'), 'unsynced draft')
  assert.equal(legacy.getItem(canvasGenerationSubmissionStorageKey(scope)), null)
})

test('migration preserves unknown accepted attempts and exact original candidate identities', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  const original = await createCanvasGenerationSubmission(input, legacy)
  const pending = { ...original, inFlightKey: original.candidates[0].key }
  const key = canvasGenerationSubmissionStorageKey(scope)
  legacy.setItem(key, JSON.stringify(pending))
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  const restored = await readCanvasGenerationSubmission(scope, adapter)
  assert.deepEqual(restored, pending)
  assert.equal(legacy.getItem(key), JSON.stringify(pending), 'read-only discovery must not migrate or mutate the old key')
  await adapter.migrateItem!(key, JSON.stringify(restored))
  assert.equal(legacy.getItem(key), canvasGenerationLegacyMarker)
  await assert.rejects(readCanvasGenerationSubmission(scope, legacy), /生成提交记录不完整/,
    'the version 1 decoder used by old clients rejects the marker instead of creating a fresh operation')
  const reloaded = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  const requests: string[] = []
  await recoverCanvasGenerationSubmission(restored!, { storage: reloaded, api: async <T>(path: string, init?: RequestInit) => {
    assert.equal(init?.method || 'GET', 'GET')
    requests.push(path)
    return { job: null } as T
  } })
  assert.ok(requests[0].endsWith(original.candidates[0].key))
  assert.deepEqual(await readCanvasGenerationSubmission(scope, reloaded), pending)
})

test('malformed legacy records stay untouched and never migrate before ledger validation', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory(), key = canvasGenerationSubmissionStorageKey(scope)
  legacy.setItem(key, '{broken')
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  await assert.rejects(readCanvasGenerationSubmission(scope, adapter), /生成提交记录无法读取/)
  assert.equal(legacy.getItem(key), '{broken')
  const emptyLegacy = legacyStorage()
  assert.equal(await createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => emptyLegacy }).getItem(key), null)
})

test('a request success followed by transaction abort is not a durable write', async t => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  let requestSucceeded = false, notifications = 0
  const originalPut = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key)
    request.addEventListener('success', () => { requestSucceeded = true; this.transaction.abort() })
    return request
  })
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy, notify: () => notifications++ })
  await assert.rejects(adapter.setItem('record', 'value'), /中止/)
  assert.equal(requestSucceeded, true)
  assert.equal(await adapter.getItem('record'), null)
  assert.equal(notifications, 0)
})

test('a failed migration commit retains the complete legacy recovery record', async t => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  const original = await createCanvasGenerationSubmission(input, legacy), key = canvasGenerationSubmissionStorageKey(scope)
  const raw = legacy.getItem(key)
  const originalPut = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  await assert.rejects(adapter.migrateItem!(key, raw!))
  assert.equal(legacy.getItem(key), raw)
  assert.equal(JSON.parse(raw!).id, original.id)
})

test('different legacy and IndexedDB identities block submission without overwriting either', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  const original = await createCanvasGenerationSubmission(input, adapter), key = canvasGenerationSubmissionStorageKey(scope)
  const oldTab = { ...original, id: 'different-intent', inFlightKey: 'possibly-accepted' }
  legacy.setItem(key, JSON.stringify(oldTab))
  await assert.rejects(createCanvasGenerationSubmission(input, adapter), /旧标签页.*冲突/)
  assert.equal(legacy.getItem(key), JSON.stringify(oldTab))
  legacy.removeItem(key)
  assert.equal((await readCanvasGenerationSubmission(scope, adapter))?.id, original.id)
})

test('concurrent identical migrations keep one durable record and one legacy rejection marker', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  const original = await createCanvasGenerationSubmission(input, legacy)
  const first = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  const second = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  const raw = JSON.stringify(original), key = canvasGenerationSubmissionStorageKey(scope)
  await Promise.all([first.migrateItem!(key, raw), second.migrateItem!(key, raw)])
  const results = await Promise.all([readCanvasGenerationSubmission(scope, first), readCanvasGenerationSubmission(scope, second)])
  assert.deepEqual(results, [original, original])
  assert.equal(legacy.getItem(key), canvasGenerationLegacyMarker)
})

test('migration never deletes a newer legacy snapshot written while its transaction commits', async t => {
  const legacy = legacyStorage(), factory = new IDBFactory()
  const original = await createCanvasGenerationSubmission(input, legacy), key = canvasGenerationSubmissionStorageKey(scope)
  const newer = JSON.stringify({ ...original, inFlightKey: original.candidates[0].key })
  const originalPut = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key)
    request.addEventListener('success', () => legacy.setItem(String(key), newer))
    return request
  })
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  await assert.rejects(adapter.migrateItem!(key, JSON.stringify(original)), /旧标签页.*冲突/)
  assert.equal(legacy.getItem(key), newer)
  const durableOnly = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacyStorage() })
  assert.equal((await readCanvasGenerationSubmission(scope, durableOnly))?.id, original.id)
})

test('a legacy migration marker without its IndexedDB copy fails closed', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory(), key = canvasGenerationSubmissionStorageKey(scope)
  legacy.setItem(key, canvasGenerationLegacyMarker)
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => legacy })
  await assert.rejects(createCanvasGenerationSubmission(input, adapter), /无法找到新副本/)
  await assert.rejects(adapter.setItem(key, 'replacement'), /无法找到新副本/)
  assert.equal(legacy.getItem(key), canvasGenerationLegacyMarker)
})

test('a failed marker replacement preserves the original legacy record and blocks migration', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory(), original = await createCanvasGenerationSubmission(input, legacy)
  const key = canvasGenerationSubmissionStorageKey(scope), raw = JSON.stringify(original)
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => ({ ...legacy,
    setItem() { throw new DOMException('full', 'QuotaExceededError') },
  }) })
  await assert.rejects(adapter.migrateItem!(key, raw), { name: 'QuotaExceededError' })
  assert.equal(legacy.getItem(key), raw)
  assert.deepEqual(await readCanvasGenerationSubmission(scope, adapter), original)
})

test('new-key marker failures only allow genuine quota errors and retain durable identity on denial', async () => {
  const legacy = legacyStorage(), factory = new IDBFactory(), key = canvasGenerationSubmissionStorageKey(scope)
  const adapter = createCanvasGenerationStorage({ indexedDB: factory, legacyStorage: () => ({ ...legacy,
    setItem() { throw new DOMException('denied', 'SecurityError') },
  }) })
  await assert.rejects(createCanvasGenerationSubmission(input, adapter), /无法保存生成提交记录/)
  assert.equal(legacy.getItem(key), null)
  assert.ok((await readCanvasGenerationSubmission(scope, adapter))?.id, 'a denied marker never discards the committed IDB identity')
})

test('legacy access and IndexedDB failures never silently create a fresh recovery ledger', async () => {
  const legacy = legacyStorage()
  browser({ indexedDB: { open() { throw new DOMException('blocked', 'SecurityError') } }, localStorage: legacy })
  await assert.rejects(createCanvasGenerationSubmission(input), /无法读取生成提交记录/)
  assert.equal(legacy.values.size, 0)
  const adapter = createCanvasGenerationStorage({ indexedDB: new IDBFactory(), legacyStorage: () => {
    throw new DOMException('blocked', 'SecurityError')
  } })
  await assert.rejects(createCanvasGenerationSubmission(input, adapter), /无法读取生成提交记录/)
})

test('browsers without IndexedDB retain the existing localStorage fallback', async () => {
  const legacy = legacyStorage()
  browser({ localStorage: legacy })
  const item = await createCanvasGenerationSubmission(input)
  assert.equal(JSON.parse(legacy.getItem(canvasGenerationSubmissionStorageKey(scope))!).id, item.id)
})

test('committed writes notify other documents without echoing to their own subscriber', async () => {
  const channels = new Set<TestChannel>()
  class TestChannel {
    onmessage: (() => void) | null = null
    constructor(readonly name: string) { channels.add(this) }
    postMessage() { for (const channel of channels) if (channel !== this && channel.name === this.name) channel.onmessage?.() }
    close() { channels.delete(this) }
  }
  const firstWindow = { indexedDB: new IDBFactory(), localStorage: legacyStorage(), BroadcastChannel: TestChannel }
  const secondWindow = { indexedDB: new IDBFactory(), localStorage: legacyStorage(), BroadcastChannel: TestChannel }
  let firstCalls = 0, secondCalls = 0
  browser(firstWindow)
  const firstUnsubscribe = subscribeCanvasGenerationStorage(() => firstCalls++)
  browser(secondWindow)
  const secondUnsubscribe = subscribeCanvasGenerationStorage(() => secondCalls++)
  browser(firstWindow)
  await canvasGenerationStorage().setItem('record', 'committed')
  assert.equal(firstCalls, 0)
  assert.equal(secondCalls, 1)
  firstUnsubscribe(); secondUnsubscribe()
  assert.equal(channels.size, 0)
})
