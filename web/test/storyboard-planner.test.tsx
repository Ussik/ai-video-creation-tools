import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, ScriptCanvasResult } from '../src/shared/api/api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: StoryboardPlanner } = await import('../src/features/storyboard/StoryboardPlanner')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const scene = { id: 'scene', episode_number: 1, heading: '车站', duration: 30 }
const detail = { id: 'planner', name: '分镜规划', brief: '站内救援', ratio: '9:16', script: { outline: '大纲', characters: '人物', scenes: [scene], artifacts: [] }, shots: [], jobs: [], assets: [] } as unknown as ProjectDetail
const models = [{ id: 'text', modality: 'text', enabled: true, name: '文本模型' }] as Model[]
const signature = 'a'.repeat(64)
const context = { signature, scenes: [{ ...scene, shot_count: 0, material_count: 0, planned: false }], documents: [{ id: 'outline', title: '故事大纲', characters: 100 }],
  skills: [{ id: 'storyboard-skill', name: '分镜技能', description: '镜头规则', revision: 'a'.repeat(40) }], project: { name: '分镜规划', style: '日漫风格' } }
const draft = { signature, scenes: [{ scene_id: 'scene', scene_heading: '车站', scene_duration: 30, shots: [{ shot_id: null, title: '人物反应', prompt: '人物转身',
  image_prompt: '人物站在车站', video_prompt: '人物转身，镜头推近', duration: 30, start_state: '', end_state: '', cut_note: '' }] }],
  used_skills: [{ id: 'storyboard-skill', name: '分镜技能', revision: 'a'.repeat(40), files: ['SKILL.md'] }], source_documents: [{ id: 'outline', title: '故事大纲' }] }
function button(text: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text); assert.ok(node, text); return node }
async function mount(options: { refresh?: () => Promise<unknown>; openCanvas?: () => void; close?: () => void; project?: ProjectDetail; initialSceneIds?: string[]; models?: Model[] } = {}) {
  dom.window.sessionStorage.clear()
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (opened = true) => act(async () => root.render(<MantineProvider env="test"><StoryboardPlanner opened={opened} onClose={options.close || (() => {})}
    detail={options.project || detail} models={options.models || models} initialSceneIds={options.initialSceneIds || ['scene']} onRefresh={options.refresh || (async () => {})} onOpenCanvas={options.openCanvas || (() => {})} onNotice={() => {}} /></MantineProvider>))
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
async function check(label: string) {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === label)
  assert.ok(element, label); await act(async () => element.click())
}
async function choosePlanningMode(label: '重新设计新方案' | '沿用当前方案更新') {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="分镜规划方式"]')
  assert.ok(input)
  await act(() => input.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label)
  assert.ok(option, label)
  await act(() => option.click())
}
async function chooseSkill(stage: 'storyboard' | 'visual_assets', value: string) {
  const trigger = stage === 'storyboard' ? '分镜规划技能选择' : '视觉设定技能选择'
  await act(() => button(trigger).click())
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${stage}主技能"]`)!
  assert.ok(input)
  await act(() => input.click())
  const option = document.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)
  assert.ok(option, value)
  await act(() => option.click())
  await act(() => button(trigger).click())
}
async function fillTextarea(label: string, value: string) {
  const input = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => node.id === document.querySelector<HTMLLabelElement>(`label[for="${node.id}"]`)?.htmlFor && document.querySelector(`label[for="${node.id}"]`)?.textContent === label)!
  assert.ok(input, label)
  await act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
function shotCountInput() {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '每场建议镜头数')
  assert.ok(label)
  const input = document.getElementById(label.htmlFor) as HTMLInputElement
  assert.ok(input); return input
}
async function fillShotCount(value: string) {
  await act(() => {
    const input = shotCountInput()
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

test('blank count enables automatic planning, numeric suggestions are sent, and clearing restores automatic mode', async t => {
  const plans: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/context')) return Response.json(context)
    if (String(url).endsWith('/plan')) { plans.push(JSON.parse(String(init?.body))); return Response.json(draft) }
    throw new Error(`Unexpected ${url}`)
  })
  const view = await mount()
  try {
    assert.equal(shotCountInput().value, '')
    assert.equal(shotCountInput().placeholder, '自动分析')
    assert.equal(button('开始规划').disabled, false)
    await act(async () => button('开始规划').click())
    assert.equal(Object.hasOwn(plans[0], 'shots_per_scene'), false, 'blank must omit the count, not send zero or a fallback')

    await act(() => button('规划设置').click())
    await fillShotCount('4')
    assert.equal(button('开始规划').disabled, false)
    await act(async () => button('开始规划').click())
    assert.equal(plans[1].shots_per_scene, 4)

    await act(() => button('规划设置').click())
    await fillShotCount('')
    assert.equal(button('开始规划').disabled, false)
    await act(async () => button('开始规划').click())
    assert.equal(Object.hasOwn(plans[2], 'shots_per_scene'), false)

    await act(() => button('规划设置').click())
    await fillShotCount('1')
    assert.equal(button('开始规划').disabled, true, 'an explicit count must retain the existing valid range')
    assert.equal(plans.length, 3)
    await view.render(false); await view.render(true)
    assert.equal(shotCountInput().value, '', 'opening again defaults to automatic count')
    assert.equal(button('开始规划').disabled, false)
  } finally { await view.destroy() }
})

test('invalid planning preserves scene diagnostics and remains retryable without saving or opening the canvas', async t => {
  const diagnostics = '分镜方案与所选场次不一致：本次选择 1 场，返回 2 场。\n缺少场次：车站（scene_id=scene）；重复 scene_id：other；未选中的 scene_id：other。'
  const sourceError = `模型结果不符合 controlled_storyboard 契约（已修正一次）：${diagnostics}`
  const unknownError = '上游模型连接暂时中断（request_id=req-2）'
  const requests: string[] = []; let attempts = 0, opened = 0
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/context')) return Response.json(context)
    if (path.endsWith('/plan')) {
      attempts++
      if (attempts === 1) return Response.json({ detail: sourceError }, { status: 422 })
      if (attempts === 2) return Response.json({ detail: unknownError }, { status: 503 })
      return Response.json(draft)
    }
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++ })
  const assertNoWrites = () => {
    assert.equal(requests.some(path => /\/(commit|canvas)$/.test(path)), false)
    assert.equal(opened, 0)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
  }
  try {
    await act(async () => button('开始规划').click())
    assert.equal(document.querySelector('[role="alert"] span')!.textContent, `分镜规划结果未通过校验（自动修正后仍未通过）：${diagnostics}`)
    assert.equal(document.body.textContent!.includes('controlled_storyboard'), false)
    assert.equal(button('开始规划').disabled, false)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '确认加入画布'), false)
    assert.equal(document.querySelector('.storyboard-planner-preview'), null)
    assertNoWrites()

    await act(async () => button('开始规划').click())
    assert.equal(document.querySelector('[role="alert"] span')!.textContent, unknownError)
    assert.equal(button('开始规划').disabled, false)
    assertNoWrites()

    await act(async () => button('开始规划').click())
    assert.equal(document.querySelector('[role="alert"]'), null)
    assert.ok(document.querySelector('.storyboard-planner-preview'))
    assert.equal(button('确认加入画布').disabled, false)
    assert.deepEqual(requests.map(path => path.split('/').at(-1)), ['context', 'plan', 'plan', 'plan'])
    assertNoWrites()
  } finally { await view.destroy() }
})

