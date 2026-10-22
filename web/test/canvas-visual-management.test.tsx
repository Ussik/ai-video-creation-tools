import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, VisualProfile, VisualProjectData } from '../src/shared/api/api'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Inspector } = await import('../src/features/visuals/VisualProfileInspector')
const { default: Bindings } = await import('../src/features/visuals/VisualBindingEditor')
const { default: Organizer } = await import('../src/features/visuals/VisualProfileOrganizer')
after(() => dom.window.close())
const profile = { id: 'lin', project_id: 'project', kind: 'character', name: '林晚', variant: '默认', definition: '日漫风格，短发', view_requirements: '正侧背三视图', revision: 2, definition_status: 'ready', board_asset_id: 'new-board', asset_task_id: null, board_prompt: '人物信息图' } as VisualProfile
const other = { ...profile, id: 'station', kind: 'location', name: '车站', board_asset_id: null } as VisualProfile
const model = { id: 'text', provider_id: 'provider', name: '文本模型', remote_id: 'text', modality: 'text', protocol: 'chat_completions', settings: {}, enabled: true } as Model
const detail = {
  id: 'project', name: '夜班列车', script: { outline: '日漫故事', characters: '林晚', generation_options: {}, artifacts: [], scenes: [{ id: 'scene', episode_number: 1, heading: '车站 · 夜', characters: '林晚' }] },
  shots: [{ id: 'shot', title: '入站', position: 0, source_scene_id: 'scene' }], assets: [{ id: 'new-board', kind: 'image' }], jobs: [], asset_tasks: [],
  visual_profiles: [profile, other], scene_visual_bindings: [{ scene_id: 'scene', profile_id: 'lin', required: true }],
  shot_visual_bindings: [{ ...profile, profile_id: 'lin', shot_id: 'shot', board_asset_id: 'old-board', required: true }],
} as unknown as ProjectDetail
const data = (base = detail): VisualProjectData => ({ visual_profiles: base.visual_profiles!, scene_visual_bindings: base.scene_visual_bindings!, shot_visual_bindings: base.shot_visual_bindings! })
const noop = () => {}
const inspectorProps = { profile, inCanvas: false, detail, generating: false, onRefresh: async () => {}, onClose: noop, onBindings: noop, onDirtyChange: noop, onBusyChange: noop, onSaved: noop, onDeleted: noop, onOpenCanvas: noop }
async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = (node: React.ReactNode) => act(() => root.render(<MantineProvider env="test">{node}</MantineProvider>))
  try { await render(element) } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { container, render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
async function fill(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  assert.ok(node, label)
  const setter = Object.getOwnPropertyDescriptor(node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(() => { setter.call(node, value); node.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function choose(label: string, value: string) {
  await act(() => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.click())
  const option = document.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)
  assert.ok(option, value); await act(() => option.click())
}
async function check(label: string) {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')].find(node => node.textContent === label)
  assert.ok(element, label); await act(() => element.click())
}

test('inline references stay scoped to the shot; filtering and disclosure are read-only and usage saves retain other objects', async t => {
  const extra = { ...detail.shot_visual_bindings![0], profile_id: other.id, kind: other.kind, name: other.name, required: false }
  const base = { ...detail, assets: [{ id: 'new-board', kind: 'image', url: '/board.png' }],
    shot_visual_bindings: [{ ...detail.shot_visual_bindings![0], board_asset_id: 'new-board', usage: 'both' as const }, extra] } as ProjectDetail
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ path: String(url), body })
    return Response.json({ ...data(base), shot_visual_bindings: [{ ...base.shot_visual_bindings![0], usage: body.bindings[0].usage }, extra] })
  })
  const view = await mount(<Bindings presentation="inline" detail={base} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.match(view.container.textContent!, /1\. 入站/)
    assert.equal(view.container.querySelector('[aria-label="选择绑定场次或镜头"]'), null)
    assert.equal(view.container.querySelectorAll('.pc-binding-profile-preview img').length, 1)
    const category = (label: string) => [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.startsWith(label))!
    await act(() => category('场景').click())
    assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 1)
    assert.match(view.container.querySelector('.pc-visual-binding')!.textContent!, /车站/)
    await act(() => category('全部').click())
    await fill('搜索引用设定', '林晚')
    assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 1)
    await act(() => button('参考与用途：林晚').click())
    assert.equal(requests.length, 0, 'opening and filtering must not write bindings')
    await choose('林晚 使用范围', 'video')
    assert.deepEqual(requests, [{ path: '/api/shots/shot/visual-bindings', body: {
      bindings: [{ profile_id: 'lin', required: true, usage: 'video' }, { profile_id: 'station', required: false }], refresh_profile_ids: [],
    } }])
  } finally { await view.destroy() }
})

