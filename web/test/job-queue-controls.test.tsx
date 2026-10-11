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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: JobQueueControls } = await import('../src/JobQueueControls')
after(() => dom.window.close())
const queue = (concurrency = 3) => ({ concurrency, max_concurrency: 10, running: 2, queued: 6 })
async function mount() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><JobQueueControls /></MantineProvider>))
  return { container, async close() { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(found, `button ${label}`); return found
}
function field() { return document.querySelector<HTMLInputElement>('input')! }
async function change(value: string) {
  await act(() => {
    const input = field()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('loads global queue counts and saves an integer limit, showing the resulting state', async t => {
  const calls: Array<{ path: string; init: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init })
    return Response.json(queue(init.method === 'PUT' ? JSON.parse(String(init.body)).concurrency : 3))
  })
  const view = await mount()
  try {
    assert.match(view.container.textContent!, /全局 · 执行 2\/3 · 排队 6/)
    await act(() => button('并行设置').click())
    assert.equal(field().value, '3')
    assert.match(document.body.textContent!, /成片导出每次执行 1 条/)
    await change('5')
    await act(() => button('保存设置').click())
    assert.equal(document.querySelector('.job-queue-settings'), null)
    assert.match(view.container.textContent!, /执行 2\/5/)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.path, '/api/job-queue')
    assert.equal(calls[1]!.init.method, 'PUT')
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { concurrency: 5 })
  } finally { await view.close() }
})

test('failed saves retain the draft and allow retry, while empty inputs cannot submit', async t => {
  let fail = true, puts = 0
  t.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    if (init.method !== 'PUT') return Response.json(queue())
    puts++
    return fail ? Response.json({ detail: '保存失败，请重试' }, { status: 500 }) : Response.json(queue(5))
  })
  const view = await mount()
  try {
    await act(() => button('并行设置').click())
    await change('')
    assert.equal(button('保存设置').disabled, true)
    await change('5')
    await act(() => button('保存设置').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /保存失败，请重试/)
    assert.equal(field().value, '5')
    fail = false
    await act(() => button('保存设置').click())
    assert.equal(puts, 2)
    assert.match(view.container.textContent!, /执行 2\/5/)
  } finally { await view.close() }
})

test('a stale polling response cannot replace a successful save and pending requests are cancelled on unmount', async t => {
  let poll!: () => void
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => { if (delay === 4000) poll = callback; return 99 })
  t.mock.method(globalThis, 'clearInterval', () => {})
  let getCalls = 0, resolveOld!: (response: Response) => void, oldSignal!: AbortSignal, finalSignal!: AbortSignal
  t.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    if (init.method === 'PUT') return Response.json(queue(5))
    if (++getCalls === 1) return Response.json(queue())
    if (getCalls === 2) { oldSignal = init.signal!; return new Promise<Response>(resolve => { resolveOld = resolve }) }
    finalSignal = init.signal!; return new Promise<Response>(() => {})
  })
  const view = await mount()
  try {
    await act(() => poll())
    await act(() => button('并行设置').click())
    await change('5')
    await act(() => button('保存设置').click())
    assert.equal(oldSignal.aborted, true)
    await act(() => resolveOld(Response.json(queue(3))))
    assert.match(view.container.textContent!, /执行 2\/5/)
    await act(() => poll())
  } finally { await view.close() }
  assert.equal(finalSignal.aborted, true)
})

test('load errors are visible and saving stays disabled until queue information is available', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: '队列连接失败' }, { status: 503 }))
  const view = await mount()
  try {
    assert.match(view.container.textContent!, /队列设置暂不可用/)
    await act(() => button('并行设置').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /队列连接失败/)
    assert.equal(button('保存设置').disabled, true)
    assert.equal(field().disabled, true)
  } finally { await view.close() }
})
