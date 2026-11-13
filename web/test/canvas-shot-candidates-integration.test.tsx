import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, Job, Model, ProjectDetail } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'
import type { ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'

// Render the actual canvas and composer; only CSS and HTTP transport are mocked.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLMediaElement.prototype.pause = () => {}
let frameId = 0
const frames = new Map<number, FrameRequestCallback>()
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
function dimensions(element: Element) {
  const node = element instanceof dom.window.HTMLElement ? element : null
  const sizedNode = node?.closest<HTMLElement>('.react-flow__node')
  return { width: Number.parseFloat(node?.style.width || sizedNode?.style.width || '') || 1200,
    height: Number.parseFloat(node?.style.height || sizedNode?.style.height || '') || 800 }
}
for (const [name, axis] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height']] as const) {
  Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() { return dimensions(this)[axis] } })
}
dom.window.Element.prototype.getBoundingClientRect = function () {
  const size = dimensions(this)
  const position = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(this.getAttribute('style') || '')
  const x = Number(position?.[1] || 0), y = Number(position?.[2] || 0)
  return { ...size, x, y, left: x, top: y, right: x + size.width, bottom: y + size.height, toJSON() { return this } }
}
class TestResizeObserver {
  private targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target)
    queueMicrotask(() => {
      if (target.isConnected && this.targets.has(target)) this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)
    })
  }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
}
Object.assign(globalThis, { ResizeObserver: TestResizeObserver })
Object.assign(dom.window, { ResizeObserver: TestResizeObserver, DOMMatrixReadOnly: class {
  m22: number
  constructor(transform: string) { this.m22 = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] || 1) }
} })
const { createRoot } = await import('react-dom/client')
const { default: ProjectCanvas } = await import('../src/features/canvas/ProjectCanvas')
after(() => dom.window.close())

const projectId = 'shot-candidates-test'
const timestamp = '2026-10-17T01:00:00Z'
const latestTimestamp = '2026-10-17T02:00:00Z'
const imageModel: Model = { id: 'image-model', provider_id: 'provider', name: '分镜图片模型', remote_id: 'image-v1',
  modality: 'image', protocol: 'image_generations', enabled: true,
  settings: { supported_modes: ['text', 'reference'], resolutions: ['4K'], ratios: ['16:9'], max_reference_images: 10 } }
const videoModel: Model = { ...imageModel, id: 'video-model', name: '视频模型', modality: 'video', protocol: 'async_video',
  settings: { supported_modes: ['first_frame'], resolutions: ['480p'], ratios: ['16:9'] } }
