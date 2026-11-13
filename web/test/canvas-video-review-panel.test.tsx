import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { VideoReviewReport } from '@video-studio/shared/media/video-review'
import type { CanvasVideoReviewPanelProps } from '../src/features/canvas/CanvasVideoReviewPanel'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
const { createRoot } = await import('react-dom/client')
const { default: Panel } = await import('../src/features/canvas/CanvasVideoReviewPanel')
const { rememberModelSelection } = await import('../src/features/models/model-selection-store')
beforeEach(() => rememberModelSelection('text', null))
after(() => dom.window.close())

const report: VideoReviewReport = {
  id: 'report-one', project_id: 'project', asset_id: 'video', shot_id: 'shot', model_id: 'vision', model_name: '画面理解模型',
  created_at: '2026-10-26T10:00:00Z', input_mode: 'sampled_frames', duration_ms: 4000, target_duration_ms: 2000, stale: false,
  summary: '主角笑意消退，但动作是否连续需要播放确认。', verdict: 'uncertain',
  findings: [{ id: 'finding', category: 'action', severity: 'warning', start_ms: 1200, end_ms: 2500, observation: '手部起止位置接近。', expected: '抬手后停在肩侧。', suggestion: '让抬手终态清楚可见。', evidence_times_ms: [1000, 2500] }],
  checks: [{ category: 'dialogue_audio', status: 'uncertain', detail: '抽样画面不能确认声音。' }],
  usable_ranges: [{ start_ms: 500, end_ms: 2500, reason: '此段包含表情变化。' }], limitations: ['连续运动与声音需要播放检查。'],
  evidence_frames: [{ time_ms: 1000, url: '/api/projects/project/assets/video/video-review-frame?time_ms=1000' }], sample_times_ms: [1000, 2500],
}
const defaults: CanvasVideoReviewPanelProps = { projectId: 'project', assetId: 'video', shotId: 'shot', models: [{ id: 'vision', label: '画面理解模型', inputMode: 'sampled_frames' }], onSeek() {}, onClose() {} }

async function mount(t: TestContext, props: Partial<CanvasVideoReviewPanelProps> = {}, history: VideoReviewReport[] = [report], post?: (init?: RequestInit) => Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init })
    return init?.method === 'POST' ? post ? post(init) : Response.json({ ...report, id: 'new-report' }) : Response.json({ reviews: history })
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<MantineProvider env="test"><Panel {...defaults} {...props} /></MantineProvider>) })
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
    assert.ok(found, `missing button ${label}`); return found
  }
  return { container, requests, button, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

async function chooseReviewModel(container: HTMLElement, name: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]'); assert.ok(input)
  await act(() => input.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === name)
  assert.ok(option, `model option ${name}`)
  await act(() => option.click())
}

test('opening review only reads history, preserves uncertainty and exposes timestamp evidence without editing the asset', async t => {
  const seeks: number[] = []
  const view = await mount(t, { onSeek: time => seeks.push(time) })
  try {
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].init?.method, undefined)
    assert.match(view.container.textContent!, /画面抽样/)
    assert.match(view.container.textContent!, /连续运动、滑步速度及声音仍需播放确认/)
    assert.match(view.container.textContent!, /素材 0:04.0.*计划入片 2.0 秒/)
    assert.match(view.container.textContent!, /待人工确认/)
    assert.match(view.container.textContent!, /尚未修改入片范围/)
    await act(() => view.button('播放问题片段 0:01.2').click())
    await act(() => view.button('查看 0:02.5').click())
    assert.deepEqual(seeks, [1200, 2500])
    assert.equal(view.requests.length, 1)
  } finally { await view.destroy() }
})

test('starting review explicitly sends selected model and shot, then shows persisted report', async t => {
  const view = await mount(t, {}, [])
  try {
    assert.equal(view.requests.length, 1)
    await act(async () => view.button('开始复核').click())
    assert.equal(view.requests.length, 2)
    assert.deepEqual(JSON.parse(String(view.requests[1].init?.body)), { model_id: 'vision', shot_id: 'shot', instructions: '' })
    assert.ok(view.requests[1].init?.signal)
    assert.match(view.container.textContent!, /主角笑意消退/)
    assert.ok(view.button('重新复核'))
  } finally { await view.destroy() }
})

