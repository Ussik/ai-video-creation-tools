import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { layoutContext, layoutDetail, layoutModels, layoutSignature, layoutSnapshot, referenceLayoutStates } from './helpers/canvas-reference-layout'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}; dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: Production } = await import('../src/features/storyboard/StoryboardProductionDialog')
const { default: Planner } = await import('../src/features/storyboard/StoryboardPlanner')
const { ReferenceStopAction, default: Recovery } = await import('../src/features/storyboard/ReferencePreparationRecovery')
const { ReferencePreparationProgress } = await import('../src/features/storyboard/ReferencePreparationProgress')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)

for (const entry of ['production', 'planner'] as const) for (const state of referenceLayoutStates) test(`${entry} ${state}: concise outcome and fixed footer actions`, async t => {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear()
  const requests: string[] = [], snapshot = layoutSnapshot(state)
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/canvas/recovery')) { if (state === 'error') throw new Error('隔离读取失败'); return Response.json(snapshot) }
    if (path.endsWith('/storyboard/context')) return Response.json(layoutContext)
    if (path === '/api/projects/layout-project') return Response.json(layoutDetail)
    if (state === 'preparing' && path.endsWith('/canvas/check')) return Response.json({ signature: layoutSignature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (state === 'preparing' && path.endsWith('/canvas/prepare')) return new Promise<Response>(() => {})
    throw new Error(`Unexpected mutation: ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async () => act(async () => root.render(<MantineProvider env="test">{entry === 'production'
    ? <Production projectId="layout-project" sceneIds={['scene']} shotIds={['shot']} designId={null} models={layoutModels} onCancel={() => {}} onComplete={() => {}} />
    : <Planner opened detail={layoutDetail} models={layoutModels} initialSceneIds={['scene']} onClose={() => {}} onRefresh={async () => {}} onNotice={() => {}} onOpenCanvas={() => {}} />}</MantineProvider>))
  try {
    await render(); await act(async () => {})
    if (state === 'preparing') await act(async () => { byText('加入画布')!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    const footer = document.querySelector(entry === 'production' ? '.storyboard-production-actions' : '.storyboard-planner-actions')!
    const working = ['preparing', 'running', 'cancelling'].includes(state)
    assert.equal(footer.querySelector('.reference-stop-action'), null, 'closing detaches; canvas entry points do not offer task cancellation')
    assert.ok(footer.querySelector('.reference-footer-primary-actions')?.contains(byText('关闭')!))
    const primary = footer.querySelector(entry === 'production' ? '.storyboard-production-primary' : '.storyboard-planner-primary')
    assert.equal(!!primary, !working && state !== 'unknown' && state !== 'error', 'running states use compact footer progress instead of a grey primary')
    const status = document.querySelector('.reference-run-status')
    assert.equal(!!status, !working && state !== 'idle', 'the detailed upper status is absent while work runs')
    assert.equal(document.querySelectorAll('.reference-run-status').length, working || state === 'idle' ? 0 : 1)
    assert.equal(document.querySelectorAll('.reference-run-status button').length, ['error', 'unknown', 'limited'].includes(state) ? 1 : 0)
    assert.equal(byText('刷新状态') !== undefined, ['error', 'unknown', 'limited'].includes(state))
    assert.equal(byText('重试') !== undefined, state === 'partial' || state === 'limited')
    if (working) {
      const activity = footer.querySelector('[aria-label="画布准备进度"]')!
      assert.ok(activity, 'running progress occupies the fixed footer')
      assert.equal(footer.firstElementChild, activity, 'the compact activity stays left of the action group')
      assert.equal(document.querySelectorAll('[aria-label="画布准备进度"]').length, 1)
      assert.match(activity.textContent!, /^正在.+ · \d+ 秒$/)
      assert.ok(activity.querySelector('.mantine-Loader-root'))
      assert.equal(document.querySelector('[aria-label="整理参考设定文本模型"]'), null)
      assert.equal(document.querySelector('.reference-preparation-model'), null)
      assert.equal(document.querySelector('.reference-preparation-links'), null)
      assert.equal(document.querySelector('.reference-failure-panel'), null)
      assert.equal(document.querySelector('.reference-step-history'), null)
      assert.doesNotMatch(document.body.textContent!, /已完成 3\/5|步骤记录|当前运行请求|累计请求|停止任务|请求编号|执行者|详情/)
      if (state === 'running') assert.match(activity.textContent!, /正在整理人物和道具/)
      if (entry === 'production') assert.match(document.querySelector('.storyboard-production-context')!.textContent!, /1 个镜头来自 1 场/)
    }
    if (!working) {
      assert.equal(document.querySelector('.reference-preparation-links'), null)
      assert.equal(document.querySelector('.reference-failure-panel'), null)
      assert.doesNotMatch(document.body.textContent!, /用途仲裁|本地校验|累计请求|旧参考15|详情/)
    }
    if (state === 'limited') {
      assert.match(document.body.textContent!, /未能加入画布/)
      assert.equal(byText('继续覆盖检查'), undefined)
      assert.ok((primary as HTMLButtonElement).disabled, 'exhausted capabilities never fabricate a retry')
      const reads = requests.length
      await act(() => byText('刷新状态')!.click())
      assert.equal(requests.length, reads + 1, 'refresh only reads status')
    }
    assert.ok(!requests.some(path => path.endsWith('/cancel') || path.endsWith('/commit')), 'no business writes or real task stops')
  } finally { await act(() => root.unmount()); container.remove() }
})

for (const entry of ['production', 'planner']) test(`${entry}: blocked coverage starts directly without a second dialog`, async t => {
  const snapshot = layoutSnapshot('limited'); snapshot.preparation!.can_restart_all = true
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/storyboard/context')) return Response.json(layoutContext)
    if (path === '/api/projects/layout-project') return Response.json(layoutDetail)
    if (path.endsWith('/canvas/check')) return Response.json({ signature: layoutSignature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/canvas/prepare')) return Response.json({ ...snapshot.plan, preparation: snapshot.preparation })
    return Response.json(snapshot)
  })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MantineProvider env="test">{entry === 'production'
      ? <Production projectId="layout-project" sceneIds={['scene']} shotIds={['shot']} designId={null} models={layoutModels} onCancel={() => {}} onComplete={() => {}} />
      : <Planner opened detail={layoutDetail} models={layoutModels} initialSceneIds={['scene']} onClose={() => {}} onRefresh={async () => {}} onNotice={() => {}} onOpenCanvas={() => {}} />}</MantineProvider>))
    await act(async () => {})
    assert.ok(!document.querySelector('.reference-failure-panel'), 'result does not expose per-object processing')
    assert.equal(byText('重新整理')!.disabled, false)
    assert.match(document.body.textContent!, /未能加入画布/)
    assert.doesNotMatch(document.body.textContent!, /用途仲裁|4\/4|详情/)
    await act(async () => { byText('重新整理')!.click(); byText('重新整理')?.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(requests.filter(path => path.endsWith('/canvas/prepare')).length, 1, 'one click starts preparation and repeated clicks do not duplicate it')
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
    assert.equal(byText('确认重新整理'), undefined)
  } finally { await act(() => root.unmount()) }
})

test('stop confirmation cannot stop a replacement run', async () => {
  let stops = 0
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const caps = layoutSnapshot('running').preparation!
  const render = async (run: string) => act(async () => root.render(<MantineProvider env="test"><ReferenceStopAction capabilities={{ ...caps, run_id: run }} onStop={async () => { stops++ }} /></MantineProvider>))
  try {
    await render('first'); await act(() => byText('停止任务')!.click()); await render('replacement')
    assert.equal(byText('确认停止任务')!.disabled, true)
    await act(() => byText('确认停止任务')!.click()); assert.equal(stops, 0)
  } finally { await act(() => root.unmount()) }
})


test('stop confirmation dispatches once despite repeated confirmation clicks', async () => {
  let stops = 0, release!: () => void
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MantineProvider env="test"><ReferenceStopAction capabilities={layoutSnapshot('running').preparation} onStop={async () => { stops++; await new Promise<void>(resolve => { release = resolve }) }} /></MantineProvider>))
    await act(() => byText('停止任务')!.click())
    await act(() => { const confirm = byText('确认停止任务')!; confirm.click(); confirm.click() })
    assert.equal(stops, 1)
    await act(async () => release())
  } finally { await act(() => root.unmount()) }
})


test('running progress shows only real counters, collapses history and respects local save phases', async () => {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const caps = layoutSnapshot('running').preparation!
  const render = async (progress?: { label: string; completed_units: number; total_units: number | null }, activity?: string) => act(async () => root.render(<MantineProvider env="test"><ReferencePreparationProgress capabilities={{ ...caps, inspection: { ...caps.inspection!, progress, steps: [
    { phase_id: 'catalog', label: '确定对象目录', completed_units: 1, total_units: 1 },
    { phase_id: 'profiles', label: '整理人物', completed_units: 3, total_units: 5 },
  ] } }} activity={activity} /></MantineProvider>))
  try {
    await render()
    assert.match(document.querySelector('.reference-current-step')!.textContent!, /等待服务端更新当前步骤/)
    assert.equal(document.querySelector('.reference-progress-count'), null)
    assert.equal(document.querySelector('.reference-step-history ul'), null)
    await act(() => byText('步骤记录（2）')!.click())
    assert.equal(document.querySelectorAll('.reference-step-history li').length, 2)
    await render({ label: '读取目录', completed_units: 2, total_units: null })
    assert.equal(document.querySelector('.reference-progress-count')!.textContent, '已完成 2')
    await render({ label: '无效计数', completed_units: 6, total_units: 5 })
    assert.equal(document.querySelector('.reference-progress-count'), null)
    await render({ label: '整理人物', completed_units: 3, total_units: 5 }, '正在保存参考设定')
    assert.match(document.querySelector('.reference-current-step')!.textContent!, /正在保存参考设定/)
    assert.equal(document.querySelector('.reference-progress-count'), null)
  } finally { await act(() => root.unmount()) }
})

test('background hint requires a confirmed detached executor', async () => {
  const root = createRoot(document.body.appendChild(document.createElement('div'))), caps = layoutSnapshot('running').preparation!
  try {
    for (const executor of ['active', 'external', 'retired', 'none'] as const) {
      await act(async () => root.render(<MantineProvider env="test"><Recovery capabilities={{ ...caps, inspection: { ...caps.inspection!, executor } }} sceneCount={1} busy onReload={() => {}} onRestart={() => {}} /></MantineProvider>))
      assert.equal(!!document.querySelector('.reference-preparation-background'), executor === 'active' || executor === 'external')
    }
  } finally { await act(() => root.unmount()) }
})

test('stop confirmation cannot stop a replacement owner in the same run', async () => {
  let stops = 0
  const root = createRoot(document.body.appendChild(document.createElement('div'))), caps = layoutSnapshot('running').preparation!
  const render = async (owner: string) => act(async () => root.render(<MantineProvider env="test"><ReferenceStopAction capabilities={{ ...caps, inspection: { ...caps.inspection!, owner_request_id: owner } }} onStop={async () => { stops++ }} /></MantineProvider>))
  try {
    await render('first'); await act(() => byText('停止任务')!.click()); await render('replacement')
    assert.equal(byText('确认停止任务')!.disabled, true)
    await act(() => byText('确认停止任务')!.click()); assert.equal(stops, 0)
  } finally { await act(() => root.unmount()) }
})
