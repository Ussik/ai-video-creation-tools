import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, Job, Model, ProjectDetail, Shot } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { importShotGraph } from '../src/features/canvas/canvas-shot-import'

const models = [{ id: 'image', modality: 'image', settings: {}, enabled: true },
  { id: 'video', modality: 'video', settings: {}, enabled: true }] as Model[]
const shot = { id: 'shot', project_id: 'project', title: '雨中的站台', position: 0, duration: 8,
  prompt: '候车', image_prompt: '雨中站台全景', video_prompt: '推近等车的人', storyboard_revision: 2,
  selected_asset_id: null, source_scene_id: null, start_state: '', end_state: '', cut_note: '' } as Shot
function blankNode(type: CanvasNode['type'], x: number, y: number): CanvasNode {
  return { id: crypto.randomUUID(), type, x, y, width: 440, height: 420, title: '', text: '', prompt: '',
    asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }
}
const graph = (): CanvasGraph => ({ nodes: [], edges: [], revision: 'a'.repeat(64) })
const detail = (assets: Asset[] = [], jobs: Job[] = []) => ({ id: 'project', ratio: '16:9', assets, jobs } as ProjectDetail)
const restore = (g: CanvasGraph, shots: Shot[], d: ProjectDetail) => importShotGraph(g, shots, d, models, models, blankNode, node => ({ height: node.height }))

test('selected imports include historical/no-scene shots and reuse nodes on repeat without mutating input', () => {
  const original = graph(), d = detail()
  const historical = { ...shot, superseded_by: 'new-design', design_id: 'old-design' }
  const result = restore(original, [historical], d)
  assert.equal(original.nodes.length, 0)
  assert.equal(result.addedShots, 1)
  assert.equal(result.graph.nodes[0].prompt, shot.image_prompt)
  assert.equal(result.graph.nodes[0].settings.storyboard_revision, 2)
  const repeated = restore(result.graph, [historical], d)
  assert.equal(repeated.graph, result.graph)
  assert.equal(repeated.addedShots, 0)
})

test('imports restore only current-revision tasks and fixed references, keeping completed assets connected', () => {
  const reference = { id: 'reference', kind: 'image', filename: '人物.png', shot_id: null, source: 'generated' } as Asset
  const resultAsset = { id: 'result', kind: 'video', filename: '站台.mp4', shot_id: shot.id, source: 'generated' } as Asset
  const obsolete = { id: 'obsolete', kind: 'video', filename: '旧站台.mp4', shot_id: shot.id, source: 'generated' } as Asset
  const job = { id: 'current-job', job_type: 'generation', shot_id: shot.id, model_id: 'video', result_asset_id: resultAsset.id,
    request: JSON.stringify({ storyboard_revision: 2, mode: 'reference', duration: 8, ratio: '16:9',
      prompt: '完整视频提示词', visual_source_prompt: '用户原始视频提示词', reference_asset_ids: [reference.id] }) } as Job
  const oldJob = { ...job, id: 'old-job', result_asset_id: obsolete.id, request: JSON.stringify({ storyboard_revision: 1 }) }
  const imported = restore(graph(), [shot], detail([reference, resultAsset, obsolete], [oldJob, job]))
  const generation = imported.graph.nodes.find(node => node.type === 'generation')!
  assert.equal(generation.job_id, job.id)
  assert.equal(generation.prompt, '用户原始视频提示词')
  assert.equal(generation.asset_id, resultAsset.id)
  assert.ok(imported.graph.edges.some(edge => edge.target === generation.id && edge.reference_asset_id === reference.id))
  assert.ok(imported.graph.nodes.some(node => node.asset_id === resultAsset.id && node.type === 'video'))
  assert.ok(!imported.graph.nodes.some(node => node.asset_id === obsolete.id))
})

test('restoring only a shot creates an empty generator while its old output remains recycled', () => {
  const history = { id: 'preserved-job', job_type: 'generation', shot_id: shot.id, model_id: 'video',
    status: 'succeeded', result_asset_id: 'still-recycled-output',
    request: JSON.stringify({ storyboard_revision: 2, prompt: '旧任务仍保留在历史中' }) } as Job
  const imported = restore(graph(), [shot], detail([], [history]))
  const generation = imported.graph.nodes.find(node => node.type === 'generation')!
  assert.equal(generation.job_id, null)
  assert.equal(generation.asset_id, null)
  assert.equal(generation.prompt, shot.image_prompt)
  assert.equal(imported.addedShots, 1)
})

test('live references remain usable when their historical owner shot is recycled', () => {
  const reference = { id: 'recovered-reference', kind: 'image', filename: '已恢复参考.png',
    shot_id: 'recycled-owner', source: 'generated' } as Asset
  const job = { id: 'live-job', job_type: 'generation', shot_id: shot.id, model_id: 'video', result_asset_id: null,
    request: JSON.stringify({ storyboard_revision: 2, reference_asset_ids: [reference.id] }) } as Job
  const imported = restore(graph(), [shot], detail([reference], [job]))
  const node = imported.graph.nodes.find(item => item.asset_id === reference.id)!
  assert.equal(node.shot_id, null, 'the media history keeps its owner without reattaching a recycled shot')
  assert.ok(imported.graph.edges.some(edge => edge.source === node.id))
  assert.equal(reference.shot_id, 'recycled-owner')
})

test('capacity reporting lets managed imports reject partial results before saving the target graph', () => {
  const full = graph()
  full.nodes = Array.from({ length: 500 }, (_, i) => ({ ...blankNode('text', 0, i * 10), id: `existing-${i}` }))
  const imported = restore(full, [shot], detail())
  assert.equal(imported.hitLimit, true)
  assert.equal(imported.graph, full)
  assert.equal(imported.firstImported, null)
  assert.equal(full.nodes.length, 500)
})

test('edge capacity is reported before a managed import can save disconnected references', () => {
  const reference = { id: 'reference', kind: 'image', filename: '人物.png', shot_id: null, source: 'generated' } as Asset
  const job = { id: 'job', job_type: 'generation', shot_id: shot.id, model_id: 'video', result_asset_id: null,
    request: JSON.stringify({ storyboard_revision: 2, reference_asset_ids: [reference.id], prompt: '推近' }) } as Job
  const fullEdges = graph()
  fullEdges.edges = Array.from({ length: 1000 }, (_, index) => ({ id: `edge-${index}`, source: 'a', target: 'b' }))
  const imported = restore(fullEdges, [shot], detail([reference], [job]))
  assert.equal(imported.hitLimit, true)
  assert.equal(imported.graph.edges.length, 1000)
  assert.equal(fullEdges.nodes.length, 0, 'the caller can reject this graph atomically')
})
