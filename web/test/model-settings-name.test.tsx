import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider } from '../src/api'

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
const { default: ModelSettings } = await import('../src/ModelSettings')
after(() => dom.window.close())

const provider = { id: 'provider-one', name: 'gpt-image', adapter: 'http', base_url: 'https://example.invalid/v1', has_key: true,
  enabled: true, auth_header: 'Authorization', auth_prefix: 'Bearer ', created_at: '2026-10-11T00:00:00Z' } as Provider
const model = { id: 'model-one', provider_id: provider.id, name: '图片模型', remote_id: 'image-model', modality: 'image',
  protocol: 'image_generations', settings: {}, enabled: true } as Model
function button(label: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  assert.ok(node, label)
  return node
}
async function fillName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function mount(t: TestContext, fail = false) {
  let stored = { ...provider }
  const requests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [], errors: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    requests.push({ url: String(url), method: init?.method, body })
    if (fail) return Response.json({ detail: '名称保存失败' }, { status: 503 })
    stored = { ...stored, name: body.name }
    return Response.json(stored)
  })
  function Harness() {
    const [providers, setProviders] = useState([stored]), [busy, setBusy] = useState(false)
    return <MantineProvider env="test"><ModelSettings providers={providers} models={[model]} busy={busy}
      refresh={async () => { setProviders([{ ...stored }]) }} action={async task => {
        setBusy(true)
        try { await task() } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
        finally { setBusy(false) }
      }} /></MantineProvider>
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness />))
  return { container, requests, errors, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('renaming a provider submits only its name and updates the heading and provider list', async t => {
  const view = await mount(t)
  try {
    await act(() => button('修改提供商名称').click())
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!.value, provider.name)
    await fillName('  映画工坊  ')
    await act(async () => button('保存名称').click())
    assert.deepEqual(view.requests, [{ url: '/api/providers/provider-one', method: 'PATCH', body: { name: '映画工坊' } }])
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, '映画工坊')
    assert.match(view.container.querySelector('.ms-provider.is-active')!.textContent!, /映画工坊/)
    assert.equal(view.container.querySelector('.ms-provider-emblem')!.textContent, '映')
    assert.equal(view.container.querySelector<HTMLInputElement>('.ms-connection-form input[type="url"]')!.value, provider.base_url)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.destroy() }
})

test('blank names cannot be saved and cancelling a rename makes no request', async t => {
  const view = await mount(t)
  try {
    await act(() => button('修改提供商名称').click())
    assert.equal(button('保存名称').disabled, true)
    await fillName('   ')
    assert.equal(button('保存名称').disabled, true)
    await fillName('未保存名称')
    await act(() => button('取消', document.querySelector('[role="dialog"]')!).click())
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, provider.name)
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('failed provider renames retain the draft and leave the displayed name unchanged', async t => {
  const view = await mount(t, true)
  try {
    await act(() => button('修改提供商名称').click())
    await fillName('待重试名称')
    await act(async () => button('保存名称').click())
    assert.deepEqual(view.errors, ['名称保存失败'])
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="提供商名称"]')!.value, '待重试名称')
    assert.equal(view.container.querySelector('.ms-provider-title h1')!.textContent, provider.name)
    assert.equal(button('保存名称').disabled, false)
  } finally { await view.destroy() }
})
