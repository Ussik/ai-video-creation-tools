import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: CanvasDeletionDialog } = await import('../src/features/canvas/CanvasDeletionDialog')
const { default: ProjectCanvasSwitcher } = await import('../src/features/canvas/ProjectCanvasSwitcher')
after(() => dom.window.close())

const canvas = { id: 'canvas-a', project_id: 'project', name: '预告方案', is_default: true, node_count: 3, viewport: null }
const other = { ...canvas, id: 'canvas-b', name: '其他画布', is_default: false }
function preview(version = 'a') {
  return { revision: version.repeat(64), cleanup_revision: version.repeat(64), node_count: 3, edge_count: 2,
    exclusive_shots: [{ id: 'shot-a', title: '旧面初鸣' }], exclusive_assets: [{ id: 'candidate', filename: '未保存候选.mp4' }],
    protected_asset_count: 4, running_job_count: 1 }
}
async function settle() {
  await act(async () => { for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(i * 16))
  } })
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  assert.ok(node, `button ${label}`); return node
}
async function click(label: string) { await act(() => button(label).click()); await settle() }
async function checkbox(index: number) {
  const node = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]
  assert.ok(node); await act(() => node.click()); await settle()
}
async function mount(t: import('node:test').TestContext, options: { conflict?: boolean; failPreview?: boolean } = {}) {
  const requests: Array<{ path: string; method: string; body: any }> = []
  const deleted: unknown[] = []
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ path, method, body })
    if (method === 'GET') {
      reads++
      return options.failPreview ? Response.json({ detail: '读取失败' }, { status: 500 }) : Response.json(preview(reads > 1 ? 'b' : 'a'))
    }
    if (method === 'DELETE') {
      if (options.conflict && requests.filter(request => request.method === 'DELETE').length === 1) return Response.json({ detail: '引用已更新' }, { status: 409 })
      return Response.json({ canvas_id: 'canvas-b' })
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider><CanvasDeletionDialog projectId="project" canvas={canvas} onClose={() => {}} onDeleted={result => deleted.push(result)} /></MantineProvider>))
  await settle()
  t.after(async () => { await act(() => root.unmount()); container.remove(); t.mock.restoreAll() })
  return { requests, deleted }
}

test('deleting a canvas preserves related content by default and reports protected content', async t => {
  const state = await mount(t)
  assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 0)
  assert.match(document.body.textContent || '', /4 个受保护素材将保留/)
  assert.match(document.body.textContent || '', /1 个生成任务仍在运行/)
  assert.match(document.body.textContent || '', /旧面初鸣/)
  await click('删除画布')
  const request = state.requests.find(item => item.method === 'DELETE')!
  assert.equal(request.path, '/api/projects/project/canvases/canvas-a')
  assert.deepEqual(request.body, { revision: 'a'.repeat(64), cleanup_revision: 'a'.repeat(64), cleanup_shots: false, cleanup_assets: false })
  assert.deepEqual(state.deleted, [{ canvas_id: 'canvas-b' }])
})

test('explicit cleanup choices include both revisions and never remove candidate files directly', async t => {
  const state = await mount(t)
  await checkbox(0); await checkbox(1)
  await click('删除画布')
  assert.deepEqual(state.requests.find(item => item.method === 'DELETE')!.body, {
    revision: 'a'.repeat(64), cleanup_revision: 'a'.repeat(64), cleanup_shots: true, cleanup_assets: true,
  })
  assert.equal(state.requests.length, 2)
})

test('conflicting references refresh the impact and require a new explicit confirmation', async t => {
  const state = await mount(t, { conflict: true })
  await checkbox(0); await checkbox(1)
  await click('删除画布')
  assert.equal(state.requests.filter(item => item.method === 'DELETE').length, 1)
  assert.equal(state.requests.filter(item => item.method === 'GET').length, 2)
  assert.equal(state.deleted.length, 0)
  assert.equal(document.querySelectorAll('input[type="checkbox"]:checked').length, 0)
  assert.match(document.body.textContent || '', /请重新选择清理项并确认/)
  await click('删除画布')
  assert.deepEqual(state.requests.filter(item => item.method === 'DELETE')[1].body, {
    revision: 'b'.repeat(64), cleanup_revision: 'b'.repeat(64), cleanup_shots: false, cleanup_assets: false,
  })
  assert.equal(state.deleted.length, 1)
})

