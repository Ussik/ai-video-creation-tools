import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, Shot } from '../src/shared/api/api'
import type { CanvasGraph, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'

// Render the actual canvas and composer; only CSS and HTTP transport are mocked.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver', 'CustomEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLMediaElement.prototype.pause = () => {}
let frameId = 0
let frameTime = performance.now()
const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now')
Object.defineProperty(performance, 'now', { configurable: true, value: () => frameTime })
after(() => {
  if (originalPerformanceNow) Object.defineProperty(performance, 'now', originalPerformanceNow)
  else Reflect.deleteProperty(performance, 'now')
})
const frames = new Map<number, FrameRequestCallback>()
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
function dimensions(element: Element) {
  const node = element instanceof dom.window.HTMLElement ? element : null
  const sizedNode = node?.closest<HTMLElement>('.react-flow__node')
  return { width: Number.parseFloat(node?.style.width || sizedNode?.style.width || '') || 1200,
    height: Number.parseFloat(node?.style.height || sizedNode?.style.height || '') || 800 }
}
for (const [name, axis] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height']] as const) {
  Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() { return dimensions(this)[axis] } })
}
dom.window.Element.prototype.getBoundingClientRect = function () {
  const size = dimensions(this)
  const position = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(this.getAttribute('style') || '')
  const x = Number(position?.[1] || 0), y = Number(position?.[2] || 0)
  return { ...size, x, y, left: x, top: y, right: x + size.width, bottom: y + size.height, toJSON() { return this } }
}
class TestResizeObserver {
  private targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target)
    queueMicrotask(() => {
      if (target.isConnected && this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
    })
  }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
}
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
Object.assign(dom.window, { ResizeObserver: TestResizeObserver, DOMMatrixReadOnly: class {
  m22: number
  constructor(transform: string) { this.m22 = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] || 1) }
} })
const { createRoot } = await import('react-dom/client')
const { default: ProjectCanvas } = await import('../src/features/canvas/ProjectCanvas')
after(() => dom.window.close())

