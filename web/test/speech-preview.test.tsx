import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { SpeechAudioClip } from '@video-studio/shared/media/speech-timeline'
import { fixture } from './fixtures/final-cut'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLMediaElement', 'Element', 'ShadowRoot', 'Event', 'KeyboardEvent', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const paused = new WeakMap<HTMLMediaElement, boolean>(), readiness = new WeakMap<HTMLMediaElement, number>(), pauses = new WeakMap<HTMLMediaElement, number>()
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return paused.get(this) ?? true } })
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return readiness.get(this) ?? 4 } })
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return this.tagName === 'AUDIO' ? 3 : 6 } })
dom.window.HTMLMediaElement.prototype.play = function () { paused.set(this, false); return Promise.resolve() }
dom.window.HTMLMediaElement.prototype.pause = function () { paused.set(this, true); pauses.set(this, (pauses.get(this) || 0) + 1) }
const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0, clock = 0
Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame }, cancelAnimationFrame: (id: number) => frames.delete(id) })
const { createRoot } = await import('react-dom/client')
const { default: TimelinePreview } = await import('../src/features/final-cut/TimelinePreview')
after(() => dom.window.close())
const speech: SpeechAudioClip = { id: 'placement', project_id: 'project', line_id: 'line', shot_id: 's1', asset_id: 'speech', offset_ms: 500,
  in_ms: 0, out_ms: 2000, gain: 1, text: '跨镜头对白。', voice_name: '旁白', stale: false, start_ms: 500, end_ms: 2500 }
async function mount(t: import('node:test').TestContext, options: { video?: boolean; gain?: number; missing?: boolean } = {}) {
  frames.clear(); clock = 0; t.mock.method(performance, 'now', () => clock)
  const data = fixture().detail
  if (!options.video) { data.timeline_clips[0].asset_id = 'alternate'; data.timeline_clips[0].source_duration_ms = null }
  data.timeline_clips[0].out_ms = 2000; data.timeline_clips[1].out_ms = 2000
  const sourceAsset = data.assets[0]
  const music = { ...sourceAsset, id: 'music', kind: 'audio' as const, url: '/music.wav' }
  if (!options.missing) data.assets.push({ ...sourceAsset, id: 'speech', kind: 'audio', url: '/speech.wav' })
  data.assets.push(music)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = (active = true) => root.render(<MantineProvider env="test"><TimelinePreview shots={data.shots} clips={data.timeline_clips} assets={data.assets} ratio="16:9" musicAsset={music} speechAudio={[{ ...speech, gain: options.gain ?? 1 }]} active={active} /></MantineProvider>)
  await act(() => render())
  await act(() => {
    container.querySelectorAll('img').forEach(node => node.dispatchEvent(new Event('load')))
    container.querySelectorAll('video').forEach(node => { node.dispatchEvent(new Event('loadedmetadata')); node.dispatchEvent(new Event('canplay')) })
  })
  return { container, setActive: async (active: boolean) => { await act(() => render(active)) }, destroy: async () => { await act(() => root.unmount()); container.remove(); frames.clear() } }
}
async function step(time: number) {
  clock = time
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); await Promise.resolve() })
}
async function toggle(container: HTMLElement, label = '播放预览') { await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()) }

test('speech stays playing across UI updates and cuts, with music ducking, pause and offset preserved', async t => {
  const view = await mount(t)
  try {
    const audio = view.container.querySelector<HTMLAudioElement>('audio[src="/speech.wav"]')!, music = view.container.querySelector<HTMLAudioElement>('audio[src="/music.wav"]')!
    await toggle(view.container); await step(800)
    assert.equal(audio.paused, false); assert.ok(Math.abs(audio.currentTime - 0.3) < 0.01)
    assert.equal(music.volume, 0.06)
    const count = pauses.get(audio) || 0
    await step(1000); await step(1300)
    assert.equal(pauses.get(audio) || 0, count, 'rendering the clock must not detach and pause the speech element')
    await step(2000); await step(2200)
    assert.match(view.container.querySelector('.timeline-preview-shot')!.textContent!, /02/)
    assert.ok(Math.abs(audio.currentTime - 1.7) < 0.01, 'speech continues from its source offset after the cut')
    await toggle(view.container, '暂停预览')
    assert.equal(audio.paused, true); assert.equal(music.paused, true)
    assert.ok(Math.abs(audio.currentTime - 1.7) < 0.01)
  } finally { await view.destroy() }
})

