import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'
import type { ProjectCanvasInfo } from '../src/features/canvas/project-canvases'
import { chooseCombobox } from './component-controls'

// Count real preview renders as well as DOM mutations: React can reconcile an
// unchanged preview without changing its DOM while still repeating its work.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    const result = await nextLoad(url, context);
    if (url.endsWith('/CanvasTextEditor.tsx')) {
      const source = String(result.source).replace(
        /function CanvasTextPreview\\([^)]*\\)\\s*\\{/,
        '$& globalThis.__canvasPreviewRenders = (globalThis.__canvasPreviewRenders || 0) + 1;'
      );
      return { ...result, source };
    }
    if (url.endsWith('/ProjectCanvas.tsx')) {
      return { ...result, source: String(result.source).replace(
        /function StudioNode\\([^)]*\\)\\s*\\{/,
        '$& globalThis.__canvasNodeRenders ||= {}; globalThis.__canvasNodeRenders[data.node.id] = (globalThis.__canvasNodeRenders[data.node.id] || 0) + 1;'
      ) };
    }
    return result;
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}

let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })

function dimensions(element: Element) {
  const node = element instanceof dom.window.HTMLElement ? element : null
  const sizedNode = node?.closest<HTMLElement>('.react-flow__node')
  const viewport = node?.closest<HTMLElement>('[data-test-viewport-width]')
  const pixels = (value: string | undefined, axis: 'width' | 'height') => value?.endsWith('%') && viewport
    ? Number(viewport.dataset[axis === 'width' ? 'testViewportWidth' : 'testViewportHeight'])
    : Number.parseFloat(value || '')
  return {
    width: pixels(node?.style.width || sizedNode?.style.width, 'width') || 1200,
    height: pixels(node?.style.height || sizedNode?.style.height, 'height') || 800,
  }
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
dom.window.Range.prototype.getBoundingClientRect = () => document.body.getBoundingClientRect()
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
class TestResizeObserver {
  private targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target)
    requestFrame(() => {
      if (target.isConnected && this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
    })
  }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
}
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
Object.assign(dom.window, {
  ResizeObserver: TestResizeObserver,
  DOMMatrixReadOnly: class {
    m22: number
    constructor(transform: string) { this.m22 = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] || 1) }
  },
})
const { createRoot } = await import('react-dom/client')
const { default: ProjectCanvas } = await import('../src/features/canvas/ProjectCanvas')
after(() => dom.window.close())

const timestamp = '2026-10-09T00:00:00Z'
const profile = { id: 'profile', project_id: 'refresh', kind: 'character', name: '林晚', variant: '默认', revision: 2,
  definition: '短发，蓝色外套', definition_status: 'ready', board_asset_id: 'board', board_prompt: '人物设定', asset_task_id: 'task' } as VisualProfile
const detail = { id: 'refresh', name: '夜班列车', brief: '一段车站故事', ratio: '9:16', updated_at: timestamp,
  script: { outline: '# 故事大纲\n\n林晚在车站等候夜班列车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
  shots: [], assets: [{ id: 'board', kind: 'image', filename: '林晚.png', url: '/api/assets/board/file', created_at: timestamp }],
  jobs: [{ id: 'job', status: 'running', result_asset_id: null, created_at: timestamp, updated_at: timestamp, request: '{}' }],
  asset_tasks: [{ id: 'task', generation_job_id: 'job' }], visual_profiles: [profile], scene_visual_bindings: [], shot_visual_bindings: [],
} as unknown as ProjectDetail
function node(id: string, type: CanvasNode['type'], x: number, y: number, width: number, height: number): CanvasNode {
  return { id, type, x, y, width, height, title: '', text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }
}
const graph: CanvasGraph = { revision: 'revision', nodes: [
  { ...node('script', 'project_script_ref', 60, 80, 640, 350), title: detail.name },
  { ...node('text', 'text', 60, 550, 420, 340), title: '镜头提示词', text: '林晚望向站台。', settings: { text_mode: 'write' } },
  { ...node('image', 'image', 60, 980, 400, 272), title: '参考图', asset_id: 'board' },
  { ...node('profile', 'generation', 900, 80, 280.6666666667, 420), title: `${profile.name} · ${profile.variant}`, asset_id: 'board', job_id: 'job',
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision } },
], edges: [{ id: 'reference', source: 'image', target: 'profile' }, { id: 'prompt', source: 'text', target: 'profile' }] }
const models: ProjectCanvasProps['models'] = []
const providers: ProjectCanvasProps['providers'] = []
const previewRenders = () => (globalThis as typeof globalThis & { __canvasPreviewRenders?: number }).__canvasPreviewRenders || 0

async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 6; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}
async function mount(props: ProjectCanvasProps, viewport?: { width: number; height: number }, zoom = 0.8, prepareStorage?: () => void) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom }))
  prepareStorage?.()
  const container = document.createElement('div'); document.body.append(container)
  if (viewport) {
    container.dataset.testViewportWidth = String(viewport.width)
    container.dataset.testViewportHeight = String(viewport.height)
  }
  const root = createRoot(container)
  const render = async (next: ProjectCanvasProps) => { await act(() => root.render(<MantineProvider env="test"><ProjectCanvas {...next} /></MantineProvider>)); await settle() }
  try { await render(props) } catch (issue) {
    await act(() => root.unmount()); container.remove()
    throw issue instanceof AggregateError ? issue.errors[0] : issue
  }
  return { container, render, destroy: async () => {
    // d3 camera transitions use real elapsed time as well as RAF. Let their
    // final frame run before discarding this harness's manual frame queue so
    // d3 can clear its animation timer rather than leave an active interval.
    if (frames.size) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) }); await settle()
    }
    await act(() => root.unmount()); container.remove(); frames.clear()
  } }
}
function propsFor(base: ProjectDetail, version: number, calls: string[]): ProjectCanvasProps {
  return { detail: base, models, providers, initialLocation: { view: 'canvas', storyboardId: null },
    onRefresh: async () => { calls.push(`refresh:${version}`) }, onOpenModels: () => calls.push(`models:${version}`),
    onNavigate: destination => calls.push(`${destination}:${version}`), onOpenScriptCreator: () => calls.push(`editor:${version}`),
    onOpenScriptDirector: focus => calls.push(`director:${version}:${focus}`),
    onLocationChange: location => calls.push(`location:${version}:${location.view}`),
  }
}
function geometry(container: HTMLElement) {
  return { viewport: container.querySelector('.react-flow__viewport')?.getAttribute('style'),
    nodes: [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map(element => ({ id: element.dataset.id,
      style: element.getAttribute('style'), selected: element.classList.contains('selected') })),
    edges: [...container.querySelectorAll('.react-flow__edge-path')].map(element => element.getAttribute('d')),
  }
}
function button(container: HTMLElement, label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  assert.ok(element, label); return element
}
function mockCanvas(t: TestContext, canvasGraph: CanvasGraph = graph) {
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: canvasGraph.nodes.length, viewport: null }])
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    if (path === '/api/projects/refresh/canvases/refresh' && method === 'PATCH') {
      return Response.json({ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: canvasGraph.nodes.length,
        ...JSON.parse(String(init?.body)) })
    }
    assert.equal(path, '/api/projects/refresh/canvas')
    assert.equal(method, 'GET', 'unchanged canvas must not autosave')
    return Response.json(canvasGraph)
  })
  return requests
}

async function openVisualCandidatesFromSidebar(container: HTMLElement) {
  if (!container.querySelector('.pc-canvas-sidebar')) {
    await act(() => button(container, '打开左侧节点列表').click()); await settle()
  }
  const profilesTab = [...container.querySelectorAll<HTMLButtonElement>('.pc-sidebar-tabs [role="tab"]')]
    .find(tab => tab.textContent?.trim().startsWith('设定'))
  assert.ok(profilesTab, 'the actual canvas sidebar exposes visual profiles')
  await act(() => profilesTab.click()); await settle()
  await act(() => button(container, `管理候选：${profile.name} · ${profile.variant}`).click()); await settle()
  const dialog = document.querySelector<HTMLElement>('.pc-candidate-modal[role="dialog"]')
  assert.ok(dialog, 'the sidebar opens the visual candidate manager in its canvas parent')
  return dialog
}

test('visual candidate dialog closes from its canvas sidebar while idle and can be reopened', async t => {
  mockCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const dialog = await openVisualCandidatesFromSidebar(view.container)
    const close = button(dialog, '关闭设定图候选')
    await act(() => close.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
    await act(() => close.click()); await settle()
    assert.equal(document.querySelector('.pc-candidate-modal'), null, 'clicking X removes the actual canvas-owned dialog')
    await openVisualCandidatesFromSidebar(view.container)
    assert.equal(document.querySelectorAll('.pc-candidate-modal').length, 1, 'an explicit new action opens one candidate manager')
  } finally { await view.destroy() }
})

for (const closeWith of ['close button', 'Escape', 'overlay'] as const) test(`visual candidate dialog ${closeWith} closes during a pending save refresh without cancelling the save or reopening`, async t => {
  let saved = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/assets/board/save') {
      assert.equal(init?.method, 'POST')
      saved++
      return Response.json({ ...detail.assets[0], saved: true })
    }
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    assert.equal(String(url), '/api/projects/refresh/canvas')
    assert.equal(init?.method || 'GET', 'GET', 'candidate dismissal never changes the canvas')
    return Response.json(graph)
  })
  let releaseRefresh!: () => void
  const pendingRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  let refreshStarted = 0, refreshFinished = 0
  const props = propsFor(detail, 0, [])
  props.onRefresh = async () => { refreshStarted++; await pendingRefresh; refreshFinished++ }
  const view = await mount(props)
  try {
    const dialog = await openVisualCandidatesFromSidebar(view.container)
    await clickText(dialog, '保存到资产')
    assert.equal(saved, 1, 'saving is submitted before the refresh remains pending')
    assert.equal(refreshStarted, 1)
    assert.equal(refreshFinished, 0, 'the refresh is deliberately held open')
    if (closeWith === 'close button') {
      const close = button(dialog, '关闭设定图候选')
      await act(() => close.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
      await act(() => close.click()); await settle()
    } else if (closeWith === 'Escape') {
      await key(button(dialog, '关闭设定图候选'), 'Escape')
    } else {
      const overlay = dialog.closest('.mantine-Modal-root')?.querySelector<HTMLElement>('.mantine-Modal-overlay')
      assert.ok(overlay, 'the actual candidate manager overlay is present')
      await act(() => overlay.click()); await settle()
    }
    assert.equal(document.querySelector('.pc-candidate-modal'), null, `${closeWith} dismisses the dialog while its refresh is still pending`)
    assert.equal(refreshFinished, 0, 'dismissal does not require waiting for the refresh')
    await act(async () => { releaseRefresh(); await pendingRefresh }); await settle()
    assert.equal(refreshFinished, 1, 'the submitted operation finishes after its manager is dismissed')
    const refreshed = { ...structuredClone(detail), assets: detail.assets.map(asset => ({ ...asset, saved: true })) }
    await view.render({ ...props, detail: refreshed })
    assert.equal(document.querySelector('.pc-candidate-modal'), null, 'a completed operation and refreshed project data do not reopen the manager')
    assert.equal(saved, 1, 'dismissal neither cancels nor resubmits the completed save')
  } finally {
    await act(async () => { releaseRefresh(); await pendingRefresh }); await settle()
    await view.destroy()
  }
})

