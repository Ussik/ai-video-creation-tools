import { chooseCombobox } from './component-controls'
import { videoReferenceUsageLabels, type VideoReferenceUsage } from '@video-studio/shared/media/video-reference-usage'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import { getManagedPromptBlocks, stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model, ProjectDetail, ShotVisualBinding, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'

// Render the actual canvas and composer; only CSS and HTTP transport are mocked.
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`, import.meta.url)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver', 'DOMParser']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const caretRect = { left: 60, top: 40, right: 61, bottom: 60, width: 1, height: 20 }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => caretRect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [caretRect] })
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
const { promptEditorDocument, promptEditorText } = await import('../src/features/canvas/CanvasPromptEditor')
after(() => dom.window.close())

const timestamp = '2026-10-10T00:00:00Z'
const videoModel: Model = { id: 'video-model', provider_id: 'provider', name: '多参考视频模型', remote_id: 'video-v2',
  modality: 'video', protocol: 'async_video', enabled: true,
  settings: { supported_modes: ['text', 'first_frame', 'first_last_frame', 'reference'], max_reference_images: 9,
    resolutions: ['480p', '720p'], ratios: ['adaptive', '9:16'], request_template: { prompt: '{{prompt}}', images: '{{images}}' } } }
const hero = { id: 'hero', project_id: 'video-reference-test', kind: 'character', name: '林晚', variant: '校服', revision: 2,
  definition: '短发，蓝色校服', view_requirements: '正面与侧面', board_asset_id: 'hero-board', board_prompt: '', asset_task_id: null,
  definition_status: 'ready' } as VisualProfile
const station = { ...hero, id: 'station', kind: 'location', name: '站台', variant: '夜间', definition: '空旷地下站台', board_asset_id: 'station-board' } as VisualProfile
const bind = (profile: VisualProfile, required: boolean): ShotVisualBinding => ({ ...profile, profile_id: profile.id, shot_id: 'shot', required })
const detail = { id: 'video-reference-test', name: '夜班列车', brief: '车站故事', ratio: '9:16', updated_at: timestamp,
  script: { outline: '林晚等车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
  shots: [{ id: 'shot', project_id: 'video-reference-test', position: 0, title: '站台回望', prompt: '林晚在站台回头。', video_prompt: '林晚缓缓回头，镜头平移。',
    duration: 5, selected_asset_id: 'storyboard', source_scene_id: null, start_state: '', end_state: '', cut_note: '' }],
  assets: ['storyboard', 'hero-board', 'station-board', 'manual'].map(id => ({ id, project_id: 'video-reference-test', kind: 'image', filename: `${id}.png`,
    shot_id: id === 'storyboard' ? 'shot' : null, url: `/api/assets/${id}/file`, created_at: timestamp })),
  jobs: [], asset_tasks: [], timeline_clips: [], asset_reviews: [], visual_profiles: [hero, station], scene_visual_bindings: [],
  shot_visual_bindings: [bind(hero, true), bind(station, false)],
} as unknown as ProjectDetail
function node(id: string, type: CanvasNode['type'], x: number, asset_id: string | null = null): CanvasNode {
  return { id, type, x, y: 100, width: 330, height: 260, title: id, text: '', prompt: '', asset_id, shot_id: null, model_id: null, job_id: null, settings: {} }
}
function initialGraph(mode: 'reference' | 'first_frame', extraManual = false): CanvasGraph {
  return { revision: 'initial', nodes: [
    { ...node('storyboard-node', 'image', 50, 'storyboard'), shot_id: 'shot' },
    { ...node('video-node', 'generation', 500), title: '分镜视频', shot_id: 'shot', model_id: videoModel.id, prompt: '林晚缓缓回头，镜头平移。',
      settings: { modality: 'video', mode, visual_reference_mode: mode === 'reference' ? 'profiles' : 'keyframe', storyboard_reference_asset_id: 'storyboard', resolution: '480p', ratio: '9:16' } },
    ...(extraManual ? [node('manual-node', 'image', 900, 'manual')] : []),
    { ...node('project-script:video-reference-test', 'project_script_ref', -790), title: detail.name, width: 720, height: 480 },
  ], edges: [{ id: 'storyboard-edge', source: 'storyboard-node', target: 'video-node', reference_asset_id: 'storyboard' },
    ...(extraManual ? [{ id: 'manual-edge', source: 'manual-node', target: 'video-node', reference_asset_id: 'manual' }] : [])] }
}
type PreviewInput = { video_reference_usages?: import('@video-studio/shared/media/video-reference-usage').VideoReferenceUsageSelection[]; mode: string; reference_asset_ids: string[]; prompt: string; visual_reference_mode: string; excluded_visual_profile_ids?: string[]; storyboard_reference_asset_id?: string | null }
type ApiHandler = (path: string, method: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined
function mockApi(t: TestContext, graph: CanvasGraph, projectDetail = detail, handler?: ApiHandler, saveError = false) {
  const previews: PreviewInput[] = [], resolvedPreviews: PreviewInput[] = [], saved: CanvasGraph[] = []
  t.after(() => dom.window.localStorage.removeItem('project-reference-batch:["video-reference-test","video-reference-test"]'))
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (path === '/api/projects/video-reference-test/canvases') return Response.json([{ id: 'video-reference-test', project_id: 'video-reference-test', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === '/api/projects/video-reference-test/skills/defaults') {
      assert.equal(method, 'GET')
      return Response.json({ policies: [{ stage: 'video_prompt', label: '视频提示词', primary_id: 'video-a', auxiliary_ids: [], source: 'global', warning: '',
        skills: ['a', 'b', 'c'].map(id => ({ id: `video-${id}`, name: `视频技能${id}`, description: `技能${id}的说明`, revision: 'a'.repeat(40) })) }] })
    }
    if (path === '/api/projects/video-reference-test/canvas') {
      if (method === 'GET') return Response.json(graph)
      assert.equal(method, 'PUT')
      if (saveError) return Response.json({ message: '模拟画布保存失败' }, { status: 500 })
      const value = JSON.parse(String(init?.body)); saved.push(value)
      return Response.json({ ...value, revision: `saved-${saved.length}` })
    }
    const handled = await handler?.(path, method, init?.body ? JSON.parse(String(init.body)) : {})
    if (handled) return handled
    assert.equal(path, '/api/projects/video-reference-test/generate/preview', 'test must never create a paid generation job')
    assert.equal(method, 'POST')
    const request = JSON.parse(String(init?.body)) as PreviewInput
    previews.push(request)
    // The server resolves bound boards; it never needs the UI to turn them into manual connections.
    const profileIds = request.mode === 'reference' && request.visual_reference_mode === 'profiles'
      ? (projectDetail.shot_visual_bindings || []).filter(binding => visualBindingApplies(binding,
        graph.nodes.find(node => node.id === 'video-node')?.settings.modality === 'image' ? 'image' : 'video')
        && (binding.required || !request.excluded_visual_profile_ids?.includes(binding.profile_id)))
        .flatMap(binding => binding.reference_assets?.length ? binding.reference_assets.map(reference => reference.asset_id) : binding.board_asset_id ? [binding.board_asset_id] : []) : []
    const resolved = resolvePromptReferences({ prompt: request.prompt, referenceAssetIds: [...new Set([...request.reference_asset_ids, ...profileIds])],
      overrides: (request as PreviewInput & { prompt_reference_overrides?: Record<string, string | null> }).prompt_reference_overrides,
      referenceLabel: '图片' })
    const response = { ...request, prompt: resolved.prompt, reference_asset_ids: resolved.referenceAssetIds, visual_signature: 'mock-reviewed-bindings' }
    resolvedPreviews.push(response)
    return Response.json(response)
  })
  return { previews, resolvedPreviews, saved }
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
async function mount(projectDetail = detail, portals = false, overrides: Partial<ProjectCanvasProps> = {}) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:video-reference-test', JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail: projectDetail, models: [videoModel], providers: [{ id: 'provider', name: '本地测试', adapter: 'http', enabled: true } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {}, onOpenModels: () => {}, onNavigate: () => {}, onOpenScriptCreator: () => {}, ...overrides }
  const render = () => root.render(<MantineProvider env={portals ? 'default' : 'test'} theme={portals ? { components: {
    Modal: { defaultProps: { transitionProps: { duration: 0 } } },
    Popover: { defaultProps: { transitionProps: { duration: 0 } } },
  } } : undefined}><ProjectCanvas {...props} /></MantineProvider>)
  try {
    await act(render); await settle()
    const video = container.querySelector<HTMLElement>('[data-id="video-node"]')!
    assert.ok(video)
    await act(() => video.click()); await settle()
  } catch (issue) { await act(() => root.unmount()); container.remove(); throw issue instanceof AggregateError ? issue.errors[0] : issue }
  const button = (label: string) => {
    const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(found, label); return found
  }
  const selectMode = async (label: string) => {
    const trigger = container.querySelector<HTMLButtonElement>('.pc-generation-mode-trigger')!
    await act(() => trigger.click()); await settle()
    const found = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${label}"]`)
    assert.ok(found, label)
    await act(() => found.click()); await settle()
  }
  const videoPromptReferences = () => [...document.querySelectorAll<HTMLImageElement>('.pc-video-reference-preview img')].flatMap(image => {
    const asset = props.detail.assets.find(asset => asset.url === image.getAttribute('src'))
    return asset ? [{ assetId: asset.id, label: asset.filename, url: asset.url }] : []
  })
  const promptReferences = () => {
    const visible = videoPromptReferences()
    if (visible.length) return visible
    const editor = container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('.pc-prompt-editor-content')?.editor
    const manifest = editor ? getManagedPromptBlocks(promptEditorText(editor.getJSON()), ['图片参考图用途', '生成参考图']).join('\n\n') : ''
    const manifestIds = [...new Set([...manifest.matchAll(/\[\[ref:([^\]]+)\]\]/g)].map(match => match[1]))]
    if (manifestIds.length) return manifestIds.flatMap(assetId => {
      const asset = props.detail.assets.find(asset => asset.id === assetId)
      return asset ? [{ assetId, label: asset.filename, url: asset.url }] : []
    })
    return (props.detail.shot_visual_bindings || []).flatMap(binding =>
      binding.reference_assets?.length ? binding.reference_assets.map(ref => ({ assetId: ref.asset_id, label: ref.label, url: '' })) : binding.board_asset_id ? [{ assetId: binding.board_asset_id, label: binding.name, url: '' }] : [])
  }
  const readablePromptText = (value: string) => {
    const refs = promptReferences()
    return value.replace(/\[\[ref:([^\]]+)\]\]/g, (_, id) => `${document.querySelector('.pc-video-references') ? '图片' : '参考图 '}${refs.findIndex(ref => ref.assetId === id) + 1}`)
  }
  const prompt = () => {
    const found = container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor; value: string }>('[contenteditable][aria-label="创作提示词"], [contenteditable][aria-label="信息图提示词"]')
    assert.ok(found, 'actual canvas composer')
    if (!Object.getOwnPropertyDescriptor(found, 'value')) Object.defineProperty(found, 'value', { get: () => readablePromptText(promptEditorText(found.editor.getJSON())) })
    return found
  }
  const systemPrompt = () => getManagedPromptBlocks(prompt().value).join('\n\n')
  const bodyPrompt = () => stripManagedPromptBlocks(prompt().value)
  const images = () => [...container.querySelectorAll('.pc-video-reference-number')].map(node => node.textContent)
  const editPrompt = async (value: string) => {
    await act(() => { prompt().editor.chain().setMeta('promptDocumentReplace', true)
      .setContent(promptEditorDocument(value, promptReferences()), { emitUpdate: true }).run() })
    await settle()
  }
  const editBody = async (value: string) => editPrompt([value,
    getManagedPromptBlocks(promptEditorText(prompt().editor.getJSON())).join('\n\n')].filter(Boolean).join('\n\n'))
  const openMention = async () => {
    const editor = prompt().editor
    await act(() => editor.chain().setTextSelection(editor.state.doc.content.size - 1).insertContent('@').run())
    await settle()
  }
  const preview = async () => { await act(() => button('查看生成信息').click()); await settle() }
  return { container, button, selectMode, prompt, bodyPrompt, systemPrompt, images, editPrompt, editBody, openMention, preview,
    renderDetail: async (next: ProjectDetail) => { props.detail = next; await act(render); await settle() },
    destroy: async () => { await act(() => root.unmount()); await settle(); container.remove(); frames.clear() } }
}

