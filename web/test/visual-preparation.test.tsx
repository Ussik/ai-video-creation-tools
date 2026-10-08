import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, Model, ProjectDetail, VisualProfile } from '../src/api'
import { imageRatios } from '../src/canvas-model-parameters'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: VisualPreparation } = await import('../src/VisualPreparation')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
Object.assign(globalThis, {
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const staleModel: Model = {
  id: 'image-model', provider_id: 'provider', name: '图片模型', remote_id: 'image-model', modality: 'image', protocol: 'image_generations', enabled: true,
  settings: { request_template: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}' }, resolutions: ['1024x1024', '1536x1024', '1024x1536'], ratios: imageRatios },
}
const currentModel: Model = { ...staleModel, settings: { request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' }, ratios: imageRatios } }
const profile: VisualProfile = {
  id: 'profile', project_id: 'project', kind: 'character', name: '人物', variant: '默认', definition: '人物的固定视觉设定',
  view_requirements: '正面、侧面、背面', revision: 1, board_asset_id: null, asset_task_id: null, board_prompt: '制作人物信息图',
}
const detail = {
  id: 'project', script: { scenes: [{ id: 'scene', heading: '车站 · 傍晚' }] }, shots: [], assets: [],
  visual_profiles: [profile], scene_visual_bindings: [], shot_visual_bindings: [],
} as unknown as ProjectDetail

async function mount(initialDetail = detail, initialModels = [staleModel]) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = async (models: Model[] = initialModels) => {
    try {
      await act(() => root.render(<MantineProvider env="test"><VisualPreparation detail={initialDetail} models={models} onRefresh={async () => {}} onClose={() => {}} /></MantineProvider>))
    } catch (issue) {
      throw issue instanceof AggregateError ? issue.errors[0] : issue
    }
  }
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label)
  assert.ok(found, label)
  return found
}
async function chooseRatio(ratio: string) {
  await act(() => document.querySelector<HTMLInputElement>('input[aria-label="信息图画幅"]')!.click())
  await act(() => document.querySelector<HTMLElement>(`[role="option"][value="${ratio}"]`)!.click())
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const emptyPreview = { prompt: profile.board_prompt, mode: 'text', reference_asset_ids: [], reference_names: [], reference_signature: 'test-signature' }

test('visual preparation refreshes stale model settings on open and before review, keeping the selected ratio for submission', async t => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  let resolveCatalog!: (value: Response) => void
  let catalogRequests = 0
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/models') {
      catalogRequests++
      return catalogRequests === 1 ? new Promise(resolve => { resolveCatalog = resolve }) : response([currentModel])
    }
    if (url === '/api/visual-profiles/profile/board-task') return response({ task_id: 'task', prompt: profile.board_prompt })
    if (url === '/api/visual-profiles/profile/board-preview') return response(emptyPreview)
    if (url === '/api/asset-tasks/task/generate') return response({ task: { id: 'task', status: 'ready' } })
    if (url === '/api/projects/project/visual-profiles') return response({ visual_profiles: [profile], scene_visual_bindings: [], shot_visual_bindings: [] })
    throw new Error(`Unexpected request: ${url}`)
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const view = await mount()
  try {
    assert.equal(button('生成信息图').disabled, true, 'generation waits for current model settings')
    assert.ok(document.body.textContent?.includes('正在更新模型配置'))
    await act(async () => resolveCatalog(response([currentModel])))
    assert.equal(button('生成信息图').disabled, false)
    await chooseRatio('9:16')
    // A stale parent rerender must not poison the final confirmation.
    await view.render([{ ...staleModel }])
    await act(() => button('生成信息图').click())
    assert.equal(catalogRequests, 2)
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="信息图画幅"]')?.value, '9:16')
    assert.equal(document.querySelector('.vp-board-size-note'), null)
    assert.deepEqual([...document.querySelectorAll('.vp-board-parameters dt')].map(element => element.textContent), ['图片模型', '画幅', '预估费用'])
    assert.equal([...document.querySelectorAll('.vp-board-parameters dd')].filter(element => element.textContent === '9:16').length, 1)
    assert.equal(button('确认生成').disabled, false)
    await act(() => button('确认生成').click())
    const submission = requests.find(item => item.url.endsWith('/generate'))!.body!
    assert.equal(submission.model_id, currentModel.id)
    assert.equal(submission.ratio, '9:16')
    assert.equal(submission.resolution, null)
    assert.ok(String(submission.prompt).startsWith(profile.board_prompt))
    assert.ok(String(submission.prompt).includes('画面比例：9:16（宽:高，竖版）'))
    assert.ok(String(submission.prompt).includes('整张输出图片使用此比例'))
  } finally { await view.destroy() }
})

