import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { EditingCut } from '@video-studio/shared/media/editing-cut'
import { fixture } from './fixtures/final-cut'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver', 'HTMLMediaElement', 'FormData', 'File']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: dom.window.sessionStorage })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLMediaElement.prototype.pause = () => {}
dom.window.HTMLMediaElement.prototype.load = () => {}
dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve()
const { createRoot } = await import('react-dom/client')
const { default: BasicFinalCutStudio } = await import('../src/features/final-cut/BasicFinalCutStudio')
const { editingCutPreview, editingCutIssues } = await import('../src/features/final-cut/editing-cut-preview')
after(() => dom.window.close())

async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
function button(text: string, root: ParentNode = document) {
  const node = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
  assert.ok(node, `button ${text} exists`); return node
}
async function click(text: string) { await act(() => button(text).click()); await settle() }
function field(label: string) {
  const direct = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (direct) return direct
  const node = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.trim() === label)
  assert.ok(node, label); const input = document.getElementById(node.htmlFor) as HTMLInputElement; assert.ok(input, label); return input
}
async function fill(label: string, value: string) {
  const input = field(label), proto = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) }); await settle()
}
async function choose(label: string, value: string) {
  const input = field(label)
  await act(() => input.click()); await settle()
  const list = document.getElementById(input.getAttribute('aria-controls') || '') || document
  const option = list.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)
  assert.ok(option, `${label} option ${value}`); await act(() => option.click()); await settle()
}

function data() {
  const { detail } = fixture()
  const audio = (id: string) => ({ ...detail.assets[0], id, shot_id: null, filename: `${id}.mp3`, kind: 'audio' as const, url: `/${id}.mp3` })
  detail.assets.push(audio('voice1'), audio('voice2'), audio('music'))
  detail.speech = { voices: [{ id: 'narrator', name: '旁白', speaker: 'speaker', instructions: '', speech_rate: 0 }], placements: [], lines: [{ id: 'original-line', project_id: detail.id, voice_id: 'narrator', scene_id: null, position: 0,
    text: '正式剧本台词', instructions: '', context_text: '', selected_asset_id: 'voice1', created_at: detail.created_at, updated_at: detail.updated_at,
    takes: ['voice1', 'voice2'].map(id => ({ id: `take-${id}`, asset_id: id, line_id: 'original-line', job_id: null, status: 'succeeded' as const,
      error: null, text: '正式剧本台词', speaker: '', instructions: '', context_text: '', speech_rate: 0, created_at: detail.created_at,
      url: `/${id}.mp3`, filename: `${id}.mp3`, duration_ms: id === 'voice1' ? 2000 : 2500 })) }] }
  const base: EditingCut = { id: 'cut-a', project_id: detail.id, name: '预告A', source_canvas_id: null, revision: 1,
    ratio: '16:9', clips: [{ id: 'part1', asset_id: 'video', title: '开场', in_ms: 1000, out_ms: 5000, source_audio_gain: .55, source_audio_fade_ms: 15 },
      { id: 'part2', asset_id: 'still', title: '片名', in_ms: 0, out_ms: 3000, source_audio_gain: 1, source_audio_fade_ms: 0 }],
    speech: [{ id: 'narration', asset_id: 'voice1', label: '原旁白', start_ms: 0, in_ms: 0, out_ms: 2000, gain: 1 }],
    music_asset_id: null, audio_settings: { music_gain: .24, duck_music: true, duck_source: true },
    captions: [{ id: 'caption', start_ms: 0, end_ms: 2000, text: '预告字幕' }], created_at: detail.created_at, updated_at: detail.updated_at }
  return { detail, cuts: [base, { ...structuredClone(base), id: 'cut-b', name: '预告B', clips: [structuredClone(base.clips[1])], speech: [], captions: [] }],
    requests: [] as Array<{ path: string; method: string; body: any }>, conflict: false, failExport: false }
}

