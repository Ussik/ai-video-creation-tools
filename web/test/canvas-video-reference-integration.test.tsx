import { chooseCombobox } from './component-controls'
import { videoReferenceUsageLabels, type VideoReferenceUsage } from '@video-studio/shared/media/video-reference-usage'
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
  ], edges: [{ id: 'storyboard-edge', source: 'storyboard-node', target: 'video-node', reference_asset_id: 'storyboard' },
    ...(extraManual ? [{ id: 'manual-edge', source: 'manual-node', target: 'video-node', reference_asset_id: 'manual' }] : [])] }
}
type PreviewInput = { video_reference_usages?: import('@video-studio/shared/media/video-reference-usage').VideoReferenceUsageSelection[]; mode: string; reference_asset_ids: string[]; prompt: string; visual_reference_mode: string; excluded_visual_profile_ids?: string[]; storyboard_reference_asset_id?: string | null }
type ApiHandler = (path: string, method: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined
function mockApi(t: TestContext, graph: CanvasGraph, projectDetail = detail, handler?: ApiHandler, saveError = false) {
  const previews: PreviewInput[] = [], saved: CanvasGraph[] = []
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
      ? (projectDetail.shot_visual_bindings || []).filter(binding => binding.required || !request.excluded_visual_profile_ids?.includes(binding.profile_id))
        .flatMap(binding => binding.reference_assets?.length ? binding.reference_assets.map(reference => reference.asset_id) : binding.board_asset_id ? [binding.board_asset_id] : []) : []
    return Response.json({ ...request, reference_asset_ids: [...new Set([...request.reference_asset_ids, ...profileIds])], visual_signature: 'mock-reviewed-bindings' })
  })
  return { previews, saved }
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
  const prompt = () => {
    const found = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="创作提示词"]')
    assert.ok(found, 'actual canvas composer'); return found
  }
  const images = () => [...container.querySelectorAll('.pc-video-reference-number')].map(node => node.textContent)
  const editPrompt = async (value: string) => {
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt(), value)
      prompt().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await settle()
  }
  const preview = async () => { await act(() => button('查看生成信息').click()); await settle() }
  return { container, button, selectMode, prompt, images, editPrompt, preview,
    renderDetail: async (next: ProjectDetail) => { props.detail = next; await act(render); await settle() },
    destroy: async () => { await act(() => root.unmount()); await settle(); container.remove(); frames.clear() } }
}

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
    const expandedPrompt = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="创作提示词"]')!
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
    assert.deepEqual(api.previews[0].reference_asset_ids, ['storyboard'], 'automatic bindings remain server-resolved inputs')
    assert.deepEqual(api.previews[0].excluded_visual_profile_ids, ['station'])
    assert.match(api.previews[0].prompt, /图片2：林晚（校服）/)
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
    assert.deepEqual(api.previews[1].reference_asset_ids, ['storyboard', 'manual'])
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
    assert.deepEqual(api.previews.at(-1)!.reference_asset_ids, ['manual'])
    assert.equal(api.previews.at(-1)!.storyboard_reference_asset_id, null)
    assert.deepEqual(api.previews.at(-1)!.video_reference_usages, [{ asset_id: 'manual', usage: 'scale' }])
  } finally { await view.destroy() }
})

const imageModel: Model = { ...videoModel, id: 'image-model', name: '图片模型', modality: 'image', protocol: 'sync_image',
  settings: { supported_modes: ['text', 'reference'], ratios: ['9:16', '16:9'], resolutions: ['1K', '2K', '4K'],
    request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}', resolution: '{{resolution}}',
      clarity: '{{clarity}}', quality: '{{quality}}', background: '{{background}}' } } }
const alternateImageModel = { ...imageModel, id: 'alternate-image-model', name: '备用图片模型' }
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
    assert.equal(stationRequest.ratio, '9:16'); assert.equal(stationRequest.clarity, '2K')
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
