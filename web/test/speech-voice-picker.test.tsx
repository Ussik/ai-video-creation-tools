import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { speechStandardVoice, speechStandardVoices, speechVoiceMatches } from '@video-studio/shared/media/speech-voices'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: SpeechVoicePicker } = await import('../src/features/speech/SpeechVoicePicker')
const { useSpeechVoicePreview } = await import('../src/features/speech/use-speech-voice-preview')
after(() => dom.window.close())

class SampleAudio {
  static instances: SampleAudio[] = []
  src = ''; preload = ''; paused = false; loads = 0
  onplaying: (() => void) | null = null; onwaiting: (() => void) | null = null
  onended: (() => void) | null = null; onerror: (() => void) | null = null
  resolve!: () => void; reject!: (error: Error) => void
  promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
  constructor() { SampleAudio.instances.push(this) }
  play() { return this.promise }
  pause() { this.paused = true }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  load() { this.loads++ }
}
const vivi = speechStandardVoices[0]!, foreign = speechStandardVoices.find(item => item.group === '外语')!
Object.defineProperty(globalThis, 'Audio', { configurable: true, value: SampleAudio })
async function mount() {
  let preview!: ReturnType<typeof useSpeechVoicePreview>
  let speaker = vivi.speaker, enabled = true
  function Harness() { preview = useSpeechVoicePreview(enabled); return <SpeechVoicePicker id="role" index={0} speaker={speaker} disabled={false} onChange={value => { speaker = value; render() }} preview={preview} /> }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  function render() { root.render(<MantineProvider env="test"><Harness /></MantineProvider>) }
  await act(render)
  return { preview: () => preview, disable: async () => { enabled = false; await act(render) }, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function audition() { return document.querySelector<HTMLButtonElement>('button[aria-label*="角色 1"]')! }
async function search(value: string) {
  const field = document.querySelector<HTMLInputElement>('[aria-label="搜索音色 1"]')!
  await act(() => { field.focus(); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}

test('the verified 2.0 catalog includes official presets and foreign voices with usable sample URLs', () => {
  assert.equal(speechStandardVoices.length, 466)
  assert.equal(new Set(speechStandardVoices.map(item => item.speaker)).size, 466)
  assert.equal(speechStandardVoices.filter(item => item.speaker.startsWith('ICL_')).length, 201)
  for (const voice of speechStandardVoices) {
    assert.ok(voice.name && voice.language && voice.description)
    assert.match(voice.speaker, /^[a-zA-Z0-9_-]+$/); assert.doesNotMatch(voice.speaker, /^S_/i)
    const url = new URL(voice.sample_url)
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'lf3-static.bytednsdoc.com')
    assert.match(url.pathname, /\.(wav|mp3)$/)
  }
  assert.match(speechStandardVoice('zh_female_sophie_uranus_bigtts')!.sample_url, /zh_male_sophie_uranus_bigtts\.mp3$/)
  assert.ok(speechVoiceMatches(foreign, foreign.speaker.toUpperCase()))
  assert.ok(speechVoiceMatches(vivi, 'vivi 粤语 通用'))
  assert.equal(speechVoiceMatches(vivi, '不存在的音色'), false)
})

test('dropdown search combines gender categories with name, ID, language and scene without changing selection', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Voice selection must not request synthesis') })
  const view = await mount()
  try {
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="标准音色 1"]')!.click())
    await search('')
    assert.equal(document.querySelectorAll('[role="option"]').length, 466)
    const category = (value: string) => document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!
    const options = () => [...document.querySelectorAll('[role="option"]')]
    await act(() => category('男').click())
    assert.equal(options().length, speechStandardVoices.filter(item => item.gender === '男').length)
    assert.ok(options().every(item => speechStandardVoice(item.getAttribute('value')!)!.gender === '男'))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="标准音色 1"]')!.value, vivi.name)
    await search('Vivi')
    assert.equal(options().length, 0)
    assert.match(document.body.textContent!, /没有匹配的音色/)
    await act(() => category('女').click())
    assert.equal(options().length, 1)
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="清空音色搜索"]')!.click())
    assert.equal(options().length, speechStandardVoices.filter(item => item.gender === '女').length)
    await search('Vivi 粤语 通用')
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    assert.match(document.querySelector('[role="option"]')!.textContent!, /Vivi/)
    await act(() => category('all').click())
    await search(foreign.speaker.toUpperCase())
    assert.equal(document.querySelectorAll('[role="option"]').length, 1)
    await act(() => document.querySelector<HTMLElement>('[role="option"]')!.click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="标准音色 1"]')!.value, foreign.name)
    assert.match(audition().getAttribute('aria-label')!, new RegExp(foreign.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally { await view.destroy() }
})

test('search results support keyboard selection and restore the trigger focus', async () => {
  const view = await mount()
  try {
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="标准音色 1"]')!.click())
    await search(foreign.speaker)
    const field = document.querySelector<HTMLInputElement>('[aria-label="搜索音色 1"]')!
    await act(() => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true })))
    await act(() => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="标准音色 1"]')!.value, foreign.name)
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)))
    assert.equal(document.activeElement?.getAttribute('aria-label'), '标准音色 1')
  } finally { await view.destroy() }
})