test('metadata does not generate; selected skill/docs are explicit and edited draft only saves on confirmation', async t => {
  const requests: Array<{ path: string; body: any }> = []; let opened = 0, closed = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (path.endsWith('/context')) return Response.json({ ...context, default_skill_ids: ['storyboard-skill'] })
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/canvas')) return Response.json({ scene_ids: ['scene'], shots: [{ id: 'shot' }], visual_profiles: [], shot_visual_bindings: [], created_shots: 0, created_profiles: 0 })
    if (path.endsWith('/commit')) return Response.json({ scene_ids: ['scene'], shots: [{ id: 'shot' }], visual_profiles: [], shot_visual_bindings: [], created_shots: 1, created_profiles: 0 } as ScriptCanvasResult)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++, close: () => closed++ })
  try {
    assert.equal(requests.length, 1); assert.ok(requests[0].path.endsWith('/context'))
    assert.ok([...document.querySelectorAll<HTMLInputElement>('.storyboard-planner-source-list input[type=checkbox]')].every(node => !node.checked))
    await check('故事大纲 · 100 字'); assert.match(document.querySelector('.storyboard-planner-skill-card')!.textContent!, /模型自动选择/)
    await chooseSkill('storyboard', 'storyboard-skill')
    await act(async () => button('开始规划').click())
    assert.deepEqual(requests[1].body.skill_ids, ['storyboard-skill']); assert.deepEqual(requests[1].body.document_ids, ['outline'])
    assert.equal(requests.length, 2); assert.equal(opened, 0)
    assert.match(document.querySelector('.storyboard-planner-used-sources .workspace-disclosure-control')!.textContent!, /已使用：分镜技能辅助技能 0 个·参考资料 1 份/)
    await fillTextarea('首帧图片提示词', '修改后的首帧')
    await act(async () => button('确认加入画布').click())
    assert.equal(requests[2].body.scenes[0].shots[0].image_prompt, '修改后的首帧')
    assert.ok(requests[3].path.endsWith('/script/canvas/check')); assert.deepEqual(requests[3].body.scene_ids, ['scene'])
    assert.deepEqual(requests[4].body, { scene_ids: ['scene'], mode: 'existing' })
    assert.equal(opened, 1); assert.equal(closed, 1)
    assert.ok(dom.window.sessionStorage.getItem('script-canvas-open:planner'))
  } finally { await view.destroy() }
})

test('empty skill selection uses base rules and changing configuration invalidates a generated draft', async t => {
  let planBody: any
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (String(url).endsWith('/context')) return Response.json(context)
    if (String(url).endsWith('/plan')) { planBody = JSON.parse(String(init?.body)); return Response.json({ ...draft, used_skills: [] }) }
    throw new Error(`Unexpected ${url}`)
  })
  const view = await mount()
  try {
    await chooseSkill('storyboard', '__base__')
    await act(async () => button('开始规划').click())
    assert.deepEqual(planBody.skill_ids, []); assert.deepEqual(planBody.document_ids, [])
    assert.equal(planBody.target_duration, undefined)
    assert.ok(button('确认加入画布'))
    await act(() => button('规划设置').click())
    await check('指定本次总时长（源场次合计 30 秒）')
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '保存分镜'), false)
  } finally { await view.destroy() }
})

