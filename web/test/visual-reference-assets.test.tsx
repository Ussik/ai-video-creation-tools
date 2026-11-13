import { chooseCombobox } from './component-controls'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, Provider, VisualProfile, VisualReferenceAsset } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: ReferenceAssets, normalizedReferenceCrop, referenceCropFromPoints, referenceAssetNeedsReview } = await import('../src/features/visuals/VisualReferenceAssets')
const { rememberModelSelection, rememberedModelId } = await import('../src/features/models/model-selection-store')
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())

const styleVersion = 'a'.repeat(64)
const profile = { id: 'profile', project_id: 'project', kind: 'character', name: '林晚', variant: '常服', revision: 2,
  definition: '黑色短发，蓝色衬衫', view_requirements: '面部和全身', board_asset_id: 'board', asset_task_id: null, board_prompt: '信息图', reference_assets: [] } as VisualProfile
const detail = { id: 'project', project_visual_style: { version: styleVersion, label: '写实', source: 'settings', details: {} },
  assets: ['board', 'portrait'].map(id => ({ id, project_id: 'project', kind: 'image', filename: `${id}.png`, url: `/assets/${id}.png`, created_at: '2026-10-10T00:00:00Z' })),
  jobs: [] } as unknown as ProjectDetail
const models = [{ id: 'disabled', enabled: false, modality: 'image', name: '停用模型', settings: {} },
  { id: 'image-model', enabled: true, modality: 'image', name: '启用图片模型', settings: { ratios: ['1:1', '3:4', '16:9'], request_template: { ratio: '{{ratio}}' }, pricing: { per_image: .2, currency: '¥' } } },
  { id: 'video-model', enabled: true, modality: 'video', name: '视频模型', settings: {} }] as Model[]
const reference = (id: string, patch: Partial<VisualReferenceAsset> = {}): VisualReferenceAsset => ({ id, asset_id: 'portrait', profile_id: profile.id,
  view: 'face', purpose: 'identity', label: id, revision: 2, style_version: styleVersion, status: 'candidate', is_default: false,
  source_asset_id: null, source_job_id: null, created_at: '', updated_at: '', ...patch })

async function mount(nextProfile = profile, nextDetail = detail, nextModels = models, providers?: Provider[]) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  let refreshes = 0
  await act(async () => root.render(<MantineProvider env="test"><ReferenceAssets profile={nextProfile} detail={nextDetail} models={nextModels} providers={providers} onRefresh={async () => { refreshes++ }} /></MantineProvider>))
  return { container, refreshes: () => refreshes, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
  assert.ok(node, label); return node
}
async function change(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
  assert.ok(field, label)
  if (field.getAttribute('aria-haspopup') === 'listbox' || field.getAttribute('role') === 'combobox') {
    await chooseCombobox(field as HTMLInputElement, label === '独立参考视角' ? '侧面' : label === '独立参考候选数量' ? value + ' 张' : value); return
  }
  const prototype = field.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  await act(() => { setter.call(field, value); field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })
}

test('opening the manager creates no assets or angle nodes; an existing image is registered only on explicit submit', async t => {
  const requests: Array<{ url: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(profile) })
  const screen = await mount()
  try {
    assert.match(screen.container.textContent!, /尚未添加独立参考图/)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(requests.length, 0)
    await act(() => button('添加参考图').click())
    assert.equal(requests.length, 0)
    await act(() => button('选择图片：portrait.png').click())
    await change('独立参考名称', '面部母版')
    await act(() => button('加入参考候选').click())
    assert.deepEqual(requests, [{ url: '/api/visual-profiles/profile/reference-assets', body: {
      expected_revision: 2, expected_style_version: styleVersion, asset_id: 'portrait', view: 'face', purpose: 'identity', label: '面部母版',
    } }])
    assert.equal(screen.refreshes(), 1)
    assert.match(screen.container.textContent!, /核对后可确认使用/)
  } finally { await screen.destroy() }
})