test('legacy final complete drafts keep authored bounded settings when opened in the structured editor', async t => {
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = imageModel.id; target.settings.modality = 'image'
  const api = mockApi(t, graph)
  let view = await mount(detail, false, { models: [imageModel] })
  try {
    const source = promptEditorText(view.prompt().editor.getJSON())
    await view.destroy()
    target.text = source.replace(hero.definition, '短发，用户保留的旧版外套')
    target.settings = { ...target.settings, prompt_is_final: true, prompt_template: source }
    view = await mount(detail, false, { models: [imageModel] })
    assert.match(promptEditorText(view.prompt().editor.getJSON()), /用户保留的旧版外套/)
    assert.doesNotMatch(view.container.querySelector('.pc-prompt-document-status')!.textContent!, /项待确认/)
    await view.preview()
    assert.match(api.previews.at(-1)!.prompt, /用户保留的旧版外套/)
  } finally { await view.destroy() }
})

test('node custom settings merge independent source changes and require a persisted choice for overlapping changes', async t => {
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = imageModel.id; target.settings.modality = 'image'
  const api = mockApi(t, graph)
  let view = await mount(detail, false, { models: [imageModel] })
  const rawPrompt = () => promptEditorText(view.prompt().editor.getJSON())
  const local = '短发，深蓝外套，保留手工纽扣细节'
  const nextHero = { ...hero, definition: '长发，白色制服' }
  const nextStation = { ...station, definition: '空旷地下站台，新增黄色安全线' }
  const updated: ProjectDetail = { ...detail, visual_profiles: [nextHero, nextStation],
    shot_visual_bindings: [bind(nextHero, true), bind(nextStation, false)] }
  try {
    await view.editPrompt(rawPrompt().replace(hero.definition, local))
    await view.renderDetail({ ...detail, visual_profiles: [hero, nextStation],
      shot_visual_bindings: [bind(hero, true), bind(nextStation, false)] })
    assert.ok(rawPrompt().includes(local))
    assert.ok(rawPrompt().includes(nextStation.definition), 'independent project edits merge within the same block')
    assert.doesNotMatch(view.container.querySelector('.pc-prompt-document-status')!.textContent!, /项待确认/)
    await view.preview()
    assert.equal(api.previews.length, 1)
    await view.renderDetail(updated)
    assert.ok(rawPrompt().includes(local), 'overlapping source changes preserve the node edit')
    assert.match(view.container.querySelector('.pc-prompt-document-status')!.textContent!, /1 项待确认/)
    await view.preview()
    assert.equal(api.previews.length, 1, 'unresolved source conflicts cannot produce a mixed preview')
    await act(() => view.button('保留本节点修改：镜头视觉设定').click()); await settle()
    assert.ok(rawPrompt().includes(local))
    assert.doesNotMatch(view.container.querySelector('.pc-prompt-document-status')!.textContent!, /项待确认/)
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    Object.assign(graph, api.saved.at(-1)!)
    await view.destroy(); view = await mount(updated, false, { models: [imageModel] })
    assert.ok(rawPrompt().includes(local), 'explicit keep decision survives reload')
    assert.doesNotMatch(view.container.querySelector('.pc-prompt-document-status')!.textContent!, /项待确认/)
    await act(() => view.button('跟随项目设定：镜头视觉设定').click()); await settle()
    assert.ok(rawPrompt().includes(nextHero.definition))
    assert.ok(!rawPrompt().includes(local))
    assert.ok(rawPrompt().includes(nextStation.definition))
  } finally { await view.destroy() }
})

test('explicit parameter conflicts block preview and synchronize without changing reference identity or prose', async t => {
  const graph = initialGraph('reference'), api = mockApi(t, graph)
  const view = await mount(detail, false)
  const rawPrompt = () => promptEditorText(view.prompt().editor.getJSON())
  const referenceIds = () => [...rawPrompt().matchAll(/\[\[ref:([^\]]+)\]\]/g)].map(match => match[1])
  try {
    const original = rawPrompt(), originalIds = referenceIds(), originalBody = view.bodyPrompt()
    await view.editPrompt(original.replace('画面比例：9:16', '画面比例：4:3').replace('视频时长：5 秒', '视频时长：12 秒'))
    const panel = view.container.querySelector('.pc-prompt-parameter-conflicts')!
    assert.ok(panel)
    assert.match(panel.textContent!, /4:3/)
    assert.match(panel.textContent!, /12/)
    await view.preview()
    assert.equal(api.previews.length, 0)
    await act(() => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '按生成参数同步提示词')!.click()); await settle()
    assert.equal(view.container.querySelector('.pc-prompt-parameter-conflicts'), null)
    assert.equal(view.bodyPrompt(), originalBody)
    assert.deepEqual(referenceIds(), originalIds)
    assert.match(rawPrompt(), /画面比例：9:16/)
    assert.match(rawPrompt(), /视频时长：5 秒/)
    await view.preview()
    assert.equal(api.previews.length, 1)
    assert.equal((api.previews[0] as unknown as { ratio: string }).ratio, '9:16')
    assert.equal((api.previews[0] as unknown as { duration: number }).duration, 5)
  } finally { await view.destroy() }
})

test('shot reference drawer preserves the composer and selection without canvas writes; Escape closes it before the composer', async t => {
  const api = mockApi(t, initialGraph('reference'))
  const view = await mount(detail, true)
  const chip = () => {
    const element = document.querySelector<HTMLButtonElement>('.pc-visual-context-button')
    assert.ok(element); return element
  }
  const open = async () => {
    await act(() => chip().dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
    await act(() => chip().click()); await settle()
    assert.ok(document.querySelector('#pc-composer-bindings'))
    assert.ok(document.querySelector('.pc-shot-references-content[role="dialog"]'), 'references use an independent viewport drawer')
    assert.ok(!document.querySelector('.pc-prompt-composer #pc-composer-bindings'), 'references no longer share the prompt body')
  }
  try {
    const textarea = view.prompt(), initialPrompt = textarea.value
    const writes = api.saved.length, previews = api.previews.length
    await open()
    assert.ok(view.prompt() === textarea, 'drawer must not remount the prompt')
    await act(() => view.button('查看引用图：林晚').click()); await settle()
    const preview = document.querySelector<HTMLImageElement>('.pc-reference-preview-image')!
    assert.ok(preview, 'reference thumbnail opens the in-app full-size preview')
    await act(() => preview.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
    assert.ok(!document.querySelector('.pc-reference-preview-image'), 'Escape closes the image preview first')
    assert.ok(document.querySelector('#pc-composer-bindings'), 'image preview must retain the reference drawer')
    assert.equal(textarea.value, initialPrompt)
    const overlay = document.querySelector<HTMLElement>('.pc-shot-references-root .mantine-Overlay-root')!
    assert.ok(overlay)
    await act(() => overlay.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
    await act(() => overlay.click()); await settle()
    assert.ok(!document.querySelector('#pc-composer-bindings'), 'outside click closes only the drawer')
    assert.ok(view.container.querySelector('[data-id="video-node"].selected'), 'outside click preserves the selected node')
    assert.ok(view.prompt() === textarea)
    await open()
    await act(() => view.button('关闭镜头引用').click()); await settle()
    assert.ok(view.prompt() === textarea, 'closing references must preserve the prompt element')
    assert.equal(textarea.value, initialPrompt)
    await act(() => view.button('放大创作区').click()); await settle()
    await open()
    const expandedPrompt = view.prompt()
    await act(() => expandedPrompt.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
    assert.ok(!document.querySelector('#pc-composer-bindings'), 'first Escape closes the reference section')
    assert.ok(document.querySelector('.pc-composer-modal-content'))
    assert.equal(expandedPrompt.value, initialPrompt)
    assert.ok(view.container.querySelector('[data-id="video-node"].selected'))
    await act(() => expandedPrompt.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
    assert.ok(!document.querySelector('.pc-composer-modal-content'), 'second Escape closes the expanded composer')
    assert.equal(view.prompt().value, initialPrompt)
    assert.equal(api.saved.length, writes)
    assert.equal(api.previews.length, previews)
  } finally { await view.destroy() }
})

test('pointer interactions with portaled prompt skills keep the selected node and refinement modal open', async t => {
  const api = mockApi(t, initialGraph('reference'))
  // Mantine's test environment disables portals and hides this regression.
  const view = await mount(detail, true)
  const pointerClick = async (element: HTMLElement) => {
    await act(() => element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }))); await settle()
    assert.ok(element.isConnected, 'pointer-down must not unmount the active editor')
    await act(() => element.click()); await settle()
  }
  const modal = () => {
    const element = document.querySelector('.prompt-skill-modal')
    assert.ok(element, 'prompt refinement modal stays open')
    assert.ok(view.container.querySelector('[data-id="video-node"].selected'), 'active node remains selected')
    assert.ok(view.container.querySelector('.pc-composer-anchor'), 'node editor remains mounted')
    return element
  }
  const chooseSkill = async (label: string, id: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    assert.ok(input)
    await pointerClick(input)
    const listbox = document.getElementById(input.getAttribute('aria-controls') || '')
    assert.ok(listbox)
    const option = listbox.querySelector<HTMLElement>(`[role="option"][value="${id}"]`)!
    assert.ok(option)
    await pointerClick(option)
    modal()
  }
  try {
    await pointerClick(view.button('使用技能整理提示词'))
    modal()
    await pointerClick(view.button('视频提示词技能选择'))
    const popover = document.querySelector<HTMLElement>('.creative-skill-popover')!
    assert.ok(popover)
    assert.equal(modal().contains(popover), false, 'regression exercises an actual portal outside the modal')
    await pointerClick(popover.querySelector<HTMLElement>('header')!)
    modal()
    await chooseSkill('video_prompt主技能', 'video-b')
    assert.match(modal().querySelector('.prompt-skill-primary')!.textContent!, /视频技能b/)
    await chooseSkill('video_prompt辅助技能', 'video-a')
    assert.match(modal().querySelector('.prompt-skill-card > p')!.textContent!, /辅助技能 1 个/)
    const about = document.querySelector<HTMLDetailsElement>('.creative-skill-about')!
    await pointerClick(about.querySelector('.workspace-disclosure-control')!)
    assert.equal(about.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'true')
    const config = document.querySelector<HTMLDetailsElement>('.creative-skill-more-config')!
    await pointerClick(config.querySelector('.workspace-disclosure-control')!)
    assert.equal(config.querySelector('.workspace-disclosure-control')!.getAttribute('aria-expanded'), 'true')
    modal()
    assert.deepEqual(api.previews, [], 'choosing skills cannot trigger paid work or even a generation preview')
    assert.deepEqual(api.saved, [], 'skill choices do not write the canvas or defaults')
    await pointerClick(view.button('关闭整理提示词'))
    assert.equal(document.querySelector('.prompt-skill-modal'), null, 'explicit close still works')
    assert.ok(view.prompt())
  } finally { await view.destroy() }
})

test('prompt primary and auxiliary choices carry into the next real canvas node and reopen', async t => {
  const graph = initialGraph('reference')
  graph.nodes.push({ ...graph.nodes[1], id: 'next-video-node', title: '下一镜视频', x: 900 })
  const api = mockApi(t, graph)
  const view = await mount()
  const skillSummary = () => {
    const modal = document.querySelector('.prompt-skill-modal')!
    assert.ok(modal)
    assert.match(modal.querySelector('.prompt-skill-primary')!.textContent!, /视频技能b/)
    assert.match(modal.querySelector('.prompt-skill-card > p')!.textContent!, /辅助技能 1 个/)
  }
  const choose = async (label: string, id: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    await act(() => input.click()); await settle()
    const option = document.getElementById(input.getAttribute('aria-controls')!)!.querySelector<HTMLElement>(`[role="option"][value="${id}"]`)!
    assert.ok(option)
    await act(() => option.click()); await settle()
  }
  try {
    await act(() => view.button('使用技能整理提示词').click()); await settle()
    await act(() => view.button('视频提示词技能选择').click()); await settle()
    await choose('video_prompt主技能', 'video-b')
    await choose('video_prompt辅助技能', 'video-a')
    skillSummary()
    await act(() => view.button('关闭整理提示词').click()); await settle()
    await act(() => view.button('使用技能整理提示词').click()); await settle()
    skillSummary()
    await act(() => view.button('关闭整理提示词').click()); await settle()
    await act(() => view.container.querySelector<HTMLElement>('[data-id="next-video-node"]')!.click()); await settle()
    assert.ok(view.container.querySelector('[data-id="next-video-node"].selected'))
    await act(() => view.button('使用技能整理提示词').click()); await settle()
    skillSummary()
    await act(() => view.button('视频提示词技能选择').click()); await settle()
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="video_prompt辅助技能"]')!.parentElement?.textContent?.includes('视频技能a'), true)
    assert.deepEqual(api.saved, [])
    assert.deepEqual(api.previews, [])
  } finally { await view.destroy() }
})

test('actual video composer numbers bound boards and synchronizes optional exclusions with editable prompt and preview request', async t => {
  const api = mockApi(t, initialGraph('reference'))
  const view = await mount()
  try {
    assert.equal(view.container.querySelector('[aria-label="分镜视频生成策略"]'), null, 'the bottom menu is the sole mode control')
    assert.ok(view.button('视频生成模式：多图参考'))
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3'])
    assert.match(view.prompt().value, /图片1：分镜构图/)
    assert.match(view.prompt().value, /图片2：林晚（校服）/)
    assert.match(view.prompt().value, /图片3：站台（夜间）/)
    await view.editPrompt(`${view.prompt().value}\n手动动作：林晚停顿一秒再回头，摄像机保持克制。`)
    await act(() => view.button('排除可选参考：站台 · 夜间').click()); await settle()
    assert.deepEqual(view.images(), ['图片1', '图片2'])
    assert.doesNotMatch(view.prompt().value, /图片3：站台/)
    assert.match(view.prompt().value, /手动动作：林晚停顿一秒再回头/)
    await view.preview()
    assert.equal(api.previews.length, 1)
    assert.deepEqual(api.previews[0].reference_asset_ids, ['storyboard', 'hero-board'], 'the complete document carries every effective input in displayed order')
    assert.deepEqual(api.previews[0].excluded_visual_profile_ids, ['station'])
    assert.match(api.resolvedPreviews[0].prompt, /图片 2：林晚（校服）/)
    assert.doesNotMatch(api.previews[0].prompt, /图片3：站台/)
    assert.deepEqual([...document.querySelectorAll('.pc-generation-info-content .pc-visual-thumbnails img')].map(image => image.getAttribute('src')),
      ['/api/assets/storyboard/file', '/api/assets/hero-board/file'])
    await act(() => view.button('恢复可选参考：站台').click()); await settle()
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3'])
    assert.match(view.prompt().value, /图片3：站台（夜间）/)
    assert.match(view.prompt().value, /手动动作：林晚停顿一秒再回头/)
    await view.preview()
    assert.deepEqual(api.previews[1].excluded_visual_profile_ids, [])
    assert.deepEqual([...document.querySelectorAll('.pc-generation-info-content .pc-visual-thumbnails img')].map(image => image.getAttribute('src')),
      ['/api/assets/storyboard/file', '/api/assets/hero-board/file', '/api/assets/station-board/file'])
  } finally { await view.destroy() }
})

test('actual video composer inherits independent shot angles without adding the connected profile board and preserves them when changing modes', async t => {
  const snapshots = [
    { id: 'side-ref', asset_id: 'hero-side', view: 'side' as const, purpose: 'costume' as const, label: '校服侧面', revision: 2, style_version: 'anime' },
    { id: 'face-ref', asset_id: 'hero-face', view: 'face' as const, purpose: 'identity' as const, label: '林晚面部', revision: 2, style_version: 'anime' },
  ]
  const projectDetail: ProjectDetail = { ...detail, project_visual_style: { version: 'anime', label: '日漫', source: 'settings', details: {} } as ProjectDetail['project_visual_style'],
    visual_profiles: [{ ...hero, board_style_status: 'needs_review', board_style_version: 'old' }, station],
    shot_visual_bindings: [{ ...bind(hero, true), reference_assets: snapshots }, bind(station, false)],
    assets: [...detail.assets, ...snapshots.map(reference => ({ ...detail.assets[0], id: reference.asset_id, shot_id: null, filename: `${reference.asset_id}.png`, url: `/api/assets/${reference.asset_id}/file` }))],
  }
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('hero-node', 'generation', 900, 'hero-board'), title: '林晚设定', settings: { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: 2 } })
  graph.edges.push({ id: 'hero-edge', source: 'hero-node', target: 'video-node' })
  const api = mockApi(t, graph, projectDetail), view = await mount(projectDetail)
  try {
    assert.equal(view.container.querySelector('[aria-label="待补齐参考图"]'), null, 'a legacy board must not invalidate the approved independent snapshot')
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3', '图片4'])
    assert.match(view.prompt().value, /侧面|校服侧面/)
    assert.match(view.prompt().value, /面部|林晚面部/)
    await view.preview()
    assert.deepEqual(api.previews[0].reference_asset_ids, ['storyboard', 'hero-side', 'hero-face'])
    assert.ok(!api.previews[0].reference_asset_ids.includes('hero-board'))
    await view.selectMode('首帧承接')
    assert.deepEqual(view.images(), ['图片1'])
    await view.selectMode('多图参考')
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3', '图片4'])
    assert.match(view.prompt().value, /林晚面部/)
  } finally { await view.destroy() }
})

