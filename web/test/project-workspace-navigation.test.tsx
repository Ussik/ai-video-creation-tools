import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Editor } from '@tiptap/core'
import type { ProjectDetail } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'

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
// d3-timer (React Flow viewport transitions) schedules its `wake` on requestAnimationFrame and releases its
// poll interval only when that callback runs. Per-test frames.clear() would drop it and keep the process alive,
// so d3's own scheduler runs on a real timer, as d3-timer does without requestAnimationFrame.
const requestFrame = (callback: FrameRequestCallback) => {
  if (callback.name === 'wake') { setTimeout(() => callback(performance.now()), 17); return 0 }
  frames.set(++frameId, callback); return frameId
}
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
const { default: App } = await import('../src/app/App')
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
    await new Promise(resolve => setTimeout(resolve, 20))
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}

async function click(element: HTMLElement) { assert.ok(element); await act(async () => { element.click(); await Promise.resolve() }); await settle() }
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
async function tab(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.project-workspace-tabs [role="tab"]')].find(item => item.textContent === label)
  assert.ok(found, label); await click(found)
}
async function tool(label: string) {
  await click(document.querySelector<HTMLButtonElement>('[aria-label="项目工具"]')!)
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)
  assert.ok(found, label); await click(found)
}
async function mountWorkspace(t: TestContext, withSource = false) {
  const project = structuredClone(detail)
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = []
  const source = { project_id: project.id, filename: '夜班原稿.txt', content: '第一集：林晚在车站等候列车。', updated_at: 'source-1',
    analysis: { id: 'analysis-1', source_version: 'source-v1', model_id: 'text-model', status: 'failed', completed_chunks: 0, total_chunks: 1,
      sections: [], error: null, updated_at: 'source-1', resume: { available: true, blocked: true, action: 'reconcile_request', message: '上次请求的最终结果待确认。' } } }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ path, method, body })
    if (path.endsWith('/conversations')) return Response.json(method === 'GET' ? { conversations: [] } : { id: 'snapshot' })
    if (method === 'PATCH' && path === '/api/projects/refresh') { Object.assign(project, body); return Response.json(project) }
    if (method === 'PUT' && path === '/api/projects/refresh/script') {
      Object.assign(project.script, body); if (typeof body?.brief === 'string') project.brief = body.brief
      return Response.json(project.script)
    }
    assert.equal(method, 'GET', `navigation cannot create generation: ${method} ${path}`)
    if (path === '/api/projects') return Response.json([project])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path === '/api/projects/refresh') return Response.json(project)
    if (path.endsWith('/canvases')) return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path.endsWith('/canvas')) return Response.json(graph)
    if (path.endsWith('/continuity')) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: path })
    if (path.endsWith('/script/source')) return Response.json(withSource ? source : null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [] })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => { root.render(<MantineProvider env="test"><App /></MantineProvider>); await Promise.resolve() }); await settle()
  await click(container.querySelector<HTMLButtonElement>('.project-card-main')!)
  return { container, requests, async destroy() { await act(() => root.unmount()); container.remove(); frames.clear() } }
}

