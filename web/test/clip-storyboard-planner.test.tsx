import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, ScriptCanvasResult } from '../src/shared/api/api'
import { rememberModelSelection } from '../src/features/models/model-selection-store'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ClipStoryboardPlanner } = await import('../src/features/storyboard/ClipStoryboardPlanner')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
beforeEach(() => { dom.window.localStorage.clear(); dom.window.sessionStorage.clear() })
const detail = { id: 'clip-project', name: '片段项目', ratio: '9:16', script: { scenes: [] }, shots: [], assets: [] } as unknown as ProjectDetail
const models = [{ id: 'text', modality: 'text', enabled: true, name: '文本模型' }] as Model[]
const signature = 'a'.repeat(64), planSignature = 'b'.repeat(64), source = '少女走进车站，发现列车已经离开。'
const skills = [{ id: 'skill', name: '短片分镜技能', description: '镜头与接镜', revision: '1234567890abcdef' }]
const context = { signature, project: { name: detail.name, brief: '', ratio: '9:16', style: '日漫' }, skills, default_skill_ids: ['skill'],
  skill_policy: { stage: 'storyboard', label: '分镜规划', primary_id: 'skill', auxiliary_ids: [], source: 'global', warning: '', skills } }
const acceptedReview = { status: 'passed', review_id: 'clip-review', repaired: false, issues: [], content_signature: 'c'.repeat(64) }
const draft = { directing_review: acceptedReview, signature: planSignature, source_text: source, total_duration: 30, instructions: '', shots: [
  { title: '进站', prompt: '少女进入车站', image_prompt: '少女站在车站门口', video_prompt: '少女推门进入，镜头跟随', duration: 15, start_state: '站在门外', end_state: '进入月台', cut_note: '接空月台' },
  { title: '空站台', prompt: '少女望向空月台', image_prompt: '少女与空月台', video_prompt: '少女停下，镜头推近', duration: 15, start_state: '进入月台', end_state: '低头', cut_note: '' },
], used_skills: [{ ...skills[0], files: ['SKILL.md'], role: 'primary' }], skill_assignment: { ids: ['skill'], source: 'automatic', reason: '这段内容需要突出转折和人物反应。' } }
const saved = { scene_ids: [], design_id: 'clip-design', target_canvas_id: null, shots: [{ id: 'new-shot' }], visual_profiles: [], shot_visual_bindings: [], created_shots: 2, created_profiles: 0 } as unknown as ScriptCanvasResult
const requests: Array<{ path: string; method: string; body: any }> = []
function button(label: string) { const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label); assert.ok(element, label); return element }
function input(label: string) { const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(element, label); return element }
async function fill(label: string, value: string) {
  await act(() => { const element = input(label), prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function mount(options: { close?: () => void; refresh?: () => Promise<unknown>; saved?: (result: ScriptCanvasResult) => void | Promise<void>; models?: Model[] } = {}) {
  requests.length = 0
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (opened = true, project = detail) => act(async () => root.render(<MantineProvider env="test"><ClipStoryboardPlanner opened={opened} detail={project} models={options.models || models}
    onClose={options.close || (() => {})} onRefresh={options.refresh || (async () => {})} onSaved={options.saved || (() => {})} onNotice={() => {}} /></MantineProvider>))
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function mockApi(t: TestContext, handler?: (path: string, body: any, init?: RequestInit) => Response | Promise<Response> | undefined) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body, method: init?.method || 'GET' })
    const custom = handler?.(path, body, init)
    if (custom) return custom
    if (path.endsWith('/context')) return Response.json(context)
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/review')) return Response.json({ ...acceptedReview, review_id: 'reviewed-clip' })
    if (path.endsWith('/commit')) return Response.json(saved)
    throw new Error(`Unexpected ${path}`)
  })
}
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, `等待${label}超时`)
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)) })
  }
}
async function startPlanning(options: { pending?: boolean; repeated?: boolean } = {}) {
  const before = requests.filter(request => request.path.endsWith('/plan')).length
  await act(async () => { button('开始规划').click(); if (options.repeated) button('开始规划').click() })
  // Request identity uses asynchronous SHA256 before fetch. Wait for the actual
  // transport boundary, and retain the deliberate pending state in race tests.
  await waitFor(() => requests.filter(request => request.path.endsWith('/plan')).length > before, '规划请求派发')
  if (!options.pending) await waitFor(() => !!document.querySelector('[aria-label="镜头 1 标题"]') || !!document.querySelector('[role="alert"]'), '规划预览或错误')
}
async function plan(options: { pending?: boolean } = {}) { await fill('片段内容', source); await startPlanning(options) }
async function chooseSkill(value: string) {
  await act(() => button('分镜规划技能选择').click())
  await act(() => input('storyboard主技能').click())
  const option = document.querySelector<HTMLElement>(`[role="option"][value="${value}"]`); assert.ok(option, value)
  await act(() => option.click())
  await act(() => button('分镜规划技能选择').click())
}