test('explicit first-frame strategy remains selected and switching preserves other references and manually edited action prose', async t => {
  const api = mockApi(t, initialGraph('first_frame', true))
  const view = await mount()
  try {
    assert.ok(view.button('视频生成模式：首帧承接'), 'existing explicit strategy is authoritative')
    assert.deepEqual(view.images(), ['图片1'])
    assert.doesNotMatch(view.prompt().value, /【视频参考图用途】/)
    await view.editPrompt(`${view.prompt().value}\n用户运镜：镜头缓缓后退，保留人物的沉默。`)
    await view.preview()
    assert.equal(api.previews[0].mode, 'first_frame')
    assert.equal(api.previews[0].visual_reference_mode, 'keyframe')
    assert.deepEqual(api.previews[0].reference_asset_ids, ['storyboard'])
    assert.match(api.previews[0].prompt, /用户运镜：镜头缓缓后退/)
    await view.selectMode('多图参考')
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3', '图片4'])
    assert.match(view.prompt().value, /图片1：分镜构图/)
    assert.match(view.prompt().value, /图片2：手动参考/)
    assert.match(view.prompt().value, /图片3：林晚（校服）/)
    assert.match(view.prompt().value, /用户运镜：镜头缓缓后退/)
    await view.preview()
    assert.equal(api.previews[1].mode, 'reference')
    assert.deepEqual(api.previews[1].reference_asset_ids, ['storyboard', 'manual', 'hero-board', 'station-board'])
    assert.equal(document.querySelectorAll('.pc-generation-info-content .pc-visual-thumbnails img').length, 4)
    await view.selectMode('首尾帧')
    assert.ok(view.button('视频生成模式：首尾帧'))
    assert.deepEqual(view.images(), ['图片1', '图片2'])
    assert.doesNotMatch(view.prompt().value, /【视频参考图用途】/)
    await view.preview()
    assert.equal(api.previews[2].mode, 'first_last_frame')
    assert.equal(api.previews[2].visual_reference_mode, 'keyframe')
    assert.deepEqual(api.previews[2].reference_asset_ids, ['storyboard', 'manual'])
    assert.match(api.previews[2].prompt, /用户运镜：镜头缓缓后退/)
    await view.selectMode('首帧承接')
    assert.deepEqual(view.images(), ['图片1'])
    assert.doesNotMatch(view.prompt().value, /【视频参考图用途】/)
    assert.match(view.prompt().value, /用户运镜：镜头缓缓后退/)
    await view.selectMode('多图参考')
    assert.deepEqual(view.images(), ['图片1', '图片2', '图片3', '图片4'], 'strict first-frame does not destroy extra reference connections')
  } finally { await view.destroy() }
})

test('video quick actions and composer menu select the same reference strategy and request', async t => {
  const graph = initialGraph('reference', true)
  delete graph.nodes.find(node => node.id === 'video-node')!.settings.storyboard_reference_asset_id
  // The opening storyboard must win over an unrelated reference connected first.
  graph.edges.reverse()
  const api = mockApi(t, graph), view = await mount()
  try {
    await view.editPrompt(`${view.prompt().value}\n用户运镜：镜头缓缓后退。`)
    for (const [label, mode, imageCount] of [['首帧承接', 'first_frame', 1], ['首尾帧', 'first_last_frame', 2]] as const) {
      if (mode === 'first_last_frame') await view.selectMode('多图参考')
      await act(() => view.container.querySelector<HTMLElement>('[data-id="storyboard-node"]')!.click()); await settle()
      const video = view.container.querySelector<HTMLElement>('[data-id="video-node"]')!
      const quick = [...video.querySelectorAll<HTMLButtonElement>('.pc-node-try-action')].find(button => button.textContent === label)
      assert.ok(quick, label)
      assert.equal(quick.disabled, false)
      await act(() => quick.click()); await settle()
      assert.ok(view.button(`视频生成模式：${label}`))
      assert.equal(view.images().length, imageCount)
      assert.match(view.prompt().value, /用户运镜：镜头缓缓后退/)
      await view.preview()
      const quickRequest = api.previews.at(-1)!
      assert.equal(quickRequest.mode, mode)
      assert.equal(quickRequest.visual_reference_mode, 'keyframe')
      assert.deepEqual(quickRequest.reference_asset_ids, imageCount === 1 ? ['storyboard'] : ['manual', 'storyboard'])
      await view.selectMode('多图参考')
      await view.selectMode(label)
      await view.preview()
      assert.deepEqual(api.previews.at(-1), quickRequest, 'both entry points produce identical generation previews')
    }
  } finally { await view.destroy() }
})

test('running video nodes lock quick mode actions just like the composer menu', async t => {
  const graph = initialGraph('reference')
  graph.nodes.find(node => node.id === 'video-node')!.job_id = 'running-video'
  const projectDetail = { ...detail, jobs: [{ id: 'running-video', status: 'running' } as ProjectDetail['jobs'][number]] }
  const api = mockApi(t, graph), view = await mount(projectDetail)
  try {
    assert.equal(view.button('视频生成模式：多图参考').disabled, true)
    await act(() => view.container.querySelector<HTMLElement>('[data-id="storyboard-node"]')!.click()); await settle()
    const video = view.container.querySelector<HTMLElement>('[data-id="video-node"]')!
    const quick = [...video.querySelectorAll<HTMLButtonElement>('.pc-node-try-action')]
    assert.deepEqual(quick.map(button => button.textContent), ['多图参考', '首帧承接', '首尾帧'])
    assert.ok(quick.every(button => button.disabled))
    await act(() => quick[0].click()); await settle()
    await act(() => video.click()); await settle()
    assert.ok(view.button('视频生成模式：多图参考'))
    assert.equal(api.previews.length, 0)
  } finally { await view.destroy() }
})

test('switching the actual composer to strict first-frame ignores dormant unconfirmed and old-style profile inputs without deleting them', async t => {
  const graph = initialGraph('reference')
  graph.nodes.push(
    { ...node('hero-node', 'generation', 900, 'hero-board'), title: '林晚设定', settings: { modality: 'image', visual_profile_id: hero.id } },
    { ...node('station-node', 'generation', 1300, 'station-board'), title: '站台设定', settings: { modality: 'image', visual_profile_id: station.id } },
  )
  graph.edges.push({ id: 'hero-edge', source: 'hero-node', target: 'video-node' }, { id: 'station-edge', source: 'station-node', target: 'video-node' })
  const unconfirmedHero = { ...hero, board_asset_id: null }
  const oldStation = { ...station, board_style_status: 'needs_review' as const, board_style_version: 'old-style' }
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: [unconfirmedHero, oldStation],
    shot_visual_bindings: [bind(unconfirmedHero, true), bind(oldStation, false)],
    project_visual_style: { version: 'new-style', label: '日漫', source: 'settings', details: {} } as ProjectDetail['project_visual_style'],
  }
  const api = mockApi(t, graph), view = await mount(projectDetail)
  try {
    assert.match(view.container.querySelector('[aria-label="待补齐参考图"]')?.textContent || '', /待补齐参考图 · 2/)
    await view.editPrompt(`${view.prompt().value}\n手工要求：林晚先停顿，再缓慢回头。`)
    await view.selectMode('首帧承接')
    assert.equal(view.container.querySelector('[aria-label="待补齐参考图"]'), null)
    assert.deepEqual(view.images(), ['图片1'])
    await view.preview()
    assert.equal(api.previews.length, 1, 'unused profile connections must not block preview')
    assert.equal(api.previews[0].mode, 'first_frame')
    assert.equal(api.previews[0].visual_reference_mode, 'keyframe')
    assert.deepEqual(api.previews[0].reference_asset_ids, ['storyboard'])
    assert.match(api.previews[0].prompt, /手工要求：林晚先停顿，再缓慢回头/)
    await view.selectMode('多图参考')
    assert.match(view.container.querySelector('[aria-label="待补齐参考图"]')?.textContent || '', /待补齐参考图 · 2/,
      'restoring multi-reference restores required preparation for the retained profile inputs')
  } finally { await view.destroy() }
})


