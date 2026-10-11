import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useEffect, useRef, useState } from 'react'
import { MantineProvider, TextInput } from '@mantine/core'
import { WorkspaceDisclosure } from '../src/WorkspaceDisclosure'
import { StudioMediaPlayer } from '../src/StudioMediaPlayer'

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
async function mount(children: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (next: React.ReactNode) => act(() => root.render(<MantineProvider env="test">{next}</MantineProvider>))
  await render(children)
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) { const control = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(control, label); return control }

test('library disclosure retains mounted draft and input identity through close, reopen and parent updates', async () => {
  let mounts = 0, unmounts = 0
  function Draft() {
    const [value, setValue] = useState('未保存草稿')
    useEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return <TextInput aria-label="保留草稿" value={value} onChange={event => setValue(event.currentTarget.value)} />
  }
  const content = () => <WorkspaceDisclosure label="展开草稿"><Draft /></WorkspaceDisclosure>
  const view = await mount(content())
  try {
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="保留草稿"]')!
    const toggle = view.container.querySelector<HTMLButtonElement>('.workspace-disclosure-control')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(() => toggle.click())
    await act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '修改但不提交'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(() => toggle.click()); await view.render(content()); await act(() => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(view.container.querySelector('input[aria-label="保留草稿"]'), input)
    assert.equal(input.value, '修改但不提交'); assert.equal(mounts, 1); assert.equal(unmounts, 0)
  } finally { await view.destroy() }
  assert.equal(unmounts, 1)
})

test('component player preserves native ref and event targets, keyboard seeking, mute and pause across updates', async () => {
  let native: HTMLVideoElement | null = null, played = 0, paused = 0, metadataTarget: EventTarget | null = null
  const ref = (element: HTMLVideoElement | HTMLAudioElement | null) => { native = element as HTMLVideoElement | null }
  const player = () => <StudioMediaPlayer ref={ref} src="/sample.mp4" onLoadedMetadata={event => { metadataTarget = event.currentTarget }} />
  const view = await mount(player())
  try {
    const engine = view.container.querySelector('video')!
    assert.equal(native, engine); assert.equal(engine.controls, false)
    Object.defineProperty(engine, 'duration', { configurable: true, value: 20 })
    let isPaused = true
    Object.defineProperty(engine, 'paused', { configurable: true, get: () => isPaused })
    engine.play = async () => { played++; isPaused = false; engine.dispatchEvent(new Event('play')) }
    engine.pause = () => { paused++; isPaused = true; engine.dispatchEvent(new Event('pause')) }
    await act(() => engine.dispatchEvent(new Event('loadedmetadata')))
    assert.equal(metadataTarget, engine)
    await act(async () => button('播放素材').click()); assert.equal(played, 1)
    await view.render(player()); assert.equal(native, engine); assert.equal(paused, 0)
    const thumb = view.container.querySelector<HTMLElement>('[role="slider"][aria-label="素材播放进度"]')!
    assert.ok(thumb)
    await act(() => thumb.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.ok(engine.currentTime > 0 && engine.currentTime <= 20)
    await act(() => button('素材静音').click()); assert.equal(engine.muted, true)
    await act(() => button('取消素材静音').click()); assert.equal(engine.muted, false)
    await act(() => button('暂停素材').click()); assert.equal(paused, 1)
  } finally { await view.destroy() }
  assert.equal(native, null)
})

test('failed playback is actionable and does not claim the media is playing', async () => {
  const view = await mount(<StudioMediaPlayer src="/unavailable.mp3" kind="audio" />)
  try {
    const engine = view.container.querySelector('audio')!
    engine.play = async () => { throw new Error('cannot play') }
    await act(async () => button('播放素材').click())
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /播放失败/)
    assert.ok(button('播放素材')); assert.equal(view.container.querySelector('[aria-label="暂停素材"]'), null)
    engine.play = async () => { engine.dispatchEvent(new Event('play')) }
    await act(async () => button('播放素材').click())
    assert.ok(button('暂停素材')); assert.equal(view.container.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})
