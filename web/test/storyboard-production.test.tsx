import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, ScriptCanvasResult } from '../src/shared/api/api'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import { assertStoryboardProductionScope } from '../src/features/storyboard/storyboard-production'
import { rememberModelSelection } from '../src/features/models/model-selection-store'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const { default: StoryboardProductionDialog } = await import('../src/features/storyboard/StoryboardProductionDialog')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())
const models = [{ id: 'ordinary-text', name: '普通文本', enabled: true, modality: 'text' },
  { id: 'default-text', name: '默认文本', enabled: true, modality: 'text', is_default: true },
  { id: 'disabled-text', name: '已停用', enabled: false, modality: 'text' },
  { id: 'image', name: '图片模型', enabled: true, modality: 'image' }] as Model[]
const detail = { id: 'project', shots: [{ id: 'shot', source_scene_id: 'scene', design_id: 'design', deleted_at: null, superseded_by: null }],
  script: { scenes: [{ id: 'scene' }] } } as unknown as ProjectDetail
const signature = 'a'.repeat(64)
const result = { scene_ids: ['scene'], design_id: 'design', target_canvas_id: 'new-canvas', shots: detail.shots, visual_profiles: [],
  shot_visual_bindings: [], created_shots: 0, created_profiles: 0 } as ScriptCanvasResult
function button(text: string) { const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text); assert.ok(value, text); return value }
async function mount(options: { models?: Model[]; complete?: (result: ScriptCanvasResult) => void | Promise<void>; cancel?: () => void; designId?: string | null; sceneIds?: string[]; shotIds?: string[] } = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><StoryboardProductionDialog projectId="project" sceneIds={options.sceneIds || ['scene']} shotIds={options.shotIds || ['shot']} designId={options.designId === undefined ? 'design' : options.designId}
    models={options.models || models} onComplete={options.complete || (() => {})} onCancel={options.cancel || (() => {})} /></MantineProvider>))
  return { destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
type Request = { path: string; body?: any }
function mockRequests(t: { mock: { method: Function } }, options: { needsAnalysis?: boolean; project?: ProjectDetail; prepare?: () => Promise<Response>; referenceCommit?: () => Response; management?: ShotManagementSnapshot } = {}) {
  const requests: Request[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path === '/api/projects/project') return Response.json(options.project || detail)
    if (path.endsWith('/shot-management') && options.management) return Response.json(options.management)
    if (path.endsWith('/script/canvas/check')) return Response.json({ signature, scene_ids: body.scene_ids, needs_analysis: options.needsAnalysis ? body.scene_ids : [] })
    if (path.endsWith('/script/canvas/prepare')) return options.prepare ? options.prepare() : Response.json({ signature, scene_ids: body.scene_ids, profiles: [], reference_usage_version: 1 })
    if (path.endsWith('/script/canvas/commit')) return options.referenceCommit ? options.referenceCommit() : Response.json(result)
    if (path.endsWith('/storyboard/canvas')) return Response.json(result)
    throw new Error(`Unexpected ${path}`)
  })
  return requests
}

test('production opens without requests and defaults to the preferred enabled text model', async t => {
  const requests = mockRequests(t)
  const view = await mount()
  try {
    assert.deepEqual(requests, [])
    assert.equal((document.querySelector('input[aria-label="整理参考设定文本模型"]') as HTMLInputElement).value, '默认文本')
    assert.match(document.body.textContent!, /1 个镜头/)
    assert.match(document.body.textContent!, /1 场/)
    assert.equal(button('准备并加入画布').disabled, false)
  } finally { await view.destroy() }
})

test('production freezes in-flight references and clears a cached preparation after an external model change', async t => {
  let finishPrepare!: (response: Response) => void, prepares = 0, commits = 0
  const requests = mockRequests(t, { needsAnalysis: true,
    prepare: () => ++prepares === 1 ? new Promise<Response>(resolve => { finishPrepare = resolve }) : Promise.resolve(Response.json({ signature, scene_ids: ['scene'], profiles: [] })),
    referenceCommit: () => ++commits === 1 ? Response.json({ detail: '保存暂不可用' }, { status: 503 }) : Response.json(result),
  })
  const view = await mount()
  try {
    const selected = () => document.querySelector<HTMLInputElement>('[aria-label="整理参考设定文本模型"]')!
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    await act(() => rememberModelSelection('text', 'ordinary-text'))
    assert.equal(selected().value, '默认文本')
    await act(async () => finishPrepare(Response.json({ signature, scene_ids: ['scene'], profiles: [] })))
    assert.equal(selected().value, '普通文本')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /保存暂不可用/)
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.filter(request => request.path.endsWith('/canvas/prepare')).map(request => request.body.model_id), ['default-text', 'ordinary-text'])
    assert.equal(button('已加入画布').disabled, true)
    await act(() => rememberModelSelection('text', 'default-text'))
    assert.equal(selected().value, '普通文本', 'a completed import keeps its preparation model')
  } finally { await view.destroy() }
})