function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return { id, project_id: projectId, shot_id: 'shot', kind: 'image', filename: `${id}.png`, source: 'generated', model_id: imageModel.id,
    prompt: '林晚站在月台。', remote_url: null, saved: true, created_at: timestamp, url: `/api/assets/${id}/file`, ...overrides }
}
function job(id: string, resultAssetId: string, input: Record<string, unknown> = {}, overrides: Partial<Job> = {}): Job {
  return { id, project_id: projectId, shot_id: 'shot', model_id: imageModel.id, job_type: 'generation',
    request: JSON.stringify({ prompt: '林晚站在月台。', modality: 'image', mode: 'text', shot_id: 'shot', reference_asset_ids: [], ...input }),
    status: 'succeeded', external_id: null, result_asset_id: resultAssetId, recovery_available: false, error: null,
    created_at: timestamp, ...overrides }
}
function fixture(): { detail: ProjectDetail; graph: CanvasGraph } {
  const detail = { id: projectId, name: '夜班列车', brief: '车站故事', ratio: '16:9', updated_at: timestamp,
    script: { outline: '林晚等车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
    shots: [{ id: 'shot', project_id: projectId, position: 0, title: '站台回望', prompt: '林晚站在月台。', duration: 5,
      selected_asset_id: 'final-video', source_scene_id: null, start_state: '', end_state: '', cut_note: '' },
    { id: 'other-shot', project_id: projectId, position: 1, title: '另一镜头', prompt: '列车入站。', duration: 5,
      selected_asset_id: null, source_scene_id: null, start_state: '', end_state: '', cut_note: '' }],
    assets: [asset('older'), asset('latest', { created_at: latestTimestamp }), asset('other-shot', { shot_id: 'other-shot' }),
      asset('profile-board'), asset('profile-reference'), asset('failed-result'),
      asset('frame', { model_id: null, prompt: null }), asset('uploaded', { source: 'upload', model_id: null }),
      asset('final-video', { kind: 'video', model_id: videoModel.id, filename: 'final-video.mp4' })],
    jobs: [job('older-job', 'older'), job('latest-job', 'latest', {}, { created_at: latestTimestamp }),
      job('other-shot-job', 'other-shot', { shot_id: 'other-shot' }, { shot_id: 'other-shot' }),
      job('profile-job', 'profile-board', { visual_profile_id: 'hero', asset_task_id: 'profile-task' }),
      job('profile-reference-job', 'profile-reference', { visual_profile_id: 'hero', visual_reference_generation: true }),
      job('failed-job', 'failed-result', {}, { status: 'failed' }),
      job('video-job', 'final-video', { modality: 'video' }, { model_id: videoModel.id })],
    asset_tasks: [], timeline_clips: [{ id: 'clip', project_id: projectId, shot_id: 'shot', asset_id: 'final-video',
      in_ms: 500, out_ms: 4500, source_duration_ms: 5000, source_audio_gain: 0.8, source_audio_fade_ms: 100 }],
    asset_reviews: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
  } as unknown as ProjectDetail
  const base: CanvasNode = { id: 'image-node', type: 'generation', x: 50, y: 100, width: 440, height: 420,
    title: '站台回望', text: '', prompt: '林晚站在月台。', asset_id: 'latest', shot_id: 'shot', model_id: imageModel.id,
    job_id: 'latest-job', settings: { modality: 'image', mode: 'text', resolution: '4K', ratio: '16:9' } }
  const graph: CanvasGraph = { revision: 'initial', nodes: [base, { ...base, id: 'video-node', x: 650, title: '分镜视频',
    model_id: videoModel.id, job_id: 'video-job', asset_id: 'final-video',
    settings: { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe',
      storyboard_reference_asset_id: 'latest', resolution: '480p', ratio: '16:9' } }],
  edges: [{ id: 'fixed-frame', source: 'image-node', target: 'video-node', reference_asset_id: 'latest' }] }
  return { detail, graph }
}
function mockApi(t: TestContext, initialGraph: CanvasGraph, saveAsset?: (assetId: string) => Response | Promise<Response>) {
  let graph = structuredClone(initialGraph)
  const control = { failNextSave: false }
  const saved: CanvasGraph[] = [], requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    requests.push({ path, method })
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId,
      name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    const assetSave = /^\/api\/assets\/([^/]+)\/save$/.exec(path)
    if (assetSave && saveAsset) {
      assert.equal(method, 'POST')
      return saveAsset(assetSave[1]!)
    }
    assert.equal(path, `/api/projects/${projectId}/canvas`, 'choosing a candidate must never submit generation or change the timeline')
    if (method === 'PUT') {
      if (control.failNextSave) {
        control.failNextSave = false
        return Response.json({ detail: '模拟候选保存失败' }, { status: 500 })
      }
      graph = { ...JSON.parse(String(init?.body)), revision: `saved-${saved.length + 1}` }
      saved.push(structuredClone(graph))
    } else assert.equal(method, 'GET')
    return Response.json(graph)
  })
  return { saved, requests, control, graph: () => structuredClone(graph) }
}
async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}
async function mount(detail: ProjectDetail, nodeId = 'image-node', refresh?: () => Promise<ProjectDetail>) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem(`project-canvas-viewport:${projectId}`, JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail, models: [imageModel, videoModel],
    providers: [{ id: 'provider', name: '本地测试', adapter: 'http', enabled: true } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {
      if (refresh) { props.detail = await refresh(); render() }
    }, onOpenModels() {}, onNavigate() {}, onOpenScriptCreator() {} }
  const render = () => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)
  try {
    await act(render); await settle()
    const image = container.querySelector<HTMLElement>(`[data-id="${nodeId}"]`)
    assert.ok(image)
    await act(() => image.click()); await settle()
  } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { container,
    rerender: async (detail: ProjectDetail) => { props.detail = detail; await act(render); await settle() },
    destroy: async () => { await act(() => root.unmount()); await settle(); container.remove(); frames.clear() } }
}
function candidateStrip(container: HTMLElement) {
  const strip = container.querySelector<HTMLElement>('[aria-label="分镜图候选"]')
  assert.ok(strip, 'shot image composer exposes candidate thumbnails'); return strip
}
function selectedImage(container: HTMLElement) {
  const image = container.querySelector<HTMLImageElement>('[data-id="image-node"] .pc-node-output img')
  assert.ok(image); return image.getAttribute('src')
}
async function useCandidate(container: HTMLElement, id: string) {
  const image = [...candidateStrip(container).querySelectorAll('img')].find(image => image.getAttribute('src') === `/api/assets/${id}/file`)
  assert.ok(image, `${id} is available`)
  const button = image.closest('button'); assert.ok(button)
  await act(() => button.click()); await settle()
}