test('review starts with the configured default among capable models', async t => {
  const view = await mount(t, { models: [...defaults.models, { id: 'default-vision', label: '默认画面理解模型', inputMode: 'sampled_frames', is_default: true }] }, [])
  try {
    assert.equal(view.requests.length, 1)
    await act(async () => view.button('开始复核').click())
    assert.equal(JSON.parse(String(view.requests[1].init?.body)).model_id, 'default-vision')
  } finally { await view.destroy() }
})

test('review panels follow an explicit shared text choice and remember it when reopened', async t => {
  const options = [...defaults.models, { id: 'recent-vision', label: '最近选择的复核模型', inputMode: 'sampled_frames' as const, is_default: true }]
  const first = await mount(t, { models: options }, []), second = await mount(t, { models: options }, [])
  try {
    await chooseReviewModel(first.container, defaults.models[0]!.label)
    assert.equal(first.container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]')!.value, defaults.models[0]!.label)
    assert.equal(second.container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]')!.value, defaults.models[0]!.label)
    assert.ok(first.requests.every(item => item.init?.method !== 'POST'))
    assert.ok(second.requests.every(item => item.init?.method !== 'POST'))
  } finally { await second.destroy(); await first.destroy() }
  const reopened = await mount(t, { models: options }, [])
  try {
    assert.equal(reopened.container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]')!.value, defaults.models[0]!.label)
    await act(async () => reopened.button('开始复核').click())
    assert.equal(JSON.parse(String(reopened.requests[1]!.init?.body)).model_id, defaults.models[0]!.id)
  } finally { await reopened.destroy() }
})

test('a pending review pins its request model until completion before following a newer compatible preference', async t => {
  const alternate = { id: 'alternate-vision', label: '另一复核模型', inputMode: 'sampled_frames' as const }
  let finish: ((response: Response) => void) | undefined
  const view = await mount(t, { models: [...defaults.models, alternate] }, [], () => new Promise(resolve => { finish = resolve }))
  try {
    await chooseReviewModel(view.container, alternate.label)
    await act(() => view.button('开始复核').click())
    assert.equal(JSON.parse(String(view.requests[1]!.init?.body)).model_id, alternate.id)
    await act(() => rememberModelSelection('text', defaults.models[0]!.id))
    assert.equal(view.container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]')!.value, alternate.label)
    assert.equal(view.requests.length, 2)
    await act(async () => finish!(Response.json({ ...report, model_id: alternate.id })))
    assert.equal(view.container.querySelector<HTMLInputElement>('input[aria-label="成片复核模型"]')!.value, defaults.models[0]!.label)
    assert.equal(view.requests.length, 2)
  } finally { await view.destroy() }
})

test('cancellation aborts the pending request and retains an existing report', async t => {
  let signal: AbortSignal | null | undefined
  const view = await mount(t, {}, [report], init => new Promise((_resolve, reject) => {
    signal = init?.signal
    signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')))
  }))
  try {
    await act(() => view.button('重新复核').click())
    assert.equal(view.button('重新复核').disabled, true)
    assert.match(view.container.textContent!, /正在分析画面/)
    await act(async () => view.button('取消复核').click())
    assert.equal(signal?.aborted, true)
    assert.match(view.container.textContent!, /已有报告保留/)
    assert.match(view.container.textContent!, /主角笑意消退/)
    assert.equal(view.button('重新复核').disabled, false)
  } finally { await view.destroy() }
})

test('provider failures keep the previous report visible and allow retry', async t => {
  const view = await mount(t, {}, [report], async () => Response.json({ detail: '服务商不接受视频输入' }, { status: 502 }))
  try {
    await act(async () => view.button('重新复核').click())
    assert.match(view.container.textContent!, /复核未完成.*服务商不接受视频输入/)
    assert.match(view.container.textContent!, /主角笑意消退/)
    assert.equal(view.button('重新复核').disabled, false)
  } finally { await view.destroy() }
})

test('missing capable models disables paid review while keeping historical and stale reports readable', async t => {
  const view = await mount(t, { models: [] }, [{ ...report, stale: true }])
  try {
    assert.equal(view.button('重新复核').disabled, true)
    assert.match(view.container.textContent!, /暂无可用的复核模型/)
    assert.match(view.container.textContent!, /报告依据已变化/)
    assert.match(view.container.textContent!, /主角笑意消退/)
    assert.equal(view.requests.length, 1)
  } finally { await view.destroy() }
})