test('shared choices stay frozen during clip planning and preserve the result while blocking stale saves', async t => {
  let finishPlan!: (response: Response) => void
  mockApi(t, path => path.endsWith('/plan') ? new Promise<Response>(resolve => { finishPlan = resolve }) : undefined)
  const view = await mount({ models: [...models, { ...models[0], id: 'other-text', name: '另一文本模型' }] })
  try {
    await plan({ pending: true })
    await act(() => rememberModelSelection('text', 'other-text'))
    assert.equal(input('规划文本模型').value, '文本模型')
    await act(async () => finishPlan(Response.json(draft)))
    assert.equal(input('镜头 1 标题').value, '进站')
    assert.equal(button('保存分镜').disabled, true)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /文本模型已切换.*预览仍保留/)
    await act(() => button('规划设置').click())
    assert.equal(input('规划文本模型').value, '另一文本模型')
    await act(() => rememberModelSelection('text', 'text'))
    await act(() => button('镜头预览').click())
    assert.equal(button('保存分镜').disabled, false)
    assert.equal(requests.filter(request => request.path.endsWith('/plan')).length, 1)
    assert.equal(requests.some(request => request.path.endsWith('/commit')), false)
  } finally { await view.destroy() }
})

test('opening a clip planner reads metadata only; automatic planning omits skill ids and optional count', async t => {
  mockApi(t)
  const view = await mount()
  try {
    assert.deepEqual(requests.map(item => [item.method, item.path.split('/').at(-1)]), [['GET', 'context']])
    assert.equal(button('开始规划').disabled, true)
    await plan()
    const body = requests.find(item => item.path.endsWith('/plan'))!.body
    assert.deepEqual(body, { signature, source_text: source, total_duration: 30, instructions: '', model_id: 'text' })
    assert.match(document.querySelector('[aria-label="实际使用的分镜技能"]')!.textContent!, /短片分镜技能/)
    assert.match(document.querySelector('[aria-label="实际使用的分镜技能"]')!.textContent!, /12345678/)
    assert.match(document.body.textContent!, /这段内容需要突出转折和人物反应/)
    assert.equal(requests.some(item => /canvas|prepare|commit/.test(item.path)), false)
  } finally { await view.destroy() }
})

test('manual clip edits can be explicitly reviewed without saving or replacing the edited text', async t => {
  mockApi(t, path => path.endsWith('/plan') ? Response.json({ ...draft, directing_review: acceptedReview })
    : path.endsWith('/review') ? Response.json({ ...acceptedReview, review_id: 'edited-review', content_signature: 'd'.repeat(64) }) : undefined)
  const view = await mount()
  try {
    await plan(); await fill('镜头 1 首帧图片提示词', '手改低头起点，尚未抬眼')
    assert.match(document.body.textContent!, /草稿已修改，当前版本尚未复核/)
    assert.equal(button('保存分镜').disabled, true)
    await act(async () => button('复查当前草稿').click())
    await waitFor(() => document.body.textContent!.includes('首帧、运镜、声音设计与接镜文字复核已完成'), '当前草稿复核完成')
    const review = requests.find(request => request.path.endsWith('/review'))!
    assert.equal(review.body.shots[0].image_prompt, '手改低头起点，尚未抬眼')
    assert.equal(input('镜头 1 首帧图片提示词').value, '手改低头起点，尚未抬眼')
    assert.match(document.body.textContent!, /首帧、运镜、声音设计与接镜文字复核已完成/)
    assert.equal(requests.some(request => request.path.endsWith('/commit')), false)
    assert.equal(requests.filter(request => request.path.endsWith('/plan')).length, 1)
  } finally { await view.destroy() }
})

