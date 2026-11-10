import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, VisualProfile } from '../src/shared/api/api'
import { getManagedPromptBlocks, stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'

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
// A paid submission is refused without Web Locks (canvas-generation-submission.ts), so the test browser provides them,
// serializing by name exactly as navigator.locks does.
const generationLocks = new Map<string, Promise<unknown>>()
Object.defineProperty(dom.window.navigator, 'locks', { configurable: true, value: { request: async (name: string, action: () => Promise<unknown>) => {
  const previous = generationLocks.get(name) || Promise.resolve()
  const running = previous.catch(() => {}).then(action)
  generationLocks.set(name, running)
  try { return await running } finally { if (generationLocks.get(name) === running) generationLocks.delete(name) }
} } })
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
const { promptEditorDocument, promptEditorText } = await import('../src/features/canvas/CanvasPromptEditor')
after(() => dom.window.close())

const projectId = 'visual-setting-template-test', timestamp = '2026-10-26T00:00:00Z'
const imageModel: Model = { id: 'image-model', provider_id: 'provider', name: '参考图片模型', remote_id: 'image', modality: 'image',
  protocol: 'image_generations', enabled: true, settings: { supported_modes: ['text', 'reference'], ratios: ['1:1', '16:9'], resolutions: ['1K', '2K'],
    request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}', resolution: '{{resolution}}' } } }
const assets = ['source-a', 'source-b'].map((id, index) => ({ id, project_id: projectId, kind: 'image' as const,
  filename: `参考${index === 0 ? 'A' : 'B'}.png`, url: `/api/assets/${id}/file`, created_at: timestamp }))
const detail = { id: projectId, name: '直接参考设定', brief: '', ratio: '16:9', updated_at: timestamp,
  script: { outline: '', characters: '', scenes: [], artifacts: [], generation_options: {} },
  shots: [], assets, jobs: [], asset_tasks: [], visual_profiles: [], shot_visual_bindings: [], scene_visual_bindings: [],
  timeline_clips: [], asset_reviews: [], project_visual_style: { version: 'a'.repeat(64), source: 'settings', label: '水墨动画', details: { medium: '水墨动画', palette: '墨黑与朱红' } },
} as unknown as ProjectDetail
function node(id: string, type: CanvasNode['type'], patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, x: 20, y: 50, width: 420, height: 340, title: id, text: '', prompt: '', asset_id: null,
    model_id: null, shot_id: null, job_id: null, settings: {}, ...patch }
}
function initialGraph(): CanvasGraph {
  return { revision: 'initial', nodes: [node(`project-script:${projectId}`, 'project_script_ref', { width: 720, height: 480 }),
    ...assets.map((asset, index) => node(`input-${index === 0 ? 'a' : 'b'}`, 'image', { x: 800 + index * 500, title: asset.filename, asset_id: asset.id }))], edges: [] }
}
type PreviewRequest = { prompt: string; reference_asset_ids: string[]; explicit_reference_asset_ids?: string[]; mode: string; prompt_document: boolean;
  source_artifact_type?: string; shot_id: string | null }
function mockApi(t: TestContext, allowMockGeneration = false, graph = initialGraph()) {
  let currentGraph = graph
  const submittedKeys = new Set<string>()
  const saved: CanvasGraph[] = [], previews: PreviewRequest[] = [], generations: PreviewRequest[] = [], unexpectedRequests: string[] = []
  t.after(() => assert.deepEqual(unexpectedRequests, [], 'only graph persistence and explicitly requested previews may reach HTTP'))
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (path === `/api/projects/${projectId}/canvases`) return Response.json([{ id: projectId, project_id: projectId, name: '画布 1', is_default: true, node_count: currentGraph.nodes.length, viewport: null }])
    if (path === `/api/projects/${projectId}/canvas`) {
      if (method === 'GET') return Response.json(currentGraph)
      assert.equal(method, 'PUT')
      const value = JSON.parse(String(init?.body)); currentGraph = { ...value, revision: `saved-${saved.length + 1}` }; saved.push(currentGraph)
      return Response.json(currentGraph)
    }
    if (path === `/api/projects/${projectId}/skills/defaults`) return Response.json({ policies: [] })
    // A real submission first asks whether this idempotency key already has a job (no side effect), then posts it once.
    if (allowMockGeneration && method === 'GET' && path.startsWith(`/api/projects/${projectId}/generation-submissions/`)) {
      const key = decodeURIComponent(path.slice(`/api/projects/${projectId}/generation-submissions/`.length))
      return Response.json({ job: submittedKeys.has(key) ? { id: 'mock-setting-job', project_id: projectId, status: 'queued', model_id: imageModel.id, shot_id: null, request: '{}', created_at: timestamp } : null })
    }
    if (allowMockGeneration && path === `/api/projects/${projectId}/generate`) {
      assert.equal(method, 'POST')
      const request = JSON.parse(String(init?.body)) as PreviewRequest; generations.push(request)
      for (const [name, value] of Object.entries((init?.headers || {}) as Record<string, string>)) if (/idempotency/i.test(name)) submittedKeys.add(String(value))
      return Response.json({ id: 'mock-setting-job', project_id: projectId, status: 'queued', model_id: imageModel.id,
        shot_id: null, request: JSON.stringify(request), created_at: timestamp })
    }
    if (path !== `/api/projects/${projectId}/generate/preview`) unexpectedRequests.push(`${method} ${path}`)
    assert.equal(path, `/api/projects/${projectId}/generate/preview`, 'connecting a reference must not call a text model, analyze pixels, or create a paid generation')
    assert.equal(method, 'POST')
    const request = JSON.parse(String(init?.body)) as PreviewRequest; previews.push(request)
    return Response.json({ ...request, visual_signature: 'mock-reference-signature' })
  })
  return { saved, previews, generations }
}
async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(pass * 16))
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
function button(label: string) {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    || [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  assert.ok(found, `button: ${label}`); return found
}
async function click(label: string) { await act(() => button(label).click()); await settle() }
async function menuItem(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label)
  assert.ok(found, `menu item: ${label}`)
  await act(() => found.click()); await settle()
}
async function savedGraph(snapshots: CanvasGraph[]) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 720)) }); await settle()
  assert.ok(snapshots.length, 'graph autosave reached HTTP')
  return snapshots.at(-1)!
}
async function mount(projectDetail = detail) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem(`project-canvas-viewport:${projectId}`, JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail: projectDetail, models: [imageModel],
    providers: [{ id: 'provider', name: '测试服务', enabled: true, adapter: 'http' } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {}, onOpenModels: () => {}, onNavigate: () => {}, onOpenScriptCreator: () => {} }
  try {
    await act(() => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)); await settle()
  } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  const prompt = () => {
    const found = container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('.pc-prompt-editor-content')
    assert.ok(found, 'canvas prompt editor'); return found
  }
  const promptText = () => promptEditorText(prompt().editor.getJSON())
  const references = () => assets.map(asset => ({ assetId: asset.id, label: asset.filename, url: asset.url }))
  const editBody = async (body: string) => {
    const value = [body, ...getManagedPromptBlocks(promptText())].join('\n\n')
    await act(() => { prompt().editor.chain().setMeta('promptDocumentReplace', true)
      .setContent(promptEditorDocument(value, references()), { emitUpdate: true }).run() }); await settle()
  }
  const select = async (id: string) => {
    const card = container.querySelector<HTMLElement>(`[data-id="${id}"]`); assert.ok(card)
    await act(() => card.click()); await settle()
  }
  const connect = async (sourceId: string, targetId: string) => {
    const source = container.querySelector<HTMLElement>(`[data-id="${sourceId}"] .react-flow__handle.source`)!
    const target = container.querySelector<HTMLElement>(`[data-id="${targetId}"] .react-flow__handle.target`)!
    assert.ok(source); assert.ok(target)
    await act(() => source.click()); await settle()
    await act(() => target.click()); await settle()
    await select(targetId)
  }
  return { container, promptText, editBody, select, connect, destroy: async () => {
    await act(() => root.unmount()); await settle(); container.remove(); frames.clear()
  } }
}

