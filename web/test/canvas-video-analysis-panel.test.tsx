import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import type { VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import type { CanvasVideoAnalysisPanelProps } from '../src/features/canvas/CanvasVideoAnalysisPanel'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Event', 'MouseEvent', 'HTMLTextAreaElement', 'HTMLVideoElement', 'HTMLInputElement', 'ShadowRoot', 'Document']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Panel } = await import('../src/features/canvas/CanvasVideoAnalysisPanel')
after(() => dom.window.close())

const noop = () => {}
const asset = { id: 'video', url: '/api/assets/video/file', label: '仙侠参考.mp4' }
const result: VideoPromptAnalysisResult = { asset_id: 'video', model_id: 'doubao', duration_ms: 90_000, start_ms: 0, end_ms: 90_000, fps: 2,
  global_style: '冷色云海，暖金剑光，厚重石材', uncertainties: ['声音未分析'], shots: [{ title: '踏步挥剑', start_ms: 10_000, end_ms: 15_000,
    start_state: '人物右脚后撤', action: '踏步挥剑', end_state: '碎石落下', camera: '低机位前移', vfx: '剑气切开石阶，尘浪后至',
    image_prompt: '人物站在石阶前，持剑横于胸前', video_prompt: '人物踏步挥剑，剑气切开石阶，尘浪随后扩散。', uncertainties: ['接触瞬间待播放确认'] }] }
const defaults: CanvasVideoAnalysisPanelProps = { asset, models: [{ id: 'doubao', label: '豆包视频模型' }], modelId: 'doubao', instructions: '',
  startMs: 0, endMs: null, durationMs: 90_000, fps: 2, onUpload: noop, onModelChange: noop, onInstructionsChange: noop,
  onRangeChange: noop, onFpsChange: noop, onResultChange: noop, onAnalyze: noop, onCreateGeneration: noop }

async function mount(overrides: Partial<CanvasVideoAnalysisPanelProps> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (props: Partial<CanvasVideoAnalysisPanelProps>) => { await act(() => root.render(<MantineProvider env="test"><Panel {...defaults} {...props} /></MantineProvider>)) }
  try { await render(overrides) } catch (error) { await act(() => root.unmount()); container.remove(); throw error instanceof AggregateError ? error.errors[0] : error }
  const button = (label: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label); assert.ok(found, `missing button: ${label}`); return found }
  const textarea = (label: string) => {
    const found = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => container.querySelector(`label[for="${node.id}"]`)?.textContent?.startsWith(label))
    assert.ok(found, `missing textarea: ${label}`); return found
  }
  return { container, render, button, textarea, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('video source and explicitly configured model are required, and the 90-second scope is displayed', async () => {
  let analyzed = 0
  const view = await mount({ asset: undefined, onAnalyze: () => analyzed++ })
  try {
    assert.equal(view.button('开始反推').disabled, true)
    assert.match(view.container.textContent!, /上传视频，或连接画布中的视频节点/)
    await view.render({ models: [], modelId: '' })
    assert.equal(view.button('开始反推').disabled, true)
    assert.match(view.container.textContent!, /暂无可用的豆包视频理解模型/)
    assert.match(view.container.textContent!, /视频输入格式设为“豆包视频理解”/)
    await view.render({ onAnalyze: () => analyzed++ })
    assert.equal(view.button('开始反推').disabled, false)
    assert.match(view.container.textContent!, /本次选取 90.00 秒/)
    assert.equal(view.container.querySelector('video')?.getAttribute('src'), asset.url)
    assert.equal(view.container.querySelector('video')?.hasAttribute('controls'), false)
    await act(() => view.button('开始反推').click())
    assert.equal(analyzed, 1)
  } finally { await view.destroy() }
})

test('invalid scopes cannot be analyzed and active jobs preserve prior output while allowing cancellation', async () => {
  let canceled = 0
  const view = await mount({ durationMs: 200_000 })
  try {
    assert.equal(view.button('开始反推').disabled, true)
    assert.match(view.container.textContent!, /每次最多分析 180 秒/)
    await view.render({ startMs: 40_000, endMs: 30_000 })
    assert.equal(view.button('开始反推').disabled, true)
    assert.match(view.container.textContent!, /结束时间必须晚于/)
    await view.render({ result, pending: true, elapsedSeconds: 65, onCancel: () => canceled++ })
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /正在分析视频，已等待 65 秒，可取消后重试/)
    assert.equal(view.button('重新反推').disabled, true)
    assert.equal(view.button('替换视频').disabled, true)
    assert.equal(view.button('创建当前镜头视频节点').disabled, true)
    assert.equal(view.textarea('视频提示词').value, result.shots[0].video_prompt)
    assert.ok([...view.container.querySelectorAll('textarea')].every(field => field.disabled))
    await act(() => view.button('取消反推').click())
    assert.equal(canceled, 1)
    await view.render({ result, otherPending: true, onCancel: () => canceled++ })
    assert.match(view.container.textContent!, /另一个反推节点正在处理/)
    assert.equal(view.container.querySelector('[role="status"]'), null)
    assert.ok(!view.container.textContent!.includes('取消反推'))
  } finally { await view.destroy() }
})

