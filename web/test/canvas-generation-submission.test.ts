import assert from 'node:assert/strict'
import test from 'node:test'
import { canvasGenerationSubmissionFinished, canvasGenerationSubmissionStorageKey, createCanvasGenerationSubmission,
  persistCanvasGenerationSubmission, readCanvasGenerationSubmission, recoverCanvasGenerationSubmission,
  withCanvasGenerationSubmissionLock } from '../src/features/canvas/canvas-generation-submission'

const scope = { projectId: 'project', canvasId: 'canvas', nodeId: 'node' }
const input = { ...scope, sourceSignature: 'original inputs', baselineJobId: null, candidateCount: 3,
  request: { model_id: 'model', prompt: '完整提示词 [[ref:image]]', reference_asset_ids: ['image'], shot_id: 'shot', duration: 5 } }
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}
const job = (id: string) => ({ id, status: 'queued' })
const keyOf = (init?: RequestInit) => new Headers(init?.headers).get('Idempotency-Key')!
const statusError = (status: number) => Object.assign(new Error(`rejected ${status}`), { status })

test('fixed intent preserves its full request, ordered references and distinct candidate identities', () => {
  const store = storage(), mutable = structuredClone(input)
  const item = createCanvasGenerationSubmission(mutable, store)
  mutable.request.prompt = 'new intention'; mutable.request.reference_asset_ids.push('later')
  assert.deepEqual(readCanvasGenerationSubmission(scope, store)?.request, input.request)
  assert.equal(new Set(item.candidates.map(value => value.key)).size, 3)
  assert.equal(createCanvasGenerationSubmission({ ...input, request: { ...input.request, prompt: 'changed' } }, store).id, item.id,
    'unfinished operation survives changed inputs until explicitly resolved')
})

test('read-only recovery resolves accepted candidates without submitting missing candidates', async () => {
  const store = storage(), item = createCanvasGenerationSubmission(input, store), paths: string[] = []
  const result = await recoverCanvasGenerationSubmission(item, { storage: store, api: async <T>(path: string, init?: RequestInit) => {
    paths.push(path); assert.equal(init?.method || 'GET', 'GET')
    return { job: path.endsWith(item.candidates[0].key) ? job('found') : null } as T
  } })
  assert.equal(paths.length, 3)
  assert.deepEqual(result.candidates.map(value => value.jobId), ['found', null, null])
  assert.equal(canvasGenerationSubmissionFinished(result), false)
})

test('partial acceptance with a lost response resumes only the remaining candidate using original keys and payload', async () => {
  const store = storage(), item = createCanvasGenerationSubmission(input, store)
  const accepted = new Map<string, ReturnType<typeof job>>(), posts: { key: string; body: unknown }[] = []
  let loseResponse = true
  const transport = async <T>(path: string, init?: RequestInit) => {
    if (!init?.method) return { job: accepted.get(path.split('/').at(-1)!) || null } as T
    const key = keyOf(init)
    posts.push({ key, body: JSON.parse(String(init.body)) })
    const created = job(`job-${accepted.size + 1}`); accepted.set(key, created)
    if (accepted.size === 2 && loseResponse) { loseResponse = false; throw new TypeError('response lost') }
    return created as T
  }
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, api: transport, allowSubmit: true }), /response lost/)
  assert.deepEqual(readCanvasGenerationSubmission(scope, store)?.candidates.map(value => value.jobId), ['job-1', 'job-2', null])
  assert.equal(posts.length, 2, 'lost response stops further paid POSTs')
  const result = await recoverCanvasGenerationSubmission(item, { storage: store, api: transport, allowSubmit: true })
  assert.deepEqual(posts.map(value => value.key), item.candidates.map(value => value.key))
  assert.ok(posts.every(value => JSON.stringify(value.body) === JSON.stringify(input.request)))
  assert.equal(canvasGenerationSubmissionFinished(result), true)
})

test('reload preserves unknown attempts even when a later replay receives input rejection', async () => {
  const store = storage(), item = createCanvasGenerationSubmission({ ...input, candidateCount: 1 }, store)
  let attempts = 0
  const transport = async <T>(_path: string, init?: RequestInit) => {
    if (!init?.method) return { job: null } as T
    attempts++; if (attempts === 1) throw new TypeError('unknown acceptance')
    throw statusError(422)
  }
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, api: transport, allowSubmit: true }), /unknown acceptance/)
  assert.equal(readCanvasGenerationSubmission(scope, store)?.inFlightKey, item.candidates[0].key)
  await assert.rejects(recoverCanvasGenerationSubmission(readCanvasGenerationSubmission(scope, store)!, { storage: store, api: transport, allowSubmit: true }), /422/)
  assert.equal(readCanvasGenerationSubmission(scope, store)?.rejected, undefined)
  assert.equal(createCanvasGenerationSubmission({ ...input, sourceSignature: 'edited' }, store).id, item.id)
})

test('a first definitive input rejection records partial acceptance and a deliberate new round uses new identities', async () => {
  const store = storage(), item = createCanvasGenerationSubmission(input, store)
  let posts = 0
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, allowSubmit: true, api: async <T>(_path: string, init?: RequestInit) => {
    if (!init?.method) return { job: null } as T
    if (++posts === 2) throw statusError(422)
    return job('accepted-first') as T
  } }), /422/)
  const rejected = readCanvasGenerationSubmission(scope, store)!
  assert.deepEqual(rejected.candidates.map(value => value.jobId), ['accepted-first', null, null])
  assert.match(rejected.rejected!, /422/)
  const next = createCanvasGenerationSubmission({ ...input, baselineJobId: 'accepted-first' }, store)
  assert.notEqual(next.id, item.id)
  assert.ok(next.candidates.every(value => !item.candidates.some(old => old.key === value.key)))
})