test('visual candidate dialog reports a save failure in the canvas after being closed', async t => {
  let finishSave!: () => void
  const pendingSave = new Promise<Response>(resolve => {
    finishSave = () => resolve(Response.json({ detail: '候选保存失败，请稍后重试' }, { status: 503 }))
  })
  let saveRequests = 0, refreshes = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/assets/board/save') {
      assert.equal(init?.method, 'POST')
      saveRequests++
      return pendingSave
    }
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    assert.equal(String(url), '/api/projects/refresh/canvas')
    assert.equal(init?.method || 'GET', 'GET')
    return Response.json(graph)
  })
  const props = propsFor(detail, 0, [])
  props.onRefresh = async () => { refreshes++ }
  const view = await mount(props)
  try {
    const dialog = await openVisualCandidatesFromSidebar(view.container)
    await clickText(dialog, '保存到资产')
    assert.equal(saveRequests, 1, 'the candidate save request is in flight')
    await act(() => button(dialog, '关闭设定图候选').click()); await settle()
    assert.equal(document.querySelector('.pc-candidate-modal'), null)
    await act(async () => { finishSave(); await pendingSave }); await settle()
    assert.match(view.container.querySelector('.pc-notice')?.textContent || '', /候选保存失败，请稍后重试/,
      'closing the viewer cannot hide a later request failure from the canvas user')
    assert.equal(refreshes, 0, 'failed saves are never treated as completed changes')
    assert.equal(document.querySelector('.pc-candidate-modal'), null, 'reporting the failure does not reopen the dismissed viewer')
    assert.equal(saveRequests, 1)
  } finally {
    await act(async () => { finishSave(); await pendingSave }); await settle()
    await view.destroy()
  }
})

test('parent refresh ticks do not rerender the canvas and actions retain the latest callbacks', async t => {
  const requests = mockCanvas(t), calls: string[] = []
  const view = await mount(propsFor(detail, 0, calls))
  try {
    assert.equal(view.container.querySelectorAll('.react-flow__node').length, 4)
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 2)
    assert.ok(previewRenders() > 0, 'instrumentation observes real text previews')
    const preview = view.container.querySelector('.pc-project-script-empty .pc-rich-text-preview')!
    preview.scrollTop = 90
    const before = geometry(view.container), renders = previewRenders()
    const mutations: MutationRecord[] = []
    const observer = new dom.window.MutationObserver(records => mutations.push(...records))
    observer.observe(view.container.querySelector('.pc-flow')!, { attributes: true, childList: true, characterData: true, subtree: true })
    for (let version = 1; version <= 5; version++) await view.render(propsFor(detail, version, calls))
    observer.disconnect()
    assert.equal(previewRenders(), renders, 'same project data must not rebuild text previews on parent ticks')
    assert.deepEqual(mutations, [], 'node and preview DOM remains untouched')
    assert.deepEqual(geometry(view.container), before)
    assert.equal(preview.scrollTop, 90)
    assert.deepEqual(requests, [{ path: '/api/projects/refresh/canvas', method: 'GET' }])
    assert.deepEqual(calls, ['location:0:canvas'], 'parent callback replacement does not replay location notifications')
    await act(() => button(view.container, '返回项目').click())
    await act(() => button(view.container, '打开剧本对话').click())
    assert.deepEqual(calls.slice(-2), ['projects:5', 'director:5:all'])
  } finally { await view.destroy() }
})

test('fresh project snapshots preserve viewport, selection, media and connections while changed job status updates', async t => {
  const requests = mockCanvas(t), calls: string[] = []
  const view = await mount(propsFor(structuredClone(detail), 0, calls))
  try {
    await act(() => (view.container.querySelector('[data-id="script"]') as HTMLElement).click())
    await settle()
    const before = geometry(view.container)
    const image = view.container.querySelector('[data-id="profile"] img')
    assert.ok(before.nodes.find(item => item.id === 'script')?.selected)
    assert.match(view.container.querySelector('[data-id="profile"] .pc-node-foot')!.textContent!, /生成中/)
    const mutations: MutationRecord[] = []
    const observer = new dom.window.MutationObserver(records => mutations.push(...records))
    observer.observe(view.container.querySelector('.pc-flow')!, { attributes: true, childList: true, characterData: true, subtree: true })
    for (let version = 1; version <= 5; version++) {
      await view.render(propsFor(structuredClone(detail), version, calls))
      assert.deepEqual(geometry(view.container), before, `snapshot ${version} keeps canvas geometry and selection`)
      assert.equal(view.container.querySelector('[data-id="profile"] img'), image, 'polling does not remount loaded media')
    }
    observer.disconnect()
    assert.deepEqual(mutations, [], 'unchanged snapshots cannot briefly remove connections or alter node DOM')
    const updated = structuredClone(detail)
    updated.jobs[0] = { ...updated.jobs[0], status: 'failed', error: '厂商暂不可用' }
    await view.render(propsFor(updated, 6, calls))
    assert.match(view.container.querySelector('[data-id="profile"] .pc-node-foot')!.textContent!, /生成失败/)
    assert.deepEqual(geometry(view.container), before, 'job status updates retain node geometry and selection')
    assert.deepEqual(requests, [{ path: '/api/projects/refresh/canvas', method: 'GET' }])
    assert.match(view.container.querySelector('.pc-save-status')!.textContent!, /已保存/)
  } finally { await view.destroy() }
})

function storyboardRevisionFixture() {
  const shot = { id: 'storyboard-shot', project_id: detail.id, position: 0, title: '十六岁的林晚', duration: 5,
    prompt: '十六岁的林晚走向站台', image_prompt: '十六岁的林晚站在站台，正面中景', video_prompt: '十六岁的林晚回头，镜头缓慢推近',
    source_scene_id: null, selected_asset_id: 'old-video', start_state: '', end_state: '', cut_note: '', storyboard_revision: 1 }
  const project = { ...structuredClone(detail), shots: [shot], visual_profiles: [], asset_tasks: [],
    assets: [
      { ...detail.assets[0], id: 'old-image', project_id: detail.id, shot_id: shot.id, source: 'generated', url: '/api/assets/old-image/file' },
      { ...detail.assets[0], id: 'old-video', project_id: detail.id, shot_id: shot.id, source: 'generated', kind: 'video', filename: 'old.mp4', url: '/api/assets/old-video/file' },
    ], jobs: ['image', 'video'].map(modality => ({ id: `old-${modality}-job`, project_id: detail.id, shot_id: shot.id, job_type: 'generation',
      status: 'running', result_asset_id: null, created_at: timestamp, updated_at: timestamp,
      request: JSON.stringify({ modality, storyboard_revision: 1, prompt: shot.prompt }) })),
  } as unknown as ProjectDetail
  const canvasGraph: CanvasGraph = { revision: 'storyboard-initial', nodes: [structuredClone(graph.nodes[0]),
    ...(['image', 'video'] as const).map((modality, index) => ({ ...node(`storyboard-${modality}`, 'generation', 900 + index * 520, 80, 440, 420),
      shot_id: shot.id, asset_id: `old-${modality}`, job_id: `old-${modality}-job`, title: shot.title, prompt: shot.prompt,
      settings: { modality, storyboard_revision: 1, prompt_is_final: true, prompt_override: '十六岁的旧定稿提示词', prompt_base: '旧正文',
        ...(modality === 'video' ? { storyboard_reference_asset_id: 'old-image' } : {}) } })),
    { ...node('historical-image', 'image', 900, 650, 400, 272), asset_id: 'old-image', title: '保留的历史图片' },
  ], edges: [{ id: 'old-first-frame', source: 'storyboard-image', target: 'storyboard-video', reference_asset_id: 'old-image' }] }
  const updated = structuredClone(project)
  updated.shots[0] = { ...updated.shots[0], title: '二十五岁的林晚', storyboard_revision: 2,
    prompt: '二十五岁的林晚走向站台', image_prompt: '二十五岁的林晚站在站台，正面中景', video_prompt: '二十五岁的林晚回头，镜头缓慢推近' }
  return { project, updated, canvasGraph }
}
function mockStoryboardRevisionCanvas(t: TestContext, canvasGraph: CanvasGraph, projectDetail = () => detail) {
  let current = structuredClone(canvasGraph)
  const saved: CanvasGraph[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path === '/api/projects/refresh' || path === '/api/projects/refresh/shot-management') {
      assert.equal(init?.method || 'GET', 'GET', 'explicit imports refresh their source without mutating project records')
      return Response.json(path.endsWith('/shot-management') ? { revision: 'fixture', shots: [], designs: [], canvases: [], scenes: [], trashed_assets: [] } : projectDetail())
    }
    if (path === '/api/projects/refresh/canvases') return Response.json([{ id: detail.id, project_id: detail.id, name: '画布 1', is_default: true, node_count: current.nodes.length, viewport: null }])
    if (path === '/api/projects/refresh/skills/defaults') return Response.json({ policies: [] })
    assert.equal(path, '/api/projects/refresh/canvas', 'revision synchronization cannot generate media or change project records')
    if (init?.method === 'PUT') {
      current = { ...JSON.parse(String(init.body)), revision: `revision-save-${saved.length}` }
      saved.push(structuredClone(current))
    } else assert.equal(init?.method || 'GET', 'GET')
    return Response.json(current)
  })
  return { saved, current: () => structuredClone(current) }
}
function revisionDraft() {
  const draft = dom.window.localStorage.getItem('project-canvas-draft:refresh')
  assert.ok(draft, 'revision updates retain a recoverable local draft')
  return JSON.parse(draft).graph as CanvasGraph
}
function assertCurrentStoryboard(canvasGraph: CanvasGraph) {
  for (const modality of ['image', 'video'] as const) {
    const item = canvasGraph.nodes.find(node => node.id === `storyboard-${modality}`)
    assert.ok(item)
    assert.equal(item.settings.storyboard_revision, 2)
    assert.equal(item.asset_id, null, `${modality} cannot restore historical media automatically`)
    assert.equal(item.job_id, null, `${modality} cannot keep a previous revision's job`)
    assert.match(item.prompt, /二十五岁/)
    assert.equal(item.settings.prompt_override, undefined)
    assert.equal(item.settings.storyboard_reference_asset_id, undefined)
  }
  assert.equal(canvasGraph.nodes.find(node => node.id === 'historical-image')?.asset_id, 'old-image', 'standalone historical media is preserved')
  assert.equal(canvasGraph.edges.some(edge => edge.id === 'old-first-frame'), false, 'old pinned image cannot become the new video first frame')
}

