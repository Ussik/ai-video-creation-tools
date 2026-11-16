import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { operationResponse } from '../src/shared/api/ai-operation-api'
import { aiOperationIntentPrefix, aiOperationLegacyMarker, aiOperationStorage } from '../src/shared/api/ai-operation-storage'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
})
const path = '/projects/storage-project/script/source/analysis'
const options = { method: 'POST', body: JSON.stringify({ model_id: 'model', source_updated_at: '2026-11-14T01:10:00Z' }) }
function legacyStorage(full = false) {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (full) throw new DOMException('full', 'QuotaExceededError')
      values.set(key, value)
    }, removeItem: (key: string) => { values.delete(key) } }
}
function browser(indexedDB: unknown, localStorage = legacyStorage()) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { indexedDB, localStorage } })
  Reflect.deleteProperty(globalThis, 'navigator')
  return localStorage
}
async function hash() {
  const data = new TextEncoder().encode(canonicalAiValue(['POST', path, JSON.parse(options.body)]))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
const terminal = (id: string) => Response.json({ id, route: path, state: 'completed', status_code: 200,
  result: { analysis_id: 'original-analysis' }, created_at: '', updated_at: '' })
async function durableValues(factory: IDBFactory): Promise<unknown[]> {
  const values: unknown[] = []
  for (const entry of await factory.databases()) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(entry.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      for (const storeName of database.objectStoreNames) {
        const records = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readonly')
          const request = transaction.objectStore(storeName).getAll()
          transaction.oncomplete = () => resolve(request.result)
          transaction.onabort = () => reject(transaction.error)
        })
        values.push(...records)
      }
    } finally { database.close() }
  }
  return values
}
async function includesDurableId(factory: IDBFactory, id: string) {
  return JSON.stringify(await durableValues(factory)).includes(id)
}

test('localStorage quota cannot block a durable analysis intent or erase an unsynced draft', async () => {
  const factory = new IDBFactory(), legacy = legacyStorage(true)
  legacy.values.set('script-director-draft:storage-project', 'unsynced draft')
  browser(factory, legacy)
  let posts = 0
  const response = await operationResponse(path, options, async (target, init) => {
    assert.equal(target, path); assert.equal(init?.method, 'POST'); posts++
    const id = new Headers(init?.headers).get('x-ai-operation-id')!
    assert.ok(id)
    assert.equal(await includesDurableId(factory, id), true, 'identity must be visible from a separate committed read before POST')
    return Response.json({ analysis_id: 'original-analysis' })
  })
  assert.deepEqual(await response.json(), { analysis_id: 'original-analysis' })
  assert.equal(posts, 1)
  assert.equal(legacy.getItem('script-director-draft:storage-project'), 'unsynced draft')
})

test('a lost response survives a module reload through IndexedDB and recovery only GETs the original ID', async () => {
  const factory = new IDBFactory(); browser(factory, legacyStorage(true))
  let id = '', posts = 0
  const first = await operationResponse(path, options, async (_target, init) => {
    if (init?.method === 'POST') { posts++; id = new Headers(init.headers).get('x-ai-operation-id')! }
    throw new TypeError('offline')
  })
  assert.equal((await first.json()).code, 'ai_operation_uncertain')
  assert.equal(await includesDurableId(factory, id), true)
  const reloaded = await import('../src/shared/api/ai-operation-api.ts?storage-tab=reload')
  const response = await reloaded.operationResponse(path, options, async (target: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined); assert.equal(target, `/ai-operations/${id}`)
    return terminal(id)
  })
  assert.deepEqual(await response.json(), { analysis_id: 'original-analysis' }); assert.equal(posts, 1)
})

test('legacy unknown work migrates its exact ID before GET and leaves a marker rejected by old JSON decoders', async () => {
  const factory = new IDBFactory(), legacy = browser(factory), fingerprint = await hash()
  const original = { id: 'original-unknown-operation', fingerprint, route: path, created_at: '2026-11-14T01:10:00Z' }
  const key = aiOperationIntentPrefix + fingerprint
  legacy.setItem(key, JSON.stringify(original))
  let gets = 0
  const response = await operationResponse(path, options, async (target, init) => {
    assert.equal(init?.method, undefined); assert.equal(target, `/ai-operations/${original.id}`); gets++
    assert.equal(await includesDurableId(factory, original.id), true)
    assert.equal(legacy.getItem(key), aiOperationLegacyMarker)
    assert.throws(() => JSON.parse(legacy.getItem(key)!))
    return terminal(original.id)
  })
  assert.deepEqual(await response.json(), { analysis_id: 'original-analysis' }); assert.equal(gets, 1)
})

