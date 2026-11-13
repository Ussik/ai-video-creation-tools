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
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'CustomEvent', 'MouseEvent', 'MutationObserver', 'DOMParser', 'File', 'FormData']) {
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
const { rememberModelSelection } = await import('../src/features/models/model-selection-store')
after(() => dom.window.close())

const projectId = 'image-analysis-test', timestamp = '2026-10-22T00:00:00Z'
const visionModel: Model = { id: 'vision-model', provider_id: 'provider', name: '看图模型', remote_id: 'vision', modality: 'text',
  protocol: 'chat_completions', enabled: true, settings: { supports_vision: true } }
const imageModel: Model = { ...visionModel, id: 'image-model', name: '图片模型', remote_id: 'image', modality: 'image', protocol: 'image_generations',
  settings: { supported_modes: ['text'], ratios: ['16:9'], resolutions: ['1K', '2K'],
    request_template: { prompt: '{{prompt}}', ratio: '{{ratio}}', resolution: '{{resolution}}' } } }
const uploaded = { id: 'uploaded', project_id: projectId, kind: 'image', filename: '角色.png', url: '/api/assets/uploaded/file', created_at: timestamp }
const detail = { id: projectId, name: '反推测试', brief: '', ratio: '16:9', updated_at: timestamp,
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
  shots: [], assets: [uploaded], jobs: [], asset_tasks: [], visual_profiles: [], shot_visual_bindings: [], scene_visual_bindings: [],
  timeline_clips: [], asset_reviews: [],
} as unknown as ProjectDetail
function node(id: string, type: CanvasNode['type'], patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, x: 20, y: 50, width: 420, height: 340, title: type === 'image_analysis' ? '图片反推提示词' : detail.name,
    text: '', prompt: '', asset_id: null, model_id: null, shot_id: null, job_id: null, settings: {}, ...patch }
}
function initialGraph(withAnalysis = true, text = ''): CanvasGraph {
  return { revision: 'initial', nodes: [node(`project-script:${projectId}`, 'project_script_ref', { width: 720, height: 480 }),
    ...(withAnalysis ? [node('analysis', 'image_analysis', { model_id: visionModel.id, asset_id: uploaded.id, text })] : [])], edges: [] }
}
type AnalysisBody = { asset_id: string; model_id: string; instructions: string }
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
    if (path === `/api/projects/${projectId}/canvas/image-prompt-analysis`) {
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
async function mount(openExisting = true, overrides: Partial<ProjectCanvasProps> = {}, preservePreferences = false) {
  if (!preservePreferences) {
    dom.window.localStorage.clear()
    for (const modality of ['text', 'image', 'video'] as const) rememberModelSelection(modality, null)
  }
  dom.window.sessionStorage.clear(); frames.clear()
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
      const configure = [...card.querySelectorAll<HTMLButtonElement>('button')].find(item => /配置图片反推|编辑反推提示词/.test(item.textContent || ''))
      assert.ok(configure); await act(() => configure.click()); await settle()
    }
  } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  return { container, destroy: async () => {
    // Let d3 finish camera transitions before dropping this harness's RAF queue.
    if (frames.size) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) }); await settle() }
    await act(() => root.unmount()); await settle(); container.remove(); frames.clear()
  } }
}

async function chooseModel(label: string, name: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    || (() => { const text = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label); return text ? document.getElementById(text.htmlFor) as HTMLInputElement : null })()
  assert.ok(input, `model selector: ${label}`)
  await act(() => input.click()); await settle()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === name)
  assert.ok(option, `model option: ${name}`)
  await act(() => option.click()); await settle()
}