function composerAssetSave(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('.pc-prompt-composer button')]
    .find(button => /^(保存到资产|已保存到资产)$/.test(button.textContent?.trim() || ''))
}

for (const modality of ['image', 'video'] as const) test(`the ${modality} composer saves its displayed historical result to the library without changing the canvas or final cut`, async t => {
  const { detail, graph } = modality === 'video' ? videoFixture() : fixture()
  const nodeId = `${modality}-node`, assetId = modality === 'video' ? 'older-video' : 'older'
  const node = graph.nodes.find(node => node.id === nodeId)!
  node.asset_id = assetId
  node.settings.generation_completed_job_id = node.job_id!
  detail.assets.find(asset => asset.id === assetId)!.saved = false
  const original = structuredClone(detail)
  const savedIds: string[] = []
  const api = mockApi(t, graph, id => {
    savedIds.push(id)
    return Response.json({ ...detail.assets.find(asset => asset.id === id)!, saved: true })
  })
  let refreshes = 0
  const view = await mount(detail, nodeId, async () => {
    refreshes++
    return { ...structuredClone(detail), assets: detail.assets.map(asset => ({ ...asset, saved: asset.saved || savedIds.includes(asset.id) })) }
  })
  try {
    const save = composerAssetSave(view.container)
    assert.ok(save, 'the selected result exposes a visible save action in the composer')
    assert.equal(save.disabled, false)
    const beforeGraph = api.graph(), beforeCanvasSaves = api.saved.length
    await act(() => save.click()); await settle()
    assert.deepEqual(savedIds, [assetId], 'save the displayed candidate, even when its job points to the latest result')
    assert.equal(refreshes, 1)
    const saved = composerAssetSave(view.container)
    assert.equal(saved?.textContent?.trim(), '已保存到资产')
    assert.equal(saved?.disabled, true)
    assert.equal(api.saved.length, beforeCanvasSaves, 'saving to the library never rewrites the canvas')
    assert.deepEqual(api.graph(), beforeGraph)
    assert.deepEqual(detail, original, 'project shots, final selection, trim and asset props are not mutated')
    assert.ok(api.requests.every(request => request.method === 'GET' || request.path === `/api/assets/${assetId}/save`),
      'the only write promotes the asset to the library; no generation, selection or timeline request is allowed')
  } finally { await view.destroy() }
})

test('composer asset saving blocks duplicate clicks while pending and reports completion after refresh', async t => {
  const { detail, graph } = fixture()
  detail.assets.find(asset => asset.id === 'latest')!.saved = false
  let finishSave!: () => void, saves = 0, refreshes = 0
  const pendingSave = new Promise<Response>(resolve => { finishSave = () => resolve(Response.json({ ...detail.assets.find(asset => asset.id === 'latest')!, saved: true })) })
  mockApi(t, graph, () => { saves++; return pendingSave })
  const view = await mount(detail, 'image-node', async () => {
    refreshes++
    return { ...structuredClone(detail), assets: detail.assets.map(asset => ({ ...asset, saved: true })) }
  })
  try {
    const save = composerAssetSave(view.container)!
    assert.ok(save)
    await act(() => { save.click(); save.click() }); await settle()
    assert.equal(saves, 1, 'repeated clicks cannot submit the same pending save')
    assert.equal(composerAssetSave(view.container)?.disabled, true)
    assert.equal(refreshes, 0)
    await act(async () => { finishSave(); await pendingSave }); await settle()
    assert.equal(refreshes, 1)
    assert.equal(composerAssetSave(view.container)?.textContent?.trim(), '已保存到资产')
    assert.equal(composerAssetSave(view.container)?.disabled, true)
  } finally {
    await act(async () => { finishSave(); await pendingSave }); await settle()
    await view.destroy()
  }
})