const projectId = 'shot-management-integration'
const timestamp = '2026-11-03T12:00:00Z'
const signature = 'a'.repeat(64)
const scene = { id: 'scene', episode_number: 1, heading: '月台告别', duration: 10, position: 0, location: '月台', time_of_day: '夜', characters: '林晚', action: '林晚看着列车。', dialogue: '', narration: '' }
const textModel = { id: 'text-model', provider_id: 'provider', name: '文本模型', remote_id: 'text-v1', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const oldShot: Shot = { id: 'old-shot', project_id: projectId, design_id: 'old-design', source_scene_id: scene.id, position: 0, title: '旧方案回望', prompt: '林晚看着列车。', image_prompt: '林晚站在月台。', video_prompt: '镜头慢慢推进。', duration: 10, selected_asset_id: null, start_state: '', end_state: '', cut_note: '' }
const newShot: Shot = { ...oldShot, id: 'new-shot', design_id: 'new-design', title: '新方案列车入站' }
const planDraft = { signature, mode: 'redesign', scenes: [{ scene_id: scene.id, scene_heading: scene.heading, scene_duration: 10, shots: [{ shot_id: null, title: newShot.title, prompt: newShot.prompt, image_prompt: newShot.image_prompt, video_prompt: newShot.video_prompt, duration: 10, start_state: '', end_state: '', cut_note: '' }] }], used_skills: [], source_documents: [] }
function fixture() {
  return { id: projectId, name: '月台故事', brief: '夜间的告别', ratio: '16:9', updated_at: timestamp,
    script: { outline: '林晚等车。', characters: '林晚', scenes: [scene], artifacts: [], generation_options: {} },
    shots: [oldShot], historical_shots: [], assets: [], jobs: [], asset_tasks: [], timeline_clips: [], asset_reviews: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
  } as unknown as ProjectDetail
}
async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      // Advance the same clock as d3 transitions. Dropping unfinished fake
      // frames on teardown otherwise leaves its native clock interval alive.
      frameTime += 50
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(frameTime))
    }
  })
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)
  assert.ok(node, label); return node
}
async function click(label: string) { await act(async () => button(label).click()); await settle() }
async function check(label: string) {
  const node = document.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)
  assert.ok(node, label); await act(async () => node.click()); await settle()
}
function mockApi(t: TestContext, historicalExisting = false, references?: { prepare?: boolean; target?: string }) {
  let detail = fixture(), saved = false
  if (historicalExisting) detail = { ...detail, shots: [newShot], historical_shots: [{ ...oldShot, superseded_by: 'new-design' }] }
  const requests: Array<{ path: string; method: string; body: any }> = []
  const graph: CanvasGraph = { revision: 'empty', nodes: [{ id: `project-script:${projectId}`, type: 'project_script_ref', x: 60, y: 80, width: 440, height: 320, title: '月台故事', text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }], edges: [] }
  const profile = { id: 'reference-profile', project_id: projectId, design_id: 'old-design', kind: 'character', name: '林晚', variant: '默认',
    definition: '黑色短发', view_requirements: '正面', revision: 1, board_asset_id: null }
  const binding = { ...profile, profile_id: profile.id, shot_id: oldShot.id, usage: 'both', required: true, reference_assets: [] }
  let prepared = !references?.prepare
  const installReferences = () => { detail = { ...detail, visual_profiles: [profile], shot_visual_bindings: [binding] } as unknown as ProjectDetail }
  if (references && prepared) installReferences()
  const snapshot = (): ShotManagementSnapshot => ({ revision: saved ? 'saved-plan' : 'initial',
    designs: [{ id: 'old-design', name: '旧方案', canvas_id: projectId }, ...(saved || historicalExisting ? [{ id: 'new-design', name: '分镜方案 2', canvas_id: null, canvas_pending: true }] : [])],
    canvases: [{ id: projectId, name: '原始画布' }, ...(references?.target ? [{ id: references.target, name: '另一画布' }] : [])], scenes: [scene], trashed_assets: [],
    shots: [...detail.shots, ...(detail.historical_shots || [])].map(shot => ({ shot, design_name: shot.design_id === 'new-design' ? '分镜方案 2' : '旧方案', canvas_refs: [], asset_count: 0, deleted_at: null, delete_blockers: [] })),
  })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ path, method, body })
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId, name: '原始画布', is_default: true, node_count: 0, viewport: null, design_id: 'old-design' }])
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    if (path === `/api/projects/${projectId}/canvas`) {
      if (method === 'PUT' && references) { Object.assign(graph, body, { revision: 'saved-reference-graph' }); return Response.json(graph) }
      assert.equal(method, 'GET', 'independent plans cannot change the original graph'); return Response.json(graph)
    }
    if (references?.target && path === `/api/projects/${projectId}/canvases/${references.target}`) {
      return Response.json(method === 'PUT' ? { ...body, revision: 'target-saved' } : { revision: 'target-revision', nodes: [], edges: [] })
    }
    if (path === `/api/projects/${projectId}`) return Response.json(detail)
    if (path.endsWith('/shot-management')) return Response.json(snapshot())
    if (path.endsWith('/script/storyboard/context')) return Response.json({ signature, planning_task_version: 1, project: { name: detail.name, style: '' }, scenes: [{ ...scene, shot_count: 1, material_count: 0, planned: false, has_previous_plan: true }], documents: [], skills: [] })
    if (path.endsWith('/script/storyboard/preview')) return Response.json({ preview: null })
    if (path.endsWith('/script/storyboard/tasks/lookup')) return Response.json({ task: null })
    if (path.endsWith('/script/storyboard/plan')) return Response.json(planDraft)
    if (path.endsWith('/script/storyboard/tasks') && method === 'POST') return Response.json({ id: 'planning-task', project_id: projectId, status: 'succeeded', stage: 'completed', result: planDraft })
    if (path.endsWith('/script/storyboard/commit')) {
      assert.equal(body.save_only, true, 'manager planning must save without entering production')
      saved = true; detail = { ...detail, shots: [newShot], historical_shots: [oldShot] }
      return Response.json({ scene_ids: [scene.id], shot_ids: [newShot.id], design_id: 'new-design', target_canvas_id: null, created_shots: 1, created_profiles: 0, profiles: [], shot_visual_bindings: [] })
    }
    if (path.endsWith('/script/canvas/check')) return Response.json({ signature, scene_ids: [scene.id], needs_analysis: references ? (prepared ? [] : [scene.id]) : historicalExisting ? [scene.id] : [], profiles: [] })
    if (references && path.endsWith('/script/canvas/prepare')) return Response.json({ signature, scene_ids: [scene.id], profiles: [], reference_usage_version: 1 })
    if (references && path.endsWith('/script/canvas/commit')) { prepared = true; installReferences(); return Response.json({}) }
    if (path.endsWith('/script/storyboard/canvas')) return references ? Response.json({ scene_ids: [scene.id], design_id: 'old-design', target_canvas_id: projectId,
      shots: [oldShot], visual_profiles: [profile], shot_visual_bindings: [binding], created_shots: 0, created_profiles: 0 }) : Response.json({ detail: '模拟画布准备暂时不可用' }, { status: 503 })
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return { requests, detail: () => detail }
}
async function mount(server: ReturnType<typeof mockApi>, request = { id: 'request-1', sceneIds: [scene.id] }) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const props: ProjectCanvasProps = { detail: server.detail(), models: [textModel],
    providers: [{ id: 'provider', name: '测试提供商', adapter: 'http', enabled: true } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, shotManagementRequest: request,
    onRefresh: async () => { props.detail = server.detail(); render() }, onOpenModels() {}, onNavigate() {}, onOpenScriptCreator() {} }
  const render = () => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)
  try { await act(render); await settle() }
  catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { rerender: async () => { await act(render); await settle() }, destroy: async () => { await act(() => root.unmount()); await settle(); container.remove(); frames.clear() } }
}

