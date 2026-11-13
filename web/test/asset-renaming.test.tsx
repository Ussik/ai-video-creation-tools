import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset } from '../src/shared/api/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
const { createRoot } = await import('react-dom/client')
const { default: AssetRenameDialog } = await import('../src/features/assets/AssetRenameDialog')
after(() => dom.window.close())

const asset: Asset = { id: 'asset', project_id: 'project', shot_id: null, kind: 'image', filename: 'original.png', source: 'generated', model_id: null, prompt: null, remote_url: null, saved: true, created_at: '2026-11-08T00:00:00Z', url: '/api/assets/asset/file' }
function button(label: string) {
  const control = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  assert.ok(control, `button ${label} exists`)
  return control
}
function input() {
  const label = [...document.querySelectorAll('label')].find(item => item.textContent?.startsWith('素材名称'))
  const control = label?.htmlFor ? document.getElementById(label.htmlFor) as HTMLInputElement : document.querySelector<HTMLInputElement>('input[aria-label="素材名称"]')
  assert.ok(control, 'material name input exists')
  return control
}
async function fill(value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function submit() {
  const form = input().closest('form')
  assert.ok(form, 'rename dialog supports form submission')
  await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
}
async function mount(onSave: (name: string) => Promise<void> = async () => {}) {
  let closes = 0
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><AssetRenameDialog asset={asset} currentName="图片生成 · 分镜图" onSave={onSave} onClose={() => { closes++ }} /></MantineProvider>))
  return { get closes() { return closes }, async destroy() { await act(() => root.unmount()); container.remove() } }
}

test('rename starts with the displayed title and saves a trimmed Chinese name without changing file metadata', async () => {
  const saved: string[] = [], before = JSON.stringify(asset)
  const view = await mount(async name => { saved.push(name) })
  try {
    assert.equal(input().value, '图片生成 · 分镜图')
    assert.equal(input().maxLength, 120)
    await fill('  雷神面具正面  ')
    await act(async () => button('保存').click())
    assert.deepEqual(saved, ['雷神面具正面'])
    assert.equal(view.closes, 1)
    assert.equal(JSON.stringify(asset), before)
  } finally { await view.destroy() }
})

test('blank, control-character and overlong drafts cannot save even through form submission; cancellation does not save', async () => {
  const saved: string[] = [], view = await mount(async name => { saved.push(name) })
  try {
    for (const name of ['   ', '面具\u0001参考', '\t面具', '面'.repeat(121)]) {
      await fill(name)
      assert.equal(button('保存').disabled, true)
      await submit()
      assert.deepEqual(saved, [])
      assert.equal(view.closes, 0)
    }
    await fill('面'.repeat(120))
    assert.equal(button('保存').disabled, false)
    await act(() => button('取消').click())
    assert.equal(view.closes, 1)
    assert.deepEqual(saved, [])
  } finally { await view.destroy() }
})

test('pending saves block duplicate submission and closing until the request completes', async () => {
  let resolve!: () => void, requests = 0
  const view = await mount(async () => { requests++; await new Promise<void>(done => { resolve = done }) })
  try {
    await fill('九霄雷参考图')
    await act(() => { button('保存').click(); button('保存').click() })
    await submit()
    await act(() => button('取消').click())
    await act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(requests, 1)
    assert.equal(button('保存').disabled, true)
    assert.equal(button('取消').disabled, true)
    assert.equal(view.closes, 0)
    await act(async () => resolve())
    assert.equal(view.closes, 1)
  } finally { await view.destroy() }
})

test('a failed save keeps the edited name visible and permits a successful retry', async () => {
  const saved: string[] = []
  const view = await mount(async name => { saved.push(name); if (saved.length === 1) throw new Error('名称保存失败，请重试') })
  try {
    await fill('陆离面具侧面')
    await act(async () => button('保存').click())
    assert.match(document.body.textContent || '', /名称保存失败，请重试/)
    assert.equal(input().value, '陆离面具侧面')
    assert.equal(view.closes, 0)
    assert.equal(button('保存').disabled, false)
    await act(async () => button('保存').click())
    assert.deepEqual(saved, ['陆离面具侧面', '陆离面具侧面'])
    assert.equal(view.closes, 1)
  } finally { await view.destroy() }
})