test('a failed library save remains unsaved, reports the error and allows retrying', async t => {
  const { detail, graph } = fixture()
  detail.assets.find(asset => asset.id === 'latest')!.saved = false
  let saves = 0, refreshes = 0
  const api = mockApi(t, graph, id => ++saves === 1
    ? Response.json({ detail: '模拟资产保存失败' }, { status: 503 })
    : Response.json({ ...detail.assets.find(asset => asset.id === id)!, saved: true }))
  const view = await mount(detail, 'image-node', async () => {
    refreshes++
    return { ...structuredClone(detail), assets: detail.assets.map(asset => ({ ...asset, saved: true })) }
  })
  try {
    const beforeGraph = api.graph()
    await act(() => composerAssetSave(view.container)!.click()); await settle()
    assert.equal(saves, 1)
    assert.equal(refreshes, 0)
    assert.match(view.container.querySelector('.pc-notice')?.textContent || '', /模拟资产保存失败/)
    assert.equal(composerAssetSave(view.container)?.textContent?.trim(), '保存到资产')
    assert.equal(composerAssetSave(view.container)?.disabled, false)
    assert.deepEqual(api.graph(), beforeGraph)
    await act(() => composerAssetSave(view.container)!.click()); await settle()
    assert.equal(saves, 2)
    assert.equal(refreshes, 1)
    assert.equal(composerAssetSave(view.container)?.textContent?.trim(), '已保存到资产')
    assert.equal(composerAssetSave(view.container)?.disabled, true)
  } finally { await view.destroy() }
})

test('saved results show their library state and a node without a result has no save action', async t => {
  const { detail, graph } = fixture()
  const image = graph.nodes.find(node => node.id === 'image-node')!
  image.asset_id = null; image.job_id = null
  const api = mockApi(t, graph)
  const view = await mount(detail)
  try {
    assert.equal(composerAssetSave(view.container), undefined, 'a node without a result cannot save an asset')
    const video = view.container.querySelector<HTMLElement>('[data-id="video-node"]')!
    await act(() => video.click()); await settle()
    const saved = composerAssetSave(view.container)
    assert.ok(saved, 'an existing saved result retains a visible library status')
    assert.equal(saved.textContent?.trim(), '已保存到资产')
    assert.equal(saved.disabled, true)
    await act(() => saved.click()); await settle()
    assert.equal(api.requests.some(request => request.path.endsWith('/save')), false)
  } finally { await view.destroy() }
})

test('shot image candidates include successful images across batches and exclude other shots, profiles, video, frames and uploads', async t => {
  const { detail, graph } = fixture(), original = structuredClone(detail)
  const api = mockApi(t, graph)
  const view = await mount(detail)
  try {
    assert.deepEqual([...candidateStrip(view.container).querySelectorAll('img')].map(image => image.getAttribute('src')).sort(),
      ['/api/assets/latest/file', '/api/assets/older/file'])
    const manage = [...candidateStrip(view.container).querySelectorAll('button')].find(button => button.textContent === '管理候选')
    assert.ok(manage, 'shot candidates expose their manager')
    assert.equal(candidateStrip(view.container).querySelector('.pc-shot-candidates-count')?.textContent, '2', 'candidate count reflects the same filtered collection')
    assert.equal(selectedImage(view.container), '/api/assets/latest/file')
    assert.deepEqual(detail, original, 'candidate UI does not mutate project records')
    assert.equal(api.requests.some(request => request.path.includes('/generate')), false)
  } finally { await view.destroy() }
})

test('switching an older candidate survives completed-job refresh and saved-canvas reload while fixed video inputs and selected timeline remain unchanged', async t => {
  const { detail, graph } = fixture(), original = structuredClone(detail)
  const api = mockApi(t, graph)
  let view = await mount(detail)
  try {
    await useCandidate(view.container, 'older')
    assert.equal(selectedImage(view.container), '/api/assets/older/file')
    await view.rerender({ ...structuredClone(detail), jobs: detail.jobs.map(job => ({ ...job })) })
    assert.equal(selectedImage(view.container), '/api/assets/older/file', 'polling a completed latest job must not undo the selection')
    await view.destroy()
    assert.ok(api.saved.length, 'selection persists through the normal canvas save queue')
    const saved = api.graph(), image = saved.nodes.find(node => node.id === 'image-node')!, video = saved.nodes.find(node => node.id === 'video-node')!
    assert.equal(image.asset_id, 'older')
    assert.equal(image.settings.generation_completed_job_id, 'latest-job')
    assert.equal(image.job_id, 'latest-job', 'choosing a preview must not rewrite task provenance')
    assert.deepEqual(saved.edges, graph.edges, 'switching the displayed image preserves a video node’s pinned reference')
    assert.equal(video.settings.storyboard_reference_asset_id, 'latest')
    assert.deepEqual(detail.shots, original.shots)
    assert.deepEqual(detail.timeline_clips, original.timeline_clips)
    view = await mount(structuredClone(detail))
    assert.equal(selectedImage(view.container), '/api/assets/older/file', 'reopening the saved graph retains the chosen candidate')
    assert.equal(api.requests.some(request => request.path.includes('/generate') || request.path.includes('/selection') || request.path.includes('/timeline')), false)
  } finally { await view.destroy() }
})