async function mount(t: import('node:test').TestContext, source = data()) {
  sessionStorage.clear()
  const before = structuredClone(source.detail), container = document.createElement('div'); document.body.append(container)
  const calls: boolean[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method || 'GET'
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : null
    source.requests.push({ path, method, body })
    if (path.endsWith('/editing-cuts') && method === 'GET') return Response.json({ cuts: source.cuts })
    if (path.endsWith('/editing-cuts') && method === 'POST') {
      const cut = { ...structuredClone(source.cuts[1]), id: 'new-cut', name: body.name, revision: 1, clips: [], captions: [], speech: [] }
      source.cuts.unshift(cut); return Response.json(cut)
    }
    if (path.includes('/editing-cuts/') && method === 'PUT') {
      if (source.conflict) return Response.json({ detail: '剪辑已在别处更新，请保留草稿后重新读取' }, { status: 409 })
      const id = path.split('/').at(-1), old = source.cuts.find(cut => cut.id === id)!
      assert.equal(body.revision, old.revision)
      const next = { ...old, ...body, revision: old.revision + 1 }; source.cuts = source.cuts.map(cut => cut.id === id ? next : cut)
      return Response.json(next)
    }
    if (path.endsWith('/metadata')) return Response.json({ duration_ms: 6000 })
    if (path.endsWith('/assets') && method === 'POST') return Response.json({ ...source.detail.assets[0], id: 'uploaded', shot_id: null,
      kind: 'video', filename: '新片段.mp4', source: 'upload', url: '/uploaded.mp4' })
    if (path.endsWith('/export')) return Response.json({ id: 'new-export', project_id: source.detail.id, job_type: 'export',
      request: JSON.stringify({ editing_cut_id: path.split('/').at(-2), editing_cut_revision: body.revision }),
      status: source.failExport ? 'failed' : 'queued', error: source.failExport ? '素材无法解码' : null, created_at: new Date().toISOString() })
    throw new Error(`Unexpected API: ${method} ${path}`)
  })
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><BasicFinalCutStudio detail={source.detail} onRefresh={async () => {}}
    onOpenSpeech={() => {}} onNotice={() => {}} onDirtyChange={dirty => calls.push(dirty)} /></MantineProvider>)); await settle()
  return { source, container, before, calls, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('opening reads independent cuts only, then duplicate/reorder/trim saves without changing originals', async t => {
  const view = await mount(t)
  try {
    assert.deepEqual(view.source.requests.map(x => [x.method, x.path]), [['GET', `/api/projects/${view.source.detail.id}/editing-cuts`]])
    await click('复制片段 1'); await fill('素材出点', '3.5'); await click('后移片段 2')
    assert.ok(view.container.textContent?.includes('有未保存修改'))
    await click('保存剪辑')
    const body = view.source.requests.find(x => x.method === 'PUT')!.body
    assert.equal(body.clips.length, 3); assert.equal(body.clips[0].asset_id, body.clips[2].asset_id)
    assert.notEqual(body.clips[0].id, body.clips[2].id); assert.equal(body.clips[2].out_ms, 3500)
    assert.equal(body.clips[0].out_ms, 5000); assert.deepEqual(view.source.detail, view.before)
    assert.ok(view.source.requests.filter(x => x.method !== 'GET').every(x => x.path.includes('/editing-cuts/')))
    assert.ok(view.calls.includes(true)); assert.equal(view.calls.at(-1), false)
  } finally { await view.destroy() }
})

test('switching a dirty cut offers cancel/save/discard and cancel preserves the draft', async t => {
  const view = await mount(t)
  try {
    await fill('剪辑名称', 'A的未保存修改'); await choose('选择独立剪辑', 'cut-b')
    assert.ok(document.body.textContent?.includes('当前剪辑有未保存修改')); await click('继续编辑')
    assert.equal(field('剪辑名称').value, 'A的未保存修改')
    await choose('选择独立剪辑', 'cut-b'); await click('保存后继续')
    assert.equal(field('剪辑名称').value, '预告B'); assert.equal(view.source.cuts.find(cut => cut.id === 'cut-a')!.name, 'A的未保存修改')
    await fill('剪辑名称', 'B的未保存修改'); await choose('选择独立剪辑', 'cut-a'); await click('放弃修改并继续')
    assert.equal(field('剪辑名称').value, 'A的未保存修改'); assert.equal(view.source.cuts.find(cut => cut.id === 'cut-b')!.name, '预告B')
  } finally { await view.destroy() }
})

test('CAS conflict keeps the local draft and can save it into a new independent cut', async t => {
  const view = await mount(t)
  try {
    await fill('剪辑名称', '不应丢失的草稿'); view.source.conflict = true; await click('保存剪辑')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /已在别处更新/)
    assert.equal(field('剪辑名称').value, '不应丢失的草稿')
    assert.ok(sessionStorage.getItem(`editing-cut-draft:${view.source.detail.id}:cut-a`)?.includes('不应丢失'))
    view.source.conflict = false; await click('另存为新剪辑'); await fill('新剪辑名称', '保留副本'); await click('创建剪辑')
    assert.equal(field('剪辑名称').value, '保留副本'); assert.equal(view.source.cuts.find(cut => cut.id === 'cut-a')!.name, '预告A')
    assert.equal(view.source.cuts.find(cut => cut.id === 'new-cut')!.clips.length, 2)
  } finally { await view.destroy() }
})

