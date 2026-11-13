import assert from 'node:assert/strict'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, VisualProfile, VisualProfileDraft } from '../src/shared/api/api'
import { chooseCombobox } from './component-controls'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Fields } = await import('../src/features/visuals/VisualProfileFields')
const { default: Inspector } = await import('../src/features/visuals/VisualProfileInspector')
const { default: Organizer } = await import('../src/features/visuals/VisualProfileOrganizer')
const { rememberModelSelection } = await import('../src/features/models/model-selection-store')
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())
const noop = () => {}
const base = { id: 'base', project_id: 'project', kind: 'character', name: '林晚', variant: '基础', definition: '黑色短发，固定脸型', view_requirements: '正侧背', revision: 1,
  definition_status: 'ready', base_profile_id: null, state_delta: '', board_asset_id: null, asset_task_id: null, board_prompt: '基础图' } as VisualProfile
const state = { ...base, id: 'state', variant: '雨夜', base_profile_id: base.id, state_delta: '蓝色雨衣' }
const detail = { id: 'project', name: '雨夜', shots: [], assets: [], jobs: [], asset_tasks: [], visual_profiles: [base, state], scene_visual_bindings: [], shot_visual_bindings: [],
  script: { outline: '林晚雨夜回家', characters: '林晚', generation_options: {}, artifacts: [], scenes: [{ id: 'scene', heading: '小巷 · 夜', episode_number: 1 }] } } as unknown as ProjectDetail
const model = { id: 'text', modality: 'text', name: '文本模型', enabled: true, settings: {} } as Model
const baseDraft: VisualProfileDraft = { kind: 'character', name: '新角色', variant: '基础', definition: '人物固定身份', view_requirements: '正侧背', scene_ids: ['scene'], draft_key: 'base-draft' }
const stateDraft: VisualProfileDraft = { ...baseDraft, variant: '战斗', draft_key: 'state-draft', base_draft_key: 'base-draft', state_delta: '战损外套' }
async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test">{element}</MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(found, label); return found
}
async function fill(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  assert.ok(field, label)
  const setter = Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(() => { setter.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
const choose = (label: string, value: string) => chooseCombobox(document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!, value)
const inspectorProps = { profile: state, inCanvas: true, detail, generating: false, onRefresh: async () => {}, onClose: noop, onBindings: noop,
  onDirtyChange: noop, onBusyChange: noop, onSaved: noop, onDeleted: noop, onOpenCanvas: noop }
function organizerFetch(t: TestContext, drafts: VisualProfileDraft[], requests: Array<{ path: string; body: any }>) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (path.endsWith('/models')) return Response.json([model])
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    return Response.json({ profiles: drafts })
  })
}

test('profile fields explicitly choose a base and change only the current state differences', async () => {
  function Harness() {
    const [value, setValue] = React.useState<VisualProfileDraft>({ ...baseDraft, name: '林晚', variant: '冬装' })
    return <><Fields value={value} profiles={[base]} onChange={patch => setValue(current => ({ ...current, ...patch }))} /><output>{JSON.stringify(value)}</output></>
  }
  const view = await mount(<Harness />)
  try {
    assert.equal(document.querySelector('[aria-label="本状态的差异"]'), null)
    await choose('基础设定', '林晚 · 基础（待确认基础图）')
    await fill('本状态的差异', '厚羊毛外套，保留原脸型和发型')
    const value = JSON.parse(view.container.querySelector('output')!.textContent!)
    assert.equal(value.base_profile_id, 'base'); assert.equal(value.base_draft_key, null)
    assert.equal(value.state_delta, '厚羊毛外套，保留原脸型和发型')
    await choose('基础设定', '独立基础设定')
    assert.equal(document.querySelector('[aria-label="本状态的差异"]'), null)
    assert.equal(JSON.parse(view.container.querySelector('output')!.textContent!).state_delta, '')
  } finally { await view.destroy() }
})

test('inspector retains and saves base relation and state delta, and locates the unconfirmed base', async t => {
  let located = '', body: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ ...state, state_delta: body.state_delta }) })
  const view = await mount(<Inspector {...inspectorProps} onOpenCanvas={profile => { located = profile.id }} />)
  try {
    assert.match(view.container.textContent!, /先确认「林晚 · 基础」的基础图/)
    await act(() => button('前往基础图').click()); assert.equal(located, 'base')
    await fill('本状态的差异', '蓝色雨衣，肩部湿透')
    assert.equal(button('保存设定').disabled, false)
    await act(() => button('保存设定').click())
    assert.equal(body.expected_revision, 1); assert.equal(body.base_profile_id, 'base')
    assert.equal(body.state_delta, '蓝色雨衣，肩部湿透')
  } finally { await view.destroy() }
})