test('a failed canvas save restores the prior candidate and permits retrying the same choice', async t => {
  const { detail, graph } = fixture()
  const api = mockApi(t, graph)
  const view = await mount(detail)
  try {
    api.control.failNextSave = true
    await useCandidate(view.container, 'older')
    assert.equal(selectedImage(view.container), '/api/assets/latest/file', 'a failed save restores the last displayed candidate')
    assert.match(candidateStrip(view.container).querySelector('[role="alert"]')?.textContent || '', /模拟候选保存失败/)
    const olderImage = candidateStrip(view.container).querySelector<HTMLImageElement>('img[src="/api/assets/older/file"]')!
    assert.equal(olderImage.closest('button')!.disabled, false, 'failed target is still selectable')
    await useCandidate(view.container, 'older')
    assert.equal(selectedImage(view.container), '/api/assets/older/file')
    assert.equal(candidateStrip(view.container).querySelector('[role="alert"]'), null)
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.asset_id, 'older')
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.settings.generation_completed_job_id, 'latest-job')
  } finally { await view.destroy() }
})

test('a new image job arriving after a previous candidate choice applies its result once and records the new completion', async t => {
  const { detail, graph } = fixture()
  const imageNode = graph.nodes.find(node => node.id === 'image-node')!
  imageNode.asset_id = null
  imageNode.job_id = 'next-job'
  imageNode.settings.generation_completed_job_id = 'latest-job'
  const queued = { ...detail, jobs: [...detail.jobs, job('next-job', '', {}, { status: 'queued', result_asset_id: null })] }
  const api = mockApi(t, graph)
  const view = await mount(queued)
  try {
    assert.equal(view.container.querySelector('[data-id="image-node"] .pc-node-output img'), null, 'new queued run has no completed output')
    assert.ok(candidateStrip(view.container).querySelector('button[aria-label="使用分镜图候选 1"]')?.hasAttribute('disabled'), 'new queued run cannot change candidates')
    const completed = { ...detail,
      jobs: [...detail.jobs, job('next-job', 'next', {}, { created_at: '2026-10-17T03:00:00Z' })],
      assets: [...detail.assets, asset('next', { created_at: '2026-10-17T03:00:00Z' })] }
    await view.rerender(completed)
    assert.equal(selectedImage(view.container), '/api/assets/next/file', 'new job completion is not blocked by the previous marker')
    await useCandidate(view.container, 'older')
    assert.equal(selectedImage(view.container), '/api/assets/older/file')
    await view.rerender(structuredClone(completed))
    assert.equal(selectedImage(view.container), '/api/assets/older/file', 'the new completion is consumed once')
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.settings.generation_completed_job_id, 'next-job')
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.job_id, 'next-job')
  } finally { await view.destroy() }
})

test('choosing history after a failed job does not consume that job before its same-id retry succeeds', async t => {
  const { detail, graph } = fixture()
  const imageNode = graph.nodes.find(node => node.id === 'image-node')!
  imageNode.job_id = 'retry-job'
  imageNode.settings.generation_completed_job_id = 'latest-job'
  const failedJob = job('retry-job', '', {}, { status: 'failed', result_asset_id: null, error: '暂时失败' })
  const failed = { ...detail, jobs: [...detail.jobs, failedJob] }
  const api = mockApi(t, graph)
  const view = await mount(failed)
  try {
    await useCandidate(view.container, 'older')
    assert.equal(selectedImage(view.container), '/api/assets/older/file')
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.settings.generation_completed_job_id, undefined,
      'a failed job must remain unconsumed when selecting history')
    await view.rerender({ ...failed, jobs: [...detail.jobs, { ...failedJob, status: 'queued', error: null }] })
    assert.equal(selectedImage(view.container), '/api/assets/older/file', 'backend retry keeps the chosen image while queued')
    const completed = { ...detail,
      jobs: [...detail.jobs, { ...failedJob, status: 'succeeded' as const, error: null, result_asset_id: 'retried' }],
      assets: [...detail.assets, asset('retried', { created_at: '2026-10-17T03:00:00Z' })] }
    await view.rerender(completed)
    assert.equal(selectedImage(view.container), '/api/assets/retried/file', 'same-id retry completion is applied')
    await view.destroy()
    assert.equal(api.graph().nodes.find(node => node.id === 'image-node')?.settings.generation_completed_job_id, 'retry-job')
    assert.equal(api.requests.some(request => request.path.includes('/generate')), false, 'this test simulates status polling without creating a generation')
  } finally { if (view.container.isConnected) await view.destroy() }
})

