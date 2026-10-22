import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { speechStandardVoices } from '@video-studio/shared/media/speech-voices'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: SpeechStudio } = await import('../src/features/speech/SpeechStudio')
const { createRoot } = await import('react-dom/client')
Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: dom.window.Audio })
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
async function mount(onAssetsChanged = async () => {}, onClose = () => {}, props: Partial<import('../src/features/speech/SpeechStudio').SpeechStudioProps> = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><SpeechStudio projectId="project" projectName="短剧" scenes={[{ id: 'scene', heading: '场次一' } as any]} onClose={onClose} onAssetsChanged={onAssetsChanged} {...props} /></MantineProvider>))
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

test('official audition needs no key, stops on role/speaker/tab changes, and selected catalog IDs save normally', async t => {
  const samples: Array<{ src: string; paused: boolean }> = []
  class AudioSample {
    src = ''; preload = ''; paused = false
    onplaying = null; onwaiting = null; onended = null; onerror = null
    constructor() { samples.push(this) }
    play() { return Promise.resolve() }
    pause() { this.paused = true }
    removeAttribute() { this.src = '' }
    load() {}
  }
  t.mock.method(globalThis, 'Audio', function () { return new AudioSample() })
  const second = { ...voice, id: 'actor', name: '林晚', speaker: 'zh_male_m191_uranus_bigtts' }
  let currentVoices = [{ ...voice }, second]
  const writes: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/config')) return Response.json({ ...config, enabled: false, has_key: false })
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); writes.push({ path, body })
      currentVoices = currentVoices.map(item => path.endsWith(`/${item.id}`) ? { ...item, ...body } : item)
      return Response.json(currentVoices.find(item => path.endsWith(`/${item.id}`)))
    }
    return Response.json({ voices: currentVoices, lines: [line] })
  })
  const previewButton = () => document.querySelector<HTMLButtonElement>('.speech-voice-preview-button')!
  const view = await mount()
  try {
    assert.equal(samples.length, 0)
    await act(() => button('返回配音').click())
    await act(() => button('设置声音').click())
    assert.equal(previewButton().disabled, false)
    await act(async () => previewButton().click())
    assert.equal(samples.length, 1); assert.equal(writes.length, 0)
    assert.equal(samples[0].src, speechStandardVoices[0].sample_url)
    await act(() => button('编辑角色声音 2').click())
    assert.equal(samples[0].paused, true)
    await act(async () => previewButton().click())
    const foreign = speechStandardVoices.find(item => item.group === '外语')!
    await act(() => document.querySelector<HTMLInputElement>('[aria-label="标准音色 2"]')!.click())
    await fill('搜索音色 2', foreign.speaker)
    await act(() => document.querySelector<HTMLElement>(`[role="option"][value="${foreign.speaker}"]`)!.click())
    assert.equal(samples[1].paused, true)
    assert.equal(writes.length, 0, 'selecting and auditioning do not save or generate')
    await act(async () => previewButton().click())
    await act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent!.includes('台词与旁白'))!.click())
    assert.equal(samples[2].paused, true)
    await act(() => button('设置声音').click())
    await act(async () => button('保存角色声音').click())
    assert.deepEqual(writes.map(item => [item.path, item.body.speaker]), [['/api/projects/project/speech/voices/actor', foreign.speaker]])
    await act(async () => previewButton().click())
  } finally { await view.destroy() }
  assert.equal(samples.at(-1)!.paused, true)
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
    assert.equal(document.querySelector('.speech-settings-modal'), null)
    assert.equal(button('生成配音').disabled, false)
    await act(() => button('全局语音配置').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, '')
  } finally { await view.destroy() }
})

