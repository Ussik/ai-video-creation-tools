import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Model, ProjectDetail, ScriptCanvasResult, VisualProfile, VisualProfileDraft } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { newVisualProfileDrafts, orderedVisualProfiles, visualProfileBaseChain, visualProfileBaseReadiness, visualProfileDraftRelationError } from '../src/features/visuals/visual-profile-inheritance'
import { automaticVisualReferenceEdges, missingVisualReferences, visualProfileDependencyEdges } from '../src/features/canvas/canvas-visual-profiles'
import { enqueueCanvasVisualBoard, prepareCanvasVisualBoard } from '../src/features/canvas/canvas-reference-generation'
import { addScriptCanvasNodes, scriptCanvasInitialFocus } from '../src/features/script/script-canvas-handoff'

const base = { id: 'base', project_id: 'project', kind: 'character', name: '林晚', variant: '基础', definition: '黑色短发，脸型固定', view_requirements: '正侧背面',
  revision: 1, base_profile_id: null, state_delta: '', board_asset_id: null, asset_task_id: null, board_prompt: '基础设定' } as VisualProfile
const state = { ...base, id: 'state', variant: '雨夜', base_profile_id: base.id, state_delta: '深色雨衣，衣摆湿透' }
const node = (profile: VisualProfile): CanvasNode => ({ id: `node-${profile.id}`, type: 'generation', title: profile.variant, settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: 1 },
  x: 0, y: 0, width: 440, height: 420, text: '', prompt: '', asset_id: null, shot_id: null, model_id: null, job_id: null })
const shotNode = { ...node(base), id: 'shot-node', shot_id: 'shot', settings: { modality: 'image', visual_dependencies: true } } as CanvasNode
const graph = (): CanvasGraph => ({ nodes: [node(base), node(state), shotNode], edges: [], revision: 'v1', viewport: { x: 0, y: 0, zoom: 1 } })
const detail = (): ProjectDetail => ({ id: 'project', assets: [], jobs: [], asset_tasks: [], visual_profiles: [base, state], shot_visual_bindings: [
  { ...state, profile_id: state.id, shot_id: 'shot', required: true },
] }) as ProjectDetail
const draft = (patch: Partial<VisualProfileDraft> = {}): VisualProfileDraft => ({ kind: 'character', name: '林晚', variant: '基础', definition: '固定脸型', view_requirements: '三视图', scene_ids: [], ...patch })

test('inheritance uses explicit identifiers and orders only the declared ancestors before states', () => {
  const sameName = { ...base, id: 'independent', variant: '独立' }
  const next = { ...state, id: 'older-state', base_profile_id: state.id, variant: '老年' }
  assert.deepEqual(visualProfileBaseChain(next, [sameName, next, state, base]).ancestors.map(item => item.id), ['base', 'state'])
  assert.deepEqual(orderedVisualProfiles([next, sameName, state, base]).map(item => item.id), ['base', 'state', 'older-state', 'independent'])
  assert.deepEqual(visualProfileBaseChain(sameName, [sameName, state, base]).ancestors, [], 'matching a name never creates identity')
})

test('missing, foreign-kind and cyclic bases are rejected rather than silently becoming independent profiles', () => {
  assert.match(visualProfileBaseChain(state, [state]).error!, /不存在/)
  assert.match(visualProfileBaseChain(state, [state, { ...base, kind: 'prop' }]).error!, /类型相同/)
  const cyclicBase = { ...base, base_profile_id: state.id }
  assert.match(visualProfileBaseChain(state, [state, cyclicBase]).error!, /循环/)
  assert.throws(() => orderedVisualProfiles([state, cyclicBase]), /循环/)
  const invalid = { ...detail(), visual_profiles: [state, cyclicBase] }
  assert.deepEqual(visualProfileDependencyEdges(graph(), invalid), [], 'invalid relations are not rendered as executable dependencies')
})

test('batch duplicate filtering resolves an explicit temporary base to its existing profile without inventing relations', () => {
  const savedBase = { ...base, name: '林晚' }
  const result = newVisualProfileDrafts([
    draft({ draft_key: 'base-draft' }),
    draft({ draft_key: 'state-draft', variant: '雨夜', base_draft_key: 'base-draft', state_delta: '深色雨衣' }),
    draft({ draft_key: 'independent-draft', variant: '另一版' }),
  ], [savedBase])
  assert.equal(result.length, 2)
  assert.equal(result[0].base_profile_id, 'base'); assert.equal(result[0].base_draft_key, null)
  assert.equal(result[1].base_profile_id, undefined)
})

test('reviewed batch relations retain forward keys and reject removal, self-reference and cycles', () => {
  const first = draft({ draft_key: 'first', base_draft_key: 'second', variant: '第一版' })
  const second = draft({ draft_key: 'second', variant: '第二版' })
  assert.equal(visualProfileDraftRelationError(first, [], [first, second]), undefined)
  assert.match(visualProfileDraftRelationError(first, [], [first])!, /已移除/)
  assert.match(visualProfileDraftRelationError({ ...first, base_draft_key: 'first' }, [], [first, second])!, /循环/)
  assert.match(visualProfileDraftRelationError(first, [], [first, { ...second, base_draft_key: 'first' }])!, /循环/)
  assert.match(visualProfileDraftRelationError(draft({ state_delta: '红色外套' }), [])!, /先选择基础/)
})