function videoFixture() {
  const data = fixture()
  data.detail.assets.find(asset => asset.id === 'final-video')!.created_at = latestTimestamp
  data.detail.assets.push(asset('older-video', { kind: 'video', filename: 'older-video.mp4', model_id: videoModel.id }),
    asset('profile-video', { kind: 'video' }), asset('failed-video', { kind: 'video' }),
    asset('foreign-video', { kind: 'video', shot_id: 'other-shot' }), asset('uploaded-video', { kind: 'video', source: 'upload' }))
  data.detail.jobs.push(job('older-video-job', 'older-video', { modality: 'video' }, { model_id: videoModel.id }),
    job('profile-video-job', 'profile-video', { modality: 'video', visual_profile_id: 'hero' }),
    job('failed-video-job', 'failed-video', { modality: 'video' }, { status: 'failed' }),
    job('foreign-video-job', 'foreign-video', { modality: 'video' }, { shot_id: 'other-shot' }))
  return data
}
function videoStrip(container: HTMLElement) {
  const strip = container.querySelector<HTMLElement>('[aria-label="视频候选"]')
  assert.ok(strip, 'video composer exposes candidate management'); return strip
}
function selectedVideo(container: HTMLElement) {
  return container.querySelector<HTMLVideoElement>('[data-id="video-node"] .pc-node-output video')?.getAttribute('src')
}
async function useVideoCandidate(container: HTMLElement, index = 2) {
  const button = videoStrip(container).querySelector<HTMLButtonElement>(`[aria-label="使用视频候选 ${index}"]`)
  assert.ok(button)
  await act(() => button.click()); await settle()
}

test('video candidates filter media provenance and persist an older choice through polling and reload without changing the final cut', async t => {
  const { detail, graph } = videoFixture(), original = structuredClone(detail)
  const api = mockApi(t, graph)
  let view = await mount(detail, 'video-node')
  try {
    assert.equal(videoStrip(view.container).querySelector('.pc-shot-candidates-count')?.textContent, '2')
    assert.equal(videoStrip(view.container).querySelectorAll('[aria-label^="使用视频候选"]').length, 2)
    assert.match(videoStrip(view.container).textContent!, /已入片/)
    await useVideoCandidate(view.container)
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file')
    await view.rerender(structuredClone(detail))
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file', 'completed latest-job polling cannot override the older video')
    await view.destroy()
    const saved = api.graph(), video = saved.nodes.find(node => node.id === 'video-node')!
    assert.equal(video.asset_id, 'older-video')
    assert.equal(video.job_id, 'video-job')
    assert.equal(video.settings.generation_completed_job_id, 'video-job')
    assert.deepEqual(saved.edges, graph.edges, 'pinned storyboard references remain intact')
    assert.equal(video.settings.storyboard_reference_asset_id, 'latest')
    assert.deepEqual(detail, original, 'candidate use changes only the canvas, preserving the chosen final clip and trim')
    view = await mount(structuredClone(detail), 'video-node')
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file')
    assert.ok(api.requests.every(request => !/generate|selection|timeline/.test(request.path)))
  } finally { if (view.container.isConnected) await view.destroy() }
})

test('a failed video candidate save restores the current video and can be retried', async t => {
  const { detail, graph } = videoFixture()
  const api = mockApi(t, graph)
  const view = await mount(detail, 'video-node')
  try {
    api.control.failNextSave = true
    await useVideoCandidate(view.container)
    assert.equal(selectedVideo(view.container), '/api/assets/final-video/file')
    assert.match(videoStrip(view.container).querySelector('[role="alert"]')!.textContent!, /模拟候选保存失败/)
    await useVideoCandidate(view.container)
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file')
    assert.equal(api.graph().nodes.find(node => node.id === 'video-node')?.asset_id, 'older-video')
  } finally { await view.destroy() }
})