test('the actual canvas reads a completed generation column while accepted script data remains empty', async t => {
  const server = mockApi(t)
  server.detail().script = { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} }
  server.detail().script_generation_progress = { updated_at: timestamp, documents: [
    { artifact_type: 'outline', title: '概要设计已完成', content: '已保留的概要：林晚决定返回月台找回信件。', episode_number: 0 },
  ] }
  const before = structuredClone(server.detail().script), view = await mount(server)
  try {
    await click('关闭分镜管理')
    const card = document.querySelector('.pc-project-script-card')!
    assert.ok(card)
    assert.match(card.textContent!, /概要设计已完成/)
    assert.match(card.textContent!, /已保留的概要：林晚决定返回月台找回信件/)
    assert.match(card.textContent!, /已保存草稿 · 待确认/)
    assert.doesNotMatch(card.textContent!, /暂无故事大纲/)
    assert.deepEqual(server.detail().script, before)
    assert.equal(server.requests.some(request => request.method !== 'GET'), false, 'reading a generated column does not submit or adopt it')
  } finally { await view.destroy() }
})

test('a script request opens the project shot workspace once without planning or entering production', async t => {
  const server = mockApi(t), view = await mount(server)
  try {
    assert.ok(document.querySelector('.shot-manager-modal[data-full-screen]'))
    assert.ok(document.querySelector('table[aria-label="分镜镜头表"]'))
    assert.equal((document.querySelector('input[aria-label="分镜场次筛选"]') as HTMLInputElement).value, '第 1 集 · 月台告别')
    assert.ok(button('编辑镜头：旧方案回望'))
    assert.equal(server.requests.some(request => request.path.endsWith('/plan') || request.path.endsWith('/commit') || request.path.endsWith('/check')), false)
    await click('关闭分镜管理'); await view.rerender()
    assert.equal(document.querySelector('.shot-manager-modal'), null, 'the already handled request does not reopen after closing')
  } finally { await view.destroy() }
})

test('planning from the manager saves independently and returns to the new scheme', async t => {
  const server = mockApi(t), view = await mount(server)
  try {
    await click('规划分镜'); await click('从剧本场次规划'); await click('开始规划'); await click('保存分镜方案')
    assert.equal(document.querySelector('.storyboard-planner'), null)
    assert.ok(document.querySelector('.shot-manager-modal'))
    assert.equal((document.querySelector('input[aria-label="分镜方案筛选"]') as HTMLInputElement).value, '分镜方案 2')
    assert.ok(button('编辑镜头：新方案列车入站'))
    assert.equal([...document.querySelectorAll('button')].some(item => item.getAttribute('aria-label') === '编辑镜头：旧方案回望'), false)
    assert.equal(server.requests.filter(request => request.path.endsWith('/script/storyboard/commit')).length, 1)
    assert.equal(server.requests.some(request => /\/script\/canvas\/(check|prepare|commit)$/.test(request.path) || request.path.endsWith('/script/storyboard/canvas')), false)
    assert.equal(dom.window.sessionStorage.getItem(`script-canvas-open:${projectId}`), null)
  } finally { await view.destroy() }
})