test('manual skill and explicit base rules take precedence; clearing a suggested count restores omission', async t => {
  mockApi(t)
  const view = await mount()
  try {
    await fill('片段内容', source); await fill('建议镜头数', '2'); await chooseSkill('skill')
    await startPlanning()
    assert.deepEqual(requests.at(-1)!.body.skill_ids, ['skill']); assert.equal(requests.at(-1)!.body.shots_count, 2)
    await act(() => button('规划设置').click()); await chooseSkill('__base__')
    await act(() => button('放弃预览').click())
    await fill('建议镜头数', '')
    await startPlanning()
    assert.deepEqual(requests.at(-1)!.body.skill_ids, []); assert.equal(Object.hasOwn(requests.at(-1)!.body, 'shots_count'), false)
  } finally { await view.destroy() }
})

test('edited preview validates total duration and saves only the clip plan before returning to management', async t => {
  mockApi(t); const order: string[] = []
  const view = await mount({ refresh: async () => { order.push('refresh') }, saved: result => { assert.equal(result.design_id, 'clip-design'); order.push('saved') }, close: () => { order.push('close') } })
  try {
    await plan(); await fill('镜头 1 首帧图片提示词', '修改后的开镜')
    await fill('镜头 1 时长', '14')
    assert.equal(button('保存分镜').disabled, true)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /合计时长/)
    await fill('镜头 1 时长', '15')
    assert.equal(button('保存分镜').disabled, true, 'manual changes require a current review')
    await act(async () => button('复查当前草稿').click())
    await waitFor(() => !button('保存分镜').disabled, '修改后复核')
    await act(async () => button('保存分镜').click())
    const commit = requests.find(item => item.path.endsWith('/commit'))!.body
    assert.equal(commit.shots[0].image_prompt, '修改后的开镜'); assert.equal(commit.signature, planSignature)
    assert.equal(commit.source_text, source); assert.equal(commit.total_duration, 30)
    assert.equal(commit.review_id, 'reviewed-clip')
    assert.match(commit.request_id, /^[\da-f-]{36}$/)
    assert.deepEqual(order, ['refresh', 'saved', 'close'])
    assert.equal(requests.some(item => /canvas|prepare/.test(item.path)), false)
    assert.equal(dom.window.sessionStorage.length, 0)
  } finally { await view.destroy() }
})

test('configuration changes and closing require discarding the unsaved preview; cancellation preserves it', async t => {
  mockApi(t); let closed = 0
  const view = await mount({ close: () => { closed++ } })
  try {
    await plan(); await act(() => button('规划设置').click()); await fill('总时长', '45')
    assert.match(document.body.textContent!, /放弃未保存的分镜预览/)
    await act(() => button('继续编辑').click())
    assert.equal(input('总时长').value, '30')
    await act(() => button('镜头预览').click()); assert.equal(input('镜头 1 标题').value, '进站')
    const unload = new dom.window.Event('beforeunload', { cancelable: true }); dom.window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true)
    await act(() => button('关闭片段分镜规划').click()); assert.equal(closed, 0)
    await act(() => button('继续编辑').click()); assert.equal(closed, 0)
    await act(() => button('关闭片段分镜规划').click()); await act(() => button('放弃预览').click()); assert.equal(closed, 1)
  } finally { await view.destroy() }
})

test('a completed save followed by refresh failure retries callbacks without another commit', async t => {
  mockApi(t); let refreshes = 0, callbacks = 0
  const view = await mount({ refresh: async () => { if (++refreshes === 1) throw new Error('刷新断开') }, saved: () => { callbacks++ } })
  try {
    await plan(); await act(async () => button('保存分镜').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /已保存.*刷新断开/)
    assert.equal(input('镜头 1 标题').disabled, true)
    await act(async () => button('重试返回分镜管理').click())
    assert.equal(requests.filter(item => item.path.endsWith('/commit')).length, 1)
    assert.equal(refreshes, 2); assert.equal(callbacks, 1)
  } finally { await view.destroy() }
})

