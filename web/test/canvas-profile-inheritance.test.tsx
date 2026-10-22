import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { Asset, VisualProfile } from '../src/shared/api/api'
import type { CanvasProfileInheritanceProps } from '../src/features/canvas/CanvasProfileInheritance'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: Inheritance } = await import('../src/features/canvas/CanvasProfileInheritance')
after(() => dom.window.close())

const base = { id: 'base', kind: 'character', name: '姜望', variant: '落泥前', board_asset_id: null } as VisualProfile
const profile = { ...base, id: 'state', variant: '右手背溅泥', base_profile_id: base.id,
  state_delta: '仅右手背中部有薄泥斑，保持其余衣着与面容。' } as VisualProfile
const asset = { id: 'base-image', kind: 'image', url: '/base-image.png' } as Asset
const confirmedBase = { ...base, board_asset_id: asset.id, board_style_status: 'current' } as VisualProfile
const noop = () => {}
const defaults: CanvasProfileInheritanceProps = { profile, baseProfile: base, waitingProfile: base, baseReady: false,
  onLocateBase: noop }

async function mount(overrides: Partial<CanvasProfileInheritanceProps> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (props: Partial<CanvasProfileInheritanceProps>) => {
    await act(() => root.render(<MantineProvider env="test"><Inheritance {...defaults} {...props} /></MantineProvider>))
  }
  try { await render(overrides) } catch (error) { await act(() => root.unmount()); container.remove(); throw error }
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
    assert.ok(found, `missing button: ${label}`); return found
  }
  return { container, render, button, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

function assertFoundationOnly(container: HTMLElement) {
  assert.doesNotMatch(container.textContent!, /当前状态已确认|当前状态待生成|当前状态需复核|候选待确认|当前状态生成中/)
  assert.equal([...container.querySelectorAll('button')].some(button => /生成当前状态|重新生成当前状态|当前状态生成中/.test(button.textContent || '')), false,
    'the inherited reference card never duplicates the composer generation action')
  assert.equal(container.querySelector('[aria-label="当前设定状态"]'), null, 'the current profile status belongs in its candidate section')
}

test('confirming a foundation keeps its reference visible without duplicating the current state status or generation action', async () => {
  let located = 0
  const callbacks = { onLocateBase: () => located++ }
  const view = await mount(callbacks)
  try {
    assert.match(view.container.textContent!, /等待基础图/)
    assert.match(view.container.textContent!, /继承基础造型/)
    assert.match(view.container.textContent!, /自动引用 · 必需/)
    assertFoundationOnly(view.container)
    await act(() => view.button('定位基础').click())
    assert.equal(located, 1)
    await view.render({ ...callbacks, baseProfile: confirmedBase, asset, waitingProfile: undefined, baseReady: true })
    assert.ok(view.container.querySelector('[aria-label="当前状态的基础参考"]'), 'a ready reference must remain visible')
    assert.match(view.container.textContent!, /基础参考已就绪/)
    assert.match(view.container.textContent!, /已自动引用基础图/)
    assertFoundationOnly(view.container)
    assert.match(view.container.textContent!, /仅右手背中部有薄泥斑/)
    assert.equal(view.container.querySelector('img')?.getAttribute('src'), asset.url)
    await act(() => view.button('定位基础设定：姜望 · 落泥前').click())
    assert.equal(located, 2)
  } finally { await view.destroy() }
})

test('a stale foundation or an unresolved ancestor explains the dependency without introducing a second generation entry', async () => {
  const props = { baseProfile: confirmedBase, asset, baseReady: false,
    waitingProfile: { ...confirmedBase, board_style_status: 'needs_review' as const } }
  const view = await mount(props)
  try {
    assert.match(view.container.textContent!, /基础参考需复核/)
    assert.match(view.container.textContent!, /核对并确认「姜望 · 落泥前」/)
    assert.equal(view.button('核对基础图').disabled, false)
    assertFoundationOnly(view.container)
    const ancestor = { ...base, id: 'ancestor', variant: '原始身份' }
    await view.render({ ...props, baseReady: true, waitingProfile: ancestor })
    assert.match(view.container.textContent!, /原始身份/)
    assert.match(view.container.textContent!, /请先生成并确认「姜望 · 原始身份」/)
    assertFoundationOnly(view.container)
  } finally { await view.destroy() }
})

test('confirmed and stale current states leave the foundation card focused on its own reference readiness', async () => {
  const ready = { baseProfile: confirmedBase, asset, waitingProfile: undefined, baseReady: true }
  const view = await mount(ready)
  try {
    assertFoundationOnly(view.container)
    await view.render({ ...ready, profile: { ...profile, board_asset_id: 'state-image' } })
    assertFoundationOnly(view.container)
    await view.render({ ...ready, profile: { ...profile, board_asset_id: 'state-image', base_reference_status: 'needs_review' } })
    assertFoundationOnly(view.container)
    assert.match(view.container.textContent!, /基础参考已就绪/)
    await view.render({ ...ready, busy: true })
    assert.equal(view.button('定位基础').disabled, true)
    assertFoundationOnly(view.container)
  } finally { await view.destroy() }
})

test('a base task and a broken relation show only their own dependency state and location availability', async () => {
  const view = await mount({ baseGenerating: true })
  try {
    assert.match(view.container.textContent!, /基础图生成中/)
    assertFoundationOnly(view.container)
    await view.render({ baseProfile: undefined, waitingProfile: undefined, error: '基础设定不存在，请重新选择。' })
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /基础设定不存在/)
    assertFoundationOnly(view.container)
    assert.equal(view.button('定位基础').disabled, true)
  } finally { await view.destroy() }
})