for (const [kind, label, detailPattern] of [
  ['character', '人物设定', /面部|发型|服装/], ['location', '场景设定', /空间|门窗|布局/], ['prop', '道具设定', /尺寸|结构|材质/],
] as const) test(`${label} can be created without a script and requires a connected reference before generation`, async t => {
  const transport = mockApi(t), view = await mount()
  try {
    if (kind === 'character') {
      const pane = view.container.querySelector<HTMLElement>('.react-flow__pane'); assert.ok(pane)
      await act(() => pane.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))); await settle()
    } else await click('添加节点')
    for (const entry of ['人物设定', '场景设定', '道具设定']) assert.ok([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === entry))
    await menuItem(label)
    const prompt = view.promptText()
    assert.match(prompt, /【设定图固定要求】/)
    assert.match(prompt, detailPattern)
    assert.match(prompt, /水墨动画/)
    assert.match(prompt, /画面比例/)
    assert.equal(button('开始生成').disabled, true, 'a reference setting cannot be generated with no reference')
    const saved = await savedGraph(transport.saved), created = saved.nodes.find(item => item.settings.visual_template_kind === kind)
    assert.ok(created)
    assert.equal(created.type, 'generation')
    assert.equal(created.settings.modality, 'image')
    assert.equal(created.settings.visual_profile_id, undefined)
    assert.equal(created.shot_id, null)
    assert.equal(transport.previews.length, 0)
  } finally { await view.destroy() }
})

