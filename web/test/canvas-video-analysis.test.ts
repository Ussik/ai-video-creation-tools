import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import type { Asset, Model, ProjectDetail, Provider } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { resolveCanvasVideoAnalysisSource, videoAnalysisModels, videoAnalysisRangeIssue, videoAnalysisSourceChanged, videoAnalysisTime } from '../src/features/canvas/canvas-video-analysis'

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'video_analysis', x: 0, y: 0, width: 420, height: 340,
  title: '视频反推提示词', text: '', prompt: '', asset_id: null, model_id: null, shot_id: null, job_id: null, settings: {}, ...patch })
const assets = [
  { id: 'old', kind: 'video', filename: '原视频.mp4', project_id: 'project' },
  { id: 'new', kind: 'video', filename: '新视频.mp4', project_id: 'project' },
  { id: 'image', kind: 'image', filename: '图片.png', project_id: 'project' },
  { id: 'foreign', kind: 'video', filename: '其他项目.mp4', project_id: 'other' },
] as Asset[]
function fixture() {
  const analysis = node('analysis'), source = node('source', { type: 'video', asset_id: 'old' })
  const graph: CanvasGraph = { revision: 'r', nodes: [analysis, source], edges: [] }
  const detail = { id: 'project', assets, visual_profiles: [] } as unknown as ProjectDetail
  return { analysis, source, graph, detail }
}

test('video analysis accepts one uploaded asset and pins the chosen source version when a generator changes', () => {
  const { analysis, source, graph, detail } = fixture()
  assert.match(resolveCanvasVideoAnalysisSource(analysis, graph, detail).issue || '', /请上传一个视频/)
  assert.deepEqual(resolveCanvasVideoAnalysisSource({ ...analysis, asset_id: 'old' }, graph, detail), { assetId: 'old' })
  graph.nodes[1] = { ...source, type: 'generation', asset_id: 'new', settings: { modality: 'video' } }
  graph.edges = [{ id: 'edge', source: source.id, target: analysis.id, reference_asset_id: 'old' }]
  const before = structuredClone(graph)
  assert.deepEqual(resolveCanvasVideoAnalysisSource(analysis, graph, detail), { assetId: 'old', sourceNodeId: source.id })
  assert.deepEqual(graph, before)
  assert.deepEqual(resolveCanvasVideoAnalysisSource({ ...analysis, asset_id: 'old' }, graph, detail), { assetId: 'old', sourceNodeId: source.id })
  assert.match(resolveCanvasVideoAnalysisSource({ ...analysis, asset_id: 'new' }, graph, detail).issue || '', /一次只分析一个视频/)
})

test('video analysis refuses ambiguous, missing, foreign and non-video inputs before requesting a model', () => {
  const { analysis, source, graph, detail } = fixture()
  for (const asset_id of ['missing', 'foreign', 'image']) {
    assert.match(resolveCanvasVideoAnalysisSource({ ...analysis, asset_id }, graph, detail).issue || '', /视频已失效/)
    graph.edges = [{ id: 'edge', source: source.id, target: analysis.id, reference_asset_id: asset_id }]
    assert.match(resolveCanvasVideoAnalysisSource(analysis, graph, detail).issue || '', /尚无可用视频/)
  }
  graph.edges = [{ id: 'edge', source: source.id, target: analysis.id, reference_asset_id: 'old' }]
  for (const type of ['text', 'image_analysis', 'video_analysis', 'image', 'project_script_ref'] as const) {
    graph.nodes[1] = { ...source, type }
    assert.match(resolveCanvasVideoAnalysisSource(analysis, graph, detail).issue || '', /仅支持连接视频节点/)
  }
  graph.nodes[1] = { ...source, type: 'generation', settings: { modality: 'image' } }
  assert.match(resolveCanvasVideoAnalysisSource(analysis, graph, detail).issue || '', /仅支持连接视频节点/)
  graph.nodes[1] = source
  graph.nodes.push({ ...source, id: 'second', asset_id: 'new' })
  graph.edges.push({ id: 'second-edge', source: 'second', target: analysis.id })
  assert.match(resolveCanvasVideoAnalysisSource(analysis, graph, detail).issue || '', /一次只分析一个视频/)
})

test('video model choices require explicit Doubao capability and an enabled HTTP provider', () => {
  const providers = [{ id: 'online', enabled: true, adapter: 'http' }, { id: 'offline', enabled: false, adapter: 'http' },
    { id: 'demo', enabled: true, adapter: 'demo' }] as Provider[]
  const base: Model = { id: 'chat', name: '豆包', remote_id: 'doubao-seed', provider_id: 'online', modality: 'text', protocol: 'chat_completions', enabled: true,
    settings: { supports_video: true, video_input_format: 'doubao_ark' }, is_default: true }
  const models: Model[] = [base, { ...base, id: 'responses', protocol: 'responses', is_default: false },
    { ...base, id: 'disabled', enabled: false }, { ...base, id: 'vision', settings: { supports_vision: true } },
    { ...base, id: 'generic', settings: { supports_video: true } }, { ...base, id: 'image', modality: 'image' },
    { ...base, id: 'offline', provider_id: 'offline' }, { ...base, id: 'demo', provider_id: 'demo' }, { ...base, id: 'missing', provider_id: 'missing' }]
  assert.deepEqual(videoAnalysisModels(models, providers), [{ id: 'chat', label: '豆包', is_default: true }, { id: 'responses', label: '豆包' }])
})

test('90-second full videos and selected ranges are valid while long or out-of-bounds ranges are rejected', () => {
  assert.equal(videoAnalysisRangeIssue(0, null, 90_000), '')
  assert.equal(videoAnalysisRangeIssue(20_000, 110_000, 180_000), '')
  assert.equal(videoAnalysisRangeIssue(0, 180_000, 180_000), '')
  assert.equal(videoAnalysisRangeIssue(0, 1000, 90_000), '')
  assert.match(videoAnalysisRangeIssue(0, 999, 90_000), /至少选择 1 秒/)
  assert.equal(videoAnalysisRangeIssue(0, null), '')
  assert.match(videoAnalysisRangeIssue(0, null, 180_001), /每次最多分析 180 秒/)
  assert.match(videoAnalysisRangeIssue(30_000, 20_000, 90_000), /结束时间必须晚于/)
  assert.match(videoAnalysisRangeIssue(0, 91_000, 90_000), /超出视频时长/)
  assert.match(videoAnalysisRangeIssue(90_000, null, 90_000), /结束时间必须晚于/)
  for (const value of [-1, .5, NaN, Infinity]) assert.match(videoAnalysisRangeIssue(value, null, 90_000), /有效/)
  assert.match(videoAnalysisRangeIssue(0, NaN, 90_000), /有效/)
  assert.equal(videoAnalysisTime(91_234), '1:31.23')
})

test('source changes mark results stale without clearing editable analysis', () => {
  const result = { asset_id: 'old', global_style: '手工编辑的视觉描述' } as VideoPromptAnalysisResult
  assert.equal(videoAnalysisSourceChanged(result, 'old'), false)
  assert.equal(videoAnalysisSourceChanged(result, 'new'), true)
  assert.equal(videoAnalysisSourceChanged(result), true)
  assert.equal(videoAnalysisSourceChanged(undefined, 'new'), false)
  assert.equal(result.global_style, '手工编辑的视觉描述')
})
