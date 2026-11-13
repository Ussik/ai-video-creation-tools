import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'
import { resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import { stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import type { Model, ProjectDetail, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode, ProjectCanvasProps } from '../src/features/canvas/ProjectCanvas'

// Exercise the real canvas, composer and generation flow with isolated transport.
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver', 'DOMParser']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}
const caretRect = { left: 60, top: 40, right: 61, bottom: 60, width: 1, height: 20 }
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => caretRect })
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [caretRect] })
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
  return { ...size, x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, toJSON() { return this } }
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

const timestamp = '2026-10-18T00:00:00Z'
const model: Model = { id: 'image-model', provider_id: 'provider', name: '隔离图片模型', remote_id: 'image', modality: 'image',
  protocol: 'sync_image', enabled: true, settings: { supported_modes: ['text', 'reference'], ratios: ['16:9'], resolutions: ['1K'],
    request_template: { prompt: '{{prompt}}', images: '{{images}}', ratio: '{{ratio}}', resolution: '{{resolution}}' } } }
const base = { id: 'base', project_id: 'state-reference', kind: 'character', name: '姜望', variant: '落泥前', revision: 1,
  definition: '二十二岁，粗布作业服，短发。', view_requirements: '正侧背三视图', board_asset_id: null, board_style_status: 'missing',
  board_prompt: '制作姜望落泥前的人物设定图。', asset_task_id: null, base_profile_id: null } as VisualProfile
const state = { ...base, id: 'state', variant: '右手背溅泥', base_profile_id: base.id, state_delta: '仅右手背中部增加薄泥斑。',
  definition: '姜望，右手背沾泥，其余服饰不变。', board_prompt: '制作姜望右手背溅泥的人物设定图。', base_reference_status: 'waiting' } as VisualProfile