test('closing global settings keeps dialogue edits, and Escape only dismisses the active dialog', async t => {
  let closes = 0
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return Response.json(String(url).endsWith('/config') ? config : { voices: [voice], lines: [line] }) })
  const view = await mount(async () => {}, () => { closes++ })
  const escape = () => act(() => {
    const target = document.querySelector('.app-dialog button') || document.querySelector('[aria-label="语音 API Key"]') || document.body
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  try {
    await fill('朗读文本', '保留这句未保存的台词')
    await act(() => button('全局语音配置').click())
    assert.equal(document.querySelector('.speech-studio .speech-config'), null)
    assert.ok(document.querySelector('.speech-settings-modal'))
    await escape()
    assert.equal(document.querySelector('.speech-settings-modal'), null)
    assert.equal(closes, 0)

    await act(() => button('全局语音配置').click())
    await fill('语音 API Key', 'unsaved-test-key')
    await act(() => button('返回配音').click())
    assert.match(document.querySelector('.app-dialog')!.textContent!, /新密钥尚未保存/)
    await escape()
    assert.equal(document.querySelector('.app-dialog'), null)
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, 'unsaved-test-key')
    assert.equal(closes, 0)

    await act(() => button('关闭语音配置').click())
    await act(async () => button('丢弃并关闭').click())
    assert.equal(document.querySelector('.speech-settings-modal'), null)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="朗读文本"]')!.value, '保留这句未保存的台词')
    assert.equal(closes, 0)
    assert.deepEqual(calls.sort(), ['/api/projects/project/speech', '/api/speech/config'])
    await act(() => button('全局语音配置').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, '')
  } finally { await view.destroy() }
})

test('configuration errors stay in settings, and retry saves once without generating speech', async t => {
  let fail = true
  const writes: Array<{ path: string; body: unknown }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (init?.method === 'PUT') {
      writes.push({ path, body: JSON.parse(String(init.body)) })
      if (fail) return Response.json({ detail: '配置保存失败，请稍后重试' }, { status: 422 })
      return Response.json(config)
    }
    return Response.json(path.endsWith('/config') ? config : { voices: [voice], lines: [line] })
  })
  const view = await mount()
  try {
    await act(() => button('全局语音配置').click())
    await fill('语音 API Key', 'replacement-test-key')
    await act(async () => button('保存密钥').click())
    assert.equal(document.querySelector('.speech-settings-modal [role="alert"]')!.textContent, '配置保存失败，请稍后重试')
    assert.equal(document.querySelector('.speech-studio [role="alert"]'), null)
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, 'replacement-test-key')
    assert.equal(writes.length, 1)
    fail = false
    await act(async () => button('保存密钥').click())
    assert.equal(document.querySelector('.speech-settings-modal'), null)
    assert.match(document.querySelector('.speech-notice')!.textContent!, /语音配置已保存/)
    assert.deepEqual(writes, [1, 2].map(() => ({ path: '/api/speech/config', body: { api_key: 'replacement-test-key', enabled: true } })))
    await act(() => button('全局语音配置').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="语音 API Key"]')!.value, '')
    assert.equal(document.querySelector('.speech-settings-modal [role="alert"]'), null)
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

test('placement uses the shot context and preserves the measured audio range after saving', async t => {
  const candidate = { ...take, status: 'succeeded', asset_id: 'audio', url: '/voice.mp3', duration_ms: 1800 }
  const selected = { ...line, selected_asset_id: 'audio', takes: [candidate] }
  const placements: any[] = [], writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (init?.method === 'PUT') { const input = JSON.parse(String(init.body)); writes.push(input); placements.push({ ...input, id: 'placement', line_id: line.id, asset_id: 'audio', stale: false }); return Response.json(placements[0]) }
    return Response.json({ voices: [voice], lines: [selected], placements })
  })
  const view = await mount(async () => {}, () => {}, { shots: [{ id: 'shot', source_scene_id: 'scene', title: '镜头一' } as any], initialShotId: 'shot' })
  try {
    const label = [...document.querySelectorAll('label')].find(node => node.textContent === '相对镜头起点')!
    const input = document.getElementById(label.htmlFor) as HTMLInputElement
    await act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '0.5'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('加入成片').click())
    assert.deepEqual(writes, [{ shot_id: 'shot', offset_ms: 500, in_ms: 0, out_ms: 1800, gain: 1 }])
    assert.match(document.querySelector('.speech-placement-heading')!.textContent!, /已入片/)
    assert.equal(button('更新入片配音').disabled, true)
  } finally { await view.destroy() }
})