test('per-image uses persist through node changes, mode changes and reload and match preview', async t => {
  const graph = initialGraph('reference', true), api = mockApi(t, graph)
  let view = await mount()
  const choose = async (index: number, usage: string) => {
    const select = view.container.querySelector<HTMLInputElement>(`input[aria-label="图片${index}的用途"]`)!
    assert.ok(select)
    await chooseCombobox(select, videoReferenceUsageLabels[usage as VideoReferenceUsage]); await settle()
  }
  try {
    await view.editPrompt(`${view.prompt().value}\n开场无人抱起林晚，结尾才抱起。固定机位。`)
    await choose(1, 'ending'); await choose(2, 'scale')
    assert.match(view.prompt().value, /图片1：分镜构图.*结尾构图/)
    assert.match(view.prompt().value, /图片2：手动参考.*只参考.*相对大小/)
    assert.match(view.prompt().value, /开场无人抱起林晚，结尾才抱起/)
    await view.preview()
    const expected = [{ asset_id: 'storyboard', usage: 'ending' }, { asset_id: 'manual', usage: 'scale' }]
    assert.deepEqual(api.previews.at(-1)!.video_reference_usages, expected)
    assert.match(document.querySelector('.pc-generation-info-content')!.textContent!, /结尾构图/)
    await view.selectMode('首帧承接')
    assert.equal(view.container.querySelectorAll('.pc-video-reference-usage').length, 0)
    await view.preview()
    assert.deepEqual(api.previews.at(-1)!.video_reference_usages, [])
    await view.selectMode('多图参考')
    assert.equal(view.container.querySelector<HTMLSelectElement>('[aria-label="图片1的用途"]')!.value, '结尾构图')
    // Switch away and back without unmounting the project.
    await act(() => view.container.querySelector<HTMLElement>('[data-id="storyboard-node"]')!.click()); await settle()
    await act(() => view.container.querySelector<HTMLElement>('[data-id="video-node"]')!.click()); await settle()
    assert.equal(view.container.querySelector<HTMLSelectElement>('[aria-label="图片2的用途"]')!.value, '比例尺度')
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const last = api.saved.at(-1)!
    assert.ok(last)
    assert.deepEqual(last.nodes.find(node => node.id === 'video-node')!.settings.video_reference_usages, expected)
    Object.assign(graph, last)
    await view.destroy(); view = await mount()
    assert.equal(view.container.querySelector<HTMLSelectElement>('[aria-label="图片1的用途"]')!.value, '结尾构图')
    assert.match(view.prompt().value, /固定机位/)
    await act(() => view.button('移除手动参考：分镜构图').click()); await settle()
    assert.equal(view.container.querySelector<HTMLSelectElement>('[aria-label="图片1的用途"]')!.value, '比例尺度')
    await view.preview()
    assert.deepEqual(api.previews.at(-1)!.reference_asset_ids, ['manual', 'hero-board', 'station-board'])
    assert.equal(api.previews.at(-1)!.storyboard_reference_asset_id, null)
    assert.deepEqual(api.previews.at(-1)!.video_reference_usages, [{ asset_id: 'manual', usage: 'scale' }])
  } finally { await view.destroy() }
})

const imageModel: Model = { ...videoModel, id: 'image-model', name: '图片模型', modality: 'image', protocol: 'sync_image',
  settings: { supported_modes: ['text', 'reference'], ratios: ['9:16', '16:9'], resolutions: ['1K', '2K', '4K'],
    request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}', resolution: '{{resolution}}',
      clarity: '{{clarity}}', quality: '{{quality}}', background: '{{background}}' } } }
const alternateImageModel = { ...imageModel, id: 'alternate-image-model', name: '备用图片模型' }

test('switching a legacy composer from video to image preserves optional reference exclusions and the authored body', async t => {
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  // Older generators derive their modality from the selected model until their
  // first explicit model change. Exercise that supported selection path.
  delete target.settings.modality
  const body = '林晚在立柱旁停步，保持近景和克制的眼神。'
  target.text = body
  target.settings = { ...target.settings, prompt_is_final: true, prompt_body: body, prompt_base: body, prompt_template: '' }
  const api = mockApi(t, graph)
  const view = await mount(detail, true, { models: [videoModel, imageModel] })
  const systemTokens = () => getManagedPromptBlocks(promptEditorText(view.prompt().editor.getJSON())).join('\n\n')
  try {
    await act(() => view.button('排除可选参考：站台 · 夜间').click()); await settle()
    assert.equal(view.bodyPrompt(), body)
    assert.doesNotMatch(systemTokens(), /\[\[ref:station-board\]\]/)
    const select = view.container.querySelector<HTMLInputElement>('input[aria-label="生成模型"]')!
    assert.ok(select)
    await chooseCombobox(select, imageModel.name); await settle()
    assert.equal(view.bodyPrompt(), body, 'changing the output model cannot rewrite the creator body')
    assert.match(view.systemPrompt(), /空旷地下站台/, 'excluded images do not erase the saved scene definition')
    assert.doesNotMatch(systemTokens(), /\[\[ref:station-board\]\]/)
    assert.match(systemTokens(), /\[\[ref:hero-board\]\]/)
    assert.equal((view.systemPrompt().match(/【图片参考图用途】/g) || []).length, 1)
    await view.preview()
    const request = api.resolvedPreviews.at(-1)!
    assert.ok(request)
    assert.deepEqual(request.excluded_visual_profile_ids, ['station'])
    assert.deepEqual(new Set(request.reference_asset_ids), new Set(['storyboard', 'hero-board']))
    assert.match(request.prompt, /空旷地下站台/)
    assert.match(request.prompt, /保持近景和克制的眼神/)
    assert.doesNotMatch(request.prompt, /参考图\s*3.*站台|\[\[ref:station-board\]\]/)
    const rows = [...document.querySelectorAll<HTMLImageElement>('.pc-generation-info-content .pc-visual-thumbnails img')].map(image => image.getAttribute('src'))
    assert.deepEqual(rows, ['/api/assets/storyboard/file', '/api/assets/hero-board/file'])
  } finally { await view.destroy() }
})

