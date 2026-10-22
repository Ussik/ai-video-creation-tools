import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { Asset } from '../src/shared/api/api'
import type { CanvasReferenceItem, CanvasReferenceListProps } from '../src/features/canvas/CanvasReferenceList'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const { createRoot } = await import('react-dom/client')
const { default: ReferenceList } = await import('../src/features/canvas/CanvasReferenceList')
after(() => dom.window.close())

const asset = (id: string) => ({ id, kind: 'image', url: `/${id}.png` } as Asset)
const base: CanvasReferenceItem = { assetId: 'base-private-id', asset: asset('base-private-id'), name: '姜望 · 落泥前', source: 'base', version: '第 2 版' }
const extra: CanvasReferenceItem = { assetId: 'extra-private-id', asset: asset('extra-private-id'), name: '渡口色彩参考', source: 'asset' }
async function mount(initial: CanvasReferenceListProps) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (props: CanvasReferenceListProps) => { await act(() => root.render(<MantineProvider env="test"><ReferenceList {...props} /></MantineProvider>)) }
  await render(initial)
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(found, `missing button: ${label}`); return found
  }
  return { container, render, button, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('reference rows explain their source, purpose and version while protecting the inherited base', async () => {
  const previewed: string[] = [], located: string[] = [], removed: string[] = []
  const view = await mount({ items: [base, extra, { ...extra, assetId: 'profile-private-id', asset: asset('profile-private-id'), name: '渡口场景设定', source: 'profile' }],
    onPreview: item => previewed.push(item.assetId), onLocate: item => located.push(item.assetId), onRemove: item => removed.push(item.assetId) })
  try {
    assert.ok(view.container.querySelector('[aria-label="本次生成将使用的参考"]'))
    assert.match(view.container.textContent!, /基础继承 · 保持身份 · 第 2 版/)
    assert.match(view.container.textContent!, /素材库 · 补充参考/)
    assert.match(view.container.textContent!, /设定库 · 补充参考/)
    assert.match(view.container.textContent!, /必需/)
    assert.equal(view.container.querySelector('button[aria-label="移除参考：姜望 · 落泥前"]'), null, 'the base source is required even if the caller omitted its required flag')
    await act(() => view.button('预览参考图：姜望 · 落泥前').click())
    await act(() => view.button('定位：姜望 · 落泥前').click())
    await act(() => view.button('移除参考：渡口色彩参考').click())
    assert.deepEqual(previewed, [base.assetId]); assert.deepEqual(located, [base.assetId]); assert.deepEqual(removed, [extra.assetId])
    assert.equal(view.container.querySelectorAll('img').length, 3)
    assert.doesNotMatch(view.container.textContent!, /private-id/)
  } finally { await view.destroy() }
})

test('an active task identifies its snapshot references and cannot change them', async () => {
  let removed = 0, previewed = 0
  const props = { items: [base, extra], generating: true, onRemove: () => removed++, onPreview: () => previewed++ }
  const view = await mount(props)
  try {
    assert.ok(view.container.querySelector('[aria-label="本次任务使用的参考"]'))
    assert.equal(view.button('移除参考：渡口色彩参考').disabled, true)
    await act(() => view.button('移除参考：渡口色彩参考').click())
    assert.equal(removed, 0)
    await act(() => view.button('预览：渡口色彩参考').click())
    assert.equal(previewed, 1, 'the task snapshot remains inspectable')
    await view.render({ ...props, generating: false, disabled: true })
    assert.equal(view.button('移除参考：渡口色彩参考').disabled, true)
  } finally { await view.destroy() }
})

test('legacy task snapshot references retain their submitted identity without claiming a current library source', async () => {
  const view = await mount({ items: [{ ...extra, source: 'snapshot' }], generating: true })
  try {
    assert.match(view.container.textContent!, /已提交参考/)
    assert.doesNotMatch(view.container.textContent!, /素材库|设定库|基础继承|补充参考|保持身份/)
  } finally { await view.destroy() }
})

test('unresolved reference images display a recoverable state without exposing raw ids or the wrong thumbnail', async () => {
  let previewed = 0, removed = 0
  const unresolved = { assetId: 'expired-private-id', name: 'expired-private-id', source: 'asset' as const, canLocate: false }
  const mismatch = { ...extra, assetId: 'changed-private-id', name: '已替换的补充图' }
  const view = await mount({ items: [unresolved, mismatch], onPreview: () => previewed++, onLocate: () => {}, onRemove: () => removed++ })
  try {
    assert.equal(view.container.querySelectorAll('img').length, 0)
    assert.equal(view.container.textContent!.split('已失效').length - 1, 2)
    assert.match(view.container.textContent!, /参考图 1/)
    assert.doesNotMatch(view.container.innerHTML, /aria-label="[^"]*private-id/)
    assert.doesNotMatch(view.container.textContent!, /private-id/)
    assert.equal(view.button('预览：参考图 1').disabled, true)
    assert.equal(view.container.querySelector('button[aria-label="定位：参考图 1"]'), null)
    await act(() => view.button('预览：参考图 1').click())
    await act(() => view.button('移除参考：参考图 1').click())
    assert.equal(previewed, 0); assert.equal(removed, 1)
  } finally { await view.destroy() }
})

test('empty states are explicit and the compact reference list can be collapsed', async () => {
  const view = await mount({ items: [] })
  try {
    assert.match(view.container.textContent!, /未添加参考图，将按提示词生成/)
    const heading = view.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    assert.equal(heading.getAttribute('aria-expanded'), 'true')
    await act(() => heading.click())
    assert.equal(heading.getAttribute('aria-expanded'), 'false')
    await act(() => heading.click())
    await view.render({ items: [], generating: true })
    assert.match(view.container.textContent!, /本次任务未使用参考图/)
  } finally { await view.destroy() }
})
