import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'WheelEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientWidth: { configurable: true, get() { return this.classList.contains('pc-image-preview-viewport') ? 1000 : 0 } },
  clientHeight: { configurable: true, get() { return this.classList.contains('pc-image-preview-viewport') ? 600 : 0 } },
  setPointerCapture: { value() {} }, hasPointerCapture: { value() { return false } },
})
const { createRoot } = await import('react-dom/client')
const { default: CanvasMediaPreview } = await import('../src/features/canvas/CanvasMediaPreview')
const { default: ShotCandidateManager } = await import('../src/features/canvas/ShotCandidateManager')
after(() => dom.window.close())
const image = { id: 'image', kind: 'image', url: '/api/assets/image/file', filename: '原图.png' } as Asset

async function mount(asset = image) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let closes = 0
  const render = async (next = asset) => act(() => root.render(<MantineProvider env="test"><CanvasMediaPreview asset={next} title="画布参考图" onClose={() => closes++} /></MantineProvider>))
  await render()
  const load = async () => {
    const element = document.querySelector<HTMLImageElement>('.pc-image-preview-viewport img')!
    Object.defineProperties(element, { naturalWidth: { configurable: true, value: 4000 }, naturalHeight: { configurable: true, value: 2000 } })
    await act(() => element.dispatchEvent(new Event('load')))
    const viewport = document.querySelector<HTMLElement>('.pc-image-preview-viewport')!
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} })
    return { element, viewport }
  }
  return { load, render, closes: () => closes, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
async function click(label: string) {
  await act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
}
async function pointer(element: HTMLElement, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  await act(() => element.dispatchEvent(event))
}

test('preview uses original pixels, starts fitted, and offers 100%, zoom controls and reset', async () => {
  const view = await mount()
  try {
    const { element } = await view.load()
    assert.equal(element.getAttribute('src'), image.url)
    assert.match(element.style.transform, /scale\(0\.244\)/)
    assert.match(document.body.textContent!, /4000 × 2000/)
    const buttons = [...document.querySelectorAll('button')]
    await act(() => buttons.find(button => button.textContent === '100%')!.click())
    assert.match(element.style.transform, /scale\(1\)/)
    await click('放大图片'); assert.match(element.style.transform, /scale\(1\.25\)/)
    await click('缩小图片'); assert.match(element.style.transform, /scale\(1\)/)
    await act(() => buttons.find(button => button.textContent === '适应窗口')!.click())
    assert.match(element.style.transform, /translate\(0px, 0px\) scale\(0\.244\)/)
  } finally { await view.destroy() }
})

test('wheel zoom anchors to the cursor, prevents page scrolling and clamps maximum zoom', async () => {
  const view = await mount()
  try {
    const { element, viewport } = await view.load()
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 800, clientY: 300, deltaY: -100 })
    await act(() => viewport.dispatchEvent(wheel))
    assert.equal(wheel.defaultPrevented, true)
    const transform = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(element.style.transform)!
    assert.ok(Math.abs((300 - Number(transform[1])) / Number(transform[3]) - 300 / 0.244) < 0.001)
    for (let index = 0; index < 20; index++) await click('放大图片')
    assert.match(element.style.transform, /scale\(4\)/)
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!.disabled, true)
  } finally { await view.destroy() }
})

test('dragging pans the enlarged original with boundaries; double click returns to fit', async () => {
  const view = await mount()
  try {
    const { element, viewport } = await view.load()
    await act(() => viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 500, clientY: 300 })))
    assert.match(element.style.transform, /scale\(1\)/)
    await pointer(viewport, 'pointerdown', 100, 100)
    await pointer(viewport, 'pointermove', 300, 200)
    assert.match(element.style.transform, /translate\(200px, 100px\)/)
    await pointer(viewport, 'pointermove', 9000, 9000)
    assert.match(element.style.transform, /translate\(1500px, 700px\)/)
    await pointer(viewport, 'pointerup', 9000, 9000)
    await act(() => viewport.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    assert.match(element.style.transform, /translate\(0px, 0px\) scale\(0\.244\)/)
  } finally { await view.destroy() }
})