test('a custom image body without mentions keeps only the eight effective images from eleven bindings through reference and parameter changes', async t => {
  const props = Array.from({ length: 5 }, (_, index) => ({ ...hero, id: `prop-${index}`, kind: 'prop' as const,
    name: `道具${index + 1}`, variant: '常态', definition: `道具${index + 1}的固定结构`, board_asset_id: `prop-board-${index}` }))
  const videoOnly = Array.from({ length: 4 }, (_, index) => ({ ...hero, id: `video-only-${index}`, name: `视频专用${index + 1}`,
    board_asset_id: `video-only-board-${index}` }))
  const profiles = [hero, station, ...props, ...videoOnly]
  const projectDetail: ProjectDetail = { ...detail,
    project_visual_style: { version: 'anime', source: 'settings', label: '水彩动画', details: { rendering: '水彩笔触' } },
    visual_profiles: profiles,
    shot_visual_bindings: profiles.map(profile => ({ ...bind(profile, false), usage: videoOnly.includes(profile) ? 'video' : 'image' })),
    assets: [...detail.assets, ...[...props, ...videoOnly].map(profile => ({ ...detail.assets[0], id: profile.board_asset_id!, shot_id: null,
      filename: `${profile.board_asset_id}.png`, url: `/api/assets/${profile.board_asset_id}/file` }))],
  }
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  const body = '林晚在站台边停步，人物居右，留出左侧空白；镜头保持低机位。'
  target.model_id = imageModel.id; target.text = body
  target.settings = { ...target.settings, modality: 'image', mode: 'reference', resolution: '1K', ratio: '9:16',
    prompt_is_final: true, prompt_base: '林晚在站台回头。', prompt_template: '', prompt_body: body }
  const api = mockApi(t, graph, projectDetail)
  let view = await mount(projectDetail, true, { models: [imageModel] })
  const systemIds = () => {
    const system = getManagedPromptBlocks(promptEditorText(view.prompt().editor.getJSON())).join('\n\n')
    assert.ok(system, 'bounded system reference mapping is visible in the complete editable prompt')
    return new Set([...system.matchAll(/\[\[ref:([^\]]+)\]\]/g)].map(match => match[1]))
  }
  try {
    assert.equal(view.bodyPrompt(), body)
    assert.doesNotMatch(view.bodyPrompt(), /\[\[ref:|参考图\s*\d|【镜头视觉设定】/)
    assert.match(view.container.querySelector('.pc-visual-context')!.textContent!, /本镜头关联 11 份/)
    assert.deepEqual(systemIds(), new Set(['storyboard', 'hero-board', 'station-board', ...props.map(profile => profile.board_asset_id!)]))
    assert.doesNotMatch(view.systemPrompt(), /视频专用/)
    assert.match(view.systemPrompt(), /水彩动画|水彩笔触/)
    const revisedBody = `${body}\n保留我新增的手部动作，不增加新角色。`
    await view.editBody(revisedBody)
    assert.equal(view.bodyPrompt(), revisedBody)
    assert.equal(systemIds().size, 8, 'editing prose cannot disconnect its independent image references')

    await act(() => view.button('编辑图片引用：站台 · 夜间').click()); await settle()
    await act(() => document.querySelector<HTMLButtonElement>('.pc-prompt-reference-menu .pc-prompt-reference-add')!.click()); await settle()
    const replacement = document.querySelector<HTMLImageElement>('.pc-prompt-reference-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')!
    assert.ok(replacement)
    await act(() => replacement.click()); await settle()
    assert.ok(systemIds().has('manual'))
    assert.ok(!systemIds().has('station-board'))
    assert.equal(systemIds().size, 8)
    assert.equal(view.bodyPrompt(), revisedBody)

    const parameterTrigger = view.container.querySelector<HTMLButtonElement>('.pc-generation-parameters-trigger')!
    await act(() => parameterTrigger.click()); await settle()
    const ratio = document.querySelector<HTMLButtonElement>('[role="dialog"][aria-label="生成参数"] button[title="16:9"]')!
    assert.ok(ratio)
    await act(() => ratio.click()); await settle()
    assert.equal(view.bodyPrompt(), revisedBody)
    assert.match(view.systemPrompt(), /16:9/)
    await act(() => parameterTrigger.click()); await settle()
    await view.preview()
    const request = api.resolvedPreviews.at(-1)!
    assert.deepEqual(new Set(request.reference_asset_ids), systemIds())
    assert.match(request.prompt, /保留我新增的手部动作/)
    assert.match(request.prompt, /16:9/)
    assert.equal((request.prompt.match(/【图片参考图用途】/g) || []).length, 1)
    assert.equal((request.prompt.match(/【项目画风约束】/g) || []).length, 1)

    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    assert.equal(saved.nodes.find(node => node.id === target.id)!.settings.prompt_body, revisedBody)
    assert.equal(saved.nodes.find(node => node.id === target.id)!.settings.prompt_reference_overrides!['station-board'], 'manual')
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(projectDetail, true, { models: [imageModel] })
    assert.equal(view.bodyPrompt(), revisedBody)
    assert.equal(systemIds().size, 8)
    assert.ok(systemIds().has('manual'))
    assert.ok(!systemIds().has('station-board'))
    assert.match(view.systemPrompt(), /16:9/)
  } finally { await view.destroy() }
})

test('refining a complete prompt preserves its bounded settings and keeps one editable result for application and the next refinement', async t => {
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  const originalBody = '林晚倚着站台立柱，近景，保持右侧留白。'
  target.model_id = imageModel.id; target.text = originalBody
  target.settings = { ...target.settings, modality: 'image', mode: 'reference', resolution: '1K',
    prompt_is_final: true, prompt_base: originalBody, prompt_template: '', prompt_body: originalBody }
  const textModel: Model = { ...videoModel, id: 'text-model', name: '整理模型', modality: 'text', protocol: 'chat_completions', settings: {} }
  const requests: Array<Record<string, unknown>> = []
  const refinedBody = '林晚倚着立柱，近景突出神情，背景保持简洁；右侧留白。'
  const api = mockApi(t, graph, detail, (path, method, request) => {
    if (!path.endsWith('/skills/refine-prompt')) return
    assert.equal(method, 'POST')
    requests.push(request)
    return Response.json({ prompt_body: refinedBody,
      prompt: `${refinedBody}\n\n${getManagedPromptBlocks(String(request.prompt)).join('\n\n')}`, skills: [] })
  })
  const view = await mount(detail, true, { models: [imageModel, textModel] })
  const modalButton = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>('.prompt-skill-modal button')].find(button => button.textContent === label)
    assert.ok(element, label); return element
  }
  try {
    await act(() => view.button('使用技能整理提示词').click()); await settle()
    await act(() => modalButton('整理提示词').click()); await settle()
    assert.equal(requests[0]?.prompt_body, originalBody)
    assert.equal(requests[0]?.prompt_document, true)
    assert.match(String(requests[0]?.prompt), /【镜头视觉设定】/)
    assert.match(String(requests[0]?.prompt), /【图片参考图用途】/)
    assert.equal(view.bodyPrompt(), originalBody, 'refinement has no effect before explicit application')
    const result = document.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('[contenteditable][aria-label="整理后的完整提示词"]')!
    assert.ok(result)
    assert.equal(result.editor.isEditable, true)
    assert.match(promptEditorText(result.editor.getJSON()), /近景突出神情/)
    assert.match(promptEditorText(result.editor.getJSON()), /【图片参考图用途】/)
    assert.equal(document.querySelector('textarea[aria-label="整理后的正文"]'), null)
    assert.equal(document.querySelector('textarea[aria-label="整理后的完整提示词预览"]'), null)
    await act(() => modalButton('应用提示词').click()); await settle()
    assert.equal(view.bodyPrompt(), refinedBody)
    assert.doesNotMatch(view.bodyPrompt(), /参考图\s*\d|\[\[ref:/)
    assert.match(view.systemPrompt(), /图片参考图用途/)
    assert.match(view.systemPrompt(), /林晚|站台/)
    await view.preview()
    assert.deepEqual(new Set(api.resolvedPreviews.at(-1)!.reference_asset_ids), new Set(['storyboard', 'hero-board', 'station-board']))
    assert.match(api.resolvedPreviews.at(-1)!.prompt, /近景突出神情/)
    await act(() => view.button('使用技能整理提示词').click()); await settle()
    await act(() => modalButton('整理提示词').click()); await settle()
    assert.equal(requests[1]?.prompt_document, true)
    assert.match(String(requests[1]?.prompt), /近景突出神情/)
    assert.match(String(requests[1]?.prompt), /【镜头视觉设定】/)
    assert.equal(requests[1]?.prompt_body, refinedBody)
    assert.doesNotMatch(String(requests[1]?.prompt_body), /镜头视觉设定|图片参考图用途/)
  } finally { await view.destroy() }
})

test('the single complete prompt preserves a hand-edited visual block and a manual @ input through preview, save and reload', async t => {
  const graph = initialGraph('reference'), target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = imageModel.id
  target.settings = { ...target.settings, modality: 'image', mode: 'reference', ratio: '9:16', resolution: '1K' }
  const api = mockApi(t, graph)
  let view = await mount(detail, true, { models: [imageModel] })
  const customLine = '手工设定：站台边缘保留排水槽，材质参考'
  const assertDocument = () => {
    const text = promptEditorText(view.prompt().editor.getJSON())
    const block = getManagedPromptBlocks(text, ['镜头视觉设定'])[0]
    assert.ok(block)
    assert.match(block, /手工设定：站台边缘保留排水槽，材质参考\[\[ref:manual\]\]/)
    assert.equal((text.match(/【镜头视觉设定】/g) || []).length, 1)
    assert.equal(view.container.querySelectorAll('.pc-prompt-composer .pc-prompt-editor-content').length, 1)
    assert.equal(view.container.querySelector('[aria-label="系统设定与参考"]'), null)
    assert.equal(view.prompt().editor.isEditable, true)
    return text
  }
  try {
    await view.editPrompt(promptEditorText(view.prompt().editor.getJSON()).replace('【镜头视觉设定结束】', `${customLine}\n【镜头视觉设定结束】`))
    const editor = view.prompt().editor
    let position = -1
    editor.state.doc.descendants((node, offset) => {
      if (node.isText && node.text === customLine) position = offset + node.nodeSize
    })
    assert.ok(position >= 0)
    await act(() => editor.chain().setTextSelection(position).insertContent('@').run()); await settle()
    const picker = document.querySelector('.pc-prompt-mention-menu')!
    assert.ok(picker)
    await act(() => picker.querySelector<HTMLButtonElement>('.pc-prompt-reference-add')!.click()); await settle()
    const manual = document.querySelector<HTMLImageElement>('.pc-prompt-mention-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')
    assert.ok(manual)
    await act(() => manual.click()); await settle()
    assertDocument()
    await view.preview()
    const preview = api.previews.at(-1)! as PreviewInput & { prompt_document?: boolean; prompt_body?: string }
    assert.ok(preview)
    assert.equal(preview.prompt_document, true)
    assert.match(preview.prompt, /手工设定：站台边缘保留排水槽/)
    assert.doesNotMatch(preview.prompt_body || '', /手工设定：|【镜头视觉设定】/)
    assert.deepEqual(new Set(api.resolvedPreviews.at(-1)!.reference_asset_ids), new Set(['storyboard', 'hero-board', 'station-board', 'manual']))
    const resolved = api.resolvedPreviews.at(-1)!
    assert.match(resolved.prompt, new RegExp(`材质参考图片 ${resolved.reference_asset_ids.indexOf('manual') + 1}`))
    assertDocument()
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    const settings = saved.nodes.find(node => node.id === 'video-node')!.settings
    assert.equal(settings.prompt_document, true)
    assert.doesNotMatch(settings.prompt_body || '', /手工设定：/)
    assert.equal(saved.edges.filter(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual').length, 1)
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(detail, true, { models: [imageModel] })
    assertDocument()
    await view.preview()
    assert.match(api.resolvedPreviews.at(-1)!.prompt, /手工设定：站台边缘保留排水槽/)
  } finally { await view.destroy() }
})

for (const model of [imageModel, videoModel]) test(`${model.modality} shot reference count matches the drawer while keeping usage, pending and stale bindings`, async t => {
  const usages = ['both', 'image', 'image', 'image', 'image', 'video', 'video', 'none'] as const
  const profiles = usages.map((_, index) => index === 0 ? hero : index === 1 ? station
    : { ...hero, id: `extra-${index}`, name: `其他设定${index}`, board_asset_id: null })
  const bindings = profiles.map((profile, index) => ({ ...bind(profile, false), usage: usages[index] }))
  const projectDetail = { ...detail, visual_profiles: [{ ...hero, revision: hero.revision + 1 }, ...profiles.slice(1)], shot_visual_bindings: bindings }
  const graph = initialGraph('reference')
  const target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = model.id
  target.settings = { ...target.settings, modality: model.modality, mode: model.modality === 'image' ? 'text' : 'reference' }
  const api = mockApi(t, graph, projectDetail)
  const view = await mount(projectDetail, true, { models: [model] })
  const originalBindings = JSON.stringify(projectDetail.shot_visual_bindings)
  try {
    const trigger = document.querySelector<HTMLButtonElement>('.pc-visual-context-button')!
    assert.match(trigger.textContent!, model.modality === 'image' ? /镜头引用 · 5/ : /镜头引用 · 3/)
    assert.match(view.container.querySelector('.pc-visual-context')!.textContent!, /本镜头关联 8 份/)
    const writes = api.saved.length
    await act(() => trigger.click()); await settle()
    const drawer = document.querySelector('#pc-composer-bindings')!
    const selected = [...drawer.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.startsWith(model.modality === 'image' ? '当前图片使用' : '当前视频使用'))!
    assert.match(selected.textContent!, model.modality === 'image' ? /当前图片使用\s*5/ : /当前视频使用\s*3/)
    const checks = [...drawer.querySelectorAll<HTMLInputElement>('.pc-binding-row-identity input[type="checkbox"]')]
    assert.equal(checks.length, model.modality === 'image' ? 5 : 3)
    assert.ok(checks.every(checkbox => checkbox.checked), 'only current scope profiles are checked')
    assert.match(drawer.textContent!, /引用待更新/)
    assert.match(drawer.textContent!, /参考图待确认/)
    assert.equal(JSON.stringify(projectDetail.shot_visual_bindings), originalBindings)
    assert.equal(api.saved.length, writes, 'viewing counts must not rewrite the canvas')
    assert.equal(api.previews.length, 0, 'counting must not prepare a generation request')
  } finally { await view.destroy() }
})

for (const model of [imageModel, videoModel]) test(`${model.modality} body deletions remain literal while system settings survive selection, preview and saved reload`, async t => {
  const style: ProjectDetail['project_visual_style'] = { version: 'anime', label: '日漫', source: 'settings', details: {} }
  const projectDetail: ProjectDetail = { ...detail, project_visual_style: style }
  const graph = initialGraph('reference')
  const target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = model.id; target.settings.modality = model.modality
  const api = mockApi(t, graph, projectDetail)
  let view = await mount(projectDetail, false, { models: [model] })
  try {
    const original = view.bodyPrompt(), system = view.systemPrompt()
    assert.match(system, /【项目画风约束结束】$/)
    assert.doesNotMatch(original, /【镜头视觉设定】|【项目画风约束】|【视频参考图用途】|【图片参考图用途】/)
    assert.equal(view.container.querySelector('[aria-label="系统设定与参考"][contenteditable]'), null)
    assert.equal(view.container.querySelectorAll('.pc-prompt-composer .pc-prompt-editor-content').length, 1)
    assert.equal(view.prompt().editor.isEditable, true)
    let edited = original
    for (let index = 0; index < 4; index++) {
      edited = edited.slice(0, -1)
      await view.editBody(edited)
      assert.equal(view.bodyPrompt(), edited, 'backspace must not restore deleted body text')
      assert.equal(view.systemPrompt(), system, 'editing body text does not duplicate or overwrite the bounded settings in the same editor')
    }
    await view.editBody('只保留手工动作：先停顿，再缓慢回头。\n')
    await act(() => view.container.querySelector<HTMLElement>('[data-id="storyboard-node"]')!.click()); await settle()
    await act(() => view.container.querySelector<HTMLElement>('[data-id="video-node"]')!.click()); await settle()
    assert.equal(view.bodyPrompt(), '只保留手工动作：先停顿，再缓慢回头。\n')
    if (model.modality === 'video') await view.selectMode('文生视频')
    await view.preview()
    const request = api.previews.at(-1)!
    assert.ok(request, `preview rejected current ${model.modality} body: ${view.container.textContent?.slice(-1600)}`)
    assert.match(request.prompt, /只保留手工动作/)
    assert.equal(request.prompt.split('【项目画风约束】').length - 1, 1, 'generation still carries the project style')
    if (model.modality === 'video') { assert.equal(request.reference_asset_ids.length, 0); assert.equal(request.prompt.split('【视频参考图用途】').length - 1, 0) }
    assert.equal(view.bodyPrompt(), '只保留手工动作：先停顿，再缓慢回头。\n', 'preview must not rewrite the editor')
    await view.editPrompt('')
    assert.equal(view.bodyPrompt(), '')
    assert.equal(view.button('开始生成').disabled, true)
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    assert.equal(saved.nodes.find(node => node.id === 'video-node')!.settings.prompt_body, '')
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(projectDetail, false, { models: [model] })
    assert.equal(view.bodyPrompt(), '', 'saved empty draft must not restore defaults')
    assert.equal(view.button('开始生成').disabled, true)
  } finally { await view.destroy() }
})

test('information-board prompt can be cleared and its empty override survives saved reload', async t => {
  const style: ProjectDetail['project_visual_style'] = { version: 'anime', label: '日漫', source: 'settings', details: {} }
  const projectDetail: ProjectDetail = { ...detail, project_visual_style: style,
    visual_profiles: [{ ...hero, board_prompt: withProjectStyle('人物信息图', style) }, station] }
  const graph = initialGraph('reference')
  const target = graph.nodes.find(node => node.id === 'video-node')!
  target.model_id = imageModel.id; target.shot_id = null
  target.settings = { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: hero.revision }
  const api = mockApi(t, graph, projectDetail)
  let view = await mount(projectDetail, false, { models: [imageModel] })
  try {
    const partial = view.bodyPrompt().slice(0, -1), system = view.systemPrompt()
    await view.editBody(partial)
    assert.equal(view.bodyPrompt(), partial)
    assert.equal(view.systemPrompt(), system, 'profile view requirements and identity references remain managed')
    await view.editPrompt('')
    assert.equal(view.bodyPrompt(), '')
    assert.equal(view.button('开始生成').disabled, true)
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    assert.equal(saved.nodes.find(node => node.id === 'video-node')!.settings.profile_prompt_override, '')
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(projectDetail, false, { models: [imageModel] })
    assert.equal(view.bodyPrompt(), '')
  } finally { await view.destroy() }
})

test('reference chips replace and remove actual node inputs, and persist overrides through a saved reload', async t => {
  const graph = initialGraph('reference'), api = mockApi(t, graph)
  let view = await mount(detail, true)
  try {
    await act(() => view.button('编辑图片引用：林晚 · 校服').click()); await settle()
    assert.ok(!document.querySelector('.pc-prompt-reference-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]'), 'unconnected project images are outside the default replacement list')
    await act(() => document.querySelector<HTMLButtonElement>('.pc-prompt-reference-menu .pc-prompt-reference-add')!.click()); await settle()
    const replacement = document.querySelector<HTMLImageElement>('.pc-prompt-reference-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')!
    assert.ok(replacement)
    await act(() => replacement.click()); await settle()
    assert.match(view.prompt().textContent!, /manual.png/)
    const urls = [...document.querySelectorAll<HTMLImageElement>('.pc-video-reference-preview img')].map(image => image.getAttribute('src'))
    assert.ok(urls.includes('/api/assets/manual/file'))
    assert.ok(!urls.includes('/api/assets/hero-board/file'))
    await view.preview()
    assert.equal((api.previews.at(-1) as any).prompt_reference_overrides['hero-board'], 'manual')
    assert.ok(api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'))
    assert.ok(!api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('hero-board'))
    await act(() => view.button('编辑图片引用：站台 · 夜间').click()); await settle()
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.pc-prompt-reference-remove')][0]!
    await act(() => remove.click()); await settle()
    await view.preview()
    assert.equal((api.previews.at(-1) as any).prompt_reference_overrides['station-board'], null)
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    const settings = saved.nodes.find(node => node.id === 'video-node')!.settings
    assert.equal(settings.prompt_reference_overrides!['hero-board'], 'manual')
    assert.equal(settings.prompt_reference_overrides!['station-board'], null)
    const manualEdge = saved.edges.find(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual')
    assert.ok(manualEdge, 'replacing a binding with another image establishes a pinned canvas reference')
    assert.equal(saved.nodes.find(node => node.id === manualEdge.source)?.asset_id, 'manual')
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(detail, true)
    assert.match(view.prompt().textContent!, /manual.png/)
    assert.ok(![...document.querySelectorAll<HTMLImageElement>('.pc-video-reference-preview img')].some(image => image.getAttribute('src') === '/api/assets/station-board/file'))
  } finally { await view.destroy() }
})

test('mention choices list current references and adding another project image creates one pinned connection used by preview', async t => {
  const graph = initialGraph('reference'), api = mockApi(t, graph)
  const view = await mount(detail, true)
  try {
    await view.openMention()
    const menu = document.querySelector('.pc-prompt-mention-menu')!
    assert.ok(menu)
    const active = [...menu.querySelectorAll<HTMLImageElement>('.pc-prompt-reference-option img')].map(image => image.getAttribute('src'))
    assert.deepEqual(new Set(active), new Set(['/api/assets/storyboard/file', '/api/assets/hero-board/file', '/api/assets/station-board/file']))
    assert.ok(!active.includes('/api/assets/manual/file'))
    await act(() => menu.querySelector<HTMLButtonElement>('.pc-prompt-reference-add')!.click()); await settle()
    const manual = document.querySelector<HTMLImageElement>('.pc-prompt-mention-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')
    assert.ok(manual)
    await act(() => manual.click()); await settle()
    assert.match(promptEditorText(view.prompt().editor.getJSON()), /\[\[ref:manual\]\]/)
    await view.preview()
    assert.ok(api.previews.at(-1)!.reference_asset_ids.includes('manual'))
    assert.ok(api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'))
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    const edges = saved.edges.filter(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual')
    assert.equal(edges.length, 1)
    assert.equal(saved.nodes.find(node => node.id === edges[0].source)?.asset_id, 'manual')
    assert.equal(new Set(api.resolvedPreviews.at(-1)!.reference_asset_ids).size, api.resolvedPreviews.at(-1)!.reference_asset_ids.length)
  } finally { await view.destroy() }
})

test('a pinned upstream reference survives project asset reordering and a newly completed source candidate', async t => {
  const graph = initialGraph('reference', true)
  const source = graph.nodes.find(node => node.id === 'manual-node')!
  source.type = 'generation'; source.model_id = imageModel.id; source.job_id = 'upstream-candidate'; source.settings = { modality: 'image' }
  const pending = { id: 'upstream-candidate', status: 'running', created_at: timestamp, request: '{}' } as ProjectDetail['jobs'][number]
  const projectDetail = { ...detail, jobs: [pending] }
  const api = mockApi(t, graph, projectDetail), view = await mount(projectDetail, true, { models: [videoModel, imageModel] })
  try {
    await view.editPrompt('人物参考[[ref:manual]]，保持短发和蓝色服装。')
    const candidate = { ...detail.assets[0], id: 'manual-new', shot_id: null, filename: 'manual-new.png', url: '/api/assets/manual-new/file' }
    await view.renderDetail({ ...projectDetail, assets: [candidate, ...[...projectDetail.assets].reverse()],
      jobs: [{ ...pending, status: 'succeeded', result_asset_id: candidate.id }] })
    assert.match(promptEditorText(view.prompt().editor.getJSON()), /\[\[ref:manual\]\]/)
    assert.doesNotMatch(promptEditorText(view.prompt().editor.getJSON()), /\[\[ref:manual-new\]\]/)
    await view.preview()
    assert.ok(api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'))
    assert.ok(!api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual-new'))
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    assert.equal(saved.nodes.find(node => node.id === source.id)!.asset_id, 'manual-new', 'the upstream node can display its new result')
    assert.equal(saved.edges.find(edge => edge.id === 'manual-edge')!.reference_asset_id, 'manual', 'the downstream identity stays frozen to the selected image')
  } finally { await view.destroy() }
})

test('a saved prompt with a disconnected reference blocks preview until its exact image is reconnected', async t => {
  const graph = initialGraph('reference', true)
  graph.edges = graph.edges.filter(edge => edge.id !== 'manual-edge')
  const target = graph.nodes.find(node => node.id === 'video-node')!
  target.text = '人物来自[[ref:manual]]，保持短发。'
  target.settings = { ...target.settings, prompt_is_final: true, prompt_base: '', prompt_template: '' }
  const api = mockApi(t, graph), view = await mount(detail, true)
  try {
    const invalid = document.querySelector<HTMLElement>('.pc-prompt-reference.is-invalid')
    assert.ok(invalid, 'a stale mention remains visible as invalid instead of silently adding its image')
    await view.preview()
    assert.equal(api.previews.length, 0, 'invalid mention must stop before the preview API')
    await act(() => invalid.click()); await settle()
    const reconnect = document.querySelector<HTMLButtonElement>('.pc-prompt-reference-reconnect')
    assert.ok(reconnect)
    await act(() => reconnect.click()); await settle()
    assert.equal(document.querySelector('.pc-prompt-reference.is-invalid'), null)
    await view.preview()
    assert.ok(api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'))
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    assert.equal(api.saved.at(-1)!.edges.filter(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual').length, 1)
    assert.equal(api.saved.at(-1)!.nodes.filter(node => node.asset_id === 'manual').length, 1, 'repair reuses the existing image node')
  } finally { await view.destroy() }
})

test('disconnecting a replacement edge invalidates its mention and cannot resurrect it through an automatic binding override', async t => {
  const graph = initialGraph('reference')
  const api = mockApi(t, graph), view = await mount(detail, true)
  try {
    await act(() => view.button('编辑图片引用：林晚 · 校服').click()); await settle()
    await act(() => document.querySelector<HTMLButtonElement>('.pc-prompt-reference-menu .pc-prompt-reference-add')!.click()); await settle()
    const replacement = document.querySelector<HTMLImageElement>('.pc-prompt-reference-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')
    assert.ok(replacement)
    await act(() => replacement.click()); await settle()
    await view.editPrompt(`${promptEditorText(view.prompt().editor.getJSON())}\n动作保持参考[[ref:manual]]。`)
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const edge = api.saved.at(-1)!.edges.find(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual')
    assert.ok(edge)
    const connection = view.container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${edge.id}"]`)
    assert.ok(connection, 'replacement has a visible canvas connection')
    await act(() => connection.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); await settle()
    await act(() => view.container.querySelector('.project-canvas')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))); await settle()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.app-dialog-actions button')].find(button => button.textContent === '移除')
    assert.ok(confirm)
    await act(() => confirm.click()); await settle()
    await act(() => view.container.querySelector<HTMLElement>('[data-id="video-node"]')!.click()); await settle()
    assert.ok(document.querySelector('.pc-prompt-reference.is-invalid'), 'the original text remains for user repair after its edge is removed')
    const previous = api.previews.length
    await view.preview()
    assert.equal(api.previews.length, previous, 'a stale replacement mention cannot reach the preview API')
    await view.editPrompt(promptEditorText(view.prompt().editor.getJSON()).replaceAll('[[ref:manual]]', '已移除的旧参考'))
    await view.preview()
    assert.ok(api.resolvedPreviews.at(-1), view.container.textContent || '')
    assert.ok(!api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'), 'old-to-new binding overrides cannot restore the disconnected replacement')
  } finally { await view.destroy() }
})

test('adding an earlier removed reference restores its connection and clears the removal override', async t => {
  const graph = initialGraph('reference', true), api = mockApi(t, graph)
  const view = await mount(detail, true)
  try {
    await view.editPrompt(`${promptEditorText(view.prompt().editor.getJSON())}\n动作参考[[ref:manual]]，保持节奏。`)
    await act(() => view.button('编辑图片引用：manual-node').click()); await settle()
    await act(() => document.querySelector<HTMLButtonElement>('.pc-prompt-reference-menu .pc-prompt-reference-remove')!.click()); await settle()
    await view.preview()
    assert.ok(api.resolvedPreviews.at(-1), view.container.textContent || '')
    assert.ok(!api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'))
    await view.openMention()
    await act(() => document.querySelector<HTMLButtonElement>('.pc-prompt-mention-menu .pc-prompt-reference-add')!.click()); await settle()
    const manual = document.querySelector<HTMLImageElement>('.pc-prompt-mention-menu .pc-prompt-reference-option img[src="/api/assets/manual/file"]')?.closest<HTMLButtonElement>('button')
    assert.ok(manual)
    await act(() => manual.click()); await settle()
    await view.preview()
    assert.ok(api.resolvedPreviews.at(-1)!.reference_asset_ids.includes('manual'), 'reselected image must survive the previous null override')
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    const saved = api.saved.at(-1)!
    assert.notEqual(saved.nodes.find(node => node.id === 'video-node')!.settings.prompt_reference_overrides?.manual, null)
    assert.equal(saved.edges.filter(edge => edge.target === 'video-node' && edge.reference_asset_id === 'manual').length, 1)
    assert.equal(saved.nodes.filter(node => node.asset_id === 'manual').length, 1)
  } finally { await view.destroy() }
})

test('starting from a media node preserves replacement settings and every pinned view in the new generator', async t => {
  const extra = { ...detail.assets[0], id: 'manual-detail', shot_id: null, filename: 'manual-detail.png', url: '/api/assets/manual-detail/file' }
  const projectDetail: ProjectDetail = { ...detail, assets: [...detail.assets, extra] }
  const graph = initialGraph('reference')
  const media = graph.nodes.find(node => node.id === 'video-node')!
  media.type = 'image'; media.asset_id = 'storyboard'
  media.text = '身份参考[[ref:manual]]，局部参考[[ref:manual-detail]]，缓缓回头。'
  media.settings = { ...media.settings, prompt_is_final: true, prompt_base: media.prompt, prompt_template: '',
    prompt_reference_overrides: { 'hero-board': 'manual' }, excluded_visual_profile_ids: ['station'],
    video_reference_usages: [{ asset_id: 'manual', usage: 'identity' }, { asset_id: 'manual-detail', usage: 'detail' }],
    reference_video_url: 'https://example.invalid/reference.mp4' }
  graph.nodes.push(node('multi-view-source', 'image', 900, 'manual'))
  graph.edges.push(
    { id: 'face-pin', source: 'multi-view-source', target: media.id, reference_asset_id: 'manual' },
    { id: 'detail-pin', source: 'multi-view-source', target: media.id, reference_asset_id: 'manual-detail' },
  )
  const enqueued: Record<string, unknown>[] = []
  const api = mockApi(t, graph, projectDetail, (path, method, body) => {
    if (path !== '/api/projects/video-reference-test/generate') return
    assert.equal(method, 'POST')
    enqueued.push(body)
    return Response.json({ id: 'mock-media-job', status: 'queued', created_at: timestamp })
  })
  const view = await mount(projectDetail, true)
  try {
    await act(() => view.button('开始生成').click()); await settle()
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    assert.equal(enqueued.length, 1, view.container.textContent || '')
    const saved = api.saved.at(-1)!
    const generator = saved.nodes.find(node => node.id !== media.id && node.type === 'generation' && node.job_id === 'mock-media-job')
    assert.ok(generator, 'starting from an image creates one dedicated generator')
    assert.deepEqual(generator.settings.prompt_reference_overrides, media.settings.prompt_reference_overrides)
    assert.deepEqual(generator.settings.excluded_visual_profile_ids, ['station'])
    assert.deepEqual(generator.settings.video_reference_usages, media.settings.video_reference_usages)
    assert.equal(generator.settings.storyboard_reference_asset_id, 'storyboard')
    assert.equal(generator.settings.reference_video_url, media.settings.reference_video_url)
    assert.equal(generator.settings.mode, 'reference', 'an explicit multi-reference strategy must not turn into strict first-frame')
    assert.deepEqual(saved.edges.filter(edge => edge.target === generator.id && edge.source === 'multi-view-source').map(edge => edge.reference_asset_id).sort(),
      ['manual', 'manual-detail'])
    assert.ok(saved.edges.some(edge => edge.target === generator.id && edge.source === media.id && edge.reference_asset_id === 'storyboard'))
    const references = enqueued[0].reference_asset_ids as string[]
    assert.ok(references.includes('manual') && references.includes('manual-detail'))
    assert.ok(!references.includes('hero-board'), 'copied bindings cannot restore the overridden old image')
  } finally { await view.destroy() }
})

const withoutBoard = (profile: VisualProfile): VisualProfile => ({ ...profile, board_asset_id: null })
const missingHero = withoutBoard(hero), missingStation = withoutBoard(station)
type BoardRequest = { profileId: string; body: Record<string, unknown> }
function mockBoards(t: TestContext, graph: CanvasGraph, projectDetail: ProjectDetail,
  options: { failPreview?: string; saveError?: boolean; beforeEnqueue?: () => Promise<void> } = {}) {
  const previews: BoardRequest[] = [], generated: BoardRequest[] = []
  const api = mockApi(t, graph, projectDetail, async (path, method, body) => {
    const match = /^\/api\/visual-profiles\/([^/]+)\/(board-preview|generate)$/.exec(path)
    assert.ok(match, `unexpected request ${method} ${path}; target generation and candidate confirmation are forbidden`)
    assert.equal(method, 'POST')
    const profileId = match[1], profile = projectDetail.visual_profiles!.find(profile => profile.id === profileId)!
    assert.ok(profile)
    if (match[2] === 'board-preview') {
      previews.push({ profileId, body })
      if (profileId === options.failPreview) return Response.json({ message: '模型预览暂时不可用' }, { status: 422 })
      return Response.json({ prompt: `${body.prompt_override || profile.definition}\n${body.prompt_append || ''}`,
        mode: (body.reference_asset_ids as string[])?.length || (body.reference_profile_ids as string[])?.length ? 'reference' : 'text',
        reference_asset_ids: body.reference_asset_ids || [], reference_names: [], reference_signature: `signature-${profileId}`,
        project_style_version: 'test-style', project_visual_style: projectDetail.project_visual_style, style_warnings: [] })
    }
    assert.ok(api.saved.length, 'nodes must be persisted before enqueueing')
    assert.equal(api.saved.at(-1)!.nodes.filter(node => node.settings.visual_profile_id === profileId).length, 1)
    generated.push({ profileId, body })
    await options.beforeEnqueue?.()
    const jobs = Array.from({ length: Number(body.candidate_count) }, (_, index) => ({ id: `job-${profileId}-${index}`,
      status: 'queued', created_at: timestamp, request: JSON.stringify({ visual_profile_id: profileId, visual_profile_revision: profile.revision }) }))
    return Response.json({ job: jobs[0], jobs, task: { id: `task-${profileId}`, status: 'generating' } })
  }, options.saveError)
  return { ...api, boardPreviews: previews, generated }
}

test('one click fills only missing references, preserves each board configuration and prevents duplicate submission until refresh', async t => {
  const optional = { ...missingHero, id: 'optional', name: '可选道具' }
  const confirmed = { ...hero, id: 'confirmed', name: '已确认人物' }
  const candidate = { ...missingHero, id: 'candidate', name: '待确认人物', candidate_asset_ids: ['manual'] }
  const queued = { ...missingHero, id: 'queued', name: '排队人物' }
  const running = { ...missingHero, id: 'running', name: '生成人物', asset_task_id: 'running-task' }
  const unrelated = { ...missingHero, id: 'unrelated', name: '别的镜头人物' }
  const profiles = [missingHero, missingStation, optional, confirmed, candidate, queued, running, unrelated]
  const queuedJob = { id: 'already-queued', status: 'queued', created_at: timestamp,
    request: JSON.stringify({ visual_profile_id: queued.id, visual_profile_revision: queued.revision }) } as ProjectDetail['jobs'][number]
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: profiles,
    shot_visual_bindings: [...profiles.filter(profile => profile.id !== unrelated.id).map(profile => bind(profile, profile.id !== optional.id)),
      { ...bind(unrelated, true), shot_id: 'other-shot' }], jobs: [queuedJob],
    asset_tasks: [{ id: 'running-task', status: 'generating' } as ProjectDetail['asset_tasks'][number]] }
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('hero-node', 'generation', 900), model_id: alternateImageModel.id, title: '林晚设定', text: '保持蓝色校服',
    settings: { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: hero.revision,
      ratio: '16:9', resolution: '4K', clarity: '4K', quality: 'high', background: 'transparent', candidate_count: 2,
      profile_prompt_override: '手工设定提示词' } },
    { ...node('notes', 'text', 1200), text: '不要添加装饰品' })
  graph.edges.push({ id: 'hero-input', source: 'hero-node', target: 'video-node' }, { id: 'notes-input', source: 'notes', target: 'hero-node' })
  const originalTarget = structuredClone(graph.nodes.find(node => node.id === 'video-node')!)
  const api = mockBoards(t, graph, projectDetail)
  let refreshes = 0
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel, alternateImageModel], onRefresh: async () => { refreshes++ } })
  try {
    const button = view.button('一键生成所需参考图')
    assert.match(button.textContent!, /· 2/)
    await act(() => { button.click(); button.click() }); await settle()
    assert.deepEqual(api.generated.map(request => request.profileId), ['hero', 'station'])
    assert.equal(refreshes, 1)
    const heroRequest = api.generated[0].body, stationRequest = api.generated[1].body
    assert.equal(heroRequest.model_id, alternateImageModel.id)
    assert.equal(heroRequest.ratio, '16:9'); assert.equal(heroRequest.resolution, '4K')
    assert.equal(heroRequest.clarity, '4K'); assert.equal(heroRequest.quality, 'high')
    assert.equal(heroRequest.background, 'transparent'); assert.equal(heroRequest.candidate_count, 2)
    assert.equal(heroRequest.prompt_override, '手工设定提示词')
    assert.match(String(heroRequest.prompt), /手工设定提示词.*\n不要添加装饰品\n\n保持蓝色校服/)
    assert.equal(heroRequest.expected_revision, hero.revision)
    assert.equal(heroRequest.reference_signature, 'signature-hero'); assert.equal(heroRequest.project_style_version, 'test-style')
    assert.ok(!('shot_id' in heroRequest) && !('mode' in heroRequest), 'strict board API receives only supported fields')
    assert.equal(stationRequest.model_id, imageModel.id); assert.equal(stationRequest.candidate_count, 1)
    assert.equal(stationRequest.ratio, '16:9'); assert.equal(stationRequest.clarity, '4K')
    assert.equal(stationRequest.resolution, '4K'); assert.equal(stationRequest.quality, 'extreme')
    assert.equal(stationRequest.background, 'auto')
    const saved = api.saved.at(-1)!
    assert.deepEqual(saved.nodes.find(node => node.id === 'video-node'), originalTarget)
    assert.equal(saved.nodes.find(node => node.id === 'hero-node')!.job_id, 'job-hero-0')
    assert.equal(saved.nodes.find(node => node.settings.visual_profile_id === station.id)!.job_id, 'job-station-0')
    assert.ok(view.container.querySelector('.react-flow__node[data-id="video-node"].selected'))
    assert.match(view.container.querySelector('[aria-label="待补齐参考图"]')!.textContent!, /已提交 2 份设定图/)
    assert.equal(view.button('一键生成所需参考图').disabled, true)
    await act(() => view.button('一键生成所需参考图').click()); await settle()
    assert.equal(api.generated.length, 2, 'stale project detail must not permit duplicate submission')
    const completed = { ...projectDetail, assets: [...projectDetail.assets, { ...detail.assets[0], id: 'new-hero-board', shot_id: null }],
      jobs: [...projectDetail.jobs, { id: 'job-hero-0', status: 'succeeded', created_at: timestamp, result_asset_id: 'new-hero-board',
        request: JSON.stringify({ visual_profile_id: hero.id, visual_profile_revision: hero.revision }) } as ProjectDetail['jobs'][number],
        { id: 'job-hero-1', status: 'failed', created_at: timestamp } as ProjectDetail['jobs'][number]] }
    await view.renderDetail(completed)
    assert.match(view.button('定位参考设定：林晚 · 校服').textContent!, /去确认/)
    assert.equal(completed.visual_profiles![0].board_asset_id, null, 'generation does not confirm a candidate')
  } finally { await view.destroy() }
})

test('one-click state generation waits for confirmed foundation then resumes exactly once', async t => {
  const base = { ...missingHero, id: 'foundation', name: '基础人物', variant: '日常装' }
  const state = { ...missingHero, id: 'rain-state', name: '雨中人物', variant: '泥水状态', base_profile_id: base.id, state_delta: '衣摆沾泥' }
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: [base, state], shot_visual_bindings: [bind(state, true)] }
  const graph = initialGraph('reference')
  const api = mockBoards(t, graph, projectDetail)
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel] })
  try {
    await act(() => view.button('一键生成所需参考图').click()); await settle()
    assert.deepEqual(api.generated.map(item => item.profileId), [base.id])
    assert.match(view.container.querySelector('.pc-required-reference-result')!.textContent!, /基础图确认/)
    const approved: ProjectDetail = { ...projectDetail, visual_profiles: [{ ...base, revision: 2, board_asset_id: 'manual' }, state] }
    await view.renderDetail(approved)
    assert.deepEqual(api.generated.map(item => item.profileId), [base.id, state.id])
    await view.renderDetail(approved)
    assert.equal(api.generated.length, 2, 'repeat refresh never resubmits an accepted state task')
  } finally { await view.destroy() }
})

test('reference batch isolates unavailable models, unconfirmed dependencies and preview errors while other references enter the queue', async t => {
  const blocked = { ...missingHero, id: 'blocked', name: '依赖未确认人物' }
  const unavailable = { ...missingHero, id: 'unavailable', name: '模型失效人物' }
  const dependency = { ...missingHero, id: 'dependency', name: '待确认前置设定', candidate_asset_ids: ['manual'] }
  const profiles = [missingHero, blocked, unavailable, missingStation, dependency]
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: profiles,
    shot_visual_bindings: profiles.filter(profile => profile.id !== dependency.id).map(profile => bind(profile, true)) }
  const graph = initialGraph('reference')
  for (const profile of [blocked, unavailable, dependency]) graph.nodes.push({ ...node(`${profile.id}-node`, 'generation', 900),
    model_id: profile === unavailable ? 'disabled-model' : imageModel.id,
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision } })
  graph.edges.push({ id: 'blocked-dependency', source: 'dependency-node', target: 'blocked-node' })
  const api = mockBoards(t, graph, projectDetail, { failPreview: hero.id })
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel] })
  try {
    await act(() => view.button('一键生成所需参考图').click()); await settle()
    assert.deepEqual(api.generated.map(request => request.profileId), [station.id])
    assert.deepEqual(api.boardPreviews.map(request => request.profileId), [hero.id, station.id])
    const result = view.container.querySelector('.pc-required-reference-result')!.textContent!
    assert.match(result, /已提交 1 份设定图/)
    assert.match(result, /模型失效人物.*图片模型不可用/)
    assert.match(result, /依赖未确认人物.*请先补齐并确认参考图.*待确认前置设定/)
    assert.match(result, /林晚.*模型预览暂时不可用/)
    assert.equal(api.saved.at(-1)!.nodes.find(node => node.settings.visual_profile_id === hero.id)!.job_id, null)
    assert.equal(api.saved.at(-1)!.nodes.find(node => node.id === 'video-node')!.job_id, null)
    assert.equal(view.button('一键生成所需参考图').disabled, false, 'failed references remain retryable')
  } finally { await view.destroy() }
})