test('a refreshed storyboard revision replaces prompts and clears old media across late jobs and undo, while explicit history selection stays available', async t => {
  const { project, updated, canvasGraph } = storyboardRevisionFixture()
  const { saved } = mockStoryboardRevisionCanvas(t, canvasGraph)
  const view = await mount(propsFor(project, 0, []))
  try {
    assert.ok(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output img'))
    await act(() => button(view.container, '添加文本').click()); await settle()
    await view.render(propsFor(updated, 1, []))
    assertCurrentStoryboard(revisionDraft())
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output'), null)
    assert.equal(view.container.querySelector('[data-id="storyboard-video"] .pc-node-output'), null)
    await act(() => (view.container.querySelector('[data-id="storyboard-image"]') as HTMLElement).click()); await settle()
    assert.match(view.container.querySelector<HTMLElement>('[contenteditable][aria-label="创作提示词"]')!.textContent!, /二十五岁/)
    assert.doesNotMatch(view.container.querySelector<HTMLElement>('[contenteditable][aria-label="创作提示词"]')!.textContent!, /十六岁/)
    const completed = structuredClone(updated)
    completed.jobs = completed.jobs.map(job => ({ ...job, status: 'succeeded', result_asset_id: job.id === 'old-image-job' ? 'old-image' : 'old-video' }))
    await view.render(propsFor(completed, 2, []))
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output'), null, 'late completion of the previous revision cannot refill the node')
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    assertCurrentStoryboard(revisionDraft())
    await act(() => button(view.container, '重做画布操作').click()); await settle()
    assertCurrentStoryboard(revisionDraft())
    await act(() => (view.container.querySelector('[data-id="storyboard-image"]') as HTMLElement).click()); await settle()
    const candidate = [...view.container.querySelectorAll<HTMLButtonElement>('[aria-label="分镜图候选"] button')]
      .find(item => item.querySelector('img')?.getAttribute('src') === '/api/assets/old-image/file')
    assert.ok(candidate, 'historical results remain available for an explicit choice')
    await act(async () => candidate.click()); await settle()
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output img')?.getAttribute('src'), '/api/assets/old-image/file')
    await view.render(propsFor(structuredClone(completed), 3, []))
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output img')?.getAttribute('src'), '/api/assets/old-image/file', 'polling preserves a deliberate historical candidate choice')
  } finally { await view.destroy() }
  const current = saved.at(-1)!.nodes.find(node => node.id === 'storyboard-image')!
  assert.equal(current.settings.storyboard_revision, 2)
  assert.equal(current.asset_id, 'old-image')
  assert.equal(current.job_id, null)
})

test('restoring an older local draft upgrades storyboard prompts without restoring stale generated media', async t => {
  const { updated, canvasGraph } = storyboardRevisionFixture()
  const draft = structuredClone(canvasGraph)
  draft.nodes.push({ ...node('unsaved-note', 'text', 900, 1100, 420, 340), text: '保留的未保存备注' })
  const { saved } = mockStoryboardRevisionCanvas(t, canvasGraph)
  const view = await mount(propsFor(updated, 0, []), undefined, 0.8, () => {
    dom.window.localStorage.setItem('project-canvas-draft:refresh', JSON.stringify({ base: canvasGraph, graph: draft }))
  })
  try {
    assert.ok(view.container.querySelector('[data-id="unsaved-note"]'), 'unrelated unsaved edits survive revision synchronization')
    assertCurrentStoryboard(revisionDraft())
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output'), null)
    await act(() => (view.container.querySelector('[data-id="storyboard-video"]') as HTMLElement).click()); await settle()
    assert.match(view.container.querySelector<HTMLElement>('[contenteditable][aria-label="创作提示词"]')!.textContent!, /二十五岁/)
  } finally { await view.destroy() }
  assertCurrentStoryboard(saved.at(-1)!)
})

test('a completed job from an older storyboard cannot populate a node already marked with the current revision', async t => {
  const { updated, canvasGraph } = storyboardRevisionFixture()
  for (const node of canvasGraph.nodes) if (node.shot_id) { node.settings.storyboard_revision = 2; node.asset_id = null }
  updated.jobs = updated.jobs.map(job => ({ ...job, status: 'succeeded', result_asset_id: job.id === 'old-image-job' ? 'old-image' : 'old-video' }))
  mockStoryboardRevisionCanvas(t, canvasGraph)
  const view = await mount(propsFor(updated, 0, []))
  try {
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output'), null)
    assert.equal(view.container.querySelector('[data-id="storyboard-video"] .pc-node-output'), null)
    await view.render(propsFor(structuredClone(updated), 1, []))
    assert.equal(view.container.querySelector('[data-id="storyboard-image"] .pc-node-output'), null)
    assert.equal(view.container.querySelector('[data-id="storyboard-video"] .pc-node-output'), null)
  } finally { await view.destroy() }
})

test('importing replanned shots excludes previous-revision jobs and media while allowing current results and an explicit selected asset', async t => {
  const { updated, canvasGraph } = storyboardRevisionFixture()
  updated.shots[0].selected_asset_id = null
  updated.jobs = updated.jobs.map(job => ({ ...job, status: 'succeeded', result_asset_id: job.id === 'old-image-job' ? 'old-image' : 'old-video' }))
  canvasGraph.nodes = [canvasGraph.nodes[0]]; canvasGraph.edges = []
  let freshDetail = updated
  const { saved } = mockStoryboardRevisionCanvas(t, canvasGraph, () => freshDetail)
  const view = await mount(propsFor(updated, 0, []))
  try {
    await clickText(view.container, '导入分镜')
    const imported = saved.at(-1)!
    assert.ok(imported, 'explicit import persists its graph before reporting success')
    const generators = imported.nodes.filter(node => node.type === 'generation')
    assert.equal(generators.length, 1)
    assert.equal(generators[0].settings.storyboard_revision, 2)
    assert.match(generators[0].prompt, /二十五岁/)
    assert.equal(generators[0].job_id, null, 'import must not attach a successful job from the old screenplay')
    assert.equal(generators[0].asset_id, null)
    assert.equal(imported.nodes.some(node => node.asset_id === 'old-image' || node.asset_id === 'old-video'), false,
      'previous-revision media cannot be recreated as independent cards during shot import')

    const withCurrent = structuredClone(updated)
    withCurrent.shots[0].selected_asset_id = 'old-video'
    withCurrent.assets.push({ ...withCurrent.assets[0], id: 'current-image', url: '/api/assets/current-image/file' })
    withCurrent.jobs.unshift({ ...withCurrent.jobs[0], id: 'current-image-job', result_asset_id: 'current-image',
      request: JSON.stringify({ modality: 'image', storyboard_revision: 2, prompt: withCurrent.shots[0].image_prompt }) })
    freshDetail = withCurrent
    await view.render(propsFor(withCurrent, 1, []))
    await rightClick(view.container.querySelector('.react-flow__pane')!)
    await clickText(view.container.querySelector('.pc-context-menu')!, '导入分镜')
    const next = saved.at(-1)!
    assert.ok(next, 'the second explicit import persists its current media choices')
    assert.ok(next.nodes.some(node => node.type === 'generation' && node.job_id === 'current-image-job' && node.asset_id === 'current-image'),
      'a successful job for the current revision remains reusable')
    assert.ok(next.nodes.some(node => node.type === 'image' && node.asset_id === 'current-image'))
    assert.ok(next.nodes.some(node => node.type === 'video' && node.asset_id === 'old-video'), 'the explicitly selected final-cut asset remains importable')
    assert.equal(next.nodes.some(node => node.asset_id === 'old-image'), false, 'other historical assets remain excluded')
  } finally { await view.destroy() }
  assert.ok(saved.at(-1)?.nodes.some(node => node.asset_id === 'current-image'))
  assert.equal(saved.at(-1)?.nodes.some(node => node.asset_id === 'old-image'), false)
})

test('video metadata fits the result node and selection or repeated metadata cannot change its dimensions', async t => {
  const videoDetail = { ...detail, visual_profiles: [], asset_tasks: [], jobs: [],
    assets: [{ id: 'clip', kind: 'video', filename: 'shot.mp4', url: '/api/assets/clip/file', created_at: timestamp }] } as unknown as ProjectDetail
  const videoGraph = { ...graph, nodes: [{ ...node('clip-node', 'generation', 100, 100, 440, 420), title: '分镜视频', asset_id: 'clip', settings: { modality: 'video' } }], edges: [] }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    assert.equal(String(url), '/api/projects/refresh/canvas')
    return Response.json(init?.method === 'PUT' ? { ...JSON.parse(String(init.body)), revision: 'saved-video' } : videoGraph)
  })
  const view = await mount(propsFor(videoDetail, 0, []))
  try {
    assert.equal(view.container.querySelector('[data-id="clip-node"] video'), null, 'inactive video uses a static poster')
    await act(() => (view.container.querySelector('[data-id="clip-node"]') as HTMLElement).click()); await settle()
    const video = view.container.querySelector<HTMLVideoElement>('[data-id="clip-node"] video')!
    assert.ok(video)
    const frame = () => view.container.querySelector<HTMLElement>('[data-id="clip-node"]')!
    const size = () => ({ width: Number.parseFloat(frame().style.width), height: Number.parseFloat(frame().style.height) })
    const before = size()
    await act(() => video.dispatchEvent(new dom.window.Event('loadedmetadata')))
    assert.deepEqual(size(), before, 'unknown metadata leaves the node unchanged')
    Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } })
    await act(() => video.dispatchEvent(new dom.window.Event('loadedmetadata')))
    await settle()
    const fitted = size()
    assert.equal(fitted.width, 440); assert.ok(fitted.height < 420)
    assert.ok(Math.abs((fitted.width - 2) / (fitted.height - 2) - 16 / 9) < 1e-10)
    assert.ok(frame().querySelector('.pc-node-media-result'))
    await act(() => frame().click()); await settle()
    assert.equal(video.controls, false); assert.ok(video.closest('.studio-media-player')!.querySelector('[aria-label="播放素材"]'), 'selected video exposes component playback controls')
    assert.deepEqual(size(), fitted, 'selecting does not shrink or expand a fitted result')
    await act(() => video.dispatchEvent(new dom.window.Event('loadedmetadata'))); await settle()
    await view.render(propsFor(structuredClone(videoDetail), 1, []))
    assert.deepEqual(size(), fitted, 'polling and repeated metadata preserve the fitted frame')
    assert.equal(frame().querySelector('video'), video, 'refresh keeps the same loaded video element')
  } finally { await view.destroy() }
})

function mockEditableCanvas(t: TestContext) {
  let current = structuredClone(graph)
  const saved: CanvasGraph[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    assert.equal(String(url), '/api/projects/refresh/canvas', 'cleanup only writes the canvas, never project resources')
    if (!init?.method || init.method === 'GET') return Response.json(current)
    assert.equal(init.method, 'PUT')
    const payload = JSON.parse(String(init.body)) as CanvasGraph
    saved.push(payload)
    current = { ...payload, revision: `saved-${saved.length}` }
    return Response.json(current)
  })
  return { saved }
}

async function key(target: Element | Window, value: string, modifiers: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers })
  await act(() => target.dispatchEvent(event)); await settle()
  return event
}

async function multiSelect(container: HTMLElement, ids: string[]) {
  await key(dom.window, 'Control', { code: 'ControlLeft', ctrlKey: true })
  for (const id of ids) {
    await act(() => container.querySelector(`[data-id="${id}"]`)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })))
    await settle()
  }
  await act(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' })))
}

async function rightClick(element: Element) {
  await act(() => element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 800, clientY: 500 })))
  await settle()
}

async function clickText(container: ParentNode, text: string) {
  const matches = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.textContent?.trim() === text)
  assert.equal(matches.length, 1, `one button named ${text}`)
  // Real pointer-down exercises the document capture listener, which must not
  // dismiss a selection before the toolbar's click reaches the delete action.
  await act(() => matches[0].dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
  await act(async () => { matches[0].click(); await Promise.resolve() }); await settle()
}

async function answerDialog(text: '取消' | '移除' | '清空画布') {
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  await clickText(dialog, text)
}