test('manual creation saves a definition without adding a node or generating images', async t => {
  let saved: VisualProfile | undefined, opened = 0
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json({ ...data(), visual_profiles: [...detail.visual_profiles!, { ...profile, id: 'prop', kind: 'prop', name: '车票', definition: '旧纸质车票', board_asset_id: null }] })
  })
  const view = await mount(<Inspector {...inspectorProps} profile={undefined} onSaved={value => { saved = value }} onOpenCanvas={() => opened++} />)
  try {
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(button('创建设定').disabled, true)
    await choose('设定类型', 'prop'); await fill('设定名称', '车票'); await fill('固定视觉设定', '旧纸质车票')
    assert.equal(button('创建设定').disabled, false)
    await act(() => button('创建设定').click())
    assert.equal(saved?.id, 'prop'); assert.equal(opened, 0)
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/projects/project/visual-profiles')
    assert.equal(requests[0].body.profiles[0].kind, 'prop')
  } finally { await view.destroy() }
})

test('manual creation in a new design permits a historical name and uses the returned created identity', async t => {
  let saved: VisualProfile | undefined, body: any
  const created = { ...profile, id: 'new-lin', design_id: 'design-new', variant: '默认 · 新方案', definition: '新方案白发', board_asset_id: null }
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({ ...data(), visual_profiles: [...detail.visual_profiles!, created], created_profile_ids: [created.id] })
  })
  const view = await mount(<Inspector {...inspectorProps} profile={undefined} designId="design-new" onSaved={value => { saved = value }} />)
  try {
    await fill('设定名称', profile.name); await fill('固定视觉设定', '新方案白发')
    await act(() => button('创建设定').click())
    assert.equal(body.design_id, 'design-new')
    assert.equal(saved?.id, created.id, 'backend variant scoping cannot turn a successful save into an apparent failure')
    assert.equal(view.container.querySelector('[role="alert"]'), null)
  } finally { await view.destroy() }
})

test('shot reference choices follow the selected design and historical shots retain their own choices', async () => {
  const currentProfile = { ...profile, id: 'new-lin', name: '新方案人物', design_id: 'design-new' }
  const base = { ...detail, visual_profiles: [...detail.visual_profiles!, currentProfile], shots: [
    ...detail.shots, { ...detail.shots[0], id: 'shot-new', title: '新方案开镜', design_id: 'design-new' },
  ] } as ProjectDetail
  const props = { detail: base, onRefresh: async () => {}, onClose: noop, onBusyChange: noop, onLocate: noop }
  const view = await mount(<Bindings {...props} context={{ target: 'shot:shot-new' }} />)
  try {
    assert.match(view.container.querySelector('.pc-visual-bindings')!.textContent!, /新方案人物/)
    assert.doesNotMatch(view.container.querySelector('.pc-visual-bindings')!.textContent!, /车站/)
    await choose('选择绑定场次或镜头', 'shot:shot')
    assert.match(view.container.querySelector('.pc-visual-bindings')!.textContent!, /车站/)
    assert.doesNotMatch(view.container.querySelector('.pc-visual-bindings')!.textContent!, /新方案人物/)
  } finally { await view.destroy() }
})

test('new design batch organization scopes scenes and preserves design id through analysis and save', async t => {
  const current = { ...detail, shots: [{ ...detail.shots[0], design_id: 'design-new' }], script: { ...detail.script, scenes: [
    ...detail.script.scenes, { ...detail.script.scenes[0], id: 'other-scene', heading: '其他方案场次' },
  ] } } as ProjectDetail
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (path === '/api/models') return Response.json([model])
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    return Response.json(path.endsWith('/analyze') ? { profiles: [{ ...profile, definition: '新设计人物', scene_ids: ['scene'] }] } : data())
  })
  const view = await mount(<Organizer detail={current} designId="design-new" models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    assert.equal(button('确认保存 1 份设定').disabled, false, 'an identically named historical profile does not discard a new design draft')
    await act(() => button('确认保存 1 份设定').click())
    assert.equal(requests[0].body.design_id, 'design-new'); assert.deepEqual(requests[0].body.scene_ids, ['scene'])
    assert.equal(requests[1].body.design_id, 'design-new')
  } finally { await view.destroy() }
})

