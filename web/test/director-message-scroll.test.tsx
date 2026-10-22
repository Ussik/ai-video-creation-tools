import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, Provider, ProjectDetail } from '../src/shared/api/api'
import { skillStageOptions } from '../src/shared/api/skills-api'
import { replyClassificationVersion } from '../src/features/script/script-reply'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const requestFrame = (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id }
const cancelFrame = (id: number) => { frames.delete(id) }
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const isMessages = (element: Element) => element.classList.contains('script-director-messages')
const isHidden = (element: Element) => Boolean(element.closest('[hidden]'))
const messageHeight = 180
const viewportHeight = 360
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return isMessages(this) && !isHidden(this) ? viewportHeight : 0 } })
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return isMessages(this) && !isHidden(this) ? this.querySelectorAll('[data-message-id]').length * messageHeight + 100 : 0 } })
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const viewport = isMessages(this) ? this : this.closest<HTMLElement>('.script-director-messages')
  let top = 100, height = isMessages(this) ? viewportHeight : 0
  if (this.matches('[data-message-id]') && viewport) {
    top += [...viewport.querySelectorAll('[data-message-id]')].indexOf(this) * messageHeight - viewport.scrollTop
    height = messageHeight
  }
  if (isHidden(this)) height = 0
  return { x: 0, y: top, top, left: 0, width: 560, height, right: 560, bottom: top + height, toJSON() { return this } }
}
dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
  const top = typeof options === 'number' ? y || 0 : options?.top || 0
  this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight))
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptDirectorPanel } = await import('../src/features/script/ScriptDirectorPanel')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const detail = { id: 'director-scroll', name: '消息滚动回归', brief: '', ratio: '9:16', script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} }, shots: [], jobs: [], assets: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'model', provider_id: 'provider', name: '测试模型', modality: 'text', enabled: true, settings: {} } as Model
const provider = { id: 'provider', enabled: true, adapter: 'http' } as Provider
const policies = { policies: skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] })) }
const messages = Array.from({ length: 12 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', text: `第 ${index + 1} 条创作讨论。`, classification_version: replyClassificationVersion, classification: { type: 'other' } }))
const conversation = { id: 'conversation-1', label: '创作讨论', messages }
const historyResponse = () => Response.json({ conversations: [conversation], task_persistence: true, tasks: [] })
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`

function mockFetch(t: TestContext, history: () => Promise<Response> | Response = historyResponse, stream?: (path: string) => Response | undefined) {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json(policies)
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/conversations') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/conversations')) return history()
    const response = stream?.(path)
    if (response) return response
    throw new Error(`Unexpected request: ${path}`)
  })
}

async function flushFrames() {
  for (let round = 0; round < 8 && frames.size; round++) {
    const pending = [...frames.entries()]
    frames.clear()
    await act(async () => { for (const [, callback] of pending) callback(round * 16); await Promise.resolve() })
  }
}
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await flushFrames()
}
async function mount(initial: { hidden?: boolean; openRequestId?: number } = {}) {
  dom.window.localStorage.clear()
  frames.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let props = initial
  const render = async (next = props, nextDetail = detail) => {
    props = next
    await act(async () => root.render(<MantineProvider env="test"><ScriptDirectorPanel detail={nextDetail} models={[model]} providers={[provider]} onRefresh={async () => {}} onClose={() => {}} onOpenModels={() => {}} onNotice={() => {}} {...props} /></MantineProvider>))
    await settle()
  }
  await render()
  const viewport = () => container.querySelector<HTMLElement>('[role="log"][aria-label="导演对话消息"]')!
  return { container, viewport, render, destroy: async () => { await act(() => root.unmount()); container.remove(); frames.clear() } }
}
async function readEarlier(viewport: HTMLElement) {
  await act(() => { viewport.scrollTop = 0; viewport.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })) })
  await flushFrames()
}
function assertLatest(viewport: HTMLElement, message = 'the latest conversation is shown') {
  assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight, message)
}

test('history loaded after the panel mounts opens at its latest message', async t => {
  let release!: (response: Response) => void
  const history = new Promise<Response>(resolve => { release = resolve })
  mockFetch(t, () => history)
  const view = await mount()
  try {
    assert.equal(view.viewport().querySelectorAll('[data-message-id]').length, 1)
    await act(() => release(historyResponse()))
    await settle()
    assert.equal(view.viewport().querySelectorAll('[data-message-id]').length, messages.length)
    assertLatest(view.viewport(), 'the completed asynchronous history load must scroll to the newest message')
  } finally { await view.destroy() }
})

test('revealing the existing panel and reopening it always shows its latest message', async t => {
  mockFetch(t)
  const view = await mount({ hidden: true, openRequestId: 1 })
  try {
    assert.equal(view.viewport().clientHeight, 0)
    await act(() => view.viewport().dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
    await view.render({ hidden: false, openRequestId: 1 })
    assertLatest(view.viewport(), 'a panel initially loaded while hidden must scroll once its viewport has a height')

    await readEarlier(view.viewport())
    assert.equal(view.viewport().scrollTop, 0)
    assert.match(view.container.textContent!, /回到最新消息/)
    await view.render({ hidden: true, openRequestId: 1 })
    await view.render({ hidden: false, openRequestId: 1 })
    assertLatest(view.viewport(), 'showing an already mounted panel resets an earlier reading position')

    await readEarlier(view.viewport())
    await view.render({ hidden: false, openRequestId: 2 })
    assertLatest(view.viewport(), 'the script conversation entry reopens the same visible panel at its latest message')
  } finally { await view.destroy() }
})

test('expanding the minimized panel shows its latest message without ordinary rerenders taking away an earlier reading position', async t => {
  mockFetch(t)
  const view = await mount({ openRequestId: 1 })
  try {
    assertLatest(view.viewport())
    await readEarlier(view.viewport())
    await view.render({ openRequestId: 1 }, { ...detail, name: '后台刷新后的项目名称' })
    assert.equal(view.viewport().scrollTop, 0, 'an unrelated project refresh must preserve deliberate upward scrolling')
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="收起对话"]')!.click())
    await settle()
    assert.equal(view.viewport().clientHeight, 0)
    await act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="展开对话"]')!.click())
    await settle()
    assertLatest(view.viewport(), 'expanding restores the latest-message view')
    assert.doesNotMatch(view.container.textContent!, /回到最新消息/)
  } finally { await view.destroy() }
})

test('streamed replies keep following at the latest message but do not interrupt deliberate upward scrolling', async t => {
  const taskId = 'running-scroll-task'
  const execution = { title: '剧本创作对话', request: '讨论开场', started_at: Date.now(), focus_artifact: 'all', mode: 'script' }
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const encode = new TextEncoder()
  mockFetch(t, () => Response.json({ task_persistence: true,
    tasks: [{ id: taskId, message_id: taskId, conversation_id: conversation.id, started_at: execution.started_at, execution }],
    conversations: [{ ...conversation, messages: [...messages, { id: taskId, role: 'assistant', text: '正在处理创作任务…', pending: true, task_id: taskId, execution }] }],
  }), path => path.endsWith(`/tasks/${taskId}/stream`) ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
    stream = controller; controller.enqueue(encode.encode(event({ type: 'task', task_id: taskId })))
  } }), { headers: { 'Content-Type': 'text/event-stream' } }) : undefined)
  const view = await mount({ openRequestId: 1 })
  try {
    await settle()
    const latest = view.viewport().querySelector<HTMLElement>(`[data-message-id="${taskId}"]`)!
    assert.ok(latest)
    assert.ok(latest.getBoundingClientRect().bottom <= view.viewport().getBoundingClientRect().bottom, 'the latest running reply is visible after opening')
    await readEarlier(view.viewport())
    await act(() => stream.enqueue(encode.encode(event({ type: 'delta', text: '新的开场讨论逐步到达。' }))))
    await settle()
    assert.match(latest.textContent!, /新的开场讨论逐步到达/)
    assert.equal(view.viewport().scrollTop, 0, 'incoming reply text must not pull the user away from earlier messages')
    assert.match(view.container.textContent!, /回到最新消息/)
    await view.render({ openRequestId: 2 })
    assert.ok(latest.getBoundingClientRect().bottom <= view.viewport().getBoundingClientRect().bottom, 'reopening returns to the latest running reply')
  } finally { await view.destroy() }
})