test('a late planning response after close or project switch cannot install a preview or call save callbacks', async t => {
  let resolvePlan!: (response: Response) => void
  mockApi(t, path => path.endsWith('/plan') ? new Promise<Response>(resolve => { resolvePlan = resolve }) : undefined)
  let callbacks = 0
  const view = await mount({ saved: () => { callbacks++ } })
  try {
    await fill('片段内容', source); await startPlanning({ pending: true })
    await view.render(false); await view.render(true, { ...detail, id: 'other-project' })
    await act(async () => resolvePlan(Response.json(draft)))
    assert.equal(document.querySelector('[aria-label="镜头 1 标题"]'), null)
    assert.equal(input('片段内容').value, '')
    assert.equal(callbacks, 0); assert.equal(requests.some(item => item.path.endsWith('/commit')), false)
  } finally { await view.destroy() }
})

test('failed planning remains retryable and no enabled text model blocks model work', async t => {
  let attempts = 0
  mockApi(t, path => path.endsWith('/plan') && ++attempts === 1 ? Response.json({ detail: '模型暂时断开' }, { status: 503 }) : undefined)
  const view = await mount()
  try {
    await plan(); assert.match(document.querySelector('[role="alert"]')!.textContent!, /模型暂时断开/)
    assert.equal(button('开始规划').disabled, false)
    await startPlanning(); assert.ok(input('镜头 1 标题'))
  } finally { await view.destroy() }
  const noModel = await mount({ models: [] })
  try { await fill('片段内容', source); assert.equal(button('开始规划').disabled, true); assert.match(document.body.textContent!, /启用.*文本模型/) }
  finally { await noModel.destroy() }
})

test('rapid repeated planning and saving create one request for each operation', async t => {
  mockApi(t)
  const view = await mount()
  try {
    await fill('片段内容', source)
    await startPlanning({ repeated: true })
    assert.equal(requests.filter(item => item.path.endsWith('/plan')).length, 1)
    await act(async () => { button('保存分镜').click(); button('保存分镜').click() })
    assert.equal(requests.filter(item => item.path.endsWith('/commit')).length, 1)
  } finally { await view.destroy() }
})

test('a late commit response after changing project cannot refresh or select a design in the new project', async t => {
  let resolveCommit!: (response: Response) => void, refreshed = 0, selected = 0, closed = 0
  mockApi(t, path => path.endsWith('/commit') ? new Promise<Response>(resolve => { resolveCommit = resolve }) : undefined)
  const view = await mount({ refresh: async () => { refreshed++ }, saved: () => { selected++ }, close: () => { closed++ } })
  try {
    await plan(); await act(() => button('保存分镜').click())
    await view.render(true, { ...detail, id: 'next-project' })
    await act(async () => resolveCommit(Response.json(saved)))
    assert.equal(refreshed, 0); assert.equal(selected, 0); assert.equal(closed, 0)
    assert.equal(input('片段内容').value, '')
    assert.equal(document.querySelector('[aria-label="镜头 1 标题"]'), null)
  } finally { await view.destroy() }
})

test('accepting changed content discards the old preview and replanning sends the changed source', async t => {
  mockApi(t, (path, body) => path.endsWith('/plan') ? Response.json({ ...draft, source_text: body.source_text }) : undefined)
  const view = await mount()
  try {
    await plan(); await act(() => button('规划设置').click()); await fill('片段内容', '少女转身离开。')
    await act(() => button('放弃预览').click())
    assert.equal(input('片段内容').value, '少女转身离开。'); assert.equal(button('镜头预览').disabled, true)
    await startPlanning()
    assert.equal(requests.at(-1)!.body.source_text, '少女转身离开。')
  } finally { await view.destroy() }
})

test('context errors can reload without model work and invalid timing cannot be sent', async t => {
  let contexts = 0
  mockApi(t, path => path.endsWith('/context') && ++contexts === 1 ? Response.json({ detail: '配置连接失败' }, { status: 503 }) : undefined)
  const view = await mount()
  try {
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /配置连接失败/)
    await act(async () => button('重新读取配置').click())
    await fill('片段内容', source); await fill('总时长', '0'); assert.equal(button('开始规划').disabled, true)
    await fill('总时长', '120'); await fill('建议镜头数', '0'); assert.equal(button('开始规划').disabled, true)
    await fill('建议镜头数', ''); assert.equal(button('开始规划').disabled, false)
    assert.equal(requests.some(item => item.path.endsWith('/plan')), false)
  } finally { await view.destroy() }
})

