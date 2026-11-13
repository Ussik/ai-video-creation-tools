import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { CanvasContinuityResult } from '../src/features/canvas/canvas-continuity-review'
import { continuityFixture, continuityReport } from './fixtures/canvas-continuity'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'FormData']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Panel } = await import('../src/features/canvas/CanvasVideoContinuityCheck')
const { canvasContinuitySource } = await import('../src/features/canvas/canvas-continuity-review')
const { rememberModelSelection } = await import('../src/features/models/model-selection-store')
beforeEach(() => { dom.window.localStorage.clear(); rememberModelSelection('text', null) })
after(() => dom.window.close())

async function settle() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
async function mount(t: TestContext, options: { result?: CanvasContinuityResult; emptyModels?: boolean; post?: (init: RequestInit) => Promise<Response> } = {}) {
  const f = continuityFixture(), requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [], results: CanvasContinuityResult[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props = { detail: f.detail, request: f.request, models: options.emptyModels ? [] : f.models, providers: [f.provider], result: options.result,
    modifyAudio: false, onModifyAudio(value: boolean) { props.modifyAudio = value; render() },
    onResult(value: CanvasContinuityResult) { results.push(value); props.result = value; render() } }
  const render = () => root.render(<MantineProvider env="test"><Panel {...props} /></MantineProvider>)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init!.body)); requests.push({ url: String(url), init: init!, body })
    return options.post ? options.post(init!) : Response.json(continuityReport(body.source_signature))
  })
  await act(render); await settle()
  const button = (label: string) => {
    const element = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
    assert.ok(element, `button ${label}`); return element
  }
  const checkbox = (label: string) => {
    const text = [...container.querySelectorAll('label')].find(item => item.textContent?.trim() === label)
    assert.ok(text, `checkbox ${label}`)
    const element = document.getElementById(text.htmlFor) as HTMLInputElement; assert.ok(element); return element
  }
  return { f, props, requests, results, container, button, checkbox,
    rerender: async () => { await act(render); await settle() },
    click: async (label: string) => { const count = requests.length; await act(() => button(label).click()); await settle(); if (label === '核对当前版本' || label === '重新核对当前版本') for (let index = 0; requests.length === count && index < 100; index++) await act(() => new Promise(resolve => setTimeout(resolve, 1))); await settle() },
    choose: async (name: string) => {
      const label = [...container.querySelectorAll('label')].find(item => item.textContent === '核对模型')!;
      const input = document.getElementById(label.htmlFor)!;
      await act(() => input.click()); await settle()
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === name)
      assert.ok(option, `model ${name}`); await act(() => option.click()); await settle()
    }, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
const frameLabel = '同时核对前镜实际尾帧与本镜参考图'
const audioLabel = '允许按新设计修改已确认台词'
const acknowledgeLabel = '已查看问题，保留当前设计继续生成'

test('opening remains read-only and explicit checks send the exact target, trim snapshot and false audio permission', async t => {
  const view = await mount(t)
  try {
    assert.equal(view.requests.length, 0)
    assert.match(view.container.querySelector('img')!.getAttribute('src')!, /assets\/video\/frame\?time_ms=4950/)
    assert.equal(view.checkbox(frameLabel).disabled, true)
    assert.equal(view.checkbox(audioLabel).checked, false)
    await view.click('核对当前版本')
    assert.equal(view.requests.length, 1)
    assert.deepEqual(view.requests[0].body, { model_id: 'text', shot_id: 's2', target_model_id: 'seedance', prompt: view.f.request.prompt,
      generation_duration: 5, source_signature: canvasContinuitySource(view.f.detail, view.f.request).signature,
      mode: 'reference', generate_audio: true,
      storyboard_asset_id: 'still', include_frames: false, modify_audio: false })
    assert.equal(view.results[0].acknowledged, false)
    assert.match(view.container.textContent!, /声音未试听/)
    await act(() => view.checkbox(audioLabel).click()); await settle()
    await view.click('重新核对当前版本')
    assert.equal(view.requests[1].body.modify_audio, true)
    assert.notEqual(view.requests[1].body.source_signature, view.requests[0].body.source_signature)
  } finally { await view.destroy() }
})

