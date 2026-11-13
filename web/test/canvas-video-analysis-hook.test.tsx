import assert from 'node:assert/strict'
import { after, beforeEach, test, type TestContext } from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createRoot } from 'react-dom/client'
import { videoAnalysisText, type VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { ProjectDetail } from '../src/shared/api/api'
import { useCanvasVideoAnalysis } from '../src/features/canvas/useCanvasVideoAnalysis'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
after(() => dom.window.close())
beforeEach(() => dom.window.localStorage.clear())

const result: VideoPromptAnalysisResult = { asset_id: 'video', model_id: 'doubao', duration_ms: 90_000, start_ms: 0, end_ms: 90_000, fps: 2,
  global_style: '山海国漫画风', uncertainties: ['声音未分析'], shots: [{ title: '踏步出剑', start_ms: 0, end_ms: 6000,
    start_state: '右脚后撤', action: '向前踏步挥剑', end_state: '尘浪扩散', camera: '低机位跟随', vfx: '剑气切开石阶',
    image_prompt: '人物持剑横于胸前', video_prompt: '人物向前踏步挥剑，剑气切开石阶，尘浪随后扩散。', uncertainties: [] }] }
const analysisNode: CanvasNode = { id: 'analysis', type: 'video_analysis', x: 0, y: 0, width: 420, height: 340, title: '视频反推',
  text: '', prompt: '', asset_id: 'video', model_id: 'doubao', shot_id: null, job_id: null, settings: { video_analysis_fps: 2 } }

async function mount(t: TestContext, initial: Partial<CanvasNode> = {}) {
  let graph: CanvasGraph = { revision: 'r', nodes: [{ ...analysisNode, ...initial }], edges: [] }
  let visibleGraph: CanvasGraph | null = graph, canvasId = 'canvas-a'
  let hook: ReturnType<typeof useCanvasVideoAnalysis>
  const writes: CanvasGraph[] = [], notices: string[] = []
  const requests: { url: string; init: RequestInit; resolve: (response: Response) => void }[] = []
  const detail = { id: 'project', assets: [{ id: 'video', project_id: 'project', kind: 'video', filename: 'source.mp4' }], visual_profiles: [] } as unknown as ProjectDetail
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => await new Promise<Response>(resolve => {
    requests.push({ url: String(url), init, resolve })
    // Intentionally ignore abort here so late upstream/mock responses exercise
    // the hook's own ownership guards as well as its AbortSignal.
  }))
  function Harness() {
    hook = useCanvasVideoAnalysis({ detail, canvasId, graph: visibleGraph, getGraph: () => graph, models: [{ id: 'doubao' }],
      changeGraph: update => { graph = update(graph); writes.push(graph) }, refresh: async () => {}, notice: message => notices.push(message) })
    return null
  }
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async () => { await act(() => root.render(<Harness />)) }
  await render()
  return {
    get hook() { return hook! }, get graph() { return graph }, writes, notices, requests,
    begin: async () => { const count = requests.length; let pending!: Promise<void>; await act(() => { pending = hook!.analyze('analysis') }); for (let index = 0; requests.length === count && index < 100; index++) await act(() => new Promise(resolve => setTimeout(resolve, 1))); return { pending } },
    rerender: async (options: { canvasId?: string; visibleGraph?: CanvasGraph | null; graph?: CanvasGraph } = {}) => {
      if (options.canvasId !== undefined) canvasId = options.canvasId
      if (options.graph !== undefined) graph = options.graph
      if ('visibleGraph' in options) visibleGraph = options.visibleGraph ?? null
      else visibleGraph = graph
      await render()
    },
    resolve: async (index: number, pending: Promise<void>, output = result) => {
      await act(async () => { requests[index].resolve(Response.json(requests[index].url.includes('/ai-operations/') ? { id: requests[index].url.split('/').at(-1), state: 'completed', status_code: 200, result: output } : output)); await pending })
    },
    destroy: async () => { await act(() => root.unmount()); container.remove() },
  }
}

