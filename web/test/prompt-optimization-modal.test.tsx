import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Job, Model, Provider } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: PromptOptimizationModal } = await import('../src/features/jobs/PromptOptimizationModal')
after(() => dom.window.close())
const job = { id: 'job', project_id: 'project', request: '{"prompt":"原始画面描述"}', error: 'content_policy_violation' } as Job
const models = [{ id: 'text', name: '文本模型', provider_id: 'provider', enabled: true, modality: 'text' },
  { id: 'disabled', name: '禁用模型', provider_id: 'provider', enabled: false, modality: 'text' }] as Model[]
const providers = [{ id: 'provider', name: '服务商', enabled: true, adapter: 'http' }] as Provider[]
const originalFetch = globalThis.fetch

function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(node, label); return node
}
async function edit(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="优化后的提示词"]')!
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), applied: string[] = []
  let closed = 0
  const render = async (sourceKey = 'v1', catalog = models) => act(() => root.render(<MantineProvider env="test">
    <PromptOptimizationModal job={job} models={catalog} providers={providers} sourceKey={sourceKey} newDraft
      onClose={() => { closed++ }} onApply={value => { applied.push(value) }} />
  </MantineProvider>))
  await render()
  return { render, applied, closed: () => closed, async close() { globalThis.fetch = originalFetch; await act(() => root.unmount()); container.remove() } }
}

test('opening is free of model calls; explicit optimization returns an editable comparison and applying does not generate images', async () => {
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options?.body)) })
    return new Response(JSON.stringify({ prompt: '优化建议', changes: ['移除不适宜细节'] }), { status: 200 })
  }
  const view = await mount()
  try {
    assert.equal(requests.length, 0); assert.equal(button('应用到画布').disabled, true)
    await act(async () => { button('生成优化建议').click(); button('生成优化建议').click() })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/api/projects/project/jobs/job/optimize-prompt')
    assert.deepEqual(requests[0].body, { model_id: 'text', prompt: '原始画面描述' })
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="优化前的提示词"]')!.value, '原始画面描述')
    await edit(''); await edit('人工编辑的适宜描述')
    await act(async () => button('应用到画布').click())
    assert.deepEqual(view.applied, ['人工编辑的适宜描述']); assert.equal(view.closed(), 1)
    assert.equal(requests.length, 1)
  } finally { await view.close() }
})

test('changed source/configuration makes suggestions stale and blocks applying until regenerated', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ prompt: '优化建议', changes: ['调整'] }), { status: 200 })
  const view = await mount()
  try {
    await act(async () => button('生成优化建议').click())
    await view.render('v2')
    assert.equal(button('应用到画布').disabled, true)
    assert.match(document.body.textContent!, /生成配置已变化/)
    await act(async () => button('重新优化').click())
    assert.equal(button('应用到画布').disabled, false)
  } finally { await view.close() }
})

test('closing aborts a pending request and unavailable models never start optimization', async () => {
  let signal: AbortSignal | null = null, resolve!: (value: Response) => void
  globalThis.fetch = async (_url, options) => { signal = options!.signal!; return new Promise(done => { resolve = done }) }
  const view = await mount()
  try {
    await act(() => button('生成优化建议').click())
    await act(() => button('取消').click())
    assert.equal((signal as unknown as AbortSignal).aborted, true)
    await act(async () => resolve(new Response(JSON.stringify({ prompt: '迟到结果', changes: ['调整'] }), { status: 200 })))
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="优化后的提示词"]')!.value, '')
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
  const empty = await mount()
  try { await empty.render('v1', []); assert.equal(button('生成优化建议').disabled, true) }
  finally { await empty.close() }
})

test('model request errors remain visible with the source intact and allow another attempt', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ detail: '文本模型暂不可用' }), { status: 502 }) }
  const view = await mount()
  try {
    await act(async () => button('生成优化建议').click())
    assert.ok([...document.querySelectorAll('[role="alert"]')].some(alert => alert.textContent?.includes('文本模型暂不可用')))
    assert.equal(button('生成优化建议').disabled, false); assert.equal(button('应用到画布').disabled, true)
    await act(async () => button('生成优化建议').click())
    assert.equal(calls, 2); assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})