test('prepared references can go to production without any text model and preserve the selected shot scope', async t => {
  const requests = mockRequests(t), completed: ScriptCanvasResult[] = []
  const view = await mount({ models: [], complete: value => { completed.push(value) } })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.map(request => request.path), ['/api/projects/project', '/api/projects/project/script/canvas/check', '/api/projects/project/script/storyboard/canvas'])
    assert.deepEqual(requests[1].body, { scene_ids: ['scene'], design_id: 'design' })
    assert.deepEqual(requests[2].body, { scene_ids: ['scene'], shot_ids: ['shot'], design_id: 'design', mode: 'existing' })
    assert.deepEqual(completed, [result])
  } finally { await view.destroy() }
})

test('production prepares references with automatic skill selection and commits before importing the saved plan', async t => {
  const requests = mockRequests(t, { needsAnalysis: true })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.map(request => request.path.split('/').slice(-2).join('/')), ['projects/project', 'canvas/check', 'canvas/prepare', 'canvas/commit', 'storyboard/canvas'])
    assert.deepEqual(requests[2].body, { scene_ids: ['scene'], design_id: 'design', signature, model_id: 'default-text' })
    assert.deepEqual(requests[3].body, { scene_ids: ['scene'], design_id: 'design', signature, profiles: [], reference_usage_version: 1 })
    assert.ok(requests.every(request => !request.path.includes('/generate')))
  } finally { await view.destroy() }
})

test('obsolete selected shots are rejected before checking or preparing another active design', async t => {
  const requests = mockRequests(t, { project: { ...detail, shots: [{ ...detail.shots[0], design_id: 'replacement-design' }] } })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 1)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /当前|更新/)
  } finally { await view.destroy() }
})

test('production preserves explicit visual coverage when committing a prepared plan', async t => {
  const visual_coverage = [{ scene_id: 'scene', shot_id: 'shot', source_excerpt: '无人月台', objects: [], no_reference_reason: '只有一次性远景，无可复用对象。' }]
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => Response.json({
    signature, scene_ids: ['scene'], profiles: [], reference_usage_version: 1, coverage_version: 1, visual_coverage,
  }) })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const commit = requests.find(request => request.path.endsWith('/canvas/commit'))!
    assert.equal(commit.body.coverage_version, 1)
    assert.deepEqual(commit.body.visual_coverage, visual_coverage)
  } finally { await view.destroy() }
})

test('missing references require a text model before any model or commit request', async t => {
  const requests = mockRequests(t, { needsAnalysis: true })
  const view = await mount({ models: [] })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 2)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /启用.*文本模型/)
  } finally { await view.destroy() }
})

test('a failed handoff retries only the cached result without preparing or creating a canvas again', async t => {
  const requests = mockRequests(t); let completes = 0
  const view = await mount({ complete: async value => { assert.deepEqual(value, result); if (++completes === 1) throw new Error('刷新画布失败') } })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /刷新画布失败/)
    const requestCount = requests.length
    await act(async () => button('重试打开画布').click())
    assert.equal(requests.length, requestCount)
    assert.equal(completes, 2)
  } finally { await view.destroy() }
})

test('cancelling reference generation ignores a late result and never commits or hands off', async t => {
  let resolvePrepare!: (response: Response) => void, completed = 0, cancelled = 0
  const requests = mockRequests(t, { needsAnalysis: true, prepare: () => new Promise(resolve => { resolvePrepare = resolve }) })
  const view = await mount({ complete: () => { completed++ }, cancel: () => { cancelled++ } })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 3)
    await act(() => button('取消整理').click())
    assert.equal(cancelled, 1)
    await act(async () => resolvePrepare(Response.json({ signature, scene_ids: ['scene'], profiles: [] })))
    assert.equal(requests.length, 3)
    assert.equal(completed, 0)
  } finally { await view.destroy() }
})

test('unmounting while validating selection isolates a late project response', async t => {
  let resolveProject!: (response: Response) => void, completed = 0
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    paths.push(String(url)); return new Promise<Response>(resolve => { resolveProject = resolve })
  })
  const view = await mount({ complete: () => { completed++ } })
  await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
  await view.destroy()
  await act(async () => resolveProject(Response.json(detail)))
  assert.deepEqual(paths, ['/api/projects/project'])
  assert.equal(completed, 0)
})