test('speech reads and placement updates stay in the chosen final-cut canvas while audio remains shared', async t => {
  const candidate = { ...take, status: 'succeeded', asset_id: 'audio', url: '/voice.mp3', duration_ms: 1800 }
  const selected = { ...line, selected_asset_id: 'audio', takes: [candidate] }
  const calls: Array<{ path: string; method: string; body?: any }> = []
  let placement: any = null
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method || 'GET'
    calls.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (path.endsWith('/config')) return Response.json(config)
    if (method === 'PUT') {
      placement = { ...JSON.parse(String(init!.body)), id: 'new-plan-placement', line_id: line.id, asset_id: 'audio', stale: false }
      return Response.json(placement)
    }
    if (method === 'DELETE') { placement = null; return Response.json({ ok: true }) }
    return Response.json({ voices: [voice], lines: [selected], placements: placement ? [placement] : [] })
  })
  const view = await mount(async () => {}, () => {}, {
    shots: [{ id: 'new-shot', source_scene_id: 'scene', title: '重新规划的镜头' } as any],
    initialShotId: 'new-shot', finalCutCanvasId: 'new-plan',
  })
  try {
    assert.deepEqual(calls.map(item => item.path).sort(), ['/api/projects/project/speech?canvas_id=new-plan', '/api/speech/config'])
    assert.match(document.querySelector('.speech-placement-heading')!.textContent!, /待设置播放位置/)
    await act(async () => button('加入成片').click())
    assert.match(document.querySelector('.speech-placement-heading')!.textContent!, /已入片/)
    await act(async () => button('移出成片').click())
    assert.match(document.querySelector('.speech-placement-heading')!.textContent!, /待设置播放位置/)
    assert.deepEqual(calls.filter(item => item.method !== 'GET'), [
      { path: '/api/projects/project/speech/lines/line/placement?canvas_id=new-plan', method: 'PUT', body: { shot_id: 'new-shot', offset_ms: 0, in_ms: 0, out_ms: 1800, gain: 1 } },
      { path: '/api/projects/project/speech/lines/line/placement?canvas_id=new-plan', method: 'DELETE' },
    ])
    assert.ok(calls.filter(item => item.method === 'GET' && !item.path.endsWith('/config')).every(item => item.path === '/api/projects/project/speech?canvas_id=new-plan'))
    assert.equal(document.querySelector('audio')?.getAttribute('src'), '/voice.mp3', 'the existing audio candidate is still available')
  } finally { await view.destroy() }
})

test('stale selected audio is visible as history and cannot enter the cut', async t => {
  const selected = { ...line, text: '这是新的台词。', selected_asset_id: 'audio', selected_is_stale: true,
    takes: [{ ...take, status: 'succeeded', asset_id: 'audio', duration_ms: 1800, url: '/old.mp3' }] }
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('/config') ? config : { voices: [voice], lines: [selected] }))
  const view = await mount(async () => {}, () => {}, { shots: [{ id: 'shot', title: '镜头一', source_scene_id: 'scene' } as any] })
  try {
    assert.match(document.querySelector('.speech-candidates')!.textContent!, /历史版本/)
    assert.match(document.querySelector('.speech-action-status')!.textContent!, /需要更新/)
    assert.equal(button('加入成片').disabled, true)
    assert.equal(button('生成配音').disabled, false)
  } finally { await view.destroy() }
})

test('bulk generation submits only the checked list and reports skipped lines', async t => {
  const second = { ...line, id: 'second', text: '第二句。' }, writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (String(url).endsWith('/batch/generate')) { writes.push(JSON.parse(String(init?.body))); return Response.json({ results: [{ line_id: line.id, status: 'skipped' }, { line_id: second.id, status: 'generated' }] }) }
    return Response.json({ voices: [voice], lines: [line, second] })
  })
  const view = await mount()
  try {
    await act(() => document.querySelector<HTMLInputElement>('.speech-batch-tools input[type="checkbox"]')!.click())
    await act(async () => button('生成缺失配音').click())
    assert.deepEqual(writes, [{ line_ids: ['line', 'second'] }])
    assert.match(document.querySelector('.speech-notice')!.textContent!, /已提交 1 条，跳过 1 条/)
  } finally { await view.destroy() }
})