test('a saved pending scheme enters explicit production preparation without writing into the original canvas', async t => {
  const server = mockApi(t), view = await mount(server)
  try {
    await click('规划分镜'); await click('从剧本场次规划'); await click('开始规划'); await click('保存分镜方案')
    await check('选择镜头：新方案列车入站')
    assert.equal(document.querySelector('input[aria-label="加入目标画布"]'), null)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /将创建此方案的画布/)
    await click('加入画布')
    assert.ok(document.querySelector('.storyboard-production-modal'))
    assert.match(document.querySelector('.storyboard-production-summary')!.textContent!, /1 个镜头/)
    assert.equal(server.requests.some(request => request.path.endsWith('/script/storyboard/canvas')), false)
    assert.equal(server.requests.some(request => request.method === 'PUT'), false)
    await click('准备并加入画布')
    const production = server.requests.find(request => request.path.endsWith('/script/storyboard/canvas'))
    assert.deepEqual(production?.body, { scene_ids: [scene.id], shot_ids: [newShot.id], design_id: 'new-design', mode: 'existing' })
    assert.match(document.querySelector('.storyboard-production-error')!.textContent!, /模拟画布准备暂时不可用/)
    assert.equal(server.requests.some(request => request.method === 'PUT'), false, 'a preparation failure cannot fall back to the original canvas')
    await click('关闭分镜制作准备')
    assert.equal(document.querySelector('.storyboard-production-modal'), null)
    assert.ok(document.querySelector('.shot-manager-modal'))
    assert.equal(document.querySelector('.shot-manager-error'), null, 'cancelling preparation is not an error')
    assert.equal((document.querySelector('input[aria-label="选择镜头：新方案列车入站"]') as HTMLInputElement).checked, true)
  } finally { await view.destroy() }
})

test('historical shots with an existing canvas still check their own references before a later import', async t => {
  const server = mockApi(t, true), view = await mount(server)
  try {
    await check('选择镜头：旧方案回望')
    await click('加入画布')
    assert.ok(document.querySelector('.storyboard-production-modal'), 'later scenes still require explicit reference preparation')
    const checked = server.requests.filter(request => request.path.endsWith('/script/canvas/check'))
    assert.deepEqual(checked.map(request => request.body), [{ scene_ids: [scene.id], design_id: 'old-design' }])
    assert.equal(server.requests.some(request => request.path.endsWith('/prepare') || request.method === 'PUT'), false)
    await click('关闭分镜制作准备')
    assert.equal((document.querySelector('input[aria-label="选择镜头：旧方案回望"]') as HTMLInputElement).checked, true)
  } finally { await view.destroy() }
})

test('a valid reference preparation cache imports profile nodes into the existing canvas', async t => {
  const server = mockApi(t, false, {}), view = await mount(server)
  try {
    await check('选择镜头：旧方案回望'); await click('加入画布')
    assert.equal(document.querySelector('.storyboard-production-modal'), null)
    const save = server.requests.find(request => request.method === 'PUT')!
    assert.ok(save, 'an actual graph is persisted')
    assert.equal(save.body.nodes.filter((node: any) => node.settings.visual_profile_id === 'reference-profile').length, 1)
    assert.equal(save.body.nodes.filter((node: any) => node.shot_id === 'old-shot').length, 1)
    assert.ok(server.requests.some(request => request.path.endsWith('/script/storyboard/canvas')))
    assert.equal(server.requests.some(request => request.path.endsWith('/canvas/prepare')), false)
  } finally { await view.destroy() }
})

