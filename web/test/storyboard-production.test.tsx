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
  const render = async (patch: Partial<typeof options> = {}) => {
    options = { ...options, ...patch }
    await act(async () => root.render(<MantineProvider env="test"><StoryboardProductionDialog projectId="project" sceneIds={options.sceneIds || ['scene']} shotIds={options.shotIds || ['shot']} designId={options.designId === undefined ? 'design' : options.designId}
      models={options.models || models} onComplete={options.complete || (() => {})} onCancel={options.cancel || (() => {})} /></MantineProvider>))
  }
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
type Request = { path: string; body?: any }
function mockRequests(t: { mock: { method: Function } }, options: { needsAnalysis?: boolean; project?: ProjectDetail; prepare?: (init?: RequestInit) => Promise<Response>; referenceCommit?: () => Response; management?: ShotManagementSnapshot } = {}) {
  const requests: Request[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path.endsWith('/canvas/recovery')) return Response.json({ signature, scene_ids: body.scene_ids })
    requests.push({ path, body })
    if (path === '/api/projects/project') return Response.json(options.project || detail)
    if (path.endsWith('/shot-management') && options.management) return Response.json(options.management)
    if (path.endsWith('/script/canvas/check')) return Response.json({ signature, scene_ids: body.scene_ids, needs_analysis: options.needsAnalysis ? body.scene_ids : [] })
    if (path.endsWith('/script/canvas/prepare')) return options.prepare ? options.prepare(init) : Response.json({ signature, scene_ids: body.scene_ids, profiles: [], reference_usage_version: 1 })
    if (path.endsWith('/script/canvas/commit')) return options.referenceCommit ? options.referenceCommit() : Response.json(result)
    if (path.endsWith('/storyboard/canvas')) return Response.json(result)
    throw new Error(`Unexpected ${path}`)
  })
  return requests
}

test('production opens with only a recovery read and defaults to the preferred enabled text model', async t => {
  const requests = mockRequests(t)
  const view = await mount()
  try {
    assert.deepEqual(requests, [])
    assert.equal((document.querySelector('input[aria-label="整理参考设定文本模型"]') as HTMLInputElement).value, '默认文本')
    assert.match(document.body.textContent!, /1 个镜头/)
    assert.match(document.body.textContent!, /1 场/)
    assert.equal(button('加入画布').disabled, false)
  } finally { await view.destroy() }
})

test('stale results show one concise outcome without old reference lists', async t => {
  const caps = { run_id: 'retained-run', state: 'complete', model_id: 'default-text', full_scope: true,
    can_retry_failed: false, retry_reason: '已完成', retryable_unit_keys: [], can_continue: false, continue_reason: '已完成', pending_unit_keys: [],
    can_restart_all: false, restart_reason: '暂无重做额度', requires_confirmation: false,
    adoption: { can_adopt: false, source_matches: false, reason: '当前分镜已更新', completed_profiles: 9, missing_shot_ids: [], can_prepare_current: true, prepare_reason: '', discarded: false },
    budget: { task_requests: 9, task_max_requests: 512, run_requests: 9, run_max_requests: 256, runs: 1, max_runs: 3 } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).endsWith('/canvas/recovery')
    ? Response.json({ signature, scene_ids: ['scene'], preparation: caps, retained_plan: { signature: 'b'.repeat(64), scene_ids: ['scene'], profiles: [{ draft_key: 'old', name: '旧参考', definition: '旧定义' }] } })
    : (() => { throw new Error(`Unexpected ${url}`) })())
  const view = await mount()
  try {
    assert.match(document.querySelector('[aria-label="画布准备结果"]')!.textContent!, /分镜已更新/)
    assert.equal(document.querySelector('.reference-preparation-links'), null)
    assert.equal(document.querySelector('#reference-retained-content'), null)
    assert.equal(button('整理参考').disabled, false)
  } finally { await view.destroy() }
})

