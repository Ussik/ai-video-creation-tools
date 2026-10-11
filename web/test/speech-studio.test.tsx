import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: SpeechStudio } = await import('../src/SpeechStudio')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const config = { enabled: true, has_key: true, default_speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 0, endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', resource_id: 'seed-tts-2.0' }
const voice = { id: 'narrator', name: '旁白', speaker: config.default_speaker, instructions: '', speech_rate: 0 }
const line = { id: 'line', project_id: 'project', voice_id: voice.id, scene_id: 'scene', position: 0, text: '这是旧台词。', instructions: '', context_text: '', selected_asset_id: null, created_at: '2026-10-10T00:00:00Z', updated_at: '', takes: [] as any[] }
const take = { id: 'take', line_id: line.id, job_id: 'job', asset_id: null, status: 'queued', error: null, text: line.text, speaker: voice.speaker, instructions: '', context_text: '', speech_rate: 0, created_at: new Date().toISOString(), url: null, filename: null }
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text); assert.ok(node, text); return node }
async function fill(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  assert.ok(field, label)
  const prototype = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function mount(onAssetsChanged = async () => {}, onClose = () => {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><SpeechStudio projectId="project" projectName="短剧" scenes={[{ id: 'scene', heading: '场次一' } as any]} onClose={onClose} onAssetsChanged={onAssetsChanged} /></MantineProvider>))
  return { destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('opening only loads configuration and project speech, without synthesis or automatic import', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async url => { const path = String(url); calls.push(path); return Response.json(path.endsWith('/config') ? config : { voices: [voice], lines: [line] }) })
  const view = await mount()
  try {
    assert.deepEqual(calls.sort(), ['/api/projects/project/speech', '/api/speech/config'])
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="朗读文本"]')!.value, line.text)
    assert.equal(button('生成配音').disabled, false)
    assert.equal(document.querySelector('audio'), null)
  } finally { await view.destroy() }
})

test('generation saves edited text and performance before submitting once, then disables the original button label', async t => {
  const calls: Array<{ path: string; method: string; body: any }> = []
  let current = { ...line }, submitted = false
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })
    if (path.endsWith('/config')) return Response.json(config)
    if (path.endsWith('/lines/line') && method === 'PATCH') { current = { ...current, ...body }; return Response.json(current) }
    if (path.endsWith('/generate')) { submitted = true; return Response.json({ job: { id: 'job' } }) }
    return Response.json({ voices: [voice], lines: [{ ...current, takes: submitted ? [{ ...take, text: current.text, instructions: current.instructions }] : [] }] })
  })
  const view = await mount()
  try {
    await fill('朗读文本', '这句台词已经修改。'); await fill('表演要求', '轻声，略带犹豫。')
    await act(async () => button('生成配音').click())
    const updates = calls.filter(item => item.method !== 'GET')
    assert.deepEqual(updates.map(item => [item.method, item.path]), [['PATCH', '/api/projects/project/speech/lines/line'], ['POST', '/api/projects/project/speech/lines/line/generate']])
    assert.equal(updates[0].body.text, '这句台词已经修改。'); assert.equal(updates[0].body.instructions, '轻声，略带犹豫。')
    assert.equal(button('生成配音').textContent, '生成配音'); assert.equal(button('生成配音').disabled, true)
    assert.equal(document.querySelectorAll('.speech-generating').length, 1)
    await act(() => button('生成配音').click())
    assert.equal(calls.filter(item => item.path.endsWith('/generate')).length, 1)
  } finally { await view.destroy() }
})

test('a missing key blocks generation, and saving clears the credential without displaying a stored key', async t => {
  let currentConfig = { ...config, enabled: false, has_key: false }
  const keys: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/config')) {
      if (init?.method === 'PUT') { keys.push(JSON.parse(String(init.body)).api_key); currentConfig = { ...config } }
      return Response.json(currentConfig)
    }
    return Response.json({ voices: [voice], lines: [line] })
  })
  const view = await mount()
  try {
    assert.equal(button('生成配音').disabled, true)
    await fill('语音 API Key', 'test-secret-value')
    assert.equal(document.body.textContent!.includes('test-secret-value'), false)
    await act(async () => button('保存并启用').click())
    assert.deepEqual(keys, ['test-secret-value'])
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, '')
    assert.equal(button('生成配音').disabled, false)
  } finally { await view.destroy() }
})

