import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, Model } from '../src/shared/api/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Manager, ShotCandidateStrip: Strip } = await import('../src/features/canvas/ShotCandidateManager')
after(() => dom.window.close())

const first = { id: 'first', project_id: 'project', shot_id: 'shot', kind: 'image', filename: 'first.png', source: 'generated', model_id: 'image', prompt: '海上船头', remote_url: null, saved: false, created_at: '2026-10-17T10:00:00Z', url: '/first.png' } as Asset
const second = { ...first, id: 'second', filename: 'second.png', url: '/second.png' }
const archived = { ...first, id: 'archived', filename: 'archived.png', url: '/archived.png' }
const video = { ...first, id: 'video', kind: 'video', url: '/video.mp4' } as Asset
const models = [{ id: 'image', name: '图片模型' }] as Model[]
const noop = () => {}
const props = { candidates: [first, second, archived], archivedAssetIds: ['archived'], displayedAssetId: 'first', models, title: '踏上船头', onUse: async (_id: string) => {}, onArchive: async (_id: string, _archived: boolean) => {}, onPreview: (_asset: Asset) => {}, onClose: noop }

async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = (node: React.ReactNode) => act(() => root.render(<MantineProvider env="test">{node}</MantineProvider>))
  try { await render(element) } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(element, label)
  return element
}

test('strip shows only unique active images, marks current use and applies a clicked candidate with duplicate protection', async () => {
  const used: string[] = []
  let resolve!: () => void, managed = 0
  const onUse = (id: string) => { used.push(id); return new Promise<void>(done => { resolve = done }) }
  const view = await mount(<Strip {...props} candidates={[first, second, first, archived, video]} onUse={onUse} onManage={() => managed++} />)
  try {
    assert.equal(view.container.querySelectorAll('.pc-shot-candidate-strip button').length, 2)
    assert.equal(button('使用分镜图候选 1').getAttribute('aria-pressed'), 'true')
    assert.equal(button('使用分镜图候选 1').disabled, true)
    await act(() => { button('使用分镜图候选 2').click(); button('使用分镜图候选 2').click() })
    assert.deepEqual(used, ['second'])
    assert.equal(button('管理候选').disabled, true)
    await act(async () => { resolve() })
    await view.render(<Strip {...props} displayedAssetId="second" onUse={onUse} onManage={() => managed++} />)
    assert.equal(button('使用分镜图候选 2').getAttribute('aria-pressed'), 'true')
    await act(() => button('管理候选').click())
    assert.equal(managed, 1)
  } finally { await view.destroy() }
})

test('strip preserves the current picture after a failed switch and supports retry', async () => {
  let attempts = 0
  const view = await mount(<Strip {...props} onUse={async () => { if (++attempts === 1) throw new Error('图片切换失败') }} onManage={noop} />)
  try {
    await act(async () => { button('使用分镜图候选 2').click() })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /图片切换失败/)
    assert.equal(button('使用分镜图候选 1').getAttribute('aria-pressed'), 'true')
    assert.equal(button('使用分镜图候选 2').disabled, false)
    await act(async () => { button('使用分镜图候选 2').click() })
    assert.equal(attempts, 2)
    assert.equal(document.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})

test('manager selection is read-only until explicitly applied, with preview and guarded closing while saving', async () => {
  const used: string[] = [], previews: string[] = [], busy: boolean[] = []
  let closeCount = 0, resolve!: () => void
  const view = await mount(<Manager {...props} onUse={id => { used.push(id); return new Promise<void>(done => { resolve = done }) }} onPreview={asset => previews.push(asset.id)} onClose={() => closeCount++} onBusyChange={value => busy.push(value)} />)
  try {
    await act(() => button('查看分镜候选图 2').click())
    assert.deepEqual(used, [])
    await act(() => button('放大查看分镜候选图').click())
    assert.deepEqual(previews, ['second'])
    await act(() => { button('设为当前图片').click(); button('设为当前图片').click() })
    assert.deepEqual(used, ['second'])
    assert.deepEqual(busy, [true])
    assert.equal(button('关闭分镜图候选').disabled, true)
    await act(() => document.querySelector('[role="dialog"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(closeCount, 0)
    await act(async () => { resolve() })
    assert.deepEqual(busy, [true, false])
    await act(() => button('关闭分镜图候选').click())
    assert.equal(closeCount, 1)
  } finally { await view.destroy() }
})

test('manager protects current and in-use images, archives other candidates and restores them without use', async () => {
  const archivedCalls: Array<[string, boolean]> = [], uses: string[] = []
  const callbacks = { onUse: async (id: string) => { uses.push(id) }, onArchive: async (id: string, value: boolean) => { archivedCalls.push([id, value]) } }
  const view = await mount(<Manager {...props} {...callbacks} protectedAssetIds={['second']} />)
  try {
    assert.equal(button('归档候选').disabled, true, 'currently displayed image stays active')
    await act(() => button('查看分镜候选图 2').click())
    assert.equal(button('归档候选').disabled, true, 'independently in-use image stays active')
    await view.render(<Manager {...props} {...callbacks} />)
    await act(async () => { button('归档候选').click() })
    assert.deepEqual(archivedCalls, [['second', true]])
    await view.render(<Manager {...props} {...callbacks} archivedAssetIds={['archived', 'second']} />)
    await act(() => button('已归档 · 2').click())
    assert.equal(button('设为当前图片').disabled, true)
    await act(async () => { button('恢复候选').click() })
    assert.deepEqual(archivedCalls, [['second', true], ['second', false]])
    assert.deepEqual(uses, [], 'restoring does not change the node picture')
  } finally { await view.destroy() }
})

test('manager failed archive remains retryable and empty filters are readable', async () => {
  let attempts = 0
  const view = await mount(<Manager {...props} archivedAssetIds={[]} onArchive={async () => { if (++attempts === 1) throw new Error('归档保存失败') }} />)
  try {
    await act(() => button('查看分镜候选图 2').click())
    await act(async () => { button('归档候选').click() })
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /归档保存失败/)
    assert.equal(button('归档候选').disabled, false)
    await act(async () => { button('归档候选').click() })
    assert.equal(attempts, 2)
    await act(() => button('已归档 · 0').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /暂无归档的分镜候选图/)
    assert.equal(document.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})

test('Escape keeps the candidate manager open beneath image preview and closes it when idle', async () => {
  let closed = 0
  const onClose = () => { closed++ }
  const view = await mount(<Manager {...props} previewOpen onClose={onClose} />)
  const escape = async () => act(() => document.querySelector('[role="dialog"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  try {
    await escape()
    assert.equal(closed, 0)
    await view.render(<Manager {...props} onClose={onClose} />)
    await escape()
    assert.equal(closed, 1)
  } finally { await view.destroy() }
})