test('a stale planning signature reloads configuration while keeping creator inputs and retries with the new signature', async t => {
  let contexts = 0, attempts = 0
  const freshSignature = 'c'.repeat(64), director = '先全景，结尾停在人物的反应上。', changedDirector = `${director}保持夜景。`
  mockApi(t, (path, body) => {
    if (path.endsWith('/context')) return Response.json({ ...context, signature: ++contexts === 1 ? signature : freshSignature })
    if (path.endsWith('/plan')) {
      if (++attempts === 1) return Response.json({ detail: '技能或项目配置已更新，请重新读取规划配置' }, { status: 409 })
      assert.equal(body.signature, freshSignature)
      return Response.json({ ...draft, source_text: body.source_text, total_duration: body.total_duration, instructions: body.instructions,
        shots: draft.shots.map(shot => ({ ...shot, duration: 12 })) })
    }
  })
  const view = await mount()
  try {
    await fill('片段内容', source); await fill('总时长', '24'); await fill('建议镜头数', '2'); await fill('导演要求', director)
    await chooseSkill('__base__')
    await startPlanning()
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /配置已更新/)
    assert.equal(button('开始规划').disabled, true, 'a known stale signature cannot be submitted again before refreshing')
    await fill('导演要求', changedDirector)
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /重新读取配置/, 'editing inputs cannot hide the stale configuration recovery action')
    await act(async () => button('重新读取配置').click())
    assert.equal(input('片段内容').value, source); assert.equal(input('总时长').value, '24')
    assert.equal(input('建议镜头数').value, '2'); assert.equal(input('导演要求').value, changedDirector)
    assert.equal(button('开始规划').disabled, false)
    await startPlanning()
    const plans = requests.filter(item => item.path.endsWith('/plan'))
    assert.deepEqual(plans.map(item => item.body.signature), [signature, freshSignature])
    assert.deepEqual(plans[1].body, { signature: freshSignature, source_text: source, total_duration: 24, instructions: changedDirector,
      model_id: 'text', shots_count: 2, skill_ids: [] })
    assert.ok(input('镜头 1 标题'))
    assert.equal(requests.some(item => item.path.endsWith('/commit')), false)
  } finally { await view.destroy() }
})

test('a save version conflict refreshes configuration only after confirming preview loss and keeps the original clip inputs', async t => {
  let contexts = 0, commits = 0, callbacks = 0
  const freshSignature = 'd'.repeat(64)
  mockApi(t, path => {
    if (path.endsWith('/context')) return Response.json({ ...context, signature: ++contexts === 1 ? signature : freshSignature })
    if (path.endsWith('/commit') && ++commits === 1) return Response.json({ detail: '保存前技能配置已更新，请重新规划' }, { status: 409 })
  })
  const view = await mount({ saved: () => { callbacks++ } })
  try {
    await plan(); await act(async () => button('保存分镜').click())
    assert.equal(button('保存分镜').disabled, true); assert.equal(callbacks, 0)
    await act(() => button('重新读取配置').click()); await act(() => button('继续编辑').click())
    assert.equal(contexts, 1); assert.equal(input('镜头 1 标题').value, '进站')
    await act(() => button('重新读取配置').click()); await act(async () => button('放弃预览').click())
    assert.equal(contexts, 2); assert.equal(input('片段内容').value, source); assert.equal(input('总时长').value, '30')
    assert.equal(button('镜头预览').disabled, true)
    await startPlanning()
    assert.equal(requests.filter(item => item.path.endsWith('/plan')).at(-1)!.body.signature, freshSignature)
    await act(async () => button('保存分镜').click())
    assert.equal(callbacks, 1); assert.equal(commits, 2)
    const ids = requests.filter(item => item.path.endsWith('/commit')).map(item => item.body.request_id)
    assert.notEqual(ids[0], ids[1], 'a refreshed, newly generated preview is a new save request')
  } finally { await view.destroy() }
})

