import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { operationResponse } from '../src/shared/api/ai-operation-api'
import { api, type ApiError } from '../src/shared/api/api'
const values = new Map<string, string>()
const localStorage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
beforeEach(() => { values.clear(); Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } }) })
const path = '/projects/project/skills/refine-prompt'
const options = { method: 'POST', body: JSON.stringify({ prompt: '原稿', model_id: 'model' }) }
const pending = () => [...values.entries()].filter(([key]) => key.startsWith('ai-operation-intent:'))
const saved = () => JSON.parse(pending()[0]?.[1] || '{}') as { id: string }
const terminal = (id: string, result = { prompt: '保留草稿' }) => Response.json({ id, route: path, state: 'completed', status_code: 200, result, created_at: '', updated_at: '' })

test('persists identity before dispatch and recovers a lost accepted response without another POST', async () => {
  const calls: string[] = []; let identity = ''
  const response = await operationResponse(path, options, async (target, init) => {
    calls.push(init?.method || 'GET')
    if (target === path) {
      identity = new Headers(init?.headers).get('x-ai-operation-id')!
      assert.ok(identity); assert.equal(saved().id, identity)
      throw new TypeError('response delivery lost')
    }
    assert.equal(target, `/ai-operations/${identity}`)
    return terminal(identity)
  })
  assert.deepEqual(await response.json(), { prompt: '保留草稿' })
  assert.deepEqual(calls, ['POST', 'GET']); assert.equal(pending().length, 0)
})

test('uncertain work survives remount and an explicit repeat only observes the original identity', async () => {
  let posts = 0
  const first = await operationResponse(path, options, async (_target, init) => { if (init?.method === 'POST') posts++; throw new TypeError('offline') })
  assert.equal((await first.json()).code, 'ai_operation_uncertain')
  const id = saved().id; assert.ok(id)
  const response = await operationResponse(path, options, async (target, init) => {
    assert.equal(init?.method, undefined); assert.equal(target, `/ai-operations/${id}`)
    return terminal(id)
  })
  assert.equal((await response.json()).prompt, '保留草稿'); assert.equal(posts, 1, 'only the original request was dispatched')
})

test('an interrupted or unrecognized lookup retains identity and never dispatches again', async () => {
  await operationResponse(path, options, async () => { throw new Error('lost') })
  const id = saved().id
  for (const response of [Response.json({ id, state: 'interrupted' }), Response.json({ detail: 'unknown endpoint' }, { status: 404 })]) {
    const recovered = await operationResponse(path, options, async (_target, init) => { assert.equal(init?.method, undefined); return response })
    assert.equal((await recovered.json()).code, 'ai_operation_uncertain'); assert.equal(saved().id, id)
  }
})

test('only authoritative absence allows the next explicit retry to dispatch the same identity', async () => {
  await operationResponse(path, options, async () => { throw new Error('lost') })
  const id = saved().id, methods: string[] = []
  const response = await operationResponse(path, options, async (_target, init) => {
    methods.push(init?.method || 'GET')
    if (!init?.method) return Response.json({ code: 'ai_operation_not_found' }, { status: 404 })
    assert.equal(new Headers(init.headers).get('x-ai-operation-id'), id)
    return Response.json({ prompt: '新送达' })
  })
  assert.equal((await response.json()).prompt, '新送达'); assert.deepEqual(methods, ['GET', 'POST'])
})

test('known terminal work allows a new explicit identical request with a new identity; canonical JSON keys recover together', async () => {
  const ids: string[] = []
  for (let index = 0; index < 2; index++) await operationResponse(path, options, async (_target, init) => {
    ids.push(new Headers(init?.headers).get('x-ai-operation-id')!); return Response.json({ prompt: '完成' })
  })
  assert.notEqual(ids[0], ids[1])
  await operationResponse(path, options, async () => { throw new Error('lost') })
  const id = saved().id
  await operationResponse(path, { ...options, body: JSON.stringify({ model_id: 'model', prompt: '原稿' }) }, async (_target, init) => { assert.equal(init?.method, undefined); return terminal(id) })
})

