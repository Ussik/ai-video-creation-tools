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
  return {
    width: Number.parseFloat(node?.style.width || sizedNode?.style.width || '') || 1200,
    height: Number.parseFloat(node?.style.height || sizedNode?.style.height || '') || 800,
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
async function mount(props: ProjectCanvasProps) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
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
    assert.equal(String(url), '/api/projects/refresh/canvas')
    return Response.json(init?.method === 'PUT' ? { ...JSON.parse(String(init.body)), revision: 'saved-video' } : videoGraph)
  })
  const view = await mount(propsFor(videoDetail, 0, []))
  try {
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