const selectedIds = (container: HTMLElement) => geometry(container).nodes.filter(item => item.selected).map(item => item.id)
const nodeIds = (container: HTMLElement) => geometry(container).nodes.map(item => item.id)
const editableIds = graph.nodes.filter(item => item.type !== 'project_script_ref').map(item => item.id)
function assertScriptOnly(container: HTMLElement) {
  const nodes = [...container.querySelectorAll('.react-flow__node')]
  assert.equal(nodes.length, 1, 'only the permanent project script remains visible')
  assert.ok(nodes[0].querySelector('.pc-node-project_script_ref'), 'remaining node is the project script, never a reimported shot')
  assert.equal(container.querySelectorAll('.react-flow__edge-path').length, 0)
}
function assertSavedScriptOnly(nodes: CanvasNode[] | undefined) {
  assert.ok(nodes)
  assert.equal(nodes.length, 1, 'only the permanent project script is persisted')
  assert.equal(nodes[0].type, 'project_script_ref')
}

async function nodeFilterMenu(container: HTMLElement) {
  await act(() => button(container, '筛选画布节点类型').click()); await settle()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  assert.ok(menu, 'node filter opens the component menu')
  return menu
}

async function chooseNodeFilter(container: HTMLElement, label: string) {
  const menu = await nodeFilterMenu(container)
  const option = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.trim().startsWith(label))
  assert.ok(option, `filter option ${label}`)
  await act(() => option.click()); await settle()
}

function mixedModalityCanvas() {
  const canvasGraph = structuredClone(graph)
  canvasGraph.nodes.push(
    { ...node('image-generation', 'generation', 1400, 80, 400, 300), title: '补充图片', settings: { modality: 'image' } },
    { ...node('video-generation', 'generation', 1400, 550, 440, 300), title: '镜头视频', model_id: 'video-model' },
    { ...node('text-generation', 'generation', 1400, 980, 420, 340), title: '文字生成', settings: { modality: 'text' } },
  )
  canvasGraph.edges.push({ id: 'image-to-video', source: 'image', target: 'video-generation' })
  const props = propsFor(detail, 0, [])
  props.models = [{ id: 'video-model', provider_id: 'provider', name: '视频模型', remote_id: 'video-model', modality: 'video',
    protocol: 'async_video', enabled: true, settings: { supported_modes: ['text'], resolutions: ['720p'], ratios: ['9:16'] } }]
  return { canvasGraph, props }
}

test('node type filters include generated modalities and profile images, hide crossing edges and minimap entries, and restore the complete canvas', async t => {
  const { canvasGraph, props } = mixedModalityCanvas()
  const original = structuredClone(canvasGraph), requests = mockCanvas(t, canvasGraph)
  const view = await mount(props)
  try {
    const menu = await nodeFilterMenu(view.container)
    for (const [label, count] of [['全部节点', 7], ['图片节点', 3], ['视频节点', 1], ['文本节点', 2], ['剧本节点', 1]] as const) {
      const option = [...menu.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim().startsWith(label))
      assert.ok(option, label)
      assert.match(option.textContent!.trim(), new RegExp(`${label}\\s*${count}$`), `${label} shows its full graph count`)
    }
    const imageOption = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent?.startsWith('图片节点'))!
    await act(() => imageOption.click()); await settle()
    assert.deepEqual(nodeIds(view.container), ['image', 'profile', 'image-generation'])
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 1, 'only the image-to-image connection remains visible')
    await act(() => button(view.container, '显示小地图').click()); await settle()
    assert.equal(view.container.querySelectorAll('.react-flow__minimap-node').length, 3, 'minimap excludes hidden nodes')
    await chooseNodeFilter(view.container, '视频节点')
    assert.deepEqual(nodeIds(view.container), ['video-generation'], 'a generation node inherits its model modality')
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    assert.equal(view.container.querySelectorAll('.react-flow__minimap-node').length, 1)
    await chooseNodeFilter(view.container, '文本节点')
    assert.deepEqual(nodeIds(view.container), ['text', 'text-generation'])
    await chooseNodeFilter(view.container, '剧本节点')
    assert.deepEqual(nodeIds(view.container), ['script'])
    await chooseNodeFilter(view.container, '全部节点')
    assert.deepEqual(nodeIds(view.container), canvasGraph.nodes.map(node => node.id))
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 3)
    assert.equal(view.container.querySelectorAll('.react-flow__minimap-node').length, 7)
    assert.deepEqual(canvasGraph, original, 'filtering never changes persisted nodes or connections')
    assert.equal(requests.some(request => request.method === 'PUT'), false)
  } finally { await view.destroy() }
})

test('filter changes trim hidden selections and select-all scopes to visible nodes; an empty filter can recover without saving', async t => {
  const requests = mockCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), editableIds)
    await chooseNodeFilter(view.container, '图片节点')
    assert.deepEqual(selectedIds(view.container), ['image', 'profile'], 'hidden script and text nodes leave the selection')
    await key(surface, 'Escape')
    await key(surface, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), ['image', 'profile'], 'select-all cannot select hidden nodes')
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 2 个节点/)
    await chooseNodeFilter(view.container, '视频节点')
    assert.deepEqual(nodeIds(view.container), [])
    assert.deepEqual(selectedIds(view.container), [])
    assert.equal(view.container.querySelector('.pc-selection-toolbar'), null)
    await key(surface, 'a', { ctrlKey: true })
    assert.equal(view.container.querySelector('.pc-selection-toolbar'), null, 'empty view cannot select hidden graph records')
    await clickText(view.container, '显示全部节点')
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    assert.equal(requests.some(request => request.method === 'PUT'), false, 'filter and selection changes do not autosave graph data')
    assert.equal(dom.window.localStorage.getItem('project-canvas-draft:refresh'), null)
  } finally { await view.destroy() }
})

test('parent refresh preserves the session filter and locating a hidden node from the sidebar reveals and selects it without saving', async t => {
  const requests = mockCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    await chooseNodeFilter(view.container, '图片节点')
    await view.render(propsFor(structuredClone(detail), 1, []))
    assert.deepEqual(nodeIds(view.container), ['image', 'profile'], 'polling does not reset the current filter')
    await act(() => button(view.container, '打开左侧节点列表').click()); await settle()
    const hiddenNode = [...view.container.querySelectorAll<HTMLButtonElement>('.pc-sidebar-node-main')]
      .find(item => item.querySelector('strong')?.textContent === '镜头提示词')
    assert.ok(hiddenNode, 'sidebar retains hidden canvas nodes')
    await act(() => hiddenNode.click()); await settle()
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id), 'locating a hidden node restores all node types')
    assert.deepEqual(selectedIds(view.container), ['text'])
    assert.ok(view.container.querySelector('[data-id="text"] [contenteditable="true"]'), 'revealed text node is the active editing target')
    assert.equal(requests.some(request => request.method === 'PUT'), false)
  } finally { await view.destroy() }
})

test('filtered deletion saves the complete remaining graph and undo restores it; adding a hidden type reveals the new node', async t => {
  const { saved } = mockEditableCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const surface = view.container.querySelector('.pc-flow')!
    await chooseNodeFilter(view.container, '文本节点')
    await key(surface, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), ['text'])
    await key(surface, 'Delete'); await answerDialog('移除')
    assert.deepEqual(nodeIds(view.container), [], 'the only visible text node was removed')
    await chooseNodeFilter(view.container, '全部节点')
    assert.deepEqual(nodeIds(view.container), ['script', 'image', 'profile'], 'hidden nodes survive the visible selection deletion')
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].nodes.map(node => node.id), ['script', 'image', 'profile'])
    assert.deepEqual(saved[0].edges, [{ id: 'reference', source: 'image', target: 'profile' }], 'an unrelated hidden-node connection is persisted')
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 2)
    await chooseNodeFilter(view.container, '图片节点')
    await act(() => button(view.container, '添加视频生成节点').click()); await settle()
    const newId = nodeIds(view.container).find(id => !graph.nodes.some(node => node.id === id))
    assert.ok(newId, 'new video generation node becomes visible despite the previous image filter')
    assert.deepEqual(nodeIds(view.container), [...graph.nodes.map(node => node.id), newId], 'adding a hidden type restores all nodes')
    assert.deepEqual(selectedIds(view.container), [newId])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    const latest = saved.at(-1)!
    assert.equal(latest.nodes.find(node => node.id === newId)?.settings.modality, 'video')
    assert.deepEqual(latest.edges, graph.edges)
    for (const snapshot of saved) {
      for (const item of [...snapshot.nodes, ...snapshot.edges]) assert.equal(Object.hasOwn(item, 'hidden'), false, 'view-only visibility is never serialized')
    }
  } finally { await view.destroy() }
})

test('Shift box selection excludes the project script and retains its ordinary-node batch on right click', async t => {
  const canvasGraph = structuredClone(graph)
  canvasGraph.nodes[1].y = 80
  mockCanvas(t, canvasGraph)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const pane = view.container.querySelector('.react-flow__pane')!
    await key(dom.window, 'Shift', { code: 'ShiftLeft', shiftKey: true })
    for (const [type, x, y] of [['pointerdown', 20, 20], ['pointermove', 1100, 450], ['pointerup', 1100, 450]] as const) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, shiftKey: true })
      Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
      await act(() => pane.dispatchEvent(event)); await settle()
    }
    await act(() => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }))); await settle()
    assert.deepEqual(selectedIds(view.container), ['text', 'profile'])
    const overlay = view.container.querySelector('.react-flow__nodesselection-rect')!
    assert.ok(overlay, 'actual React Flow box-selection overlay is present')
    await act(() => overlay.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 2 })))
    await settle()
    await rightClick(overlay)
    assert.deepEqual(selectedIds(view.container), ['text', 'profile'])
    assert.match(view.container.querySelector('.pc-context-menu')!.textContent!, /删除所选 2 个节点/)
    await clickText(view.container.querySelector('.pc-context-menu')!, '取消选择')
    assert.deepEqual(selectedIds(view.container), [])
  } finally { await view.destroy() }
})

test('canvas select-all supports both platforms, while text editing and sidebar shortcuts keep their native scope', async t => {
  const requests = mockCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const surface = view.container.querySelector('.pc-flow')!
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      assert.equal((await key(surface, 'a', modifiers)).defaultPrevented, true)
      assert.deepEqual(selectedIds(view.container), editableIds)
      assert.match(view.container.querySelector('[aria-label="多选节点操作"]')!.textContent!, /已选 3 个节点/)
      await clickText(view.container.querySelector('.pc-selection-toolbar')!, '取消选择')
      assert.deepEqual(selectedIds(view.container), [])
    }
    await act(() => (view.container.querySelector('[data-id="text"]') as HTMLElement).click()); await settle()
    const editor = view.container.querySelector('[data-id="text"] [contenteditable="true"]')!
    assert.ok(editor, 'actual text editor is present')
    await key(editor, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), ['text'], 'text select-all does not select every canvas node')
    await key(editor, 'Backspace')
    assert.equal(document.querySelector('[role="dialog"]'), null, 'editing cannot open canvas deletion')
    await act(() => button(view.container, '打开左侧节点列表').click()); await settle()
    const search = view.container.querySelector('[aria-label="搜索画布节点"]')!
    assert.equal((await key(search, 'a', { ctrlKey: true })).defaultPrevented, false)
    assert.deepEqual(selectedIds(view.container), ['text'])
    assert.equal((await key(view.container.querySelector('.project-canvas')!, 'a', { ctrlKey: true })).defaultPrevented, false)
    assert.equal(requests.length, 1, 'selection changes do not autosave graph data')
  } finally { await view.destroy() }
})

