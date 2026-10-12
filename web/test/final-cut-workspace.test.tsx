import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { fixture, projectId, canvasNode } from './fixtures/final-cut'

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
const { default: App } = await import('../src/app/App')
after(() => dom.window.close())

async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 12; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}
function button(scope: ParentNode, text: string) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === text)
  assert.ok(result, `button ${text} exists`); return result
}
async function click(element: HTMLElement) { await act(() => element.click()); await settle() }
async function input(scope: ParentNode, label: string, value: string) {
  const fieldLabel = [...scope.querySelectorAll('label')].find(element => element.textContent?.trim() === label)
  assert.ok(fieldLabel, label)
  const field = document.getElementById(fieldLabel.htmlFor) as HTMLInputElement
  assert.ok(field)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function mount(t: import('node:test').TestContext, data = fixture()) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  t.mock.method(globalThis, 'fetch', data.fetchFixture)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
  await click(container.querySelector<HTMLButtonElement>('.project-card-main')!)
  const openStudio = async () => {
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="切换创作页面"]')!)
    await click(button(document.body, '成片工作台'))
    assert.ok(container.querySelector('.final-cut-workspace'))
  }
  await openStudio()
  return { container, data, openStudio, destroy: async () => { await act(() => root.unmount()); container.remove(); frames.clear() } }
}

test('final-cut workspace preserves trim, audio, selection and export contracts without generation inputs', async t => {
  const view = await mount(t)
  try {
    const inspector = view.container.querySelector('.final-cut-inspector')!
    assert.ok(inspector.querySelector('input'))
    assert.equal(view.container.querySelector('.final-cut-workspace textarea'), null, 'shot prompt/state editors are absent')
    assert.equal(view.container.querySelector('[aria-label="生成类型"]'), null)
    assert.ok(!view.container.querySelector('.final-cut-workspace')!.textContent!.includes('开始生成'))
    assert.equal(view.container.querySelectorAll('.candidate').length, 2, 'text candidates cannot enter a cut')
    assert.ok(!button(view.container, '连续预览').disabled)
    await input(inspector, '素材入点', '1'); await input(inspector, '素材出点', '4.5')
    await click(button(inspector, '保存取段'))
    assert.deepEqual(view.data.requests.filter(request => request.path === '/api/timeline-clips/c1').at(-1)?.body, { in_ms: 1000, out_ms: 4500 })
    await input(inspector, '素材出点', '0.5')
    assert.ok(button(inspector, '保存取段').disabled, 'invalid reverse interval is blocked')
    await input(inspector, '素材出点', '4.5')
    await input(inspector, '原声音量', '70'); await input(inspector, '首尾淡变', '200')
    await click(button(inspector, '保存原声'))
    assert.deepEqual(view.data.requests.filter(request => request.path === '/api/timeline-clips/c1').at(-1)?.body,
      { source_audio_gain: 0.7, source_audio_fade_ms: 200 })
    await click(button(view.container.querySelector('.candidate-grid')!, '选为成片'))
    assert.deepEqual(view.data.requests.find(request => request.path === '/api/shots/s1/selection')?.body, { asset_id: 'alternate' })
    assert.equal(view.container.querySelector('.source-audio-editor'), null, 'still images have no original audio controls')
    assert.ok(!button(view.container, '连续预览').disabled)
    await click(button(view.container.querySelector('.timeline')!, '导出视频'))
    assert.equal(view.data.requests.filter(request => request.path.endsWith('/export') && request.method === 'POST').length, 1)
    assert.ok(view.data.requests.every(request => !request.path.includes('/generations') && !request.path.includes('/generation')))
  } finally { await view.destroy() }
})

test('return to canvas selects an existing shot node on another canvas without duplicating it', async t => {
  const view = await mount(t)
  try {
    await click(button(view.container, '在画布调整此镜头'))
    assert.equal(dom.window.localStorage.getItem(`project-active-canvas:${projectId}`), 'second')
    const selected = view.container.querySelector('.react-flow__node[data-id="video-node"]')
    assert.ok(selected?.classList.contains('selected'), 'actual matching node is selected')
    assert.equal(view.container.querySelectorAll('.react-flow__node').length, 2)
    assert.match(view.container.querySelector('.react-flow__viewport')!.getAttribute('style')!, /scale\(1\)/)
    assert.equal(view.data.requests.filter(request => request.method === 'PUT' || request.method === 'POST').length, 0)
    assert.equal(dom.window.sessionStorage.getItem(`shot-canvas-open:${projectId}`), null)
  } finally { await view.destroy() }
})

test('return to canvas honors a conflicting local draft instead of importing a second shot node', async t => {
  const view = await mount(t)
  try {
    const draft = structuredClone(view.data.graphs.second)
    draft.nodes = [canvasNode('draft-video', 's1')]
    dom.window.localStorage.setItem(`project-canvas-draft:${projectId}:second`, JSON.stringify({
      base: { ...view.data.graphs.second, revision: 'older-rev' }, graph: draft,
    }))
    await click(button(view.container, '在画布调整此镜头'))
    assert.ok(view.container.querySelector('.react-flow__node[data-id="draft-video"]')?.classList.contains('selected'))
    assert.equal(view.container.querySelectorAll('.react-flow__node').length, 1)
    assert.equal(view.data.requests.filter(request => request.method === 'PUT' || request.method === 'POST').length, 0)
    assert.ok(dom.window.localStorage.getItem(`project-canvas-draft:${projectId}:second`), 'draft is preserved')
  } finally { await view.destroy() }
})

test('return to an empty canvas imports only the missing current shot once', async t => {
  const view = await mount(t)
  try {
    view.data.graphs[projectId].nodes = []; view.data.graphs.second.nodes = []
    await click(button(view.container, '在画布调整此镜头'))
    const saved = JSON.parse(dom.window.localStorage.getItem(`project-canvas-draft:${projectId}`)!)
    assert.ok(saved.graph.nodes.length > 0)
    assert.ok(saved.graph.nodes.every((node: { shot_id: string }) => node.shot_id === 's1'), 'unrelated shot is not auto-imported')
    assert.equal(saved.graph.nodes.filter((node: { type: string }) => node.type === 'generation').length, 1)
    assert.equal(view.container.querySelectorAll('.react-flow__node.selected').length, 1)
    assert.ok(view.data.requests.every(request => !request.path.includes('/generations')))
    await view.openStudio(); await click(button(view.container, '在画布调整此镜头'))
    assert.equal(view.container.querySelectorAll('.react-flow__node').length, saved.graph.nodes.length, 'second navigation reuses imported nodes')
  } finally { await view.destroy() }
})

test('empty workbench guides users back to canvas and disables preview/export', async t => {
  const data = fixture(); data.detail.shots = []; data.detail.assets = []; data.detail.timeline_clips = []
  const view = await mount(t, data)
  try {
    assert.ok(view.container.textContent?.includes('还没有入片镜头'))
    assert.ok(button(view.container, '连续预览').disabled)
    assert.ok(button(view.container.querySelector('.timeline')!, '导出视频').disabled)
    await click(button(view.container, '前往画布制作'))
    assert.ok(view.container.querySelector('.project-canvas'))
    assert.equal(view.data.requests.filter(request => request.method !== 'GET').length, 0)
  } finally { await view.destroy() }
})