test('two pointers pinch to zoom; changing the asset resets the fitted view', async () => {
  const view = await mount()
  try {
    const { element, viewport } = await view.load()
    await act(() => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })))
    await pointer(viewport, 'pointerdown', 400, 300, 1)
    await pointer(viewport, 'pointerdown', 600, 300, 2)
    await pointer(viewport, 'pointermove', 700, 300, 2)
    assert.match(element.style.transform, /translate\(50px, 0px\) scale\(1\.5\)/)
    await pointer(viewport, 'pointercancel', 700, 300, 2)
    await pointer(viewport, 'pointerup', 400, 300, 1)
    await view.render({ ...image, id: 'another', url: '/api/assets/another/file' })
    const next = await view.load()
    assert.match(next.element.style.transform, /translate\(0px, 0px\) scale\(0\.244\)/)
  } finally { await view.destroy() }
})

test('a failed image shows a clear state and disables zoom; preview remains dismissible', async () => {
  const view = await mount()
  try {
    await act(() => document.querySelector('img')!.dispatchEvent(new Event('error')))
    assert.match(document.body.textContent!, /图片加载失败/)
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="放大图片"]')!.disabled, true)
    await click('关闭素材预览'); assert.equal(view.closes(), 1)
  } finally { await view.destroy() }
})

test('video preview keeps the original player and has no image zoom controls', async () => {
  const view = await mount({ ...image, kind: 'video', filename: '视频.mp4' })
  try {
    assert.equal(document.querySelector('video')?.getAttribute('src'), image.url)
    assert.equal(document.querySelector('[aria-label="图片缩放控制"]'), null)
  } finally { await view.destroy() }
})

test('Escape closes only a candidate image preview, preserving its manager and canvas composer; Tab reaches document', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let canvasEscapes = 0, candidateCloses = 0, previewCloses = 0, documentTabs = 0
  const candidate = { ...image, created_at: '2026-10-17T10:00:00Z', source: 'generated' } as Asset
  const observeTab = (event: KeyboardEvent) => { if (event.key === 'Tab') documentTabs++ }
  function Harness() {
    const [composerOpen, setComposerOpen] = useState(true)
    const [managerOpen, setManagerOpen] = useState(true)
    const [preview, setPreview] = useState<Asset | null>(null)
    return <div onKeyDown={event => {
      if (event.key === 'Escape') { canvasEscapes++; setComposerOpen(false) }
    }}>
      <div data-testid="composer-state">{composerOpen ? 'composer-open' : 'composer-closed'}</div>
      {managerOpen && <ShotCandidateManager candidates={[candidate]} archivedAssetIds={[]} displayedAssetId={candidate.id} models={[]} title="船头分镜"
        previewOpen={Boolean(preview)} onUse={async () => {}} onArchive={async () => {}} onPreview={setPreview}
        onClose={() => { candidateCloses++; setManagerOpen(false) }} />}
      {preview && <CanvasMediaPreview asset={preview} title="分镜图候选预览" onClose={() => { previewCloses++; setPreview(null) }} />}
    </div>
  }
  document.addEventListener('keydown', observeTab)
  try {
    await act(() => root.render(<MantineProvider env="test"><Harness /></MantineProvider>))
    await click('放大查看分镜候选图')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
    const viewport = document.querySelector<HTMLElement>('.pc-media-preview [aria-label="图片详情查看器"]')!
    assert.ok(viewport)
    await act(() => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    assert.equal(documentTabs, 1, 'Tab must reach Mantine document-level focus trapping')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(() => viewport.dispatchEvent(escape))
    assert.equal(escape.defaultPrevented, true)
    assert.equal(previewCloses, 1)
    assert.equal(document.querySelector('.pc-media-preview'), null)
    assert.ok(document.querySelector('.pc-shot-candidate-modal'), 'candidate manager remains open below the preview')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    assert.equal(candidateCloses, 0)
    assert.equal(canvasEscapes, 0, 'the preview Escape must not bubble through portals to canvas shortcuts')
    assert.equal(container.querySelector('[data-testid="composer-state"]')!.textContent, 'composer-open')
  } finally {
    document.removeEventListener('keydown', observeTab)
    await act(() => root.unmount())
    container.remove()
  }
})