test('modifier multi-selection survives right click and batch removal preserves other nodes, supports undo/redo and autosaves', async t => {
  const { saved } = mockEditableCanvas(t)
  const untouched = structuredClone(detail)
  const view = await mount(propsFor(detail, 0, []))
  try {
    await multiSelect(view.container, ['text', 'image'])
    assert.deepEqual(selectedIds(view.container), ['text', 'image'])
    await rightClick(view.container.querySelector('[data-id="image"]')!)
    assert.deepEqual(selectedIds(view.container), ['text', 'image'], 'right-click preserves the batch')
    await clickText(view.container.querySelector('.pc-context-menu')!, '删除所选 2 个节点')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /移除 2 个节点/)
    await answerDialog('取消')
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    assert.deepEqual(selectedIds(view.container), ['text', 'image'])
    await clickText(view.container.querySelector('.pc-selection-toolbar')!, '删除所选')
    await answerDialog('移除')
    assert.deepEqual(nodeIds(view.container), ['script', 'profile'])
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    assert.equal(view.container.querySelector('.pc-selection-toolbar'), null)
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id), 'one undo restores the whole batch')
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 2, 'undo restores attached edges')
    await act(() => button(view.container, '重做画布操作').click()); await settle()
    assert.deepEqual(nodeIds(view.container), ['script', 'profile'])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    assert.equal(saved.length, 1, 'batch removal persists as one graph save')
    assert.deepEqual(saved[0].nodes.map(node => node.id), ['script', 'profile'])
    assert.deepEqual(saved[0].edges, [])
    assert.deepEqual(detail, untouched, 'shots, assets, jobs and definitions are preserved')
  } finally { await view.destroy() }
})

test('right-click on an unselected node offers a single-node deletion and preserves the remaining graph', async t => {
  mockEditableCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    await multiSelect(view.container, ['script', 'text'])
    await rightClick(view.container.querySelector('[data-id="image"]')!)
    assert.deepEqual(selectedIds(view.container), ['image'])
    await clickText(view.container.querySelector('.pc-context-menu')!, '删除节点')
    await answerDialog('移除')
    assert.deepEqual(nodeIds(view.container), ['script', 'text', 'profile'])
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 1, 'unrelated edge is retained')
  } finally { await view.destroy() }
})

test('repeated delete keys open one batch confirmation and Escape clears the selection after cancellation', async t => {
  const requests = mockCanvas(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true })
    await key(surface, 'Delete')
    await key(surface, 'Delete', { repeat: true })
    await key(surface, 'Backspace')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    await key(document.querySelector('[role="dialog"]')!, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), editableIds)
    await answerDialog('取消')
    await key(surface, 'Escape')
    assert.deepEqual(selectedIds(view.container), [])
    assert.equal(view.container.querySelector('.pc-selection-toolbar'), null)
    await key(surface, 'Delete')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(requests.length, 1, 'cancelled removal never saves')
  } finally { await view.destroy() }
})

test('clear-canvas menu protects the project script and project records after refresh, undo and redo', async t => {
  const { saved } = mockEditableCanvas(t)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []))
  try {
    await rightClick(view.container.querySelector('.react-flow__pane')!)
    await clickText(view.container.querySelector('.pc-context-menu')!, '清空画布')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /清空画布（3 个节点）/)
    await answerDialog('取消')
    assert.equal(nodeIds(view.container).length, 4)
    await clickText(view.container.querySelector('.pc-context-menu')!, '清空画布')
    await answerDialog('清空画布')
    assertScriptOnly(view.container)
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    assert.equal(dom.window.localStorage.getItem('project-canvas-imported:refresh'), null, 'remaining empty never relies on a browser import marker')
    await view.render(propsFor(structuredClone(withShots), 1, []))
    assertScriptOnly(view.container)
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'z', { ctrlKey: true })
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    await key(surface, 'z', { ctrlKey: true, shiftKey: true })
    assertScriptOnly(view.container)
    await act(() => button(view.container, '画布操作菜单').click()); await settle()
    const menu = document.querySelector('.pc-sidebar-dropdown')!
    const clear = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '清空画布')!
    assert.ok(clear)
    assert.equal(clear.disabled, true, 'empty canvas cannot request another clear')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    assert.equal(saved.length, 1)
    assertSavedScriptOnly(saved[0].nodes)
    assert.deepEqual(saved[0].edges, [])
    assert.equal(withShots.shots[0].id, 'kept-shot')
    assert.equal(withShots.assets.length, detail.assets.length)
    assert.equal(withShots.jobs.length, detail.jobs.length)
  } finally { await view.destroy() }
})

function mockMultipleCanvases(t: TestContext, rejectSave = false, secondGraph?: CanvasGraph, defaultGraph: CanvasGraph = graph) {
  const graphs = new Map<string, CanvasGraph>([['refresh', structuredClone(defaultGraph)]])
  if (secondGraph) graphs.set('canvas-2', structuredClone(secondGraph))
  let metadata: ProjectCanvasInfo[] = [{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: defaultGraph.nodes.length, viewport: null as { x: number; y: number; zoom: number } | null },
    ...(secondGraph ? [{ id: 'canvas-2', project_id: 'refresh', name: '画布 2', is_default: false, node_count: secondGraph.nodes.length,
      viewport: { x: -50, y: 25, zoom: 0.6 } }] : [])]
  const requests: Array<{ path: string; method: string; body?: any }> = []
  const failures = { remainingSaves: 0 }
  const controls: { nextListGate?: Promise<void>; projectDetail?: ProjectDetail } = {}
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    if (path === '/api/projects/refresh' || path === '/api/projects/refresh/shot-management') {
      assert.equal(method, 'GET', 'manual imports may only read the latest project and shot state')
      return Response.json(path.endsWith('/shot-management') ? { revision: 'fixture', shots: [], designs: [], canvases: [], scenes: [], trashed_assets: [] } : controls.projectDetail || detail)
    }
    if (path === '/api/projects/refresh/canvases') {
      if (method === 'POST') {
        const created = { id: `canvas-${metadata.length + 1}`, project_id: 'refresh', name: `画布 ${metadata.length + 1}`, is_default: false, node_count: 0, viewport: null }
        metadata.push(created); graphs.set(created.id, { revision: 'empty-revision', nodes: [], edges: [] })
        // Explicit camera avoids React Flow's animated first-node centering in this manual-RAF harness.
        dom.window.localStorage.setItem(`project-canvas-viewport:refresh:${created.id}`, JSON.stringify({ x: -50, y: 25, zoom: 0.6 }))
        return Response.json(created)
      }
      const gate = controls.nextListGate; controls.nextListGate = undefined
      if (gate) await gate
      return Response.json(metadata)
    }
    const match = /^\/api\/projects\/refresh\/(?:canvas$|canvases\/([^/]+)$)/.exec(path)
    assert.ok(match, `unexpected request ${path}`)
    const id = match[1] || 'refresh'
    const current = graphs.get(id)!
    if (method === 'PATCH') {
      metadata = metadata.map(canvas => canvas.id === id ? { ...canvas, ...body } : canvas)
      return Response.json(metadata.find(canvas => canvas.id === id))
    }
    if (method === 'PUT') {
      if (rejectSave || failures.remainingSaves > 0) {
        if (failures.remainingSaves > 0) failures.remainingSaves--
        return Response.json({ detail: '测试保存失败' }, { status: 500 })
      }
      assert.equal(body.revision, current.revision)
      const updated = { ...body, revision: `saved-${requests.length}` }; graphs.set(id, updated)
      return Response.json(updated)
    }
    return Response.json(current)
  })
  const addCanvas = (id: string, designId: string, canvasGraph: CanvasGraph = { revision: `empty-${id}`, nodes: [], edges: [] }) => {
    metadata.push({ id, project_id: 'refresh', name: `新方案 ${id}`, design_id: designId, is_default: false, node_count: canvasGraph.nodes.length, viewport: { x: 0, y: 0, zoom: 0.6 } })
    graphs.set(id, structuredClone(canvasGraph))
  }
  return { graphs, requests, failures, controls, addCanvas }
}
async function canvasMenu(container: HTMLElement) {
  await act(() => button(container, '切换画布').click()); await settle()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  assert.ok(menu); return menu
}

function sidebarTab(container: HTMLElement, label: '画布' | '资产' | '设定') {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('.pc-sidebar-tabs [role="tab"]')]
    .find(element => element.textContent?.trim().startsWith(label))
  assert.ok(tab, `sidebar tab ${label}`)
  return tab
}

function sidebarCount(container: HTMLElement, label: '画布' | '资产' | '设定') {
  return Number(sidebarTab(container, label).querySelector('.pc-sidebar-tab-count')?.textContent)
}

async function openSidebarTab(container: HTMLElement, label: '画布' | '资产' | '设定') {
  if (!container.querySelector('.pc-canvas-sidebar')) {
    await act(() => button(container, '打开左侧节点列表').click()); await settle()
  }
  await act(() => sidebarTab(container, label).click()); await settle()
}

async function searchSidebar(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.ok(input, `sidebar search ${label}`)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}

function sidebarScopeDetail(): ProjectDetail {
  const extraProfile = (id: string, name: string, kind: VisualProfile['kind'], designId: string | null) => ({
    ...profile, id, name, kind, design_id: designId, board_asset_id: null, asset_task_id: null,
  })
  return { ...detail,
    visual_profiles: [profile, extraProfile('legacy-location', '旧方案车站', 'location', null),
      extraProfile('current-character', '新方案乘客', 'character', 'design-new'),
      extraProfile('current-location', '新方案站台', 'location', 'design-new'),
      extraProfile('current-prop', '新方案车票', 'prop', 'design-new'),
      extraProfile('archived-character', '归档方案列车员', 'character', 'design-archived')],
    assets: [{ ...detail.assets[0], saved: true },
      { ...detail.assets[0], id: 'current-saved', filename: '新方案已保存.png', saved: true },
      { ...detail.assets[0], id: 'history-saved', kind: 'audio', filename: '历史方案已保存.mp3', saved: true },
      { ...detail.assets[0], id: 'unsaved', filename: '未保存候选.png', saved: false },
      { ...detail.assets[0], id: 'exported', kind: 'video', filename: '成片导出.mp4', source: 'export', saved: true }],
  } as ProjectDetail
}