test('storyboard automatic mode sends no selected ids and displays the model result while manual base rules override it', async t => {
  const plans: Array<Record<string, unknown>> = []
  const skills = [
    { id: 'storyboard-skill', name: 'short-drama-storyboard', description: '通用分镜', revision: 'a'.repeat(40) },
    { id: 'segmented-skill', name: 'novel-storyboard', description: '多镜分段规划', revision: 'a'.repeat(40) },
  ]
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/context')) return Response.json({ ...context, skills, default_skill_ids: ['storyboard-skill'],
      skill_policy: { stage: 'storyboard', label: '分镜规划', primary_id: 'storyboard-skill', auxiliary_ids: [], source: 'global', warning: '', skills } })
    if (String(url).endsWith('/plan')) { plans.push(JSON.parse(String(init?.body))); return Response.json({ ...draft,
      used_skills: [{ id: 'segmented-skill', name: 'novel-storyboard', revision: 'a'.repeat(40), files: ['SKILL.md'] }],
      skill_assignment: { source: 'automatic', ids: ['segmented-skill'], reason: '多镜分段任务适合按段组织镜头。' } }) }
    throw new Error(`Unexpected ${url}`)
  })
  const view = await mount()
  try {
    await fillTextarea('导演要求', '按 H3 做多镜分段，明确段内切镜和关键帧')
    assert.match(document.querySelector('[aria-label="本次分镜技能"]')!.textContent!, /模型自动选择/)
    assert.equal(plans.length, 0, 'typing instructions does not make a model request')
    await act(() => button('开始规划').click())
    assert.equal(Object.hasOwn(plans[0], 'skill_ids'), false)
    assert.match(document.querySelector('.storyboard-planner-used-sources')!.textContent!, /novel-storyboard/)
    await act(() => document.querySelector<HTMLElement>('.storyboard-planner-used-sources .workspace-disclosure-control')!.click())
    assert.match(document.querySelector('.storyboard-planner-used-details')!.textContent!, /选择理由：多镜分段任务适合按段组织镜头/)
    await act(() => button('规划设置').click())
    await act(() => button('分镜规划技能选择').click())
    const input = document.querySelector<HTMLInputElement>('input[aria-label="storyboard主技能"]')!
    assert.ok(input)
    await act(() => input.click())
    const base = document.querySelector<HTMLElement>('[role="option"][value="__base__"]')
    assert.ok(base)
    await act(() => base.click())
    await act(() => button('分镜规划技能选择').click())
    await fillTextarea('导演要求', '按 H3 做多镜分段，调整每段的台词落点')
    await act(() => button('开始规划').click())
    assert.deepEqual(plans[1]?.skill_ids, [])
  } finally { await view.destroy() }
})

test('refresh failure retries the same saved result without a second commit', async t => {
  let commits = 0, refreshes = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (String(url).endsWith('/context')) return Response.json(context)
    if (String(url).endsWith('/plan')) return Response.json(draft)
    if (String(url).endsWith('/canvas')) return Response.json({ scene_ids: ['scene'], shots: [], visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 0 })
    if (String(url).endsWith('/commit')) { commits++; return Response.json({ scene_ids: ['scene'], shots: [], visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 0 }) }
    throw new Error(`Unexpected ${url}`)
  })
  const view = await mount({ refresh: async () => { if (++refreshes === 1) throw new Error('刷新失败') } })
  try {
    await act(async () => button('开始规划').click())
    await act(async () => button('确认加入画布').click())
    assert.match(document.body.textContent!, /分镜已保存，后续操作失败/)
    await act(async () => button('继续加入画布').click())
    assert.equal(commits, 1); assert.equal(refreshes, 2)
  } finally { await view.destroy() }
})

const savedShot = { ...draft.scenes[0].shots[0], shot_id: 'saved-shot', scene_id: 'saved-scene', title: '已保存的镜头' }
const savedScene = { ...scene, id: 'saved-scene', heading: '已有场次' }
const emptyCanvas = { scene_ids: ['scene'], shots: [], visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 0 }

test('updated screenplay scenes must be replanned from the current episode document before old shots can return to the canvas', async t => {
  const requests: Array<{ path: string; body: any }> = []
  const updatedScene = { ...savedScene, planned: false, needs_replan: true, replan_reason: 'episode_script_changed', shot_count: 1, material_count: 1 }
  const updatedDocument = { id: 'episode-current', title: '第一集（已修改）', artifact_type: 'episode_script', episode_number: 1, characters: 560 }
  const freshDraft = { ...draft, scenes: [{ ...draft.scenes[0], scene_id: savedScene.id,
    shots: [{ ...savedShot, prompt: '按修改后的正文重新规划', image_prompt: '修改后的新首帧' }] }] }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json({ ...context, scenes: [updatedScene], documents: [updatedDocument],
      default_document_ids: [updatedDocument.id], existing_shots: [savedShot] })
    if (path.endsWith('/plan')) return Response.json(freshDraft)
    if (path.endsWith('/commit')) return Response.json({ ...emptyCanvas, updated_shot_ids: [savedShot.shot_id] })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [savedScene.id], needs_analysis: [] })
    if (path.endsWith('/canvas')) return Response.json({ ...emptyCanvas, scene_ids: [savedScene.id],
      shots: [{ ...freshDraft.scenes[0].shots[0], id: savedShot.shot_id }] })
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [savedScene.id] })
  try {
    assert.match(document.querySelector('.storyboard-planner-sidebar')!.textContent!, /正文已更新，需重新规划/)
    assert.match(document.body.textContent!, /旧分镜和素材仍会保留，请先按最新资料重新规划后再加入画布/)
    assert.equal(document.querySelector<HTMLButtonElement>('button[aria-label="分镜预览"]')!.disabled, true)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '确认加入画布'), false)
    assert.equal(document.querySelector('.storyboard-planner-preview'), null, 'historical shots cannot be presented as a ready plan')
    assert.equal(document.querySelector<HTMLInputElement>('.storyboard-planner-source-list input')!.checked, true, 'the current edited episode is selected automatically')
    assert.deepEqual(requests.map(request => request.path.split('/').at(-1)), ['context'])
    await choosePlanningMode('沿用当前方案更新')
    await act(async () => button('开始规划').click())
    const plan = requests.find(request => request.path.endsWith('/plan'))!
    assert.deepEqual(plan.body.scene_ids, [savedScene.id])
    assert.deepEqual(plan.body.document_ids, [updatedDocument.id])
    assert.equal(document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!.value, '按修改后的正文重新规划')
    assert.equal(requests.some(request => /\/(commit|canvas)$/.test(request.path)), false, 'planning still requires explicit save confirmation')
    await act(async () => button('确认加入画布').click())
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.equal(handoff.result.shots[0].prompt, '按修改后的正文重新规划')
    assert.equal(requests.filter(request => request.path.endsWith('/plan')).length, 1)
  } finally { await view.destroy() }
})