test('shot response loss is recovered by its fixed independent key without creating a generation job', async () => {
  const store = storage(), item = createCanvasGenerationSubmission({ ...input, request: { ...input.request, shot_id: null },
    shotInput: { title: '新镜头', prompt: '完整镜头提示词', duration: 5 } }, store)
  let acceptedShot = false, shotPosts = 0, generationPosts = 0
  const transport = async <T>(path: string, init?: RequestInit) => {
    if (path.includes('/shot-submissions/')) return { shot: acceptedShot ? { id: 'fixed-shot' } : null } as T
    if (path.endsWith('/shots')) { shotPosts++; assert.equal(keyOf(init), item.shot!.key); acceptedShot = true; throw new Error('shot response lost') }
    if (path.endsWith('/generate')) { generationPosts++; return job('later') as T }
    return { job: null } as T
  }
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, api: transport, allowSubmit: true }), /shot response lost/)
  assert.equal(readCanvasGenerationSubmission(scope, store)?.shot?.id, 'fixed-shot')
  await recoverCanvasGenerationSubmission(item, { storage: store, api: transport })
  assert.equal(shotPosts, 1); assert.equal(generationPosts, 0)
})

test('durable failure after acceptance stops the next candidate and leaves the original key recoverable', async () => {
  const store = storage(), item = createCanvasGenerationSubmission(input, store)
  let writesFail = false, posts = 0
  const failing = { getItem: store.getItem, setItem: (key: string, value: string) => {
    if (writesFail) throw new Error('quota exceeded')
    store.setItem(key, value)
  } }
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: failing, allowSubmit: true, api: async <T>(_path: string, init?: RequestInit) => {
    if (!init?.method) return { job: posts ? job('accepted') : null } as T
    posts++; writesFail = true; return job('accepted') as T
  } }), /无法保存生成提交记录/)
  assert.equal(posts, 1)
  assert.equal(readCanvasGenerationSubmission(scope, store)?.inFlightKey, item.candidates[0].key)
  assert.equal(readCanvasGenerationSubmission(scope, store)?.candidates[0].jobId, null)
})

test('a blocked pre-submit storage write prevents all network submissions', () => {
  assert.throws(() => createCanvasGenerationSubmission(input, { getItem: () => null, setItem: () => { throw new Error('disabled') } }), /无法保存生成提交记录/)
})

test('source departure during durable progress stops before the actual POST', async () => {
  const store = storage(), item = createCanvasGenerationSubmission(input, store)
  let active = true, posts = 0
  await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, allowSubmit: true, isActive: () => active,
    onProgress: value => { if (value.inFlightKey) active = false }, api: async <T>(_path: string, init?: RequestInit) => {
      if (init?.method) posts++
      return { job: null } as T
    } }), /已离开来源画布/)
  assert.equal(posts, 0)
})

test('malformed lookup and accepted tombstones never turn into new paid submissions', async () => {
  for (const response of [{}, statusError(409)]) {
    const store = storage(), item = createCanvasGenerationSubmission(input, store)
    let posts = 0
    await assert.rejects(recoverCanvasGenerationSubmission(item, { storage: store, allowSubmit: true,
      api: async <T>(_path: string, init?: RequestInit) => {
        if (init?.method) posts++
        if (response instanceof Error) throw response
        return response as T
      } }))
    assert.equal(posts, 0)
    assert.equal(createCanvasGenerationSubmission({ ...input, sourceSignature: 'changed' }, store).id, item.id)
  }
})

test('paid submission fails closed without Web Locks while read-only recovery remains available', async () => {
  let actions = 0
  await assert.rejects(withCanvasGenerationSubmissionLock(scope, true, async () => { actions++ }, {} as LockManager), /无法保护重复提交/)
  await withCanvasGenerationSubmissionLock(scope, false, async () => { actions++ }, {} as LockManager)
  assert.equal(actions, 1)
})

test('serialized tabs reuse an accepted intent for the same stale node and a current deliberate retry creates a new round', async () => {
  const store = storage(), queue = new Map<string, Promise<unknown>>()
  const locks = { request: (name: string, action: () => Promise<unknown>) => {
    const next = (queue.get(name) || Promise.resolve()).then(action); queue.set(name, next); return next
  } } as LockManager
  let posts = 0
  const action = () => withCanvasGenerationSubmissionLock(scope, true, async () => {
    const item = createCanvasGenerationSubmission({ ...input, candidateCount: 1 }, store)
    return recoverCanvasGenerationSubmission(item, { storage: store, allowSubmit: true, api: async <T>(_path: string, init?: RequestInit) => {
      if (!init?.method) return { job: null } as T
      posts++; return job('one-job') as T
    } })
  }, locks)
  const [first, second] = await Promise.all([action(), action()])
  assert.equal(first.id, second.id); assert.equal(posts, 1)
  const next = createCanvasGenerationSubmission({ ...input, candidateCount: 1, baselineJobId: 'one-job' }, store)
  assert.notEqual(next.id, first.id)
  assert.throws(() => persistCanvasGenerationSubmission(first, store), /记录已变化/)
  assert.equal(JSON.parse(store.getItem(canvasGenerationSubmissionStorageKey(scope))!).id, next.id)
})