test('editing retains unsaved text and sends the original revision after a concurrent profile refresh', async t => {
  let requestBody: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requestBody = JSON.parse(String(init?.body)); return Response.json({ error: '版本已变化' }, { status: 409 }) })
  const view = await mount(<Inspector {...inspectorProps} />)
  try {
    await fill('固定视觉设定', '新增蓝色外套')
    await view.render(<Inspector {...inspectorProps} profile={{ ...profile, revision: 3, definition: '其他编辑' }} />)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="固定视觉设定"]')!.value, '新增蓝色外套')
    await act(() => button('保存设定').click())
    assert.equal(requestBody.expected_revision, 2); assert.equal(requestBody.definition, '新增蓝色外套')
    assert.ok(document.querySelector('[role="alert"]'))
    assert.equal(button('加入画布').disabled, true)
    assert.equal(button('删除设定').disabled, true, 'used shots must be unbound before deleting')
  } finally { await view.destroy() }
})

test('same-revision board changes can refresh a shot snapshot without dropping other required references', async t => {
  const extra = { ...detail.shot_visual_bindings![0], profile_id: other.id, kind: other.kind, name: other.name, required: 0 as unknown as boolean }
  const base = { ...detail, shot_visual_bindings: [...detail.shot_visual_bindings!, extra] }
  let requestBody: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requestBody = JSON.parse(String(init?.body)); return Response.json(data(base)) })
  const view = await mount(<Bindings detail={base} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(view.container.textContent!, /图片缺失/)
    await act(() => button('更新引用').click())
    assert.deepEqual(requestBody.refresh_profile_ids, ['lin'])
    assert.deepEqual(requestBody.bindings, [{ profile_id: 'lin', required: true }, { profile_id: 'station', required: false }])
  } finally { await view.destroy() }
})

test('bulk shot reference updates require confirmation and cancellation leaves snapshots unchanged', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async url => { requests.push(String(url)); return Response.json(data()) })
  const view = await mount(<Bindings presentation="drawer" detail={detail} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.match(view.container.textContent!, /1 项引用待更新/)
    await act(() => button('更新本镜头全部引用（1）').click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent!, /更新本镜头引用/)
    assert.equal(requests.length, 0, 'opening the confirmation must not refresh snapshots')
    await act(() => button('取消').click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(requests.length, 0)
    assert.equal(button('更新本镜头全部引用（1）').disabled, false)
    assert.match(view.container.textContent!, /引用待更新/)
  } finally { await view.destroy() }
})

test('bulk refresh includes every stale binding in the current shot despite filters and preserves fresh bindings and usage', async t => {
  const station = { ...other, board_asset_id: 'station-new' }
  const ticket = { ...profile, id: 'ticket', kind: 'prop', name: '车票', board_asset_id: null } as VisualProfile
  const elder = { ...profile, id: 'elder', name: '老人' }
  const bindings = [
    { ...detail.shot_visual_bindings![0], revision: 1, usage: 'image' as const },
    { ...detail.shot_visual_bindings![0], profile_id: station.id, kind: station.kind, name: station.name, board_asset_id: 'station-old', required: false, usage: 'none' as const },
    { ...detail.shot_visual_bindings![0], profile_id: ticket.id, kind: ticket.kind, name: ticket.name, board_asset_id: null, required: false, usage: 'video' as const },
    { ...detail.shot_visual_bindings![0], profile_id: elder.id, name: elder.name, shot_id: 'other-shot', revision: 1, usage: 'both' as const },
  ]
  const base = { ...detail, visual_profiles: [profile, station, ticket, elder], shots: [...detail.shots, { ...detail.shots[0], id: 'other-shot', title: '出站', position: 1 }], shot_visual_bindings: bindings } as ProjectDetail
  const refreshed = { ...base, shot_visual_bindings: bindings.map(binding => {
    const current = base.visual_profiles!.find(item => item.id === binding.profile_id)!
    return binding.shot_id === 'shot' ? { ...binding, revision: current.revision, board_asset_id: current.board_asset_id } : binding
  }) }
  const requests: Array<{ path: string; body: any }> = []
  let release!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return new Promise<Response>(resolve => { release = resolve })
  })
  const view = await mount(<Bindings presentation="drawer" detail={base} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.match(view.container.textContent!, /2 项引用待更新/)
    const propTab = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.startsWith('道具'))!
    await act(() => propTab.click())
    await fill('搜索引用设定', '不存在的设定')
    assert.equal(view.container.querySelectorAll('.pc-visual-binding').length, 0)
    await act(() => button('更新本镜头全部引用（2）').click())
    const confirm = button('确认更新')
    await act(() => { confirm.click(); confirm.click() })
    assert.deepEqual(requests, [{ path: '/api/shots/shot/visual-bindings', body: {
      bindings: [
        { profile_id: 'lin', required: true, usage: 'image' },
        { profile_id: 'station', required: false, usage: 'none' },
        { profile_id: 'ticket', required: false, usage: 'video' },
      ], refresh_profile_ids: ['lin', 'station'],
    } }])
    assert.equal(button('确认更新').disabled, true, 'a pending update blocks duplicate submissions')
    assert.equal(button('取消').disabled, true)
    await act(() => release(Response.json(data(refreshed))))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(view.container.querySelector('[aria-label="引用更新"]'), null, 'stale references belonging to other shots do not keep this action visible')
    assert.match(view.container.textContent!, /已更新当前镜头的 2 个引用/)
  } finally { await view.destroy() }
})