test('storage failure prevents dispatch and abort keeps the pending identity', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: { ...localStorage, setItem() { throw new Error('full') } } } })
  let calls = 0
  await assert.rejects(operationResponse(path, options, async () => { calls++; return Response.json({}) }), /无法保存/)
  assert.equal(calls, 0)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage } })
  const controller = new AbortController()
  await assert.rejects(operationResponse(path, { ...options, signal: controller.signal }, async () => { controller.abort(); throw controller.signal.reason }))
  assert.equal(pending().length, 1)
})

test('ApiError retains safe machine recovery fields without copying arbitrary response fields', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ detail: '待核对', code: 'delivery_unknown', category: 'delivery', operation_id: 'op', task_id: 'task', trace_id: 'trace', outcome_certainty: 'unknown', retryable: false, retry_after_ms: 20,
    recovery: { kind: 'observe', operation_id: 'op', candidate_id: 'candidate', token: 'secret' }, token: 'secret', stack: 'server stack', raw_output: 'raw', diagnostics: 'check' }, { status: 409 })
  try {
    await assert.rejects(api('/non-ai-route'), (issue: unknown) => {
      const error = issue as ApiError
      assert.equal(error.status, 409); assert.equal(error.code, 'delivery_unknown'); assert.equal(error.retryable, false); assert.equal(error.retry_after_ms, 20)
      assert.deepEqual(error.recovery, { kind: 'observe', operation_id: 'op', candidate_id: 'candidate' })
      assert.equal(error.raw_output, 'raw'); assert.equal(error.diagnostics, 'check'); assert.equal((error as unknown as Record<string, unknown>).token, undefined); assert.notEqual(error.stack, 'server stack'); return true
    })
  } finally { globalThis.fetch = original }
})


test('running-operation replay observes the original result and never creates a new identity', async () => {
  let id = '', posts = 0
  const response = await operationResponse(path, options, async (_target, init) => {
    if (init?.method === 'POST') { posts++; id = new Headers(init.headers).get('x-ai-operation-id')!; return Response.json({ code: 'ai_operation_running' }, { status: 409 }) }
    return terminal(id)
  })
  assert.equal((await response.json()).prompt, '保留草稿'); assert.equal(posts, 1); assert.equal(pending().length, 0)
})


test('simultaneous identical invocations share one response and one dispatch before asynchronous hashing', async () => {
  let posts = 0, finish!: (response: Response) => void, ready!: () => void
  const dispatched = new Promise<void>(resolve => { ready = resolve })
  const transport = async (_target: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts++
    return new Promise<Response>(resolve => { finish = resolve; ready() })
  }
  const first = operationResponse(path, options, transport), second = operationResponse(path, options, transport)
  await dispatched
  finish(Response.json({ prompt: '同一次候选' }))
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(await a.json(), { prompt: '同一次候选' }); assert.deepEqual(await b.json(), { prompt: '同一次候选' }); assert.equal(posts, 1)
  await operationResponse(path, options, async () => { posts++; return Response.json({ prompt: '主动下一次候选' }) })
  assert.equal(posts, 2, 'a subsequent intentional invocation remains a new request')
})


