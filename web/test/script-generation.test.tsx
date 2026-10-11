import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, Provider } from '../src/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptEditor } = await import('../src/ScriptEditor')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const project = { id: 'generation-test', name: '山海经', brief: '', ratio: '9:16', script: {
  outline: '保留已确认的大纲', characters: '已确认人物', scenes: [], generation_options: {},
}, shots: [], assets: [], jobs: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text', provider_id: 'provider', name: '文本模型', modality: 'text', enabled: true } as Model
const provider = { id: 'provider', name: '提供商', adapter: 'http', enabled: true } as Provider

function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  assert.ok(result, label)
  return result
}
async function fill(label: string, value: string) {
  const input = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  assert.ok(input, label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function settle() { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function openGeneration(container: HTMLElement) {
  await act(() => button('生成剧本', container).click())
  await settle()
}
async function mount(t: TestContext) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body || '{}'))
    requests.push({ path, body, method: init?.method || 'GET' })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'script', label: '剧本创作', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (path.endsWith('/script/generate/prompt')) return Response.json({ prompt: `根据已确认大纲生成；补充要求：${body.idea || '沿用项目资料'}` })
    if (path.endsWith('/script/generate')) return Response.json({ outline: '新的详细大纲', characters: '新人物草稿', scenes: [], artifacts: [] })
    throw new Error(`Unexpected request: ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptEditor detail={project} models={[model]} providers={[provider]}
    onRefresh={async () => project} onOpenModels={() => {}} onOpenCanvas={() => {}} onNotice={() => {}} /></MantineProvider>))
  await settle()
  return { container, requests, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('an empty creative brief allows generation while existing documents remain unchanged until applied', async t => {
  const view = await mount(t)
  try {
    await openGeneration(view.container)
    const brief = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="创意概述"]')!
    assert.equal(brief.value, '')
    assert.equal(brief.required, false)
    assert.equal(brief.disabled, false)
    assert.equal(button('提示词设置').getAttribute('aria-expanded'), 'false')
    assert.ok(!document.querySelector('[role="dialog"]')?.textContent?.includes('留空时根据项目已有大纲和设定生成'))
    assert.equal(button('生成草稿').disabled, false)
    assert.ok(view.requests.every(request => !request.path.endsWith('/script/generate')), 'opening only loads settings and prompt')
    await act(() => button('生成草稿').click()); await settle()
    const generation = view.requests.find(request => request.path.endsWith('/script/generate'))!
    assert.ok(generation)
    assert.equal(generation.body.idea, '')
    assert.equal(generation.body.model_id, 'text')
    assert.match(String(generation.body.prompt_override), /沿用项目资料/)
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /检查生成结果/)
    assert.match(view.container.querySelector('[data-script-section="outline"]')?.textContent || '', /保留已确认的大纲/)
    assert.ok(view.requests.every(request => !request.path.endsWith('/commit')), 'preview never saves project content')
  } finally { await view.destroy() }
})

test('creative brief edits refresh the automatic prompt, survive reopening and reach the generation request', async t => {
  const view = await mount(t)
  try {
    await openGeneration(view.container)
    await fill('创意概述', '保留人物关系，细化全剧伏笔'); await settle()
    assert.match(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本生成提示词"]')!.value, /保留人物关系，细化全剧伏笔/)
    await act(() => button('取消').click()); await settle()
    await act(() => button('生成剧本', view.container).click()); await settle()
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="创意概述"]')!.value, '保留人物关系，细化全剧伏笔')
    await act(() => button('提示词设置').click())
    await fill('剧本生成提示词', '我编辑过的提示词')
    await fill('创意概述', '新的创意概述'); await settle()
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="剧本生成提示词"]')!.value, '我编辑过的提示词', 'automatic refresh preserves a customized prompt')
    await act(() => button('提示词设置').click())
    assert.equal(button('提示词设置').getAttribute('aria-expanded'), 'false')
    await act(() => button('生成草稿').click()); await settle()
    const generation = view.requests.find(request => request.path.endsWith('/script/generate'))!
    assert.equal(generation.body.idea, '新的创意概述')
    assert.equal(generation.body.prompt_override, '我编辑过的提示词')
    assert.ok(view.requests.every(request => !request.path.endsWith('/commit')))
  } finally { await view.destroy() }
})
