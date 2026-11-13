import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, ProjectDetail } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.assign(dom.window, { ResizeObserver: ResizeObserverStub })
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/app/App')
after(() => dom.window.close())

const originalAsset: Asset = { id: 'asset-one', project_id: 'project-one', shot_id: null, kind: 'image', filename: '面具.png', source: 'generated', model_id: null, prompt: null, remote_url: null, saved: true, created_at: '2026-11-08T00:00:00Z', url: '/api/assets/asset-one/file' }
function fixture(): ProjectDetail {
  return { id: 'project-one', name: '傩王', brief: '', ratio: '16:9', music_asset_id: null, created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z',
    production_range: { start_shot_id: null, end_shot_id: null }, script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
    shots: [], timeline_clips: [], asset_reviews: [], assets: [{ ...originalAsset }], jobs: [], asset_tasks: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [] }
}
async function settle() { await act(async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }) }
function button(label: string, scope: ParentNode = document) {
  const control = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  assert.ok(control, `button ${label} exists`)
  return control
}
function nameInput() {
  const label = [...document.querySelectorAll('label')].find(item => item.textContent?.startsWith('素材名称'))
  assert.ok(label?.htmlFor, 'name input label exists')
  return document.getElementById(label.htmlFor) as HTMLInputElement
}
async function click(control: HTMLElement) { assert.ok(control); await act(async () => control.click()); await settle() }
async function fill(control: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(control, value)
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function mount(t: TestContext) {
  const detail = fixture(), mutations: Array<{ path: string; payload: unknown }> = []
  const polls: Array<() => unknown> = []
  let delayNextDetail = false, staleReply: (() => void) | undefined, detailReads = 0
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window)
  t.mock.method(dom.window, 'setTimeout', (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 4000 && typeof handler === 'function') { polls.push(() => handler(...args)); return 1_000_000 + polls.length }
    return nativeSetTimeout(handler, timeout, ...args)
  })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (method !== 'GET') {
      assert.equal(method, 'PATCH'); assert.equal(path, '/api/assets/asset-one')
      const payload = JSON.parse(String(init?.body)) as { display_name: string }
      mutations.push({ path, payload })
      detail.assets[0] = { ...detail.assets[0], display_name: payload.display_name }
      return Response.json(detail.assets[0])
    }
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/providers' || path === '/api/models' || path.endsWith('/canvases')) return Response.json([])
    assert.equal(path, '/api/projects/project-one', `unexpected request ${path}`)
    detailReads++
    if (delayNextDetail) {
      delayNextDetail = false
      const beforeRename = structuredClone(detail)
      return new Promise<Response>(resolve => { staleReply = () => resolve(Response.json(beforeRename)) })
    }
    return Response.json(detail)
  })
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
  await click(container.querySelector<HTMLElement>('[aria-label="资产"]')!)
  await click(button('个人资产库1'))
  return { container, mutations, get detailReads() { return detailReads },
    async beginStalePoll() {
      const poll = polls.shift(); assert.ok(poll, 'background project poll is scheduled')
      delayNextDetail = true
      await act(async () => { void poll(); for (let index = 0; index < 8; index++) await Promise.resolve() })
      assert.ok(staleReply, 'the old project snapshot is held in flight')
    },
    async releaseStalePoll() { assert.ok(staleReply); await act(async () => staleReply!()); await settle() },
    async cleanup() { await act(async () => root.unmount()); container.remove() },
  }
}

test('library card rename sends the persisted name, stays searchable and ignores a late pre-save poll', async t => {
  const view = await mount(t)
  try {
    assert.equal(document.querySelector('.library-asset-title')?.textContent, '面具.png')
    await view.beginStalePoll()
    await click(document.querySelector<HTMLElement>('[aria-label="素材操作：面具.png"]')!)
    await click(button('重命名'))
    await fill(nameInput(), '  九霄雷面具正面  ')
    const readsBeforeSave = view.detailReads
    await click(button('保存'))
    assert.deepEqual(view.mutations, [{ path: '/api/assets/asset-one', payload: { display_name: '九霄雷面具正面' } }])
    assert.ok(view.detailReads > readsBeforeSave, 'saving supersedes the old poll with a fresh snapshot request')
    assert.equal(document.querySelector('.library-asset-title')?.textContent, '九霄雷面具正面')
    await view.releaseStalePoll()
    assert.equal(document.querySelector('.library-asset-title')?.textContent, '九霄雷面具正面', 'late stale response cannot revert the saved name')
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索素材"]')!
    assert.ok(search)
    await fill(search, '九霄雷')
    assert.equal(document.querySelectorAll('.library-item').length, 1)
    assert.equal(document.querySelector('.library-asset-title')?.textContent, '九霄雷面具正面')
    await fill(search, '不存在的名字')
    assert.equal(document.querySelectorAll('.library-item').length, 0)
  } finally { await view.cleanup() }
})

test('Escape dismisses only the rename opened from a preview and leaves its original material visible', async t => {
  const view = await mount(t)
  try {
    await click(document.querySelector<HTMLElement>('[aria-label="预览 面具.png"]')!)
    assert.ok(document.querySelector('.asset-preview-modal'))
    await click(button('重命名', document.querySelector('.asset-preview-actions')!))
    await fill(nameInput(), '尚未保存的面具名称')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
    await act(() => nameInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle()
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    assert.ok(document.querySelector('.asset-preview-modal'), 'cancelling a rename must preserve the open preview')
    assert.equal(document.querySelector('.mantine-Modal-title')?.textContent, '面具.png')
    assert.equal(document.querySelector('.library-asset-title')?.textContent, '面具.png')
    assert.equal(view.mutations.length, 0)
  } finally { await view.cleanup() }
})