test('a foundational profile cannot be deleted while a state still inherits it', async () => {
  const view = await mount(<Inspector {...inspectorProps} profile={base} />)
  try {
    assert.equal(button('删除设定').disabled, true)
    assert.match(view.container.textContent!, /1 份状态设定沿用此基础/)
  } finally { await view.destroy() }
})

test('batch organizer remaps a filtered saved base and submits the reviewed relation with its state difference', async t => {
  const requests: Array<{ path: string; body: any }> = []
  organizerFetch(t, [{ ...baseDraft, name: base.name, variant: base.variant }, { ...stateDraft, name: base.name, variant: '战斗' }], requests)
  const view = await mount(<Organizer detail={detail} models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    assert.equal(button('确认保存 1 份设定').disabled, false)
    await fill('本状态的差异', '战损外套，左袖撕裂')
    await act(() => button('确认保存 1 份设定').click())
    const saved = requests.at(-1)!.body.profiles[0]
    assert.equal(saved.draft_key, 'state-draft'); assert.equal(saved.base_profile_id, base.id)
    assert.equal(saved.base_draft_key, null); assert.equal(saved.state_delta, '战损外套，左袖撕裂')
  } finally { await view.destroy() }
})

test('removing a base draft blocks save until the affected state explicitly chooses another base', async t => {
  const requests: Array<{ path: string; body: any }> = []
  organizerFetch(t, [baseDraft, stateDraft], requests)
  const view = await mount(<Organizer detail={detail} models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    await act(() => button('移除此草稿').click())
    assert.equal(button('确认保存 1 份设定').disabled, true)
    assert.match(view.container.textContent!, /基础设定已移除或不存在/)
    assert.equal(requests.length, 1)
    await choose('基础设定', '林晚 · 基础（待确认基础图）')
    assert.equal(button('确认保存 1 份设定').disabled, false)
    await act(() => button('确认保存 1 份设定').click())
    assert.equal(requests[1].body.profiles[0].base_profile_id, 'base')
  } finally { await view.destroy() }
})

test('an analyzed cycle is shown as a relation conflict and cannot be saved', async t => {
  const requests: Array<{ path: string; body: any }> = []
  organizerFetch(t, [{ ...baseDraft, base_draft_key: stateDraft.draft_key }, stateDraft], requests)
  const view = await mount(<Organizer detail={detail} models={[model]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    assert.equal(button('确认保存 2 份设定').disabled, true)
    assert.match(view.container.textContent!, /循环引用/)
    assert.equal(requests.length, 1)
  } finally { await view.destroy() }
})

test('a shared text model change preserves edited visual drafts, blocks saving and restores them when switching back', async t => {
  const alternate = { ...model, id: 'another-text', name: '另一文本模型' }
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url)
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [{ stage: 'visual_assets', label: '视觉设定', primary_id: null, auxiliary_ids: [], source: 'global', warning: '', skills: [] }] })
    if (path.endsWith('/models')) return Response.json([model, alternate])
    requests.push({ path, body: JSON.parse(String(init?.body)) })
    return Response.json({ profiles: [baseDraft] })
  })
  const view = await mount(<Organizer detail={detail} models={[model, alternate]} onRefresh={async () => {}} onClose={noop} onDirtyChange={noop} onBusyChange={noop} />)
  try {
    await act(() => button('整理设定草稿').click())
    assert.equal(requests[0].body.model_id, model.id)
    await fill('设定名称', '人工调整的角色名称')
    assert.equal(button('确认保存 1 份设定').disabled, false)
    await act(() => rememberModelSelection('text', alternate.id))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="设定名称"]')!.value, '人工调整的角色名称', 'the edited draft stays visible')
    assert.equal(button('确认保存 1 份设定').disabled, true)
    assert.match(view.container.textContent!, /文本模型已切换/)
    assert.doesNotMatch(view.container.textContent!, /剧本资料已变化/)
    assert.equal(requests.length, 1, 'synchronization neither saves nor analyzes automatically')
    await act(() => rememberModelSelection('text', model.id))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="设定名称"]')!.value, '人工调整的角色名称')
    assert.equal(button('确认保存 1 份设定').disabled, false, 'returning to the generating model restores the existing draft')
    assert.doesNotMatch(view.container.textContent!, /文本模型已切换/)
    assert.equal(requests.length, 1)
    await act(() => rememberModelSelection('text', alternate.id))
    await act(() => button('放弃草稿').click())
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="整理设定的文本模型"]')!.value, alternate.name)
  } finally { await view.destroy() }
})