test('reference batch never creates jobs when the prerequisite nodes cannot be saved', async t => {
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: [missingHero], shot_visual_bindings: [bind(missingHero, true)] }
  const api = mockBoards(t, initialGraph('reference'), projectDetail, { saveError: true })
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel] })
  try {
    await act(() => view.button('一键生成所需参考图').click()); await settle()
    assert.deepEqual(api.generated, []); assert.deepEqual(api.boardPreviews, [])
    assert.match(view.container.querySelector('.pc-required-reference-result')!.textContent!, /画布保存.*模拟画布保存失败/)
    assert.equal(view.button('一键生成所需参考图').disabled, false)
  } finally { await view.destroy() }
})

test('leaving the canvas during enqueue preserves the submitted job on its original reference node', async t => {
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: [missingHero, missingStation],
    shot_visual_bindings: [bind(missingHero, true), bind(missingStation, true)] }
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let refreshed!: () => void
  const finished = new Promise<void>(resolve => { refreshed = resolve })
  const api = mockBoards(t, initialGraph('reference'), projectDetail, { beforeEnqueue: () => pending })
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel], onRefresh: async () => { refreshed() } })
  await act(() => view.button('一键生成所需参考图').click()); await settle()
  assert.equal(api.generated.length, 1)
  await view.destroy()
  await act(async () => { release(); await finished }); await settle()
  assert.equal(api.generated.length, 1, 'leaving stops additional submissions')
  assert.equal(api.saved.at(-1)!.nodes.find(node => node.settings.visual_profile_id === hero.id)!.job_id, 'job-hero-0')
})

