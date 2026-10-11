import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail } from '../src/api'
import type { CanvasGraph, CanvasNode } from '../src/ProjectCanvas'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
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
const { default: App } = await import('../src/App')
after(() => dom.window.close())

const timestamp = '2026-10-09T00:00:00Z'
const detail: ProjectDetail = { id: 'refresh', name: '夜班列车', brief: '林晚在车站等候列车', ratio: '9:16', music_asset_id: null,
  created_at: timestamp, updated_at: timestamp, production_range: { start_shot_id: null, end_shot_id: null },
  script: { outline: '# 故事大纲\n\n林晚在车站等候列车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
  shots: [], timeline_clips: [], asset_reviews: [], assets: [], jobs: [], asset_tasks: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
}
function node(id: string, type: CanvasNode['type'], x: number, y: number, width: number, height: number): CanvasNode {
  return { id, type, x, y, width, height, title: '', text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }
}
const graph: CanvasGraph = { revision: 'revision', nodes: [
  { ...node('script', 'project_script_ref', 60, 80, 640, 350), title: detail.name },
  { ...node('text', 'text', 60, 550, 420, 340), title: '镜头提示词', text: '林晚望向站台。', settings: { text_mode: 'write' } },
  { ...node('generation', 'generation', 900, 550, 440, 420), title: '图片生成', settings: { modality: 'image' } },
], edges: [{ id: 'prompt', source: 'text', target: 'generation' }] }

async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}

test('real App polling retains one canvas beside the hidden storyboard planner', async t => {
  const requests: Array<{ path: string; method: string }> = [], errors: string[] = []
  let detailReads = 0, continuityReads = 0
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    assert.equal(method, 'GET', 'background refresh cannot write the canvas or project')
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === '/api/projects/refresh/canvas') return Response.json(graph)
    if (path === '/api/projects/refresh') {
      // Real changed fields force App reconciliation even with shared snapshots.
      const next = structuredClone(detail); next.updated_at = `2026-10-09T00:00:${String(++detailReads).padStart(2, '0')}Z`
      return Response.json(next)
    }
    if (path === '/api/projects/refresh/continuity') return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: `continuity-${++continuityReads}` })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  // Invoke the actual sequential poll callback without waiting four seconds.
  const polls = new Map<number, () => Promise<void>>()
  let pollId = 100_000
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window), nativeClearTimeout = dom.window.clearTimeout.bind(dom.window)
  t.mock.method(dom.window, 'setTimeout', (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 4000) return nativeSetTimeout(handler, delay, ...args)
    assert.equal(typeof handler, 'function'); const id = ++pollId
    polls.set(id, () => (handler as (...args: unknown[]) => Promise<void>)(...args)); return id
  })
  t.mock.method(dom.window, 'clearTimeout', (id?: number) => { if (!polls.delete(id!)) nativeClearTimeout(id) })

  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<MantineProvider env="test"><App /></MantineProvider>) })
    await settle()
    const project = container.querySelector<HTMLButtonElement>('.project-card-main')
    assert.ok(project, 'project loads through the real App catalog')
    await act(async () => { project.click() }); await settle()
    assert.equal(container.querySelectorAll('.project-canvas').length, 1, 'real App mounts one canvas per project')
    assert.equal(container.querySelectorAll('.pc-flow').length, 1)
    assert.equal(container.querySelectorAll('.react-flow').length, 1)
    const canvas = container.querySelector('.project-canvas'), flow = container.querySelector('.react-flow')
    const script = container.querySelector<HTMLElement>('[data-id="script"]')!
    assert.ok(script, 'the canvas has loaded its graph')
    await act(() => script.click()); await settle()
    const viewportStyle = container.querySelector('.react-flow__viewport')!.getAttribute('style')
    const nodeStyles = [...container.querySelectorAll('.react-flow__node')].map(element => element.getAttribute('style'))
    const initialDetailReads = detailReads, initialContinuityReads = continuityReads
    assert.ok(script.classList.contains('selected'))
    for (let tick = 1; tick <= 4; tick++) {
      assert.equal(polls.size, 1, 'one sequential project poll is scheduled')
      const [id, poll] = [...polls.entries()][0]; polls.delete(id)
      await act(async () => { await poll() }); await settle()
      assert.equal(detailReads, initialDetailReads + tick, 'each tick refreshes the actual project detail')
      assert.equal(continuityReads, initialContinuityReads + tick, 'each tick also updates parent continuity state')
      assert.equal(container.querySelectorAll('.project-canvas').length, 1, `poll ${tick} cannot duplicate a canvas`)
      assert.equal(container.querySelectorAll('.pc-flow').length, 1, `poll ${tick} retains one flow host`)
      assert.equal(container.querySelector('.project-canvas'), canvas, `poll ${tick} preserves the canvas mount`)
      assert.equal(container.querySelector('.react-flow'), flow, `poll ${tick} preserves React Flow`)
      assert.equal(container.querySelector('[data-id="script"]'), script, `poll ${tick} preserves node DOM`)
      assert.ok(script.classList.contains('selected'), `poll ${tick} preserves selection`)
      assert.equal(container.querySelector('.react-flow__viewport')!.getAttribute('style'), viewportStyle)
      assert.deepEqual([...container.querySelectorAll('.react-flow__node')].map(element => element.getAttribute('style')), nodeStyles)
      assert.equal(container.querySelectorAll('.react-flow__edge-path').length, 1)
    }
    assert.deepEqual(requests.filter(request => request.path.endsWith('/canvas')), [{ path: '/api/projects/refresh/canvas', method: 'GET' }])
    assert.deepEqual(errors.filter(message => /same key|unique.*key|duplicate.*key/i.test(message)), [], 'sibling workspaces must have distinct React keys')
    assert.deepEqual(errors, [], 'App polling does not emit React rendering errors')
  } finally {
    await act(() => root.unmount()); container.remove(); frames.clear()
  }
})