const detail = { id: 'state-reference', name: '姜望两种状态', brief: '人物状态一致性', ratio: '16:9', updated_at: timestamp,
  script: { outline: '姜望捞网，泥水溅到右手背。', characters: '姜望', scenes: [], artifacts: [], generation_options: {} },
  shots: [], assets: [], jobs: [], asset_tasks: [], timeline_clips: [], asset_reviews: [],
  visual_profiles: [base, state], scene_visual_bindings: [], shot_visual_bindings: [],
} as unknown as ProjectDetail
const readyDetail: ProjectDetail = { ...detail,
  visual_profiles: [{ ...base, revision: 2, board_asset_id: 'base-image', board_style_status: 'current' },
    { ...state, base_reference_status: 'ready' }],
  assets: [{ id: 'base-image', project_id: detail.id, kind: 'image', filename: '姜望落泥前.png', url: '/base-image.png',
    shot_id: null, created_at: timestamp } as ProjectDetail['assets'][number]],
}
function profileNode(profile: VisualProfile, x: number, override?: string): CanvasNode {
  return { id: `${profile.id}-node`, type: 'generation', x, y: 100, width: 280, height: 260,
    title: `${profile.name} · ${profile.variant}`, text: '', prompt: '', asset_id: null, shot_id: null, model_id: model.id, job_id: null,
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: profile.revision,
      ratio: '16:9', resolution: '1K', profile_prompt_override: override } }
}
function initialGraph(override?: string): CanvasGraph {
  return { revision: 'initial', nodes: [profileNode(base, 100), profileNode(state, 500, override),
    { id: `project-script:${detail.id}`, type: 'project_script_ref', x: -790, y: 100, width: 720, height: 480,
      title: detail.name, text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }], edges: [] }
}
type BoardRequest = { profileId: string; body: Record<string, unknown> }
function mockApi(t: TestContext, graph: CanvasGraph) {
  const previews: BoardRequest[] = [], generated: BoardRequest[] = [], saved: CanvasGraph[] = []
  const unexpected: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (path === `/api/projects/${detail.id}/canvases` && method === 'GET') {
      return Response.json([{ id: detail.id, project_id: detail.id, name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    }
    if (path === `/api/projects/${detail.id}/canvas`) {
      if (method === 'GET') return Response.json(graph)
      assert.equal(method, 'PUT')
      const next = JSON.parse(String(init?.body)); saved.push(next)
      return Response.json({ ...next, revision: `saved-${saved.length}` })
    }
    const board = /^\/api\/visual-profiles\/([^/]+)\/(board-preview|generate)$/.exec(path)
    if (board && method === 'POST') {
      const profileId = board[1], body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.equal(profileId, state.id, 'only the selected derived state may contact generation APIs')
      if (board[2] === 'board-preview') {
        previews.push({ profileId, body })
        const prompt = resolvePromptReferences({ prompt: String(body.prompt_override || state.board_prompt), referenceAssetIds: ['base-image'] }).prompt
        return Response.json({ prompt: `${prompt}\n基础参考图 1，仅修改右手背泥斑。`, mode: 'reference', reference_asset_ids: ['base-image'],
          reference_names: ['姜望 · 落泥前'], reference_signature: 'isolated-reviewed-base', base_profile_id: base.id,
          reference_sources: [{ asset_id: 'base-image', profile_id: base.id, role: 'base' }], style_warnings: [] })
      }
      generated.push({ profileId, body })
      return Response.json({ job: { id: 'state-job', status: 'queued' }, jobs: [{ id: 'state-job', status: 'queued' }],
        task: { id: 'state-task', status: 'generating' } })
    }
    unexpected.push(`${method} ${path}`)
    assert.fail(`unexpected transport; no real request is permitted: ${method} ${path}`)
  })
  return { previews, generated, saved, unexpected }
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
async function mount(projectDetail = detail) {
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem(`project-canvas-viewport:${detail.id}`, JSON.stringify({ x: 0, y: 0, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const props: ProjectCanvasProps = { detail: projectDetail, models: [model],
    providers: [{ id: 'provider', name: '隔离测试服务', adapter: 'http', enabled: true } as ProjectCanvasProps['providers'][number]],
    initialLocation: { view: 'canvas', storyboardId: null }, onRefresh: async () => {}, onOpenModels: () => {}, onNavigate: () => {}, onOpenScriptCreator: () => {} }
  const render = async (next: ProjectDetail) => {
    props.detail = next
    await act(() => root.render(<MantineProvider env="test"><ProjectCanvas {...props} /></MantineProvider>)); await settle()
  }
  const select = async (id: string) => {
    const node = container.querySelector<HTMLElement>(`[data-id="${id}"]`); assert.ok(node)
    await act(() => node.click()); await settle()
  }
  try { await render(projectDetail); await select('state-node') }
  catch (error) { await act(() => root.unmount()); container.remove(); throw error instanceof AggregateError ? error.errors[0] : error }
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
    assert.ok(found, `missing button: ${label}`); return found
  }
  const prompt = () => {
    const found = container.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('[contenteditable][aria-label="信息图提示词"]')
    assert.ok(found, 'the real profile prompt editor is open'); return found
  }
  return { container, render, select, button, prompt,
    bodyText: () => stripManagedPromptBlocks(promptEditorText(prompt().editor.getJSON())),
    promptText: () => promptEditorText(prompt().editor.getJSON()),
    destroy: async () => { await act(() => root.unmount()); await settle(); container.remove(); frames.clear() } }
}

function currentProfileStatus(container: HTMLElement) {
  const statuses = container.querySelectorAll('[aria-label="当前设定状态"]')
  assert.equal(statuses.length, 1, 'the candidate section owns the single current profile status')
  assert.equal(statuses[0].getAttribute('role'), 'status')
  assert.equal(statuses[0].closest('[aria-label="当前状态的基础参考"]'), null)
  return statuses[0].textContent
}

function assertFoundationMapping(prompt: string, assetId: string) {
  // The system refers to the same image in the state contract, identity
  // protection, and numbered manifest. Each contract appears once; repetitions
  // of its stable identity are intentional and must not grow on refresh.
  assert.equal((prompt.match(/【基础版本与本次状态变化】/g) || []).length, 1)
  assert.equal((prompt.match(/【基础身份参考】/g) || []).length, 1)
  assert.equal((prompt.match(/【生成参考图】/g) || []).length, 1)
  assert.equal(prompt.split(`[[ref:${assetId}]]`).length - 1, 3)
}
function assertSingleGenerationEntry(container: HTMLElement, generating = false) {
  const inherited = container.querySelector('[aria-label="当前状态的基础参考"]')!
  assert.ok(inherited)
  assert.doesNotMatch(inherited.textContent!, /当前状态已确认|当前状态待生成|当前状态需复核|候选待确认|当前状态生成中/)
  assert.equal([...inherited.querySelectorAll('button')].some(button => /生成当前状态|重新生成当前状态|当前状态生成中/.test(button.textContent || '')), false)
  const actions = container.querySelectorAll('button[aria-label="开始生成"], button[aria-label="生成中，请等待"]')
  assert.equal(actions.length, 1, 'the composer retains one generation entry')
  assert.equal(actions[0].getAttribute('aria-label'), generating ? '生成中，请等待' : '开始生成')
}

test('foundation confirmation leaves a visible required reference and the sole composer action generates only that state', async t => {
  const api = mockApi(t, initialGraph())
  const view = await mount()
  try {
    assert.match(view.container.querySelector('[aria-label="当前状态的基础参考"]')!.textContent!, /等待基础图/)
    assert.equal(view.button('开始生成').disabled, true)
    assertSingleGenerationEntry(view.container)
    assert.equal(currentProfileStatus(view.container), '待生成')
    assert.ok(view.container.querySelector('[aria-label="一键生成所需参考图"]'))
    assert.equal(view.promptText().includes('[[ref:'), false)
    await view.render(readyDetail)
    assert.match(view.container.querySelector('[aria-label="当前状态的基础参考"]')!.textContent!, /基础参考已就绪/)
    assert.equal(view.container.querySelector('[aria-label="一键生成所需参考图"]'), null, 'the completed prerequisite is no longer a missing reference')
    assert.equal(view.container.querySelector('[aria-label="当前状态的基础参考"] img')?.getAttribute('src'), '/base-image.png')
    assertFoundationMapping(view.promptText(), 'base-image')
    assert.ok(view.container.querySelector('[aria-label="必需引用"]'), 'the foundation is visible as a protected prompt reference')
    assertSingleGenerationEntry(view.container)
    assert.equal(view.button('开始生成').disabled, false)
    assert.equal(view.button('开始生成').title, '生成当前设定图')
    await act(() => view.button('开始生成').click()); await settle()
    assert.deepEqual(api.previews.map(request => request.profileId), [state.id])
    assert.deepEqual(api.generated.map(request => request.profileId), [state.id])
    assert.equal(api.generated[0].body.reference_signature, 'isolated-reviewed-base')
    assert.match(String(api.generated[0].body.prompt), /基础参考图 1/)
    assert.deepEqual(api.unexpected, [])
    assert.ok(api.saved.some(graph => graph.nodes.find(node => node.id === 'state-node')?.job_id === 'state-job'))
    assert.ok(view.container.querySelector('[data-id="state-node"].selected'), 'generation keeps the derived state selected')
  } finally { await view.destroy() }
})

test('foundation readiness preserves user edits and repeated detail refreshes never duplicate its protected token', async t => {
  const userDraft = '用户保留：左手保持干净，右手泥斑不要扩大。'
  const api = mockApi(t, initialGraph(userDraft))
  const view = await mount()
  try {
    assert.match(view.promptText(), /用户保留：左手保持干净/)
    await view.render(readyDetail)
    assert.match(view.promptText(), /用户保留：左手保持干净/)
    assertFoundationMapping(view.promptText(), 'base-image')
    const editor = view.prompt().editor
    await act(() => editor.commands.setContent(promptEditorDocument(`${view.promptText()}\n追加：保留粗布衣物纹理。`, [
      { assetId: 'base-image', label: '姜望 · 落泥前', url: '/base-image.png', required: true },
    ]), { emitUpdate: true })); await settle()
    for (let index = 0; index < 3; index++) await view.render({ ...readyDetail, updated_at: `refresh-${index}`, jobs: [...readyDetail.jobs] })
    assert.match(view.promptText(), /用户保留：左手保持干净/)
    assert.match(view.promptText(), /追加：保留粗布衣物纹理/)
    assertFoundationMapping(view.promptText(), 'base-image')
    await view.select('base-node'); await view.select('state-node')
    assert.match(view.promptText(), /追加：保留粗布衣物纹理/)
    assertFoundationMapping(view.promptText(), 'base-image')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) }); await settle()
    const savedDraft = api.saved.at(-1)?.nodes.find(node => node.id === 'state-node')?.settings.profile_prompt_override
    assert.ok(savedDraft, 'the complete edited prompt is persisted to its own node')
    assert.match(savedDraft, /用户保留：左手保持干净/)
    assert.match(savedDraft, /追加：保留粗布衣物纹理/)
    assertFoundationMapping(savedDraft, 'base-image')
    const savedSettings = api.saved.at(-1)!.nodes.find(node => node.id === 'state-node')!.settings
    assert.equal(savedSettings.prompt_document, true)
    assert.equal(savedSettings.prompt_body?.includes('【基础身份参考】'), false)
    assert.equal(savedSettings.prompt_body?.includes('[[ref:base-image]]'), false)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, [])
    assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('hand edits inside a profile system block survive save, reload and the derived-state generation request', async t => {
  const graph = initialGraph('仅右手背增加薄泥斑，其他服饰保持不变。')
  const api = mockApi(t, graph)
  let view = await mount(readyDetail)
  const addition = '手工细化：背面粗布衣领保留细小磨损，沿用[[ref:base-image]]。'
  const assertEditedBlock = () => {
    assert.match(view.promptText(), /【设定图固定要求】/)
    assert.match(view.promptText(), /手工细化：背面粗布衣领保留细小磨损，沿用\[\[ref:base-image\]\]。\n【设定图固定要求结束】/)
    assert.equal((view.promptText().match(/【设定图固定要求】/g) || []).length, 1)
    assert.equal(view.container.querySelectorAll('.pc-prompt-composer .pc-prompt-editor-content').length, 1)
    assert.equal(view.prompt().editor.isEditable, true)
  }
  try {
    const prompt = view.promptText().replace('【设定图固定要求结束】', `${addition}\n【设定图固定要求结束】`)
    await act(() => view.prompt().editor.commands.setContent(promptEditorDocument(prompt, [
      { assetId: 'base-image', label: '姜望 · 落泥前', url: '/base-image.png', required: true },
    ]), { emitUpdate: true })); await settle()
    assertEditedBlock()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) }); await settle()
    const saved = api.saved.at(-1)!
    const settings = saved.nodes.find(node => node.id === 'state-node')!.settings
    assert.equal(settings.prompt_document, true)
    assert.match(settings.profile_prompt_override || '', /手工细化：背面粗布衣领/)
    assert.doesNotMatch(settings.prompt_body || '', /手工细化：/)
    Object.assign(graph, saved)
    await view.destroy(); view = await mount(readyDetail)
    assertEditedBlock()
    await act(() => view.button('开始生成').click()); await settle()
    assert.equal(api.previews.length, 1)
    assert.equal(api.previews[0].body.prompt_document, true)
    assert.match(String(api.previews[0].body.prompt_override), /手工细化：背面粗布衣领/)
    assert.match(String(api.generated[0].body.prompt), /手工细化：背面粗布衣领/)
    assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('replacing or invalidating the confirmed foundation updates the visible reference without overwriting the state draft', async t => {
  const userDraft = '手工要求：右手泥斑呈不规则形状，保留相貌和服装。'
  const api = mockApi(t, initialGraph(userDraft))
  const view = await mount(readyDetail)
  try {
    assertFoundationMapping(view.promptText(), 'base-image')
    const replacement: ProjectDetail = { ...readyDetail,
      visual_profiles: [{ ...readyDetail.visual_profiles![0], revision: 3, board_asset_id: 'new-base-image' }, readyDetail.visual_profiles![1]],
      assets: [...readyDetail.assets, { ...readyDetail.assets[0], id: 'new-base-image', url: '/new-base-image.png' }],
    }
    await view.render(replacement)
    assert.match(view.promptText(), /手工要求：右手泥斑呈不规则形状/)
    assert.equal(view.promptText().includes('[[ref:base-image]]'), false)
    assertFoundationMapping(view.promptText(), 'new-base-image')
    assert.equal(view.container.querySelector('[aria-label="当前状态的基础参考"] img')?.getAttribute('src'), '/new-base-image.png')
    assert.equal(view.button('开始生成').disabled, false)
    await view.render({ ...replacement, visual_profiles: [
      { ...replacement.visual_profiles![0], board_style_status: 'needs_review' },
      { ...replacement.visual_profiles![1], base_reference_status: 'needs_review' },
    ] })
    assert.match(view.container.querySelector('[aria-label="当前状态的基础参考"]')!.textContent!, /基础参考需复核/)
    assert.match(view.promptText(), /手工要求：右手泥斑呈不规则形状/)
    assert.equal(view.promptText().includes('[[ref:'), false, 'a foundation requiring review is not advertised as an active protected input')
    assert.equal(view.button('开始生成').disabled, true)
    await act(() => view.button('开始生成').click()); await settle()
    assertSingleGenerationEntry(view.container)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('an orphan generating task and an empty editable body both disable current state generation', async t => {
  const api = mockApi(t, initialGraph())
  const taskOnly: ProjectDetail = { ...readyDetail,
    visual_profiles: [readyDetail.visual_profiles![0], { ...readyDetail.visual_profiles![1], asset_task_id: 'state-task' }],
    asset_tasks: [{ id: 'state-task', project_id: detail.id, status: 'generating', generation_job_id: null } as ProjectDetail['asset_tasks'][number]],
  }
  const view = await mount(taskOnly)
  try {
    assertSingleGenerationEntry(view.container, true)
    assert.equal(currentProfileStatus(view.container), '生成中')
    assert.equal(view.button('生成中，请等待').disabled, true)
    await act(() => view.button('生成中，请等待').click()); await settle()
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }

  // A saved empty document explicitly omits the editable primary. A legacy
  // empty override can still inherit the profile's valid fixed main task.
  const emptyGraph = initialGraph('')
  emptyGraph.nodes.find(node => node.id === 'state-node')!.settings.prompt_sections = parsePromptSectionDocument('')
  const emptyApi = mockApi(t, emptyGraph)
  const emptyView = await mount(readyDetail)
  try {
    assertFoundationMapping(emptyView.promptText(), 'base-image')
    assertSingleGenerationEntry(emptyView.container)
    assert.equal(emptyView.button('开始生成').disabled, true, 'generated context cannot substitute for the empty editable body')
    await act(() => emptyView.button('开始生成').click()); await settle()
    assert.deepEqual(emptyApi.previews, []); assert.deepEqual(emptyApi.generated, []); assert.deepEqual(emptyApi.unexpected, [])
  } finally { await emptyView.destroy() }
})

function candidateFixture() {
  const graph = initialGraph()
  const node = graph.nodes.find(item => item.id === 'state-node')!
  node.asset_id = 'state-candidate'
  node.job_id = 'later-failed-job'
  const candidate = { ...readyDetail.assets[0], id: 'state-candidate', filename: '姜望右手背溅泥候选.png', url: '/state-candidate.png' }
  const job = (id: string, status: 'succeeded' | 'failed' | 'running', assetId: string | null, referenceIds: string[], baseSignature: string, createdAt: string) => ({
    id, project_id: detail.id, shot_id: null, model_id: model.id, job_type: 'generation', result_asset_id: assetId,
    status, external_id: null, recovery_available: false, error: null, created_at: createdAt,
    request: JSON.stringify({ visual_profile_id: state.id, visual_profile_revision: state.revision,
      reference_asset_ids: referenceIds, visual_base_signature: baseSignature }),
  } as ProjectDetail['jobs'][number])
  const succeeded = job('displayed-successful-job', 'succeeded', candidate.id, ['base-image'], 'base-signature-v2', '2026-10-18T01:00:00Z')
  const laterFailed = job('later-failed-job', 'failed', null, [], 'unrelated-failed-signature', '2026-10-18T02:00:00Z')
  const projectDetail: ProjectDetail = { ...readyDetail,
    visual_profiles: [readyDetail.visual_profiles![0], { ...readyDetail.visual_profiles![1], base_reference_signature: 'base-signature-v2' }],
    assets: [...readyDetail.assets, candidate], jobs: [laterFailed, succeeded],
  }
  return { graph, projectDetail, candidate, succeeded, laterFailed, job }
}

test('the unified reference entry exposes both libraries and an automatic inherited reference does not falsely age the displayed candidate', async t => {
  const fixture = candidateFixture()
  const api = mockApi(t, fixture.graph)
  const view = await mount(fixture.projectDetail)
  try {
    assert.equal(fixture.graph.edges.length, 0, 'the base is inherited automatically rather than represented by a persisted manual edge')
    const list = view.container.querySelector('[aria-label="本次生成将使用的参考"]')!
    assert.ok(list, 'the composer lists its actual resolved references')
    assert.match(list.textContent!, /基础继承/)
    assert.match(list.textContent!, /保持身份/)
    assert.match(list.textContent!, /必需/)
    assert.equal(list.querySelectorAll('img').length, 1)
    assert.equal(list.querySelector('img')?.getAttribute('src'), '/base-image.png')
    assert.equal(list.querySelector('button[aria-label^="移除参考："]'), null, 'an inherited reference has no removal action')
    assert.equal(view.container.querySelector('.pc-profile-reference-notice'), null, 'the displayed successful request already used this automatic base')
    assertSingleGenerationEntry(view.container)
    assert.equal(currentProfileStatus(view.container), '候选待确认')
    assert.doesNotMatch(view.container.textContent!, /参考图已变化，可重新生成候选图|当前候选使用的参考图片与当前选择不同|当前候选使用的基础版本已更新/)

    await act(() => view.button('添加参考').click()); await settle()
    const menuItems = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
    assert.ok(menuItems.includes('从素材库选择'))
    assert.ok(menuItems.includes('从设定库选择'))
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('the candidate section distinguishes confirmed and review-required current profiles while the foundation stays ready', async t => {
  const fixture = candidateFixture()
  const api = mockApi(t, fixture.graph)
  const confirmed: ProjectDetail = { ...fixture.projectDetail, visual_profiles: [fixture.projectDetail.visual_profiles![0],
    { ...fixture.projectDetail.visual_profiles![1], board_asset_id: fixture.candidate.id, board_style_status: 'current' }] }
  const view = await mount(confirmed)
  try {
    const foundation = () => view.container.querySelector('[aria-label="当前状态的基础参考"]')!
    assert.match(foundation().textContent!, /基础参考已就绪/)
    assert.equal(currentProfileStatus(view.container), '已确认')
    assertSingleGenerationEntry(view.container)
    assert.equal(view.button('开始生成').title, '重新生成当前设定图')

    await view.render({ ...confirmed, visual_profiles: [confirmed.visual_profiles![0],
      { ...confirmed.visual_profiles![1], base_reference_status: 'needs_review' }] })
    assert.match(foundation().textContent!, /基础参考已就绪/)
    assert.equal(currentProfileStatus(view.container), '需复核')
    assertSingleGenerationEntry(view.container)

    await view.render({ ...confirmed, visual_profiles: [confirmed.visual_profiles![0],
      { ...confirmed.visual_profiles![1], board_style_status: 'needs_review' }] })
    assert.equal(currentProfileStatus(view.container), '需复核', 'current-profile style review remains visible without being repeated in the base card')
    assertSingleGenerationEntry(view.container)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('a changed foundation compares the displayed successful candidate and uses a neutral notice instead of the later node job', async t => {
  const fixture = candidateFixture()
  const replacement: ProjectDetail = { ...fixture.projectDetail,
    visual_profiles: [{ ...fixture.projectDetail.visual_profiles![0], revision: 3, board_asset_id: 'new-base-image' },
      { ...fixture.projectDetail.visual_profiles![1], base_reference_signature: 'base-signature-v3' }],
    assets: [...fixture.projectDetail.assets, { ...readyDetail.assets[0], id: 'new-base-image', filename: '姜望基础图新版.png', url: '/new-base-image.png' }],
    // A newer failed job used today's references, while the displayed image
    // came from the older successful request. Only the latter is relevant.
    jobs: [{ ...fixture.laterFailed, request: JSON.stringify({ visual_profile_id: state.id, visual_profile_revision: state.revision,
      reference_asset_ids: ['new-base-image'], visual_base_signature: 'base-signature-v3' }) }, fixture.succeeded],
  }
  const api = mockApi(t, fixture.graph)
  const view = await mount(fixture.projectDetail)
  try {
    assert.equal(view.container.querySelector('.pc-profile-reference-notice'), null)
    await view.render(replacement)
    const notice = view.container.querySelector<HTMLElement>('.pc-profile-reference-notice')!
    assert.ok(notice)
    assert.equal(notice.getAttribute('role'), 'status')
    assert.match(notice.textContent!, /当前候选使用的基础版本已更新，可重新生成候选图/)
    assert.equal(notice.classList.contains('pc-required-reference-error'), false)
    assert.equal(notice.closest('[role="alert"]'), null)
    const list = view.container.querySelector('[aria-label="本次生成将使用的参考"]')!
    assert.equal(list.querySelector('img')?.getAttribute('src'), '/new-base-image.png')
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('a running profile shows the submitted reference snapshot and suppresses premature candidate notices', async t => {
  const fixture = candidateFixture()
  const currentDraft = '仍在编辑的状态草稿，手背泥斑保持细小。'
  const stateNode = fixture.graph.nodes.find(item => item.id === 'state-node')!
  stateNode.job_id = 'running-job'
  stateNode.settings.profile_prompt_override = currentDraft
  const snapshotExtra = { ...readyDetail.assets[0], id: 'submitted-extra', filename: '提交时的渡口参考.png', url: '/submitted-extra.png' }
  const runningJob = fixture.job('running-job', 'running', null, ['base-image', snapshotExtra.id], 'base-signature-v2', '2026-10-18T03:00:00Z')
  runningJob.request = JSON.stringify({ ...JSON.parse(runningJob.request), prompt: '已提交：参考图 1 保持姜望身份，参考图 2 用于渡口环境。' })
  const active: ProjectDetail = { ...fixture.projectDetail,
    visual_profiles: [{ ...fixture.projectDetail.visual_profiles![0], revision: 3, board_asset_id: 'new-base-image' },
      { ...fixture.projectDetail.visual_profiles![1], base_reference_signature: 'base-signature-v3' }],
    assets: [...fixture.projectDetail.assets, snapshotExtra,
      { ...readyDetail.assets[0], id: 'new-base-image', filename: '当前基础图.png', url: '/new-base-image.png' }],
    jobs: [runningJob, ...fixture.projectDetail.jobs],
  }
  const api = mockApi(t, fixture.graph)
  const view = await mount(active)
  try {
    const list = view.container.querySelector('[aria-label="本次任务使用的参考"]')!
    assert.ok(list)
    assert.equal(view.container.querySelector('[aria-label="本次生成将使用的参考"]'), null)
    assert.deepEqual([...list.querySelectorAll('img')].map(image => image.getAttribute('src')), ['/base-image.png', '/submitted-extra.png'])
    assert.match(list.textContent!, /已提交参考/)
    assert.doesNotMatch(list.textContent!, /当前基础图|基础继承|第 3 版/)
    assert.equal(view.container.querySelector('.pc-profile-reference-notice'), null)
    assert.doesNotMatch(view.container.textContent!, /当前候选使用的基础版本已更新|当前候选使用的参考图片与当前选择不同|参考图已变化，可重新生成候选图/)
    assertSingleGenerationEntry(view.container, true)
    assert.equal(currentProfileStatus(view.container), '生成中')
    assert.equal(view.button('生成中，请等待').disabled, true)
    assert.equal(view.prompt().getAttribute('contenteditable'), 'false')
    assert.equal(view.prompt().getAttribute('aria-disabled'), 'true')
    assert.equal(view.prompt().editor.isEditable, false)
    assert.match(view.promptText(), /已提交：/)
    assert.match(view.promptText(), /\[\[ref:base-image\]\]/)
    assert.match(view.promptText(), /\[\[ref:submitted-extra\]\]/)
    assert.equal(view.promptText().includes(currentDraft), false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) }); await settle()
    assert.equal(api.saved.at(-1)?.nodes.find(item => item.id === 'state-node')?.settings.profile_prompt_override, currentDraft,
      'the submitted prompt is a read-only view and must never overwrite the editable node draft')
    await view.render(fixture.projectDetail)
    assert.match(view.promptText(), /仍在编辑的状态草稿/)
    assert.doesNotMatch(view.promptText(), /已提交：/)
    assert.equal(view.prompt().editor.isEditable, true)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('canonical reference rows keep the base first and removing optional profile or pinned image inputs persists only the matching edges', async t => {
  const graph = initialGraph('自定义状态：[[ref:manual-profile-image]] 的色调，配合 [[ref:pinned-extra-image]] 的泥水纹理。')
  const manualProfile: VisualProfile = { ...base, id: 'manual-profile', name: '渡口', variant: '清晨', kind: 'location',
    board_asset_id: 'manual-profile-image', board_style_status: 'current', revision: 4 }
  const manualAsset = { ...readyDetail.assets[0], id: 'manual-profile-image', filename: '渡口清晨设定.png', url: '/manual-profile-image.png' }
  const pinnedAsset = { ...readyDetail.assets[0], id: 'pinned-extra-image', filename: '泥水纹理参考.png', url: '/pinned-extra-image.png' }
  const manualNode = profileNode(manualProfile, 900)
  const pinnedNode: CanvasNode = { ...profileNode(base, 1300), id: 'pinned-image-node', type: 'image', title: '泥水纹理',
    asset_id: pinnedAsset.id, settings: { modality: 'image' } }
  graph.nodes.push(manualNode, pinnedNode)
  // Put the pinned asset before the profile in persisted edge order. The
  // canonical submission order still groups manual profiles before assets.
  graph.edges.push({ id: 'pinned-reference', source: pinnedNode.id, target: 'state-node', reference_asset_id: pinnedAsset.id },
    { id: 'profile-reference', source: manualNode.id, target: 'state-node' })
  const projectDetail: ProjectDetail = { ...readyDetail, visual_profiles: [...readyDetail.visual_profiles!, manualProfile],
    assets: [...readyDetail.assets, manualAsset, pinnedAsset] }
  const api = mockApi(t, graph)
  const view = await mount(projectDetail)
  try {
    const referenceList = () => view.container.querySelector('[aria-label="本次生成将使用的参考"]')!
    const rows = () => [...referenceList().querySelectorAll('li')]
    assert.deepEqual([...referenceList().querySelectorAll('img')].map(image => image.getAttribute('src')),
      ['/base-image.png', '/manual-profile-image.png', '/pinned-extra-image.png'])
    assert.match(rows()[0].textContent!, /基础继承.*必需|必需.*基础继承/)
    assert.match(rows()[1].textContent!, /设定库/)
    assert.match(rows()[2].textContent!, /素材库/)
    assertFoundationMapping(view.promptText(), 'base-image')
    const removeManual = rows()[1].querySelector<HTMLButtonElement>('button[aria-label^="移除参考："]')!
    assert.ok(removeManual)
    await act(() => removeManual.click()); await settle()
    assert.deepEqual([...referenceList().querySelectorAll('img')].map(image => image.getAttribute('src')), ['/base-image.png', '/pinned-extra-image.png'])
    assert.equal(view.promptText().includes('[[ref:manual-profile-image]]'), false)
    assertFoundationMapping(view.promptText(), 'base-image')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) }); await settle()
    const afterProfile = api.saved.at(-1)!
    assert.ok(afterProfile)
    assert.equal(afterProfile.edges.some(edge => edge.id === 'profile-reference'), false)
    assert.ok(afterProfile.edges.some(edge => edge.id === 'pinned-reference'))
    const removePinned = rows()[1].querySelector<HTMLButtonElement>('button[aria-label^="移除参考："]')!
    await act(() => removePinned.click()); await settle()
    assert.equal(rows().length, 1)
    assert.equal(view.promptText().includes('[[ref:pinned-extra-image]]'), false)
    assertFoundationMapping(view.promptText(), 'base-image')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) }); await settle()
    const saved = api.saved.at(-1)!
    assert.equal(saved.edges.some(edge => edge.target === 'state-node'), false)
    assert.ok(saved.nodes.find(node => node.id === 'manual-profile-node'), 'removing a reference preserves its source node')
    assert.ok(saved.nodes.find(node => node.id === pinnedNode.id))
    assert.equal(saved.nodes.find(node => node.id === 'state-node')?.settings.prompt_body?.includes('【基础身份参考】') ?? false, false)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})

test('the inheritance card reads resolved state prose without persisting it over the original definition', async t => {
  const original = '仅增加薄泥斑，见 [基础设定](profile:base)。'
  const display = '仅增加薄泥斑，沿用「姜望 · 落泥前」的服饰。'
  const api = mockApi(t, initialGraph())
  const projectDetail: ProjectDetail = { ...readyDetail, visual_profiles: [readyDetail.visual_profiles![0],
    { ...readyDetail.visual_profiles![1], state_delta: original, display_state_delta: display }] }
  const view = await mount(projectDetail)
  try {
    const text = view.container.querySelector('.pc-profile-inheritance-delta')!.textContent!
    assert.match(text, /沿用「姜望 · 落泥前」的服饰/)
    assert.equal(text.includes('profile:base'), false)
    assert.equal(projectDetail.visual_profiles![1].state_delta, original)
    assert.deepEqual(api.previews, []); assert.deepEqual(api.generated, []); assert.deepEqual(api.unexpected, [])
  } finally { await view.destroy() }
})
