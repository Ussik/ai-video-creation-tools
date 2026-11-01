import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ProjectDetail } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { chooseCombobox } from './component-controls'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
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
const { default: App } = await import('../src/app/App')
after(() => dom.window.close())

const timestamp = '2026-10-09T00:00:00Z'
const detail: ProjectDetail = { id: 'refresh', name: '夜班列车', brief: '林晚在车站等候列车', ratio: '9:16', music_asset_id: null,
  created_at: timestamp, updated_at: timestamp, production_range: { start_shot_id: null, end_shot_id: null },
  script: { outline: '# 故事大纲\n\n林晚在车站等候列车。', characters: '林晚', scenes: [], artifacts: [], generation_options: {} },
  shots: [], timeline_clips: [], asset_reviews: [], assets: [], jobs: [], asset_tasks: [], visual_profiles: [], scene_visual_bindings: [], shot_visual_bindings: [],
}
function node(id: string, type: CanvasNode['type'], x: number, y: number, width: number, height: number): CanvasNode {
  return { id, type, x, y, width, height, title: '', text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }
}
const graph: CanvasGraph = { revision: 'revision', nodes: [
  { ...node('script', 'project_script_ref', 60, 80, 640, 350), title: detail.name },
  { ...node('text', 'text', 60, 550, 420, 340), title: '镜头提示词', text: '林晚望向站台。', settings: { text_mode: 'write' } },
  { ...node('generation', 'generation', 900, 550, 440, 420), title: '图片生成', settings: { modality: 'image' } },
], edges: [{ id: 'prompt', source: 'text', target: 'generation' }] }

async function settle() {
  await act(async () => {
    for (let pass = 0; pass < 8; pass++) {
      await Promise.resolve()
      const pending = [...frames.values()]; frames.clear()
      pending.forEach(callback => callback(pass * 16))
    }
  })
}

test('real App polling retains one canvas beside the hidden storyboard planner', async t => {
  const requests: Array<{ path: string; method: string }> = [], errors: string[] = []
  let detailReads = 0, continuityReads = 0
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    assert.equal(method, 'GET', 'background refresh cannot write the canvas or project')
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === '/api/projects/refresh/canvas') return Response.json(graph)
    if (path === '/api/projects/refresh') {
      // Real changed fields force App reconciliation even with shared snapshots.
      const next = structuredClone(detail); next.updated_at = `2026-10-09T00:00:${String(++detailReads).padStart(2, '0')}Z`
      return Response.json(next)
    }
    if (path === '/api/projects/refresh/continuity') return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: `continuity-${++continuityReads}` })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  // Invoke the actual sequential poll callback without waiting four seconds.
  const polls = new Map<number, () => Promise<void>>()
  let pollId = 100_000
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window), nativeClearTimeout = dom.window.clearTimeout.bind(dom.window)
  t.mock.method(dom.window, 'setTimeout', (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 4000) return nativeSetTimeout(handler, delay, ...args)
    assert.equal(typeof handler, 'function'); const id = ++pollId
    polls.set(id, () => (handler as (...args: unknown[]) => Promise<void>)(...args)); return id
  })
  t.mock.method(dom.window, 'clearTimeout', (id?: number) => { if (!polls.delete(id!)) nativeClearTimeout(id) })

  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  dom.window.localStorage.setItem('project-canvas-viewport:refresh', JSON.stringify({ x: 22, y: 33, zoom: 0.8 }))
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<MantineProvider env="test"><App /></MantineProvider>) })
    await settle()
    const project = container.querySelector<HTMLButtonElement>('.project-card-main')
    assert.ok(project, 'project loads through the real App catalog')
    await act(async () => { project.click() }); await settle()
    assert.equal(container.querySelectorAll('.project-canvas').length, 1, 'real App mounts one canvas per project')
    assert.equal(container.querySelectorAll('.pc-flow').length, 1)
    assert.equal(container.querySelectorAll('.react-flow').length, 1)
    const canvas = container.querySelector('.project-canvas'), flow = container.querySelector('.react-flow')
    const script = container.querySelector<HTMLElement>('[data-id="script"]')!
    assert.ok(script, 'the canvas has loaded its graph')
    await act(() => script.click()); await settle()
    const viewportStyle = container.querySelector('.react-flow__viewport')!.getAttribute('style')
    const nodeStyles = [...container.querySelectorAll('.react-flow__node')].map(element => element.getAttribute('style'))
    const initialDetailReads = detailReads, initialContinuityReads = continuityReads
    assert.ok(script.classList.contains('selected'))
    for (let tick = 1; tick <= 4; tick++) {
      assert.equal(polls.size, 1, 'one sequential project poll is scheduled')
      const [id, poll] = [...polls.entries()][0]; polls.delete(id)
      await act(async () => { await poll() }); await settle()
      assert.equal(detailReads, initialDetailReads + tick, 'each tick refreshes the actual project detail')
      assert.equal(continuityReads, initialContinuityReads + tick, 'each tick also updates parent continuity state')
      assert.equal(container.querySelectorAll('.project-canvas').length, 1, `poll ${tick} cannot duplicate a canvas`)
      assert.equal(container.querySelectorAll('.pc-flow').length, 1, `poll ${tick} retains one flow host`)
      assert.equal(container.querySelector('.project-canvas'), canvas, `poll ${tick} preserves the canvas mount`)
      assert.equal(container.querySelector('.react-flow'), flow, `poll ${tick} preserves React Flow`)
      assert.equal(container.querySelector('[data-id="script"]'), script, `poll ${tick} preserves node DOM`)
      assert.ok(script.classList.contains('selected'), `poll ${tick} preserves selection`)
      assert.equal(container.querySelector('.react-flow__viewport')!.getAttribute('style'), viewportStyle)
      assert.deepEqual([...container.querySelectorAll('.react-flow__node')].map(element => element.getAttribute('style')), nodeStyles)
      assert.equal(container.querySelectorAll('.react-flow__edge-path').length, 1)
    }
    assert.deepEqual(requests.filter(request => request.path.endsWith('/canvas')), [{ path: '/api/projects/refresh/canvas', method: 'GET' }])
    assert.deepEqual(errors.filter(message => /same key|unique.*key|duplicate.*key/i.test(message)), [], 'sibling workspaces must have distinct React keys')
    assert.deepEqual(errors, [], 'App polling does not emit React rendering errors')
  } finally {
    await act(() => root.unmount()); container.remove(); frames.clear()
  }
})