test('a new image node exposes an empty body above compact fixed settings and persists both into its generation preview', async t => {
  const transport = mockApi(t, initialGraph(false), () => { throw new Error('editing a prompt must not run image analysis') })
  const view = await mount(false)
  try {
    await click('添加图片生成节点')
    const element = view.container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('.pc-prompt-editor-content')
    assert.ok(element, 'the full canvas opened its prompt editor')
    const editor = element.editor, original = promptEditorText(editor.getJSON())
    const requirements = getManagedPromptBlocks(original)
    assert.equal(requirements.length, 1)
    assert.match(requirements[0], /【图片生成要求】/)
    assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph')
    assert.equal(editor.state.doc.firstChild?.textContent, '')
    assert.match(view.container.querySelector('[aria-label="固定设定摘要"]')!.textContent!, /设定与要求 · 1 项/)
    assert.equal(view.container.querySelector('.pc-prompt-requirement-choice'), null, 'fixed settings do not occupy the prose editor')
    assert.equal(button('开始生成').disabled, true, 'generated requirements alone are not authored prompt content')
    const beforeEdit = await savedGraph(transport.saved)
    const created = beforeEdit.nodes.find(item => item.type === 'generation')!
    assert.ok(created)
    assert.equal(created.text, '', 'displaying an empty body does not write generated text into the node')
    const saveCount = transport.saved.length
    await click('查看固定设定')
    const fixed = document.querySelector('[role="dialog"]')!
    assert.match(fixed.textContent!, /图片生成要求/)
    assert.equal(fixed.querySelector('[contenteditable="true"]'), null)
    assert.match(fixed.querySelector('pre')!.textContent!, /图片生成要求|画面比例|背景|清晰度/)
    await click('关闭固定设定')
    await click('预览完整提示词')
    const preview = document.querySelector('[role="dialog"]')!
    assert.equal(preview.querySelector('pre')!.textContent, original)
    assert.equal(preview.querySelector('[contenteditable="true"]'), null)
    await click('关闭完整提示词预览')
    await savedGraph(transport.saved)
    assert.equal(transport.saved.length, saveCount, 'preview changes only the view, without autosaving a graph mutation')
    assert.equal(promptEditorText(editor.getJSON()), original)

    const authored = '窗边的年轻女子，柔和晨光，近景构图，保留自然织物纹理。'
    await act(() => editor.chain().setTextSelection(1).insertContent(authored).run()); await settle()
    assert.equal(button('开始生成').disabled, false)
    const saved = await savedGraph(transport.saved), persisted = saved.nodes.find(item => item.id === created.id)!
    assert.equal(persisted.settings.prompt_body, authored)
    assert.equal(persisted.text, `${authored}\n\n${original}`)
    assert.ok(persisted.settings.prompt_sections)
    assert.equal(serializePromptSectionDocument(persisted.settings.prompt_sections), persisted.text)
    assert.deepEqual(getManagedPromptBlocks(persisted.text), requirements, 'typing the body preserves the generated requirements exactly')

    await click('查看生成信息')
    assert.equal(transport.previews.length, 1)
    assert.equal(transport.previews[0].prompt, persisted.text)
    assert.deepEqual(transport.previews[0].reference_asset_ids, [])
    assert.equal(transport.analyses.length, 0)
  } finally { await view.destroy() }
})

test('new canvas nodes use eligible category defaults and keep saved node selections', async t => {
  const graph = initialGraph(false)
  const existing = node('saved-image', 'generation', { model_id: imageModel.id, settings: { modality: 'image', ratio: '16:9' } })
  graph.nodes.push(existing)
  const defaultVision = { ...visionModel, id: 'default-vision', is_default: true }
  const defaultImage = { ...imageModel, id: 'default-image', is_default: true,
    settings: { ...imageModel.settings, ratios: ['1:1'], resolutions: ['2K'] } }
  const video: Model = { ...imageModel, id: 'video', name: '视频模型', modality: 'video', protocol: 'async_video',
    settings: { supported_modes: ['text'], ratios: ['9:16'], resolutions: ['480p'], min_duration: 1, max_duration: 3 } }
  const defaultVideo = { ...video, id: 'default-video', is_default: true }
  const unavailable = { ...defaultImage, id: 'unavailable-default', provider_id: 'disabled-provider' }
  const transport = mockApi(t, graph, () => { throw new Error('creating nodes must not generate media') })
  const view = await mount(false, { models: [unavailable, visionModel, imageModel, video, defaultVision, defaultImage, defaultVideo] })
  try {
    await click('添加图片生成节点')
    await click('添加视频生成节点')
    await click('添加图片反推提示词节点')
    const saved = await savedGraph(transport.saved)
    assert.deepEqual(saved.nodes.find(item => item.id === existing.id), existing)
    const image = saved.nodes.find(item => item.model_id === defaultImage.id)
    assert.ok(image)
    assert.equal(image.settings.ratio, '1:1')
    assert.equal(image.settings.resolution, '2K')
    const generatedVideo = saved.nodes.find(item => item.model_id === defaultVideo.id)
    assert.ok(generatedVideo)
    assert.equal(generatedVideo.settings.ratio, detail.ratio)
    assert.equal(generatedVideo.settings.duration, 3)
    assert.equal(saved.nodes.find(item => item.type === 'image_analysis')?.model_id, defaultVision.id)
    assert.equal(transport.analyses.length, 0)
    assert.equal(transport.previews.length, 0)
  } finally { await view.destroy() }
})

