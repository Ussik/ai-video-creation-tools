import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail, ShotVisualBinding, VisualProfile } from '../src/shared/api/api'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Bindings } = await import('../src/features/visuals/VisualBindingEditor')
after(() => dom.window.close())
const noop = () => {}

function fixture() {
  const visual_profiles = ['both', 'image', 'video', 'none', 'candidate'].map((id, index) => ({
    id, name: id, kind: 'character', variant: '常服', revision: 2, board_asset_id: `${id}-board`, board_prompt: id,
    definition_status: 'ready', candidate_asset_ids: [], definition: id, view_requirements: '正面',
  })) as VisualProfile[]
  const shot_visual_bindings = visual_profiles.slice(0, 4).map(profile => ({
    ...profile, shot_id: 'shot', profile_id: profile.id, usage: profile.id,
    required: profile.id !== 'video', revision: 1, sync_mode: ['image', 'none'].includes(profile.id) ? 'locked' : 'follow',
    reference_selection: ['both', 'none'].includes(profile.id) ? 'manual' : 'auto', board_asset_id: `${profile.id}-old-board`,
    reference_assets: [{ id: `${profile.id}-ref`, asset_id: `${profile.id}-frozen`, revision: 1, view: 'face', purpose: 'identity', label: '已固定面部' }],
  })) as ShotVisualBinding[]
  return { id: 'project', name: '镜头引用用途', script: { scenes: [{ id: 'scene', heading: '站台' }] },
    shots: [{ id: 'shot', title: '入站', position: 0 }, { id: 'other-shot', title: '其他镜头', position: 1 }],
    visual_profiles, shot_visual_bindings: [...shot_visual_bindings, { ...shot_visual_bindings[0], shot_id: 'other-shot', profile_id: 'candidate' }],
    scene_visual_bindings: [], assets: [], jobs: [], asset_tasks: [],
  } as unknown as ProjectDetail
}
async function mount(detail: ProjectDetail, scope: 'image' | 'video') {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><Bindings detail={detail} context={{ target: 'shot:shot', scope }} presentation="drawer"
    onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} /></MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
function checkbox(profileId: string) {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === `${profileId} · 常服`)
  assert.ok(label, profileId)
  return { label, input: document.getElementById(label.htmlFor) as HTMLInputElement }
}
async function allProfiles() {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent?.startsWith('全部设定'))!
  await act(() => tab.click())
}

for (const scope of ['image', 'video'] as const) {
  test(`${scope} drawer selects only its own usage; browsing all candidates never changes saved references`, async t => {
    const requests: unknown[] = []
    t.mock.method(globalThis, 'fetch', async (...args: unknown[]) => { requests.push(args); return Response.json({}) })
    const view = await mount(fixture(), scope)
    try {
      assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 2)
      assert.equal(checkbox('both').input.checked, true)
      assert.equal(checkbox(scope).input.checked, true)
      assert.match(view.container.textContent!, /共关联 4 份设定/)
      assert.match(view.container.querySelector('footer')!.textContent!, /使用 2 份设定/)
      await allProfiles()
      assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 5)
      assert.equal(checkbox('none').input.checked, false)
      assert.equal(checkbox('candidate').input.checked, false, 'another shot binding cannot select this candidate')
      assert.equal(checkbox(scope === 'image' ? 'video' : 'image').input.checked, false)
      assert.match(view.container.textContent!, /仅开镜图片/)
      assert.match(view.container.textContent!, /仅视频过程/)
      assert.equal(requests.length, 0)
    } finally { await view.destroy() }
  })

  test(`${scope} checkbox edits preserve the opposite usage and every frozen snapshot in the full shot payload`, async t => {
    let current = fixture()
    const requests: Array<{ bindings: Array<{ profile_id: string; required: boolean; usage?: string; sync_mode?: string; reference_selection?: string; reference_asset_ids?: string[] }>; refresh_profile_ids: string[] }> = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); requests.push(body)
      current = { ...current, shot_visual_bindings: [
        ...body.bindings.map((binding: { profile_id: string }) => ({
          ...(current.shot_visual_bindings!.find(item => item.shot_id === 'shot' && item.profile_id === binding.profile_id)
            || current.visual_profiles!.find(item => item.id === binding.profile_id)), ...binding, shot_id: 'shot',
        })), ...current.shot_visual_bindings!.filter(item => item.shot_id !== 'shot'),
      ] }
      return Response.json(current)
    })
    const original = structuredClone(current)
    const view = await mount(current, scope)
    try {
      await allProfiles()
      const opposite = scope === 'image' ? 'video' : 'image'
      for (const [profileId, expected] of [['both', opposite], [scope, 'none'], [opposite, 'both'], ['none', scope], ['candidate', scope]] as const) {
        await act(() => checkbox(profileId).label.click())
        const request = requests.at(-1)!
        assert.equal(request.bindings.find(binding => binding.profile_id === profileId)?.usage, expected)
        assert.deepEqual(request.refresh_profile_ids, [])
        assert.ok(request.bindings.every(binding => !('reference_asset_ids' in binding)), 'a use toggle does not reselect or replace frozen images')
        assert.equal(request.bindings.length, profileId === 'candidate' ? 5 : 4, 'the other output bindings are always sent')
      }
      for (const binding of original.shot_visual_bindings!) {
        const saved = current.shot_visual_bindings!.find(item => item.shot_id === binding.shot_id && item.profile_id === binding.profile_id)!
        assert.deepEqual(saved.reference_assets, binding.reference_assets)
        assert.equal(saved.board_asset_id, binding.board_asset_id)
        assert.equal(saved.required, binding.required)
        assert.equal(saved.sync_mode, binding.sync_mode)
        assert.equal(saved.reference_selection, binding.reference_selection)
      }
    } finally { await view.destroy() }
  })

  test(`${scope} drawer explains automatic updates without a manual refresh action`, async t => {
    let writes = 0
    t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json(fixture()) })
    const view = await mount(fixture(), scope)
    try {
      assert.equal(view.container.querySelector('[aria-label="引用更新"]'), null)
      assert.equal(document.querySelector('[role="dialog"]'), null)
      assert.ok(![...view.container.querySelectorAll('button')].some(node => node.textContent?.includes('更新引用')))
      assert.match(view.container.textContent!, /保留手选参考图 · 需处理/)
      if (scope === 'image') assert.match(view.container.textContent!, /已锁定 v1/)
      else assert.match(view.container.textContent!, /新版待确认/)
      const input = document.querySelector<HTMLInputElement>('[aria-label="搜索引用设定"]')!
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      await act(() => { setter.call(input, '不存在'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
      assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 0)
      assert.equal(writes, 0, 'reading automatic update state and filtering never writes bindings')
    } finally { await view.destroy() }
  })
}