test('a new video job completion applies once and subsequent history choices survive its refresh', async t => {
  const { detail, graph } = videoFixture()
  const video = graph.nodes.find(node => node.id === 'video-node')!
  video.job_id = 'next-video-job'; video.asset_id = null
  video.settings.generation_completed_job_id = 'video-job'
  const queued = { ...detail, jobs: [...detail.jobs, job('next-video-job', '', { modality: 'video' }, { model_id: videoModel.id, status: 'queued', result_asset_id: null })] }
  const api = mockApi(t, graph)
  const view = await mount(queued, 'video-node')
  try {
    assert.equal(videoStrip(view.container).querySelector<HTMLButtonElement>('[aria-label="使用视频候选 2"]')!.disabled, true)
    const completed = { ...detail,
      jobs: [...detail.jobs, job('next-video-job', 'next-video', { modality: 'video' }, { model_id: videoModel.id, created_at: '2026-10-17T03:00:00Z' })],
      assets: [...detail.assets, asset('next-video', { kind: 'video', model_id: videoModel.id, created_at: '2026-10-17T03:00:00Z' })] }
    await view.rerender(completed)
    assert.equal(selectedVideo(view.container), '/api/assets/next-video/file')
    await useVideoCandidate(view.container, 3)
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file')
    await view.rerender(structuredClone(completed))
    assert.equal(selectedVideo(view.container), '/api/assets/older-video/file')
    assert.equal(api.graph().nodes.find(node => node.id === 'video-node')?.settings.generation_completed_job_id, 'next-video-job')
  } finally { await view.destroy() }
})

test('video candidate management and full-screen playback pause underlying players and Escape preserves the selected node', async t => {
  const { detail, graph } = videoFixture()
  mockApi(t, graph)
  const view = await mount(detail, 'video-node')
  try {
    const manage = [...videoStrip(view.container).querySelectorAll('button')].find(button => button.textContent === '管理候选')!
    await act(() => manage.click()); await settle()
    assert.equal(selectedVideo(view.container), undefined, 'opening the manager pauses the canvas video')
    assert.ok(document.querySelector('.pc-shot-candidate-video-preview video'))
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="全屏查看视频候选"]')!.click()); await settle()
    const preview = document.querySelector<HTMLElement>('.pc-media-preview')!
    assert.ok(preview.hasAttribute('data-full-screen'))
    assert.equal(preview.querySelector('video')?.getAttribute('src'), '/api/assets/final-video/file')
    assert.equal(document.querySelector('.pc-shot-candidate-video-preview video'), null, 'full-screen playback pauses the manager video')
    await act(() => preview.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
    assert.equal(document.querySelector('.pc-media-preview'), null)
    assert.ok(document.querySelector('.pc-shot-candidate-modal'), 'Escape leaves the manager open')
    assert.ok(document.querySelector('.pc-shot-candidate-video-preview video'))
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭视频候选"]')!.click()); await settle()
    assert.equal(selectedVideo(view.container), '/api/assets/final-video/file', 'closing the manager restores the selected node player')
    assert.ok(videoStrip(view.container))
  } finally { await view.destroy() }
})