test('a stale scene cannot bypass replanning even if a saved-plan flag remains true and no model is configured', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url); requests.push(path)
    assert.ok(path.endsWith('/context'))
    return Response.json({ ...context, scenes: [{ ...savedScene, planned: true, needs_replan: true,
      replan_reason: '历史分镜缺少来源版本记录，请重新规划后使用', shot_count: 1, material_count: 1 }], existing_shots: [savedShot] })
  })
  const project = { ...detail, script: { ...detail.script, scenes: [savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [savedScene.id], models: [] })
  try {
    assert.match(document.querySelector('.storyboard-planner-sidebar')!.textContent!, /资料已更新，需重新规划/)
    assert.equal(button('已规划').disabled, true)
    assert.equal(button('开始规划').disabled, true)
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '确认加入画布'), false)
    assert.equal(requests.length, 1, 'no saved-plan import or model work runs implicitly')
  } finally { await view.destroy() }
})

test('default episode documents follow the selected scenes while manual reference choices are retained', async t => {
  const secondScene = { ...scene, id: 'second-scene', heading: '车厢', episode_number: 2 }
  const episodeDocuments = [
    { id: 'episode-one', title: '第一集（已修改）', artifact_type: 'episode_script', episode_number: 1, characters: 560 },
    { id: 'episode-two', title: '第二集', artifact_type: 'episode_script', episode_number: 2, characters: 420 },
  ]
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json({ ...context,
      scenes: [...context.scenes, { ...secondScene, planned: false, shot_count: 0, material_count: 0 }],
      documents: [...context.documents, ...episodeDocuments], default_document_ids: episodeDocuments.map(document => document.id) })
    if (path.endsWith('/plan')) return Response.json(draft)
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [scene, secondScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [scene.id, secondScene.id] })
  const checked = (name: string) => {
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === name)
    assert.ok(label, name)
    return (document.getElementById(label.htmlFor) as HTMLInputElement).checked
  }
  try {
    assert.equal(checked('第一集（已修改） · 560 字'), true)
    assert.equal(checked('第二集 · 420 字'), true)
    assert.equal(checked('故事大纲 · 100 字'), false)
    await check('故事大纲 · 100 字')
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="选择场次：车厢"]')!.click())
    assert.equal(checked('第一集（已修改） · 560 字'), true)
    assert.equal(checked('第二集 · 420 字'), false, 'another episode is not retained as an automatic reference after deselection')
    assert.equal(checked('故事大纲 · 100 字'), true, 'manual supplementary references survive scene changes')
    await act(async () => button('开始规划').click())
    assert.deepEqual(requests.find(request => request.path.endsWith('/plan'))!.body.document_ids, ['outline', 'episode-one'])
    await act(() => button('规划设置').click())
    await check('第一集（已修改） · 560 字')
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="选择场次：车厢"]')!.click())
    assert.equal(checked('第一集（已修改） · 560 字'), false, 'manual checkbox choices remain available')
    assert.equal(checked('第二集 · 420 字'), true)
    assert.equal(checked('故事大纲 · 100 字'), true)
  } finally { await view.destroy() }
})

test('deleted storyboard nodes take priority and full batches can switch to saved plans for model-free re-add', async t => {
  const sourceScenes = Array.from({ length: 24 }, (_, index) => ({ ...scene, id: `scene-${index}`, heading: `场次 ${index + 1}` }))
  const savedShots = sourceScenes.slice(0, 12).map((source, index) => ({ ...savedShot, shot_id: `shot-${index}`, scene_id: source.id }))
  const requests: Array<{ path: string; body: any }> = []
  let opened = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json({ ...context, existing_shots: savedShots,
      scenes: sourceScenes.map((source, index) => ({ ...source, planned: index < 12, shot_count: index < 12 ? 1 : 0,
        material_count: 0, canvas_shot_count: index > 0 && index < 11 ? 1 : 0 })) })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: body.scene_ids, needs_analysis: [] })
    if (path.endsWith('/canvas')) return Response.json({ ...emptyCanvas, scene_ids: body.scene_ids,
      shots: savedShots.filter(shot => body.scene_ids.includes(shot.scene_id)).map(shot => ({ ...shot, id: shot.shot_id, source_scene_id: shot.scene_id })) })
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: sourceScenes } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: sourceScenes.map(source => source.id), models: [], openCanvas: () => opened++ })
  const checkbox = (index: number) => document.querySelector<HTMLInputElement>(`input[aria-label="选择场次：场次 ${index + 1}"]`)!
  try {
    assert.match(document.querySelector('.storyboard-planner-sidebar')!.textContent!, /已选 2 \/ 24/)
    assert.equal(checkbox(0).checked, true); assert.equal(checkbox(11).checked, true)
    assert.equal(checkbox(12).checked, false, 'missing saved nodes take priority over unplanned scenes')
    assert.match(checkbox(0).closest('.storyboard-planner-scene-item')!.textContent!, /待加入/)
    assert.match(checkbox(1).closest('.storyboard-planner-scene-item')!.textContent!, /已加入/)
    assert.equal(button('确认加入画布').disabled, false)

    await act(() => button('待规划').click())
    assert.match(document.querySelector('.storyboard-planner-sidebar')!.textContent!, /已选 10 \/ 24/)
    assert.equal(checkbox(0).disabled, true)
    assert.equal(button('已规划').disabled, false, 'a full batch must still be able to switch back to saved plans')
    await act(() => button('已规划').click())
    assert.equal(checkbox(0).checked, true); assert.equal(checkbox(11).checked, true)
    assert.equal(checkbox(12).checked, false)
    assert.equal(button('确认加入画布').disabled, false)

    await act(() => button('清空选择').click())
    assert.equal(checkbox(11).disabled, false)
    await act(() => checkbox(11).click())
    assert.equal(document.querySelector('button[aria-label="分镜预览"]')!.getAttribute('aria-current'), 'step')
    await act(async () => button('确认加入画布').click())
    assert.equal(opened, 1)
    assert.deepEqual(requests.map(request => request.path.split('/').at(-1)), ['context', 'check', 'canvas'])
    assert.deepEqual(requests[2].body, { scene_ids: ['scene-11'], mode: 'existing' })
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.deepEqual(handoff.result.shots.map((shot: { id: string }) => shot.id), ['shot-11'])
  } finally { await view.destroy() }
})

