import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, Job, Model, ProjectDetail, ScriptCanvasResult, Shot, VisualProfile, ShotVisualBinding } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { importStoryboardGraph } from '../src/features/canvas/canvas-storyboard-import'

const models = [{ id: 'image', modality: 'image', settings: {}, enabled: true }, { id: 'video', modality: 'video', settings: {}, enabled: true }] as Model[]
const shot = { id: 'shot', project_id: 'project', design_id: 'design', source_scene_id: 'scene', title: '回望', position: 0,
  prompt: '回望', image_prompt: '站台上的人物', video_prompt: '慢慢回头', duration: 8, storyboard_revision: 2,
  selected_asset_id: null, start_state: '', end_state: '', cut_note: '' } as Shot
const profile = { id: 'profile', project_id: 'project', design_id: 'design', kind: 'character', name: '林晚', variant: '默认',
  definition: '深色外衣', view_requirements: '正面', revision: 3, board_asset_id: 'new-board' } as VisualProfile
const binding = { ...profile, profile_id: profile.id, shot_id: shot.id, revision: 2, board_asset_id: 'old-board',
  required: true, usage: 'both', reference_assets: [] } as unknown as ShotVisualBinding
const result = { scene_ids: ['scene'], design_id: 'design', target_canvas_id: 'target', shots: [shot], visual_profiles: [profile],
  shot_visual_bindings: [binding], created_profiles: 0, created_shots: 0 } as ScriptCanvasResult
const graph = (): CanvasGraph => ({ nodes: [], edges: [], revision: 'target-revision' })
function blank(type: CanvasNode['type'], x: number, y: number): CanvasNode {
  return { id: crypto.randomUUID(), type, x, y, width: 440, height: 420, title: '', text: '', prompt: '',
    asset_id: null, shot_id: null, model_id: null, job_id: null, settings: {} }
}
function fixture(jobs: Job[] = []): ProjectDetail {
  return { id: 'project', ratio: '16:9', shots: [shot], assets: ['old-board', 'new-board', 'output'].map(id => ({ id, kind: 'image' })) as Asset[],
    jobs, visual_profiles: [profile], shot_visual_bindings: [binding] } as ProjectDetail
}
const restore = (g: CanvasGraph, r = result, d = fixture()) => importStoryboardGraph(g, r, d, models, models, blank, node => ({ height: node.height }))

test('a valid preparation cache still restores profile and exact old reference nodes, then reuses them', () => {
  const original = graph(), imported = restore(original)
  assert.deepEqual(original.nodes, [])
  assert.equal(imported.graph.revision, original.revision)
  assert.equal(imported.addedProfiles, 1)
  assert.equal(imported.graph.nodes.filter(node => node.settings.visual_profile_id === 'profile').length, 1)
  assert.equal(imported.graph.nodes.filter(node => node.asset_id === 'old-board').length, 1)
  const image = imported.graph.nodes.find(node => node.shot_id === 'shot' && node.type === 'generation')!
  assert.equal(image.settings.visual_dependencies, true)
  const repeated = restore(imported.graph)
  assert.equal(repeated.graph, imported.graph)
  assert.equal(repeated.addedProfiles, 0)
  assert.equal(repeated.addedReferences, 0)
})

test('historical job snapshots, final prompts and local edits survive adding missing references', () => {
  const historical = { ...shot, superseded_by: 'next-design' }
  const job = { id: 'job', shot_id: shot.id, model_id: 'image', job_type: 'generation', status: 'succeeded', result_asset_id: 'output',
    request: JSON.stringify({ storyboard_revision: 2, reference_asset_ids: ['old-board'], prompt: '已确认精确提示词',
      prompt_is_final: true, visual_source_prompt: '当时的镜头描述' }) } as Job
  const input = { ...result, shots: [historical] }, detail = { ...fixture([job]), shots: [], historical_shots: [historical] }
  const first = restore(graph(), input, detail)
  const node = first.graph.nodes.find(node => node.job_id === 'job')!
  assert.equal(node.prompt, '当时的镜头描述'); assert.equal(node.text, '已确认精确提示词')
  assert.equal(node.asset_id, 'output')
  const edited = { ...first.graph, nodes: first.graph.nodes.map(item => item.id === node.id ? { ...item, text: '本地未提交修改', x: 1234 } : item) }
  const repeated = restore(edited, input, detail)
  assert.equal(repeated.graph, edited)
  assert.equal(repeated.graph.nodes.find(item => item.id === node.id)!.text, '本地未提交修改')
  assert.equal(repeated.graph.edges.filter(edge => edge.reference_asset_id === 'old-board').length, 1)
})

test('video job restore retains its input and adds one image dependency node without replacing the video', () => {
  const job = { id: 'video-job', shot_id: shot.id, model_id: 'video', job_type: 'generation', status: 'running',
    request: JSON.stringify({ storyboard_revision: 2, reference_asset_ids: ['old-board'], prompt: '已确认动作' }) } as Job
  const detail = fixture([job]), first = restore(graph(), result, detail)
  assert.equal(first.graph.nodes.filter(node => node.job_id === 'video-job').length, 1)
  assert.equal(first.graph.nodes.filter(node => node.shot_id === shot.id && node.model_id === 'image').length, 1)
  const repeated = restore(first.graph, result, detail)
  assert.equal(repeated.graph, first.graph)
  assert.equal(repeated.graph.nodes.find(node => node.job_id === 'video-job')!.prompt, '已确认动作')
})

test('capacity rejection keeps the caller graph unchanged', () => {
  const full = { ...graph(), nodes: Array.from({ length: 500 }, () => blank('text', 0, 0)) }
  const before = structuredClone(full)
  assert.throws(() => restore(full), /500|容量/)
  assert.deepEqual(full, before)
})