test('preparing references for an existing canvas keeps the complete result during handoff', async t => {
  const server = mockApi(t, false, { prepare: true }), view = await mount(server)
  try {
    await check('选择镜头：旧方案回望'); await click('加入画布')
    assert.ok(document.querySelector('.storyboard-production-modal'))
    await click('准备并加入画布')
    assert.equal(document.querySelector('.storyboard-production-modal'), null)
    const save = server.requests.find(request => request.method === 'PUT')!
    assert.ok(save)
    assert.equal(save.body.nodes.filter((node: any) => node.settings.visual_profile_id === 'reference-profile').length, 1)
    assert.equal(save.body.nodes.find((node: any) => node.shot_id === 'old-shot').settings.visual_dependencies, true)
    assert.equal(server.requests.filter(request => request.path.endsWith('/script/storyboard/canvas')).length, 1)
    assert.equal(server.requests.filter(request => request.path.endsWith('/canvas/prepare')).length, 1)
  } finally { await view.destroy() }
})

test('the regular import-storyboard action checks prepared references and creates their nodes', async t => {
  const server = mockApi(t, false, {}), view = await mount(server)
  try {
    await click('关闭分镜管理'); await click('导入分镜')
    assert.ok(server.requests.some(request => request.path.endsWith('/script/canvas/check')))
    assert.ok(server.requests.some(request => request.path.endsWith('/script/storyboard/canvas')))
    const save = server.requests.find(request => request.method === 'PUT')!
    assert.ok(save)
    assert.equal(save.body.nodes.filter((node: any) => node.settings.visual_profile_id === 'reference-profile').length, 1)
  } finally { await view.destroy() }
})

test('a prepared script design can target another canvas with that canvas revision and references', async t => {
  const target = 'another-canvas', server = mockApi(t, false, { target }), view = await mount(server)
  try {
    await check('选择镜头：旧方案回望')
    const picker = document.querySelector<HTMLInputElement>('input[aria-label="加入目标画布"]')!
    await act(async () => picker.click()); await settle()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === '另一画布')!
    assert.ok(option); await act(async () => option.click()); await settle()
    await click('加入画布')
    const save = server.requests.find(request => request.method === 'PUT')!
    assert.ok(save)
    assert.equal(save.path, `/api/projects/${projectId}/canvases/${target}`)
    assert.equal(save.body.revision, 'target-revision')
    assert.equal(save.body.nodes.filter((node: any) => node.settings.visual_profile_id === 'reference-profile').length, 1)
    assert.equal(server.requests.some(request => request.path.endsWith('/canvas') && request.method === 'PUT'), false)
  } finally { await view.destroy() }
})