test('saved professional plans can be previewed and reused without a model or a commit', async t => {
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (path.endsWith('/context')) return Response.json({ ...context, scenes: [{ ...savedScene, shot_count: 1, material_count: 1, planned: true, needs_replan: false }], existing_shots: [savedShot] })
    if (path.endsWith('/canvas')) return Response.json({ ...emptyCanvas, scene_ids: ['saved-scene'] })
    throw new Error(`Unexpected ${path}`)
  })
  let opened = 0
  const project = { ...detail, script: { ...detail.script, scenes: [savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: ['saved-scene'], models: [], openCanvas: () => opened++ })
  try {
    assert.equal(button('确认加入画布').disabled, false)
    const field = document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!
    assert.ok(field.readOnly); assert.equal(field.value, savedShot.prompt)
    await act(async () => button('确认加入画布').click())
    assert.equal(opened, 1)
    assert.deepEqual(requests.map(request => request.path.split('/').at(-1)), ['context', 'check', 'canvas'])
    assert.deepEqual(requests[2].body, { scene_ids: ['saved-scene'], mode: 'existing' })
  } finally { await view.destroy() }
})

test('mixed scope only plans missing scenes and imports both new and saved plans after confirmation', async t => {
  const requests: Array<{ path: string; body: any }> = []
  const subsetSignature = 'b'.repeat(64)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (path.endsWith('/context')) return Response.json(body.scene_ids.length === 1 ? { ...context, signature: subsetSignature } : {
      ...context, scenes: [...context.scenes, { ...savedScene, shot_count: 1, material_count: 0, planned: true }], existing_shots: [savedShot],
    })
    if (path.endsWith('/plan')) return Response.json({ ...draft, signature: subsetSignature })
    if (path.endsWith('/commit') || path.endsWith('/canvas')) return Response.json(emptyCanvas)
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [scene, savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: ['scene', 'saved-scene'] })
  try {
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="选择场次：已有场次"]')!.checked, false)
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="选择场次：已有场次"]')!.click())
    await choosePlanningMode('沿用当前方案更新')
    await act(async () => button('开始规划').click())
    const plannedRequest = requests.find(request => request.path.endsWith('/plan'))!
    assert.deepEqual(plannedRequest.body.scene_ids, ['scene']); assert.equal(plannedRequest.body.signature, subsetSignature)
    assert.equal(requests.some(request => /\/(commit|canvas)$/.test(request.path)), false)
    await act(async () => button('确认加入画布').click())
    assert.deepEqual(requests.find(request => request.path.endsWith('/commit'))!.body.scenes.map((item: any) => item.scene_id), ['scene'])
    assert.deepEqual(requests.find(request => request.path.endsWith('/canvas'))!.body, { scene_ids: ['scene', 'saved-scene'], mode: 'existing' })
  } finally { await view.destroy() }
})

test('replanning passes updated shot identities to the canvas even when refresh needs a retry', async t => {
  let commits = 0, imports = 0, refreshes = 0
  const savedPlan = { ...draft, scenes: [{ ...draft.scenes[0], scene_id: savedScene.id,
    shots: [{ ...savedShot, prompt: '重新规划的镜头描述', image_prompt: '重新规划的首帧', video_prompt: '重新规划的动作' }] }] }
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url)
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (path.endsWith('/context')) return Response.json({ ...context, scenes: [{ ...savedScene, shot_count: 1, material_count: 1, planned: true }], existing_shots: [savedShot] })
    if (path.endsWith('/plan')) return Response.json(savedPlan)
    if (path.endsWith('/commit')) { commits++; return Response.json({ ...emptyCanvas, updated_shot_ids: [savedShot.shot_id], created_shots: 1 }) }
    if (path.endsWith('/canvas')) { imports++; return Response.json({ ...emptyCanvas, scene_ids: [savedScene.id], shots: [{ ...savedPlan.scenes[0].shots[0], id: savedShot.shot_id }], updated_shot_ids: [] }) }
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [savedScene.id], refresh: async () => { if (++refreshes === 1) throw new Error('刷新失败') } })
  try {
    await act(() => button('规划设置').click())
    await check('重新规划已有分镜')
    await choosePlanningMode('沿用当前方案更新')
    await act(async () => button('开始规划').click())
    await act(async () => button('确认加入画布').click())
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    await act(async () => button('继续加入画布').click())
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.deepEqual(handoff.result.updated_shot_ids, [savedShot.shot_id])
    assert.equal(handoff.result.shots[0].image_prompt, '重新规划的首帧')
    assert.equal(handoff.result.created_shots, 1)
    assert.equal(commits, 1); assert.equal(imports, 1)
  } finally { await view.destroy() }
})