test('confirmed character reference boards are reviewed and submitted in reference mode', async t => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const referenceProfile = { ...profile, id: 'linwan', name: '林晚', variant: '夜探旧祠堂', board_asset_id: 'linwan-board' }
  const fixture = { ...detail, visual_profiles: [{ ...profile, board_asset_id: 'current-board' }, referenceProfile], assets: [
    { id: 'current-board', kind: 'image', filename: '当前人物信息图.png', url: '/current.png' } as Asset,
    { id: 'linwan-board', kind: 'image', filename: '林晚信息图.png', url: '/linwan.png' } as Asset,
  ] }
  const referenceModel = { ...currentModel, settings: { ...currentModel.settings, request_templates: { reference: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}' } } } }
  const preview = { prompt: `${profile.board_prompt}\n参考图 1：林晚 · 夜探旧祠堂`, mode: 'reference', reference_asset_ids: ['linwan-board'], reference_names: ['林晚 · 夜探旧祠堂 · v1'], reference_signature: 'reference-signature' }
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), body })
    if (url === '/api/models') return response([referenceModel])
    if (url === '/api/visual-profiles/profile/board-preview') return response(preview)
    if (url === '/api/visual-profiles/profile/board-task') return response({ task_id: 'task', prompt: preview.prompt })
    if (url === '/api/asset-tasks/task/generate') return response({ task: { id: 'task', status: 'ready' } })
    if (url === '/api/projects/project/visual-profiles') return response(fixture)
    throw new Error(`Unexpected request: ${url}`)
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const view = await mount(fixture, [referenceModel])
  try {
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="生成参考图"]')!.click())
    assert.equal(document.querySelector('[role="option"][value="profile:profile"]'), null, 'the current profile is not offered as a related profile reference')
    await act(() => document.querySelector<HTMLElement>('[role="option"][value="profile:linwan"]')!.click())
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="生成参考图"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await chooseRatio('9:16')
    await act(() => button('生成信息图').click())
    assert.deepEqual(requests.find(item => item.url.endsWith('/board-preview'))!.body!.reference_profile_ids, ['linwan'])
    assert.equal(document.querySelector('.vp-board-size-note'), null, 'ratio validation uses the reference template')
    assert.ok(document.querySelector('.vp-board-review')?.textContent?.includes('林晚 · 夜探旧祠堂 · v1'))
    assert.equal(document.querySelector('.vp-board-review img')?.getAttribute('src'), '/linwan.png')
    await act(() => button('确认生成').click())
    assert.equal(requests.find(item => item.url.endsWith('/board-task'))!.body!.reference_signature, preview.reference_signature)
    const submission = requests.find(item => item.url.endsWith('/generate'))!.body!
    assert.equal(submission.mode, 'reference')
    assert.deepEqual(submission.reference_asset_ids, ['linwan-board'])
    assert.ok(String(submission.prompt).startsWith(preview.prompt))
    assert.ok(String(submission.prompt).includes('画面比例：9:16（宽:高，竖版）'))
    assert.ok(String(submission.prompt).includes('整张输出图片使用此比例'))
    assert.equal(submission.ratio, '9:16')
    assert.equal(submission.resolution, null)
  } finally { await view.destroy() }
})

test('unconfigured reference fields show a configuration warning and cannot enqueue generation', async t => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  const reference = { ...profile, id: 'reference-profile', name: '林晚', board_asset_id: 'board' }
  const fixture = { ...detail, visual_profiles: [profile, reference], assets: [{ id: 'board', kind: 'image', filename: 'board.png', url: '/board.png' } as Asset] }
  globalThis.fetch = async url => {
    requests.push(String(url))
    return url === '/api/models' ? response([currentModel]) : response({ message: '当前模型的本地请求模板未配置参考图字段' }, 422)
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const view = await mount(fixture)
  try {
    await act(() => document.querySelector<HTMLInputElement>('input[aria-label="生成参考图"]')!.click())
    await act(() => document.querySelector<HTMLElement>('[role="option"][value="profile:reference-profile"]')!.click())
    assert.ok(document.querySelector('.vp-reference-note')?.textContent?.includes('本地请求模板未配置参考图字段'))
    await act(() => button('生成信息图').click())
    assert.equal(document.querySelector('.vp-board-review'), null)
    assert.ok(document.querySelector('[role="alert"]'))
    assert.equal(requests.some(url => url.endsWith('/generate') || url.endsWith('/board-task')), false)
  } finally { await view.destroy() }
})

test('a failed catalog refresh prevents reviewing stale settings and makes no generation writes', async t => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async url => {
    requests.push(String(url))
    return requests.length === 1 ? response([currentModel]) : response({ message: '模型配置读取失败' }, 503)
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const view = await mount()
  try {
    await chooseRatio('9:16')
    await act(() => button('生成信息图').click())
    assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('模型配置读取失败'))
    assert.equal(document.querySelector('.vp-board-review'), null)
    assert.deepEqual(requests, ['/api/models', '/api/models'])
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="信息图画幅"]')?.value, '9:16')
  } finally { await view.destroy() }
})