test('profile sidebar badges follow the selected design scope across canvases while search and type filters only narrow the list', async t => {
  const { addCanvas } = mockMultipleCanvases(t)
  addCanvas('canvas-new', 'design-new', { revision: 'new-design', nodes: structuredClone(graph.nodes.slice(0, 2)), edges: [] })
  const view = await mount(propsFor(sidebarScopeDetail(), 0, []))
  const names = () => [...view.container.querySelectorAll('.pc-sidebar-profile strong')].map(element => element.textContent)
  try {
    await openSidebarTab(view.container, '设定')
    assert.equal(sidebarCount(view.container, '设定'), 2, 'the legacy canvas counts only its own unscoped profiles')
    assert.deepEqual(names(), ['林晚', '旧方案车站'])
    await clickText(view.container.querySelector('[aria-label="设定类型筛选"]')!, '人物')
    assert.deepEqual(names(), ['林晚'])
    assert.equal(sidebarCount(view.container, '设定'), 2, 'type filters do not redefine the scope total')
    const scope = view.container.querySelector<HTMLInputElement>('[aria-label="设定方案范围"]')!
    await chooseCombobox(scope, '全部方案（含历史）'); await settle()
    assert.equal(sidebarCount(view.container, '设定'), 6, 'all-scope includes current, other and archived designs')
    assert.deepEqual(names(), ['林晚', '新方案乘客', '归档方案列车员'])
    await searchSidebar(view.container, '搜索视觉设定', '归档')
    assert.deepEqual(names(), ['归档方案列车员'])
    assert.equal(sidebarCount(view.container, '设定'), 6, 'search does not change the selected scope count')
    await clickText(await canvasMenu(view.container), '新方案 canvas-new')
    await openSidebarTab(view.container, '设定')
    assert.equal(view.container.querySelector<HTMLInputElement>('[aria-label="设定方案范围"]')!.value, '当前方案设定')
    assert.equal(sidebarCount(view.container, '设定'), 3, 'the new canvas defaults to its own design scope')
    assert.deepEqual(names(), ['新方案乘客', '新方案站台', '新方案车票'])
    await chooseCombobox(view.container.querySelector<HTMLInputElement>('[aria-label="设定方案范围"]')!, '全部方案（含历史）'); await settle()
    assert.equal(sidebarCount(view.container, '设定'), 6)
    assert.equal(names().length, 6)
    await clickText(await canvasMenu(view.container), '画布 1')
    await openSidebarTab(view.container, '设定')
    assert.equal(sidebarCount(view.container, '设定'), 2, 'returning to another canvas also restores a consistent default scope')
    assert.deepEqual(names(), ['林晚', '旧方案车站'])
  } finally { await view.destroy() }
})

test('canvas sidebar counts only current graph nodes including its script while assets remain project-shared saved non-export media', async t => {
  const { addCanvas } = mockMultipleCanvases(t)
  addCanvas('canvas-new', 'design-new', { revision: 'new-design', nodes: structuredClone(graph.nodes.slice(0, 2)), edges: [] })
  const view = await mount(propsFor(sidebarScopeDetail(), 0, []))
  const assetNames = () => [...view.container.querySelectorAll('.pc-sidebar-asset-copy strong')].map(element => element.textContent)
  try {
    await openSidebarTab(view.container, '画布')
    assert.equal(sidebarCount(view.container, '画布'), 4, 'the current graph count includes the permanent project script')
    assert.equal(view.container.querySelectorAll('.pc-sidebar-node-main').length, 4)
    await chooseCombobox(view.container.querySelector<HTMLInputElement>('[aria-label="节点类型筛选"]')!, '图片节点'); await settle()
    assert.equal(view.container.querySelectorAll('.pc-sidebar-node-main').length, 1)
    assert.equal(sidebarCount(view.container, '画布'), 4, 'node-type filters do not change the graph total')
    await searchSidebar(view.container, '搜索画布节点', '没有这个节点')
    assert.equal(view.container.querySelectorAll('.pc-sidebar-node-main').length, 0)
    assert.equal(sidebarCount(view.container, '画布'), 4)
    await openSidebarTab(view.container, '资产')
    assert.equal(sidebarCount(view.container, '资产'), 3, 'project-shared saved media count, unsaved and exports do not')
    assert.equal(assetNames().length, 3)
    assert.ok(assetNames().includes('历史方案已保存.mp3'), 'archived saved media stay accessible in the project library')
    assert.ok(assetNames().includes('新方案已保存.png'))
    assert.doesNotMatch(assetNames().join(' '), /未保存候选|成片导出/)
    assert.match(view.container.querySelector('.pc-sidebar-tools')!.textContent!, /项目共享 · 已保存素材/)
    await clickText(view.container.querySelector('[aria-label="资产类型筛选"]')!, '音频')
    assert.deepEqual(assetNames(), ['历史方案已保存.mp3'])
    assert.equal(sidebarCount(view.container, '资产'), 3, 'asset kind filters only narrow the list')
    await searchSidebar(view.container, '搜索资产', '不存在的素材')
    assert.equal(assetNames().length, 0)
    assert.equal(sidebarCount(view.container, '资产'), 3)
    await clickText(await canvasMenu(view.container), '新方案 canvas-new')
    await openSidebarTab(view.container, '资产')
    assert.equal(sidebarCount(view.container, '画布'), 2, 'canvas changes replace the node total instead of accumulating across canvases')
    assert.equal(sidebarCount(view.container, '资产'), 3, 'switching canvases preserves the shared library total')
    assert.equal(assetNames().length, 3)
    assert.ok(assetNames().includes('历史方案已保存.mp3'))
    await openSidebarTab(view.container, '画布')
    assert.equal(view.container.querySelectorAll('.pc-sidebar-node-main').length, 2)
    assert.match(view.container.querySelector('.pc-sidebar-list')!.textContent!, /项目级剧本/)
  } finally { await view.destroy() }
})

for (const target of ['default', 'secondary'] as const) test(`missing project script is backfilled exactly once in the ${target} canvas and survives remount`, async t => {
  const existingNode = { ...structuredClone(graph.nodes[1]), ...(target === 'secondary' ? { x: -1_000_000 } : {}) }
  const noScript: CanvasGraph = { revision: 'legacy-no-script', nodes: [existingNode], edges: [] }
  const { graphs } = mockMultipleCanvases(t, false, noScript, noScript)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '未加入的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const targetId = target === 'default' ? 'refresh' : 'canvas-2'
  const view = await mount(propsFor(withShots, 0, []))
  try {
    if (target === 'secondary') await clickText(await canvasMenu(view.container), '画布 2')
    assert.equal(view.container.querySelectorAll('.pc-node-project_script_ref').length, 1)
    assert.equal(nodeIds(view.container).length, 2, 'only the missing project script is added, never project shots')
    assert.ok(view.container.querySelector('[data-id="text"]'), 'backfill preserves existing canvas content')
    await view.render(propsFor(structuredClone(withShots), 1, []))
    assert.equal(view.container.querySelectorAll('.pc-node-project_script_ref').length, 1, 'parent refresh cannot duplicate the script')
    await clickText(await canvasMenu(view.container), target === 'default' ? '画布 2' : '画布 1')
    assert.equal(graphs.get(targetId)?.nodes.filter(node => node.type === 'project_script_ref').length, 1, 'backfilled script is persisted for this canvas')
    assert.ok(graphs.get(targetId)!.nodes.every(node => node.x >= -1_000_000), 'backfill stays within valid coordinates even at the canvas boundary')
    await clickText(await canvasMenu(view.container), target === 'default' ? '画布 1' : '画布 2')
    assert.equal(view.container.querySelectorAll('.pc-node-project_script_ref').length, 1, 'switching back cannot duplicate the script')
    assert.equal(nodeIds(view.container).length, 2)
  } finally { await view.destroy() }
  const reopened = await mount(propsFor(structuredClone(withShots), 2, []))
  try {
    if (target === 'secondary') await clickText(await canvasMenu(reopened.container), '画布 2')
    assert.equal(reopened.container.querySelectorAll('.pc-node-project_script_ref').length, 1, 'fresh session loads a single saved script')
    assert.equal(nodeIds(reopened.container).length, 2)
  } finally { await reopened.destroy() }
})

test('the project script can be opened, selected and moved while direct deletion and select-all protect it', async t => {
  const { saved } = mockEditableCanvas(t), calls: string[] = []
  let movedX = Number.NaN
  const view = await mount(propsFor(detail, 0, calls))
  try {
    const script = view.container.querySelector<HTMLElement>('[data-id="script"]')!
    await act(() => script.click()); await settle()
    assert.deepEqual(selectedIds(view.container), ['script'], 'explicit single selection stays available for moving and resizing')
    const before = script.getAttribute('style')
    await key(script, 'ArrowRight')
    assert.notEqual(script.getAttribute('style'), before, 'the project script still supports normal keyboard movement')
    movedX = Number(/translate\(([-\d.]+)px/.exec(script.getAttribute('style') || '')?.[1])
    assert.ok(movedX > graph.nodes[0].x, 'ArrowRight moves the project script to the right')
    await key(view.container.querySelector('.pc-flow')!, 'Delete')
    assert.equal(document.querySelector('[role="dialog"]'), null, 'a selected project script cannot enter the deletion workflow')
    assert.ok(view.container.querySelector('[data-id="script"]'))
    await rightClick(script)
    assert.equal([...view.container.querySelectorAll('.pc-context-menu [role="menuitem"]')].some(item => item.textContent?.trim() === '删除节点' && !(item as HTMLButtonElement).disabled), false,
      'the project script has no enabled context deletion action')
    await key(dom.window, 'Escape')
    await act(() => button(view.container, '打开剧本对话').click())
    await act(() => button(view.container, '编辑剧本').click())
    assert.deepEqual(calls.slice(-2), ['director:0:all', 'editor:0'])
    await chooseNodeFilter(view.container, '剧本节点')
    await act(() => script.click()); await settle()
    assert.deepEqual(selectedIds(view.container), ['script'])
    await key(view.container.querySelector('.pc-flow')!, 'a', { metaKey: true })
    assert.deepEqual(selectedIds(view.container), [], 'select-all on a script-only filter clears an existing script selection')
    await key(view.container.querySelector('.pc-flow')!, 'Delete')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await chooseNodeFilter(view.container, '全部节点')
    await act(() => script.click()); await settle()
    await key(view.container.querySelector('.pc-flow')!, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), editableIds, 'select-all replaces a prior script selection with only deletable nodes')
    await key(view.container.querySelector('.pc-flow')!, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
  } finally { await view.destroy() }
  assertSavedScriptOnly(saved.at(-1)?.nodes)
  assert.equal(saved.at(-1)?.nodes[0].x, movedX, 'protected movement survives the later bulk deletion')
})

for (const target of ['default', 'secondary'] as const) test(`select-all deletion retains only the script when switching away from the ${target} canvas with project shots and returning immediately`, async t => {
  const { graphs, requests } = mockMultipleCanvases(t, false, graph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const originalDetail = structuredClone(withShots)
  const view = await mount(propsFor(withShots, 0, []))
  const targetId = target === 'default' ? 'refresh' : 'canvas-2'
  const targetLabel = target === 'default' ? '画布 1' : '画布 2'
  const otherLabel = target === 'default' ? '画布 2' : '画布 1'
  try {
    if (target === 'secondary') await clickText(await canvasMenu(view.container), targetLabel)
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true })
    assert.deepEqual(selectedIds(view.container), editableIds)
    await key(surface, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    // Switch before the 650ms autosave debounce: leaving must flush the deletion
    // while preserving its script, before reloading the server snapshot.
    await clickText(await canvasMenu(view.container), otherLabel)
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    assertSavedScriptOnly(graphs.get(targetId)?.nodes)
    assert.deepEqual(graphs.get(targetId)?.edges, [])
    await clickText(await canvasMenu(view.container), targetLabel)
    assertScriptOnly(view.container)
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    const targetPath = target === 'default' ? '/api/projects/refresh/canvas' : '/api/projects/refresh/canvases/canvas-2'
    const saves = requests.filter(request => request.path === targetPath && request.method === 'PUT')
    assert.ok(saves.length > 0, 'switching saved the deletion immediately')
    for (const save of saves) { assertSavedScriptOnly(save.body.nodes); assert.deepEqual(save.body.edges, []) }
    assert.deepEqual(withShots, originalDetail, 'deleting canvas cards preserves project shots, source assets and tasks')
  } finally { await view.destroy() }
})

for (const target of ['default', 'secondary'] as const) test(`select-all deletion of the ${target} canvas survives a complete remount without local import markers`, async t => {
  const { graphs, requests, controls } = mockMultipleCanvases(t, false, graph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  controls.projectDetail = withShots
  const targetId = target === 'default' ? 'refresh' : 'canvas-2'
  const targetPath = target === 'default' ? '/api/projects/refresh/canvas' : '/api/projects/refresh/canvases/canvas-2'
  const view = await mount(propsFor(withShots, 0, []))
  try {
    if (target === 'secondary') await clickText(await canvasMenu(view.container), '画布 2')
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true }); await key(surface, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
  } finally { await view.destroy() }
  assertSavedScriptOnly(graphs.get(targetId)?.nodes)
  assert.deepEqual(graphs.get(targetId)?.edges, [])
  const beforeRemount = requests.length
  // mount intentionally clears storage to model a fresh session or another
  // device; the persisted server graph must be enough to retain the deletion.
  const reopened = await mount(propsFor(structuredClone(withShots), 1, []))
  try {
    if (target === 'secondary') await clickText(await canvasMenu(reopened.container), '画布 2')
    assertScriptOnly(reopened.container)
    assert.equal(reopened.container.querySelectorAll('.react-flow__edge-path').length, 0)
    assert.equal(requests.slice(beforeRemount).some(request => request.path === targetPath && request.method === 'PUT'), false,
      'reopening an intentionally empty canvas must not create a replacement graph')
    if (target === 'default') {
      await clickText(reopened.container, '导入分镜')
      assert.equal(nodeIds(reopened.container).length, 2, 'the explicit import action adds its shot beside the protected script')
      assert.match(reopened.container.textContent!, /保留的分镜/)
    }
  } finally { await reopened.destroy() }
})

test('select-all deletion is not reimported after switching canvases when persistent browser storage is unavailable', async t => {
  const { graphs } = mockMultipleCanvases(t, false, graph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []))
  const storagePrototype = Object.getPrototypeOf(dom.window.localStorage)
  const originalGet = storagePrototype.getItem, originalSet = storagePrototype.setItem
  t.mock.method(storagePrototype, 'getItem', function (this: Storage, name: string) {
    if (this === dom.window.localStorage) throw new dom.window.DOMException('Storage disabled', 'SecurityError')
    return originalGet.call(this, name)
  })
  t.mock.method(storagePrototype, 'setItem', function (this: Storage, name: string, value: string) {
    if (this === dom.window.localStorage) throw new dom.window.DOMException('Storage disabled', 'SecurityError')
    return originalSet.call(this, name, value)
  })
  try {
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true }); await key(surface, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
    await clickText(await canvasMenu(view.container), '画布 2')
    assertSavedScriptOnly(graphs.get('refresh')?.nodes)
    await clickText(await canvasMenu(view.container), '画布 1')
    assertScriptOnly(view.container)
  } finally { await view.destroy() }
})

