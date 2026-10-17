import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Asset, Job, Model, ProjectDetail } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'

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
function mockApi(t: TestContext, initialGraph: CanvasGraph) {
  let graph = structuredClone(initialGraph)
  const control = { failNextSave: false }
  const saved: CanvasGraph[] = [], requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    requests.push({ path, method })
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId,
      name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
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
async function mount(detail: ProjectDetail) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem(`project-canvas-viewport:${projectId}`, JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail, models: [imageModel, videoModel],
    providers: [{ id: 'provider', name: '本地测试', adapter: 'http', enabled: true } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {}, onOpenModels() {}, onNavigate() {}, onOpenScriptCreator() {} }
  const render = () => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)
  try {
    await act(render); await settle()
    const image = container.querySelector<HTMLElement>('[data-id="image-node"]')
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