const clipDesignId = 'clip-design'
const clipSource = '少女跑进车站，最后一班列车已经离开，她停在空月台。'
const clipShots: Shot[] = [
  { ...newShot, id: 'clip-shot-1', design_id: clipDesignId, source_scene_id: null, position: 0, title: '片段进站', duration: 6 },
  { ...newShot, id: 'clip-shot-2', design_id: clipDesignId, source_scene_id: null, position: 1, title: '片段空月台', duration: 6 },
]
function mockClipApi(t: TestContext, options: { existing?: boolean; withScript?: boolean; canvasFails?: boolean } = {}) {
  let saved = !!options.existing
  let detail = { ...fixture(), script: { ...fixture().script, scenes: options.withScript ? [scene] : [] },
    shots: [...(options.withScript ? [oldShot] : []), ...(saved ? clipShots : [])], historical_shots: [] } as ProjectDetail
  const requests: Array<{ path: string; method: string; body: any }> = []
  const graph: CanvasGraph = { revision: 'clip-original', nodes: [{ id: `project-script:${projectId}`, type: 'project_script_ref', x: 60, y: 80, width: 440, height: 320,
    title: detail.name, text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }], edges: [] }
  const clipCanvasId = 'clip-canvas'
  const skills = [{ id: 'clip-skill', name: '短片分镜技能', description: '节奏与镜头衔接', revision: '1234567890abcdef' }]
  const clipContext = { signature, project: { name: detail.name, brief: detail.brief, ratio: detail.ratio, style: '日漫风格' }, skills, default_skill_ids: ['clip-skill'],
    skill_policy: { stage: 'storyboard', label: '分镜规划', primary_id: 'clip-skill', auxiliary_ids: [], source: 'global', warning: '', skills } }
  const result = (shots = clipShots, canvasId: string | null = null) => ({ scene_ids: [], design_id: clipDesignId, target_canvas_id: canvasId,
    shots, visual_profiles: [], shot_visual_bindings: [], created_shots: 2, created_profiles: 0 })
  const snapshot = (): ShotManagementSnapshot => ({ revision: saved ? 'clip-saved' : 'clip-initial',
    designs: [...(options.withScript ? [{ id: 'old-design', name: '旧方案', canvas_id: projectId }] : []), ...(saved ? [{ id: clipDesignId,
      name: '片段方案 1', canvas_id: options.existing ? clipCanvasId : null, canvas_pending: !options.existing, source_type: 'clip' as const, source_text: clipSource, total_duration: 12 }] : [])],
    canvases: [{ id: projectId, name: '原始画布' }, ...(options.existing ? [{ id: clipCanvasId, name: '片段画布' }] : [])],
    scenes: options.withScript ? [scene] : [], trashed_assets: [],
    shots: detail.shots.map(shot => ({ shot, design_name: shot.design_id === clipDesignId ? '片段方案 1' : '旧方案', canvas_refs: [], asset_count: 0, deleted_at: null, delete_blockers: [] })),
  })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ path, method, body })
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId, name: '原始画布', is_default: true, node_count: 0, viewport: null, design_id: options.withScript ? 'old-design' : null },
      ...(options.existing ? [{ id: clipCanvasId, project_id: projectId, name: '片段画布', is_default: false, node_count: 0, viewport: null, design_id: clipDesignId }] : [])])
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    if (path === `/api/projects/${projectId}/canvas`) { assert.equal(method, 'GET', 'clip planning and handoff must preserve the original graph'); return Response.json(graph) }
    if (path === `/api/projects/${projectId}`) return Response.json(detail)
    if (path.endsWith('/shot-management')) return Response.json(snapshot())
    if (path.endsWith('/storyboard/clip/context')) { assert.equal(method, 'GET'); return Response.json(clipContext) }
    if (path.endsWith('/storyboard/clip/plan')) return Response.json({ signature: 'b'.repeat(64), source_text: body.source_text, total_duration: body.total_duration, instructions: body.instructions,
      shots: clipShots.map(shot => ({ title: shot.title, prompt: shot.prompt, image_prompt: shot.image_prompt, video_prompt: shot.video_prompt,
        duration: shot.duration, start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note })),
      used_skills: [{ ...skills[0], files: ['SKILL.md'], role: 'primary' }], skill_assignment: { ids: ['clip-skill'], source: 'fixed', reason: '按分镜规划使用全局绑定。' } })
    if (path.endsWith('/storyboard/clip/commit')) { saved = true; detail = { ...detail, shots: [...detail.shots, ...clipShots] }; return Response.json(result()) }
    if (path.endsWith('/storyboard/clip/canvas')) {
      if (options.canvasFails) return Response.json({ detail: '片段画布暂时不可用' }, { status: 503 })
      return Response.json(result(clipShots.filter(shot => body.shot_ids.includes(shot.id)), clipCanvasId))
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return { requests, detail: () => detail }
}
async function fill(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  assert.ok(node, label)
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function createClipFromManager() {
  await click('规划分镜')
  assert.ok(document.querySelector('.clip-storyboard-planner'))
  assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '从剧本场次规划'), false, 'a project without scenes opens clip planning directly')
  await fill('片段内容', clipSource); await fill('总时长', '12')
  await click('分镜规划技能选择')
  const primary = document.querySelector<HTMLInputElement>('input[aria-label="storyboard主技能"]'); assert.ok(primary)
  assert.equal(primary.value, '短片分镜技能')
  assert.match(document.querySelector('.creative-skill-popover')!.textContent!, /按功能分配/)
  await click('分镜规划技能选择'); await click('开始规划')
  assert.match(document.querySelector('[aria-label="实际使用的分镜技能"]')!.textContent!, /短片分镜技能/)
  assert.match(document.querySelector('[aria-label="实际使用的分镜技能"]')!.textContent!, /12345678/)
  await click('保存分镜')
}

