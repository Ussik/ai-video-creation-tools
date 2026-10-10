import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, StrictMode } from 'react'
import type { ProjectDetail } from '../src/api'
import { shareProjectSnapshot } from '../src/project-snapshot'
import { useProjectDetailRefresh } from '../src/useProjectDetailRefresh'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

function snapshot(id = 'a'): ProjectDetail {
  return {
    id, name: '项目', brief: '简介', ratio: '16:9', music_asset_id: null,
    created_at: '2026-10-09', updated_at: '2026-10-09',
    production_range: { start_shot_id: null, end_shot_id: null },
    script: { outline: '大纲', characters: '人物', scenes: [], artifacts: [], generation_options: { genre: '悬疑' } },
    shots: [], timeline_clips: [], asset_reviews: [], assets: [], asset_tasks: [],
    visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
    jobs: [{ id: 'job', project_id: id, shot_id: null, model_id: null, job_type: 'generation', request: '{}',
      status: 'queued', external_id: null, result_asset_id: null, recovery_available: false, error: null, created_at: '2026-10-09' }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

async function mount(projectId: string | null = 'a', strict = false) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let state!: ReturnType<typeof useProjectDetailRefresh>
  const committedDetails: Array<ProjectDetail | null> = []
  function Harness({ id }: { id: string | null }) {
    state = useProjectDetailRefresh(id)
    React.useEffect(() => { committedDetails.push(state.detail) }, [state.detail])
    return <span>{state.detail?.id || ''}</span>
  }
  const render = async (id: string | null) => {
    await act(() => root.render(strict ? <StrictMode><Harness id={id} /></StrictMode> : <Harness id={id} />))
  }
  await render(projectId)
  let destroyed = false
  return {
    current: () => state,
    committedDetails,
    render,
    destroy: async () => {
      if (destroyed) return
      destroyed = true
      await act(() => root.unmount())
      container.remove()
    },
  }
}

test('identical JSON snapshots preserve the root and every nested reference', () => {
  const previous = snapshot()
  assert.equal(shareProjectSnapshot(previous, snapshot()), previous)
  assert.equal(shareProjectSnapshot(null, previous), previous)
  const otherProject = snapshot('b')
  assert.equal(shareProjectSnapshot(previous, otherProject), otherProject)
})

test('real detail and job changes replace only the changed JSON branches', () => {
  const previous = snapshot()
  const incoming = snapshot()
  incoming.name = '新名称'
  incoming.jobs[0].status = 'running'
  incoming.script.generation_options.genre = '科幻'
  const next = shareProjectSnapshot(previous, incoming)
  assert.notEqual(next, previous)
  assert.equal(next.name, '新名称')
  assert.notEqual(next.jobs, previous.jobs)
  assert.notEqual(next.jobs[0], previous.jobs[0])
  assert.equal(next.jobs[0].status, 'running')
  assert.notEqual(next.script, previous.script)
  assert.notEqual(next.script.generation_options, previous.script.generation_options)
  assert.equal(next.script.scenes, previous.script.scenes)
  assert.equal(next.assets, previous.assets)
  assert.equal(next.production_range, previous.production_range)
  assert.equal(previous.jobs[0].status, 'queued', 'sharing never mutates the old snapshot')

  const removed = snapshot()
  delete removed.script.artifacts
  removed.jobs = []
  const withRemovedFields = shareProjectSnapshot(previous, removed)
  assert.equal(Object.hasOwn(withRemovedFields.script, 'artifacts'), false)
  assert.deepEqual(withRemovedFields.jobs, [])
  assert.equal(withRemovedFields.assets, previous.assets)
})

test('an identical poll keeps detail identity and genuine job progress still commits', async t => {
  const responses = [snapshot(), snapshot(), snapshot()]
  responses[2].jobs[0].status = 'running'
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()))
  const view = await mount()
  try {
    await act(async () => { await view.current().refreshDetail() })
    const first = view.current().detail!
    const commits = view.committedDetails.length
    await act(async () => { await view.current().refreshDetail() })
    assert.equal(view.current().detail, first)
    assert.equal(view.committedDetails.length, commits)
    await act(async () => { await view.current().refreshDetail() })
    assert.equal(view.current().detail?.jobs[0].status, 'running')
    assert.equal(view.current().detail?.script, first.script)
    assert.equal(view.current().detail?.assets, first.assets)
  } finally { await view.destroy() }
})