test('crop controls and preview use original-image coordinates and submit a separate candidate', async t => {
  const requests: Array<{ url: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(profile) })
  const screen = await mount()
  try {
    await act(() => button('添加参考图').click())
    await act(() => button('裁切单张参考').click())
    await change('裁切左侧位置百分比', '20'); await change('裁切顶部位置百分比', '30')
    await change('裁切宽度百分比', '40'); await change('裁切高度百分比', '50')
    const image = document.querySelector<HTMLImageElement>('[aria-label="独立参考裁切预览"] img')!
    assert.equal(image.style.width, '250%'); assert.equal(image.style.left, '-50%'); assert.equal(image.style.top, '-60%')
    assert.equal(requests.length, 0)
    await act(() => button('保存裁切候选').click())
    assert.equal(requests[0].url, '/api/visual-profiles/profile/reference-crop')
    assert.deepEqual(requests[0].body.crop, { x: .2, y: .3, width: .4, height: .5 })
    assert.equal(requests[0].body.asset_id, 'board')
    assert.equal(screen.refreshes(), 1)
  } finally { await screen.destroy() }
})

test('angle generation uses enabled image models, previews without generating, invalidates changed inputs and preserves edited prompt', async t => {
  const requests: Array<{ url: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(String(url).endsWith('reference-preview') ? { prompt: '生成同一人物的单个视角，不要拼版。', reference_asset_ids: ['board'], reference_signature: 'signature', project_style_version: styleVersion, mode: 'reference' } : { job: { id: 'job' }, jobs: [{ id: 'job' }] })
  })
  const screen = await mount()
  try {
    await act(() => button('添加参考图').click()); await act(() => button('按角度生成').click())
    const modelSelect = document.querySelector<HTMLSelectElement>('[aria-label="独立参考生成模型"]')!
    await act(() => modelSelect.click())
    assert.deepEqual([...document.getElementById(modelSelect.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].map(item => item.textContent), ['启用图片模型'])
    await act(() => modelSelect.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(requests.length, 0)
    assert.equal(button('生成 1 张候选').disabled, true)
    await act(() => button('预览提示词').click())
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.model_id, 'image-model')
    assert.deepEqual(requests[0].body.reference_asset_ids, ['board'])
    assert.equal(button('生成 1 张候选').disabled, false)
    await change('独立参考视角', 'side')
    assert.equal(button('生成 1 张候选').disabled, true)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /请重新预览/)
    await act(() => button('重新预览提示词').click())
    await change('独立参考生成提示词', '同一人物侧面，单人单视角，保留蓝色衬衫。')
    await change('独立参考候选数量', '2')
    await act(() => button('生成 2 张候选').click())
    const generation = requests.find(item => item.url.endsWith('reference-generate'))!
    assert.equal(generation.body.prompt, '同一人物侧面，单人单视角，保留蓝色衬衫。')
    assert.equal(generation.body.view, 'side'); assert.equal(generation.body.candidate_count, 2)
    assert.equal(generation.body.reference_signature, 'signature')
    assert.equal(screen.refreshes(), 1)
  } finally { await screen.destroy() }
})

test('reference generation prefers the default image model and excludes unavailable providers', async t => {
  const requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ prompt: '单人单视角', reference_asset_ids: ['board'], reference_signature: 'signature', project_style_version: styleVersion, mode: 'reference' })
  })
  const image = { ...models[1]!, provider_id: 'provider' }
  const preferred = { ...image, id: 'preferred', name: '默认图片模型', is_default: true }
  const unavailable = { ...preferred, id: 'unavailable', name: '停用提供商模型', provider_id: 'offline' }
  const screen = await mount(profile, detail, [unavailable, image, preferred], [
    { id: 'provider', enabled: true, adapter: 'http' }, { id: 'offline', enabled: false, adapter: 'http' },
  ] as Provider[])
  try {
    await act(() => button('添加参考图').click()); await act(() => button('按角度生成').click())
    const field = document.querySelector<HTMLInputElement>('[aria-label="独立参考生成模型"]')!
    assert.equal(field.value, '默认图片模型')
    assert.equal(requests.length, 0)
    await act(() => button('预览提示词').click())
    assert.equal(requests[0].model_id, 'preferred')
    await change('独立参考生成模型', '启用图片模型')
    await act(() => button('重新预览提示词').click())
    assert.equal(requests[1].model_id, 'image-model')
  } finally { await screen.destroy() }
})