test('reference commit failures reuse the preparation when its source signature is unchanged', async t => {
  let commits = 0
  const requests = mockRequests(t, { needsAnalysis: true, referenceCommit: () => ++commits === 1
    ? Response.json({ message: '暂时无法保存参考设定' }, { status: 503 }) : Response.json(result) })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /暂时无法保存/)
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.filter(request => request.path.endsWith('/canvas/prepare')).length, 1)
    assert.equal(requests.filter(request => request.path.endsWith('/canvas/commit')).length, 2)
    assert.equal(requests.filter(request => request.path.endsWith('/storyboard/canvas')).length, 1)
  } finally { await view.destroy() }
})

test('a reference commit locks closing and repeated confirmation until the write finishes', async t => {
  let resolveCommit!: (response: Response) => void, commits = 0, cancelled = 0
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url); requests.push(path)
    if (path === '/api/projects/project') return Response.json(detail)
    if (path.endsWith('/canvas/check')) return Response.json({ signature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/canvas/prepare')) return Response.json({ signature, scene_ids: ['scene'], profiles: [] })
    if (path.endsWith('/canvas/commit')) { commits++; return new Promise<Response>(resolve => { resolveCommit = resolve }) }
    if (path.endsWith('/storyboard/canvas')) return Response.json(result)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ cancel: () => { cancelled++ } })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(button('取消').disabled, true)
    assert.equal(button('关闭分镜制作准备').disabled, true)
    const primary = document.querySelector<HTMLButtonElement>('.storyboard-production-primary')
    assert.ok(primary)
    assert.equal(primary.disabled, true)
    assert.match(primary.textContent || '', /保存中|整理中|检查中|打开中/)
    await act(() => { primary.click(); button('取消').click() })
    assert.equal(commits, 1)
    assert.equal(cancelled, 0)
    await act(async () => resolveCommit(Response.json(result)))
    assert.equal(requests.filter(path => path.endsWith('/storyboard/canvas')).length, 1)
    assert.equal(button('已加入画布').disabled, true)
  } finally { await view.destroy() }
})


const historicalShot = { ...detail.shots[0], project_id: 'project', superseded_by: 'replacement-design' }
const laterDetail = { ...detail, shots: [{ ...detail.shots[0], id: 'new-shot', design_id: 'replacement-design' }], historical_shots: [historicalShot] }
function pendingSnapshot(): ShotManagementSnapshot {
  return { revision: 'pending', designs: [{ id: 'design', name: '先保存的方案A', canvas_id: null, canvas_pending: true }, { id: 'replacement-design', name: '后保存的方案B', canvas_id: null, canvas_pending: true }],
    shots: [{ shot: historicalShot, design_name: '先保存的方案A', canvas_refs: [], asset_count: 0, deleted_at: null, delete_blockers: [] }], scenes: [], canvases: [], trashed_assets: [] }
}

test('a verified historical pending design prepares its own references after another plan was saved', async t => {
  const requests = mockRequests(t, { project: laterDetail, management: pendingSnapshot(), needsAnalysis: true })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.map(request => request.path.split('/').slice(-2).join('/')), ['projects/project', 'project/shot-management', 'canvas/check', 'canvas/prepare', 'canvas/commit', 'storyboard/canvas'])
    for (const request of requests.filter(request => /\/script\/canvas\/(check|prepare|commit)$/.test(request.path))) assert.equal(request.body.design_id, 'design')
    assert.deepEqual(requests.at(-1)!.body, { scene_ids: ['scene'], shot_ids: ['shot'], design_id: 'design', mode: 'existing' })
    assert.equal(document.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})

test('a historical design with an existing canvas prepares a later scene using the same explicit design', async t => {
  const secondShot = { ...historicalShot, id: 'second-shot', source_scene_id: 'second-scene' }
  const management = pendingSnapshot()
  management.designs[0] = { ...management.designs[0], canvas_id: 'first-scene-canvas', canvas_pending: false }
  management.canvases = [{ id: 'first-scene-canvas', name: '方案A画布' }]
  management.shots.push({ ...management.shots[0], shot: secondShot })
  const project = { ...laterDetail, script: { ...laterDetail.script, scenes: [...laterDetail.script.scenes, { id: 'second-scene' }] },
    historical_shots: [historicalShot, secondShot] } as ProjectDetail
  const requests = mockRequests(t, { project, management, needsAnalysis: true })
  const view = await mount({ sceneIds: ['second-scene'], shotIds: ['second-shot'] })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.map(request => request.path.split('/').slice(-2).join('/')), ['projects/project', 'project/shot-management', 'canvas/check', 'canvas/prepare', 'canvas/commit', 'storyboard/canvas'])
    const references = requests.filter(request => /\/script\/canvas\/(check|prepare|commit)$/.test(request.path))
    assert.equal(references.length, 3)
    for (const request of references) {
      assert.equal(request.body.design_id, 'design')
      assert.deepEqual(request.body.scene_ids, ['second-scene'])
    }
    assert.deepEqual(requests.at(-1)!.body, { scene_ids: ['second-scene'], shot_ids: ['second-shot'], design_id: 'design', mode: 'existing' })
    assert.equal(document.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})