test('historical audio stays playable, and selecting it posts selection without generating', async t => {
  let selectedAsset: string | null = null, changed = 0
  const mutations: Array<{ path: string; body: any }> = []
  const history = { ...take, asset_id: 'audio', status: 'succeeded', text: '旧版本的文字', url: '/api/assets/audio/file', duration_ms: 1300 }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); mutations.push({ path, body }); selectedAsset = body.asset_id; return Response.json({ ...line, selected_asset_id: selectedAsset }) }
    return Response.json(path.endsWith('/config') ? config : { voices: [voice], lines: [{ ...line, takes: [history, { ...take, id: 'old-failed', status: 'failed', error: 'Earlier error' }], selected_asset_id: selectedAsset }] })
  })
  const view = await mount(async () => { changed++ })
  try {
    assert.equal(document.querySelector<HTMLAudioElement>('audio')!.getAttribute('src'), history.url)
    assert.match(document.querySelector('.speech-take')!.textContent!, /历史版本/)
    assert.match(document.querySelector('.speech-take-version')!.textContent!, /旧版本的文字/)
    assert.equal(document.querySelector('[role="alert"]'), null, 'a successful latest take must hide older failures')
    await act(async () => button('选用此版本').click())
    assert.deepEqual(mutations, [{ path: '/api/projects/project/speech/lines/line/select', body: { asset_id: 'audio' } }])
    assert.equal(changed, 1); assert.equal(button('已选用').disabled, true)
  } finally { await view.destroy() }
})

test('closing an edited draft asks before discarding, while empty drafts do not trigger confirmation', async t => {
  let closes = 0, empty = false
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('/config') ? config : { voices: [voice], lines: empty ? [] : [line] }))
  const view = await mount(async () => {}, () => { closes++ })
  try {
    await fill('朗读文本', '正在修改的台词')
    await act(() => document.querySelector<HTMLButtonElement>('.speech-studio-header .mantine-CloseButton-root')!.click())
    assert.equal(closes, 0)
    await act(() => button('继续编辑').click())
    assert.equal(closes, 0)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="朗读文本"]')!.value, '正在修改的台词')
    await act(() => document.querySelector<HTMLButtonElement>('.speech-studio-header .mantine-CloseButton-root')!.click())
    await act(async () => button('丢弃并关闭').click())
    assert.equal(closes, 1)
  } finally { await view.destroy() }
  empty = true
  const fresh = await mount(async () => {}, () => { closes++ })
  try {
    await act(() => document.querySelector<HTMLButtonElement>('.speech-studio-header .mantine-CloseButton-root')!.click())
    assert.equal(closes, 2)
    assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === '丢弃并关闭'), false)
  } finally { await fresh.destroy() }
})

test('unassigned roles cannot generate, and switching lines preserves unsaved edits', async t => {
  const second = { ...line, id: 'second', position: 1, voice_id: 'unassigned', text: '第二句' }
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('/config') ? config : { voices: [voice, { ...voice, id: 'unassigned', name: '待分配角色' }], lines: [line, second] }))
  const view = await mount()
  try {
    await fill('朗读文本', '未保存的新文本')
    await act(() => [...document.querySelectorAll<HTMLButtonElement>('.speech-line-item')].find(item => item.textContent!.includes('第二句'))!.click())
    assert.equal(button('生成配音').disabled, true)
    assert.match(document.querySelector('.speech-editor')!.textContent!, /请先确认这句台词的角色/)
    await act(() => [...document.querySelectorAll<HTMLButtonElement>('.speech-line-item')].find(item => item.textContent!.includes('未保存的新文本'))!.click())
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="朗读文本"]')!.value, '未保存的新文本')
  } finally { await view.destroy() }
})