test('analysis sends only source and focus, then saves the structured result and matching editable text', async t => {
  const view = await mount(t)
  try {
    const { pending } = await view.begin()
    assert.equal(view.requests.length, 1)
    assert.equal(view.requests[0].url, '/api/projects/project/canvas/video-prompt-analysis')
    assert.deepEqual(JSON.parse(String(view.requests[0].init.body)), { asset_id: 'video', model_id: 'doubao', instructions: '', start_ms: 0, end_ms: null, fps: 2 })
    await view.resolve(0, pending)
    assert.equal(view.writes.length, 1)
    assert.deepEqual(view.graph.nodes[0].settings.video_analysis_result, result)
    assert.equal(view.graph.nodes[0].text, videoAnalysisText(result))
    assert.equal(view.hook.run, null)
    assert.equal(view.notices.length, 1)
  } finally { await view.destroy() }
})

test('unloading a canvas cancels analysis even while getGraph still points to the previous save queue', async t => {
  const view = await mount(t)
  try {
    const { pending } = await view.begin()
    await view.rerender({ visibleGraph: null })
    assert.equal(view.requests[0].init.signal?.aborted, true)
    assert.equal(view.hook.run, null)
    await view.resolve(0, pending)
    assert.equal(view.writes.length, 0)
    assert.equal(view.graph.nodes[0].settings.video_analysis_result, undefined)
    assert.deepEqual(view.notices, [])
  } finally { await view.destroy() }
})

test('changing canvas ownership aborts an old request and ignores late output even when node ids coincide', async t => {
  const view = await mount(t)
  try {
    const { pending } = await view.begin()
    await view.rerender({ canvasId: 'canvas-b', graph: structuredClone(view.graph) })
    assert.equal(view.requests[0].init.signal?.aborted, true)
    assert.equal(view.hook.run, null, 'the new canvas must not retain a canceled busy state')
    await view.resolve(0, pending)
    assert.equal(view.writes.length, 0)
    assert.equal(view.graph.nodes[0].settings.video_analysis_result, undefined)
    assert.deepEqual(view.notices, [])
  } finally { await view.destroy() }
})

test('human edits leave the running request alone but prevent its late result from overwriting the draft', async t => {
  const original = { ...result, global_style: '原先已编辑画风' }
  const view = await mount(t, { text: videoAnalysisText(original), settings: { video_analysis_fps: 2, video_analysis_result: original } })
  try {
    const { pending } = await view.begin()
    const edited = { ...original, global_style: '刚刚修改的画风', shots: original.shots.map(shot => ({ ...shot, video_prompt: '刚刚修改的动作要求' })) }
    await view.rerender({ graph: { ...view.graph, nodes: [{ ...view.graph.nodes[0], text: videoAnalysisText(edited), settings: { ...view.graph.nodes[0].settings, video_analysis_result: edited } }] } })
    assert.equal(view.requests[0].init.signal?.aborted, false)
    assert.equal(view.hook.run?.phase, 'analyzing')
    await view.resolve(0, pending)
    assert.equal(view.writes.length, 0)
    assert.deepEqual(view.graph.nodes[0].settings.video_analysis_result, edited)
    assert.equal(view.graph.nodes[0].text, videoAnalysisText(edited))
    assert.match(view.hook.errors.analysis, /人工内容已变化.*未覆盖/)
    assert.equal(view.hook.run, null)
  } finally { await view.destroy() }
})

test('cancel followed by a new request cannot let the old response overwrite or clear the new run', async t => {
  const view = await mount(t)
  try {
    const first = await view.begin()
    await act(() => view.hook.cancel())
    assert.equal(view.requests[0].init.signal?.aborted, true)
    const second = await view.begin()
    assert.equal(view.requests.length, 2)
    assert.ok(view.requests[1].url.includes('/ai-operations/'), 'explicit continuation observes the original request')
    assert.equal(view.requests[1].init.method, undefined)
    await view.resolve(0, first.pending)
    assert.equal(view.writes.length, 0)
    assert.equal(view.hook.run?.phase, 'analyzing')
    assert.equal(view.requests[1].init.signal?.aborted, false)
    await view.resolve(1, second.pending)
    assert.equal(view.writes.length, 1)
    assert.equal(view.hook.run, null)
  } finally { await view.destroy() }
})