const partialUnits = [
  { unit_key: 'PROP-FRIED-NOODLE', name: '炒面', variant: '默认', code: 'visual_profile_locked_field_changed', message: 'private diagnostic attempt 2', retryable: false,
    recovery_type: 'blocked', checkpoint_source: 'original_raw', is_new_model_call: false, attempt: 2, scene_ids: ['scene'], shot_ids: ['shot'],
    recovery: { action: 'retry', model_call: 'required', token: 'b'.repeat(64) } },
  { unit_key: 'PROP-BRONZE-GONG', name: '铜锣', variant: '默认', code: 'visual_profile_pending', message: 'private pending', retryable: false,
    recovery_type: 'none', checkpoint_source: 'none', is_new_model_call: false, attempt: 0, recovery: { action: 'continue', model_call: 'possible' } },
  { unit_key: 'PROP-WOOD-CLAPPER', name: '木梆', variant: '默认', code: 'structured_initial_delivery_pending', message: 'private unknown', retryable: false,
    recovery_type: 'blocked', checkpoint_source: 'none', is_new_model_call: false, attempt: 1, recovery: { action: 'inspect', model_call: 'unknown' } },
]
const partialPlan = () => Response.json({ signature, scene_ids: ['scene'], profiles: [{ draft_key: 'ready-object', name: '已完成对象', variant: '默认' }], status: 'partial', failed_units: partialUnits })

test('one result action retries all three failed objects without per-object rows', async t => {
  const units = partialUnits.map((unit, index) => ({ ...unit, code: 'visual_profile_locked_field_changed',
    recovery: { action: 'retry', model_call: 'required', token: String(index + 1).repeat(64) } }))
  const preparation = { run_id: 'legacy', state: 'partial', model_id: 'default-text', full_scope: false, can_retry_failed: true, retry_reason: '仅重试失败项', retryable_unit_keys: units.map(unit => unit.unit_key),
    can_continue: false, continue_reason: '没有待处理项', pending_unit_keys: [], can_restart_all: true, restart_reason: '仅重新整理所选场次视觉参考', requires_confirmation: false,
    budget: { task_requests: 9, task_max_requests: 512, run_requests: 9, run_max_requests: 256, runs: 1, max_runs: 3 } }
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => Response.json({ signature, scene_ids: ['scene'], profiles: [], status: 'partial', failed_units: units, preparation }) })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const primary = button('重试')
    assert.equal(primary.disabled, false)
    const footer = document.querySelector('.storyboard-production-actions')!
    assert.deepEqual([...footer.querySelectorAll('button')].map(node => node.textContent), ['关闭', '重试'])
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    assert.match(document.querySelector('[aria-label="画布准备结果"]')!.textContent!, /未能加入画布/)
    assert.doesNotMatch(document.body.textContent!, /详情|当前运行请求|运行版本/)
    await act(async () => { primary.click(); primary.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const request = requests.filter(item => item.path.endsWith('/canvas/prepare')).at(-1)!.body
    assert.deepEqual(request.unit_keys, units.map(unit => unit.unit_key))
    assert.deepEqual(request.retry_units, units.map(unit => ({ unit_key: unit.unit_key, token: unit.recovery.token })))
    assert.match(request.request_id, /^[a-f0-9-]{36}$/)
    assert.equal(requests.filter(item => item.path.endsWith('/canvas/prepare')).length, 2)
  } finally { await view.destroy() }
})

test('partial production shows a concise result and retries only eligible failures', async t => {
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => partialPlan() })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const panel = document.querySelector('[aria-label="画布准备结果"]')!
    assert.ok(panel)
    assert.match(panel.textContent!, /未能加入画布/)
    assert.doesNotMatch(panel.textContent!, /炒面|铜锣|木梆|private|attempt|original_raw/)
    const footer = document.querySelector('.storyboard-production-actions')!
    assert.deepEqual([...footer.querySelectorAll('button')].map(node => node.textContent), ['关闭', '重试'])
    assert.equal(button('重试').disabled, false)
    await act(async () => { button('重试').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.filter(item => item.path.endsWith('/canvas/prepare')).at(-1)!.body.unit_keys, ['PROP-FRIED-NOODLE'])
    assert.ok(!requests.some(item => /canvas\/commit|storyboard\/canvas/.test(item.path)))
  } finally { await view.destroy() }
})

