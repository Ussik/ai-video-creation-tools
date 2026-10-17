import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
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

function project(id: string, name: string): ProjectDetail {
  return { id, name, brief: '', ratio: '16:9', music_asset_id: null, created_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:00:00Z',
    production_range: { start_shot_id: null, end_shot_id: null }, script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
    shots: [], timeline_clips: [], asset_reviews: [], assets: [], jobs: [], asset_tasks: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [] }
}
const fixtures = [project('a', '春日序章'), project('b', '夏日旅途'), project('c', '冬日归来')]
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }) }
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const result = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  assert.ok(result, `button ${label} exists`)
  return result
}
function checkbox(label: string): HTMLInputElement {
  const result = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    || [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.labels?.[0]?.textContent === label)
  assert.ok(result, `checkbox ${label} exists`)
  return result
}
async function click(element: HTMLElement) { await act(async () => element.click()); await settle() }
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索项目"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function mount(t: TestContext) {
  let projects = structuredClone(fixtures), failDelete = false
  const mutations: Array<{ path: string; ids?: string[] }> = [], continuityReads: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (method !== 'GET') {
      assert.equal(path, '/api/projects/batch-delete')
      assert.equal(method, 'POST')
      const { project_ids: ids } = JSON.parse(String(init?.body)) as { project_ids: string[] }
      mutations.push({ path, ids })
      if (failDelete) return Response.json({ detail: '项目「夏日旅途」还有进行中的任务' }, { status: 422 })
      projects = projects.filter(item => !ids.includes(item.id))
      return Response.json({ ok: true, deleted_ids: ids })
    }
    if (path === '/api/projects') return Response.json(projects)
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    const id = /^\/api\/projects\/([^/]+)(?:\/|$)/.exec(path)?.[1]
    if (path.endsWith('/continuity')) {
      continuityReads.push(id!)
      return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: id })
    }
    if (path.endsWith('/canvases')) return Response.json([{ id, project_id: id, name: '画布 1', is_default: true, node_count: 0, viewport: null }])
    if (path.endsWith('/canvas')) return Response.json({ revision: 'test', nodes: [], edges: [] })
    const detail = projects.find(item => item.id === id)
    assert.ok(detail, `unexpected request: ${method} ${path}`)
    return Response.json(detail)
  })
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
  return { container, mutations, continuityReads, failDeletion: () => { failDelete = true },
    allowDeletion: () => { failDelete = false }, cleanup: async () => { await act(async () => root.unmount()); container.remove() } }
}

test('project batch selection supports current-result select all, hidden selections and cancelling without deletion', async t => {
  const view = await mount(t)
  try {
    assert.equal(document.querySelectorAll('.project-card-more').length, 3)
    await click(button('批量管理'))
    assert.equal(button('删除所选项目').disabled, true)
    await click(checkbox('选择项目：春日序章'))
    assert.equal(document.querySelector('.project-card-main')?.getAttribute('aria-pressed'), 'true')
    assert.ok(document.querySelector('.project-page'), 'selecting a card must keep the gallery open')
    await search('夏日')
    assert.equal(document.querySelectorAll('.project-card-main').length, 1)
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 1.*1 个不在当前结果中/)
    await click(checkbox('全选当前结果'))
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 2/)
    await click(checkbox('全选当前结果'))
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 1/)
    assert.equal(checkbox('选择项目：夏日旅途').checked, false, 'deselect current results preserves hidden selections')
    await search('不存在的项目')
    assert.equal(checkbox('全选当前结果').disabled, true)
    await search('')
    assert.equal(checkbox('全选当前结果').indeterminate, true)
    await click(checkbox('全选当前结果'))
    assert.equal(checkbox('全选当前结果').checked, true)
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 3/)
    await click(button('删除所选项目'))
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /删除 3 个项目/)
    assert.deepEqual([...dialog.querySelectorAll('li')].map(item => item.textContent), fixtures.map(item => item.name))
    await click(button('取消', dialog))
    assert.equal(view.mutations.length, 0)
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 3/)
    await click(button('取消批量管理'))
    assert.equal(document.querySelectorAll('.project-card-more').length, 3)
    await click(button('批量管理'))
    assert.match(document.querySelector('.project-batch-count')!.textContent!, /已选 0/)
  } finally { await view.cleanup() }
})

test('confirmed batch deletion sends one request and switches away from a deleted active project', async t => {
  const view = await mount(t)
  try {
    await click(button('批量管理'))
    await click(document.querySelectorAll<HTMLButtonElement>('.project-card-main')[0])
    await click(checkbox('选择项目：夏日旅途'))
    await click(button('删除所选项目'))
    await click(button('确认删除 2 个项目'))
    assert.deepEqual(view.mutations, [{ path: '/api/projects/batch-delete', ids: ['a', 'b'] }])
    assert.deepEqual([...document.querySelectorAll('.project-card-meta strong')].map(item => item.textContent), ['冬日归来'])
    assert.equal(document.querySelector('.project-batch-toolbar'), null)
    assert.equal(view.continuityReads.at(-1), 'c', 'remaining project becomes active')
    assert.match(document.body.textContent!, /已删除 2 个项目/)
  } finally { await view.cleanup() }
})

test('failed batch deletion shows the server reason, retains selection and supports retry without switching the active project', async t => {
  const view = await mount(t)
  try {
    await click(button('批量管理'))
    await click(checkbox('选择项目：夏日旅途'))
    view.failDeletion()
    await click(button('删除所选项目')); await click(button('确认删除 1 个项目'))
    assert.match(document.body.textContent!, /夏日旅途.*进行中的任务/)
    assert.equal(document.querySelectorAll('.project-card-main').length, 3)
    assert.equal(checkbox('选择项目：夏日旅途').checked, true)
    assert.equal(button('删除所选项目').disabled, false)
    const reads = view.continuityReads.length
    view.allowDeletion()
    await click(button('删除所选项目')); await click(button('确认删除 1 个项目'))
    assert.equal(document.querySelectorAll('.project-card-main').length, 2)
    assert.equal(view.continuityReads.length, reads, 'deleting an inactive project must preserve the current detail')
    assert.equal(view.continuityReads.at(-1), 'a')
  } finally { await view.cleanup() }
})

test('deleting all projects leaves a working empty gallery with creation available', async t => {
  const view = await mount(t)
  try {
    await click(button('批量管理')); await click(checkbox('全选当前结果'))
    await click(button('删除所选项目')); await click(button('确认删除 3 个项目'))
    assert.equal(document.querySelectorAll('.project-card-main').length, 0)
    assert.ok(document.querySelector('.project-create'))
    assert.equal(button('批量管理').disabled, true)
    assert.equal(document.querySelector('.project-batch-toolbar'), null)
  } finally { await view.cleanup() }
})

test('cancelling batch mode preserves ordinary card navigation', async t => {
  const view = await mount(t)
  try {
    await click(button('批量管理')); await click(button('取消批量管理'))
    await click(document.querySelector<HTMLButtonElement>('.project-card-main')!)
    assert.equal(document.querySelector('.project-page'), null)
    assert.ok(document.querySelector('.project-canvas'))
    assert.equal(view.mutations.length, 0)
  } finally { await view.cleanup() }
})
