import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Job, Model, Provider } from '../src/shared/api/api'
import { rememberModelSelection } from '../src/features/models/model-selection-store'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: PromptOptimizationModal } = await import('../src/features/jobs/PromptOptimizationModal')
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())
const job = { id: 'job', project_id: 'project', request: '{"prompt":"原始画面描述"}', error: 'content_policy_violation' } as Job
const models = [{ id: 'text', name: '文本模型', provider_id: 'provider', enabled: true, modality: 'text' },
  { id: 'disabled', name: '禁用模型', provider_id: 'provider', enabled: false, modality: 'text' }] as Model[]
const providers = [{ id: 'provider', name: '服务商', enabled: true, adapter: 'http' }] as Provider[]
const originalFetch = globalThis.fetch

function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(node, label); return node
}
function textarea(label: string) {
  const field = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  assert.ok(field, label); return field
}
async function fill(label: string, value: string) {
  const field = textarea(label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const edit = (value: string) => fill('优化后的提示词', value)
async function chooseModel(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="优化提示词的文本模型"]')!
  await act(() => input.click())
  const option = document.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)
  assert.ok(option, value)
  await act(() => option.click())
}
async function mount(initialCatalog = models) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), applied: string[] = []
  let closed = 0
  const render = async (sourceKey = 'v1', catalog = initialCatalog, prompt?: string) => act(() => root.render(<MantineProvider env="test">
    <PromptOptimizationModal job={job} models={catalog} providers={providers} sourceKey={sourceKey} prompt={prompt} newDraft
      onClose={() => { closed++ }} onApply={value => { applied.push(value) }} />
  </MantineProvider>))
  await render()
  return { render, applied, closed: () => closed, async close() { globalThis.fetch = originalFetch; await act(() => root.unmount()); container.remove() } }
}

test('optimization starts with the default text model, retains a manual choice and replaces it only when unavailable', async () => {
  const preferred = { ...models[0]!, id: 'preferred', name: '默认文本模型', is_default: true }
  const catalog = [models[0]!, preferred]
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    return Response.json({ prompt: '优化建议', changes: [] })
  }
  const view = await mount(catalog)
  try {
    assert.equal(requests.length, 0)
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="优化提示词的文本模型"]')!.value, '默认文本模型')
    await chooseModel('text')
    await view.render('v1', [...catalog])
    await act(async () => button('生成优化建议').click())
    assert.equal(requests[0].model_id, 'text')
    await view.render('v1', [{ ...models[0]!, enabled: false }, preferred])
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="优化提示词的文本模型"]')!.value, '默认文本模型')
    await act(async () => button('继续调整').click())
    assert.equal(requests[1].model_id, 'preferred')
  } finally { await view.close() }
})

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
    assert.deepEqual(requests[0].body, { model_id: 'text', prompt: '原始画面描述', adjustment_request: '' })
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="优化前的提示词"]')!.value, '原始画面描述')
    await edit(''); await edit('人工编辑的适宜描述')
    await act(async () => button('应用到画布').click())
    assert.deepEqual(view.applied, ['人工编辑的适宜描述']); assert.equal(view.closed(), 1)
    assert.equal(requests.length, 1)
  } finally { await view.close() }
})

test('changed source/configuration makes suggestions stale and blocks applying until regenerated', async () => {
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    return new Response(JSON.stringify({ prompt: '优化建议', changes: ['调整'] }), { status: 200 })
  }
  const view = await mount()
  try {
    await fill('本次调整要求', '保留人物关系')
    await act(async () => button('生成优化建议').click())
    await edit('用户编辑过的候选')
    await view.render('v2')
    assert.equal(button('应用到画布').disabled, true)
    assert.match(document.body.textContent!, /生成配置已变化/)
    await act(async () => button('重新优化').click())
    assert.deepEqual(requests[1], { model_id: 'text', prompt: '原始画面描述', adjustment_request: '保留人物关系' })
    assert.equal(button('应用到画布').disabled, false)
    await edit('针对旧草稿编辑的候选')
    await view.render('v2', models, '新的画布草稿')
    assert.equal(button('应用到画布').disabled, true)
    await act(async () => button('重新优化').click())
    assert.deepEqual(requests[2], { model_id: 'text', prompt: '新的画布草稿', adjustment_request: '保留人物关系' })
    assert.equal(button('应用到画布').disabled, false)
  } finally { await view.close() }
})

