import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { Asset, Model, ProjectDetail } from '../src/shared/api/api'
import { imageAnalysisSourceChanged, resolveCanvasImageAnalysisSource } from '../src/features/canvas/canvas-image-analysis'
import { canvasNodeCategory } from '../src/features/canvas/canvas-node-type-filter'
import { canvasPromptIndex, indexedCanvasPrompt } from '../src/features/canvas/canvas-performance'
import { freezeLegacyPromptReferenceDrafts, replaceConnectedPromptReference } from '../src/features/canvas/canvas-prompt-reference-graph'
import { visualBoardReferences, visualNodeAsset } from '../src/features/canvas/canvas-visual-profiles'
import { createImageVideoHandoff, fixedReferenceAsset, imageVideoConnection } from '../src/features/canvas/canvas-shot-workflow'
import { imageVideoSourceContext } from '../src/features/canvas/canvas-image-video-context'

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type: 'image_analysis', x: 0, y: 0, width: 420, height: 340, title: '图片反推提示词', text: '', prompt: '',
    asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {}, ...patch }
}

function fixture() {
  const analysis = node('analysis'), source = node('source', { type: 'image', title: '角色图', asset_id: 'original' })
  const detail = { id: 'project', assets: [
    { id: 'original', kind: 'image', project_id: 'project', filename: '原图.png' },
    { id: 'other', kind: 'image', project_id: 'project', filename: '另一张.png' },
    { id: 'foreign', kind: 'image', project_id: 'another', filename: '其他项目.png' },
    { id: 'video', kind: 'video', project_id: 'project', filename: '视频.mp4' },
  ], visual_profiles: [], shot_visual_bindings: [], jobs: [], asset_tasks: [] } as unknown as ProjectDetail
  const graph: CanvasGraph = { nodes: [analysis, source], edges: [], revision: 'r' }
  return { analysis, source, detail, graph }
}

test('analysis resolves an uploaded source or a pinned image connection without mutating the graph', () => {
  const { analysis, graph, detail } = fixture(), before = structuredClone(graph)
  assert.match(resolveCanvasImageAnalysisSource(analysis, graph, detail).issue || '', /请上传/)
  assert.deepEqual(resolveCanvasImageAnalysisSource({ ...analysis, asset_id: 'original' }, graph, detail), { assetId: 'original' })
  graph.edges = [{ id: 'edge', source: 'source', target: analysis.id, reference_asset_id: 'other' }]
  assert.deepEqual(resolveCanvasImageAnalysisSource(analysis, graph, detail), { assetId: 'other', sourceNodeId: 'source' })
  assert.deepEqual(graph.nodes, before.nodes)
  assert.deepEqual(graph.edges, [{ id: 'edge', source: 'source', target: analysis.id, reference_asset_id: 'other' }])
})

test('analysis deduplicates the same image but rejects conflicting uploads or multiple different connected images', () => {
  const { analysis, source, graph, detail } = fixture()
  graph.edges = [{ id: 'edge', source: source.id, target: analysis.id }]
  assert.deepEqual(resolveCanvasImageAnalysisSource({ ...analysis, asset_id: 'original' }, graph, detail), { assetId: 'original', sourceNodeId: source.id })
  assert.match(resolveCanvasImageAnalysisSource({ ...analysis, asset_id: 'other' }, graph, detail).issue || '', /一次只分析一张/)
  graph.nodes.push({ ...source, id: 'second', asset_id: 'other' })
  graph.edges.push({ id: 'second-edge', source: 'second', target: analysis.id })
  assert.match(resolveCanvasImageAnalysisSource(analysis, graph, detail).issue || '', /一次只分析一张/)
  graph.nodes[2].asset_id = 'original'
  assert.equal(resolveCanvasImageAnalysisSource(analysis, graph, detail).assetId, 'original')
})

test('analysis source rejects foreign, missing and non-image assets and text-output connections', () => {
  const { analysis, source, graph, detail } = fixture()
  for (const asset_id of ['foreign', 'missing', 'video']) {
    assert.match(resolveCanvasImageAnalysisSource({ ...analysis, asset_id }, graph, detail).issue || '', /图片已失效/)
    graph.edges = [{ id: 'edge', source: source.id, target: analysis.id, reference_asset_id: asset_id }]
    assert.match(resolveCanvasImageAnalysisSource(analysis, graph, detail).issue || '', /尚无可用图片/)
  }
  for (const type of ['text', 'image_analysis', 'project_script_ref', 'video'] as const) {
    graph.nodes = [analysis, { ...source, type }]
    graph.edges = [{ id: 'edge', source: source.id, target: analysis.id, reference_asset_id: 'original' }]
    assert.match(resolveCanvasImageAnalysisSource(analysis, graph, detail).issue || '', /仅支持连接图片节点/)
  }
  graph.nodes = [analysis, { ...source, type: 'generation', settings: { modality: 'video' } }]
  assert.match(resolveCanvasImageAnalysisSource(analysis, graph, detail).issue || '', /仅支持连接图片节点/)
})