test('right clicking an existing picture creates a setting with that exact picture already connected', async t => {
  const transport = mockApi(t), view = await mount()
  try {
    const picture = view.container.querySelector<HTMLElement>('[data-id="input-a"]'); assert.ok(picture)
    await act(() => picture.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))); await settle()
    for (const label of ['创建人物设定', '创建场景设定', '创建道具设定']) assert.ok([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === label))
    await menuItem('创建道具设定')
    assert.match(view.promptText(), /\[\[ref:source-a\]\]/)
    assert.match(view.promptText(), /道具/)
    assert.equal(button('开始生成').disabled, false)
    const saved = await savedGraph(transport.saved), created = saved.nodes.find(item => item.settings.visual_template_kind === 'prop')!
    assert.ok(created)
    assert.deepEqual(saved.edges.filter(edge => edge.target === created.id).map(({ source, reference_asset_id }) => ({ source, reference_asset_id })),
      [{ source: 'input-a', reference_asset_id: 'source-a' }])
    assert.equal(created.shot_id, null)
    assert.equal(transport.previews.length, 0, 'creating a preconnected setting does not request analysis or generation')
  } finally { await view.destroy() }
})

test('the image shortcut pins the displayed candidate instead of a different confirmed profile board', async t => {
  const profile = { id: 'hero-profile', project_id: projectId, kind: 'character', name: '角色', variant: '默认',
    definition: '短发，长衣', view_requirements: '正面、侧面和背面', revision: 1, definition_status: 'ready',
    board_asset_id: 'source-a', board_style_version: detail.project_visual_style!.version, board_style_status: 'current',
    asset_task_id: null, board_prompt: '', candidate_asset_ids: ['source-a', 'source-b'], archived_candidate_asset_ids: [], reference_assets: [] } as VisualProfile
  const graph = initialGraph()
  graph.nodes.push(node('candidate-source', 'generation', { x: 1800, title: '角色候选', asset_id: 'source-b', model_id: imageModel.id,
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision } }))
  const transport = mockApi(t, false, graph), view = await mount({ ...detail, visual_profiles: [profile] })
  try {
    const picture = view.container.querySelector<HTMLElement>('[data-id="candidate-source"]'); assert.ok(picture)
    assert.match(picture.querySelector<HTMLImageElement>('img')?.src || '', /\/api\/assets\/source-b\/(?:file|preview)/, 'the node currently displays candidate B')
    await act(() => picture.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))); await settle()
    await menuItem('创建人物设定')
    const saved = await savedGraph(transport.saved), created = saved.nodes.find(item => item.settings.visual_template_kind === 'character')!
    assert.ok(created)
    assert.deepEqual(saved.edges.filter(edge => edge.target === created.id).map(({ source, reference_asset_id }) => ({ source, reference_asset_id })),
      [{ source: 'candidate-source', reference_asset_id: 'source-b' }])
    assert.match(view.promptText(), /\[\[ref:source-b\]\]/)
    assert.doesNotMatch(view.promptText(), /\[\[ref:source-a\]\]/)
    assert.equal(transport.previews.length, 0)
  } finally { await view.destroy() }
})