test('mouse dragging a crop backwards uses the actual image bounds, without letterbox offsets', async () => {
  const screen = await mount()
  try {
    await act(() => button('添加参考图').click()); await act(() => button('裁切单张参考').click())
    const stage = document.querySelector<HTMLDivElement>('[aria-label="在原图上拖动选择裁切区域"]')!
    stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200, right: 310, bottom: 220, x: 10, y: 20, toJSON() {} })
    async function pointer(type: string, x: number, y: number) {
      const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await act(() => stage.dispatchEvent(event))
    }
    await pointer('pointerdown', 250, 180); await pointer('pointermove', 70, 60); await pointer('pointerup', 70, 60)
    const percentages = ['左侧位置', '顶部位置', '宽度', '高度'].map(label => document.querySelector<HTMLInputElement>(`[aria-label="裁切${label}百分比"]`)!.value)
    assert.deepEqual(percentages, ['20', '20', '60', '60'])
  } finally { await screen.destroy() }
})

test('reference generation remembers image choices and preserves a stale prompt when another entry changes the image model', async t => {
  const image = models[1]!, alternate = { ...image, id: 'alternate-image', name: '另一图片模型' }
  const requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ prompt: '已核对的独立参考提示词', reference_asset_ids: ['board'], reference_signature: 'signature', project_style_version: styleVersion, mode: 'reference' })
  })
  const screen = await mount(profile, detail, [image, alternate])
  try {
    await act(() => button('添加参考图').click()); await act(() => button('按角度生成').click())
    await change('独立参考生成模型', alternate.name)
    assert.equal(rememberedModelId('image'), alternate.id)
    await act(() => button('预览提示词').click())
    assert.equal(requests[0].model_id, alternate.id)
    assert.equal(button('生成 1 张候选').disabled, false)
    await act(() => rememberModelSelection('text', 'unrelated-text'))
    assert.equal(button('生成 1 张候选').disabled, false, 'a text preference does not change image generation')
    await act(() => rememberModelSelection('image', image.id))
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="独立参考生成模型"]')!.value, image.name)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="独立参考生成提示词"]')!.value, '已核对的独立参考提示词')
    assert.equal(button('生成 1 张候选').disabled, true)
    assert.equal(requests.length, 1)
    await act(() => button('重新预览提示词').click())
    assert.equal(requests[1].model_id, image.id)
    assert.equal(button('生成 1 张候选').disabled, false)
  } finally { await screen.destroy() }
})

test('old definition or style candidates cannot be confirmed or set as default; archival remains available', async t => {
  const requests: Array<{ url: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(profile) })
  const screen = await mount({ ...profile, reference_assets: [reference('旧版', { revision: 1 }), reference('旧画风', { style_version: 'b'.repeat(64), status: 'confirmed' }), reference('当前候选')] })
  try {
    assert.equal(button('确认参考图：旧版').disabled, true)
    assert.equal(button('设为默认参考：旧画风').disabled, true)
    assert.equal(button('确认参考图：当前候选').disabled, false)
    await act(() => button('归档参考图：旧版').click())
    assert.equal(requests[0].url, `/api/visual-profiles/profile/reference-assets/${encodeURIComponent('旧版')}`)
    assert.deepEqual(requests[0].body, { expected_revision: 2, expected_style_version: styleVersion, status: 'archived' })
  } finally { await screen.destroy() }
})