test('queued browser tabs observe the completed original operation instead of starting another paid request', async () => {
  const held = new Set<string>(), queues = new Map<string, Array<() => void>>()
  const locks = { request(name: string, optionsOrWork: unknown, maybeWork?: (lock: unknown) => Promise<unknown>) {
    const lockOptions = optionsOrWork as { ifAvailable?: boolean; signal?: AbortSignal }
    if (lockOptions.ifAvailable && lockOptions.signal) return Promise.reject(new DOMException('ifAvailable and signal cannot be combined', 'NotSupportedError'))
    const work = (maybeWork || optionsOrWork) as (lock: unknown) => Promise<unknown>
    if ((optionsOrWork as { ifAvailable?: boolean })?.ifAvailable && held.has(name)) return Promise.resolve(work(null))
    return new Promise((resolve, reject) => {
      const run = () => {
        held.add(name)
        Promise.resolve(work({ name })).then(resolve, reject).finally(() => { held.delete(name); queues.get(name)?.shift()?.() })
      }
      if (held.has(name)) { const queue = queues.get(name) || []; queue.push(run); queues.set(name, queue) } else run()
    })
  } }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } })
  const otherTab = await import('../src/shared/api/ai-operation-api.ts?browser-tab=other')
  let posts = 0, gets = 0, id = '', finish!: (response: Response) => void, ready!: () => void
  const dispatched = new Promise<void>(resolve => { ready = resolve })
  const transport = async (_target: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; id = new Headers(init.headers).get('x-ai-operation-id')!; return new Promise<Response>(resolve => { finish = resolve; ready() }) }
    gets++; return terminal(id)
  }
  try {
    const first = operationResponse(path, options, transport)
    await dispatched
    const second = otherTab.operationResponse(path, options, transport)
    await new Promise(resolve => setTimeout(resolve, 5))
    finish(Response.json({ prompt: '保留草稿' }))
    const results = await Promise.all([first, second])
    assert.deepEqual(await results[0].json(), { prompt: '保留草稿' }); assert.deepEqual(await results[1].json(), { prompt: '保留草稿' })
    assert.equal(posts, 1); assert.equal(gets, 1)
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator') }
})


test('existing domain idempotency owners keep independent same-body candidates and explicit operation headers', async () => {
  const original = globalThis.fetch, identities: string[] = []
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    identities.push(headers.get('Idempotency-Key') || headers.get('x-ai-operation-id')!)
    assert.equal(pending().length, 0, 'the existing owner does not create another client intent')
    return Response.json({ id: identities.at(-1) })
  }
  try {
    const same = { method: 'POST', body: JSON.stringify({ prompt: '相同候选输入' }) }
    const results = await Promise.all(['candidate_0', 'candidate_1', 'candidate_2'].map(key => api<{ id: string }>('/projects/project/generate', { ...same, headers: { 'Idempotency-Key': key } })))
    assert.deepEqual(results.map(row => row.id), ['candidate_0', 'candidate_1', 'candidate_2'])
    await api(path, { ...same, headers: { 'x-ai-operation-id': 'existing-explicit-owner' } })
    assert.equal(identities.at(-1), 'existing-explicit-owner')
  } finally { globalThis.fetch = original }
})


test('a coalesced caller cancels independently while the original request continues', async () => {
  let finish!: (response: Response) => void, ready!: () => void, posts = 0
  const dispatched = new Promise<void>(resolve => { ready = resolve })
  const first = operationResponse(path, options, async () => { posts++; return new Promise<Response>(resolve => { finish = resolve; ready() }) })
  await dispatched
  const controller = new AbortController()
  const second = operationResponse(path, { ...options, signal: controller.signal }, async () => { throw new Error('duplicate dispatch') })
  controller.abort()
  await assert.rejects(second, { name: 'AbortError' })
  assert.equal(posts, 1); assert.equal(pending().length, 1)
  finish(Response.json({ prompt: '原请求继续完成' }))
  assert.equal((await (await first).json()).prompt, '原请求继续完成')
})

test('a browser-tab lock waiter passes its own signal and cancels before the lock holder completes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const controller = new AbortController(); let queued = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request(_name: string, lockOptions: { ifAvailable?: boolean; signal?: AbortSignal }, work: (lock: unknown) => unknown) {
      if (lockOptions.ifAvailable && lockOptions.signal) return Promise.reject(new DOMException('ifAvailable and signal cannot be combined', 'NotSupportedError'))
      if (lockOptions.ifAvailable) return Promise.resolve(work(null))
      queued = true; assert.equal(lockOptions.signal, controller.signal)
      return new Promise((_resolve, reject) => lockOptions.signal!.addEventListener('abort', () => reject(lockOptions.signal!.reason), { once: true }))
    },
  } } })
  try {
    const response = operationResponse(path, { ...options, signal: controller.signal }, async () => { throw new Error('waiter must not dispatch') })
    for (let index = 0; !queued && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(queued, true); controller.abort()
    await assert.rejects(response, { name: 'AbortError' })
    // Settlement releases this tab's local in-flight slot immediately.
    Reflect.deleteProperty(globalThis, 'navigator')
    const next = await operationResponse(path, options, async () => Response.json({ prompt: '独立新操作' }))
    assert.equal((await next.json()).prompt, '独立新操作')
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator') }
})