test('audition starts only on click, supports loading cancellation, and ignores a late play resolution', async () => {
  SampleAudio.instances = []
  const view = await mount()
  try {
    assert.equal(SampleAudio.instances.length, 0)
    await act(() => audition().click())
    const audio = SampleAudio.instances[0]!
    assert.equal(audio.src, vivi.sample_url); assert.equal(audition().textContent, '取消加载')
    await act(() => audition().click())
    assert.equal(audio.paused, true); assert.equal(audio.src, ''); assert.equal(audio.loads, 1)
    await act(async () => audio.resolve())
    assert.equal(view.preview().status, 'idle')
    assert.equal(audition().textContent, '试听')
  } finally { await view.destroy() }
})

test('only one sample plays and stale failures cannot overwrite the newer sample', async () => {
  SampleAudio.instances = []
  const view = await mount()
  try {
    await act(() => view.preview().toggle('first-role', vivi))
    const first = SampleAudio.instances[0]!, staleError = first.onerror!
    await act(() => view.preview().toggle('role', foreign))
    const second = SampleAudio.instances[1]!
    assert.equal(first.paused, true); assert.equal(first.src, '')
    await act(async () => { first.reject(new Error('old request')); staleError(); second.resolve() })
    assert.equal(view.preview().status, 'playing'); assert.equal(view.preview().speaker, foreign.speaker)
    await act(() => second.onwaiting!())
    assert.equal(view.preview().status, 'loading')
    await act(() => second.onplaying!())
    await act(() => second.onended!())
    assert.equal(view.preview().status, 'idle'); assert.equal(second.paused, true)
  } finally { await view.destroy() }
})

test('playback errors allow retry and disabling/unmounting aborts the audio', async () => {
  SampleAudio.instances = []
  const view = await mount()
  try {
    await act(() => audition().click())
    await act(async () => SampleAudio.instances[0]!.reject(new Error('blocked playback')))
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /无法播放/)
    assert.equal(SampleAudio.instances[0]!.paused, true)
    await act(() => audition().click())
    assert.equal(document.querySelector('[role="alert"]'), null)
    await view.disable()
    assert.equal(SampleAudio.instances[1]!.paused, true); assert.equal(view.preview().status, 'idle')
    await act(() => view.preview().toggle('role', vivi))
    assert.equal(SampleAudio.instances.length, 2)
  } finally { await view.destroy() }
  const fresh = await mount()
  await act(() => audition().click())
  const last = SampleAudio.instances.at(-1)!
  await fresh.destroy()
  assert.equal(last.paused, true); assert.equal(last.src, ''); assert.equal(last.onplaying, null)
})
