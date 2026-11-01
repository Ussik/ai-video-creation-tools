import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'
import { getManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

// Exercise the complete canvas; only styles and HTTP transport are mocked.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver', 'DOMParser', 'File', 'FormData']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
const cancelFrame = (id: number) => frames.delete(id)
Object.assign(globalThis, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame })
function dimensions(element: Element) {
  const node = element instanceof dom.window.HTMLElement ? element : null, sized = node?.closest<HTMLElement>('.react-flow__node')
  return { width: Number.parseFloat(node?.style.width || sized?.style.width || '') || 1200,
    height: Number.parseFloat(node?.style.height || sized?.style.height || '') || 800 }
}
for (const [name, axis] of [['offsetWidth', 'width'], ['clientWidth', 'width'], ['offsetHeight', 'height'], ['clientHeight', 'height']] as const) {
  Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, get() { return dimensions(this)[axis] } })
}
dom.window.Element.prototype.getBoundingClientRect = function () {
  const size = dimensions(this)
  return { ...size, x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, toJSON() { return this } }
}
dom.window.Range.prototype.getBoundingClientRect = () => document.body.getBoundingClientRect()
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
class TestResizeObserver {
  private targets = new Set<Element>()
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target)
    requestFrame(() => {
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
const { promptEditorText } = await import('../src/features/canvas/CanvasPromptEditor')
after(() => dom.window.close())

const projectId = 'video-analysis-test', timestamp = '2026-10-22T00:00:00Z'
const visionModel: Model = { id: 'vision-model', provider_id: 'provider', name: '看图模型', remote_id: 'vision', modality: 'text',
  protocol: 'chat_completions', enabled: true, settings: { supports_video: true, video_input_format: 'doubao_ark' } }
const imageModel: Model = { ...visionModel, id: 'image-model', name: '图片模型', remote_id: 'image', modality: 'video', protocol: 'async_video',
  settings: { min_duration: 4, max_duration: 15, supported_modes: ['text'], ratios: ['16:9'], resolutions: ['1K', '2K'],
    request_template: { prompt: '{{prompt}}', ratio: '{{ratio}}', resolution: '{{resolution}}' } } }
const uploaded = { id: 'uploaded', project_id: projectId, kind: 'video', filename: '参考片.mp4', url: '/api/assets/uploaded/file', created_at: timestamp }
const detail = { id: projectId, name: '反推测试', brief: '', ratio: '16:9', updated_at: timestamp,
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
  shots: [], assets: [uploaded], jobs: [], asset_tasks: [], visual_profiles: [], shot_visual_bindings: [], scene_visual_bindings: [],
  timeline_clips: [], asset_reviews: [],
} as unknown as ProjectDetail
function node(id: string, type: CanvasNode['type'], patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, x: 20, y: 50, width: 420, height: 340, title: type === 'video_analysis' ? '视频反推提示词' : detail.name,
    text: '', prompt: '', asset_id: null, model_id: null, shot_id: null, job_id: null, settings: {}, ...patch }
}
function initialGraph(withAnalysis = true, text = ''): CanvasGraph {
  return { revision: 'initial', nodes: [node(`project-script:${projectId}`, 'project_script_ref', { width: 720, height: 480 }),
    ...(withAnalysis ? [node('analysis', 'video_analysis', { model_id: visionModel.id, asset_id: uploaded.id, text })] : [])], edges: [] }
}
type AnalysisBody = { asset_id: string; model_id: string; instructions: string; start_ms: number; end_ms: number|null; fps: number }
function mockApi(t: TestContext, graph: CanvasGraph, analyze: (body: AnalysisBody, init?: RequestInit) => Response | Promise<Response>) {
  const saved: CanvasGraph[] = [], analyses: AnalysisBody[] = [], previews: Array<Record<string, unknown>> = [], uploads: FormData[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId, name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === `/api/projects/${projectId}/canvas`) {
      if (method === 'GET') return Response.json(graph)
      assert.equal(method, 'PUT')
      const value = JSON.parse(String(init?.body)); saved.push(value)
      return Response.json({ ...value, revision: `saved-${saved.length}` })
    }
    if (path === `/api/projects/${projectId}/assets`) {
      assert.equal(method, 'POST'); assert.ok(init?.body instanceof FormData)
      uploads.push(init.body); return Response.json(uploaded)
    }
    if (path === `/api/projects/${projectId}/canvas/video-prompt-analysis`) {
      assert.equal(method, 'POST'); const body = JSON.parse(String(init?.body)) as AnalysisBody
      analyses.push(body); return analyze(body, init)
    }
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    assert.equal(path, `/api/projects/${projectId}/generate/preview`, 'test must never submit a paid image generation')
    const body = JSON.parse(String(init?.body)); previews.push(body)
    return Response.json({ ...body, visual_signature: 'test-reference-signature' })
  })
  return { saved, analyses, previews, uploads }
}
async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(pass * 16))
    }
  })
}
function button(label: string) {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    || [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  assert.ok(found, `button: ${label}`); return found
}
async function click(label: string) { await act(async () => { button(label).click(); await Promise.resolve() }); await settle() }
function field(label: string) {
  const found = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(item => document.querySelector(`label[for="${item.id}"]`)?.textContent?.startsWith(label))
  assert.ok(found, `textarea: ${label}`); return found
}
async function edit(label: string, value: string) {
  const element = field(label)
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await settle()
}
async function savedGraph(snapshots: CanvasGraph[]) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 720)) }); await settle()
  assert.ok(snapshots.length, 'actual graph autosave reached HTTP')
  return snapshots.at(-1)!
}
async function mount(openExisting = true, overrides: Partial<ProjectCanvasProps> = {}) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem(`project-canvas-viewport:${projectId}`, JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail, models: [visionModel, imageModel],
    providers: [{ id: 'provider', name: '测试服务', enabled: true, adapter: 'http' } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {}, onOpenModels: () => {}, onNavigate: () => {}, onOpenScriptCreator: () => {}, ...overrides }
  try {
    await act(() => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)); await settle()
    if (openExisting) {
      const card = container.querySelector<HTMLElement>('[data-id="analysis"]'); assert.ok(card)
      await act(() => card.click()); await settle()
      const configure = [...card.querySelectorAll<HTMLButtonElement>('button')].find(item => /配置视频反推|编辑视频反推/.test(item.textContent || ''))
      assert.ok(configure); await act(() => configure.click()); await settle()
    }
  } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { container, destroy: async () => {
    // Let d3 finish camera transitions before dropping this harness's RAF queue.
    if (frames.size) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) }); await settle() }
    await act(() => root.unmount()); await settle(); container.remove(); frames.clear()
  } }
}