test('director stays hidden on the script page and dirty workspace navigation honors cancel then discard', async t => {
  const view = await mountWorkspace(t)
  try {
    assert.equal(view.container.querySelector('.project-workspace-tabs [aria-selected="true"]')?.textContent, '剧本')
    assert.ok(view.container.querySelector('[aria-label="剧本创作"]'))
    assert.equal(view.container.querySelector('[aria-label="剧本导演"]:not([hidden])'), null)
    const outline = view.container.querySelector<HTMLElement & { editor: Editor }>('[data-script-section="outline"] [contenteditable="true"]')!
    assert.ok(outline)
    await act(() => { outline.editor.commands.setContent('<p>尚未保存的人工改稿。</p>') }); await settle()
    await tab('画布'); assert.match(document.body.textContent!, /离开剧本编辑器？/)
    await click(button('继续编辑'))
    assert.ok(view.container.querySelector('[aria-label="剧本创作"]'))
    assert.match(outline.textContent!, /尚未保存的人工改稿/)
    await tab('画布'); await click(button('放弃修改并离开'))
    assert.ok(!view.container.querySelector('[aria-label="剧本创作"]'), 'editor exited')
    assert.equal(view.container.querySelector('.project-workspace-tabs [aria-selected="true"]')?.textContent, '画布')
    assert.equal(view.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/conversations')).length, 0)
  } finally { await view.destroy() }
})

test('settings page saves the original PATCH and PUT contracts, returns to script and clears old modal state', async t => {
  const view = await mountWorkspace(t)
  try {
    await click(view.container.querySelector<HTMLButtonElement>('button[aria-label="创作设定"]')!)
    const settings = view.container.querySelector<HTMLElement>('.creative-brief-workspace')!
    assert.ok(settings); assert.ok(!document.querySelector('.mantine-Modal-content'), 'settings uses a page')
    await click(button('打开剧本设定器', settings))
    await click(document.querySelectorAll<HTMLButtonElement>('.atelier-preset-list button')[1])
    await click(button('取消', document.querySelector('.script-director-settings-modal')!))
    assert.match(settings.querySelector('.creative-brief-art')!.textContent!, /玄幻修仙/)
    await click(button('打开剧本设定器', settings))
    await click(document.querySelectorAll<HTMLButtonElement>('.atelier-preset-list button')[1])
    await click(button('确认设定', document.querySelector('.script-director-settings-modal')!))
    assert.match(settings.querySelector('.creative-brief-art')!.textContent!, /都市现实/)
    assert.equal(view.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/conversations')).length, 0)
    const name = [...settings.querySelectorAll<HTMLInputElement>('input')].find(input => document.querySelector(`label[for="${input.id}"]`)?.textContent === '项目名称')!
    assert.ok(name)
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(name, '夜班列车改名')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    }); await settle()
    await click(button('保存并继续创作', settings))
    assert.ok(!view.container.querySelector('.creative-brief-workspace'), 'settings page exited')
    assert.ok(view.container.querySelector('[aria-label="剧本创作"]'), 'saving releases its guard before navigation')
    const writes = view.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/conversations'))
    assert.deepEqual(writes.map(r => [r.method, r.path]), [['PATCH', '/api/projects/refresh'], ['PUT', '/api/projects/refresh/script']])
    assert.equal(writes[0].body?.name, '夜班列车改名')
    assert.equal((writes[1].body?.generation_options as { genre?: string }).genre, '都市现实')
    assert.equal(writes[1].body?.outline, detail.script.outline)
    assert.equal(writes[1].body?.characters, detail.script.characters)
    await tab('画布'); await tab('剧本')
    assert.ok(!document.querySelector('.mantine-Modal-content'), 'no legacy dialog')
    assert.ok(!document.querySelector('.script-director-settings-modal'), 'no legacy settings modal')
  } finally { await view.destroy() }
})

test('source page owns exactly one analysis and recovery subtree beside the retained conversation', async t => {
  const view = await mountWorkspace(t, true)
  try {
    await tab('剧本'); await tool('原稿与分析')
    assert.ok(view.container.querySelector('[aria-label="原稿与分析"]'))
    assert.equal(view.container.querySelectorAll('[data-source-analysis="analysis-1"]').length, 1, 'hidden chat cannot duplicate recovery ownership')
    assert.equal(view.container.querySelectorAll('[aria-label="剧本分析状态"]').length, 1)
    assert.match(view.container.querySelector('.source-workspace-reading')!.textContent!, /第一集：林晚在车站等候列车。/)
    assert.equal(view.requests.filter(r => /request-recovery/.test(r.path)).length, 0)
    assert.equal(view.requests.filter(r => r.method !== 'GET' && !r.path.endsWith('/conversations')).length, 0)
    await click(button('返回剧本'))
    assert.ok(view.container.querySelector('[aria-label="剧本创作"]'))
    assert.equal(view.container.querySelectorAll('[data-source-analysis="analysis-1"]').length, 1)
  } finally { await view.destroy() }
})