test('redesign defaults to fresh shots and a dedicated canvas while retries keep the committed target', async t => {
  const requests: Array<{ path: string; body: any }> = []
  let refreshes = 0
  const freshDraft = { ...draft, mode: 'redesign', instructions: '重新设计开镜和人物状态', scenes: [
    { ...draft.scenes[0], scene_id: savedScene.id, shots: [{ ...draft.scenes[0].shots[0], shot_id: null, title: '全新开镜' }] },
  ] }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json({ ...context, scenes: [{ ...savedScene, shot_count: 8, material_count: 5, planned: true }], existing_shots: [savedShot] })
    if (path.endsWith('/plan')) return Response.json(freshDraft)
    if (path.endsWith('/storyboard/commit')) return Response.json({ ...emptyCanvas, design_id: 'new-design', target_canvas_id: 'new-canvas', created_shots: 1 })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: [savedScene.id], needs_analysis: [] })
    if (path.endsWith('/storyboard/canvas')) return Response.json({ ...emptyCanvas, shots: [{ ...freshDraft.scenes[0].shots[0], id: 'new-shot', design_id: 'new-design' }] })
    throw new Error(`Unexpected ${path}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [savedScene.id], refresh: async () => { if (++refreshes === 1) throw new Error('刷新失败') } })
  try {
    await act(() => button('规划设置').click())
    await check('重新规划已有分镜')
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="分镜规划方式"]')!.value, '重新设计新方案')
    await fillTextarea('导演要求', freshDraft.instructions)
    await check('指定本次总时长（源场次合计 30 秒）')
    const durationLabel = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === '本次目标时长')!
    const durationInput = document.getElementById(durationLabel.htmlFor) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
    await act(() => { setter.call(durationInput, '1'); durationInput.dispatchEvent(new dom.window.Event('input', { bubbles: true })); durationInput.dispatchEvent(new dom.window.Event('blur', { bubbles: true })) })
    await act(async () => button('开始规划').click())
    const plan = requests.find(request => request.path.endsWith('/plan'))!
    assert.equal(plan.body.mode, 'redesign'); assert.equal(plan.body.instructions, freshDraft.instructions)
    assert.equal(plan.body.target_duration, 1, 'fresh designs are not constrained by the old eight-shot count')
    assert.equal(document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!.readOnly, false)
    assert.ok(button('移除新增镜头'), 'fresh shots remain independently removable')
    await fillTextarea('首帧图片提示词', '只属于新方案的首帧')
    await act(async () => button('确认加入画布').click())
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    await act(async () => button('继续加入画布').click())
    const commits = requests.filter(request => request.path.endsWith('/storyboard/commit'))
    assert.equal(commits.length, 1)
    assert.equal(commits[0].body.mode, 'redesign'); assert.equal(commits[0].body.instructions, freshDraft.instructions)
    assert.equal(commits[0].body.scenes[0].shots[0].shot_id, null)
    assert.equal(commits[0].body.scenes[0].shots[0].image_prompt, '只属于新方案的首帧')
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.equal(handoff.canvas_id, 'new-canvas'); assert.equal(handoff.result.design_id, 'new-design')
    assert.equal(handoff.result.shots[0].id, 'new-shot')
  } finally { await view.destroy() }
})

test('redesign covers the entire selected scope and changing its mode invalidates the preview', async t => {
  const requests: any[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/context')) return Response.json({ ...context, scenes: [...context.scenes, { ...savedScene, shot_count: 2, material_count: 1, planned: true }], existing_shots: [savedShot] })
    if (String(url).endsWith('/plan')) {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ ...draft, mode: 'redesign', scenes: [draft.scenes[0], { ...draft.scenes[0], scene_id: savedScene.id }] })
    }
    throw new Error(`Unexpected ${url}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: [scene, savedScene] } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: [scene.id, savedScene.id] })
  try {
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="选择场次：已有场次"]')!.click())
    await act(async () => button('开始规划').click())
    assert.deepEqual(requests[0].scene_ids, [scene.id, savedScene.id]); assert.equal(requests[0].mode, 'redesign')
    await act(() => button('规划设置').click())
    await choosePlanningMode('沿用当前方案更新')
    assert.equal(document.querySelector('.storyboard-planner-preview'), null)
    assert.ok(button('开始规划'))
    assert.equal(document.querySelector<HTMLButtonElement>('button[aria-label="分镜预览"]')!.disabled, true)
  } finally { await view.destroy() }
})

test('redesign does not silently reuse a legacy shot identity returned by the model', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/context')) return Response.json({ ...context, scenes: [{ ...savedScene, shot_count: 1, material_count: 1, planned: false }], existing_shots: [savedShot] })
    if (String(url).endsWith('/plan')) return Response.json({ ...draft, mode: 'redesign', scenes: [{ ...draft.scenes[0], scene_id: savedScene.id, shots: [savedShot] }] })
    throw new Error(`Unexpected ${url}`)
  })
  const view = await mount({ project: { ...detail, script: { ...detail.script, scenes: [savedScene] } }, initialSceneIds: [savedScene.id] })
  try {
    await act(async () => button('开始规划').click())
    assert.match(document.body.textContent!, /新方案包含旧镜头/)
    assert.equal(document.querySelector('.storyboard-planner-preview'), null)
  } finally { await view.destroy() }
})

test('legacy scene shots are not treated as ready plans and oversized ranges make the batch explicit', async t => {
  const sourceScenes = Array.from({ length: 24 }, (_, i) => ({ ...scene, id: `scene-${i}`, heading: `场次 ${i + 1}` }))
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/check')) return Response.json({ signature, scene_ids: [], needs_analysis: [] })
    if (String(url).endsWith('/context')) return Response.json({ ...context, scenes: sourceScenes.map(scene => ({ ...scene, shot_count: 1, material_count: 0, planned: false })) })
    throw new Error(`Unexpected ${url}`)
  })
  const project = { ...detail, script: { ...detail.script, scenes: sourceScenes } } as ProjectDetail
  const view = await mount({ project, initialSceneIds: sourceScenes.map(scene => scene.id) })
  try {
    assert.match(document.querySelector('.storyboard-planner-sidebar')!.textContent!, /已选 10 \/ 24/)
    assert.equal(document.querySelectorAll('.storyboard-planner-scene-item').length, 24)
    assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === '确认加入画布'), false)
    assert.ok(button('开始规划'))
  } finally { await view.destroy() }
})