test('a failed script import save cannot replay deleted nodes into another canvas', async t => {
  const { graphs, failures } = mockMultipleCanvases(t, false, graph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []))
  try {
    failures.remainingSaves = 1
    const requestKey = 'script-canvas-open:refresh'
    dom.window.sessionStorage.setItem(requestKey, JSON.stringify({ id: 'pending-import', project_id: detail.id, ratio: detail.ratio,
      result: { scene_ids: [], shots: withShots.shots, visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 1 } }))
    await act(() => dom.window.dispatchEvent(new dom.window.Event('script-canvas-open'))); await settle()
    assert.equal(nodeIds(view.container).length, 5, 'the explicit script request added its shot node')
    assert.equal(dom.window.sessionStorage.getItem(requestKey), null, 'the local import consumes its request even if remote persistence fails')
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true }); await key(surface, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
    await clickText(await canvasMenu(view.container), '画布 2')
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id), 'a discarded import must not be replayed into the other canvas')
    await clickText(await canvasMenu(view.container), '画布 1')
    assertScriptOnly(view.container)
    assertSavedScriptOnly(graphs.get('refresh')?.nodes)
    assert.deepEqual(graphs.get('refresh')?.edges, [])
  } finally { await view.destroy() }
})

test('an explicit script request waits for its target canvas instead of importing into the visible canvas', async t => {
  const { graphs } = mockMultipleCanvases(t, false, graph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []))
  try {
    await clickText(await canvasMenu(view.container), '画布 2')
    const requestKey = 'script-canvas-open:refresh'
    dom.window.sessionStorage.setItem(requestKey, JSON.stringify({ id: 'targeted-import', project_id: detail.id, canvas_id: 'refresh', ratio: detail.ratio,
      result: { scene_ids: [], shots: withShots.shots, visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 1 } }))
    await act(() => dom.window.dispatchEvent(new dom.window.Event('script-canvas-open'))); await settle()
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id), 'the wrong canvas remains untouched')
    assert.ok(dom.window.sessionStorage.getItem(requestKey), 'the request remains available to its target')
    await clickText(await canvasMenu(view.container), '画布 1')
    assert.equal(nodeIds(view.container).length, 5)
    assert.equal(dom.window.sessionStorage.getItem(requestKey), null)
    assert.equal(graphs.get('refresh')?.nodes.length, 5)
    assert.deepEqual(graphs.get('canvas-2')?.nodes, graph.nodes)
  } finally { await view.destroy() }
})

test('a new design handoff saves current edits and opens only its dedicated canvas while history remains browseable', async t => {
  const oldShot = { id: 'old-shot', project_id: detail.id, position: 0, title: '历史镜头名称', prompt: '旧方案站台', duration: 5, selected_asset_id: null,
    source_scene_id: 'scene', superseded_by: 'design-new' }
  const newShot = { ...oldShot, id: 'new-shot', title: '新方案镜头', prompt: '新的开镜', design_id: 'design-new', superseded_by: null }
  const oldGraph = { ...structuredClone(graph), nodes: [...structuredClone(graph.nodes), { ...node('old-shot-node', 'generation', 1500, 80, 440, 420), shot_id: oldShot.id, settings: { modality: 'image' as const } }] }
  const { graphs, requests, addCanvas } = mockMultipleCanvases(t, false, undefined, oldGraph)
  const base = { ...detail, shots: [newShot], historical_shots: [oldShot] } as ProjectDetail
  const view = await mount(propsFor(base, 0, []))
  try {
    await act(() => button(view.container, '打开左侧节点列表').click()); await settle()
    assert.match(view.container.querySelector('.pc-canvas-sidebar')!.textContent!, /历史镜头名称/, 'old canvas metadata comes from historical shots')
    await act(() => button(view.container, '添加文本').click()); await settle()
    const oldNodeIds = nodeIds(view.container)
    addCanvas('canvas-new', 'design-new')
    dom.window.sessionStorage.setItem('script-canvas-open:refresh', JSON.stringify({ id: 'design-import', project_id: detail.id, canvas_id: 'canvas-new', ratio: detail.ratio,
      result: { scene_ids: ['scene'], shots: [newShot], visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 1, design_id: 'design-new', target_canvas_id: 'canvas-new' } }))
    await act(() => dom.window.dispatchEvent(new dom.window.Event('script-canvas-open'))); await settle()
    assert.match(button(view.container, '切换画布').textContent!, /canvas-new/)
    assert.equal(graphs.get('refresh')!.nodes.length, oldGraph.nodes.length + 1, 'leaving flushes edits to the old canvas before switching')
    assert.ok(oldNodeIds.every(id => graphs.get('refresh')!.nodes.some(item => item.id === id)))
    assert.deepEqual(graphs.get('refresh')!.edges, oldGraph.edges, 'historical manual edges are preserved only in their own canvas')
    assert.deepEqual(graphs.get('canvas-new')!.nodes.filter(item => item.shot_id).map(item => item.shot_id), ['new-shot'])
    assert.equal(graphs.get('canvas-new')!.nodes.some(item => item.settings.visual_profile_id === profile.id), false)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:refresh'), null)
    assert.equal(requests.some(item => item.method === 'PUT' && item.path === '/api/projects/refresh/canvas'), true)
    await clickText(await canvasMenu(view.container), '画布 1')
    await act(() => button(view.container, '打开左侧节点列表').click()); await settle()
    assert.match(view.container.querySelector('.pc-canvas-sidebar')!.textContent!, /历史镜头名称/)
    assert.deepEqual(nodeIds(view.container), oldNodeIds)
  } finally { await view.destroy() }
})

test('a newer design request arriving during canvas metadata reload is resumed after the current operation', async t => {
  const { graphs, controls, addCanvas } = mockMultipleCanvases(t)
  const view = await mount(propsFor(detail, 0, []))
  const key = 'script-canvas-open:refresh'
  const request = (id: string) => ({ id: `request-${id}`, project_id: detail.id, canvas_id: `canvas-${id}`, ratio: detail.ratio,
    result: { scene_ids: [], shots: [{ id: `shot-${id}`, project_id: detail.id, position: 0, title: id, prompt: id, duration: 5, selected_asset_id: null, design_id: id }],
      visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 1, design_id: id, target_canvas_id: `canvas-${id}` } })
  try {
    addCanvas('canvas-first', 'first'); addCanvas('canvas-latest', 'latest')
    let release!: () => void
    controls.nextListGate = new Promise<void>(resolve => { release = resolve })
    dom.window.sessionStorage.setItem(key, JSON.stringify(request('first')))
    await act(() => dom.window.dispatchEvent(new dom.window.Event('script-canvas-open'))); await settle()
    dom.window.sessionStorage.setItem(key, JSON.stringify(request('latest')))
    await act(() => dom.window.dispatchEvent(new dom.window.Event('script-canvas-open')))
    await act(() => release()); await settle()
    assert.match(button(view.container, '切换画布').textContent!, /canvas-latest/)
    assert.equal(graphs.get('canvas-first')!.nodes.length, 0)
    assert.deepEqual(graphs.get('canvas-latest')!.nodes.filter(item => item.shot_id).map(item => item.shot_id), ['shot-latest'])
    assert.equal(dom.window.sessionStorage.getItem(key), null)
  } finally { await view.destroy() }
})

test('manual storyboard import only offers shots belonging to the current canvas design', async t => {
  const { graphs, addCanvas, controls } = mockMultipleCanvases(t)
  addCanvas('canvas-new', 'design-new')
  const shot = { project_id: detail.id, position: 0, prompt: '站台', duration: 5, selected_asset_id: null }
  const base = { ...detail, shots: [{ ...shot, id: 'new-shot', title: '当前方案镜头', design_id: 'design-new' }, { ...shot, id: 'foreign-shot', title: '其他方案镜头', design_id: 'design-other' }],
    historical_shots: [{ ...shot, id: 'legacy-shot', title: '旧镜头' }] } as ProjectDetail
  controls.projectDetail = base
  const view = await mount(propsFor(base, 0, []))
  try {
    await clickText(await canvasMenu(view.container), '新方案 canvas-new')
    await clickText(view.container, '导入分镜'); await settle()
    assert.match(view.container.textContent!, /当前方案镜头/)
    assert.doesNotMatch(view.container.textContent!, /其他方案镜头|旧镜头/)
    await clickText(await canvasMenu(view.container), '画布 1')
    assert.deepEqual(graphs.get('canvas-new')!.nodes.filter(item => item.shot_id).map(item => item.shot_id), ['new-shot'])
  } finally { await view.destroy() }
})

