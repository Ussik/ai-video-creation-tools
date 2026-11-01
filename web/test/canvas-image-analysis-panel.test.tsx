import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { CanvasImageAnalysisPanelProps } from '../src/features/canvas/CanvasImageAnalysisPanel'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'HTMLTextAreaElement', 'ShadowRoot', 'Document']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
const { createRoot } = await import('react-dom/client')
const { default: Panel } = await import('../src/features/canvas/CanvasImageAnalysisPanel')
after(() => dom.window.close())

const noop = () => {}
const asset = { id: 'image', url: '/api/assets/image/file', label: '角色原图' }
const defaults: CanvasImageAnalysisPanelProps = { asset, models: [{ id: 'vision', label: '视觉模型' }], modelId: 'vision', instructions: '', prompt: '',
  onUpload: noop, onModelChange: noop, onInstructionsChange: noop, onPromptChange: noop, onAnalyze: noop, onCreateGeneration: noop }

async function mount(overrides: Partial<CanvasImageAnalysisPanelProps> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (props: Partial<CanvasImageAnalysisPanelProps>) => {
    await act(() => root.render(<MantineProvider env="test"><Panel {...defaults} {...props} /></MantineProvider>))
  }
  try { await render(overrides) } catch (error) { await act(() => root.unmount()); container.remove(); throw error instanceof AggregateError ? error.errors[0] : error }
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
    assert.ok(found, `missing button: ${label}`); return found
  }
  return { container, render, button, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

function paste(target: Element, files: File[], items: Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>[] = files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file }))) {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items, files } })
  target.dispatchEvent(event)
  return event
}

test('analysis requires an image and an available image-capable model with visible guidance', async () => {
  let analyzed = 0
  const callbacks = { onAnalyze: () => analyzed++ }
  const view = await mount({ ...callbacks, asset: undefined })
  try {
    assert.match(view.container.textContent!, /上传图片，或连接画布中的图片节点/)
    assert.equal(view.button('开始反推').disabled, true)
    await view.render({ ...callbacks, models: [], modelId: '' })
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /暂无可用的看图模型/)
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /模型设置中启用文本模型的“支持图片理解”/)
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /Gemini 图片反推/)
    assert.equal(view.button('开始反推').disabled, true)
    await view.render(callbacks)
    assert.equal(view.container.querySelector('img')?.getAttribute('src'), asset.url)
    assert.equal(view.button('开始反推').disabled, false)
    await act(() => view.button('开始反推').click())
    assert.equal(analyzed, 1)
    assert.equal(view.button('创建图片生成节点').disabled, true)
  } finally { await view.destroy() }
})

test('busy state reports elapsed time, prevents duplicate actions and allows cancellation', async () => {
  let canceled = 0
  const view = await mount({ prompt: '已有专业提示词', pending: true, elapsedSeconds: 65.8, onCancel: () => canceled++ })
  try {
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /已等待 65 秒/)
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /可取消后重试/)
    assert.equal(view.button('重新反推').disabled, true)
    assert.equal(view.button('替换图片').disabled, true)
    assert.equal(view.button('创建图片生成节点').disabled, true)
    assert.ok([...view.container.querySelectorAll('textarea')].every(field => field.disabled))
    await act(() => view.button('取消反推').click())
    assert.equal(canceled, 1)
  } finally { await view.destroy() }
})

test('analysis errors remain visible next to the actions and preserve the editable result', async () => {
  const prompts: string[] = []
  let created = 0
  const view = await mount({ prompt: '保留的构图与灯光描述', error: '模型服务超时，请重试。',
    onPromptChange: text => prompts.push(text), onCreateGeneration: () => created++ })
  try {
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /反推未完成.*模型服务超时/)
    const field = view.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="完成图片分析后，提示词会显示在这里"]')!
    assert.equal(field.value, '保留的构图与灯光描述')
    assert.equal(field.disabled, false)
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '编辑后的提示词')
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.deepEqual(prompts, ['编辑后的提示词'])
    await act(() => view.button('创建图片生成节点').click())
    assert.equal(created, 1)
  } finally { await view.destroy() }
})

test('another active node locks controls without claiming this node is analyzing or canceling the other task', async () => {
  const view = await mount({ otherPending: true, prompt: '当前节点已有结果', onCancel: noop })
  try {
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /另一个图片反推节点正在处理/)
    assert.equal(view.container.querySelector('[role="status"]'), null)
    assert.equal(view.button('重新反推').disabled, true)
    assert.equal(view.button('替换图片').disabled, true)
    assert.equal(view.button('创建图片生成节点').disabled, true)
    assert.ok([...view.container.querySelectorAll('textarea')].every(field => field.disabled))
    assert.ok(!view.container.textContent!.includes('取消反推'))
  } finally { await view.destroy() }
})

test('image selection supports replacing an image and selecting the same file again', async () => {
  const uploads: File[] = []
  const view = await mount({ onUpload: file => uploads.push(file) })
  try {
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    assert.equal(input.accept, 'image/png,image/jpeg,image/webp')
    assert.equal(input.multiple, false)
    const file = new dom.window.File(['image'], 'image.png', { type: 'image/png' }) as unknown as File
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    assert.deepEqual(uploads, [file, file])
    let canceled = 0
    await view.render({ uploading: true, onCancel: () => canceled++ })
    assert.equal(view.button('正在上传').disabled, true)
    assert.equal(view.button('开始反推').disabled, true)
    await act(() => view.button('取消上传').click())
    assert.equal(canceled, 1)
  } finally { await view.destroy() }
})