function styleReviewFixture(origin: 'custom' | 'removed' | 'unknown', status: VisualReferenceAsset['status'] = 'candidate', reviewed = false) {
  const fingerprint = 'f'.repeat(64)
  const item = reference(`${origin}视角`, { status, source_job_id: 'custom-reference-job',
    style_version: status === 'confirmed' ? styleVersion : fingerprint })
  const currentProfile = { ...profile, reference_assets: [item] }
  const currentDetail = { ...detail, visual_profiles: [currentProfile], jobs: [{ id: item.source_job_id, status: 'succeeded',
    result_asset_id: item.asset_id, request: JSON.stringify({ project_style_version: styleVersion,
      effective_visual_style: { origin, fingerprint }, ...(reviewed ? { visual_style_reviews: [{ profile_id: profile.id, style_version: styleVersion }] } : {}) }),
  }] } as unknown as ProjectDetail
  return { item, currentProfile, currentDetail }
}

for (const origin of ['custom', 'removed', 'unknown'] as const) test(`a current ${origin} reference candidate can be explicitly reviewed despite its effective-style fingerprint`, async t => {
  const fixture = styleReviewFixture(origin), requests: Array<{ url: string; body: unknown }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(fixture.currentProfile) })
  const screen = await mount(fixture.currentProfile, fixture.currentDetail)
  try {
    assert.match(screen.container.textContent!, /画风待核对/)
    assert.match(screen.container.textContent!, /确认不会重绘图片/)
    const confirm = button(`确认参考图：${fixture.item.label}`)
    assert.equal(confirm.disabled, false)
    assert.deepEqual(requests, [], 'displaying a warning never approves the image')
    await act(() => confirm.click())
    assert.deepEqual(requests, [{ url: `/api/visual-profiles/profile/reference-assets/${encodeURIComponent(fixture.item.id)}`,
      body: { expected_revision: profile.revision, expected_style_version: styleVersion, status: 'confirmed' } }])
    assert.equal(screen.refreshes(), 1)
  } finally { await screen.destroy() }
})

test('an old automatic confirmed stamp exposes per-image reconfirmation until its matching human review exists', async t => {
  const fixture = styleReviewFixture('custom', 'confirmed'), requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json(fixture.currentProfile) })
  const screen = await mount(fixture.currentProfile, fixture.currentDetail)
  try {
    assert.match(screen.container.textContent!, /画风待核对/)
    assert.equal(button(`设为默认参考：${fixture.item.label}`).disabled, true)
    const confirm = button(`重新确认参考图：${fixture.item.label}`)
    assert.equal(confirm.disabled, false)
    await act(() => confirm.click())
    assert.deepEqual(requests, [{ expected_revision: profile.revision, expected_style_version: styleVersion, status: 'confirmed' }])
  } finally { await screen.destroy() }
  const reviewed = styleReviewFixture('custom', 'confirmed', true)
  const reviewedScreen = await mount(reviewed.currentProfile, reviewed.currentDetail)
  try {
    assert.equal(document.querySelector(`[aria-label="重新确认参考图：${reviewed.item.label}"]`), null)
    assert.equal(button(`设为默认参考：${reviewed.item.label}`).disabled, false)
    assert.doesNotMatch(reviewedScreen.container.textContent!, /画风待核对/)
    assert.equal(requests.length, 1, 'a reviewed image does not trigger any repeat confirmation')
  } finally { await reviewedScreen.destroy() }
})

test('current custom archived views can be restored for review while genuinely old revisions remain blocked', async t => {
  const fixture = styleReviewFixture('removed', 'archived'), old = { ...fixture.item, id: 'old-custom', label: '旧版自定义视角', revision: profile.revision - 1 }
  const currentProfile = { ...fixture.currentProfile, reference_assets: [fixture.item, old] }
  const requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return Response.json(currentProfile) })
  const screen = await mount(currentProfile, { ...fixture.currentDetail, visual_profiles: [currentProfile] })
  try {
    await act(() => button('已归档 · 2').click())
    assert.equal(button(`恢复参考图：${fixture.item.label}`).disabled, false)
    assert.equal(button(`恢复参考图：${old.label}`).disabled, true)
    await act(() => button(`恢复参考图：${fixture.item.label}`).click())
    assert.deepEqual(requests, [{ expected_revision: profile.revision, expected_style_version: styleVersion, status: 'candidate' }])
  } finally { await screen.destroy() }
  const oldCandidate = { ...old, status: 'candidate' as const }
  const oldProfile = { ...currentProfile, reference_assets: [oldCandidate] }
  const oldScreen = await mount(oldProfile, { ...fixture.currentDetail, visual_profiles: [oldProfile] })
  try {
    assert.equal(button(`确认参考图：${old.label}`).disabled, true)
    await act(() => button(`确认参考图：${old.label}`).click())
    assert.equal(requests.length, 1)
  } finally { await oldScreen.destroy() }
})

