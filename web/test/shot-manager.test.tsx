import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'
import type { ProjectDetail, Shot } from '../src/shared/api/api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ShotManager } = await import('../src/features/storyboard/ShotManager')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const project = { id: 'project', name: '镜头项目' } as ProjectDetail
const shot = (id: string, title: string, position: number, design = 'design-a', scene = 'scene-a'): Shot => ({ id, title, position, project_id: 'project', design_id: design, source_scene_id: scene, prompt: `${title}的描述`, image_prompt: `${title}首帧`, video_prompt: `${title}动态`, duration: 5, selected_asset_id: null, start_state: '起点', end_state: '终点', cut_note: '接下镜' })
function snapshot(): ShotManagementSnapshot {
  return { revision: 'revision-1', designs: [{ id: 'design-a', name: '方案甲', canvas_id: 'canvas-a' }, { id: 'design-b', name: '方案乙', canvas_id: 'canvas-b' }], canvases: [{ id: 'canvas-a', name: '画布甲' }, { id: 'canvas-b', name: '画布乙' }], scenes: [{ id: 'scene-a', heading: '车站', episode_number: 1, position: 0 }, { id: 'scene-b', heading: '街道', episode_number: 1, position: 1 }], trashed_assets: [{ id: 'asset-trash', filename: '已回收视频.mp4', kind: 'video', deleted_at: '2026-11-01T00:00:00Z' }], shots: [
    { shot: shot('a', '进站', 0), design_name: '方案甲', canvas_refs: [{ id: 'canvas-a', name: '画布甲' }], asset_count: 3, deleted_at: null, delete_blockers: ['画布甲仍引用此镜头'] },
    { shot: shot('b', '告别', 1), design_name: '方案甲', canvas_refs: [], asset_count: 0, deleted_at: null, delete_blockers: [] },
    { shot: shot('c', '追逐', 2, 'design-b', 'scene-b'), design_name: '方案乙', canvas_refs: [], asset_count: 1, deleted_at: null, delete_blockers: [] },
    { shot: shot('trash', '旧镜头', 3), design_name: '方案甲', canvas_refs: [], asset_count: 0, deleted_at: '2026-11-01T00:00:00Z', delete_blockers: [] },
  ] }
}
function button(label: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label); assert.ok(node, `button ${label}`); return node }
function hasButton(label: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].some(item => item.getAttribute('aria-label') === label || item.textContent === label) }
async function click(label: string) { await act(async () => button(label).click()) }
async function choose(label: string, option: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(input, label)
  await act(async () => input.click())
  const node = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === option); assert.ok(node, option)
  await act(async () => node.click())
}
async function type(label: string, value: string) {
  const labelNode = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.replace(' *', '') === label)
  const input = (labelNode ? document.getElementById(labelNode.htmlFor) : document.querySelector(`[aria-label="${label}"]`)) as HTMLInputElement | HTMLTextAreaElement
  assert.ok(input, label)
  await act(async () => {
    const proto = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function check(label: string) { const input = document.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`); assert.ok(input, label); await act(async () => input.click()) }
async function openTrash() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.startsWith('回收站'))!
  await act(async () => tab.click())
}
async function confirmDialog(label = '彻底删除') {
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('.app-dialog button')].find(node => node.textContent === label)
  assert.ok(confirm, `dialog action ${label}`)
  await act(async () => confirm.click())
}
async function mount(options: { refresh?: () => Promise<unknown>; close?: () => void; add?: (ids: string[], canvas: string) => Promise<void>; notice?: (message: string) => void; plan?: (sceneIds?: string[]) => void; planClip?: () => void; initialDesignId?: string | null; initialSceneIds?: string[] } = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (detail = project, opened = true) => act(async () => root.render(<MantineProvider env="test"><ShotManager opened={opened} onClose={options.close || (() => {})} detail={detail} activeCanvasId="canvas-a" onRefresh={options.refresh || (async () => {})} onAddToCanvas={options.add || (async () => {})} onNotice={options.notice} onPlan={options.plan} onPlanClip={options.planClip} initialDesignId={options.initialDesignId} initialSceneIds={options.initialSceneIds} /></MantineProvider>))
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('opening only reads metadata, defaults to current canvas design, and filters across schemes, scenes and text', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(`${init?.method || 'GET'} ${url}`); return Response.json(snapshot()) })
  const view = await mount()
  try {
    assert.deepEqual(requests, ['GET /api/projects/project/shot-management'])
    assert.ok(hasButton('编辑镜头：进站')); assert.ok(hasButton('编辑镜头：告别')); assert.equal(hasButton('编辑镜头：追逐'), false)
    assert.match(document.querySelector('.shot-manager-row')!.textContent!, /画布：画布甲/)
    assert.match(document.querySelector('.shot-manager-row')!.textContent!, /素材 3 个/)
    await choose('分镜方案筛选', '全部方案'); assert.ok(hasButton('编辑镜头：追逐'))
    await choose('分镜场次筛选', '第 1 集 · 街道'); assert.ok(hasButton('编辑镜头：追逐')); assert.equal(hasButton('编辑镜头：进站'), false)
    await choose('分镜场次筛选', '全部场次'); await type('搜索分镜', '告别')
    assert.ok(hasButton('编辑镜头：告别')); assert.equal(hasButton('编辑镜头：进站'), false)
    assert.equal(requests.length, 1)
  } finally { await view.destroy() }
})

test('editing requires explicit save, sends the snapshot revision and prevents repeated writes while pending', async t => {
  let current = snapshot(), finish: (() => void) | null = null, writes: any[] = [], refreshed = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    return new Promise<Response>(resolve => { finish = () => { current = { ...current, revision: 'revision-2', shots: current.shots.map(entry => entry.shot.id === body.shot_id ? { ...entry, shot: { ...entry.shot, ...body.patch } } : entry) }; resolve(Response.json(current)) } })
  })
  const view = await mount({ refresh: async () => { refreshed++ } })
  try {
    await type('镜头标题', '更新标题'); await type('视频提示词', '镜头向前推进')
    assert.equal(writes.length, 0); assert.equal(button('复制').disabled, true)
    await act(async () => { button('保存修改').click(); button('保存修改').click() })
    assert.equal(writes.length, 1); assert.equal(writes[0].revision, 'revision-1'); assert.equal(writes[0].action, 'update'); assert.equal(writes[0].patch.video_prompt, '镜头向前推进'); assert.equal(writes[0].patch.title, '更新标题')
    assert.equal(Object.hasOwn(writes[0].patch, 'source_scene_id'), false)
    await act(async () => { finish!() })
    assert.equal(refreshed, 1); assert.ok(hasButton('编辑镜头：更新标题')); assert.equal(button('保存修改').disabled, true)
  } finally { await view.destroy() }
})

test('dirty selection and close need a discard decision; cancelling keeps the current editor', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  let closed = 0
  const view = await mount({ close: () => closed++ })
  try {
    await type('镜头标题', '未保存标题')
    await click('编辑镜头：告别'); assert.match(document.body.textContent!, /放弃未保存的镜头修改/)
    await click('继续编辑'); assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '未保存标题')
    await click('关闭分镜管理'); await click('继续编辑'); assert.equal(closed, 0)
    await click('编辑镜头：告别'); await click('放弃修改'); assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '告别')
    await click('关闭分镜管理'); assert.equal(closed, 1)
  } finally { await view.destroy() }
})

test('reorder uses same-scheme scene direction, blockers prevent trash, and the recycle bin restores shots and assets', async t => {
  let current = snapshot(); const actions: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); actions.push(body)
    current = { ...current, revision: `revision-${actions.length + 1}`, shots: current.shots.map(entry => entry.shot.id === body.shot_id ? { ...entry, deleted_at: body.action === 'trash' ? '2026-11-01T00:00:00Z' : body.action === 'restore' ? null : entry.deleted_at } : entry), trashed_assets: body.action === 'restore_asset' ? [] : current.trashed_assets }
    return Response.json(current)
  })
  const view = await mount()
  try {
    assert.equal(button('移入回收站').disabled, true); assert.match(document.querySelector('.shot-manager-blockers')!.textContent!, /画布甲仍引用此镜头/)
    await click('编辑镜头：告别'); assert.equal(button('上移镜头').disabled, false); assert.equal(button('下移镜头').disabled, true)
    await click('上移镜头'); assert.equal(actions[0].direction, 'up')
    await click('移入回收站'); assert.equal(actions.length, 1)
    const dialogs = document.querySelectorAll('[role="dialog"]'); assert.equal(dialogs.length, 2)
    const confirm = [...dialogs[1].querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '移入回收站')!; await act(async () => confirm.click())
    assert.equal(actions[1].action, 'trash'); assert.equal(hasButton('编辑镜头：告别'), false)
    const trashTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-value="trash"]') || [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.startsWith('回收站'))!; await act(async () => trashTab.click())
    await click('编辑镜头：旧镜头'); await click('恢复镜头'); assert.equal(actions[2].action, 'restore')
    await click('恢复素材'); assert.equal(actions[3].action, 'restore_asset'); assert.equal(actions[3].asset_id, 'asset-trash')
    assert.equal(hasButton('恢复素材'), false)
  } finally { await view.destroy() }
})

test('selected shots are sent to the chosen target canvas without writing a graph in the manager', async t => {
  const requests: string[] = [], added: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push(`${init?.method || 'GET'} ${url}`); return Response.json(snapshot()) })
  const view = await mount({ add: async (ids, canvas) => { added.push({ ids, canvas }) } })
  try {
    await check('选择镜头：告别'); await choose('加入目标画布', '画布乙'); await click('加入画布')
    assert.deepEqual(added, [{ ids: ['b'], canvas: 'canvas-b' }]); assert.equal(requests.length, 2); assert.ok(requests.every(item => item.startsWith('GET')))
    assert.equal(hasButton('加入画布'), false)
  } finally { await view.destroy() }
})

test('a revision conflict keeps edits until an explicit reload and then unlocks the manager', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init?.body) return Response.json({ detail: '项目内容已变化，请重新读取' }, { status: 409 })
    reads++; return Response.json(snapshot())
  })
  const view = await mount()
  try {
    await type('镜头标题', '我的草稿'); await click('保存修改')
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /项目内容已变化/)
    assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '我的草稿')
    await click('重新读取最新版本'); await click('放弃修改')
    assert.equal(reads, 2); assert.equal(button('刷新分镜列表').disabled, false)
    assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '进站')
  } finally { await view.destroy() }
})

test('late mutation responses from a previous project do not refresh or notify the next project', async t => {
  let resolveWrite: ((value: Response) => void) | null = null, refreshed = 0; const notices: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.body) return new Promise<Response>(resolve => { resolveWrite = resolve })
    if (String(url).includes('/next/')) return Response.json({ ...snapshot(), shots: [] })
    return Response.json(snapshot())
  })
  const view = await mount({ refresh: async () => { refreshed++ }, notice: message => notices.push(message) })
  try {
    await type('镜头标题', '旧项目草稿'); await click('保存修改')
    await view.render({ ...project, id: 'next', name: '下个项目' })
    await act(async () => resolveWrite!(Response.json({ ...snapshot(), revision: 'late' })))
    assert.equal(refreshed, 0); assert.deepEqual(notices, []); assert.equal(hasButton('编辑镜头：进站'), false)
    assert.match(document.querySelector('.shot-manager-heading')!.textContent!, /下个项目/)
  } finally { await view.destroy() }
})

test('batch addition cannot discard a dirty editor and a project switch clears its discard dialog', async t => {
  let added = 0
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  const view = await mount({ add: async () => { added++ } })
  try {
    await check('选择镜头：告别'); assert.equal(button('加入画布').disabled, false)
    await type('镜头标题', '仍在编辑的标题'); assert.equal(button('加入画布').disabled, true)
    assert.match(document.querySelector('.shot-manager-batch-help')!.textContent!, /请先保存/)
    await act(async () => button('加入画布').click()); assert.equal(added, 0)
    assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '仍在编辑的标题')
    await click('编辑镜头：告别'); assert.ok(hasButton('放弃修改'))
    await view.render({ ...project, id: 'next', name: '另一个项目' })
    assert.equal(hasButton('放弃修改'), false); assert.match(document.querySelector('.shot-manager-heading')!.textContent!, /另一个项目/)
  } finally { await view.destroy() }
})

test('duplication uses the saved shot action and selects the returned independent shot', async t => {
  const current = snapshot(); const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    return Response.json({ ...current, revision: 'revision-copy', shots: [...current.shots, { ...current.shots[0], shot: { ...current.shots[0].shot, id: 'copy', title: '进站（副本）', selected_asset_id: null }, canvas_refs: [], asset_count: 0, delete_blockers: [] }] })
  })
  const view = await mount()
  try {
    await click('复制')
    assert.deepEqual(writes, [{ action: 'duplicate', shot_id: 'a', revision: 'revision-1' }])
    assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '进站（副本）')
    assert.match(document.querySelector('.shot-manager-reference-summary')!.textContent!, /没有画布引用/)
    assert.equal(button('移入回收站').disabled, false)
  } finally { await view.destroy() }
})


test('the workspace exposes scene totals, scan-friendly shot columns and factual production status', async t => {
  const next = snapshot(); next.shots[0].shot.selected_asset_id = 'selected-video'
  t.mock.method(globalThis, 'fetch', async () => Response.json(next))
  const view = await mount({ plan: () => {} })
  try {
    assert.ok(document.querySelector('[aria-label="分镜场次导航"]'))
    assert.match(document.querySelector('[aria-label="分镜场次导航"]')!.textContent!, /2 镜.*10 秒/)
    assert.ok(document.querySelector('table[aria-label="分镜镜头表"]'))
    assert.match(document.querySelector('table')!.textContent!, /画面与描述.*时长.*制作状态.*画布/)
    assert.match(document.querySelector('table')!.textContent!, /已选片/)
    assert.match(document.querySelector('table')!.textContent!, /待制作/)
    assert.equal(button('规划分镜').disabled, false)
    await click('场次：第 1 集 · 车站')
    assert.ok(hasButton('编辑镜头：告别'))
  } finally { await view.destroy() }
})

test('shot thumbnails keep the selected image and fall back to the latest available image', async t => {
  const next = snapshot()
  next.shots[0].shot.selected_asset_id = 'selected-a'
  next.shots[1].shot.selected_asset_id = 'missing-selection'
  t.mock.method(globalThis, 'fetch', async () => Response.json(next))
  const assets = [
    { id: 'candidate-a', shot_id: 'a', kind: 'image', created_at: '2026-11-03T02:00:00Z', url: '/candidate-a.png' },
    { id: 'selected-a', shot_id: 'a', kind: 'image', created_at: '2026-11-03T01:00:00Z', url: '/selected-a.png' },
    { id: 'older-b', shot_id: 'b', kind: 'image', created_at: '2026-11-03T01:00:00Z', url: '/older-b.png' },
    { id: 'latest-b', shot_id: 'b', kind: 'image', created_at: '2026-11-03T02:00:00Z', url: '/latest-b.png' },
    { id: 'deleted-b', shot_id: 'b', kind: 'image', created_at: '2026-11-03T03:00:00Z', url: '/deleted-b.png', deleted_at: '2026-11-03T04:00:00Z' },
    { id: 'video-b', shot_id: 'b', kind: 'video', created_at: '2026-11-03T05:00:00Z', url: '/video-b.mp4' },
  ] as ProjectDetail['assets']
  const view = await mount()
  const preview = (title: string) => document.querySelector<HTMLImageElement>(`img[alt="${title}的分镜图"]`)?.getAttribute('src')
  try {
    await view.render({ ...project, assets })
    assert.equal(preview('进站'), '/selected-a.png', 'a newer candidate must not replace the selected image')
    assert.equal(preview('告别'), '/latest-b.png', 'an unavailable selection falls back to the newest active image')
    await view.render({ ...project, assets: assets.map(asset => asset.id === 'selected-a' ? { ...asset, deleted_at: '2026-11-03T06:00:00Z' } : asset) })
    assert.equal(preview('进站'), '/candidate-a.png', 'a deleted selected image also falls back to the newest active candidate')
  } finally { await view.destroy() }
})

test('planning uses the chosen scene and respects the unsaved-edit guard', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  const planned: Array<string[] | undefined> = []
  const view = await mount({ plan: ids => planned.push(ids), initialSceneIds: ['scene-a'] })
  try {
    await type('镜头标题', '未保存的规划前修改')
    await click('规划分镜'); assert.deepEqual(planned, [])
    await click('继续编辑'); assert.deepEqual(planned, [])
    await click('规划分镜'); await click('放弃修改')
    assert.deepEqual(planned, [['scene-a']])
  } finally { await view.destroy() }
})

test('a project without script scenes can open skill-based clip planning directly', async t => {
  const current = { ...snapshot(), scenes: [], shots: [], designs: [] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(current))
  let clips = 0, scripts = 0
  const view = await mount({ planClip: () => { clips++ }, plan: () => { scripts++ } })
  try {
    await click('规划分镜')
    assert.equal(clips, 1)
    assert.equal(scripts, 0)
    assert.equal(document.body.textContent?.includes('选择分镜来源'), false)
    assert.match(document.querySelector('.shot-manager-empty')!.textContent!, /片段内容|一段内容/)
  } finally { await view.destroy() }
})

test('a saved clip shows its source and only imports into its own canvas', async t => {
  const current = snapshot()
  current.designs[1] = { ...current.designs[1], source_type: 'clip', source_text: '一段追逐短片', total_duration: 5 }
  current.shots[2].shot.source_scene_id = null
  const added: Array<{ ids: string[]; canvas: string }> = []
  t.mock.method(globalThis, 'fetch', async () => Response.json(current))
  const view = await mount({ initialDesignId: 'design-b', add: async (ids, canvas) => { added.push({ ids, canvas }) } })
  try {
    assert.match(document.querySelector('[aria-label="片段来源"]')!.textContent!, /一段追逐短片.*5 秒/)
    await check('选择镜头：追逐')
    assert.equal(document.querySelector('input[aria-label="加入目标画布"]'), null)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /方案乙/)
    await click('加入画布')
    assert.deepEqual(added, [{ ids: ['c'], canvas: 'canvas-b' }])
    await choose('分镜方案筛选', '全部方案')
    await check('选择镜头：进站'); await check('选择镜头：追逐')
    assert.equal(button('加入画布').disabled, true, 'clip and script schemes cannot share a production request')
  } finally { await view.destroy() }
})

test('planning source selection protects dirty edits and keeps scene and clip callbacks separate', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  let clips = 0; const scripts: Array<string[] | undefined> = []
  const view = await mount({ planClip: () => { clips++ }, plan: ids => scripts.push(ids), initialSceneIds: ['scene-a'] })
  try {
    await type('镜头标题', '未保存的标题')
    await click('规划分镜'); await click('继续编辑')
    assert.equal(hasButton('从片段内容规划'), false)
    await click('规划分镜'); await click('放弃修改')
    await click('从片段内容规划')
    assert.equal(clips, 1); assert.deepEqual(scripts, [])
    await click('规划分镜'); await click('从剧本场次规划')
    assert.deepEqual(scripts, [['scene-a']])
  } finally { await view.destroy() }
})

test('an empty saved plan can start planning without choosing a target canvas', async t => {
  const next = snapshot(); next.shots = []; next.canvases = []
  t.mock.method(globalThis, 'fetch', async () => Response.json(next))
  let planned = 0
  const view = await mount({ plan: () => { planned++ } })
  try {
    assert.match(document.querySelector('.shot-manager-empty')!.textContent!, /规划分镜/)
    await click('开始规划分镜'); assert.equal(planned, 1)
    assert.equal(document.querySelector('input[aria-label="加入目标画布"]'), null)
  } finally { await view.destroy() }
})


test('a pending plan creates its own canvas while mixed-plan selections remain blocked', async t => {
  const next = snapshot()
  Object.assign(next.designs[1], { canvas_pending: true, canvas_id: null })
  t.mock.method(globalThis, 'fetch', async () => Response.json(next))
  const added: unknown[] = []
  const view = await mount({ add: async (ids, canvas) => { added.push({ ids, canvas }) }, initialDesignId: 'design-b' })
  try {
    await check('选择镜头：追逐')
    assert.equal(document.querySelector('input[aria-label="加入目标画布"]'), null)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /将创建此方案的画布/)
    assert.equal(button('加入画布').disabled, false)
    await click('加入画布'); assert.deepEqual(added, [{ ids: ['c'], canvas: '' }])
    await choose('分镜方案筛选', '全部方案')
    await check('选择镜头：追逐'); await check('选择镜头：告别')
    assert.equal(button('加入画布').disabled, true)
    assert.match(document.querySelector('.shot-manager-batch')!.textContent!, /请按方案分别加入画布/)
  } finally { await view.destroy() }
})

test('a newly saved design is selected after refreshing without overwriting a dirty shot', async t => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', async () => { reads++; return Response.json(snapshot()) })
  const options = { initialDesignId: 'design-a' }
  const view = await mount(options)
  try {
    await type('镜头标题', '保留我的镜头修改')
    options.initialDesignId = 'design-b'; await view.render()
    assert.equal(reads, 1)
    assert.equal((document.querySelector('.shot-manager-fields input') as HTMLInputElement).value, '保留我的镜头修改')
    await click('编辑镜头：告别'); await click('放弃修改')
    assert.equal(reads, 2)
    assert.ok(hasButton('编辑镜头：追逐'))
    assert.equal(hasButton('编辑镜头：告别'), false)
  } finally { await view.destroy() }
})

test('selected shots can be recycled together and the request uses the current revision', async t => {
  let current=snapshot(); const writes: any[]=[]
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    if(!init?.body) return Response.json(current)
    const body=JSON.parse(String(init.body)); writes.push(body)
    if(body.action==='trash_many') current={...current,revision:'revision-batch',shots:current.shots.map(entry=>body.shot_ids.includes(entry.shot.id)?{...entry,deleted_at:'2026-11-09T00:00:00Z'}:entry)}
    return Response.json(current)
  })
  const view=await mount()
  try {
    await choose('分镜方案筛选','全部方案')
    await check('选择镜头：告别'); await check('选择镜头：追逐')
    await click('批量移入回收站')
    assert.match(document.body.textContent!,/将 2 个镜头移入回收站/)
    const confirm=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node=>node.textContent==='移入回收站')!
    await act(async()=>confirm.click())
    assert.deepEqual(writes,[{action:'trash_many',shot_ids:['b','c'],revision:'revision-1'}])
    assert.ok(current.shots.find(entry=>entry.shot.id==='b')!.deleted_at)
    assert.ok(current.shots.find(entry=>entry.shot.id==='c')!.deleted_at)
  } finally { await view.destroy() }
})

test('a selected scheme can be recycled and restored as a group while blockers explain why not', async t => {
  let current=snapshot(); current.shots[0]!.delete_blockers=[]
  const writes: any[]=[]
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    if(!init?.body) return Response.json(current)
    const body=JSON.parse(String(init.body)); writes.push(body)
    if(body.action==='trash_design') current={...current,revision:'revision-plan-trash',shots:current.shots.map(entry=>entry.shot.design_id===body.design_id?{...entry,deleted_at:'2026-11-09T00:00:00Z'}:entry)}
    if(body.action==='restore_design') current={...current,revision:'revision-plan-restore',shots:current.shots.map(entry=>entry.shot.design_id===body.design_id?{...entry,deleted_at:null}:entry)}
    return Response.json(current)
  })
  const view=await mount()
  try {
    assert.equal(button('回收方案').disabled,false)
    await click('回收方案')
    const confirm=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node=>node.textContent==='移入回收站')!
    await act(async()=>confirm.click())
    assert.deepEqual(writes[0],{action:'trash_design',design_id:'design-a',revision:'revision-1'})
    assert.ok(current.shots.filter(entry=>entry.shot.design_id==='design-a').every(entry=>entry.deleted_at))
    const trashTab=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node=>node.textContent?.startsWith('回收站'))!
    await act(async()=>trashTab.click())
    await choose('分镜方案筛选','方案甲')
    assert.equal(button('恢复方案').disabled,false)
    await click('恢复方案')
    const restore=[...document.querySelectorAll<HTMLButtonElement>('.app-dialog button')].find(node=>node.textContent==='恢复方案')!
    await act(async()=>restore.click())
    assert.deepEqual(writes[1],{action:'restore_design',design_id:'design-a',revision:'revision-plan-trash'})
    assert.ok(current.shots.filter(entry=>entry.shot.design_id==='design-a').every(entry=>!entry.deleted_at))
  } finally { await view.destroy() }
})

test('scheme and batch recycle controls expose canvas blockers before submission', async t => {
  t.mock.method(globalThis,'fetch',async()=>Response.json(snapshot()))
  const view=await mount()
  try {
    assert.equal(button('回收方案').disabled,true)
    assert.match(document.querySelector('.shot-manager-recycle-blockers')!.textContent!,/进站.*画布甲仍引用此镜头/)
    await check('选择镜头：进站')
    assert.equal(button('批量移入回收站').disabled,true)
    assert.match(document.querySelector('.shot-manager-batch-help')!.textContent!,/进站.*画布甲仍引用此镜头/)
  } finally { await view.destroy() }
})

test('the default scheme filter recycles its null-design shots as a group', async t => {
  const current=snapshot(); current.shots[0]!.shot.design_id=null; current.shots[0]!.design_name='默认方案'; current.shots[0]!.delete_blockers=[]
  const writes: any[]=[]
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    if(!init?.body) return Response.json(current)
    const body=JSON.parse(String(init.body)); writes.push(body)
    return Response.json(current)
  })
  const view=await mount()
  try {
    await choose('分镜方案筛选','默认方案')
    assert.ok(hasButton('编辑镜头：进站')); assert.equal(hasButton('编辑镜头：告别'),false)
    assert.equal(button('回收方案').disabled,false)
    await click('回收方案')
    const confirm=[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node=>node.textContent==='移入回收站')!
    await act(async()=>confirm.click())
    assert.deepEqual(writes[0],{action:'trash_design',design_id:null,revision:'revision-1'})
  } finally { await view.destroy() }
})

test('empty scenes are hidden for the current scheme and can be shown for planning without leaving a hidden filter', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  const view = await mount()
  try {
    assert.equal(hasButton('场次：第 1 集 · 街道'), false)
    await check('显示空场次')
    assert.ok(hasButton('场次：第 1 集 · 街道'))
    await click('场次：第 1 集 · 街道')
    assert.equal(hasButton('编辑镜头：进站'), false)
    await check('显示空场次')
    assert.equal(hasButton('场次：第 1 集 · 街道'), false)
    assert.ok(hasButton('编辑镜头：进站'))
    assert.equal(document.querySelector('.shot-manager-list-heading strong')!.textContent, '全部场次')
    await choose('分镜方案筛选', '全部方案')
    await click('场次：第 1 集 · 街道')
    await choose('分镜方案筛选', '方案甲')
    assert.ok(hasButton('编辑镜头：进站'), 'switching schemes resets a scene that becomes hidden')
  } finally { await view.destroy() }
})

test('an explicit empty initial scene stays available as a planning source', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(snapshot()))
  const planned: Array<string[] | undefined> = []
  const view = await mount({ initialSceneIds: ['scene-b'], plan: ids => planned.push(ids) })
  try {
    assert.ok(hasButton('场次：第 1 集 · 街道'))
    assert.match(document.querySelector('.shot-manager-list-heading strong')!.textContent!, /街道/)
    await click('开始规划分镜')
    assert.deepEqual(planned, [['scene-b']])
  } finally { await view.destroy() }
})

test('permanent shot deletion requires confirmation, locks filters, and updates the recycle count', async t => {
  let current = snapshot(), refreshed = 0
  const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    current = { ...current, revision: 'after-purge', shots: current.shots.filter(entry => entry.shot.id !== body.shot_id) }
    return Response.json(current)
  })
  const view = await mount({ refresh: async () => { refreshed++ } })
  try {
    await openTrash()
    await click('编辑镜头：旧镜头')
    assert.ok(document.querySelector('.shot-manager.is-detail'))
    await click('彻底删除镜头')
    assert.match(document.querySelector('.app-dialog')!.textContent!, /旧镜头.*不可恢复.*关联素材与生成记录保留/)
    assert.equal((document.querySelector('input[aria-label="分镜方案筛选"]') as HTMLInputElement).disabled, true)
    await click('取消')
    assert.deepEqual(writes, [])
    await click('彻底删除镜头'); await confirmDialog()
    assert.deepEqual(writes, [{ action: 'purge', shot_id: 'trash', revision: 'revision-1' }])
    assert.equal(refreshed, 1)
    assert.equal(hasButton('编辑镜头：旧镜头'), false)
    assert.equal(document.querySelector('.shot-manager.is-detail'), null, 'a removed shot must leave the mobile detail view')
    assert.match([...document.querySelectorAll('[role="tab"]')].find(node => node.textContent?.startsWith('回收站'))!.textContent!, /回收站 · 1/)
    assert.equal(button('刷新分镜列表').disabled, false)
  } finally { await view.destroy() }
})

test('recycled shots can be selected and permanently deleted as an exact batch', async t => {
  const current = snapshot(); const writes: any[] = []
  current.shots.push({ ...current.shots[3], shot: shot('trash-other', '另一旧镜头', 4) })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    return Response.json({ ...current, shots: current.shots.filter(entry => !body.shot_ids.includes(entry.shot.id)) })
  })
  const view = await mount()
  try {
    await openTrash(); await check('选择当前筛选的全部镜头')
    await click('批量彻底删除')
    assert.match(document.querySelector('.app-dialog')!.textContent!, /2 个镜头/)
    await confirmDialog()
    assert.deepEqual(writes, [{ action: 'purge_many', shot_ids: ['trash', 'trash-other'], revision: 'revision-1' }])
    assert.equal(hasButton('批量彻底删除'), false)
    assert.equal(hasButton('编辑镜头：旧镜头'), false)
    assert.equal(hasButton('编辑镜头：另一旧镜头'), false)
  } finally { await view.destroy() }
})

test('empty recycle bin confirms all project records even when filters hide some', async t => {
  const current = snapshot(); const writes: any[] = []
  current.shots.push({ ...current.shots[3], shot: shot('hidden-trash', '别的方案旧镜头', 4, 'design-b', 'scene-b') })
  current.trashed_assets.push({ id: 'hidden-asset', filename: '另一素材.png', kind: 'image', deleted_at: '2026-11-09' })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    return Response.json({ ...current, shots: current.shots.filter(entry => !entry.deleted_at), trashed_assets: [] })
  })
  const view = await mount()
  try {
    await openTrash(); await choose('分镜方案筛选', '方案甲'); await type('搜索分镜', '旧镜头')
    assert.equal(hasButton('编辑镜头：别的方案旧镜头'), false)
    assert.equal(document.body.textContent?.includes('另一素材.png'), false)
    await click('清空回收站')
    assert.match(document.querySelector('.app-dialog')!.textContent!, /整个项目.*2 个镜头.*2 个素材.*不受.*筛选.*不可恢复/)
    await confirmDialog('清空回收站')
    assert.deepEqual(writes, [{ action: 'empty_trash', revision: 'revision-1' }])
    assert.equal(button('清空回收站').disabled, true)
    assert.match([...document.querySelectorAll('[role="tab"]')].find(node => node.textContent?.startsWith('回收站'))!.textContent!, /回收站 · 0/)
  } finally { await view.destroy() }
})

test('recycled asset deletion explains retained files and uses its own action', async t => {
  const current = snapshot(); const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    const body = JSON.parse(String(init.body)); writes.push(body)
    return Response.json({ ...current, trashed_assets: [] })
  })
  const view = await mount()
  try {
    await openTrash(); await click('彻底删除素材：已回收视频.mp4')
    assert.match(document.querySelector('.app-dialog')!.textContent!, /移除素材记录.*保留本地文件及生成记录/)
    await confirmDialog()
    assert.deepEqual(writes, [{ action: 'purge_asset', asset_id: 'asset-trash', revision: 'revision-1' }])
    assert.equal(hasButton('恢复素材'), false)
  } finally { await view.destroy() }
})

test('permanent deletion shows reference blockers while preserving restore controls', async t => {
  const current = snapshot()
  Object.assign(current.shots[3], { purge_blockers: ['被剪辑稿引用'] })
  Object.assign(current.trashed_assets[0], { purge_blockers: ['已保存至素材库'] })
  const writes: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { if (init?.body) writes.push(init.body); return Response.json(current) })
  const view = await mount()
  try {
    await openTrash()
    assert.equal(button('彻底删除镜头').disabled, true)
    assert.equal(button('彻底删除素材：已回收视频.mp4').disabled, true)
    assert.match(document.querySelector('.shot-manager-detail')!.textContent!, /暂不能彻底删除.*被剪辑稿引用/)
    assert.match(document.querySelector('.shot-manager-asset-trash')!.textContent!, /已保存至素材库/)
    await check('选择镜头：旧镜头')
    assert.equal(button('批量彻底删除').disabled, true)
    assert.equal(button('恢复镜头').disabled, false)
    assert.equal(button('恢复素材').disabled, false)
    assert.deepEqual(writes, [])
  } finally { await view.destroy() }
})

test('a purge conflict keeps recycled records and offers an explicit refresh', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => init?.body ? Response.json({ detail: '引用已变化，请刷新' }, { status: 409 }) : Response.json(snapshot()))
  const view = await mount()
  try {
    await openTrash(); await click('彻底删除镜头'); await confirmDialog()
    assert.ok(hasButton('编辑镜头：旧镜头'))
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /引用已变化/)
    assert.equal(button('重新读取最新版本').disabled, false)
  } finally { await view.destroy() }
})

test('switching projects abandons a permanent deletion confirmation without submitting it', async t => {
  const writes: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { if (init?.body) writes.push(init.body); return Response.json(snapshot()) })
  const view = await mount()
  try {
    await openTrash(); await click('彻底删除镜头')
    await view.render({ ...project, id: 'next', name: '新项目' })
    assert.equal(document.querySelector('.app-dialog'), null)
    assert.deepEqual(writes, [])
    assert.equal(button('刷新分镜列表').disabled, false)
  } finally { await view.destroy() }
})

test('a permanent deletion stays locked through the request and a late response cannot change another project', async t => {
  let finish: ((value: Response) => void) | null = null, refreshed = 0
  const writes: unknown[] = [], notices: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(snapshot())
    writes.push(init.body)
    return new Promise<Response>(resolve => { finish = resolve })
  })
  const view = await mount({ refresh: async () => { refreshed++ }, notice: value => notices.push(value) })
  try {
    await openTrash(); await click('彻底删除镜头'); await confirmDialog()
    assert.equal(writes.length, 1)
    assert.equal(button('彻底删除镜头').disabled, true)
    assert.equal(button('清空回收站').disabled, true)
    assert.equal((document.querySelector('input[aria-label="显示空场次"]') as HTMLInputElement).disabled, true)
    await act(async () => { button('彻底删除镜头').click(); button('清空回收站').click() })
    assert.equal(writes.length, 1)
    await view.render({ ...project, id: 'next', name: '下个项目' })
    await act(async () => finish!(Response.json({ ...snapshot(), shots: [], trashed_assets: [] })))
    assert.equal(refreshed, 0); assert.deepEqual(notices, [])
    assert.match(document.querySelector('.shot-manager-heading')!.textContent!, /下个项目/)
    assert.ok(hasButton('编辑镜头：进站'))
  } finally { await view.destroy() }
})

test('project empty-trash blockers account for references removed in the same purge', async t => {
  const current = snapshot()
  Object.assign(current.trashed_assets[0], { purge_blockers: ['待删除镜头的素材复核引用'] })
  Object.assign(current, { empty_trash_blockers: [] })
  const writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (!init?.body) return Response.json(current)
    writes.push(JSON.parse(String(init.body)))
    return Response.json({ ...current, shots: current.shots.filter(entry => !entry.deleted_at), trashed_assets: [] })
  })
  const view = await mount()
  try {
    await openTrash()
    assert.equal(button('彻底删除素材：已回收视频.mp4').disabled, true, 'single-asset deletion remains protected')
    assert.equal(button('清空回收站').disabled, false, 'the server permits the combined operation')
    await click('清空回收站'); await confirmDialog('清空回收站')
    assert.deepEqual(writes, [{ action: 'empty_trash', revision: 'revision-1' }])
  } finally { await view.destroy() }
})