test('clip quality failures retain editable shots and historical evidence until the edited candidate passes a new review', async t => {
  const issue = { code: 'first_frame_conflict', scene_id: 'clip', shot_index: 0, related_scene_id: null, related_shot_index: null,
    severity: 'error', message: '开镜已抬眼，动作却要求从低头开始', evidence: '图片写抬眼；视频写从低头抬眼', repair: '统一为低头起点' }
  mockApi(t, path => path.endsWith('/plan') ? Response.json({ ...draft, directing_review: { ...acceptedReview, status: 'needs_work', issues: [issue] } })
    : path.endsWith('/review') ? Response.json({ ...acceptedReview, review_id: 'repaired-review' }) : undefined)
  const view = await mount()
  try {
    await plan()
    assert.equal(input('镜头 1 首帧图片提示词').disabled, false)
    assert.equal(button('保存分镜').disabled, true)
    assert.match(document.body.textContent!, /开镜已抬眼/)
    await fill('镜头 1 首帧图片提示词', '少女低头站在车站门口')
    assert.equal(button('保存分镜').disabled, true)
    assert.match(document.body.textContent!, /以下保留上次问题/)
    assert.match(document.body.textContent!, /图片写抬眼；视频写从低头抬眼/)
    assert.equal(button('复查当前草稿').disabled, false)
    await act(async () => button('复查当前草稿').click())
    await waitFor(() => !button('保存分镜').disabled, '当前编辑版本复核')
    assert.equal(input('镜头 1 首帧图片提示词').value, '少女低头站在车站门口')
    await act(async () => button('保存分镜').click())
    const commit = requests.find(request => request.path.endsWith('/commit'))!.body
    assert.equal(commit.review_id, 'repaired-review')
    assert.equal(commit.shots[0].image_prompt, '少女低头站在车站门口')
    assert.equal(requests.filter(request => request.path.endsWith('/plan')).length, 1)
  } finally { await view.destroy() }
})

test('clip pending, inconclusive, and missing current receipts require review while retaining the candidate', async t => {
  const cases = [
    { label: 'pending', review: { ...acceptedReview, status: 'pending_review', review_id: undefined }, text: /等待完成首帧与接镜复核/ },
    { label: 'inconclusive', review: { ...acceptedReview, status: 'inconclusive', review_id: undefined, error: { code: 'timeout', message: '复查暂时断开' } }, text: /本次复查未能得出结论.*复查暂时断开/ },
    { label: 'missing receipt', review: { ...acceptedReview, review_id: undefined }, text: /当前分镜尚未通过复查/ },
    { label: 'legacy missing review', review: undefined, text: /当前分镜尚未通过复查/ },
  ]
  for (const item of cases) await t.test(item.label, async child => {
    dom.window.localStorage.clear()
    mockApi(child, path => path.endsWith('/plan') ? Response.json({ ...draft, directing_review: item.review }) : undefined)
    const view = await mount()
    try {
      await plan()
      assert.equal(input('镜头 1 标题').value, '进站')
      assert.equal(input('镜头 1 标题').disabled, false)
      assert.equal(button('保存分镜').disabled, true)
      assert.equal(button('复查当前草稿').disabled, false)
      assert.match(document.body.textContent!, item.text)
      await act(async () => button('复查当前草稿').click())
      await waitFor(() => !button('保存分镜').disabled, '当前收据复核')
      assert.equal(requests.some(request => request.path.endsWith('/commit')), false)
    } finally { await view.destroy() }
  })
})

test('a failed clip review keeps the editable candidate and can be explicitly reviewed again without replanning', async t => {
  let reviews = 0
  mockApi(t, path => path.endsWith('/plan') ? Response.json({ ...draft, directing_review: { ...acceptedReview, status: 'inconclusive', review_id: undefined } })
    : path.endsWith('/review') && ++reviews === 1 ? Response.json({ detail: '复查服务暂时不可用' }, { status: 503 }) : undefined)
  const view = await mount()
  try {
    await plan()
    await act(async () => button('复查当前草稿').click())
    await waitFor(() => document.body.textContent!.includes('复查服务暂时不可用'), '复查错误')
    assert.equal(input('镜头 1 标题').value, '进站')
    assert.equal(input('镜头 1 标题').disabled, false)
    assert.equal(button('保存分镜').disabled, true)
    assert.equal(button('复查当前草稿').disabled, false)
    await act(async () => button('复查当前草稿').click())
    await waitFor(() => !button('保存分镜').disabled, '重试复核完成')
    assert.equal(reviews, 2)
    assert.equal(requests.filter(request => request.path.endsWith('/plan')).length, 1)
    assert.equal(requests.some(request => request.path.endsWith('/commit')), false)
  } finally { await view.destroy() }
})
