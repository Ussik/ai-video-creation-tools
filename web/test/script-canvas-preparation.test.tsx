import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail, ScriptCanvasResult } from '../src/shared/api/api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const scene = { id: 'scene', episode_number: 1, heading: '车站', duration: 5, characters: '林晚', action: '等车' }
const detail = { id: 'canvas-ui', name: '画布流程', brief: '', ratio: '9:16', script: { outline: '故事大纲', characters: '林晚', scenes: [scene], artifacts: [], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text', provider_id: 'provider', name: '文本模型', remote_id: 'test', modality: 'text', protocol: 'chat_completions', enabled: true, settings: {} } as Model
const provider = { id: 'provider', name: '提供商', enabled: true, adapter: 'http' } as Provider
const result = { scene_ids: ['scene'], shots: [{ id: 'shot', source_scene_id: 'scene' }], visual_profiles: [], shot_visual_bindings: [], created_shots: 1, created_profiles: 0 } as ScriptCanvasResult
const signature = 'a'.repeat(64)
const context = { signature, scenes: [{ ...scene, shot_count: 0, material_count: 0 }], documents: [], skills: [], project: { name: '画布流程', style: '' } }
const draft = { signature, scenes: [{ scene_id: 'scene', scene_heading: '车站', scene_duration: 5, shots: [{ shot_id: null, title: '等车', prompt: '林晚在车站等车', image_prompt: '林晚站在月台', video_prompt: '林晚看向驶来的列车，镜头推近', duration: 5, start_state: '', end_state: '', cut_note: '' }] }], used_skills: [], source_documents: [] }
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); assert.ok(node, text); return node }
async function mount(options: { models?: Model[]; detail?: ProjectDetail; refresh?: () => Promise<void>; close?: () => void; openShotManager?: (sceneIds?: string[]) => void } = {}) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  dom.window.localStorage.setItem('script-director-model:canvas-ui', model.id)
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={options.detail || detail} models={options.models || [model]} providers={[provider]} onRefresh={options.refresh || (async () => {})} onClose={options.close || (() => {})} onOpenModels={() => {}} onOpenShotManager={options.openShotManager} onNotice={() => {}} /></MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
const common = (path: string) => path.endsWith('/skills/defaults') ? Response.json({ policies: [{ stage: 'script', label: '剧本创作', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] }) : path.endsWith('/tools-state') ? Response.json({ draft: null, decisions: [] })
  : path.endsWith('/conversations') ? Response.json({ conversations: [] }) : path.endsWith('/script/source') ? Response.json(null) : null

test('the 规划分镜 entry opens independent planning metadata without a model request or scene-import shortcut', async t => {
  const requests: Array<{ path: string; body: any }> = []; let closed = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), basic = common(path); if (basic) return basic
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    if (path.endsWith('/storyboard/context')) return Response.json(context)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ close: () => closed++ })
  try {
    const production = view.container.querySelector('[aria-label="故事板制作"]')!
    assert.deepEqual([...production.querySelectorAll('button')].map(button => button.textContent?.trim()), ['规划分镜'])
    await act(async () => button('规划分镜').click())
    assert.equal(requests.length, 1)
    assert.ok(requests[0].path.endsWith('/storyboard/context'))
    assert.deepEqual(requests[0].body, { scene_ids: ['scene'] })
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '直接按场次加入'), false)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:canvas-ui'), null)
    assert.equal(closed, 0)
  } finally { await view.destroy() }
})

test('missing storyboards cannot bypass planning when no text model is available', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url), basic = common(path); if (basic) return basic
    paths.push(path)
    if (path.endsWith('/storyboard/context')) return Response.json(context)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ models: [] })
  try {
    await act(async () => button('规划分镜').click())
    assert.equal(paths.length, 1); assert.ok(paths[0].endsWith('/storyboard/context'))
    assert.equal(button('开始规划').disabled, true)
    assert.match(document.body.textContent!, /配置并启用文本模型/)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '直接按场次加入'), false)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:canvas-ui'), null)
  } finally { await view.destroy() }
})

test('the script planning fallback saves independently and retries refresh without another commit', async t => {
  let commits = 0, plans = 0, checks = 0, imports = 0, refreshes = 0, closed = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), basic = common(path); if (basic) return basic
    if (path.endsWith('/storyboard/context')) return Response.json(context)
    if (path.endsWith('/storyboard/preview')) return Response.json({ preview: null })
    if (path.endsWith('/storyboard/plan')) { plans++; return Response.json(draft) }
    if (path.endsWith('/storyboard/commit')) { commits++; assert.equal(JSON.parse(String(init?.body)).save_only, true); return Response.json(result) }
    if (path.endsWith('/script/canvas/check')) {
      checks++; assert.deepEqual(JSON.parse(String(init?.body)), { scene_ids: ['scene'] })
      return Response.json({ signature, scene_ids: ['scene'], needs_analysis: [] })
    }
    if (path.endsWith('/storyboard/canvas')) { imports++; assert.deepEqual(JSON.parse(String(init?.body)), { scene_ids: ['scene'], mode: 'existing' }); return Response.json({ ...result, created_shots: 0 }) }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ close: () => closed++, refresh: async () => { if (++refreshes === 1) throw new Error('刷新失败') } })
  try {
    await act(async () => button('规划分镜').click())
    assert.equal(plans, 0); assert.equal(commits, 0)
    await act(async () => button('开始规划').click())
    assert.equal(plans, 1); assert.equal(commits, 0)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:canvas-ui'), null)
    await act(async () => button('保存分镜方案').click())
    assert.match(document.body.textContent!, /刷新失败/); assert.equal(closed, 0)
    await act(async () => button('重试刷新').click())
    assert.equal(commits, 1); assert.equal(closed, 0, 'saving the fallback planner keeps the script editor open')
    assert.equal(checks, 0); assert.equal(imports, 0); assert.equal(refreshes, 2)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:canvas-ui'), null)
  } finally { await view.destroy() }
})


test('script planning opens the shared shot manager with its scene scope when the integration callback is provided', async t => {
  const scopes: Array<string[] | undefined> = [], unexpected: string[] = []
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url), basic = common(path); if (basic) return basic
    unexpected.push(path); throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openShotManager: ids => scopes.push(ids) })
  try {
    await act(() => button('规划分镜').click())
    assert.deepEqual(scopes, [['scene']])
    assert.deepEqual(unexpected, [])
    assert.equal(document.querySelector('.storyboard-planner'), null)
  } finally { await view.destroy() }
})