test('failed bulk refresh preserves the shot snapshots and permits retrying the same confirmed update', async t => {
  const requests: Array<{ path: string; body: any }> = []
  const updated = { ...detail, shot_visual_bindings: [{ ...detail.shot_visual_bindings![0], board_asset_id: profile.board_asset_id }] }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return requests.length === 1 ? Response.json({ error: '暂时无法更新' }, { status: 500 }) : Response.json(data(updated))
  })
  const view = await mount(<Bindings presentation="drawer" detail={detail} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    await act(() => button('更新本镜头全部引用（1）').click())
    await act(() => button('确认更新').click())
    assert.ok(document.querySelector('[role="dialog"]'), 'a failed update leaves the confirmation available to retry')
    assert.match(document.querySelector('[role="dialog"] [role="alert"]')!.textContent!, /暂时无法更新/)
    assert.equal(button('确认更新').disabled, false)
    assert.match(view.container.textContent!, /1 项引用待更新/)
    await act(() => button('确认更新').click())
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1], requests[0], 'retry retains the original usage, required flags and refresh scope')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(view.container.querySelector('[aria-label="引用更新"]'), null)
    assert.match(view.container.textContent!, /已更新当前镜头的 1 个引用/)
  } finally { await view.destroy() }
})

test('shot usage can change independently while retaining other objects and frozen references', async t => {
  const original = { ...detail, shot_visual_bindings: [{ ...detail.shot_visual_bindings![0], usage: 'both' as const }] }
  let saved: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    saved = JSON.parse(String(init?.body))
    return Response.json({ ...data(original), shot_visual_bindings: [{ ...original.shot_visual_bindings[0], usage: saved.bindings[0].usage }] })
  })
  const view = await mount(<Bindings detail={original} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    await choose('林晚 使用范围', 'video')
    assert.deepEqual(saved.bindings, [{ profile_id: 'lin', required: true, usage: 'video' }])
    assert.deepEqual(saved.refresh_profile_ids, [])
  } finally { await view.destroy() }
})

test('shot reference choices recommend the camera angle, save explicit ordered IDs and retain other bindings', async t => {
  const reference = (id: string, view: 'side' | 'face') => ({ id, asset_id: id, profile_id: profile.id, view,
    purpose: view === 'face' ? 'identity' as const : 'costume' as const, label: view === 'face' ? '面部' : '校服侧面',
    revision: 2, style_version: null, status: 'confirmed' as const, is_default: view === 'face', source_asset_id: null, source_job_id: null,
    created_at: '', updated_at: '' })
  const refs = [reference('face-ref', 'face'), reference('side-ref', 'side')]
  const current = { ...profile, reference_assets: refs }
  const extra = { ...detail.shot_visual_bindings![0], profile_id: other.id, kind: other.kind, name: other.name, required: false }
  const base = { ...detail, shots: [{ ...detail.shots[0], prompt: '林晚侧面近景', image_prompt: '从侧面拍林晚' }],
    visual_profiles: [current, other], shot_visual_bindings: [{ ...detail.shot_visual_bindings![0], board_asset_id: profile.board_asset_id, reference_assets: [] }, extra],
    assets: [...detail.assets, ...refs.map(ref => ({ id: ref.asset_id, kind: 'image', url: `/${ref.asset_id}.png` }))],
  } as ProjectDetail
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ path: String(url), body })
    const chosen = body.bindings.find((binding: any) => binding.profile_id === profile.id).reference_asset_ids
    return Response.json({ ...data(base), shot_visual_bindings: [{ ...base.shot_visual_bindings![0], reference_assets: chosen.map((id: string) => refs.find(ref => ref.id === id)) }, extra] })
  })
  const view = await mount(<Bindings detail={base} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.equal(requests.length, 0, 'viewing recommendations does not generate or mutate assets')
    await act(() => button('按镜头推荐').click())
    assert.equal(requests[0].path, '/api/shots/shot/visual-bindings')
    assert.deepEqual(requests[0].body.bindings, [{ profile_id: profile.id, required: true, reference_asset_ids: ['face-ref', 'side-ref'] }, { profile_id: other.id, required: false }])
    assert.match(view.container.textContent!, /2 张独立参考图/)
    await check('面部 · 身份与外貌')
    assert.deepEqual(requests[1].body.bindings[0].reference_asset_ids, ['side-ref'])
    assert.equal(document.querySelectorAll('.pc-binding-reference-current img').length, 1)
    await act(() => button('使用信息图').click())
    assert.deepEqual(requests[2].body.bindings[0].reference_asset_ids, [])
  } finally { await view.destroy() }
})