test('an explicit image-model choice becomes the default for later nodes and the next visit while saved bindings remain intact', async t => {
  const graph = initialGraph(false), existing = node('saved-image', 'generation', { model_id: imageModel.id, settings: { modality: 'image', ratio: '16:9' } })
  graph.nodes.push(existing)
  const configured = { ...imageModel, is_default: true }
  const alternate = { ...imageModel, id: 'recent-image', name: '最近选择图片模型', settings: { ...imageModel.settings, ratios: ['1:1'], resolutions: ['2K'] } }
  const models = [visionModel, configured, alternate]
  const transport = mockApi(t, graph, () => { throw new Error('choosing a model must not generate or analyze media') })
  const first = await mount(false, { models })
  let persisted: CanvasGraph
  try {
    await click('添加图片生成节点')
    await chooseModel('生成模型', alternate.name)
    await click('添加图片生成节点')
    persisted = await savedGraph(transport.saved)
    assert.deepEqual(persisted.nodes.find(item => item.id === existing.id), existing)
    const added = persisted.nodes.filter(item => item.type === 'generation' && item.id !== existing.id)
    assert.equal(added.length, 2)
    assert.ok(added.every(item => item.model_id === alternate.id))
    assert.equal(added[1]!.settings.ratio, '1:1')
    assert.equal(added[1]!.settings.resolution, '2K')
    assert.equal(transport.analyses.length + transport.previews.length, 0)
  } finally { await first.destroy() }
  const revisit = mockApi(t, persisted!, () => { throw new Error('creating a node must not generate media') })
  const second = await mount(false, { models }, true)
  try {
    await click('添加图片生成节点')
    const saved = await savedGraph(revisit.saved)
    assert.equal(saved.nodes.filter(item => item.type === 'generation').at(-1)!.model_id, alternate.id)
    assert.deepEqual(saved.nodes.find(item => item.id === existing.id), existing)
  } finally { await second.destroy() }
})

test('image analysis remembers an image model by its actual category and falls back within eligible capabilities', async t => {
  const nano = { ...imageModel, id: 'nano-recent', name: '最近选择 Gemini 图片模型',
    settings: { ...imageModel.settings, image_analysis: { enabled: true, protocol: 'gemini_generate_content' } } }
  const configuredImage = { ...imageModel, is_default: true }
  const configuredVision = { ...visionModel, is_default: true }
  const graph = initialGraph(false)
  const transport = mockApi(t, graph, () => { throw new Error('selecting defaults must not analyze media') })
  const view = await mount(false, { models: [configuredVision, configuredImage, nano] })
  try {
    await act(() => rememberModelSelection('image', imageModel.id)); await settle()
    await click('添加图片反推提示词节点')
    const first = await savedGraph(transport.saved)
    assert.equal(first.nodes.find(item => item.type === 'image_analysis')!.model_id, visionModel.id, 'plain remembered image generator cannot serve image analysis')
    await chooseModel('看图模型', nano.name)
    const close = document.querySelector<HTMLButtonElement>('.mantine-Modal-close'); assert.ok(close)
    await act(() => close.click()); await settle()
    await click('添加图片生成节点')
    await click('添加图片反推提示词节点')
    const saved = await savedGraph(transport.saved)
    assert.equal(saved.nodes.find(item => item.type === 'generation')!.model_id, nano.id, 'Gemini analysis selection remembers its image modality')
    assert.ok(saved.nodes.filter(item => item.type === 'image_analysis').every(item => item.model_id === nano.id))
    assert.equal(transport.analyses.length + transport.previews.length, 0)
  } finally { await view.destroy() }
})