test('reference handles compose the setting template, preserve manual text on replacement, and restore the saved kind after reload', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
  t.after(() => { if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor); else Reflect.deleteProperty(document, 'elementFromPoint') })
  const transport = mockApi(t)
  let view = await mount()
  try {
    await click('添加节点'); await menuItem('人物设定')
    const saved = await savedGraph(transport.saved), target = saved.nodes.find(item => item.settings.visual_template_kind === 'character')!
    assert.ok(target)
    await view.connect('input-a', target.id)
    assert.match(view.promptText(), /\[\[ref:source-a\]\]/)
    assert.equal(button('开始生成').disabled, false)
    assert.equal(transport.previews.length, 0, 'connection only composes a prompt locally')
    await click('查看生成信息')
    assert.equal(transport.previews.length, 1, document.querySelector('.pc-notice')?.textContent || 'preview reached HTTP')
    assert.equal(transport.previews[0].mode, 'reference')
    assert.equal(transport.previews[0].source_artifact_type, 'character')
    assert.equal(transport.previews[0].shot_id, null)
    assert.deepEqual(transport.previews[0].reference_asset_ids, ['source-a'])
    assert.equal(transport.previews[0].prompt_document, true)
    assert.match(transport.previews[0].prompt, /设定图固定要求/)
    assert.match(transport.previews[0].prompt, /水墨动画/)
    assert.doesNotMatch(transport.previews[0].prompt, /只生成当前镜头的一幅完整画面|不要复制设定板的多视角拼版/)
    await click('查看生成信息')

    const body = '保留参考人物的身份与衣装，强调衣领结构与手套细节。'
    await view.editBody(body)
    await view.connect('input-b', target.id)
    assert.equal(stripManagedPromptBlocks(view.promptText()).trim(), body, 'manual prose is preserved independently of managed-block separators')
    const remove = [...view.container.querySelectorAll<HTMLButtonElement>('.pc-composer-reference-remove')].find(item => item.getAttribute('aria-label')?.includes('参考A'))
    assert.ok(remove, 'connected reference can be removed')
    await act(() => remove.click()); await settle()
    assert.equal(stripManagedPromptBlocks(view.promptText()).trim(), body, 'manual prose is preserved independently of managed-block separators')
    assert.doesNotMatch(view.promptText(), /\[\[ref:source-a\]\]/)
    assert.match(view.promptText(), /\[\[ref:source-b\]\]/)
    await click('查看生成信息')
    assert.deepEqual(transport.previews.at(-1)!.reference_asset_ids, ['source-b'])
    assert.match(transport.previews.at(-1)!.prompt, /衣领结构与手套细节/)
    const persisted = await savedGraph(transport.saved)
    assert.equal(persisted.nodes.find(item => item.id === target.id)!.settings.visual_template_kind, 'character')
    assert.equal(persisted.edges.filter(edge => edge.target === target.id).length, 1)
    await view.destroy()
    view = await mount(); await view.select(target.id)
    assert.equal(stripManagedPromptBlocks(view.promptText()).trim(), body, 'manual prose is preserved independently of managed-block separators')
    assert.match(view.promptText(), /\[\[ref:source-b\]\]/)
    assert.match(view.promptText(), /【设定图固定要求】/)
    assert.doesNotMatch(view.promptText(), /\[\[ref:source-a\]\]/)
  } finally { await view.destroy() }
})

test('explicit generation queues the setting directly without creating a storyboard shot', async t => {
  const transport = mockApi(t, true), view = await mount()
  try {
    const picture = view.container.querySelector<HTMLElement>('[data-id="input-a"]'); assert.ok(picture)
    await act(() => picture.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))); await settle()
    await menuItem('创建场景设定')
    assert.equal(transport.generations.length, 0)
    const initial = await savedGraph(transport.saved), created = initial.nodes.find(item => item.settings.visual_template_kind === 'location')!
    assert.ok(created)
    await click('开始生成')
    const saved = await savedGraph(transport.saved)
    assert.equal(transport.previews.length, 1)
    console.error('PROBE notice=', JSON.stringify(document.querySelector('.pc-notice')?.textContent), '| gens', transport.generations.length)
    assert.equal(transport.generations.length, 1, document.querySelector('.pc-notice')?.textContent || 'only a mocked queue request is allowed')
    const preview = transport.previews[0], queued = transport.generations[0]
    assert.equal(queued.shot_id, null)
    assert.equal(queued.source_artifact_type, 'location')
    assert.equal(queued.prompt_document, true)
    assert.equal(queued.mode, 'reference')
    assert.deepEqual(queued.reference_asset_ids, ['source-a'])
    assert.deepEqual(queued.reference_asset_ids, preview.reference_asset_ids)
    assert.equal(queued.prompt, preview.prompt)
    assert.match(queued.prompt, /设定图固定要求/)
    assert.match(queued.prompt, /水墨动画/)
    const result = saved.nodes.find(item => item.id === created.id)!
    assert.equal(result.shot_id, null)
    assert.equal(result.job_id, 'mock-setting-job')
    assert.equal(result.settings.visual_template_kind, 'location')
  } finally { await view.destroy() }
})