for (const field of ['prompt', 'title'] as const) test(`managed ${field} changes adopt the server canvas revision before later imports and canvas edits`, async t => {
  const initial = fixture()
  let serverDetail = structuredClone(initial.detail), serverGraph = structuredClone(initial.graph)
  serverDetail.shots = serverDetail.shots.map(shot => ({ ...shot, image_prompt: '', video_prompt: '', storyboard_revision: 0 }))
  let revision = 0, managementRevision = 0
  const conflicts: string[] = [], saved: CanvasGraph[] = [], requests: string[] = []
  const snapshot = (): ShotManagementSnapshot => ({ revision: String(managementRevision).padStart(64, '0'),
    shots: serverDetail.shots.map(shot => ({ shot: structuredClone(shot), design_name: '默认方案',
      canvas_refs: serverGraph.nodes.some(node => node.shot_id === shot.id) ? [{ id: projectId, name: '画布 1' }] : [],
      asset_count: serverDetail.assets.filter(asset => asset.shot_id === shot.id).length, deleted_at: null, delete_blockers: [] })),
    designs: [], canvases: [{ id: projectId, name: '画布 1' }], scenes: [], trashed_assets: [] })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    requests.push(`${method} ${path}`)
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId,
      name: '画布 1', is_default: true, node_count: serverGraph.nodes.length, viewport: null }])
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    if (path === `/api/projects/${projectId}`) return Response.json(serverDetail)
    if (path === `/api/projects/${projectId}/shot-management`) return Response.json(snapshot())
    if (path === `/api/projects/${projectId}/shot-management/actions`) {
      const input = JSON.parse(String(init?.body))
      assert.equal(input.revision, snapshot().revision)
      const shot = serverDetail.shots.find(shot => shot.id === input.shot_id)!
      const prior = structuredClone(shot)
      Object.assign(shot, input.patch)
      if (field === 'prompt') {
        shot.storyboard_revision = (prior.storyboard_revision || 0) + 1
        shot.selected_asset_id = null
        serverDetail.timeline_clips = serverDetail.timeline_clips.filter(clip => clip.shot_id !== shot.id)
        serverGraph.nodes = serverGraph.nodes.map(node => node.type === 'generation' && node.shot_id === shot.id
          ? { ...node, title: shot.title, prompt: shot.prompt, text: '', asset_id: null, job_id: null,
            settings: { ...node.settings, storyboard_revision: shot.storyboard_revision, duration: shot.duration,
              storyboard_reference_asset_id: undefined, generation_completed_job_id: undefined } } : node)
        serverGraph.edges = []
      } else serverGraph.nodes = serverGraph.nodes.map(node => node.type === 'generation' && node.shot_id === shot.id
        ? { ...node, title: shot.title } : node)
      serverGraph.revision = `management-${++managementRevision}`
      return Response.json(snapshot())
    }
    assert.equal(path, `/api/projects/${projectId}/canvas`, 'management integration cannot submit generation')
    if (method === 'PUT') {
      const input = JSON.parse(String(init?.body)) as CanvasGraph
      const badStoryboard = input.nodes.some(node => node.type === 'generation' && node.shot_id
        && (node.settings.storyboard_revision || 0) !== (serverDetail.shots.find(shot => shot.id === node.shot_id)?.storyboard_revision || 0))
      if (input.revision !== serverGraph.revision || badStoryboard) {
        conflicts.push(`${input.revision} against ${serverGraph.revision}`)
        return Response.json({ detail: '画布已在其他位置修改，请刷新后重试' }, { status: 409 })
      }
      serverGraph = { ...input, revision: `saved-${++revision}` }
      saved.push(structuredClone(serverGraph))
    }
    return Response.json(serverGraph)
  })
  const view = await mount(serverDetail, 'image-node', async () => structuredClone(serverDetail))
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')]
      .find(node => node.getAttribute('aria-label') === label || node.textContent === label)
    assert.ok(button, label); await act(async () => { button.click() }); await settle()
  }
  try {
    await click('切换创作页面'); await click('分镜管理')
    await click('编辑镜头：站台回望')
    const label = [...document.querySelectorAll<HTMLLabelElement>('.shot-manager-fields label')]
      .find(node => node.textContent?.replace(' *', '') === (field === 'prompt' ? '镜头描述' : '镜头标题'))!
    assert.ok(label)
    const input = document.getElementById(label.htmlFor) as HTMLInputElement | HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(field === 'prompt' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value')!
        .set!.call(input, field === 'prompt' ? '镜头从站台推进到人物眼神' : '站台回望新版标题')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('保存修改')
    assert.equal(managementRevision, 1)
    assert.ok(requests.filter(request => request === `GET /api/projects/${projectId}/canvas`).length >= 2,
      'management changes read the saved graph before applying fresh shot props')
    assert.deepEqual(conflicts, [])
    assert.equal(document.querySelector('.pc-conflict'), null)
    assert.equal(document.querySelector('.shot-manager-error'), null)
    const select = document.querySelector<HTMLInputElement>('input[aria-label="选择镜头：另一镜头"]')!
    await act(async () => { select.click() }); await settle(); await click('加入画布')
    assert.ok(serverGraph.nodes.some(node => node.type === 'generation' && node.shot_id === 'other-shot'))
    assert.deepEqual(conflicts, [], 'import uses the adopted revision')
    await click('关闭分镜管理'); await click('添加文本')
    await click('切换创作页面'); await click('分镜管理')
    assert.ok(saved.at(-1)!.nodes.some(node => node.type === 'text'), 'later local edits persist through the normal leave/flush path')
    assert.deepEqual(conflicts, [], 'continued editing cannot save the stale pre-management graph')
    const image = serverGraph.nodes.find(node => node.id === 'image-node')!
    assert.equal(image.title, serverDetail.shots[0].title)
    assert.equal(image.settings.storyboard_revision || 0, field === 'prompt' ? 1 : 0)
    assert.equal(image.asset_id, field === 'prompt' ? null : 'latest', 'metadata edits retain the existing output')
    assert.equal(document.querySelectorAll('.project-canvas').length, 1)
  } finally { await view.destroy() }
})