test('an object retry is explicit and later closes without dispatching or claiming a canvas import', async t => {
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => partialPlan() })
  let closed = 0
  const view = await mount({ cancel: () => closed++ })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    await act(async () => { button('重试').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const retry = requests.filter(item => item.path.endsWith('/canvas/prepare')).at(-1)!.body
    assert.deepEqual(retry.unit_keys, ['PROP-FRIED-NOODLE'])
    assert.deepEqual(retry.retry_units, [{ unit_key: 'PROP-FRIED-NOODLE', token: 'b'.repeat(64) }])
    const before = requests.length
    await act(() => button('关闭').click())
    assert.equal(requests.length, before)
    assert.equal(closed, 1)
    assert.ok(!requests.some(item => /canvas\/commit|storyboard\/canvas/.test(item.path)))
  } finally { await view.destroy() }
})

test('a disconnected object retry removes stale retry affordances and requires checking the request', async t => {
  let prepares = 0
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => ++prepares === 1 ? partialPlan()
    : Response.json({ code: 'ai_delivery_unknown', outcome_certainty: 'unknown', detail: 'request accepted then disconnected' }, { status: 409 }) })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    await act(async () => { button('重试').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /核对请求记录/)
    assert.equal(document.querySelector('.reference-failure-panel'), null)
    assert.equal(button('重试').disabled, true)
    const before = requests.length
    await act(() => button('重试').click())
    assert.equal(requests.length, before)
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    await act(() => rememberModelSelection('text', 'ordinary-text'))
    assert.equal(selected(), null, 'the running model selector is hidden')
    assert.equal(document.querySelector('.reference-preparation-model'), null, 'running only shows compact activity')
    assert.match(document.querySelector('[aria-label="画布准备进度"]')!.textContent!, /^正在整理参考 · \d+ 秒$/)
    await act(async () => finishPrepare(Response.json({ signature, scene_ids: ['scene'], profiles: [] })))
    assert.equal(selected().value, '普通文本')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /保存暂不可用/)
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.deepEqual(requests.map(request => request.path.split('/').slice(-2).join('/')), ['projects/project', 'canvas/check', 'canvas/prepare', 'canvas/commit', 'storyboard/canvas'])
    assert.match(requests[2].body.request_id, /^[a-f0-9-]{36}$/)
    assert.deepEqual({ ...requests[2].body, request_id: undefined }, { scene_ids: ['scene'], design_id: 'design', signature, model_id: 'default-text', request_id: undefined })
    assert.deepEqual(requests[3].body, { scene_ids: ['scene'], design_id: 'design', signature, profiles: [], reference_usage_version: 1 })
    assert.ok(requests.every(request => !request.path.includes('/generate')))
  } finally { await view.destroy() }
})

test('obsolete selected shots are rejected before checking or preparing another active design', async t => {
  const requests = mockRequests(t, { project: { ...detail, shots: [{ ...detail.shots[0], design_id: 'replacement-design' }] } })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const commit = requests.find(request => request.path.endsWith('/canvas/commit'))!
    assert.equal(commit.body.coverage_version, 1)
    assert.deepEqual(commit.body.visual_coverage, visual_coverage)
  } finally { await view.destroy() }
})

test('missing references require a text model before any model or commit request', async t => {
  const requests = mockRequests(t, { needsAnalysis: true })
  const view = await mount({ models: [] })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 2)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /启用.*文本模型/)
  } finally { await view.destroy() }
})

test('a failed handoff retries only the cached result without preparing or creating a canvas again', async t => {
  const requests = mockRequests(t); let completes = 0
  const view = await mount({ complete: async value => { assert.deepEqual(value, result); if (++completes === 1) throw new Error('刷新画布失败') } })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /刷新画布失败/)
    const requestCount = requests.length
    await act(async () => button('重试打开画布').click())
    assert.equal(requests.length, requestCount)
    assert.equal(completes, 2)
  } finally { await view.destroy() }
})