const referencePolicy = { stage: 'visual_assets', label: '视觉设定', primary_id: 'asset-skill', auxiliary_ids: [], source: 'project', warning: '',
  skills: [{ id: 'asset-skill', name: '信息图设定技能', description: '整理详细人物场景道具信息图', revision: 'b'.repeat(40) }] }
const referenceContext = { ...context, reference_preparation: { signature, scene_ids: ['scene'], needs_analysis: ['scene'], skill_policy: referencePolicy, default_skill_ids: ['asset-skill'] } }
const profileDraft = { kind: 'character', name: '林晚', variant: '校服', definition: '日漫风格，黑发与灰色制服', view_requirements: '正侧背及服装细节', scene_ids: ['scene'] }
const referenceCanvas = { ...emptyCanvas, shots: [{ id: 'shot', source_scene_id: 'scene' }], created_profiles: 1,
  visual_profiles: [{ id: 'profile', ...profileDraft, revision: 1, board_asset_id: null }],
  shot_visual_bindings: [{ shot_id: 'shot', profile_id: 'profile', name: '林晚', required: true, board_asset_id: null }] }

test('confirmation uses a fresh source version to prepare references before importing the planned shots', async t => {
  const requests: Array<{ path: string; body: any }> = []; let opened = 0
  const freshSignature = 'c'.repeat(64)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json(referenceContext)
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/storyboard/commit')) return Response.json({ ...emptyCanvas, created_shots: 1 })
    if (path.endsWith('/check')) return Response.json({ signature: freshSignature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/prepare')) return Response.json({ signature: freshSignature, scene_ids: ['scene'], profiles: [profileDraft], used_skills: [{ id: 'asset-skill', name: '信息图设定技能' }], loaded_files: ['SKILL.md'] })
    if (path.endsWith('/script/canvas/commit')) return Response.json(referenceCanvas)
    if (path.endsWith('/storyboard/canvas')) return Response.json({ ...referenceCanvas, created_profiles: 0 })
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++ })
  try {
    assert.equal(requests.length, 1)
    await act(async () => button('开始规划').click())
    assert.equal(requests.length, 2); assert.equal(opened, 0)
    assert.match(document.querySelector('.storyboard-planner-reference-preparation')!.textContent!, /模型自动选择/)
    assert.equal(document.querySelector('[role="dialog"][aria-label="参考设定说明"]'), null)
    await act(() => button('查看参考设定说明').click())
    assert.match(document.querySelector('[role="dialog"][aria-label="参考设定说明"]')!.textContent!, /未变化的设定与确认图会复用/)
    await act(() => button('查看参考设定说明').click())
    assert.equal(document.querySelector('[role="dialog"][aria-label="参考设定说明"]'), null)
    assert.equal(requests.length, 2, 'viewing the reference explanation does not trigger generation')
    await act(async () => button('确认加入画布').click())
    assert.deepEqual(requests.map(request => request.path.split('/').slice(-2).join('/')), [
      'storyboard/context', 'storyboard/plan', 'storyboard/commit', 'canvas/check', 'canvas/prepare', 'canvas/commit', 'storyboard/canvas',
    ])
    assert.deepEqual(requests[4].body, { signature: freshSignature, scene_ids: ['scene'], model_id: 'text' })
    assert.deepEqual(requests[5].body, { signature: freshSignature, scene_ids: ['scene'], profiles: [profileDraft] })
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!).result
    assert.equal(handoff.visual_profiles[0].id, 'profile'); assert.equal(handoff.shot_visual_bindings[0].required, true)
    assert.equal(handoff.created_shots, 1); assert.equal(handoff.created_profiles, 1); assert.equal(opened, 1)
  } finally { await view.destroy() }
})

test('failed reference preparation keeps saved shots and retries without another storyboard commit', async t => {
  let commits = 0, preparations = 0, opened = 0
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url)
    if (path.endsWith('/context')) return Response.json(referenceContext)
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/storyboard/commit')) { commits++; return Response.json(emptyCanvas) }
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/prepare')) {
      if (++preparations === 1) return Response.json({ error: '设定整理超时' }, { status: 504 })
      return Response.json({ signature, scene_ids: ['scene'], profiles: [profileDraft] })
    }
    if (path.endsWith('/script/canvas/commit') || path.endsWith('/storyboard/canvas')) return Response.json(referenceCanvas)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++ })
  try {
    await act(async () => button('开始规划').click())
    assert.match(document.querySelector('.storyboard-planner-section-title')!.textContent!, /未保存草稿，可修改后确认/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!.readOnly, false)
    await act(async () => button('确认加入画布').click())
    assert.match(document.body.textContent!, /分镜已保存，后续操作失败/)
    assert.match(document.querySelector('.storyboard-planner-section-title')!.textContent!, /已保存分镜/)
    assert.doesNotMatch(document.querySelector('.storyboard-planner-section-title')!.textContent!, /未保存草稿/)
    assert.match(document.querySelector('.storyboard-planner-scene-list')!.textContent!, /已保存 · 1 镜/)
    assert.doesNotMatch(document.querySelector('.storyboard-planner-scene-list')!.textContent!, /草稿/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!.readOnly, true)
    assert.equal([...document.querySelectorAll('button')].some(item => item.textContent === '添加镜头' || item.textContent === '移除新增镜头'), false)
    assert.equal(opened, 0); assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    assert.equal(button('视觉设定技能选择').disabled, false, 'failed reference analysis can switch skills without unlocking the saved storyboard')
    assert.equal(button('继续加入画布').disabled, false)
    await act(async () => button('继续加入画布').click())
    assert.equal(commits, 1); assert.equal(preparations, 2); assert.equal(opened, 1)
  } finally { await view.destroy() }
})