test('audio replacement, mix and subtitles belong to the cut and leave speech selection untouched', async t => {
  const view = await mount(t)
  try {
    await click('配音'); await choose('替换配音素材', 'voice2')
    assert.equal(field('替换配音素材').value, '正式剧本台词 · 旁白 · 候选 2')
    assert.equal(field('音频出点').value, '2.5 秒')
    await fill('成片开始位置', '2'); await fill('配音音量', '125')
    await fill('配音标注／字幕正文', '师兄，我想带你回家。'); await click('用此配音创建字幕')
    await fill('字幕 2 开始', '2.2'); await fill('字幕 2 结束', '4.7')
    await click('配乐'); await choose('配乐素材', 'music'); await fill('配乐音量', '35')
    await click('保存剪辑')
    const body = view.source.requests.find(x => x.method === 'PUT')!.body
    assert.equal(body.speech[0].asset_id, 'voice2'); assert.equal(body.speech[0].start_ms, 2000); assert.equal(body.speech[0].out_ms, 2500)
    assert.equal(body.speech[0].gain, 1.25); assert.equal(body.music_asset_id, 'music'); assert.equal(body.audio_settings.music_gain, .35)
    assert.equal(body.captions[1].text, '师兄，我想带你回家。'); assert.equal(body.captions[1].start_ms, 2200)
    assert.deepEqual(view.source.detail, view.before); assert.ok(!view.source.requests.some(x => /\/speech\/|audio-settings|\/shots\//.test(x.path)))
  } finally { await view.destroy() }
})

test('speech assets show searchable dialogue, voice and candidate names instead of storage filenames', async t => {
  const view = await mount(t)
  try {
    assert.ok(button('预览素材：正式剧本台词 · 旁白 · 候选 1'))
    assert.ok(button('预览素材：正式剧本台词 · 旁白 · 候选 2'))
    await fill('搜索剪辑素材', '旁白 · 候选 2')
    const library = view.container.querySelector('[aria-label="剪辑素材库"]')!
    assert.equal(library.querySelectorAll('.basic-cut-asset').length, 1)
    assert.ok(library.textContent?.includes('正式剧本台词 · 旁白 · 候选 2'))
    await fill('搜索剪辑素材', 'voice1.mp3')
    assert.equal(library.querySelectorAll('.basic-cut-asset').length, 1)
    assert.ok(library.textContent?.includes('候选 1'))
  } finally { await view.destroy() }
})

test('browser container duration cannot reject a valid saved speech boundary', async t => {
  const view = await mount(t)
  try {
    await click('配音')
    const audio = view.container.querySelector<HTMLAudioElement>('audio[src="/voice1.mp3"]')!
    assert.ok(audio)
    Object.defineProperty(audio, 'duration', { configurable: true, value: 1.95 })
    await act(() => audio.dispatchEvent(new dom.window.Event('loadedmetadata')))
    await fill('配音标注／字幕正文', '保留按解码时长保存的完整音频')
    assert.equal(button('保存剪辑').disabled, false)
    await click('保存剪辑')
    assert.equal(view.source.requests.find(item => item.method === 'PUT')!.body.speech[0].out_ms, 2000)
  } finally { await view.destroy() }
})

test('uploads add project assets without a shot association; imported video can enter the cut', async t => {
  const view = await mount(t)
  try {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new dom.window.File(['video bytes'], '新片段.mp4', { type: 'video/mp4' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))); await settle()
    const upload = view.source.requests.find(x => x.path.endsWith('/assets'))!
    assert.ok(upload.body instanceof FormData); assert.equal(upload.body.get('shot_id'), null)
    assert.ok(view.container.textContent?.includes('新片段.mp4'))
    await click('添加到末尾'); await click('保存剪辑')
    const body = view.source.requests.find(x => x.method === 'PUT')!.body
    assert.equal(body.clips.at(-1).asset_id, 'uploaded'); assert.equal(body.clips.at(-1).out_ms, 6000)
  } finally { await view.destroy() }
})

test('export saves the exact edited revision first and surfaces a failed job', async t => {
  const view = await mount(t)
  try {
    view.source.failExport = true; await fill('素材出点', '4.5'); await click('保存并导出')
    const mutations = view.source.requests.filter(x => x.method !== 'GET')
    assert.deepEqual(mutations.map(x => x.method), ['PUT', 'POST'])
    assert.equal(mutations[1].body.revision, 2); assert.ok(mutations[1].path.endsWith('/editing-cuts/cut-a/export'))
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /素材无法解码/)
    assert.equal(button('重试导出').disabled, false)
  } finally { await view.destroy() }
})