test('closing reference generation preserves the accepted request and ignores late UI effects', async t => {
  let resolvePrepare!: (response: Response) => void, completed = 0, cancelled = 0
  let acceptedSignal: AbortSignal | null | undefined
  const requests = mockRequests(t, { needsAnalysis: true, prepare: init => {
    acceptedSignal = init?.signal
    return new Promise(resolve => { resolvePrepare = resolve })
  } })
  const view = await mount({ complete: () => { completed++ }, cancel: () => { cancelled++ } })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 3)
    await act(() => button('关闭').click())
    assert.equal(cancelled, 1)
    assert.ok(acceptedSignal)
    assert.equal(acceptedSignal.aborted, false, 'closing must not abort accepted reference work')
    await act(async () => resolvePrepare(Response.json({ signature, scene_ids: ['scene'], profiles: [] })))
    assert.equal(requests.length, 3)
    assert.equal(completed, 0)
    assert.ok(!requests.some(request => request.path.endsWith('/canvas/cancel')))
  } finally { await view.destroy() }
})

test('unmounting while validating selection isolates a late project response', async t => {
  let resolveProject!: (response: Response) => void, completed = 0
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/canvas/recovery')) return Response.json({ signature, scene_ids: ['scene'] })
    paths.push(String(url)); return new Promise<Response>(resolve => { resolveProject = resolve })
  })
  const view = await mount({ complete: () => { completed++ } })
  await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /暂时无法保存/)
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.filter(request => request.path.endsWith('/canvas/prepare')).length, 1)
    assert.equal(requests.filter(request => request.path.endsWith('/canvas/commit')).length, 2)
    assert.equal(requests.filter(request => request.path.endsWith('/storyboard/canvas')).length, 1)
  } finally { await view.destroy() }
})

test('a reference commit locks closing and repeated confirmation until the write finishes', async t => {
  let resolveCommit!: (response: Response) => void, commits = 0, cancelled = 0
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    if (String(url).endsWith('/canvas/recovery')) return Response.json({ signature, scene_ids: ['scene'] })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(button('关闭').disabled, true)
    assert.equal(button('关闭分镜制作准备').disabled, true)
    const primary = document.querySelector<HTMLButtonElement>('.storyboard-production-primary')
    assert.equal(primary, null, 'work in progress is shown in the footer, not a disabled primary action')
    assert.match(document.querySelector('[aria-label="画布准备进度"]')!.textContent!, /^正在保存.+ · \d+ 秒$/)
    await act(() => button('关闭').click())
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(requests.length, 2)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /方案|更新/)
  } finally { await view.destroy() }
})