test('select-all deletion of a virtualized 161-node media canvas retains only its script after an immediate canvas round trip', async t => {
  const mediaGraph: CanvasGraph = { revision: 'large-media', nodes: Array.from({ length: 161 }, (_, index) => {
    const type = index % 4 === 0 ? 'image' : index % 4 === 3 ? 'text' : 'generation'
    return { ...node(`media-${index}`, type, 80 + index % 10 * 520, 80 + Math.floor(index / 10) * 440, 420, 340),
      title: `媒体节点 ${index}`, asset_id: type === 'image' ? 'board' : null, text: type === 'text' ? '保留提示词' : '',
      settings: type === 'generation' ? { modality: index % 4 === 1 ? 'image' as const : 'video' as const } : {} }
  }), edges: Array.from({ length: 112 }, (_, index) => ({ id: `media-edge-${index}`, source: `media-${index}`, target: `media-${index + 1}` })) }
  const { graphs, requests } = mockMultipleCanvases(t, false, graph, mediaGraph)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []), { width: 1200, height: 800 })
  try {
    assert.ok(nodeIds(view.container).length > 0 && nodeIds(view.container).length < 20, 'only visible media cards are mounted')
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true })
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 161 个节点/)
    await key(surface, 'Delete')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /移除 161 个节点/)
    await answerDialog('移除')
    assertScriptOnly(view.container)
    await clickText(await canvasMenu(view.container), '画布 2')
    assertSavedScriptOnly(graphs.get('refresh')?.nodes)
    assert.deepEqual(graphs.get('refresh')?.edges, [])
    await clickText(await canvasMenu(view.container), '画布 1')
    assertScriptOnly(view.container)
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    const saves = requests.filter(request => request.path === '/api/projects/refresh/canvas' && request.method === 'PUT')
    assert.ok(saves.length > 0)
    for (const save of saves) { assertSavedScriptOnly(save.body.nodes); assert.deepEqual(save.body.edges, []) }
  } finally { await view.destroy() }
})

test('new canvas starts with its project script and switches preserve independent content, selection, viewport and undo history', async t => {
  const { graphs, requests } = mockMultipleCanvases(t)
  const view = await mount(propsFor(detail, 0, []))
  try {
    await act(() => button(view.container, '添加文本').click()); await settle()
    const firstIds = nodeIds(view.container), selected = selectedIds(view.container)
    assert.equal(firstIds.length, 5); assert.equal(selected.length, 1)
    const firstGeometry = geometry(view.container)
    await canvasMenu(view.container)
    await act(() => button(document.body, '新增画布').click()); await settle()
    assert.match(button(view.container, '切换画布').textContent!, /画布 2/)
    assertScriptOnly(view.container)
    assert.equal(graphs.get('refresh')!.nodes.length, 5, 'pending edit saved before create')
    const put = requests.findIndex(item => item.method === 'PUT'), create = requests.findIndex(item => item.method === 'POST')
    assert.ok(put >= 0 && put < create)
    assert.equal(button(view.container, '撤销画布操作').disabled, true)
    await act(() => button(view.container, '添加文本').click()); await settle()
    const secondIds = nodeIds(view.container); assert.equal(secondIds.length, 2)
    const menu = await canvasMenu(view.container); await clickText(menu, '画布 1'); await settle()
    assert.deepEqual(nodeIds(view.container), firstIds)
    assert.deepEqual(selectedIds(view.container), selected)
    assert.equal(geometry(view.container).viewport, firstGeometry.viewport)
    assert.equal(button(view.container, '撤销画布操作').disabled, false)
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    const nextMenu = await canvasMenu(view.container); await clickText(nextMenu, '画布 2'); await settle()
    assert.deepEqual(nodeIds(view.container), secondIds)
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    assertScriptOnly(view.container)
    assert.equal(dom.window.localStorage.getItem('project-active-canvas:refresh'), 'canvas-2')
    assert.ok(requests.some(item => item.path === '/api/projects/refresh/canvases/canvas-2' && item.method === 'PUT'))
  } finally { await view.destroy() }
})

test('failed save keeps active canvas and recoverable local draft instead of creating or switching a canvas', async t => {
  const { requests } = mockMultipleCanvases(t, true)
  const view = await mount(propsFor(detail, 0, []))
  try {
    await act(() => button(view.container, '添加文本').click()); await settle()
    const ids = nodeIds(view.container)
    await canvasMenu(view.container)
    await act(() => button(document.body, '新增画布').click()); await settle()
    assert.match(button(view.container, '切换画布').textContent!, /画布 1/)
    assert.deepEqual(nodeIds(view.container), ids)
    assert.ok(dom.window.localStorage.getItem('project-canvas-draft:refresh'))
    assert.equal(requests.some(item => item.method === 'POST'), false)
    assert.match(view.container.textContent!, /测试保存失败/)
  } finally { await view.destroy() }
})

function manyNodeCanvas(t: TestContext, count = 500) {
  let current: CanvasGraph = { revision: 'many-nodes', nodes: Array.from({ length: count }, (_, index) => ({
    ...node(`many-${index}`, 'text', 40 + index % 10 * 520, 80 + Math.floor(index / 10) * 440, 420, 340),
    title: `文本 ${index}`, text: '保留提示词与换行\n'.repeat(10), settings: { text_mode: 'write' },
  })), edges: [{ id: 'prompt-link', source: 'many-0', target: 'many-499' }] }
  const saved: CanvasGraph[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: count, viewport: null }])
    assert.equal(String(url), '/api/projects/refresh/canvas')
    if (init?.method === 'PUT') {
      current = { ...JSON.parse(String(init.body)), revision: `many-saved-${saved.length}` }; saved.push(current)
    }
    return Response.json(current)
  })
  return { saved }
}

const nodeRenderCounts = () => ({ ...(globalThis as typeof globalThis & { __canvasNodeRenders?: Record<string, number> }).__canvasNodeRenders })

test('500-node canvas mounts only visible cards while select/delete/undo retain all offscreen data', async t => {
  const { saved } = manyNodeCanvas(t)
  const view = await mount(propsFor(detail, 0, []), { width: 1200, height: 800 })
  try {
    assert.ok(nodeIds(view.container).length > 0 && nodeIds(view.container).length < 20)
    assert.equal(view.container.querySelector('[data-id="many-499"]'), null, 'offscreen card is not mounted')
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'a', { ctrlKey: true })
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 500 个节点/)
    assert.equal(view.container.querySelectorAll('.pc-rich-text-editor').length, 0, 'multi-select creates no rich editors')
    await key(surface, 'Delete'); await answerDialog('移除')
    assertScriptOnly(view.container)
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    await key(surface, 'a', { metaKey: true })
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 500 个节点/)
  } finally { await view.destroy() }
  assert.equal(saved.at(-1)?.nodes.length, 501, 'saved snapshot includes every offscreen node and the permanent script')
  assert.deepEqual(saved.at(-1)?.edges, [{ id: 'prompt-link', source: 'many-0', target: 'many-499' }])
})

test('editing one visible text card leaves unrelated cards unrendered and mounts only its editor', async t => {
  manyNodeCanvas(t)
  const view = await mount(propsFor(detail, 0, []), { width: 1200, height: 800 })
  try {
    await act(() => (view.container.querySelector('[data-id="many-0"]') as HTMLElement).click()); await settle()
    assert.equal(view.container.querySelectorAll('.pc-rich-text-editor').length, 1)
    const element = view.container.querySelector<HTMLElement>('[data-id="many-0"] [contenteditable="true"]')!
    const editor = (element as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    assert.ok(editor)
    const before = nodeRenderCounts()
    await act(() => { editor.commands.setTextSelection(1); editor.commands.insertContent('新提示词') }); await settle()
    const after = nodeRenderCounts()
    assert.ok(after['many-0'] > before['many-0'])
    for (const id of nodeIds(view.container).filter(id => id !== 'many-0')) assert.equal(after[id], before[id], `unrelated ${id} did not rerender`)
    assert.match(element.textContent!, /新提示词/)
    const otherVisibleId = nodeIds(view.container).find(id => id !== 'many-0' && id?.startsWith('many-'))
    assert.ok(otherVisibleId, 'another visible text card can join the selection')
    await multiSelect(view.container, [otherVisibleId])
    assert.equal(view.container.querySelectorAll('.pc-rich-text-editor').length, 0)
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 2 个节点/)
  } finally { await view.destroy() }
})

test('zoomed-out large canvas retains actual text contents and creates no idle editors', async t => {
  manyNodeCanvas(t)
  const view = await mount(propsFor(detail, 0, []), { width: 1200, height: 800 }, 0.3)
  try {
    assert.ok(nodeIds(view.container).length > 8)
    const contents = view.container.querySelectorAll('.pc-node .pc-node-content')
    assert.equal(contents.length, nodeIds(view.container).length - view.container.querySelectorAll('.pc-node-project_script_ref').length, 'any visible script preview has its own content container')
    for (const content of contents) assert.match(content.textContent!, /保留提示词与换行/)
    assert.equal(view.container.querySelectorAll('.pc-rich-text-editor').length, 0)
    await key(view.container.querySelector('.pc-flow')!, 'a', { ctrlKey: true })
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 500 个节点/)
    assert.equal(view.container.querySelectorAll('.pc-node-content').length, contents.length)
  } finally { await view.destroy() }
})

test('single-node connection motion cancels on all-select, hidden links, background and unmount', async t => {
  manyNodeCanvas(t)
  const active = new Set<unknown>()
  const previousAnimate = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'animate')
  Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', { configurable: true, value: (_frames: Keyframe[], options: KeyframeAnimationOptions) => {
    assert.equal(options.iterations, Infinity)
    const animation = { currentTime: 0, cancel: () => active.delete(animation) }
    active.add(animation); return animation
  } })
  t.after(() => {
    if (previousAnimate) Object.defineProperty(dom.window.HTMLElement.prototype, 'animate', previousAnimate)
    else delete (dom.window.HTMLElement.prototype as Partial<HTMLElement>).animate
  })
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  const view = await mount(propsFor(detail, 0, []), { width: 1200, height: 800 })
  const select = async () => { await act(() => (view.container.querySelector('[data-id="many-0"]') as HTMLElement).click()); await settle() }
  try {
    assert.equal(active.size, 0)
    await select(); assert.equal(active.size, 1)
    assert.equal(view.container.querySelector('[data-edge-id="prompt-link"]')?.className, 'pc-edge-motion-dot')
    await key(view.container.querySelector('.pc-flow')!, 'a', { ctrlKey: true }); assert.equal(active.size, 0)
    await select(); assert.equal(active.size, 1)
    await act(() => button(view.container, '隐藏连线').click()); await settle(); assert.equal(active.size, 0)
    await act(() => button(view.container, '显示连线').click()); await settle(); assert.equal(active.size, 1)
    await act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) }); assert.equal(active.size, 0)
    await act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) }); assert.equal(active.size, 1)
  } finally {
    await view.destroy(); assert.equal(active.size, 0)
    delete (document as Partial<Document>).hidden
  }
})