test('a buffering speech track freezes the visual clock until the audio is ready', async t => {
  const view = await mount(t)
  try {
    const audio = view.container.querySelector<HTMLAudioElement>('audio[src="/speech.wav"]')!
    readiness.set(audio, 1)
    await toggle(view.container); await step(400); await step(600); await step(900)
    assert.match(view.container.textContent!, /正在缓冲音画/)
    assert.equal(audio.paused, true)
    assert.ok(view.container.querySelector('.timeline-preview-clock')!.textContent!.startsWith('00:00.4'))
    readiness.set(audio, 4); await step(1000)
    assert.equal(audio.paused, false)
    assert.ok(audio.currentTime < 0.3, 'buffering time cannot be counted as played dialogue')
  } finally { await view.destroy() }
})

test('muted speech never plays or ducks the music, and missing audio blocks preview clearly', async t => {
  const muted = await mount(t, { gain: 0 })
  try {
    await toggle(muted.container); await step(800)
    assert.equal(muted.container.querySelector<HTMLAudioElement>('audio[src="/speech.wav"]')!.paused, true)
    assert.equal(muted.container.querySelector<HTMLAudioElement>('audio[src="/music.wav"]')!.volume, 0.24)
  } finally { await muted.destroy() }
  const missing = await mount(t, { missing: true })
  try {
    assert.match(missing.container.textContent!, /入片配音素材不存在/)
    assert.equal(missing.container.querySelector<HTMLButtonElement>('[aria-label="播放预览"]')!.disabled, true)
  } finally { await missing.destroy() }
})

test('seeking a video after playback updates its actual source position and pauses all audio', async t => {
  const view = await mount(t, { video: true })
  try {
    await toggle(view.container)
    const video = view.container.querySelector<HTMLVideoElement>('video')!
    video.currentTime = 0.9; await step(900)
    const slider = view.container.querySelector<HTMLElement>('[role="slider"]')!
    await act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    assert.equal(video.currentTime, 0)
    assert.equal(video.paused, true)
    assert.ok([...view.container.querySelectorAll('audio')].every(audio => audio.paused))
    await act(() => video.dispatchEvent(new Event('seeked')))
    assert.equal(view.container.querySelector<HTMLButtonElement>('[aria-label="播放预览"]')!.disabled, false)
  } finally { await view.destroy() }
})

test('speech over 100 percent uses Web Audio even when the visual track contains only images', async t => {
  const levels: Array<{ value: number }> = []
  class AudioContextFixture {
    state = 'running'; destination = {}
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    createMediaElementSource() { return { connect: (gain: unknown) => gain } }
    createGain() { const gain = { gain: { value: 1 }, connect() { return this } }; levels.push(gain.gain); return gain }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioContextFixture })
  const view = await mount(t, { gain: 1.5 })
  try {
    await toggle(view.container); await step(800)
    assert.equal(view.container.querySelector<HTMLAudioElement>('audio[src="/speech.wav"]')!.volume, 1)
    assert.ok(levels.some(level => level.value === 1.5))
  } finally {
    await view.destroy()
    if (original) Object.defineProperty(globalThis, 'AudioContext', original)
    else Reflect.deleteProperty(globalThis, 'AudioContext')
  }
})

test('opening another preview pauses the underlying player without losing its position', async t => {
  const view = await mount(t)
  try {
    await toggle(view.container); await step(800)
    const audio = view.container.querySelector<HTMLAudioElement>('audio[src="/speech.wav"]')!
    assert.equal(audio.paused, false)
    await view.setActive(false)
    assert.ok([...view.container.querySelectorAll('audio')].every(item => item.paused))
    assert.ok(Math.abs(audio.currentTime - 0.3) < 0.01)
    assert.equal(view.container.querySelector<HTMLButtonElement>('[aria-label="播放预览"]')!.disabled, true)
    await view.setActive(true)
    assert.equal(audio.paused, true, 'closing an overlay must not resume playback unexpectedly')
  } finally { await view.destroy() }
})