test('an empty current scope stays empty until an explicit candidate is selected', async t => {
  const detail = fixture()
  detail.shot_visual_bindings = detail.shot_visual_bindings!.filter(binding => binding.shot_id !== 'shot' || binding.usage === 'none' || binding.usage === 'video')
  let writes = 0
  t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json(detail) })
  const view = await mount(detail, 'image')
  try {
    assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 0)
    assert.match(view.container.textContent!, /当前图片尚未使用设定/)
    assert.match(view.container.querySelector('footer')!.textContent!, /使用 0 份设定/)
    await allProfiles()
    assert.ok([...view.container.querySelectorAll<HTMLInputElement>('.pc-binding-row-identity input[type="checkbox"]')].every(input => !input.checked))
    assert.equal(writes, 0)
  } finally { await view.destroy() }
})


test('turning follow on preserves manual references and every hidden binding', async t => {
  const detail = fixture()
  const original = detail.shot_visual_bindings!.find(binding => binding.profile_id === 'none')!
  let request: any
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { request = JSON.parse(String(init?.body)); return Response.json(detail) })
  const view = await mount(detail, 'image')
  try {
    await allProfiles()
    await act(() => button('参考与用途：none').click())
    const toggle = document.querySelector<HTMLInputElement>('[aria-label="none 自动跟随最新设定"]')!
    assert.equal(toggle.checked, false)
    await act(() => toggle.click())
    assert.deepEqual(request.bindings.find((binding: any) => binding.profile_id === 'none'), {
      profile_id: 'none', required: true, usage: 'none', sync_mode: 'follow', reference_selection: 'manual',
    })
    assert.equal(request.bindings.length, 4)
    assert.ok(request.bindings.every((binding: any) => !('reference_asset_ids' in binding)))
    assert.deepEqual(request.refresh_profile_ids, [])
    assert.deepEqual(detail.shot_visual_bindings!.find(binding => binding.profile_id === 'none'), original)
  } finally { await view.destroy() }
})

test('restoring automatic matching explicitly releases manual selection without touching other usages', async t => {
  const detail = fixture()
  let request: any
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { request = JSON.parse(String(init?.body)); return Response.json(detail) })
  const view = await mount(detail, 'image')
  try {
    await act(() => button('参考与用途：both').click())
    await act(() => button('恢复自动匹配').click())
    assert.deepEqual(request.bindings.find((binding: any) => binding.profile_id === 'both'), {
      profile_id: 'both', required: true, usage: 'both', sync_mode: 'follow', reference_selection: 'auto',
    })
    assert.deepEqual(request.refresh_profile_ids, ['both'])
    assert.ok(request.bindings.every((binding: any) => !('reference_asset_ids' in binding)))
    assert.equal(request.bindings.find((binding: any) => binding.profile_id === 'image').sync_mode, 'locked')
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await view.destroy() }
})

test('historical shot references show a fixed version and stay read-only', async t => {
  const detail = fixture()
  detail.historical_shots = [{ ...detail.shots[0], superseded_by: 'replacement-shot' }]
  detail.shots = detail.shots.slice(1)
  let writes = 0
  t.mock.method(globalThis, 'fetch', async () => { writes++; return Response.json(detail) })
  const view = await mount(detail, 'image')
  try {
    assert.match(view.container.textContent!, /历史版本 · v1/)
    await act(() => button('参考与用途：both').click())
    const toggle = document.querySelector<HTMLInputElement>('[aria-label="both 自动跟随最新设定"]')!
    assert.equal(toggle.checked, false)
    assert.equal(toggle.disabled, true)
    assert.match(view.container.textContent!, /历史版本已固定/)
    assert.ok([...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.disabled))
    assert.ok(![...view.container.querySelectorAll('button')].some(node => node.textContent === '恢复自动匹配'))
    assert.equal(writes, 0)
  } finally { await view.destroy() }
})