test('edited style and prompts are returned as a full controlled result, copied, and only explicitly applied', async () => {
  const changed: VideoPromptAnalysisResult[] = [], copied: string[] = [], created: number[] = []
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  const callbacks = { onResultChange: (value: VideoPromptAnalysisResult) => changed.push(value), onCreateGeneration: (index: number) => created.push(index) }
  const view = await mount({ result, ...callbacks })
  const edit = async (label: string, value: string) => { const field = view.textarea(label); await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }) }
  try {
    assert.deepEqual(created, [])
    assert.match(view.container.textContent!, /起始状态人物右脚后撤/)
    assert.match(view.container.textContent!, /剑气切开石阶，尘浪后至/)
    await edit('整体画风', '用户修改的国漫画风')
    assert.equal(changed.at(-1)!.global_style, '用户修改的国漫画风')
    assert.equal(result.global_style, '冷色云海，暖金剑光，厚重石材')
    await view.render({ result: changed.at(-1), ...callbacks })
    await edit('视频提示词', '用户修改的动作时序')
    assert.equal(changed.at(-1)!.shots[0].video_prompt, '用户修改的动作时序')
    assert.equal(changed.at(-1)!.shots[0].image_prompt, result.shots[0].image_prompt)
    await view.render({ result: changed.at(-1), ...callbacks })
    await act(async () => { view.button('复制当前镜头').click(); await Promise.resolve() })
    assert.equal(copied[0], '画风与视觉：用户修改的国漫画风\n\n用户修改的动作时序')
    await act(async () => { view.button('复制全部镜头').click(); await Promise.resolve() })
    assert.match(copied[1], /整体画风：用户修改的国漫画风/)
    assert.match(copied[1], /10.00–15.00 秒\n用户修改的动作时序/)
    await act(() => view.button('创建当前镜头视频节点').click())
    assert.deepEqual(created, [0])
    await view.render({ result, asset: { ...asset, id: 'replaced' }, ...callbacks })
    assert.match(view.container.textContent!, /来源视频已变化/)
    assert.equal(view.button('创建当前镜头视频节点').disabled, true)
    assert.equal(view.textarea('视频提示词').value, result.shots[0].video_prompt)
  } finally { await view.destroy() }
})

test('upload selection permits reselecting the same MP4/MOV and metadata reports the actual duration', async () => {
  const uploads: File[] = [], durations: number[] = []
  const view = await mount({ onUpload: file => uploads.push(file), onDurationChange: duration => durations.push(duration) })
  try {
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    assert.equal(input.accept, 'video/mp4,video/quicktime,.mp4,.mov')
    const file = new dom.window.File(['video'], '参考.mov', { type: 'video/quicktime' }) as unknown as File
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    assert.deepEqual(uploads, [file, file])
    const media = view.container.querySelector('video')!
    Object.defineProperty(media, 'duration', { configurable: true, value: 90.25 })
    await act(() => media.dispatchEvent(new dom.window.Event('loadedmetadata', { bubbles: true })))
    assert.deepEqual(durations, [90_250])
    let canceled = 0
    await view.render({ uploading: true, onCancel: () => canceled++ })
    assert.equal(view.button('正在上传').disabled, true)
    await act(() => view.button('取消上传').click())
    assert.equal(canceled, 1)
  } finally { await view.destroy() }
})

test('shot evidence locates the original source time without issuing an analysis or generation request', async () => {
  let plays = 0
  const view = await mount({ result })
  try {
    const media = view.container.querySelector('video')!
    media.play = async () => { plays++ }
    await act(() => view.button('查看 0:10.00–0:15.00').click())
    assert.equal(media.currentTime, 10)
    assert.equal(plays, 1)
  } finally { await view.destroy() }
})