test('base-plan production preserves the existing reference API contract without a design parameter', async t => {
  const requests = mockRequests(t, { project: { ...detail, shots: [{ ...detail.shots[0], design_id: null }] }, needsAnalysis: true })
  const view = await mount({ designId: null })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
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


test('complete recovery without a current plan cannot advertise adoption or silently prepare again', async t => {
  const requests: string[] = []
  const caps = { run_id: 'completed-run', state: 'complete', model_id: 'default-text', full_scope: true,
    can_retry_failed: false, retry_reason: '来源已变化', retryable_unit_keys: [], can_continue: false, continue_reason: '来源已变化', pending_unit_keys: [],
    can_restart_all: false, restart_reason: '已达到运行版本上限', requires_confirmation: true,
    budget: { task_requests: 30, task_max_requests: 512, run_requests: 30, run_max_requests: 256, runs: 3, max_runs: 3 } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/canvas/recovery')) return Response.json({ signature, scene_ids: ['scene'], preparation: caps })
    throw new Error('Unexpected mutation/read: ' + path)
  })
  const view = await mount()
  try {
    assert.equal(button('加入画布').disabled, true)
    assert.equal([...document.querySelectorAll('button')].filter(node => node.textContent === '核对状态').length, 0)
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')))
    assert.equal(requests.length, 2)
    assert.ok(requests.every(path => path.endsWith('/canvas/recovery')))
  } finally { await view.destroy() }
})


for (const sourceChanged of [false, true]) test(`adoption refresh ${sourceChanged ? 'blocks a genuinely changed source' : 'uses the current complete run'} without model calls or duplicate commits`, async t => {
  const nextSignature = 'c'.repeat(64), requests: Request[] = []
  let reads = 0, release!: (response: Response) => void
  const caps = { run_id: 'complete-run', state: 'complete', model_id: 'default-text', full_scope: true,
    can_retry_failed: false, retry_reason: '', retryable_unit_keys: [], can_continue: true, continue_reason: '', pending_unit_keys: [],
    can_restart_all: false, restart_reason: '已达上限', requires_confirmation: true,
    budget: { task_requests: 30, task_max_requests: 512, run_requests: 30, run_max_requests: 256, runs: 3, max_runs: 3 } }
  const snapshot = (sig: string) => {
    const preparation = { ...caps, run_id: sig === signature ? 'old-run' : 'current-run' }
    return { signature: sig, scene_ids: ['scene'], preparation,
      plan: { signature: sig, scene_ids: ['scene'], profiles: [], status: 'complete', preparation } }
  }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.endsWith('/canvas/recovery')) return ++reads === 1 ? Response.json(snapshot(signature)) : new Promise<Response>(resolve => { release = resolve })
    if (path === '/api/projects/project') return Response.json(detail)
    if (path.endsWith('/canvas/check')) return Response.json({ signature: nextSignature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/canvas/commit') || path.endsWith('/storyboard/canvas')) return Response.json(result)
    throw new Error('Unexpected request: ' + path)
  })
  let completed = 0
  const view = await mount({ complete: () => { completed++ } })
  try {
    await act(async () => { const primary = button('加入画布'); primary.click(); primary.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(reads, 2, 'one guarded recovery refresh is shared by the active click')
    assert.equal(requests.filter(item => item.path.endsWith('/canvas/commit')).length, 0)
    await act(async () => release(Response.json(sourceChanged ? { signature: nextSignature, scene_ids: ['scene'], preparation: { ...caps, run_id: 'old-run', can_continue: false,
      adoption: { can_adopt: false, source_matches: false, reason: '旧版镜头已不在当前范围', completed_profiles: 9, missing_shot_ids: ['old-shot'] } } } : snapshot(nextSignature))))
    assert.equal(requests.some(item => item.path.endsWith('/canvas/prepare')), false)
    assert.equal(requests.filter(item => item.path.endsWith('/canvas/commit')).length, 0, 'a different run must be reviewed before adopting')
    if (!sourceChanged) {
      assert.match(document.body.textContent!, /待采用运行已变化/)
      await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
      await act(async () => release(Response.json(snapshot(nextSignature))))
    }
    assert.equal(requests.filter(item => item.path.endsWith('/canvas/commit')).length, sourceChanged ? 0 : 1)
    assert.equal(completed, sourceChanged ? 0 : 1)
    if (sourceChanged) { assert.match(document.body.textContent!, /旧版镜头/); assert.equal(button('加入画布').disabled, true) }
    else { assert.equal(requests.find(item => item.path.endsWith('/canvas/commit'))!.body.signature, nextSignature); assert.equal(button('已加入画布').disabled, true) }
  } finally { await view.destroy() }
})

test('closing during an adoption refresh ignores its late result and performs no commit or generation', async t => {
  let reads = 0, release!: (response: Response) => void, commits = 0
  const caps = { run_id: 'complete-run', state: 'complete', model_id: 'default-text', full_scope: true, can_retry_failed: false, retryable_unit_keys: [], can_continue: true,
    pending_unit_keys: [], can_restart_all: false, requires_confirmation: true, budget: { task_requests: 1, task_max_requests: 512, run_requests: 1, run_max_requests: 256, runs: 2, max_runs: 3 } }
  const snapshot = { signature, scene_ids: ['scene'], preparation: caps, plan: { signature, scene_ids: ['scene'], profiles: [], preparation: caps } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/canvas/recovery')) return ++reads === 1 ? Response.json(snapshot) : new Promise<Response>(resolve => { release = resolve })
    if (path === '/api/projects/project') return Response.json(detail)
    if (path.endsWith('/canvas/check')) return Response.json({ signature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    commits++; throw new Error('Mutation forbidden: ' + path)
  })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    await act(() => button('关闭').click())
    await act(async () => release(Response.json(snapshot)))
    assert.equal(commits, 0)
    assert.equal(document.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})


test('successful reference adoption is not committed again when canvas import needs retry', async t => {
  let reads = 0, commits = 0, imports = 0
  const caps = { run_id: 'complete-run', state: 'complete', full_scope: true, can_retry_failed: false, retryable_unit_keys: [], can_continue: true,
    pending_unit_keys: [], can_restart_all: false, budget: { task_requests: 30, task_max_requests: 512, run_requests: 30, run_max_requests: 256, runs: 3, max_runs: 3 } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url)
    if (path.endsWith('/canvas/recovery')) { reads++; return Response.json({ signature, scene_ids: ['scene'], preparation: caps,
      plan: { signature, scene_ids: ['scene'], profiles: [], preparation: caps } }) }
    if (path === '/api/projects/project') return Response.json(detail)
    if (path.endsWith('/canvas/check')) return Response.json({ signature: commits ? 'b'.repeat(64) : signature, scene_ids: ['scene'], needs_analysis: commits ? [] : ['scene'] })
    if (path.endsWith('/canvas/commit')) { commits++; return Response.json(result) }
    if (path.endsWith('/storyboard/canvas')) return ++imports === 1 ? Response.json({ detail: '画布暂时不可用' }, { status: 503 }) : Response.json(result)
    throw new Error('Model calls forbidden: ' + path)
  })
  const view = await mount()
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(commits, 1); assert.match(document.body.textContent!, /画布暂时不可用/)
    await act(async () => { button('重试加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(commits, 1); assert.equal(imports, 2); assert.equal(reads, 2)
    assert.equal(button('已加入画布').disabled, true)
  } finally { await view.destroy() }
})


test('stale complete results keep two footer buttons without technical details', async t => {
  const requests: string[] = []
  const caps = { run_id: 'old-run', state: 'complete', model_id: 'default-text', full_scope: true,
    can_retry_failed: false, retry_reason: '', retryable_unit_keys: [], can_continue: false, continue_reason: '', pending_unit_keys: [],
    can_restart_all: false, restart_reason: '旧版本已达上限', requires_confirmation: true,
    adoption: { can_adopt: false, source_matches: false, reason: '当前分镜已更新，旧结果不能直接采用。', completed_profiles: 9, missing_shot_ids: ['old-shot'],
      can_prepare_current: true, prepare_reason: '', discarded: false },
    budget: { task_requests: 53, task_max_requests: 512, run_requests: 30, run_max_requests: 256, runs: 3, max_runs: 3 } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    requests.push(String(url))
    if (String(url).endsWith('/canvas/recovery')) return Response.json({ signature, scene_ids: ['scene'], preparation: caps,
      retained_plan: { signature: 'b'.repeat(64), scene_ids: ['scene'], profiles: [{ name: '旧铜锣', draft_key: 'old-prop', definition: '旧参考定义' }] } })
    throw new Error('Read-only test: ' + url)
  })
  const view = await mount()
  try {
    assert.equal(button('整理参考').disabled, false)
    assert.ok(![...document.querySelectorAll('button')].some(node => node.textContent === '刷新状态'))
    assert.deepEqual([...document.querySelectorAll('.storyboard-production-actions button')].map(node => node.textContent), ['关闭', '整理参考'])
    assert.equal([...document.querySelectorAll('button')].filter(node => node.textContent === '核对状态').length, 0)
    assert.equal(document.querySelectorAll('.storyboard-production-primary').length, 1)
    assert.equal(requests.length, 1, 'opening actions never starts a model')
  } finally { await view.destroy() }
})


test('model changes and replacement shot selection refresh read-only recovery automatically and ignore older responses', async t => {
  let reads = 0, release!: (response: Response) => void
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    requests.push(String(url)); assert.ok(String(url).endsWith('/canvas/recovery'), 'automatic updates must only read recovery')
    if (++reads === 2) return new Promise<Response>(resolve => { release = resolve })
    return Response.json({ signature: reads === 1 ? signature : 'c'.repeat(64), scene_ids: ['scene'] })
  })
  const view = await mount()
  try {
    await act(() => rememberModelSelection('text', 'ordinary-text'))
    assert.equal(reads, 2)
    await view.render({ shotIds: ['replacement-shot'] })
    assert.equal(reads, 3)
    await act(async () => release(Response.json({ signature: 'b'.repeat(64), scene_ids: ['scene'], preparation: { run_id: 'late', state: 'unknown', full_scope: true,
      can_continue: false, can_retry_failed: false, retryable_unit_keys: [], pending_unit_keys: [], can_restart_all: false, restart_reason: '迟到旧状态' } })))
    assert.doesNotMatch(document.body.textContent!, /迟到旧状态/)
    assert.equal(button('加入画布').disabled, false)
    assert.equal(requests.length, 3)
  } finally { await view.destroy() }
})


test('recovery read failure exposes status-area retry without dispatching generation', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith('/canvas/recovery'), 'retry must only read recovery')
    if (++reads === 1) throw new Error('offline read')
    return Response.json({ signature, scene_ids: ['scene'] })
  })
  const view = await mount()
  try {
    assert.equal(document.querySelector('.storyboard-production-primary'), null)
    assert.ok(!document.querySelector('.storyboard-production-actions')!.contains(button('刷新状态')))
    await act(async () => button('刷新状态').click())
    assert.equal(reads, 2)
    assert.equal(button('加入画布').disabled, false)
    assert.deepEqual([...document.querySelectorAll('.storyboard-production-actions button')].map(node => node.textContent), ['关闭', '加入画布'])
  } finally { await view.destroy() }
})