test('failed mutations retain the open review and show the server error', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: '设定版本已更新，请刷新' }, { status: 409 }))
  const screen = await mount()
  try {
    await act(() => button('添加参考图').click()); await act(() => button('加入参考候选').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /设定版本已更新/)
    assert.ok(document.querySelector('[role="dialog"]'))
    assert.equal(screen.refreshes(), 0)
    assert.equal(button('加入参考候选').disabled, false)
  } finally { await screen.destroy() }
})

test('partial generation failures stay visible with their exact reason, separate from board jobs and earlier revisions', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('查看失败原因不应发送请求') })
  const metadata = { visual_reference_generation: true, visual_profile_id: profile.id, visual_profile_revision: 2, visual_reference_view: 'side', visual_reference_label: '侧脸候选' }
  const job = (id: string, status: string, request: object, error: string | null) => ({ id, model_id: 'image-model', status, request: JSON.stringify(request), error, created_at: '2026-10-10T10:00:00Z' })
  const nextDetail = { ...detail, jobs: [
    job('success', 'succeeded', metadata, null), job('failure', 'failed', metadata, '图片服务超时，请稍后重新提交'),
    job('pending', 'queued', metadata, null),
    job('board-failure', 'failed', { visual_profile_id: profile.id, visual_profile_revision: 2 }, '母版错误不应显示'),
    job('old-failure', 'failed', { ...metadata, visual_profile_revision: 1 }, '旧版错误不应显示'),
    job('foreign-failure', 'failed', { ...metadata, visual_profile_id: 'other' }, '其他设定错误不应显示'),
  ] } as unknown as ProjectDetail
  const screen = await mount(profile, nextDetail)
  try {
    assert.match(screen.container.textContent!, /正在生成 1 张参考候选/)
    const failures = screen.container.querySelector<HTMLDetailsElement>('.pc-reference-job-failures')!
    assert.ok(failures)
    assert.match(failures.querySelector('.workspace-disclosure-control')!.textContent!, /生成失败 · 1 张 · 查看原因/)
    assert.equal(failures.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'false')
    await act(() => failures.querySelector('.workspace-disclosure-control')!.click())
    assert.equal(failures.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'true')
    assert.match(failures.textContent!, /侧脸候选/)
    assert.match(failures.textContent!, /图片服务超时，请稍后重新提交/)
    assert.doesNotMatch(screen.container.textContent!, /母版错误不应显示|旧版错误不应显示|其他设定错误不应显示/)
    assert.equal(calls, 0)
  } finally { await screen.destroy() }
})

test('reverse drags and numeric crop changes stay inside the original image; unrecorded style needs review', () => {
  assert.deepEqual(referenceCropFromPoints({ x: .8, y: .9 }, { x: .2, y: .3 }), { x: .2, y: .3, width: .6000000000000001, height: .6000000000000001 })
  assert.deepEqual(normalizedReferenceCrop({ x: .8, y: -.2, width: .6, height: 2 }), { x: .8, y: 0, width: .19999999999999996, height: 1 })
  assert.equal(referenceAssetNeedsReview(reference('a', { style_version: null }), profile, styleVersion), true)
  assert.equal(referenceAssetNeedsReview(reference('a'), profile, styleVersion), false)
})