test('header project switching retains asset workspace and clears prior selections and search without writes', async t => {
  const a = { ...structuredClone(detail), id: 'a', name: '项目甲', assets: [{ id: 'asset-a', project_id: 'a', shot_id: null, kind: 'image', filename: '甲.png', source: 'generated', saved: true, model_id: null, prompt: null, remote_url: null, created_at: timestamp, url: '/a.png' }] } as ProjectDetail
  const b = { ...structuredClone(detail), id: 'b', name: '项目乙', assets: [{ ...a.assets[0], id: 'asset-b', project_id: 'b', filename: '乙.png', url: '/b.png' }] } as ProjectDetail
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    assert.equal(method, 'GET', 'switching projects must not mutate either project')
    if (path === '/api/projects') return Response.json([a, b])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path.endsWith('/canvases')) return Response.json([])
    if (path.endsWith('/continuity')) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: path })
    if (path === '/api/projects/a') return Response.json(a)
    if (path === '/api/projects/b') return Response.json(b)
    throw new Error(`Unexpected request: ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="资产"]')!.click()); await settle()
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择 甲.png"]')!
    assert.ok(checkbox)
    await act(() => checkbox.click()); await settle()
    assert.ok(container.querySelector('.asset-bulk-bar'))
    const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索素材"]')!
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, '甲')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await chooseCombobox(container.querySelector<HTMLInputElement>('input[aria-label="切换项目"]')!, '项目乙'); await settle()
    assert.ok(container.querySelector('[aria-label="生成历史"]'), 'active workspace remains generation history')
    assert.equal(container.querySelector('.project-canvas'), null)
    assert.equal(container.querySelector('.asset-bulk-bar'), null)
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="搜索素材"]')?.value, '')
    assert.equal(container.querySelector('.library-copy strong')?.textContent, '乙.png')
    await act(() => [...container.querySelectorAll<HTMLButtonElement>('.asset-library-rail button')].find(el => el.textContent?.includes('个人资产库'))!.click()); await settle()
    await chooseCombobox(container.querySelector<HTMLInputElement>('input[aria-label="切换项目"]')!, '项目甲'); await settle()
    assert.ok(container.querySelector('[aria-label="个人资产库"]'), 'asset subview survives project switching')
    assert.equal(container.querySelector('.library-copy strong')?.textContent, '甲.png')
    assert.ok(requests.every(request => request.method === 'GET'))
  } finally { await act(() => root.unmount()); container.remove(); frames.clear() }
})

test('editor supplement opens the exact missing outline scope without generating or saving', async t => {
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'; requests.push({ path, method })
    assert.equal(method, 'GET', 'opening supplement configuration must not generate or save')
    if (path === '/api/projects') return Response.json([detail])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path === '/api/projects/refresh/canvases') return Response.json([{ id: 'refresh', project_id: 'refresh', name: '画布 1', is_default: true, node_count: graph.nodes.length, viewport: null }])
    if (path === '/api/projects/refresh/canvas') return Response.json(graph)
    if (path === '/api/projects/refresh') return Response.json(detail)
    if (path.endsWith('/continuity')) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: 'supplement' })
    if (path.endsWith('/script/source')) return Response.json(null)
    if (path.endsWith('/conversations')) return Response.json({ conversations: [] })
    if (path.endsWith('/tools-state')) return Response.json({ draft: null, decisions: [] })
    if (path.endsWith('/skills/defaults')) return Response.json({ policies: [] })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
    await act(() => container.querySelector<HTMLButtonElement>('.project-card-main')!.click()); await settle()
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑剧本"]')!.click()); await settle()
    assert.ok(container.querySelector('[aria-label="剧本创作"]'))
    const supplement = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '补齐故事大纲缺项')
    assert.ok(supplement)
    assert.equal(supplement.disabled, false)
    await act(() => supplement.click()); await settle()
    assert.equal(container.querySelector('[aria-label="剧本创作"]'), null)
    const panel = container.querySelector('[aria-label="分阶段生成面板"]')!
    assert.ok(panel, 'the editor opens the real director configuration')
    assert.equal(panel.querySelector<HTMLInputElement>('input[aria-label="阶段处理方式"]')?.value, '补齐缺失栏目')
    const deliverables = [...panel.querySelectorAll('p')].find(element => element.textContent?.startsWith('本次交付：'))!.textContent!
    assert.doesNotMatch(deliverables, /概要设计/, 'the saved outline is excluded from the requested work')
    assert.match(deliverables, /故事简述/)
    assert.match(deliverables, /钩子预设/)
    assert.match(deliverables, /分集大纲/)
    assert.match(panel.textContent!, /已保存栏目的标题和正文保持原样/)
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="打开剧本对话"]')!.click()); await settle()
    assert.equal(container.querySelector('[aria-label="分阶段生成面板"]'), null, 'a regular conversation opening clears the supplement request')
    assert.ok(requests.every(request => request.method === 'GET'))
    assert.equal(detail.script.outline, '# 故事大纲\n\n林晚在车站等候列车。')
  } finally { await act(() => root.unmount()); container.remove(); frames.clear() }
})

test('task history pauses idle and hidden polling, refreshes on visibility, and resets filters when switching projects', async t => {
  const a = { ...structuredClone(detail), id: 'tasks-a', name: '任务项目甲' }
  const b = { ...structuredClone(detail), id: 'tasks-b', name: '任务项目乙' }
  let status: 'running' | 'succeeded' = 'running', visibility = 'visible', reads = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    assert.equal(init?.method || 'GET', 'GET', 'viewing/filtering task history must never create generation requests')
    if (path === '/api/projects') return Response.json([a, b])
    if (path === '/api/providers' || path === '/api/models') return Response.json([])
    if (path.endsWith('/canvases')) return Response.json([])
    if (path.endsWith('/continuity')) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: path })
    if (path === '/api/projects/tasks-a') {
      reads++
      return Response.json({ ...a, jobs: [{ id: 'task', project_id: a.id, shot_id: null, model_id: null, job_type: 'generation',
        request: '{}', status, external_id: null, result_asset_id: null, recovery_available: false, error: null, created_at: timestamp }] })
    }
    if (path === '/api/projects/tasks-b') return Response.json(b)
    throw new Error(`Unexpected request: ${path}`)
  })
  const polls = new Map<number, () => Promise<void>>()
  let pollId = 200_000
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window), nativeClearTimeout = dom.window.clearTimeout.bind(dom.window)
  t.mock.method(dom.window, 'setTimeout', (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 4000) return nativeSetTimeout(handler, delay, ...args)
    const id = ++pollId; polls.set(id, () => (handler as (...args: unknown[]) => Promise<void>)(...args)); return id
  })
  t.mock.method(dom.window, 'clearTimeout', (id?: number) => { if (!polls.delete(id!)) nativeClearTimeout(id) })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  async function tick() {
    assert.equal(polls.size, 1, 'one shared project poll remains scheduled')
    const [id, poll] = [...polls.entries()][0]; polls.delete(id)
    await act(async () => poll()); await settle()
  }
  try {
    await act(() => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="任务记录"]')!.click()); await settle()
    assert.equal([...container.querySelectorAll('.topbar-actions button')].some(el => el.textContent === '配音'), false)
    assert.ok(container.querySelector('[aria-label="任务列表"]'))
    let before = reads
    await tick(); assert.equal(reads, before + 1, 'active tasks continue updating')
    visibility = 'hidden'; before = reads
    await tick(); assert.equal(reads, before, 'hidden history performs no project request')
    visibility = 'visible'
    await act(() => document.dispatchEvent(new Event('visibilitychange'))); await settle()
    assert.equal(reads, before + 1, 'returning to history refreshes immediately')
    status = 'succeeded'; await tick(); before = reads
    await tick(); assert.equal(reads, before, 'completed history stops automatic requests')
    const failedTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent?.startsWith('失败'))!
    await act(() => failedTab.click())
    assert.match(container.querySelector('.task-records')!.textContent!, /没有符合条件的任务/)
    await chooseCombobox(container.querySelector<HTMLInputElement>('input[aria-label="切换项目"]')!, '任务项目乙'); await settle()
    assert.match(container.querySelector('.task-records')!.textContent!, /还没有任务记录/)
    await chooseCombobox(container.querySelector<HTMLInputElement>('input[aria-label="切换项目"]')!, '任务项目甲'); await settle()
    assert.equal(container.querySelectorAll('.task-records tbody tr').length, 1, 'new project scope resets old filters')
    assert.equal(container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.textContent, '全部1')
  } finally {
    await act(() => root.unmount()); container.remove(); frames.clear()
    Reflect.deleteProperty(document, 'visibilityState')
  }
})

test('real App resumes video query and download through their original jobs without changing prompts or creating paid requests', async t => {
  const project = structuredClone(detail)
  project.jobs = (['verify', 'query', 'download'] as const).map(action => ({ id: `restart-${action}`, project_id: project.id,
    shot_id: null, model_id: 'video-model', job_type: 'generation', request: JSON.stringify({ prompt: `原提示词-${action}`, duration: 8 }),
    status: 'failed', external_id: action === 'query' ? 'vendor-existing' : null, result_asset_id: null, error: '服务重启',
    recovery_available: action === 'download', task_resume_available: action === 'query', recovery_action: action, recovery_modality: 'video', created_at: timestamp }))
  const originalRequests = new Map(project.jobs.map(job => [job.id, job.request]))
  const writes: Array<{ path: string; body: BodyInit | null | undefined }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url), method = init?.method || 'GET'
    if (method !== 'GET') {
      writes.push({ path, body: init?.body })
      assert.equal(method, 'POST')
      const match = /^\/api\/jobs\/(restart-query|restart-download)\/retry$/.exec(path)
      assert.ok(match, 'only existing-task query or download may be resumed')
      assert.equal(init?.body, undefined, 'resuming cannot supply a modified prompt or generation payload')
      const existing = project.jobs.find(job => job.id === match[1])!
      existing.status = 'queued'; existing.recovery_action = null
      return Response.json(existing)
    }
    if (path === '/api/projects') return Response.json([project])
    if (path === '/api/providers') return Response.json([{ id: 'provider', name: '测试提供商', adapter: 'http', enabled: true }])
    if (path === '/api/models') return Response.json([{ id: 'video-model', provider_id: 'provider', name: '视频模型', modality: 'video', enabled: true, settings: {} }])
    if (path === '/api/projects/refresh') return Response.json(project)
    if (path.endsWith('/canvases')) return Response.json([])
    if (path.endsWith('/continuity')) return Response.json({ shots: [], summary: { status: 'ready', error_count: 0, warning_count: 0 }, signature: 'recovery' })
    if (path === '/api/job-queue') return Response.json({ concurrency: 3, max_concurrency: 10, running: 0, queued: 0 })
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  dom.window.localStorage.clear(); dom.window.sessionStorage.clear(); frames.clear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><App /></MantineProvider>)); await settle()
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="任务记录"]')!.click()); await settle()
    assert.equal(writes.length, 0, 'mounting history never resumes or recreates generation work')
    const unknown = [...container.querySelectorAll('tbody tr')].find(row => row.textContent?.includes('原任务可能已被接收'))!
    assert.ok(unknown); assert.match(unknown.querySelector('.job-status')!.textContent!, /待核对/)
    assert.doesNotMatch(unknown.textContent!, /重试|继续查询|恢复下载/)
    const action = (label: string) => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)
      assert.ok(found, label); return found
    }
    await act(() => action('继续查询').click()); await settle()
    assert.match(container.textContent!, /原任务继续查询已入队/)
    await act(() => action('恢复下载').click()); await settle()
    assert.match(container.textContent!, /下载恢复任务已入队/)
    assert.deepEqual(writes.map(value => value.path), ['/api/jobs/restart-query/retry', '/api/jobs/restart-download/retry'])
    assert.ok(project.jobs.every(job => job.request === originalRequests.get(job.id)))
    assert.equal(project.jobs.find(job => job.id === 'restart-verify')!.status, 'failed')
  } finally { await act(() => root.unmount()); container.remove(); frames.clear() }
})
