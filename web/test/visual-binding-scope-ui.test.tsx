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
    required: profile.id !== 'video', revision: 1, board_asset_id: `${profile.id}-old-board`,
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
    const requests: Array<{ bindings: Array<{ profile_id: string; required: boolean; usage?: string; reference_asset_ids?: string[] }>; refresh_profile_ids: string[] }> = []
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
      }
    } finally { await view.destroy() }
  })

  test(`${scope} bulk refresh includes only active stale references and preserves hidden rows despite search`, async t => {
    const detail = fixture()
    let request: any
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { request = JSON.parse(String(init?.body)); return Response.json(detail) })
    const view = await mount(detail, scope)
    try {
      const input = document.querySelector<HTMLInputElement>('[aria-label="搜索引用设定"]')!
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
      await act(() => { setter.call(input, '不存在'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
      assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 0)
      await act(() => button(`更新${scope === 'image' ? '图片' : '视频'}使用的引用（2）`).click())
      assert.match(document.querySelector('[role="dialog"]')!.textContent!, /图片与视频共用的引用/)
      await act(() => button('确认更新').click())
      assert.deepEqual(request.refresh_profile_ids, ['both', scope])
      assert.deepEqual(request.bindings.map((binding: any) => binding.profile_id), ['both', 'image', 'video', 'none'])
      assert.deepEqual(request.bindings.map((binding: any) => binding.usage), ['both', 'image', 'video', 'none'])
      assert.ok(request.bindings.every((binding: any) => !('reference_asset_ids' in binding)))
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
