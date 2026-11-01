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
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
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

test('full-screen image preview uses original pixels, starts fitted, and offers 100%, zoom controls and reset', async () => {
  const view = await mount()
  try {
    assert.equal(document.querySelector('[role="dialog"]')?.hasAttribute('data-full-screen'), true)
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

test('full-screen video preview keeps the original player and has no image zoom controls', async () => {
  const view = await mount({ ...image, kind: 'video', filename: '视频.mp4' })
  try {
    assert.equal(document.querySelector('[role="dialog"]')?.hasAttribute('data-full-screen'), true)
    assert.equal(document.querySelector('video')?.getAttribute('src'), image.url)
    assert.equal(document.querySelector('[aria-label="图片缩放控制"]'), null)
  } finally { await view.destroy() }
})

test('video preview shows generation and edit durations before review, then jumps to a reported problem without submitting analysis', async t => {
  const requests: Array<{ url: string; method?: string }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), method: init?.method })
    return Response.json({ reviews: [{ id: 'report', project_id: 'project', asset_id: 'video', shot_id: 'shot', model_id: 'vision', model_name: '画面模型', created_at: '2026-10-26T10:00:00Z',
      input_mode: 'sampled_frames', duration_ms: 4000, target_duration_ms: 2000, stale: false, summary: '抬手未完成', verdict: 'needs_work', checks: [], limitations: [], usable_ranges: [], evidence_frames: [], sample_times_ms: [1200],
      findings: [{ id: 'issue', category: 'action', severity: 'warning', start_ms: 1200, end_ms: 2000, observation: '手停在原位', expected: '抬手', suggestion: '明确抬手终态', evidence_times_ms: [] }] }] })
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><CanvasMediaPreview asset={{ ...image, id: 'video', kind: 'video', project_id: 'project' }} title="反应镜头"
      projectId="project" shotId="shot" generationDurationMs={4000} plannedDurationMs={2000}
      reviewModels={[{ id: 'vision', label: '看图模型', inputMode: 'sampled_frames' }]} onClose={() => {}} /></MantineProvider>))
    assert.match(document.querySelector('[aria-label="生成与入片时长"]')!.textContent!, /生成 4.0 秒.*计划入片 2.0 秒/)
    assert.equal(requests.length, 0)
    await click('成片复核')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, undefined)
    await click('播放问题片段 0:01.2')
    assert.equal(document.querySelector<HTMLVideoElement>('.pc-media-preview video')!.currentTime, 1.2)
    assert.equal(requests.length, 1)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('reviewing a comparison candidate switches playback and review evidence to that actual asset while preserving the baseline', async t => {
  const requests: Array<{ url: string; method?: string }> = []
  const baseline = { ...image, id: 'baseline', project_id: 'project', shot_id: 'shot', kind: 'video', source: 'generated', url: '/baseline.mp4', filename: '原片.mp4' } as Asset
  const candidate = { ...baseline, id: 'candidate', filename: '候选.mp4', url: '/candidate.mp4' }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), method: init?.method })
    if (String(url).includes('video-comparisons')) return Response.json({ comparisons: [{ id: 'comparison', created_at: '2026-10-26T10:00:00Z', model_name: 'Fast', status: 'succeeded',
      baseline_prompt: '主角跑近', candidate_prompt: '主角跑近并停稳', parameters: { reference_asset_ids: [] }, generation_duration_ms: 4000, edit_duration_ms: 2000, trim_target_ms: 2000,
      seed_locked: false, stale: false, stale_reasons: [], candidate_url: candidate.url, candidate_asset: candidate }] })
    return Response.json({ reviews: [] })
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><CanvasMediaPreview asset={baseline} title="跑入镜头" projectId="project" initialPanel="comparison"
      reviewModels={[{ id: 'vision', label: '看图模型', inputMode: 'sampled_frames' }]} onClose={() => {}} /></MantineProvider>))
    const review = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '复核对照候选')!
    assert.ok(review)
    await act(() => review.click())
    assert.equal(document.querySelector('.pc-media-preview-stage video')?.getAttribute('src'), candidate.url)
    assert.ok(requests.some(request => request.url.includes('/assets/candidate/video-reviews')))
    await click('返回原片')
    assert.equal(document.querySelector('.pc-media-preview-stage video')?.getAttribute('src'), baseline.url)
    assert.ok(requests.some(request => request.url.includes('/assets/baseline/video-reviews')))
    assert.ok(requests.every(request => !request.method || request.method === 'GET'), 'opening comparisons and reports must not submit generation or alter selected media')
  } finally { await act(() => root.unmount()); container.remove() }
})

for (const modality of ['image', 'video'] as const) test(`Escape closes only a candidate ${modality} preview, preserving its manager and canvas composer; Tab reaches document`, async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let canvasEscapes = 0, candidateCloses = 0, previewCloses = 0, documentTabs = 0
  const candidate = { ...image, kind: modality, created_at: '2026-10-17T10:00:00Z', source: 'generated' } as Asset
  const observeTab = (event: KeyboardEvent) => { if (event.key === 'Tab') documentTabs++ }
  function Harness() {
    const [composerOpen, setComposerOpen] = useState(true)
    const [managerOpen, setManagerOpen] = useState(true)
    const [preview, setPreview] = useState<Asset | null>(null)
    return <div onKeyDown={event => {
      if (event.key === 'Escape') { canvasEscapes++; setComposerOpen(false) }
    }}>
      <div data-testid="composer-state">{composerOpen ? 'composer-open' : 'composer-closed'}</div>
      {managerOpen && <ShotCandidateManager modality={modality} candidates={[candidate]} archivedAssetIds={[]} displayedAssetId={candidate.id} models={[]} title="船头分镜"
        previewOpen={Boolean(preview)} onUse={async () => {}} onArchive={async () => {}} onPreview={setPreview}
        onClose={() => { candidateCloses++; setManagerOpen(false) }} />}
      {preview && <CanvasMediaPreview asset={preview} title="分镜图候选预览" onClose={() => { previewCloses++; setPreview(null) }} />}
    </div>
  }
  document.addEventListener('keydown', observeTab)
  try {
    await act(() => root.render(<MantineProvider env="test"><Harness /></MantineProvider>))
    await click(modality === 'image' ? '放大查看分镜候选图' : '全屏查看视频候选')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
    const focusTarget = document.querySelector<HTMLElement>(modality === 'image'
      ? '.pc-media-preview [aria-label="图片详情查看器"]' : '.pc-media-preview [aria-label="播放素材"]')!
    assert.ok(focusTarget)
    await act(() => focusTarget.focus())
    if (modality === 'video') {
      const video = document.querySelector<HTMLVideoElement>('.pc-media-preview video')!
      video.play = async () => {}
      await act(() => focusTarget.click())
    }
    assert.equal(document.activeElement, focusTarget)
    await act(() => focusTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    assert.equal(documentTabs, 1, 'Tab must reach Mantine document-level focus trapping')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(() => focusTarget.dispatchEvent(escape))
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