test('failed impact check blocks deletion and offers a read-only retry', async t => {
  const state = await mount(t, { failPreview: true })
  assert.equal(button('删除画布').disabled, true)
  assert.match(document.body.textContent || '', /读取失败/)
  await click('重新检查')
  assert.equal(state.requests.length, 2)
  assert.ok(state.requests.every(item => item.method === 'GET'))
})

test('canvas switcher waits for saved edits before checking impact and refreshes resources after deletion', async t => {
  const events: string[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let removed = false
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), method = init?.method || 'GET'
    events.push(`${method} ${path}`)
    if (path.endsWith('/deletion-preview')) return Response.json(preview())
    if (method === 'DELETE') { removed = true; return Response.json({ canvas_id: other.id }) }
    if (path.endsWith('/canvases')) return Response.json(removed ? [other] : [canvas, other])
    throw new Error(`Unexpected API ${method} ${path}`)
  })
  const actions = { revision: () => 'a'.repeat(64), leave: async () => { events.push('save edits'); return true }, move: async () => true }
  await act(() => root.render(<MantineProvider><ProjectCanvasSwitcher projectId="project" onResourcesChanged={async () => { events.push('refresh resources') }}>{(active, _session, menu, register) => {
    register(actions)
    return <div key={active.id} data-active-canvas={active.id}><span>{active.name}</span>{menu}</div>
  }}</ProjectCanvasSwitcher></MantineProvider>))
  await settle()
  t.after(async () => { await act(() => root.unmount()); container.remove(); t.mock.restoreAll() })
  await click('切换画布'); await click('删除当前画布')
  assert.ok(events.indexOf('save edits') < events.findIndex(event => event.endsWith('/deletion-preview')))
  assert.equal(button('切换画布').disabled, true)
  await click('删除画布')
  assert.ok(events.includes('refresh resources'))
  assert.equal(button('切换画布').disabled, false)
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.match(button('切换画布').textContent || '', /其他画布/)
  assert.equal(document.querySelectorAll('[data-active-canvas]').length, 1, 'deletion must unmount the old keyed canvas')
  assert.equal(document.querySelector('[data-active-canvas]')?.getAttribute('data-active-canvas'), other.id)
})

test('external imports invalidate only the target inactive canvas session and reload metadata', async t => {
  dom.window.localStorage.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const sessions = new Map<string, { revision?: string; history: { past: unknown[]; future: unknown[] }; selection?: unknown }>()
  let reads = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), '/api/projects/project/canvases'); reads++
    return Response.json([canvas, other])
  })
  const actions = { revision: () => 'a'.repeat(64), leave: async () => true, move: async () => true }
  await act(() => root.render(<MantineProvider><ProjectCanvasSwitcher projectId="project">{(active, session, menu, register) => {
    sessions.set(active.id, session); register(actions); return menu
  }}</ProjectCanvasSwitcher></MantineProvider>))
  await settle()
  t.after(async () => { await act(() => root.unmount()); container.remove(); t.mock.restoreAll() })
  await click('切换画布'); await click('其他画布')
  const inactive = sessions.get(other.id)!
  inactive.revision = 'old'
  inactive.history.past.push({})
  inactive.selection = { nodeId: 'old-node' }
  await click('切换画布'); await click('预告方案')
  const activeSession = sessions.get(canvas.id)!
  activeSession.revision = 'active-revision'
  activeSession.history.past.push({ active: true })
  await act(() => window.dispatchEvent(new dom.window.CustomEvent('project-canvas-resources-changed', { detail: { projectId: 'other-project', canvasId: other.id } })))
  await settle()
  assert.equal(reads, 1)
  await act(() => window.dispatchEvent(new dom.window.CustomEvent('project-canvas-resources-changed', { detail: { projectId: 'project', canvasId: other.id } })))
  await settle()
  assert.equal(reads, 2)
  assert.equal(inactive.revision, undefined)
  assert.deepEqual(inactive.history, { past: [], future: [] })
  assert.equal(inactive.selection, undefined)
  assert.equal(activeSession.revision, 'active-revision')
  assert.equal(activeSession.history.past.length, 1)
})