const shotResult = { title: '踏步挥剑', start_ms: 0, end_ms: 3000, start_state: '持剑站立', action: '向前挥剑',
  end_state: '剑停于身侧', camera: '低机位跟随', vfx: '未见明显特效', image_prompt: '人物站在石阶上。',
  video_prompt: '人物向前踏步挥剑，镜头低位跟随。', uncertainties: [] }
function result() {
  return { asset_id: uploaded.id, model_id: visionModel.id, duration_ms: 90_000, start_ms: 0, end_ms: 90_000, fps: 2,
    global_style: '三维国漫，暖色侧光。', shots: [shotResult, { ...shotResult, title: '远景落石', start_ms: 3000, end_ms: 9000,
      video_prompt: '第二个镜头独有的落石描述。' }], uncertainties: ['未分析声音。'] }
}

test('video analysis edits persist and creating one shot freezes only that prompt without submitting generation', async t => {
  const transport = mockApi(t, initialGraph(), body => {
    assert.deepEqual(body, { asset_id: uploaded.id, model_id: visionModel.id, instructions: '', start_ms: 0, end_ms: null, fps: 2 })
    return Response.json(result())
  })
  const view = await mount()
  try {
    await click('开始反推')
    assert.equal(transport.analyses.length, 1)
    assert.match(document.body.textContent!, /2 个镜头/)
    await edit('整体画风', '手工修订的冷暖对比风格')
    await edit('视频提示词', '手工修订的踏步、转髋和受力动作。')
    const saved = await savedGraph(transport.saved), analysis = saved.nodes.find(item => item.id === 'analysis')!
    assert.equal(analysis.settings.video_analysis_result?.global_style, '手工修订的冷暖对比风格')
    assert.equal(analysis.settings.video_analysis_result?.shots[0].video_prompt, '手工修订的踏步、转髋和受力动作。')
    assert.match(analysis.text, /手工修订的踏步/)
    await click('创建当前镜头视频节点')
    const applied = await savedGraph(transport.saved), generation = applied.nodes.find(item => item.type === 'generation')!
    assert.ok(generation)
    assert.equal(generation.settings.modality, 'video')
    assert.equal(generation.settings.duration, 4, 'three second editorial shot adapts to model four second minimum')
    assert.match(generation.prompt, /手工修订的冷暖对比风格/)
    assert.match(generation.prompt, /手工修订的踏步/)
    assert.doesNotMatch(generation.prompt, /第二个镜头独有/)
    assert.equal(generation.settings.reference_video_url, undefined)
    assert.equal(generation.asset_id, null)
    assert.equal(applied.edges.some(edge => edge.target === generation.id), false, 'source video and whole-film prompt are not implicit inputs')
    assert.equal(detail.jobs.length, 0)
  } finally { await view.destroy() }
})

test('toolbar exposes video analysis and requires explicit compatible model configuration', async t => {
  let openedModels = 0
  const transport = mockApi(t, initialGraph(false), () => { throw new Error('must not analyze without a configured model') })
  const view = await mount(false, { models: [{ ...visionModel, settings: { supports_vision: true } }], onOpenModels: () => openedModels++ })
  try {
    await click('添加视频反推提示词节点')
    assert.match(document.body.textContent!, /暂无可用的豆包视频理解模型/)
    assert.equal(button('开始反推').disabled, true)
    const saved = await savedGraph(transport.saved), node = saved.nodes.find(item => item.type === 'video_analysis')!
    assert.ok(node)
    assert.equal(node.model_id, null)
    assert.equal(transport.analyses.length, 0)
    await click('去模型设置')
    assert.equal(openedModels, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally { await view.destroy() }
})