test('download identifies its exported revision and stays available after unsaved and saved edits', async t => {
  const source = data()
  source.detail.assets.push({ ...source.detail.assets[0], id: 'export-a', shot_id: null, kind: 'video', filename: '预告A.mp4', url: '/export-a.mp4' })
  source.detail.jobs.push({ id: 'export-job-a', project_id: source.detail.id, shot_id: null, model_id: null, job_type: 'export',
    request: JSON.stringify({ editing_cut_id: 'cut-a', editing_cut_revision: 1 }), status: 'succeeded', external_id: null,
    result_asset_id: 'export-a', recovery_available: false, error: null, created_at: source.detail.created_at })
  const view = await mount(t, source)
  try {
    const download = () => view.container.querySelector<HTMLAnchorElement>('.basic-cut-download a')
    assert.match(view.container.querySelector('.basic-cut-download')!.textContent!, /本剪辑当前成片（v1）/)
    assert.equal(download()!.getAttribute('href'), '/export-a.mp4')
    await fill('剪辑名称', '预告A修改稿')
    assert.match(view.container.querySelector('.basic-cut-download')!.textContent!, /较早版本成片.*请导出当前修改.*v1/)
    assert.equal(download()!.getAttribute('href'), '/export-a.mp4')
    await click('保存剪辑')
    assert.equal(source.cuts[0].revision, 2)
    assert.match(view.container.querySelector('.basic-cut-download')!.textContent!, /较早版本成片.*请导出当前修改.*v1/)
    assert.equal(download()!.getAttribute('href'), '/export-a.mp4')
    await choose('选择独立剪辑', 'cut-b')
    assert.equal(download(), null)
  } finally { await view.destroy() }
})

test('preview supports repeated assets and draft audio beyond picture is saved but blocks export', () => {
  const { detail, cuts } = data(), cut = structuredClone(cuts[0])
  cut.clips.push({ ...cut.clips[0], id: 'another-use', in_ms: 2000, out_ms: 4000 })
  const preview = editingCutPreview(cut, detail.assets)
  assert.equal(new Set(preview.shots.map(x => x.id)).size, 3)
  assert.equal(preview.clips[0].asset_id, preview.clips[2].asset_id)
  const stillCut = { ...cut, clips: [{ ...cut.clips[1], out_ms: 90000 }], speech: [], captions: [] }
  assert.deepEqual(editingCutIssues(stillCut, detail.assets, new Map(), true), [])
  cut.speech[0].start_ms = 30000
  assert.deepEqual(editingCutIssues(cut, detail.assets, new Map()), [])
  assert.match(editingCutIssues(cut, detail.assets, new Map(), true)[0], /配音.*超出成片/)
  cut.speech = []; cut.captions[0].text = '这是需要拆成多条的长字幕'.repeat(20)
  assert.ok(editingCutIssues(cut, detail.assets, new Map(), true).some(x => x.includes('超过 4 行')))
})

test('caption preview renders shared line wrapping at the current timeline position', async t => {
  const source = data(); source.cuts[0].captions[0].text = '这是超过一行长度的中文字幕，用来验证预览与成片共同采用相同的自动换行逻辑。'
  const view = await mount(t, source)
  try {
    const caption = view.container.querySelector('.timeline-preview-caption')!
    assert.ok(caption); assert.ok(caption.textContent?.includes('\n'))
    assert.match(caption.textContent!, /中文字幕/)
  } finally { await view.destroy() }
})