test('a failed reference draft save resumes the saved new design without recreating shots or losing its canvas', async t => {
  const paths: string[] = []
  let referenceSaves = 0, opened = 0
  const freshSignature = 'd'.repeat(64)
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url); paths.push(path)
    if (path.endsWith('/context')) return Response.json({ ...referenceContext, scenes: [{ ...scene, planned: true, shot_count: 1, material_count: 1 }],
      existing_shots: [{ ...savedShot, scene_id: scene.id }] })
    if (path.endsWith('/plan')) return Response.json({ ...draft, mode: 'redesign', instructions: '重新设计' })
    if (path.endsWith('/storyboard/commit')) return Response.json({ ...emptyCanvas, created_shots: 1, design_id: 'design-saved', target_canvas_id: 'canvas-saved' })
    if (path.endsWith('/check')) return Response.json({ signature: freshSignature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/prepare')) return Response.json({ signature: freshSignature, scene_ids: ['scene'], profiles: [{ ...profileDraft, design_id: 'design-saved' }] })
    if (path.endsWith('/script/canvas/commit')) {
      if (++referenceSaves === 1) return Response.json({ error: '视觉草稿的设计方案与当前场次不一致' }, { status: 422 })
      return Response.json(referenceCanvas)
    }
    if (path.endsWith('/storyboard/canvas')) return Response.json({ ...referenceCanvas, created_profiles: 0 })
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++ })
  try {
    await act(() => button('规划设置').click())
    await check('重新规划已有分镜')
    await act(async () => button('开始规划').click())
    await act(async () => button('确认加入画布').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /分镜已保存.*视觉草稿的设计方案/)
    assert.match(document.querySelector('.storyboard-planner-section-title')!.textContent!, /已保存分镜/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.storyboard-planner-preview textarea')!.readOnly, true)
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    assert.equal(opened, 0)
    await act(async () => button('继续加入画布').click())
    assert.equal(paths.filter(path => path.endsWith('/storyboard/commit')).length, 1)
    assert.equal(paths.filter(path => path.endsWith('/plan')).length, 1)
    assert.equal(referenceSaves, 2); assert.equal(opened, 1)
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.equal(handoff.canvas_id, 'canvas-saved')
    assert.equal(handoff.result.design_id, 'design-saved')
    assert.equal(handoff.result.created_shots, 1)
  } finally { await view.destroy() }
})

test('saved plans still prepare missing references and an explicit empty selection uses base rules', async t => {
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    if (path.endsWith('/context')) return Response.json({ ...referenceContext, scenes: [{ ...scene, planned: true, shot_count: 1, material_count: 0 }],
      existing_shots: [{ ...savedShot, scene_id: 'scene' }], reference_preparation: { ...referenceContext.reference_preparation, default_skill_ids: [], skill_policy: { ...referencePolicy, primary_id: null } } })
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/prepare')) return Response.json({ signature, scene_ids: ['scene'], profiles: [profileDraft] })
    if (path.endsWith('/script/canvas/commit') || path.endsWith('/storyboard/canvas')) return Response.json(referenceCanvas)
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    assert.equal(requests.length, 1)
    await chooseSkill('visual_assets', '__base__')
    await act(async () => button('确认加入画布').click())
    assert.equal(requests.some(request => /\/storyboard\/(commit|plan)$/.test(request.path)), false)
    assert.deepEqual(requests.find(request => request.path.endsWith('/prepare'))!.body.skill_ids, [])
    assert.ok(dom.window.sessionStorage.getItem('script-canvas-open:planner'))
  } finally { await view.destroy() }
})

test('cancelling reference analysis prevents a late result from being committed or opening the canvas', async t => {
  let resolveAnalysis!: (value: Response) => void, opened = 0
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async url => {
    const path = String(url); paths.push(path)
    if (path.endsWith('/context')) return Response.json(referenceContext)
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/storyboard/commit')) return Response.json(emptyCanvas)
    if (path.endsWith('/check')) return Response.json({ signature, scene_ids: ['scene'], needs_analysis: ['scene'] })
    if (path.endsWith('/prepare')) return new Promise<Response>(resolve => { resolveAnalysis = resolve })
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount({ openCanvas: () => opened++ })
  try {
    await act(async () => button('开始规划').click())
    await act(async () => { button('确认加入画布').click(); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.match(document.querySelector('.storyboard-planner-footer-status')!.textContent!, /正在整理参考设定/)
    assert.equal(button('继续加入画布').disabled, true)
    await act(() => button('取消整理').click())
    await act(async () => { resolveAnalysis(Response.json({ signature, scene_ids: ['scene'], profiles: [profileDraft] })); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(paths.some(path => path.endsWith('/script/canvas/commit') || path.endsWith('/storyboard/canvas')), false)
    assert.equal(opened, 0); assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    assert.equal(button('继续加入画布').disabled, false)
  } finally { await view.destroy() }
})

test('saving reference skill defaults reloads only that policy and preserves the edited storyboard preview', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url); requests.push(path)
    if (path.endsWith('/context')) return Response.json(referenceContext)
    if (path.endsWith('/plan')) return Response.json(draft)
    if (path.endsWith('/skills/defaults/visual_assets') && init?.method === 'PUT') return Response.json({})
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [referencePolicy] })
    throw new Error(`Unexpected ${path}`)
  })
  const view = await mount()
  try {
    await act(async () => button('开始规划').click())
    await fillTextarea('首帧图片提示词', '保留我编辑的首帧')
    await chooseSkill('visual_assets', 'asset-skill')
    await act(() => button('视觉设定技能选择').click())
    await act(() => document.querySelector<HTMLElement>('.creative-skill-more-config .workspace-disclosure-control')!.click())
    await act(async () => button('设为项目默认').click())
    assert.equal(requests.filter(path => path.endsWith('/context')).length, 1)
    assert.ok(requests.some(path => path.endsWith('/skills/defaults')))
    assert.ok([...document.querySelectorAll<HTMLTextAreaElement>('textarea')].some(field => field.value === '保留我编辑的首帧'))
    assert.equal(button('确认加入画布').disabled, false)
  } finally { await view.destroy() }
})
