import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail, VisualProfile } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: VisualWorkspace } = await import('../src/features/visuals/VisualWorkspace')
after(() => dom.window.close())

const profile = { id: 'person', project_id: 'project', kind: 'character', name: '沈砚', variant: '基础', definition: '深色短褂，左手持灯。', view_requirements: '正面、侧面', revision: 3,
  definition_status: 'ready', board_asset_id: null, asset_task_id: null, board_prompt: '', base_profile_id: null, state_delta: '' } as VisualProfile
const location = { ...profile, id: 'alley', kind: 'location', name: '荒巷', definition: '雨后的青石巷。' } as VisualProfile
const source = { id: 'project', name: '夜巡三更', shots: [], assets: [], jobs: [], asset_tasks: [], visual_profiles: [profile, location], scene_visual_bindings: [], shot_visual_bindings: [],
  script: { outline: '', characters: '', generation_options: {}, artifacts: [], scenes: [] } } as unknown as ProjectDetail
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
async function fill(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  assert.ok(field, label)
  const proto = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  await act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function mount(detail = structuredClone(source), options: Partial<React.ComponentProps<typeof VisualWorkspace>> = {}) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><VisualWorkspace detail={detail} models={[]} providers={[]} onRefresh={async () => {}} onClose={() => {}} {...options} /></MantineProvider>))
  return { destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('visual workspace renders category, media cards and inspector without automatic generation or writes', async t => {
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ path: String(url), method: init?.method || 'GET' }); return Response.json([]) })
  const view = await mount()
  try {
    assert.ok(document.querySelector('[aria-label="视觉设定分类"]'))
    assert.equal(document.querySelectorAll('.visual-workspace-card').length, 2)
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="设定名称"]')!.value, '沈砚')
    await fill('搜索视觉设定', '荒巷')
    assert.equal(document.querySelectorAll('.visual-workspace-card').length, 1)
    await act(async () => button('编辑视觉设定：荒巷 · 基础').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="设定名称"]')!.value, '荒巷')
    assert.deepEqual(requests, [{ path: '/api/projects/project/canvases', method: 'GET' }])
  } finally { await view.destroy() }
})

test('visual workspace preserves a dirty profile on cancelled navigation and saves its original revision contract', async t => {
  const writes: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!init?.method) return Response.json([])
    const body = JSON.parse(String(init.body)); writes.push({ path: String(url), body })
    return Response.json({ ...profile, ...body, revision: 4 })
  })
  let guard: (() => Promise<boolean>) | null = null
  const view = await mount(structuredClone(source), { registerNavigationGuard: value => { guard = value } })
  try {
    await fill('固定视觉设定', '深色短褂，左手持灯，右手持锣。')
    await act(async () => button('编辑视觉设定：荒巷 · 基础').click())
    await act(async () => button('继续编辑').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="设定名称"]')!.value, '沈砚')
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="固定视觉设定"]')!.value, '深色短褂，左手持灯，右手持锣。')
    let pending!: Promise<boolean>
    await act(() => { pending = guard!() })
    await act(async () => button('继续编辑').click())
    assert.equal(await pending, false)
    await act(async () => button('保存设定').click())
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, '/api/visual-profiles/person')
    assert.equal(writes[0].body.expected_revision, 3)
    assert.equal(writes[0].body.definition, '深色短褂，左手持灯，右手持锣。')
    assert.equal(writes[0].body.definition_status, 'ready')
    assert.equal(await guard!(), true)
  } finally { await view.destroy() }
  assert.equal(guard, null)
})