test('explicit Gemini image analysis and GPT vision models are selectable while plain image generators remain excluded', async t => {
  const nano = { ...imageModel, id: 'nano-analysis', name: 'Nano Banana 反推', remote_id: 'nano-banana-fast',
    settings: { ...imageModel.settings, image_analysis: { enabled: true, protocol: 'gemini_generate_content', remote_id: 'gemini-2.5-flash-image' } } }
  const gpt = { ...visionModel, id: 'gpt-vision', name: 'GPT 看图', remote_id: 'gpt-4.1' }
  const unavailable = { ...nano, id: 'disabled-analysis', name: '已停用反推', enabled: false }
  const graph = initialGraph()
  graph.nodes.find(node => node.id === 'analysis')!.model_id = nano.id
  const transport = mockApi(t, graph, body => Response.json({ ...body, prompt: 'Gemini 返回的构图、光线与材质描述。' }))
  const view = await mount(true, { models: [nano, gpt, imageModel, unavailable] })
  try {
    assert.equal(button('开始反推').disabled, false)
    const label = [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === '看图模型')
    assert.ok(label)
    const select = document.getElementById(label.htmlFor) as HTMLInputElement
    assert.equal(select.value, nano.name)
    await act(() => select.click()); await settle()
    const choices = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.textContent)
    assert.ok(choices.includes(nano.name))
    assert.ok(choices.includes(gpt.name))
    assert.ok(!choices.includes(imageModel.name))
    assert.ok(!choices.includes(unavailable.name))
    const selected = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === nano.name)
    assert.ok(selected)
    await act(() => selected.click()); await settle()
    await click('开始反推')
    assert.deepEqual(transport.analyses, [{ asset_id: uploaded.id, model_id: nano.id, instructions: '' }])
    assert.equal(field('专业提示词').value, 'Gemini 返回的构图、光线与材质描述。')
    const saved = await savedGraph(transport.saved)
    assert.equal(saved.nodes.find(node => node.id === 'analysis')!.model_id, nano.id)
    assert.equal(transport.previews.length, 0)
  } finally { await view.destroy() }
})

test('toolbar creates a persisted image-analysis node, uploads a source and feeds edited professional text to image generation', async t => {
  const transport = mockApi(t, initialGraph(false), body => Response.json({ ...body, prompt: '低机位中景，人物身着黑色长衣，冷色侧逆光，浅景深。' }))
  const view = await mount(false)
  try {
    await click('添加图片反推提示词节点')
    assert.ok(document.querySelector('.pc-image-analysis-panel'))
    assert.equal(button('开始反推').disabled, true)
    const input = document.querySelector<HTMLInputElement>('.pc-image-analysis-panel input[type="file"]'); assert.ok(input)
    Object.defineProperty(input, 'files', { configurable: true, value: [new dom.window.File(['image'], '角色.png', { type: 'image/png' })] })
    await act(() => input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))); await settle()
    assert.equal(transport.uploads.length, 1)
    assert.equal(button('开始反推').disabled, false)
    await edit('反推要求', '重点分析镜头构图和人物服装')
    await click('开始反推')
    assert.deepEqual(transport.analyses, [{ asset_id: uploaded.id, model_id: visionModel.id, instructions: '重点分析镜头构图和人物服装' }])
    assert.match(field('专业提示词').value, /低机位中景/)
    await edit('专业提示词', '手改专业提示词：近景，窗边暖光，真实织物纹理。')
    const firstSave = await savedGraph(transport.saved), analysis = firstSave.nodes.find(item => item.type === 'image_analysis')!
    assert.ok(analysis)
    assert.equal(analysis.asset_id, uploaded.id)
    assert.equal(analysis.text, '手改专业提示词：近景，窗边暖光，真实织物纹理。')
    assert.equal(analysis.settings.image_analysis_source_asset_id, uploaded.id)
    await click('创建图片生成节点')
    const downstream = await savedGraph(transport.saved), generation = downstream.nodes.find(item => item.type === 'generation')!
    assert.ok(generation)
    assert.deepEqual(downstream.edges.filter(edge => edge.target === generation.id).map(({ source, reference_asset_id }) => ({ source, reference_asset_id })),
      [{ source: analysis.id, reference_asset_id: undefined }])
    await click('查看生成信息')
    assert.equal(transport.previews.length, 1, document.querySelector('.pc-notice')?.textContent || 'generation preview reached HTTP')
    assert.match(String(transport.previews[0].prompt), /手改专业提示词：近景，窗边暖光/)
    assert.deepEqual(transport.previews[0].reference_asset_ids, [])
  } finally { await view.destroy() }
})