test('frozen archived references can be individually removed while retaining other references, with busy and stale protection', async t => {
  const reference = (id: string, label: string, archived = false) => ({ id, asset_id: id, profile_id: profile.id, view: 'side' as const,
    purpose: 'costume' as const, label, revision: 2, style_version: null, status: archived ? 'archived' as const : 'confirmed' as const,
    is_default: false, source_asset_id: null, source_job_id: null, created_at: '', updated_at: '' })
  const refs = [reference('archived-front', '归档正面', true), reference('archived-side', '归档侧面', true), reference('current-face', '当前面部')]
  const current = { ...profile, reference_assets: refs }
  const extra = { ...detail.shot_visual_bindings![0], profile_id: other.id, kind: other.kind, name: other.name, required: false }
  const base = { ...detail, visual_profiles: [current, other],
    shot_visual_bindings: [{ ...detail.shot_visual_bindings![0], reference_assets: refs }, extra],
    assets: [...detail.assets, ...refs.map(ref => ({ id: ref.asset_id, kind: 'image', url: `/${ref.asset_id}.png` }))],
  } as ProjectDetail
  const requests: Array<{ path: string; body: any }> = []
  let release!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return new Promise<Response>(resolve => { release = resolve })
  })
  const props = { detail: base, context: { target: 'shot:shot' }, onRefresh: async () => {}, onClose: noop, onBusyChange: noop, onLocate: noop }
  const view = await mount(<Bindings {...props} />)
  try {
    const available = view.container.querySelector('[aria-label="林晚 可选独立参考图"]')!
    assert.doesNotMatch(available.textContent!, /归档正面|归档侧面/)
    assert.equal(button('移除镜头参考：归档正面').disabled, false)
    await act(() => button('移除镜头参考：归档正面').click())
    assert.deepEqual(requests, [{ path: '/api/shots/shot/visual-bindings', body: {
      bindings: [{ profile_id: profile.id, required: true, reference_asset_ids: ['archived-side', 'current-face'] }, { profile_id: other.id, required: false }], refresh_profile_ids: [],
    } }])
    assert.equal(button('移除镜头参考：归档侧面').disabled, true, 'a pending save blocks another removal')
    const updated = { ...base, shot_visual_bindings: [{ ...base.shot_visual_bindings![0], reference_assets: refs.slice(1) }, extra] }
    await act(() => release(Response.json(data(updated))))
    assert.equal(view.container.querySelector('[aria-label="移除镜头参考：归档正面"]'), null)
    assert.equal(button('移除镜头参考：归档侧面').disabled, false)
    assert.equal(view.container.querySelectorAll('.pc-binding-reference-current img').length, 2)
    await view.render(<Bindings {...props} detail={{ ...updated, visual_profiles: [{ ...current, revision: 3 }, other] }} />)
    assert.equal(button('移除镜头参考：归档侧面').disabled, true, 'stale snapshots require refreshing before selection changes')
    await act(() => button('移除镜头参考：归档侧面').click())
    assert.equal(requests.length, 1)
  } finally { await view.destroy() }
})

