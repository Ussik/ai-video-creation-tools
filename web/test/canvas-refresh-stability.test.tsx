import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail, VisualProfile } from '../src/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/ProjectCanvas'

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
const { default: ProjectCanvas } = await import('../src/ProjectCanvas')
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
async function mount(props: ProjectCanvasProps, viewport?: { width: number; height: number }, zoom = 0.8) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom }))
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
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove(); frames.clear() } }
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
function mockCanvas(t: TestContext) {
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    assert.equal(path, '/api/projects/refresh/canvas')
    assert.equal(method, 'GET', 'unchanged canvas must not autosave')
    return Response.json(graph)
  })
  return requests
}

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
    assert.equal(video.controls, true, 'selected video retains native playback controls')
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

test('Shift box selection keeps its complete batch when the selection overlay receives a right click', async t => {
  mockCanvas(t)
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
    assert.deepEqual(selectedIds(view.container), ['script', 'profile'])
    const overlay = view.container.querySelector('.react-flow__nodesselection-rect')!
    assert.ok(overlay, 'actual React Flow box-selection overlay is present')
    await act(() => overlay.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 2 })))
    await settle()
    await rightClick(overlay)
    assert.deepEqual(selectedIds(view.container), ['script', 'profile'])
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
      assert.deepEqual(selectedIds(view.container), graph.nodes.map(node => node.id))
      assert.match(view.container.querySelector('[aria-label="多选节点操作"]')!.textContent!, /已选 4 个节点/)
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
    assert.deepEqual(selectedIds(view.container), graph.nodes.map(node => node.id))
    await answerDialog('取消')
    await key(surface, 'Escape')
    assert.deepEqual(selectedIds(view.container), [])
    assert.equal(view.container.querySelector('.pc-selection-toolbar'), null)
    await key(surface, 'Delete')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(requests.length, 1, 'cancelled removal never saves')
  } finally { await view.destroy() }
})

test('clear-canvas menu confirms once, preserves project records, stays empty after refresh and supports keyboard undo/redo', async t => {
  const { saved } = mockEditableCanvas(t)
  const withShots = { ...detail, shots: [{ id: 'kept-shot', project_id: detail.id, position: 0, title: '保留的分镜', prompt: '站台', duration: 5, selected_asset_id: null }] } as ProjectDetail
  const view = await mount(propsFor(withShots, 0, []))
  try {
    await rightClick(view.container.querySelector('.react-flow__pane')!)
    await clickText(view.container.querySelector('.pc-context-menu')!, '清空画布')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /清空画布（4 个节点）/)
    await answerDialog('取消')
    assert.equal(nodeIds(view.container).length, 4)
    await clickText(view.container.querySelector('.pc-context-menu')!, '清空画布')
    await answerDialog('清空画布')
    assert.deepEqual(nodeIds(view.container), [], 'clearing does not reimport existing shots')
    assert.equal(view.container.querySelectorAll('.react-flow__edge-path').length, 0)
    assert.equal(dom.window.localStorage.getItem('project-canvas-imported:refresh'), '1')
    await view.render(propsFor(structuredClone(withShots), 1, []))
    assert.deepEqual(nodeIds(view.container), [])
    const surface = view.container.querySelector('.pc-flow')!
    await key(surface, 'z', { ctrlKey: true })
    assert.deepEqual(nodeIds(view.container), graph.nodes.map(node => node.id))
    await key(surface, 'z', { ctrlKey: true, shiftKey: true })
    assert.deepEqual(nodeIds(view.container), [])
    await act(() => button(view.container, '画布操作菜单').click()); await settle()
    const menu = document.querySelector('.pc-sidebar-dropdown')!
    const clear = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '清空画布')!
    assert.ok(clear)
    assert.equal(clear.disabled, true, 'empty canvas cannot request another clear')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 750)) }); await settle()
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].nodes, [])
    assert.deepEqual(saved[0].edges, [])
    assert.equal(withShots.shots[0].id, 'kept-shot')
    assert.equal(withShots.assets.length, detail.assets.length)
    assert.equal(withShots.jobs.length, detail.jobs.length)
  } finally { await view.destroy() }
})

function mockMultipleCanvases(t: TestContext, rejectSave = false) {
  const graphs = new Map<string, CanvasGraph>([['refresh', structuredClone(graph)]])
  let metadata = [{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null as { x: number; y: number; zoom: number } | null }]
  const requests: Array<{ path: string; method: string; body?: any }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    if (path === '/api/projects/refresh/canvases') {
      if (method === 'POST') {
        const created = { id: `canvas-${metadata.length + 1}`, project_id: 'refresh', name: `画布 ${metadata.length + 1}`, is_default: false, node_count: 0, viewport: null }
        metadata.push(created); graphs.set(created.id, { revision: 'empty-revision', nodes: [], edges: [] })
        // Explicit camera avoids React Flow's animated first-node centering in this manual-RAF harness.
        dom.window.localStorage.setItem(`project-canvas-viewport:refresh:${created.id}`, JSON.stringify({ x: -50, y: 25, zoom: 0.6 }))
        return Response.json(created)
      }
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
      if (rejectSave) return Response.json({ detail: '测试保存失败' }, { status: 500 })
      assert.equal(body.revision, current.revision)
      const updated = { ...body, revision: `saved-${requests.length}` }; graphs.set(id, updated)
      return Response.json(updated)
    }
    return Response.json(current)
  })
  return { graphs, requests }
}
async function canvasMenu(container: HTMLElement) {
  await act(() => button(container, '切换画布').click()); await settle()
  const menu = document.querySelector<HTMLElement>('[role="menu"]')
  assert.ok(menu); return menu
}

test('new canvas starts empty and switches save first, unmount other nodes, restore selection, viewport and independent undo history', async t => {
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
    assert.deepEqual(nodeIds(view.container), [], 'inactive canvas nodes are unmounted')
    assert.equal(graphs.get('refresh')!.nodes.length, 5, 'pending edit saved before create')
    const put = requests.findIndex(item => item.method === 'PUT'), create = requests.findIndex(item => item.method === 'POST')
    assert.ok(put >= 0 && put < create)
    assert.equal(button(view.container, '撤销画布操作').disabled, true)
    await act(() => button(view.container, '添加文本').click()); await settle()
    const secondIds = nodeIds(view.container); assert.equal(secondIds.length, 1)
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
    assert.deepEqual(nodeIds(view.container), [])
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
    assert.equal(nodeIds(view.container).length, 0)
    await act(() => button(view.container, '撤销画布操作').click()); await settle()
    await key(surface, 'a', { metaKey: true })
    assert.match(view.container.querySelector('.pc-selection-toolbar')!.textContent!, /已选 500 个节点/)
  } finally { await view.destroy() }
  assert.equal(saved.at(-1)?.nodes.length, 500, 'saved snapshot still includes every offscreen node')
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
    const otherVisibleId = nodeIds(view.container).find(id => id !== 'many-0')
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
    assert.equal(contents.length, nodeIds(view.container).length)
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