test('one-click confirmation handles only unresolved references for this shot and retains the target draft', async t => {
  const pendingHero = { ...missingHero, candidate_asset_ids: ['hero-board'] }
  const pendingStation = { ...missingStation, candidate_asset_ids: ['station-board'] }
  const chosen = { ...hero, id: 'chosen', name: '已选人物' }
  const queued = { ...pendingHero, id: 'queued', name: '生成人物' }
  const unrelated = { ...pendingHero, id: 'unrelated', name: '其他镜头人物' }
  const optional = { ...pendingHero, id: 'optional', name: '未使用道具' }
  const profiles = [pendingHero, pendingStation, chosen, queued, unrelated, optional]
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: profiles, project_visual_style: { version: 'a'.repeat(64), label: '', source: 'unspecified', details: {} },
    shot_visual_bindings: [bind(pendingHero, true), bind(pendingStation, true), bind(chosen, true), bind(queued, true), bind(optional, false), { ...bind(unrelated, true), shot_id: 'other-shot' }],
    jobs: [{ id: 'queued-job', status: 'running', created_at: timestamp, request: JSON.stringify({ visual_profile_id: queued.id, visual_profile_revision: queued.revision }) } as ProjectDetail['jobs'][number]] }
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('hero-node', 'generation', 900), model_id: imageModel.id, asset_id: 'manual', settings: { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: hero.revision } })
  const originalTarget = structuredClone(graph.nodes.find(node => node.id === 'video-node')!)
  const requests: Record<string, unknown>[] = []
  const api = mockApi(t, graph, projectDetail, (path, method, body) => {
    assert.equal(path, '/api/projects/video-reference-test/visual-profiles/confirm-first')
    assert.equal(method, 'POST'); requests.push(body)
    return Response.json({ confirmed: [hero, station], skipped: [] })
  })
  let refreshes = 0
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel], onRefresh: async () => { refreshes++ } })
  try {
    assert.match(view.button('一键确认所需参考图').textContent!, /· 2/)
    await act(() => { view.button('一键确认所需参考图').click(); view.button('一键确认所需参考图').click() }); await settle()
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].profiles, [{ id: hero.id, expected_revision: hero.revision }, { id: station.id, expected_revision: station.revision }])
    assert.equal(requests[0].expected_style_version, 'a'.repeat(64))
    assert.equal(refreshes, 1)
    await view.renderDetail({ ...projectDetail, visual_profiles: profiles.map(profile => profile.id === hero.id ? hero : profile.id === station.id ? station : profile),
      shot_visual_bindings: projectDetail.shot_visual_bindings!.map(binding => binding.profile_id === hero.id ? bind(hero, true) : binding.profile_id === station.id ? bind(station, true) : binding) })
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    assert.equal(api.saved.at(-1)!.nodes.find(node => node.id === 'hero-node')!.asset_id, 'hero-board')
    assert.deepEqual(api.saved.at(-1)!.nodes.find(node => node.id === 'video-node'), originalTarget)
    assert.ok(!document.querySelector('button[aria-label="一键确认所需参考图"]'))
    assert.equal(api.previews.length, 0, 'confirmation never starts target generation')
  } finally { await view.destroy() }
})

