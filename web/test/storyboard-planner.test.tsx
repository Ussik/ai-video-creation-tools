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
    await check('故事大纲 · 100 字'); assert.match(document.querySelector('.storyboard-planner-skill-card')!.textContent!, /分镜技能/)
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
    await act(async () => button('开始规划').click())
    assert.deepEqual(planBody.skill_ids, []); assert.deepEqual(planBody.document_ids, [])
    assert.equal(planBody.target_duration, undefined)
    assert.ok(button('确认加入画布'))
    await act(() => button('规划设置').click())
    await check('指定本次总时长（源场次合计 30 秒）')
    assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '保存分镜'), false)
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
    await act(async () => button('确认加入画布').click())
    assert.equal(commits, 1); assert.equal(refreshes, 2)
  } finally { await view.destroy() }
})

const savedShot = { ...draft.scenes[0].shots[0], shot_id: 'saved-shot', scene_id: 'saved-scene', title: '已保存的镜头' }
const savedScene = { ...scene, id: 'saved-scene', heading: '已有场次' }
const emptyCanvas = { scene_ids: ['scene'], shots: [], visual_profiles: [], shot_visual_bindings: [], created_profiles: 0, created_shots: 0 }

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
    if (path.endsWith('/context')) return Response.json({ ...context, scenes: [{ ...savedScene, shot_count: 1, material_count: 1, planned: true }], existing_shots: [savedShot] })
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
    await act(async () => button('开始规划').click())
    await act(async () => button('确认加入画布').click())
    assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    await act(async () => button('确认加入画布').click())
    const handoff = JSON.parse(dom.window.sessionStorage.getItem('script-canvas-open:planner')!)
    assert.deepEqual(handoff.result.updated_shot_ids, [savedShot.shot_id])
    assert.equal(handoff.result.shots[0].image_prompt, '重新规划的首帧')
    assert.equal(handoff.result.created_shots, 1)
    assert.equal(commits, 1); assert.equal(imports, 1)
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
    assert.match(document.querySelector('.storyboard-planner-reference-preparation')!.textContent!, /信息图设定技能/)
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
    assert.deepEqual(requests[4].body, { signature: freshSignature, scene_ids: ['scene'], model_id: 'text', skill_ids: ['asset-skill'] })
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
    await act(async () => button('确认加入画布').click())
    assert.match(document.body.textContent!, /分镜已保存，后续操作失败/)
    assert.equal(opened, 0); assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    assert.equal(button('视觉设定技能选择').disabled, false, 'failed reference analysis can switch skills without unlocking the saved storyboard')
    await act(async () => button('确认加入画布').click())
    assert.equal(commits, 1); assert.equal(preparations, 2); assert.equal(opened, 1)
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
    assert.equal(button('确认加入画布').disabled, true)
    await act(() => button('取消整理').click())
    await act(async () => { resolveAnalysis(Response.json({ signature, scene_ids: ['scene'], profiles: [profileDraft] })); await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(paths.some(path => path.endsWith('/script/canvas/commit') || path.endsWith('/storyboard/canvas')), false)
    assert.equal(opened, 0); assert.equal(dom.window.sessionStorage.getItem('script-canvas-open:planner'), null)
    assert.equal(button('确认加入画布').disabled, false)
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
    await act(() => button('视觉设定技能选择').click())
    await act(() => document.querySelector<HTMLElement>('.creative-skill-more-config .workspace-disclosure-control')!.click())
    await act(async () => button('设为项目默认').click())
    assert.equal(requests.filter(path => path.endsWith('/context')).length, 1)
    assert.ok(requests.some(path => path.endsWith('/skills/defaults')))
    assert.ok([...document.querySelectorAll<HTMLTextAreaElement>('textarea')].some(field => field.value === '保留我编辑的首帧'))
    assert.equal(button('确认加入画布').disabled, false)
  } finally { await view.destroy() }
})