test('a successful IndexedDB put followed by transaction abort never dispatches an uncommitted request', async t => {
  const factory = new IDBFactory(); browser(factory)
  const originalPut = IDBObjectStore.prototype.put
  let requestSucceeded = false, calls = 0
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key)
    request.addEventListener('success', () => { requestSucceeded = true; this.transaction.abort() })
    return request
  })
  await assert.rejects(operationResponse(path, options, async () => { calls++; return Response.json({}) }))
  assert.equal(requestSucceeded, true); assert.equal(calls, 0)
  assert.deepEqual(await durableValues(factory), [])
})

test('malformed legacy records fail closed without overwriting them or dispatching', async () => {
  const factory = new IDBFactory(), legacy = browser(factory), key = aiOperationIntentPrefix + await hash()
  legacy.setItem(key, '{broken')
  let calls = 0
  await assert.rejects(operationResponse(path, options, async () => { calls++; return Response.json({}) }))
  assert.equal(calls, 0); assert.equal(legacy.getItem(key), '{broken')
  assert.deepEqual(await durableValues(factory), [])
})

test('an old tab cannot overwrite a different pending IndexedDB identity and trigger duplicate POST', async () => {
  const factory = new IDBFactory(), legacy = browser(factory), fingerprint = await hash()
  let id = '', posts = 0
  await operationResponse(path, options, async (_target, init) => {
    if (init?.method === 'POST') { posts++; id = new Headers(init.headers).get('x-ai-operation-id')! }
    throw new TypeError('lost accepted delivery')
  })
  const changed = JSON.stringify({ id: 'conflicting-old-tab-intent', fingerprint, route: path, created_at: '2026-11-14T01:10:00Z' })
  const key = aiOperationIntentPrefix + fingerprint
  legacy.setItem(key, changed)
  let recoveryCalls = 0
  await assert.rejects(operationResponse(path, options, async () => { recoveryCalls++; return Response.json({}) }))
  assert.equal(posts, 1); assert.equal(recoveryCalls, 0); assert.equal(legacy.getItem(key), changed)
  assert.equal(await includesDurableId(factory, id), true)
})

test('cancellation retains the committed IndexedDB ID and a later invocation only observes that operation', async () => {
  const factory = new IDBFactory(); browser(factory, legacyStorage(true))
  const controller = new AbortController()
  let id = '', posts = 0
  await assert.rejects(operationResponse(path, { ...options, signal: controller.signal }, async (_target, init) => {
    posts++; id = new Headers(init?.headers).get('x-ai-operation-id')!
    controller.abort(); throw controller.signal.reason
  }), { name: 'AbortError' })
  assert.equal(await includesDurableId(factory, id), true)
  const reloaded = await import('../src/shared/api/ai-operation-api.ts?storage-tab=cancel-recovery')
  const response = await reloaded.operationResponse(path, options, async (target: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined); assert.equal(target, `/ai-operations/${id}`)
    return terminal(id)
  })
  assert.deepEqual(await response.json(), { analysis_id: 'original-analysis' }); assert.equal(posts, 1)
})

