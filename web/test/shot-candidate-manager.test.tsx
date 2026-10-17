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
dom.window.HTMLMediaElement.prototype.play = async function () {
  Object.defineProperty(this, 'paused', { configurable: true, value: false })
  this.dispatchEvent(new dom.window.Event('play'))
}
dom.window.HTMLMediaElement.prototype.pause = function () {
  Object.defineProperty(this, 'paused', { configurable: true, value: true })
  this.dispatchEvent(new dom.window.Event('pause'))
}
const { createRoot } = await import('react-dom/client')
const { default: Manager, ShotCandidateStrip: Strip } = await import('../src/features/canvas/ShotCandidateManager')
after(() => dom.window.close())

const first = { id: 'first', project_id: 'project', shot_id: 'shot', kind: 'image', filename: 'first.png', source: 'generated', model_id: 'image', prompt: '海上船头', remote_url: null, saved: false, created_at: '2026-10-17T10:00:00Z', url: '/first.png' } as Asset
const second = { ...first, id: 'second', filename: 'second.png', url: '/second.png' }
const archived = { ...first, id: 'archived', filename: 'archived.png', url: '/archived.png' }
const video = { ...first, id: 'video', kind: 'video', filename: 'video.mp4', model_id: 'video-model', url: '/api/assets/video/file' } as Asset
const videoSecond = { ...video, id: 'video-second', filename: 'video-second.mp4', url: '/api/assets/video-second/file' }
const videoArchived = { ...video, id: 'video-archived', filename: 'video-archived.mp4', url: '/api/assets/video-archived/file' }
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

test('video strip lists only unique active videos as thumbnails and locks switching during generation', async () => {
  const used: string[] = []
  let managed = 0
  const videoProps = { ...props, modality: 'video' as const, candidates: [first, video, videoSecond, video, videoArchived], archivedAssetIds: [videoArchived.id], displayedAssetId: video.id, selectedAssetId: video.id, onUse: async (id: string) => { used.push(id) }, onManage: () => { managed++ } }
  const view = await mount(<Strip {...videoProps} generating />)
  try {
    const strip = view.container.querySelector('[aria-label="视频候选列表"]')!
    assert.equal(strip.querySelectorAll('button').length, 2)
    assert.equal(strip.querySelectorAll('video').length, 0, 'candidate thumbnails do not create active video players')
    assert.equal(strip.querySelector('img')!.getAttribute('src'), '/api/assets/video/preview?size=320')
    assert.match(button('使用视频候选 1').textContent!, /当前使用 · 已入片/)
    assert.equal(button('使用视频候选 2').disabled, true)
    await act(() => { button('使用视频候选 2').click(); button('管理候选').click() })
    assert.deepEqual(used, [])
    assert.equal(managed, 1, 'the manager remains available to inspect existing videos')
    await view.render(<Strip {...videoProps} />)
    await act(async () => { button('使用视频候选 2').click() })
    assert.deepEqual(used, [videoSecond.id])
  } finally { await view.destroy() }
})

test('video manager plays selected candidates and opens an independent preview without changing the node', async () => {
  const used: string[] = [], previews: string[] = []
  const videoProps = { ...props, modality: 'video' as const, candidates: [video, first, videoSecond], archivedAssetIds: [], displayedAssetId: video.id, onUse: async (id: string) => { used.push(id) }, onPreview: (asset: Asset) => { previews.push(asset.id) } }
  const view = await mount(<Manager {...videoProps} />)
  try {
    await act(() => button('查看视频候选 2').click())
    const player = document.querySelector<HTMLVideoElement>('.pc-shot-candidate-video-preview video')!
    assert.equal(player.getAttribute('src'), videoSecond.url)
    assert.equal(player.closest('button'), null, 'interactive player is outside candidate selection buttons')
    assert.equal(document.querySelector('button button'), null)
    assert.deepEqual(used, [], 'inspecting another candidate does not apply it')
    await act(async () => { button('播放素材').click() })
    assert.equal(player.paused, false)
    assert.ok(button('暂停素材'))
    await act(() => button('全屏查看视频候选').click())
    assert.deepEqual(previews, [videoSecond.id])
    await view.render(<Manager {...videoProps} previewOpen />)
    assert.equal(player.paused, true, 'opening a separate preview pauses the manager player')
    assert.equal(document.querySelector('.pc-shot-candidate-video-preview video'), null)
    await view.render(<Manager {...videoProps} />)
    await act(async () => { button('设为当前视频').click() })
    assert.deepEqual(used, [videoSecond.id])
  } finally { await view.destroy() }
})

test('video manager protects the current and final-cut videos, and restores archived videos without applying them', async () => {
  const archives: Array<[string, boolean]> = [], used: string[] = []
  const videoProps = { ...props, modality: 'video' as const, candidates: [video, videoSecond, videoArchived], archivedAssetIds: [videoArchived.id], displayedAssetId: video.id, selectedAssetId: videoSecond.id, onUse: async (id: string) => { used.push(id) }, onArchive: async (id: string, value: boolean) => { archives.push([id, value]) } }
  const view = await mount(<Manager {...videoProps} />)
  try {
    assert.equal(button('归档候选').disabled, true, 'current video cannot be archived')
    await act(() => button('查看视频候选 2').click())
    assert.match(button('查看视频候选 2').textContent!, /已入片/)
    assert.equal(button('归档候选').disabled, true, 'final-cut selection is protected independently of current node')
    await view.render(<Manager {...videoProps} selectedAssetId={null} generating />)
    assert.equal(button('设为当前视频').disabled, true)
    assert.equal(button('归档候选').disabled, true)
    assert.match(document.querySelector('[role="status"]')!.textContent!, /正在生成视频/)
    await act(() => button('已归档 · 1').click())
    assert.equal(button('恢复候选').disabled, true)
    await view.render(<Manager {...videoProps} selectedAssetId={null} />)
    assert.equal(button('设为当前视频').disabled, true, 'archived candidate must first be restored')
    await act(async () => { button('恢复候选').click() })
    assert.deepEqual(archives, [[videoArchived.id, false]])
    assert.deepEqual(used, [])
    await view.render(<Manager {...videoProps} selectedAssetId={null} archivedAssetIds={[]} />)
    await act(() => button('候选视频 · 3').click())
    await act(() => button('查看视频候选 2').click())
    await act(async () => { button('归档候选').click() })
    assert.deepEqual(archives, [[videoArchived.id, false], [videoSecond.id, true]])
  } finally { await view.destroy() }
})