test('a historical design whose linked canvas is missing is rejected before any reference request', async t => {
  const management = pendingSnapshot(); management.designs[0] = { ...management.designs[0], canvas_pending: false, canvas_id: 'deleted-canvas' }
  management.canvases = [{ id: 'replacement-canvas', name: '另一方案画布' }]
  const requests = mockRequests(t, { project: laterDetail, management })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 2)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /方案|更新/)
    assert.throws(() => assertStoryboardProductionScope(laterDetail, 'project', ['scene'], ['shot'], 'design'))
  } finally { await view.destroy() }
})

test('a target shot moved to a different design is rejected before reference preparation', async t => {
  const management = pendingSnapshot(); management.shots[0].shot = { ...historicalShot, design_id: 'replacement-design' }
  const requests = mockRequests(t, { project: laterDetail, management, needsAnalysis: true })
  const view = await mount()
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 2)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /方案|更新/)
  } finally { await view.destroy() }
})


test('base-plan production preserves the existing reference API contract without a design parameter', async t => {
  const requests = mockRequests(t, { project: { ...detail, shots: [{ ...detail.shots[0], design_id: null }] }, needsAnalysis: true })
  const view = await mount({ designId: null })
  try {
    await act(async () => { button('准备并加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const references = requests.filter(request => /\/script\/canvas\/(check|prepare|commit)$/.test(request.path))
    assert.equal(references.length, 3)
    assert.ok(references.every(request => !Object.hasOwn(request.body, 'design_id')))
    assert.equal(requests.at(-1)!.body.design_id, null)
  } finally { await view.destroy() }
})

test('deleted or foreign historical entries cannot use pending-plan permission', () => {
  const cases = [
    (snapshot: ShotManagementSnapshot) => { snapshot.shots[0].deleted_at = '2026-11-03' },
    (snapshot: ShotManagementSnapshot) => { snapshot.shots[0].shot = { ...historicalShot, project_id: 'other-project' } },
    (snapshot: ShotManagementSnapshot) => { snapshot.shots[0].shot = { ...historicalShot, source_scene_id: 'other-scene' } },
  ]
  for (const change of cases) {
    const snapshot = pendingSnapshot(); change(snapshot)
    assert.throws(() => assertStoryboardProductionScope(laterDetail, 'project', ['scene'], ['shot'], 'design', snapshot), /方案|更新/)
  }
})

test('historical permission validates every selected current and historical shot against the fresh snapshot', () => {
  const currentShot = { ...historicalShot, id: 'current-shot', source_scene_id: 'second-scene', superseded_by: null }
  const project = { ...laterDetail, shots: [currentShot], script: { ...laterDetail.script, scenes: [...laterDetail.script.scenes, { id: 'second-scene' }] } } as ProjectDetail
  const snapshot = pendingSnapshot()
  snapshot.shots.push({ ...snapshot.shots[0], shot: currentShot })
  const validate = (freshProject: ProjectDetail, freshSnapshot: ShotManagementSnapshot) => assertStoryboardProductionScope(freshProject, 'project', ['scene', 'second-scene'], ['shot', 'current-shot'], 'design', freshSnapshot)
  assert.doesNotThrow(() => validate(project, snapshot))
  const changes = [
    (fresh: ShotManagementSnapshot) => { fresh.shots[1].shot.project_id = 'another-project' },
    (fresh: ShotManagementSnapshot) => { fresh.shots[1].shot.design_id = 'replacement-design' },
    (fresh: ShotManagementSnapshot) => { fresh.shots[1].deleted_at = '2026-11-03' },
    (fresh: ShotManagementSnapshot) => { fresh.shots[0].shot.source_scene_id = 'second-scene' },
  ]
  for (const change of changes) {
    const fresh = structuredClone(snapshot); change(fresh)
    assert.throws(() => validate(project, fresh), /方案|更新/)
  }
  const foreignHistorical = { ...project, historical_shots: [{ ...historicalShot, project_id: 'another-project' }] }
  assert.throws(() => validate(foreignHistorical, snapshot), /方案|更新/)
})