test('script sync previews before/after text, cancellation makes no change and confirmation preserves takes', async t => {
  const candidate = { ...take, status: 'succeeded', asset_id: 'audio', url: '/old.mp3', duration_ms: 1800 }
  let current = { ...line, selected_asset_id: 'audio', source_status: 'changed', selected_is_stale: true, takes: [candidate] }
  const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/config')) return Response.json(config)
    if (path.endsWith('/import/preview')) return Response.json({ sync_token: 'current-token', added: 0, updated: 1, removed: 0, preserved: 0,
      changes: [{ kind: 'updated', scene_id: 'scene', role: voice.name, before: line.text, after: '这是剧本改后的台词。' }] })
    if (path.endsWith('/import')) { writes.push(JSON.parse(String(init?.body))); current = { ...current, text: '这是剧本改后的台词。', source_status: 'current' }; return Response.json({}) }
    return Response.json({ voices: [voice], lines: [current] })
  })
  const view = await mount()
  try {
    await act(async () => button('同步本场剧本').click())
    assert.match(document.querySelector('.speech-sync-differences')!.textContent!, /这是旧台词。/)
    assert.match(document.querySelector('.speech-sync-differences')!.textContent!, /这是剧本改后的台词。/)
    await act(() => button('暂不同步').click())
    assert.equal(writes.length, 0)
    await act(async () => button('同步本场剧本').click())
    await act(async () => button('同步并保留历史').click())
    assert.deepEqual(writes, [{ scene_ids: ['scene'], mode: 'sync', sync_token: 'current-token' }])
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="朗读文本"]')!.value, '这是剧本改后的台词。')
    assert.equal(document.querySelectorAll('.speech-take').length, 1)
  } finally { await view.destroy() }
})

test('role detail follows the dialogue voice, preserves edits across roles and saves their original bindings', async t => {
  const second = { ...voice, id: 'actor', name: '林晚', speaker: 'zh_male_m191_uranus_bigtts' }
  let currentVoices = [{ ...voice }, { ...second }]
  const writes: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/config')) return Response.json(config)
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)), id = path.split('/').at(-1)
      writes.push({ path, body }); currentVoices = currentVoices.map(item => item.id === id ? { ...item, ...body } : item)
      return Response.json(currentVoices.find(item => item.id === id))
    }
    return Response.json({ voices: currentVoices, lines: [{ ...line, voice_id: second.id }] })
  })
  const view = await mount()
  try {
    assert.match(document.querySelector('.speech-bound-voice')!.textContent!, /云舟 2.0/)
    assert.equal(document.querySelector('.speech-bound-voice')!.textContent!.includes(second.speaker), false)
    await act(() => button('设置声音').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="角色名称 2"]')!.value, second.name)
    assert.equal(document.querySelector('[aria-label="角色名称 1"]'), null)
    await fill('角色默认表演 2', '低声而坚定。')
    await act(() => button('编辑角色声音 1').click())
    await fill('角色名称 1', '故事旁白')
    await act(() => button('编辑角色声音 2').click())
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="角色默认表演 2"]')!.value, '低声而坚定。')
    await act(async () => button('保存角色声音').click())
    assert.deepEqual(writes.map(item => item.path), ['/api/projects/project/speech/voices/narrator', '/api/projects/project/speech/voices/actor'])
    assert.equal(writes[0].body.name, '故事旁白'); assert.equal(writes[1].body.instructions, '低声而坚定。')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="角色名称 2"]')!.value, second.name)
    assert.equal(button('保存角色声音').disabled, true)
  } finally { await view.destroy() }
})

test('saving a new custom voice retains selection when its temporary id is replaced', async t => {
  let currentVoices = [{ ...voice }]
  const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes.push(body)
      const saved = { ...body, id: 'saved-actor' }; currentVoices.push(saved)
      return Response.json(saved)
    }
    return Response.json({ voices: currentVoices, lines: [line] })
  })
  const view = await mount()
  try {
    await act(() => button('设置声音').click())
    await act(() => button('新增角色').click())
    await fill('角色名称 2', '阿黎')
    await act(() => button('自定义音色').click())
    await fill('Speaker ID 2', 'custom-speaker')
    await act(async () => button('保存角色声音').click())
    assert.equal(writes.length, 1); assert.equal(writes[0].speaker, 'custom-speaker')
    assert.equal(button('编辑角色声音 2').getAttribute('aria-pressed'), 'true')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="角色名称 2"]')!.value, '阿黎')
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Speaker ID 2"]')!.value, 'custom-speaker')
  } finally { await view.destroy() }
})