test('profile inputs analyze their approved image while an explicit pin preserves the selected candidate', () => {
  const { analysis, source, graph, detail } = fixture()
  detail.visual_profiles = [{ id: 'profile', board_asset_id: 'original' }] as ProjectDetail['visual_profiles']
  graph.nodes = [analysis, { ...source, type: 'generation', asset_id: 'other', settings: { modality: 'image', visual_profile_id: 'profile' } }]
  graph.edges = [{ id: 'edge', source: source.id, target: analysis.id }]
  assert.equal(resolveCanvasImageAnalysisSource(analysis, graph, detail).assetId, 'original')
  graph.edges[0].reference_asset_id = 'other'
  assert.equal(resolveCanvasImageAnalysisSource(analysis, graph, detail).assetId, 'other')
})

test('analysis output contributes editable text downstream and belongs to the text filter', () => {
  const { analysis, graph, detail } = fixture(), target = node('target', { type: 'generation', prompt: '电影级画面' })
  analysis.asset_id = 'original'; analysis.text = '  低机位中景，暖色侧逆光。  '
  graph.nodes.push(target)
  graph.edges = [{ id: 'edge', source: analysis.id, target: target.id }]
  assert.equal(indexedCanvasPrompt(target, canvasPromptIndex(graph, []), () => ''), '低机位中景，暖色侧逆光。\n\n电影级画面')
  analysis.text = '用户已编辑的专业提示词'
  assert.equal(indexedCanvasPrompt(target, canvasPromptIndex(graph, []), () => ''), '用户已编辑的专业提示词\n\n电影级画面')
  assert.equal(canvasNodeCategory(analysis, new Map<string, Model>(), new Map<string, Asset>(detail.assets.map(asset => [asset.id, asset]))), 'text')
})

test('analysis preview image never passes downstream as a profile-board reference, even on a pinned text edge', () => {
  const { analysis, graph, detail } = fixture()
  analysis.asset_id = 'original'
  graph.edges = [{ id: 'edge', source: analysis.id, target: 'target', reference_asset_id: 'original' }]
  assert.equal(visualNodeAsset(analysis, detail)?.id, 'original')
  assert.equal(visualNodeAsset(analysis, detail, true), undefined)
  assert.deepEqual(visualBoardReferences(graph, 'target', detail), { reference_profile_ids: [], reference_asset_ids: [] })
  assert.deepEqual(fixedReferenceAsset(graph, 'target', detail.assets), [])
  const target = node('target', { type: 'generation', settings: { modality: 'image' } })
  graph.nodes.push(target)
  const replaced = replaceConnectedPromptReference(graph, target.id, 'original', null, detail)
  assert.equal(replaced, graph, 'an image-reference edit must not remove a text-output edge')
})

test('analysis keeps edited prose and tracks only an actual successful source change', () => {
  const { analysis, graph, detail } = fixture()
  analysis.text = '参考图1的构图，保留窗边侧光'
  analysis.settings.image_analysis_source_asset_id = 'original'
  analysis.settings.prompt_is_final = true
  assert.equal(imageAnalysisSourceChanged(analysis, 'original'), false)
  assert.equal(imageAnalysisSourceChanged(analysis, 'other'), true)
  assert.equal(imageAnalysisSourceChanged(analysis), true)
  assert.equal(imageAnalysisSourceChanged({ ...analysis, text: '' }, 'other'), false)
  assert.equal(imageAnalysisSourceChanged({ ...analysis, settings: {} }, 'other'), false)
  assert.equal(freezeLegacyPromptReferenceDrafts(graph, detail), graph, 'analysis is authored text, not a media reference document')
})

test('analysis source image cannot be mistaken for a generated storyboard frame', () => {
  const { analysis, graph, detail } = fixture(), video = node('video', { type: 'generation', settings: { modality: 'video' } })
  analysis.asset_id = 'original'
  assert.equal(imageVideoConnection(analysis, video, detail, []), undefined)
  assert.equal(imageVideoConnection(video, analysis, detail, []), undefined)
  assert.throws(() => createImageVideoHandoff(graph, analysis, detail, [], video, 'edge'), /请先生成或选择一张分镜图片/)
})

test('image-to-video context inherits analysis prose and excludes the analysis input image', () => {
  const { analysis, graph, detail } = fixture(), target = node('target', { type: 'generation', prompt: '静态首帧构图', settings: { modality: 'image' } })
  analysis.text = '电影中景，暗红服装，柔和顶光'; analysis.asset_id = 'original'
  detail.shots = []
  graph.nodes.push(target)
  graph.edges = [{ id: 'analysis-text', source: analysis.id, target: target.id, reference_asset_id: 'original' }]
  const context = imageVideoSourceContext(graph, target, detail, [])
  assert.match(context.body, /电影中景，暗红服装，柔和顶光/)
  assert.deepEqual(context.referenceAssetIds, [])
  detail.assets = detail.assets.filter(asset => asset.id !== 'original')
  assert.deepEqual(imageVideoSourceContext(graph, target, detail, []).referenceAssetIds, [], 'text links do not validate their input image as a downstream reference')
})