test('cancellation after response headers stops body observation and late bytes retain the original identity', async () => {
  const controller = new AbortController(); let body!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void
  const dispatched = new Promise<void>(resolve => { ready = resolve })
  const response = operationResponse(path, { ...options, signal: controller.signal }, async () => {
    const result = new Response(new ReadableStream<Uint8Array>({ start(value) { body = value } }), { headers: { 'Content-Type': 'application/json' } })
    ready(); return result
  })
  await dispatched; const id = saved().id; controller.abort()
  await assert.rejects(response, { name: 'AbortError' })
  body.enqueue(new TextEncoder().encode(JSON.stringify({ prompt: '迟到正文' }))); body.close()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(saved().id, id, 'ignored late delivery cannot clear uncertain identity')
  const recovered = await operationResponse(path, options, async (_target, init) => { assert.equal(init?.method, undefined); return terminal(id) })
  assert.equal((await recovered.json()).prompt, '保留草稿')
})

test('malformed POST bodies recover the original completed operation without repeating paid dispatch', async t => {
  for (const raw of ['<!doctype html><title>Bad gateway</title>', '{"prompt":"truncated']) await t.test(raw.startsWith('<') ? 'proxy HTML' : 'truncated JSON', async () => {
    values.clear()
    let id = '', posts = 0, gets = 0
    const response = await operationResponse(path, options, async (target, init) => {
      if (init?.method === 'POST') {
        posts++; id = new Headers(init.headers).get('x-ai-operation-id')!
        return new Response(raw, { status: 502 })
      }
      gets++; assert.equal(target, `/ai-operations/${id}`)
      assert.equal(saved().id, id, 'malformed delivery retains the original identity while observing')
      return terminal(id)
    })
    assert.deepEqual(await response.json(), { prompt: '保留草稿' })
    assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(pending().length, 0)
  })
})

test('malformed POST and lookup bodies retain uncertain identity across explicit repeats', async () => {
  let id = '', posts = 0, gets = 0
  const transport = async (target: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++; id = new Headers(init.headers).get('x-ai-operation-id')!
      return new Response('{"prompt":"truncated', { status: 200 })
    }
    gets++; assert.equal(target, `/ai-operations/${id}`)
    return new Response('<html>lookup gateway unavailable</html>', { status: 502 })
  }
  const first = await operationResponse(path, options, transport)
  assert.equal((await first.json()).code, 'ai_operation_uncertain')
  assert.equal(saved().id, id)
  const second = await operationResponse(path, options, transport)
  assert.equal((await second.json()).code, 'ai_operation_uncertain')
  assert.equal(saved().id, id)
  assert.equal(posts, 1); assert.equal(gets, 2, 'explicit repeat only observes the saved operation')
})

test('interrupted operations recover only complete retained candidates through the original GET identity', async t => {
  for (const available of [true, false]) await t.test(available ? 'retained clip candidate' : 'no complete candidate', async () => {
    values.clear()
    let posts = 0
    await operationResponse(path, options, async (_target, init) => {
      if (init?.method === 'POST') posts++
      throw new Error('delivery interrupted')
    })
    const id = saved().id, candidate = { shots: [{ title: '保留镜头', prompt: '完整片段候选' }], directing_review: { status: 'inconclusive', repaired: false, issues: [] } }
    let gets = 0
    const response = await operationResponse(path, options, async (target, init) => {
      assert.equal(init?.method, undefined, 'recovery never dispatches a paid POST')
      assert.equal(target, `/ai-operations/${id}`); gets++
      return Response.json({ id, route: path, state: 'interrupted', status_code: null, ...(available ? { candidate } : {}) })
    })
    const body = await response.json()
    if (available) { assert.deepEqual(body, candidate); assert.equal(body.directing_review.review_id, undefined) }
    else { assert.equal(body.code, 'ai_operation_uncertain'); assert.equal(saved().id, id) }
    assert.equal(posts, 1); assert.equal(gets, 1)
  })
})