test('pasting an image into the analysis dialog uploads only its source without running analysis or creating canvas nodes', async t => {
  const graph = initialGraph(true, '保留用户编辑的专业提示词')
  graph.nodes.find(item => item.id === 'analysis')!.asset_id = null
  const transport = mockApi(t, graph, () => { throw new Error('pasting an image must not start analysis') })
  const view = await mount()
  let escapedPastes = 0
  const onDocumentPaste = () => escapedPastes++
  document.addEventListener('paste', onDocumentPaste)
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(document.activeElement, document.querySelector('.pc-image-analysis-source'), 'opening the dialog focuses its paste target')
    const image = new dom.window.File(['clipboard-image'], 'clipboard.png', { type: 'image/png' })
    const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: image.type, getAsFile: () => image }], files: [image],
    } })
    await act(() => field('反推要求').dispatchEvent(paste)); await settle()

    assert.equal(paste.defaultPrevented, true)
    assert.equal(escapedPastes, 0, 'the image paste stays inside the analysis dialog')
    assert.equal(transport.uploads.length, 1)
    const file = transport.uploads[0].get('file')
    assert.ok(file instanceof dom.window.File)
    assert.equal(file.name, 'clipboard.png')
    assert.equal(file.type, 'image/png')
    assert.equal(file.size, image.size)
    assert.ok(document.querySelector<HTMLImageElement>('.pc-image-analysis-source img')?.src.endsWith(uploaded.url))
    assert.equal(field('反推要求').value, '')
    assert.equal(field('专业提示词').value, '保留用户编辑的专业提示词')
    assert.equal(button('重新反推').disabled, false)
    assert.equal(transport.analyses.length, 0)
    assert.equal(transport.previews.length, 0)

    const saved = await savedGraph(transport.saved)
    assert.deepEqual(saved.nodes.map(item => item.id), graph.nodes.map(item => item.id))
    assert.equal(saved.nodes.find(item => item.id === 'analysis')!.asset_id, uploaded.id)
    assert.equal(saved.nodes.find(item => item.id === 'analysis')!.text, '保留用户编辑的专业提示词')
    assert.deepEqual(saved.edges, [])
  } finally { document.removeEventListener('paste', onDocumentPaste); await view.destroy() }
})

test('analysis HTTP errors remain visible, preserve edited output and allow a successful retry', async t => {
  let attempts = 0
  const transport = mockApi(t, initialGraph(true, '已编辑的旧提示词'), body => ++attempts === 1
    ? Response.json({ detail: '看图模型连接失败，请重试' }, { status: 503 }) : Response.json({ ...body, prompt: '重试得到的专业提示词' }))
  const view = await mount()
  try {
    await click('重新反推')
    assert.match(document.querySelector('.pc-image-analysis-error')!.textContent || '', /看图模型连接失败，请重试/)
    assert.equal(field('专业提示词').value, '已编辑的旧提示词')
    assert.equal(button('重新反推').disabled, false)
    await click('重新反推')
    assert.equal(field('专业提示词').value, '重试得到的专业提示词')
    assert.equal(document.querySelector('.pc-image-analysis-error'), null)
    assert.equal(transport.analyses.length, 2)
  } finally { await view.destroy() }
})

test('cancelled analysis cannot overwrite a newer retry when its ignored transport finishes late', async t => {
  let finishOld: ((response: Response) => void) | undefined, oldSignal: AbortSignal | null | undefined, calls = 0
  mockApi(t, initialGraph(true, '保留的旧结果'), (body, init) => {
    if (++calls === 1) { oldSignal = init?.signal; return new Promise<Response>(resolve => { finishOld = resolve }) }
    return Response.json({ ...body, prompt: '新一次反推结果' })
  })
  const view = await mount()
  try {
    await click('重新反推')
    assert.ok(document.querySelector('.pc-image-analysis-status'))
    await click('取消反推')
    assert.equal(oldSignal?.aborted, true)
    assert.equal(field('专业提示词').value, '保留的旧结果')
    assert.equal(button('重新反推').disabled, false)
    await click('重新反推')
    assert.equal(field('专业提示词').value, '新一次反推结果')
    await act(async () => { finishOld!(Response.json({ asset_id: uploaded.id, model_id: visionModel.id, prompt: '迟到旧结果，不应覆盖' })); await Promise.resolve() }); await settle()
    assert.equal(field('专业提示词').value, '新一次反推结果')
  } finally { await view.destroy() }
})

test('a connected source image is analyzed through its fixed asset while the saved card remains text output', async t => {
  const graph = initialGraph()
  graph.nodes.find(item => item.id === 'analysis')!.asset_id = null
  graph.nodes.push(node('image-source', 'image', { asset_id: uploaded.id, title: '已生成图片' }))
  graph.edges = [{ id: 'input', source: 'image-source', target: 'analysis', reference_asset_id: uploaded.id }]
  const transport = mockApi(t, graph, body => Response.json({ ...body, prompt: '从连线图片反推的专业提示词' }))
  const view = await mount()
  try {
    assert.ok(document.querySelector<HTMLImageElement>('.pc-image-analysis-source img')?.src.endsWith(uploaded.url))
    await click('开始反推')
    assert.equal(transport.analyses[0].asset_id, uploaded.id)
    assert.equal(field('专业提示词').value, '从连线图片反推的专业提示词')
    const saved = await savedGraph(transport.saved), analysis = saved.nodes.find(item => item.id === 'analysis')!
    assert.equal(analysis.asset_id, null)
    assert.equal(analysis.settings.image_analysis_source_asset_id, uploaded.id)
    assert.equal(analysis.text, '从连线图片反推的专业提示词')
  } finally { await view.destroy() }
})