test('custom directions are trimmed and continuation keeps manual edits through failure and retry', async () => {
  const requests: Array<Record<string, unknown>> = []
  let resolve!: (value: Response) => void
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    if (requests.length === 1) return new Response(JSON.stringify({ prompt: '适宜的画面建议', changes: ['调整细节'] }), { status: 200 })
    if (requests.length === 2) return new Promise(done => { resolve = done })
    return new Response(JSON.stringify({ prompt: '保留用户编辑后的新建议', changes: ['精简描述'] }), { status: 200 })
  }
  const view = await mount()
  try {
    assert.equal(textarea('本次调整要求').maxLength, 4_000)
    await fill('本次调整要求', '  保留人物身份和场景关系。\n  ')
    await act(async () => button('生成优化建议').click())
    assert.deepEqual(requests[0], { model_id: 'text', prompt: '原始画面描述', adjustment_request: '保留人物身份和场景关系。' })
    assert.equal(button('应用到画布').disabled, false)
    await edit('适宜的画面建议，用户手动加入红色围巾')
    await fill('本次调整要求', '  精简描述，保留红色围巾。  ')
    assert.equal(button('应用到画布').disabled, true, 'directions need a fresh suggestion before applying')
    await act(() => button('继续调整').click())
    assert.equal(textarea('本次调整要求').disabled, true)
    assert.equal(textarea('优化后的提示词').value, '适宜的画面建议，用户手动加入红色围巾')
    assert.deepEqual(requests[1], { model_id: 'text', prompt: '适宜的画面建议，用户手动加入红色围巾', adjustment_request: '精简描述，保留红色围巾。' })
    await act(async () => resolve(new Response(JSON.stringify({ detail: '文本模型暂不可用' }), { status: 502 })))
    assert.equal(textarea('优化后的提示词').value, '适宜的画面建议，用户手动加入红色围巾')
    assert.equal(textarea('本次调整要求').value, '  精简描述，保留红色围巾。  ')
    assert.equal(textarea('本次调整要求').disabled, false)
    assert.equal(button('应用到画布').disabled, true)
    assert.match(document.body.textContent!, /文本模型暂不可用/)
    await act(async () => button('继续调整').click())
    assert.deepEqual(requests[2], requests[1], 'retry keeps the same manual candidate and directions')
    assert.equal(button('应用到画布').disabled, false)
    await act(async () => button('应用到画布').click())
    assert.deepEqual(view.applied, ['保留用户编辑后的新建议'])
  } finally { await view.close() }
})

test('changing the text model keeps the edited candidate as the next adjustment basis', async () => {
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    return new Response(JSON.stringify({ prompt: requests.length === 1 ? '首轮候选' : '另一模型的建议', changes: ['调整'] }), { status: 200 })
  }
  const view = await mount()
  try {
    await view.render('v1', [...models, { ...models[0]!, id: 'text-other', name: '另一文本模型' }])
    await act(async () => button('生成优化建议').click())
    await edit('首轮候选，保留手动添加的衣着细节')
    await chooseModel('text-other')
    assert.equal(textarea('优化后的提示词').value, '首轮候选，保留手动添加的衣着细节')
    assert.equal(button('应用到画布').disabled, true)
    await act(async () => button('继续调整').click())
    assert.deepEqual(requests[1], { model_id: 'text-other', prompt: '首轮候选，保留手动添加的衣着细节', adjustment_request: '' })
    assert.equal(button('应用到画布').disabled, false)
  } finally { await view.close() }
})

test('overlong adjustment directions cannot start optimization', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('{}') }
  const view = await mount()
  try {
    await fill('本次调整要求', '长'.repeat(4_001))
    assert.equal(button('生成优化建议').disabled, true)
    await act(() => button('生成优化建议').click())
    assert.equal(calls, 0)
    await fill('本次调整要求', '长'.repeat(4_000))
    assert.equal(button('生成优化建议').disabled, false)
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

test('external model selection waits for the running optimization then preserves its candidate as stale', async () => {
  let finish!: (response: Response) => void
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    return new Promise(resolve => { finish = resolve })
  }
  const catalog = [...models, { ...models[0], id: 'other', name: '另一文本模型' }]
  const view = await mount(catalog)
  try {
    await act(() => button('生成优化建议').click())
    await act(() => rememberModelSelection('text', 'other'))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="优化提示词的文本模型"]')!.value, '文本模型')
    assert.equal(requests[0].model_id, 'text')
    await act(async () => finish(Response.json({ prompt: '原模型完成的候选', changes: [] })))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="优化提示词的文本模型"]')!.value, '另一文本模型')
    assert.equal(textarea('优化后的提示词').value, '原模型完成的候选')
    assert.equal(button('应用到画布').disabled, true)
    assert.deepEqual(view.applied, [])
  } finally { await view.close() }
})