test('a project without script scenes plans a clip with fixed skills, saves independently and hands off only the checked shot', async t => {
  const server = mockClipApi(t), view = await mount(server, { id: 'clip-request', sceneIds: [] })
  try {
    await createClipFromManager()
    const planning = server.requests.find(request => request.path.endsWith('/storyboard/clip/plan'))!
    assert.deepEqual(planning.body, { signature, source_text: clipSource, total_duration: 12, instructions: '', model_id: textModel.id })
    assert.equal(Object.hasOwn(planning.body, 'skill_ids'), false)
    assert.equal(document.querySelector('.clip-storyboard-planner'), null)
    assert.equal((document.querySelector('input[aria-label="分镜方案筛选"]') as HTMLInputElement).value, '片段方案 1')
    assert.ok(button('编辑镜头：片段进站')); assert.ok(button('编辑镜头：片段空月台'))
    assert.match(document.querySelector('.shot-manager-table')!.textContent!, /片段内容/)
    const commit = server.requests.find(request => request.path.endsWith('/storyboard/clip/commit'))!
    assert.equal(commit.body.source_text, clipSource); assert.equal(commit.body.total_duration, 12); assert.equal(commit.body.shots.length, 2)
    assert.equal(dom.window.sessionStorage.getItem(`script-canvas-open:${projectId}`), null)
    assert.equal(server.requests.some(request => request.path.endsWith('/storyboard/clip/canvas') || request.method === 'PUT'), false)
    await check('选择镜头：片段空月台'); await click('加入画布')
    const production = server.requests.find(request => request.path.endsWith('/storyboard/clip/canvas'))!
    assert.deepEqual(production.body, { design_id: clipDesignId, shot_ids: ['clip-shot-2'] })
    assert.equal(document.querySelector('.storyboard-production-modal'), null, 'clip production does not run script reference preparation')
    assert.equal(document.querySelector('.shot-manager-modal'), null)
    const handoff = JSON.parse(dom.window.sessionStorage.getItem(`script-canvas-open:${projectId}`)!)
    assert.equal(handoff.canvas_id, 'clip-canvas'); assert.equal(handoff.result.design_id, clipDesignId)
    assert.deepEqual(handoff.result.shots.map((shot: Shot) => shot.id), ['clip-shot-2'])
    assert.equal(server.requests.some(request => /\/script\//.test(request.path) || /\/(prepare|check)$/.test(request.path) || request.method === 'PUT'), false)
  } finally { await view.destroy() }
})

test('a failed clip canvas request keeps the selection and never imports into the original graph', async t => {
  const server = mockClipApi(t, { canvasFails: true }), view = await mount(server, { id: 'clip-failure', sceneIds: [] })
  try {
    await createClipFromManager(); await check('选择镜头：片段进站'); await click('加入画布')
    assert.deepEqual(server.requests.find(request => request.path.endsWith('/storyboard/clip/canvas'))!.body, { design_id: clipDesignId, shot_ids: ['clip-shot-1'] })
    assert.match(document.querySelector('.shot-manager-error')!.textContent!, /片段画布暂时不可用/)
    assert.equal((document.querySelector('input[aria-label="选择镜头：片段进站"]') as HTMLInputElement).checked, true)
    assert.equal(server.requests.some(request => request.method === 'PUT' || /\/script\//.test(request.path)), false)
    assert.equal(dom.window.sessionStorage.getItem(`script-canvas-open:${projectId}`), null)
  } finally { await view.destroy() }
})

test('an existing clip always targets its own canvas and mixed script selections cannot enter production', async t => {
  const server = mockClipApi(t, { existing: true, withScript: true, canvasFails: true }), view = await mount(server, { id: 'clip-existing', sceneIds: [] })
  try {
    await check('选择镜头：片段进站'); await check('选择镜头：旧方案回望')
    assert.equal(button('加入画布').disabled, true)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /请按方案分别加入画布/)
    assert.equal(server.requests.some(request => /\/(canvas|check)$/.test(request.path) && request.method === 'POST'), false)
    await check('选择镜头：旧方案回望')
    assert.equal(document.querySelector('input[aria-label="加入目标画布"]'), null)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /将加入「片段方案 1」的画布/)
    await click('加入画布')
    assert.deepEqual(server.requests.find(request => request.path.endsWith('/storyboard/clip/canvas'))!.body, { design_id: clipDesignId, shot_ids: ['clip-shot-1'] })
    assert.match(document.querySelector('.shot-manager-error')!.textContent!, /片段画布暂时不可用/)
    assert.equal(server.requests.some(request => request.method === 'PUT' || /\/script\//.test(request.path)), false)
  } finally { await view.destroy() }
})