test('clearing the source removes uploaded identity and incoming image edges while preserving the editable output and downstream text edge', async t => {
  const graph = initialGraph(true, '用户已编辑并保留的专业提示词')
  graph.nodes.find(item => item.id === 'analysis')!.settings.image_analysis_source_asset_id = uploaded.id
  graph.nodes.push(node('image-source', 'image', { asset_id: uploaded.id, title: '来源图片' }),
    node('downstream', 'generation', { model_id: imageModel.id, settings: { modality: 'image' } }))
  graph.edges = [{ id: 'input', source: 'image-source', target: 'analysis', reference_asset_id: uploaded.id },
    { id: 'output', source: 'analysis', target: 'downstream' }]
  const transport = mockApi(t, graph, () => { throw new Error('clearing a source must not invoke image analysis') })
  const view = await mount()
  try {
    assert.ok(document.querySelector('.pc-image-analysis-source img'))
    await click('清空来源图片')
    assert.equal(document.querySelector('.pc-image-analysis-source img'), null)
    assert.equal(field('专业提示词').value, '用户已编辑并保留的专业提示词')
    assert.equal(button('重新反推').disabled, true)
    assert.equal(button('创建图片生成节点').disabled, false)
    const card = view.container.querySelector<HTMLElement>('[data-id="analysis"]')!
    assert.ok(card.querySelector('.pc-image-analysis-empty'))
    assert.match(card.textContent || '', /用户已编辑并保留的专业提示词/)
    const saved = await savedGraph(transport.saved), analysis = saved.nodes.find(item => item.id === 'analysis')!
    assert.equal(analysis.asset_id, null)
    assert.equal(analysis.text, '用户已编辑并保留的专业提示词')
    assert.equal(analysis.settings.image_analysis_source_asset_id, uploaded.id, 'last successful source remains provenance of the preserved output')
    assert.deepEqual(saved.edges.filter(edge => edge.target === analysis.id), [])
    assert.deepEqual(saved.edges.filter(edge => edge.source === analysis.id), [{ id: 'output', source: 'analysis', target: 'downstream' }])
    assert.equal(transport.analyses.length, 0)
  } finally { await view.destroy() }
})

test('deleting a running analysis cancels its lock and undo cannot revive a late result', async t => {
  let finishOld: ((response: Response) => void) | undefined, oldSignal: AbortSignal | null | undefined, calls = 0
  mockApi(t, initialGraph(true, '删除前保存的提示词'), (body, init) => {
    if (++calls === 1) { oldSignal = init?.signal; return new Promise<Response>(resolve => { finishOld = resolve }) }
    return Response.json({ ...body, prompt: '撤销后重新反推的结果' })
  })
  const view = await mount()
  try {
    await click('重新反推')
    const close = document.querySelector<HTMLButtonElement>('.mantine-Modal-close'); assert.ok(close)
    await act(() => close.click()); await settle()
    const surface = view.container.querySelector('.pc-flow')!
    await act(() => surface.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))); await settle()
    await click('移除')
    assert.equal(view.container.querySelector('[data-id="analysis"]'), null)
    assert.equal(oldSignal?.aborted, true, 'deleting the running node releases its request immediately')
    await click('撤销画布操作')
    const card = view.container.querySelector<HTMLElement>('[data-id="analysis"]'); assert.ok(card)
    await act(() => card.click()); await settle()
    const configure = [...card.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === '编辑反推提示词'); assert.ok(configure)
    await act(() => configure.click()); await settle()
    assert.equal(field('专业提示词').value, '删除前保存的提示词')
    assert.equal(button('重新反推').disabled, false)
    await act(async () => { finishOld!(Response.json({ asset_id: uploaded.id, model_id: visionModel.id, prompt: '删除前发起的迟到结果' })); await Promise.resolve() }); await settle()
    assert.equal(field('专业提示词').value, '删除前保存的提示词')
    await click('重新反推')
    assert.equal(field('专业提示词').value, '撤销后重新反推的结果')
  } finally { await view.destroy() }
})