test('unknown status polling is bounded, coalesces concurrent checks and stops on read failure', async t => {
  let tick!: () => void, reads = 0, release!: (response: Response) => void, fail = false
  t.mock.method(dom.window, 'setInterval', (callback: () => void) => { tick = callback; return 123 })
  t.mock.method(dom.window, 'clearInterval', () => {})
  const snapshot = { signature, scene_ids: ['scene'], preparation: { run_id: 'unknown', state: 'unknown', full_scope: true,
    can_continue: false, can_retry_failed: false, can_restart_all: false, retryable_unit_keys: [], pending_unit_keys: [], restart_reason: '等待核对',
    budget: { task_requests: 1, task_max_requests: 512, run_requests: 1, run_max_requests: 256, runs: 1, max_runs: 3 } } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith('/canvas/recovery'))
    reads++
    if (reads === 2) return new Promise<Response>(resolve => { release = resolve })
    if (fail) throw new Error('offline')
    return Response.json(snapshot)
  })
  const view = await mount()
  try {
    assert.equal(document.querySelector('.storyboard-production-primary'), null)
    await act(async () => { button('刷新状态').click(); button('刷新状态').click(); tick() })
    assert.equal(reads, 2, 'concurrent explicit and automatic checks share one read')
    await act(async () => release(Response.json(snapshot)))
    fail = true
    await act(async () => tick())
    for (let i = 0; i < 3; i++) await act(async () => tick())
    assert.equal(reads, 3, 'read error stops automatic reads before the polling limit')
    fail = false
    await act(async () => button('刷新状态').click())
    assert.equal(reads, 4)
    for (let i = 0; i < 20; i++) await act(async () => tick())
    assert.equal(reads, 15, 'initial + manual + retry + at most 12 polls including the failed read')
    await act(async () => button('刷新状态').click())
    assert.equal(reads, 16, 'explicit check still works after polling limit')
  } finally { await view.destroy() }
})