test('out-of-order responses cannot overwrite the latest requested snapshot', async t => {
  const responses = [deferred<Response>(), deferred<Response>()]
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => responses[calls++].promise)
  const view = await mount()
  try {
    const first = view.current().refreshDetail()
    const second = view.current().refreshDetail()
    const newest = snapshot(); newest.jobs[0].status = 'running'
    await act(async () => { responses[1].resolve(Response.json(newest)); await second })
    const accepted = view.current().detail
    await act(async () => { responses[0].resolve(Response.json(snapshot())); assert.equal(await first, undefined) })
    assert.equal(view.current().detail, accepted)
    assert.equal(view.current().detail?.jobs[0].status, 'running')
  } finally { await view.destroy() }
})

test('an old project callback neither fetches nor invalidates the active project request', async t => {
  const response = deferred<Response>()
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', (url: unknown) => { paths.push(String(url)); return response.promise })
  const view = await mount()
  try {
    const refresh = view.current().refreshDetail
    const oldCallback = () => refresh('a')
    await view.render('b')
    assert.equal(view.current().refreshDetail, refresh, 'the refresh callback stays stable across project changes')
    const active = refresh()
    assert.equal(await oldCallback(), undefined)
    assert.deepEqual(paths, ['/api/projects/b'])
    await act(async () => { response.resolve(Response.json(snapshot('b'))); await active })
    assert.equal(view.current().detail?.id, 'b')
  } finally { await view.destroy() }
})

test('a project switch invalidates in-flight responses even after returning to the old ID', async t => {
  const responses = [deferred<Response>(), deferred<Response>()]
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => responses[calls++].promise)
  const view = await mount()
  try {
    const old = view.current().refreshDetail()
    await view.render('b')
    await view.render('a')
    const current = view.current().refreshDetail()
    await act(async () => { responses[0].resolve(Response.json(snapshot())); assert.equal(await old, undefined) })
    assert.equal(view.current().detail, null)
    const latest = snapshot(); latest.name = '本次项目'
    await act(async () => { responses[1].resolve(Response.json(latest)); await current })
    assert.equal(view.current().detail?.name, '本次项目')
  } finally { await view.destroy() }
})

test('null project selection and mismatched response IDs cannot publish detail', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => { paths.push(String(url)); return Response.json(snapshot('b')) })
  const view = await mount(null)
  try {
    assert.equal(await view.current().refreshDetail(), undefined)
    assert.deepEqual(paths, [])
    await view.render('a')
    await act(async () => { assert.equal(await view.current().refreshDetail(), undefined) })
    assert.equal(view.current().detail, null)
  } finally { await view.destroy() }
})

test('unmount invalidates pending responses and callbacks cannot fetch afterward', async t => {
  const response = deferred<Response>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return response.promise })
  const view = await mount()
  const refresh = view.current().refreshDetail
  const pending = refresh()
  await view.destroy()
  response.resolve(Response.json(snapshot()))
  assert.equal(await pending, undefined)
  assert.equal(await refresh(), undefined)
  assert.equal(calls, 1)
  assert.deepEqual(view.committedDetails, [null])
})

test('StrictMode cleanup leaves the remounted hook able to refresh', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  const view = await mount('a', true)
  try {
    await act(async () => { await view.current().refreshDetail() })
    assert.equal(view.current().detail?.id, 'a')
  } finally { await view.destroy() }
})

test('active request errors propagate while obsolete project errors are ignored', async t => {
  const responses = [deferred<Response>(), deferred<Response>()]
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => responses[calls++].promise)
  const view = await mount()
  try {
    const obsolete = view.current().refreshDetail()
    await view.render('b')
    responses[0].reject(new Error('old project failure'))
    assert.equal(await obsolete, undefined)
    const active = view.current().refreshDetail()
    responses[1].reject(new Error('active failure'))
    await assert.rejects(active, /active failure/)
  } finally { await view.destroy() }
})
