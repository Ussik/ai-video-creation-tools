import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import React, { act, useState } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ModelSettings } = await import('../src/features/models/ModelSettings')
after(() => dom.window.close())

const providers = [
  { id: 'alpha', name: '甲提供商', adapter: 'http', enabled: true, has_key: true, base_url: 'https://alpha.invalid/v1' },
  { id: 'beta', name: '乙提供商', adapter: 'http', enabled: true, has_key: true, base_url: 'https://beta.invalid/v1' },
  { id: 'disabled', name: '停用提供商', adapter: 'http', enabled: false, has_key: true, base_url: 'https://disabled.invalid/v1' },
] as Provider[]
const models = [
  { id: 'text-a', name: '甲文本', provider_id: 'alpha', modality: 'text', protocol: 'responses', enabled: true, is_default: true },
  { id: 'text-b', name: '乙文本', provider_id: 'beta', modality: 'text', protocol: 'responses', enabled: true },
  { id: 'image-a', name: '甲图片', provider_id: 'alpha', modality: 'image', protocol: 'image_generations', enabled: true },
  { id: 'image-disabled', name: '停用图片', provider_id: 'alpha', modality: 'image', protocol: 'image_generations', enabled: false },
  { id: 'video-disabled', name: '停用商视频', provider_id: 'disabled', modality: 'video', protocol: 'async_video', enabled: true },
].map(model => ({ ...model, remote_id: model.id, settings: {} })) as Model[]

function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)
  assert.ok(node, label)
  return node
}
function selected(label: string) {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.ok(node, label)
  return node
}
function dropdownFor(input: HTMLInputElement) {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.htmlFor === input.id)
  assert.ok(label?.id, `${input.getAttribute('aria-label')} label is associated with the combobox`)
  // Mantine links each mounted listbox to its label, including hidden portals.
  const list = [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].find(node =>
    node.getAttribute('aria-labelledby')?.split(/\s+/).includes(label.id))
  assert.ok(list, `${input.getAttribute('aria-label')} has its own dropdown`)
  return list
}
async function choose(label: string, option: string) {
  const input = selected(label)
  await act(() => { input.focus(); input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await act(() => input.click())
  const list = dropdownFor(input)
  const node = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === option)
  assert.ok(node, option)
  await act(async () => node.click())
}
async function mount(t: TestContext, fail = false) {
  let stored = models.map(model => ({ ...model }))
  const requests: Array<{ url: string; method?: string; body: BodyInit | null | undefined }> = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body })
    if (fail) return Response.json({ detail: '默认设置保存失败' }, { status: 503 })
    const target = stored.find(model => String(url) === `/api/models/${model.id}/default`)
    assert.ok(target)
    stored = stored.map(model => model.modality === target.modality ? { ...model, is_default: init?.method === 'PUT' && model.id === target.id } : model)
    return Response.json(stored.find(model => model.id === target.id))
  })
  function Harness() {
    const [catalog, setCatalog] = useState(stored), [busy, setBusy] = useState(false)
    return <MantineProvider env="test"><ModelSettings providers={providers} models={catalog} busy={busy}
      refresh={async () => setCatalog([...stored])} action={async task => {
        setBusy(true)
        try { await task() } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness />))
  await act(() => button('默认模型').click())
  return { requests, errors, container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('global default selectors include models from other enabled providers and save only the default endpoint', async t => {
  const view = await mount(t)
  try {
    assert.equal(selected('默认文本模型').value, '甲文本 · 甲提供商')
    await choose('默认文本模型', '乙文本 · 乙提供商')
    assert.deepEqual(view.requests, [{ url: '/api/models/text-b/default', method: 'PUT', body: undefined }])
    assert.equal(selected('默认文本模型').value, '乙文本 · 乙提供商')
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('global selectors set and cancel a modality default while preserving the other defaults', async t => {
  const view = await mount(t)
  try {
    await choose('默认图片模型', '甲图片 · 甲提供商')
    assert.equal(selected('默认图片模型').value, '甲图片 · 甲提供商')
    await choose('默认图片模型', '自动选择')
    assert.equal(selected('默认图片模型').value, '自动选择')
    assert.equal(selected('默认文本模型').value, '甲文本 · 甲提供商')
    assert.deepEqual(view.requests.map(request => [request.url, request.method]), [
      ['/api/models/image-a/default', 'PUT'], ['/api/models/image-a/default', 'DELETE'],
    ])
  } finally { await view.destroy() }
})

test('automatic selection clears a default and disabled models cannot become defaults', async t => {
  const view = await mount(t)
  try {
    assert.equal(selected('默认视频模型').disabled, true)
    assert.match(view.container.textContent!, /暂无已启用的视频模型/)
    await act(() => selected('默认图片模型').click())
    assert.equal([...dropdownFor(selected('默认图片模型')).querySelectorAll('[role="option"]')].some(node => node.textContent?.includes('停用图片')), false)
    await act(() => selected('默认图片模型').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await choose('默认文本模型', '自动选择')
    assert.equal(selected('默认文本模型').value, '自动选择')
    assert.deepEqual(view.requests.map(request => [request.url, request.method]), [['/api/models/text-a/default', 'DELETE']])
  } finally { await view.destroy() }
})

test('failed default updates retain the saved default and expose the action error', async t => {
  const view = await mount(t, true)
  try {
    await choose('默认文本模型', '乙文本 · 乙提供商')
    assert.equal(selected('默认文本模型').value, '甲文本 · 甲提供商')
    assert.deepEqual(view.errors, ['默认设置保存失败'])
  } finally { await view.destroy() }
})