test('a freshly completed full-scope preparation saves and opens in the same user action', async t => {
  let opened = 0
  const requests = mockRequests(t, { needsAnalysis: true, prepare: async () => Response.json({ signature, scene_ids: ['scene'], profiles: [],
    status: 'complete', preparation: { run_id: 'fresh', full_scope: true, state: 'complete' } }) })
  const view = await mount({ complete: () => { opened++ } })
  try {
    await act(async () => { button('加入画布').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.equal(opened, 1)
    assert.deepEqual(requests.filter(r => /\/(prepare|commit|canvas)$/.test(r.path)).map(r => r.path.split('/').at(-1)), ['prepare', 'commit', 'canvas'])
    assert.equal(requests.find(r => r.path.endsWith('/canvas/commit'))!.body.run_id, 'fresh')
  } finally { await view.destroy() }
})


test('a failed run without a plan does not present retained references as current results', async t => {
  const profiles = Array.from({ length: 15 }, (_, index) => ({ draft_key: 'old-' + index, name: '旧参考' + index, definition: '保留定义' }))
  const caps = { run_id: 'failed', state: 'failed', full_scope: true, can_retry_failed: false, retryable_unit_keys: [], can_continue: false, pending_unit_keys: [], can_restart_all: false,
    adoption: { source_matches: false, can_adopt: false, completed_profiles: 0, missing_shot_ids: [] },
    budget: { task_requests: 15, task_max_requests: 512, run_requests: 0, run_max_requests: 256, runs: 2, max_runs: 3 } }
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith('/canvas/recovery'))
    return Response.json({ signature, scene_ids: ['scene'], preparation: caps,
      retained_results: [{ run_id: 'old', plan: { signature: 'b'.repeat(64), scene_ids: ['scene'], profiles } }] })
  })
  const view = await mount()
  try {
    assert.match(document.body.textContent!, /分镜已更新/)
    assert.doesNotMatch(document.body.textContent!, /0 份旧参考|正在整理参考/)
    assert.equal(document.querySelector('.reference-preparation-details'), null)
    assert.equal(document.querySelector('.reference-failure-panel'), null)
  } finally { await view.destroy() }
})