test('only explicit base relations create derived dependency edges; manual references remain unchanged', () => {
  const previous = graph(), before = structuredClone(previous)
  const d = detail()
  const edges = automaticVisualReferenceEdges(previous, d)
  assert.deepEqual(edges.map(edge => [edge.source, edge.target]), [['node-base', 'node-state'], ['node-state', 'shot-node']])
  assert.match(edges[0].id, /^auto-visual-base:/)
  assert.deepEqual(previous, before)
  previous.edges.push({ id: 'manual', source: 'node-base', target: 'node-state' })
  assert.deepEqual(visualProfileDependencyEdges(previous, d), [], 'a manually displayed identical relation is not duplicated')
  d.visual_profiles = [base, { ...state, base_profile_id: null }]
  assert.deepEqual(visualProfileDependencyEdges(previous, d), [], 'ordinary manual reference edges do not establish base identity')
})

test('missing state references identify their unconfirmed base first and retain an actionable state node', () => {
  const previous = graph(), d = detail()
  assert.deepEqual(missingVisualReferences(previous, 'shot-node', d).map(item => [item.profileId, item.nodeId, item.action]), [
    ['base', 'node-base', 'generate'], ['state', 'node-state', 'generate'],
  ])
  assert.deepEqual(missingVisualReferences(previous, 'node-state', d).map(item => item.profileId), ['base'])
  const approvedBase = { ...base, board_asset_id: 'base-board', board_style_version: 'current' }
  d.visual_profiles = [approvedBase, state]; d.assets = [{ id: 'base-board', kind: 'image' }] as ProjectDetail['assets']
  d.project_visual_style = { version: 'current' } as ProjectDetail['project_visual_style']
  assert.equal(visualProfileBaseReadiness(state, d).waitingProfile, undefined)
  assert.deepEqual(missingVisualReferences(previous, 'shot-node', d).map(item => item.profileId), ['state'])
  d.project_visual_style = { version: 'next-style' } as ProjectDetail['project_visual_style']
  assert.equal(visualProfileBaseReadiness(state, d).waitingProfile?.id, base.id)
})

test('a state board waits for base approval before previewing and never falls back to text-only generation', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; assert.fail('an unconfirmed base cannot contact preview or generation') })
  await assert.rejects(prepareCanvasVisualBoard(node(state), state, graph(), detail(), { id: 'model', modality: 'image' } as Model), /先生成并确认.*基础/)
  assert.equal(requests, 0)
})

test('state board preview and enqueue preserve stable prompt tokens and explicit reference overrides for backend resolution', async t => {
  const requests: Array<{ path: string; body: any }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(String(url).endsWith('board-preview') ? { prompt: '参考图 1保持脸型，参考图 2的光线', mode: 'reference',
      reference_asset_ids: ['base-board', 'new-light'], reference_names: ['基础身份图', '光线图'], reference_signature: 'reviewed', base_profile_id: 'base',
      reference_sources: [{ asset_id: 'base-board', profile_id: 'base', role: 'base' }, { asset_id: 'new-light', role: 'manual' }] }
      : { job: { id: 'job' }, jobs: [{ id: 'job' }], task: { id: 'task' } })
  })
  const d = detail()
  d.visual_profiles = [{ ...base, board_asset_id: 'base-board' }, state]
  d.assets = [{ id: 'base-board', kind: 'image' }, { id: 'new-light', kind: 'image' }] as ProjectDetail['assets']
  const source = { ...node(state), settings: { ...node(state).settings,
    profile_prompt_override: '[[ref:base-board]]保持脸型，[[ref:old-light]]的光线', prompt_reference_overrides: { 'old-light': 'new-light' } } }
  const connected = graph()
  connected.nodes.push({ ...node(base), id: 'light-reference', type: 'image', asset_id: 'new-light', settings: {} })
  connected.edges.push({ id: 'light-input', source: 'light-reference', target: source.id })
  const model = { id: 'model', modality: 'image', settings: { request_template: { images: '{{images}}', ratio: '{{ratio}}' } } } as Model
  const prepared = await prepareCanvasVisualBoard(source, state, connected, d, model)
  await enqueueCanvasVisualBoard(prepared.board, prepared.request, 1)
  for (const request of requests) {
    assert.deepEqual(request.body.prompt_reference_overrides, { 'old-light': 'new-light' })
    assert.equal(request.body.prompt_override, source.settings.profile_prompt_override)
    assert.deepEqual(request.body.reference_asset_ids, ['new-light'], 'replacement references must remain connected; the backend adds the required base')
  }
  assert.deepEqual(prepared.request.reference_asset_ids, ['base-board', 'new-light'])
  assert.equal(prepared.request.prompt.includes('[[ref:'), false)
})

test('script handoff includes explicit bases ahead of state nodes and focuses the unconfirmed foundation', () => {
  const input = { visual_profiles: [state, base], shots: [{ id: 'shot', title: '雨夜相见', position: 0, prompt: '雨夜', image_prompt: '雨夜', duration: 5 }],
    shot_visual_bindings: detail().shot_visual_bindings } as ScriptCanvasResult
  const imported = addScriptCanvasNodes({ ...graph(), nodes: [], edges: [] }, input, '16:9')
  assert.deepEqual(imported.graph.nodes.slice(0, 2).map(item => item.settings.visual_profile_id), ['base', 'state'])
  const focused = scriptCanvasInitialFocus(imported, input, detail())
  assert.equal(focused.targetNodeId, imported.graph.nodes[0].id)
  assert.equal(focused.missingReferenceCount, 2)
})