test('profile usage can remove a shot binding and apply scene references to shots', async t => {
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json({ ...data(), shot_visual_bindings: [] })
  })
  const view = await mount(<Bindings detail={detail} context={{ profileId: 'lin' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    assert.match(view.container.textContent!, /已引用 · 2/)
    await check('林晚 · 默认')
    assert.equal(requests[0].path, '/api/shots/shot/visual-bindings'); assert.deepEqual(requests[0].body.bindings, [])
    await choose('选择绑定场次或镜头', 'scene:scene')
    await act(() => button('应用到本场镜头').click())
    assert.equal(requests[1].path, '/api/script-scenes/scene/visual-bindings/apply-to-shots')
  } finally { await view.destroy() }
})

test('a failed binding save keeps prior checks visible with an error', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '无法保存' }, { status: 500 }))
  const view = await mount(<Bindings detail={detail} context={{ target: 'shot:shot' }} onRefresh={async () => {}} onClose={noop} onBusyChange={noop} onLocate={noop} />)
  try {
    await check('林晚 · 默认')
    assert.equal(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /无法保存/)
  } finally { await view.destroy() }
})

test('batch organization shows timed progress, reviews editable missing profiles, then saves without node or image writes', async t => {
  let release!: (value: Response) => void
  const requests: Array<{ path: string; body?: any }> = []
  const draft = { kind: 'prop', name: '车票', variant: '默认', definition: '旧纸质车票', view_requirements: '正面与背面', scene_ids: ['scene'] }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url); if (path.endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] }); requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path === '/api/models') return Response.json([model])
    if (path.endsWith('/analyze')) return new Promise<Response>(resolve => { release = resolve })
    return Response.json(data())
  })
  const view = await mount(<Organizer detail={detail} models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    assert.equal(button('整理设定草稿').disabled, true)
    assert.match(view.container.querySelector('[role="status"]')!.textContent!, /正在整理设定.*处理中/)
    await act(() => release(Response.json({ profiles: [draft, { ...draft, kind: profile.kind, name: profile.name, variant: profile.variant }] })))
    assert.equal(button('确认保存 1 份设定').disabled, false)
    await fill('固定视觉设定', '有金色字样的旧车票')
    await act(() => button('确认保存 1 份设定').click())
    assert.deepEqual(requests.map(item => item.path), ['/api/models', '/api/projects/project/visual-profiles/analyze', '/api/projects/project/visual-profiles'])
    assert.equal(requests.at(-1)!.body.profiles[0].definition, '有金色字样的旧车票')
    assert.deepEqual(requests[1].body.scene_ids, ['scene'])
  } finally { await view.destroy() }
})

test('batch draft cannot be saved after its source script changed', async t => {
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (init?.method === 'POST') writes.push(String(url))
    return Response.json(String(url).endsWith('/models') ? [model] : { profiles: [{ kind: 'prop', name: '票', variant: '默认', definition: '纸票', view_requirements: '正背面', scene_ids: [] }] })
  })
  const props = { detail, models: [model], onRefresh: async () => {}, onClose: noop, onDirtyChange: noop, onBusyChange: noop }
  const view = await mount(<Organizer {...props} />)
  try {
    await act(() => button('整理设定草稿').click())
    await view.render(<Organizer {...props} detail={{ ...detail, script: { ...detail.script, outline: '更新的大纲' } }} />)
    assert.equal(button('确认保存 1 份设定').disabled, true)
    assert.match(view.container.textContent!, /剧本资料已变化/)
    assert.equal(writes.length, 1)
  } finally { await view.destroy() }
})

test('read-only profile editor adopts a newer definition rather than showing stale text', async () => {
  const view = await mount(<Inspector {...inspectorProps} />)
  try {
    await view.render(<Inspector {...inspectorProps} profile={{ ...profile, revision: 3, definition: '更新后的设定' }} />)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="固定视觉设定"]')!.value, '更新后的设定')
    assert.equal(button('保存设定').disabled, true)
    assert.equal(document.querySelector('[role="status"]'), null)
  } finally { await view.destroy() }
})

test('renaming a batch draft to an existing profile is rejected before a save request', async t => {
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (init?.method === 'POST') writes.push(String(url))
    return Response.json(String(url).endsWith('/models') ? [model] : { profiles: [{ kind: 'character', name: '新角色', variant: '默认', definition: '日漫角色', view_requirements: '正背面', scene_ids: [] }] })
  })
  const view = await mount(<Organizer detail={detail} models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    await fill('设定名称', '林晚')
    await act(() => button('确认保存 1 份设定').click())
    assert.match(view.container.querySelector('[role="alert"]')!.textContent!, /已存在或在草稿中重复/)
    assert.equal(writes.length, 1)
  } finally { await view.destroy() }
})