test('pixel inspection is opt-in and is never sent to an incapable selected model', async t => {
  const view = await mount(t)
  try {
    await view.choose('图片模型')
    assert.equal(view.checkbox(frameLabel).checked, false)
    await act(() => view.checkbox(frameLabel).click()); await settle()
    await view.click('核对当前版本')
    assert.equal(view.requests[0].body.model_id, 'vision')
    assert.equal(view.requests[0].body.include_frames, true)
    await view.choose('文字模型')
    assert.equal(view.checkbox(frameLabel).disabled, true)
    await view.click('重新核对当前版本')
    assert.equal(view.requests[1].body.include_frames, false)
    assert.equal(view.requests[1].body.modify_audio, false)
  } finally { await view.destroy() }
})

test('historical reports remain readable while acknowledgement applies only to a matching current version', async t => {
  const view = await mount(t, { result: { report: continuityReport('historical-signature'), acknowledged: true } })
  try {
    assert.match(view.container.textContent!, /以下结果待复查/)
    assert.match(view.container.textContent!, /首帧已经睁眼/)
    assert.equal(view.container.textContent!.includes(acknowledgeLabel), false)
    await view.click('重新核对当前版本')
    assert.equal(view.checkbox(acknowledgeLabel).checked, false)
    await act(() => view.checkbox(acknowledgeLabel).click()); await settle()
    assert.equal(view.results.at(-1)!.acknowledged, true)
    view.props.request = { ...view.props.request, prompt: '新的本镜起点。' }; await view.rerender()
    assert.match(view.container.textContent!, /以下结果待复查/)
    assert.equal(view.container.textContent!.includes(acknowledgeLabel), false)
    await view.click('重新核对当前版本')
    assert.equal(view.checkbox(acknowledgeLabel).checked, false)
  } finally { await view.destroy() }
})

test('cancelling a request aborts it and an eventual stale completion cannot replace the existing report', async t => {
  let finish: (response: Response) => void = () => {}
  const report = continuityReport('existing-history')
  const view = await mount(t, { result: { report, acknowledged: false }, post: () => new Promise(resolve => { finish = resolve }) })
  try {
    await view.click('重新核对当前版本')
    const pending = view.requests[0]
    await view.click('取消核对')
    assert.equal(pending.init.signal!.aborted, true)
    await act(async () => finish(Response.json(continuityReport(String(pending.body.source_signature))))); await settle()
    assert.equal(view.results.length, 0)
    assert.equal(view.props.result!.report, report)
    assert.equal(view.button('重新核对当前版本').disabled, false)
  } finally { await view.destroy() }
})

test('changing selected media while a request runs aborts it, and a late old response cannot overwrite a new result', async t => {
  const finishes: Array<(response: Response) => void> = []
  const view = await mount(t, { post: () => new Promise(resolve => finishes.push(resolve)) })
  try {
    await view.click('核对当前版本')
    const old = view.requests[0]
    view.props.detail = structuredClone(view.props.detail)
    view.props.detail.timeline_clips[0].out_ms = 4000
    await view.rerender()
    assert.equal(old.init.signal!.aborted, true)
    await view.click('核对当前版本')
    const current = view.requests[1]
    assert.notEqual(current.body.source_signature, old.body.source_signature)
    await act(async () => finishes[1](Response.json({ ...continuityReport(String(current.body.source_signature)), summary: '当前版本的报告。' }))); await settle()
    await act(async () => finishes[0](Response.json({ ...continuityReport(String(old.body.source_signature)), summary: '旧版本的报告。' }))); await settle()
    assert.equal(view.results.length, 1)
    assert.match(view.container.textContent!, /当前版本的报告/)
    assert.doesNotMatch(view.container.textContent!, /旧版本的报告/)
  } finally { await view.destroy() }
})

test('a server response for a mismatched signature is discarded', async t => {
  const view = await mount(t, { post: async () => Response.json(continuityReport('not-the-requested-version')) })
  try {
    await view.click('核对当前版本')
    assert.equal(view.results.length, 0)
    assert.equal(view.button('核对当前版本').disabled, false)
  } finally { await view.destroy() }
})

test('models arriving asynchronously and replacement defaults remain selectable without remounting the panel', async t => {
  const view = await mount(t, { emptyModels: true })
  try {
    assert.equal(view.button('核对当前版本').disabled, true)
    view.props.models = view.f.models; await view.rerender()
    assert.equal(view.button('核对当前版本').disabled, false)
    await view.click('核对当前版本')
    assert.equal(view.requests[0].body.model_id, 'text')
    view.props.models = [view.f.models[1]]; await view.rerender()
    assert.equal(view.button('重新核对当前版本').disabled, false)
    await view.click('重新核对当前版本')
    assert.equal(view.requests[1].body.model_id, 'vision')
  } finally { await view.destroy() }
})
