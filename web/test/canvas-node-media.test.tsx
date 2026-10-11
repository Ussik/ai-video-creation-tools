import { MantineProvider } from '@mantine/core'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Asset } from '../src/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(globalThis, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
const observers = new Set<TestIntersectionObserver>()
class TestIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) { observers.add(this) }
  observe() {}
  disconnect() { observers.delete(this) }
  visible(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}
Object.assign(globalThis, { IntersectionObserver: TestIntersectionObserver })
const { createRoot } = await import('react-dom/client')
const { default: CanvasNodeMedia } = await import('../src/CanvasNodeMedia')
after(() => dom.window.close())
const video = { id: 'video', kind: 'video', url: '/api/assets/video/file', filename: '镜头.mp4' } as Asset
const image = { id: 'image', kind: 'image', url: '/api/assets/image/file', filename: '参考.png' } as Asset
async function mount(asset: Asset) {
  hidden = false
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (controls = false, onMediaSize?: (width: number, height: number) => void, previewSize: 320 | 640 = 640) => {
    await act(() => root.render(<MantineProvider env="test"><CanvasNodeMedia asset={asset} controls={controls} previewSize={previewSize} onMediaSize={onMediaSize} /></MantineProvider>))
  }
  await render()
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function playing(element: HTMLVideoElement) {
  let paused = false, pauses = 0
  Object.defineProperty(element, 'paused', { configurable: true, get: () => paused })
  element.pause = () => { paused = true; pauses++ }
  return { resume: () => { paused = false }, pauses: () => pauses }
}

test('idle video uses a cached poster; single selection mounts original controls and deselection stops playback', async () => {
  const view = await mount(video)
  try {
    assert.equal(view.container.querySelector('video'), null)
    assert.equal(view.container.querySelector('img')?.getAttribute('src'), '/api/assets/video/preview?size=640')
    await view.render(true)
    const element = view.container.querySelector('video')!
    assert.equal(element.getAttribute('src'), video.url)
    assert.equal(element.controls, false); assert.ok(view.container.querySelector('[aria-label="播放素材"]')); assert.equal(element.autoplay, false)
    const playback = playing(element)
    await view.render()
    assert.equal(playback.pauses(), 1)
    assert.equal(view.container.querySelector('video'), null)
    assert.equal(observers.size, 0, 'deselect disconnects visibility observer')
  } finally { await view.destroy() }
})

test('active video pauses offscreen and in the background, never resumes automatically', async () => {
  const view = await mount(video)
  try {
    await view.render(true)
    const element = view.container.querySelector('video')!, playback = playing(element)
    const observer = [...observers][0]!
    observer.visible(false); assert.equal(playback.pauses(), 1)
    observer.visible(true); assert.equal(element.paused, true)
    playback.resume(); hidden = true
    document.dispatchEvent(new Event('visibilitychange')); assert.equal(playback.pauses(), 2)
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); assert.equal(element.paused, true)
    playback.resume(); await view.destroy(); assert.equal(playback.pauses(), 3)
    assert.equal(observers.size, 0)
  } finally { if (view.container.isConnected) await view.destroy() }
})

test('image selection restores original resolution and failed thumbnails fall back to original', async () => {
  const view = await mount(image)
  try {
    const element = view.container.querySelector('img')!
    assert.equal(element.getAttribute('src'), '/api/assets/image/preview?size=640')
    await view.render(true); assert.equal(view.container.querySelector('img'), element)
    assert.equal(element.getAttribute('src'), image.url)
    await view.render(); assert.match(element.getAttribute('src')!, /\/preview\?size=640$/)
    await act(() => element.dispatchEvent(new Event('error')))
    assert.equal(element.getAttribute('src'), image.url)
  } finally { await view.destroy() }
})

test('video poster failure stays static and selecting it still opens playable original', async () => {
  const view = await mount(video)
  try {
    await act(() => view.container.querySelector('img')!.dispatchEvent(new Event('error')))
    assert.equal(view.container.querySelector('img, video'), null)
    assert.match(view.container.textContent!, /镜头\.mp4/)
    await view.render(true); assert.equal(view.container.querySelector('video')?.getAttribute('src'), video.url)
  } finally { await view.destroy() }
})

test('selected video reports original dimensions for generation-node sizing', async () => {
  const view = await mount(video)
  try {
    const sizes: number[][] = []
    await view.render(true, (width, height) => sizes.push([width, height]))
    const element = view.container.querySelector('video')!
    Object.defineProperties(element, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } })
    await act(() => element.dispatchEvent(new Event('loadedmetadata')))
    assert.deepEqual(sizes, [[1920, 1080]])
  } finally { await view.destroy() }
})

test('overview keeps actual images and video posters with smaller cached previews; selection restores originals', async () => {
  for (const asset of [image, video]) {
    const view = await mount(asset)
    try {
      await view.render(false, undefined, 320)
      assert.equal(view.container.querySelector('img')?.getAttribute('src'), `/api/assets/${asset.id}/preview?size=320`)
      assert.equal(view.container.querySelector('video'), null)
      await view.render(true, undefined, 320)
      assert.equal(view.container.querySelector(asset.kind === 'video' ? 'video' : 'img')?.getAttribute('src'), asset.url)
      await view.render(false, undefined, 640)
      assert.equal(view.container.querySelector('img')?.getAttribute('src'), `/api/assets/${asset.id}/preview?size=640`)
    } finally { await view.destroy() }
  }
})