test('pasting images uploads the first image once from clipboard items or files and supports replacing it', async () => {
  const uploads: File[] = []
  const callbacks = { onUpload: (file: File) => uploads.push(file) }
  const view = await mount({ ...callbacks, asset: undefined })
  try {
    const source = view.container.querySelector<HTMLElement>('.pc-image-analysis-source')!
    assert.equal(source.tabIndex, 0)
    assert.ok(source.hasAttribute('data-autofocus'))
    assert.match(source.textContent!, /⌘V \/ Ctrl\+V 粘贴图片/)
    const png = new dom.window.File(['png'], '截图.png', { type: 'image/png' }) as unknown as File
    const jpeg = new dom.window.File(['jpeg'], '照片.jpg', { type: 'image/jpeg' }) as unknown as File
    const webp = new dom.window.File(['webp'], '图片.webp', { type: 'image/webp' }) as unknown as File
    await act(() => {
      const event = paste(source, [png, jpeg])
      assert.equal(event.defaultPrevented, true)
    })
    assert.deepEqual(uploads, [png])
    await view.render(callbacks)
    const field = view.container.querySelector('textarea')!
    await act(() => {
      assert.equal(paste(field, [jpeg], []).defaultPrevented, true)
      assert.equal(paste(field, [webp], [{ kind: 'file', type: 'image/png', getAsFile: () => null }]).defaultPrevented, true)
    })
    assert.deepEqual(uploads, [png, jpeg, webp])
  } finally { await view.destroy() }
})

test('image paste is blocked during uploads, analysis, or another active task without reaching the canvas', async () => {
  const uploads: File[] = []
  const view = await mount()
  const file = new dom.window.File(['png'], '截图.png', { type: 'image/png' }) as unknown as File
  let bubbled = 0
  const onPaste = () => { bubbled++ }
  document.addEventListener('paste', onPaste)
  try {
    for (const state of [{ uploading: true }, { pending: true }, { otherPending: true }]) {
      await view.render({ ...state, onUpload: file => uploads.push(file) })
      await act(() => { assert.equal(paste(view.container.querySelector('section')!, [file]).defaultPrevented, true) })
    }
    assert.deepEqual(uploads, [])
    assert.equal(bubbled, 0)
  } finally { document.removeEventListener('paste', onPaste); await view.destroy() }
})

test('plain text and non-image clipboard files keep normal paste behavior in text fields', async () => {
  const uploads: File[] = []
  const view = await mount({ onUpload: file => uploads.push(file) })
  try {
    const file = new dom.window.File(['text'], '说明.txt', { type: 'text/plain' }) as unknown as File
    const field = view.container.querySelector('textarea')!
    await act(() => {
      assert.equal(paste(field, [], [{ kind: 'string', type: 'text/plain', getAsFile: () => null }]).defaultPrevented, false)
      assert.equal(paste(field, [file]).defaultPrevented, false)
    })
    assert.deepEqual(uploads, [])
  } finally { await view.destroy() }
})

test('text field length limits agree with persisted node and analysis request limits', async () => {
  const view = await mount()
  try {
    const fields = [...view.container.querySelectorAll('textarea')].filter(field => !field.hasAttribute('aria-hidden'))
    assert.equal(fields[0]?.maxLength, 4000)
    assert.equal(fields[1]?.maxLength, 20000)
  } finally { await view.destroy() }
})

test('clearing a source is explicit, unavailable during work, and keeps the result controlled by the parent', async () => {
  let cleared = 0
  const callbacks = { onClearSource: () => cleared++ }
  const view = await mount({ ...callbacks, prompt: '保留的专业提示词' })
  try {
    await act(() => view.button('清空来源图片').click())
    assert.equal(cleared, 1)
    assert.equal(view.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="完成图片分析后，提示词会显示在这里"]')!.value, '保留的专业提示词')
    for (const state of [{ pending: true }, { uploading: true }, { otherPending: true }]) {
      await view.render({ ...callbacks, ...state })
      assert.equal(view.button('清空来源图片').disabled, true)
    }
    await view.render({ ...callbacks, asset: undefined })
    assert.ok(!view.container.textContent!.includes('清空来源图片'))
    assert.ok(view.button('上传图片'))
  } finally { await view.destroy() }
})

test('copy uses the edited prompt and displays a visible fallback if clipboard access fails', async () => {
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
  const view = await mount({ prompt: '专业电影提示词' })
  try {
    await act(async () => { view.button('复制提示词').click(); await Promise.resolve() })
    assert.deepEqual(copied, ['专业电影提示词'])
    assert.ok(view.button('已复制'))
    await view.render({ prompt: '编辑后的版本' })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    await act(async () => { view.button('复制提示词').click(); await Promise.resolve() })
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /复制失败，请在下方选中提示词后复制/)
    assert.equal(view.button('创建图片生成节点').disabled, false)
  } finally { await view.destroy() }
})