test('automatic first-board selection displays the approved first image instead of the last completed candidate', async t => {
  const job = { id: 'last-candidate', status: 'succeeded', result_asset_id: 'manual', created_at: timestamp,
    request: JSON.stringify({ visual_profile_id: hero.id, visual_profile_revision: hero.revision, auto_confirm_first: true }) } as ProjectDetail['jobs'][number]
  const profile = { ...hero, asset_task_id: 'hero-task' }
  const projectDetail: ProjectDetail = { ...detail, visual_profiles: [profile, station], jobs: [job],
    asset_tasks: [{ id: 'hero-task', status: 'ready', generation_job_id: job.id } as ProjectDetail['asset_tasks'][number]] }
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('hero-node', 'generation', 900), model_id: imageModel.id, job_id: job.id,
    settings: { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: hero.revision } })
  const api = mockApi(t, graph, projectDetail)
  const view = await mount(projectDetail, false, { models: [videoModel, imageModel] })
  try {
    await act(() => new Promise(resolve => setTimeout(resolve, 900))); await settle()
    assert.equal(api.saved.at(-1)!.nodes.find(node => node.id === 'hero-node')!.asset_id, hero.board_asset_id)
    assert.equal(api.saved.at(-1)!.nodes.find(node => node.id === 'hero-node')!.settings.visual_completed_job_id, job.id)
  } finally { await view.destroy() }
})

test('double-click opens original images and displayed profile candidates without selecting or generating an asset', async t => {
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('profile-node', 'generation', 900, 'manual'), title: '道具候选', model_id: imageModel.id,
    settings: { modality: 'image', visual_profile_id: hero.id, visual_profile_revision: hero.revision } })
  const api = mockApi(t, graph)
  const view = await mount(detail, true, { models: [videoModel, imageModel] })
  try {
    for (const [id, assetId] of [['storyboard-node', 'storyboard'], ['profile-node', 'manual']]) {
      const card = view.container.querySelector<HTMLElement>(`[data-id="${id}"]`)!
      await act(() => card.click()); await settle()
      const writes = api.saved.length
      await act(() => card.querySelector('img')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))); await settle()
      const image = document.querySelector<HTMLImageElement>('.pc-image-preview-viewport > img')!
      assert.ok(image)
      assert.equal(image.getAttribute('src'), `/api/assets/${assetId}/file`, 'preview uses the original displayed candidate')
      assert.equal(api.saved.length, writes)
      assert.equal(api.previews.length, 0)
      await act(() => image.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
      assert.ok(!document.querySelector('.pc-media-preview'))
      assert.ok(view.container.querySelector(`[data-id="${id}"].selected`), 'Escape preserves selection')
    }
    assert.equal(detail.visual_profiles![0].board_asset_id, 'hero-board', 'preview never confirms a candidate')
    await act(() => view.container.querySelector<HTMLElement>('[data-id="video-node"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))); await settle()
    assert.ok(!document.querySelector('.pc-media-preview'), 'an empty generation node has no media preview')
  } finally { await view.destroy() }
})

test('video double-click transfers playback to the large preview, ignores player controls and stops on close', async t => {
  const video = { ...detail.assets[0], id: 'video-result', kind: 'video' as const, filename: '镜头.mp4', url: '/api/assets/video-result/file' }
  const projectDetail = { ...detail, assets: [...detail.assets, video] }
  const graph = initialGraph('reference')
  graph.nodes.push({ ...node('video-result-node', 'video', 900, video.id), title: '完整镜头' })
  const api = mockApi(t, graph, projectDetail)
  const pauses: HTMLMediaElement[] = []
  t.mock.method(dom.window.HTMLMediaElement.prototype, 'pause', function (this: HTMLMediaElement) { pauses.push(this) })
  const view = await mount(projectDetail, true)
  try {
    const card = view.container.querySelector<HTMLElement>('[data-id="video-result-node"]')!
    await act(() => card.click()); await settle()
    const inline = card.querySelector<HTMLVideoElement>('video')!
    assert.ok(inline)
    Object.defineProperty(inline, 'paused', { configurable: true, value: false })
    await act(() => card.querySelector('[aria-label="播放素材"]')!.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))); await settle()
    assert.ok(!document.querySelector('.pc-media-preview'), 'double-clicking player controls keeps their existing behavior')
    const writes = api.saved.length
    await act(() => inline.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))); await settle()
    const expanded = document.querySelector<HTMLVideoElement>('.pc-media-preview video')!
    assert.ok(expanded)
    assert.equal(expanded.getAttribute('src'), video.url)
    assert.ok(document.querySelector('.pc-media-preview [aria-label="全屏播放素材"]'))
    assert.equal(card.querySelector('video'), null, 'the canvas video becomes a poster while the preview is open')
    assert.ok(pauses.includes(inline))
    assert.equal(document.querySelectorAll('video').length, 1)
    Object.defineProperty(expanded, 'paused', { configurable: true, value: false })
    await act(() => view.button('关闭素材预览').click()); await settle()
    assert.ok(pauses.includes(expanded), 'closing stops preview playback')
    assert.ok(!document.querySelector('.pc-media-preview'))
    assert.ok(view.container.querySelector('[data-id="video-result-node"].selected'))
    assert.equal(api.saved.length, writes)
    assert.equal(api.previews.length, 0)
  } finally { await view.destroy() }
})