test('known running preparation keeps polling past twelve reads without overlap and stops after completion', async t => {
  let tick!: () => void, reads = 0, release!: (response: Response) => void
  t.mock.method(dom.window, 'setInterval', (callback: () => void, delay: number) => {
    if (delay === 5000) tick = callback
    return delay === 5000 ? 123 : 124
  })
  t.mock.method(dom.window, 'clearInterval', () => {})
  const snapshot = (state: string) => ({ signature, scene_ids: ['scene'], preparation: { run_id: 'running', state, model_id: 'default-text', full_scope: false,
    can_continue: false, can_retry_failed: false, can_restart_all: false, retryable_unit_keys: [], pending_unit_keys: [],
    budget: { task_requests: 1, task_max_requests: 512, run_requests: 1, run_max_requests: 256, runs: 1, max_runs: 3 } } })
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).endsWith('/canvas/recovery')); reads++
    if (reads === 15) return new Promise<Response>(resolve => { release = resolve })
    return Response.json(snapshot('running'))
  })
  const view = await mount()
  try {
    for (let i = 0; i < 14; i++) await act(async () => tick())
    assert.equal(reads, 15, 'known running work is still observed beyond one minute')
    await act(async () => { tick(); tick() }); assert.equal(reads, 15, 'one pending read only')
    await act(async () => release(Response.json(snapshot('complete'))))
    await act(async () => tick()); assert.equal(reads, 15, 'completed tasks stop automatic polling')
  } finally { await view.destroy() }
})
