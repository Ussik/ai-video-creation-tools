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
async function mount(options: { refresh?: () => Promise<unknown>; close?: () => void; add?: (ids: string[], canvas: string) => Promise<void>; notice?: (message: string) => void } = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = async (detail = project, opened = true) => act(async () => root.render(<MantineProvider env="test"><ShotManager opened={opened} onClose={options.close || (() => {})} detail={detail} activeCanvasId="canvas-a" onRefresh={options.refresh || (async () => {})} onAddToCanvas={options.add || (async () => {})} onNotice={options.notice} /></MantineProvider>))
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
    assert.equal(button('加入画布').disabled, true)
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