test('two browser modules sharing Web Locks and IndexedDB dispatch once and the waiter observes completion', async () => {
  const factory = new IDBFactory(); browser(factory, legacyStorage(true))
  const held = new Set<string>(), queues = new Map<string, Array<() => void>>()
  let queued!: () => void
  const waiterQueued = new Promise<void>(resolve => { queued = resolve })
  const locks = { request(name: string, optionsOrWork: unknown, maybeWork?: (lock: unknown) => Promise<unknown>) {
    const lockOptions = optionsOrWork as { ifAvailable?: boolean; signal?: AbortSignal }
    const work = (maybeWork || optionsOrWork) as (lock: unknown) => Promise<unknown>
    if (lockOptions.ifAvailable && held.has(name)) return Promise.resolve(work(null))
    return new Promise((resolve, reject) => {
      const run = () => {
        held.add(name)
        Promise.resolve().then(() => work({ name })).then(resolve, reject).finally(() => { held.delete(name); queues.get(name)?.shift()?.() })
      }
      if (held.has(name)) { const list = queues.get(name) || []; list.push(run); queues.set(name, list); queued() } else run()
    })
  } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } })
  const otherTab = await import('../src/shared/api/ai-operation-api.ts?storage-tab=concurrent')
  let finish!: (response: Response) => void, ready!: () => void, posts = 0, gets = 0, id = ''
  const dispatched = new Promise<void>(resolve => { ready = resolve })
  const transport = async (_target: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; id = new Headers(init.headers).get('x-ai-operation-id')!
      return new Promise<Response>(resolve => { finish = resolve; ready() })
    }
    gets++; return terminal(id)
  }
  const first = operationResponse(path, options, transport)
  await dispatched
  const second = otherTab.operationResponse(path, options, transport)
  await waiterQueued
  finish(Response.json({ analysis_id: 'original-analysis' }))
  const results = await Promise.all([first, second])
  assert.deepEqual(await results[0].json(), { analysis_id: 'original-analysis' })
  assert.deepEqual(await results[1].json(), { analysis_id: 'original-analysis' })
  assert.equal(posts, 1); assert.equal(gets, 1)
})

test('unavailable IndexedDB plus unwritable legacy storage cannot fall back to an unrecorded identity', async () => {
  browser({ open() { throw new DOMException('blocked', 'SecurityError') } }, legacyStorage(true))
  let calls = 0
  await assert.rejects(operationResponse(path, options, async () => { calls++; return Response.json({}) }))
  assert.equal(calls, 0)
})


test('an aborted terminal transaction retains pending identity and recovery only observes the original request', async t => {
  const factory = new IDBFactory(); browser(factory)
  const fingerprint = await hash(), originalPut = IDBObjectStore.prototype.put
  let failCompletion = true, completionPutSucceeded = false, id = '', posts = 0
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalPut.call(this, value, key)
    const record = value as { pending?: unknown; completed?: { id?: string } }
    if (failCompletion && record.pending === null && record.completed?.id === id) {
      request.addEventListener('success', () => { completionPutSucceeded = true; this.transaction.abort() })
    }
    return request
  })
  const response = await operationResponse(path, options, async (_target, init) => {
    assert.equal(init?.method, 'POST'); posts++
    id = new Headers(init.headers).get('x-ai-operation-id')!
    return Response.json({ analysis_id: 'original-analysis' })
  })
  assert.deepEqual(await response.json(), { analysis_id: 'original-analysis' }, 'delivered result survives only the terminal storage failure')
  assert.equal(completionPutSucceeded, true)
  const retained = await aiOperationStorage().read(fingerprint, path)
  assert.equal(retained.pending?.id, id); assert.equal(retained.completed, null)
  failCompletion = false
  const reloaded = await import('../src/shared/api/ai-operation-api.ts?storage-tab=terminal-abort')
  const recovered = await reloaded.operationResponse(path, options, async (target: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined); assert.equal(target, `/ai-operations/${id}`)
    return terminal(id)
  })
  assert.deepEqual(await recovered.json(), { analysis_id: 'original-analysis' }); assert.equal(posts, 1)
  const completed = await aiOperationStorage().read(fingerprint, path)
  assert.equal(completed.pending, null); assert.equal(completed.completed?.id, id)
})

test('a legacy migration marker without its durable copy never authorizes a new request', async t => {
  for (const available of [true, false]) await t.test(available ? 'empty IndexedDB' : 'IndexedDB API absent', async () => {
    const factory = available ? new IDBFactory() : undefined, legacy = browser(factory)
    const key = aiOperationIntentPrefix + await hash()
    legacy.setItem(key, aiOperationLegacyMarker)
    let calls = 0
    await assert.rejects(operationResponse(path, options, async () => { calls++; return Response.json({}) }))
    assert.equal(calls, 0); assert.equal(legacy.getItem(key), aiOperationLegacyMarker)
    if (factory) assert.deepEqual(await durableValues(factory), [])
  })
})
