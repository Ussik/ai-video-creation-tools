import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addVisualProfileNode, automaticVisualReferenceEdges, missingVisualReferences, syncVisualProfileNode, visualBoardJobs, visualBoardReferences, visualCandidateAssets, visualNodeAsset } from '../src/canvas-visual-profiles'
import type { CanvasGraph, CanvasNode } from '../src/ProjectCanvas'
import type { Job, Model, ProjectDetail, ShotVisualBinding, VisualProfile } from '../src/api'

const profile = { id: 'linwan', name: '林晚', variant: '常服', revision: 2, board_asset_id: 'approved', asset_task_id: 'task' } as VisualProfile
const node = { id: 'node', type: 'generation', asset_id: 'candidate', shot_id: 'shot', settings: { modality: 'image', visual_profile_id: 'linwan' } } as CanvasNode
const detail = { visual_profiles: [profile], assets: [{ id: 'approved', kind: 'image' }, { id: 'candidate', kind: 'image' }, { id: 'upload', kind: 'image' }] } as ProjectDetail

test('old-style references offer board review first and binding refresh after approval, even when the image exists', () => {
  const target = { ...node, id: 'target', shot_id: 'shot', settings: { modality: 'image', visual_reference_mode: 'profiles' } } as CanvasNode
  const graph = { nodes: [node, target], edges: [{ id: 'ref', source: node.id, target: target.id }] } as CanvasGraph
  const stale = { ...detail, assets: detail.assets.map(asset => ({ ...asset, created_at: '2026-10-09T00:00:00Z' })), jobs: [], asset_tasks: [], project_visual_style: { version: 'new', label: '水彩', source: 'settings', details: {} },
    visual_profiles: [{ ...profile, board_style_status: 'needs_review', board_style_version: 'old' }],
    shot_visual_bindings: [{ ...profile, profile_id: profile.id, shot_id: 'shot', required: true, board_style_version: 'old' }],
  } as ProjectDetail
  assert.equal(missingVisualReferences(graph, target.id, stale)[0]?.action, 'confirm')
  const reviewed = { ...stale, visual_profiles: [{ ...profile, board_style_status: 'current' as const, board_style_version: 'new' }] }
  assert.equal(missingVisualReferences(graph, target.id, reviewed)[0]?.action, 'bindings')
  const refreshed = { ...reviewed, shot_visual_bindings: [{ ...reviewed.shot_visual_bindings![0], board_style_version: 'new' }] }
  assert.equal(missingVisualReferences(graph, target.id, refreshed).length, 0)
})

test('adding a visual profile reuses its original node and never associates a shot', () => {
  const graph = { nodes: [], edges: [], revision: 'revision' } as CanvasGraph
  const added = addVisualProfileNode(graph, profile, node)
  assert.equal(added.graph.nodes[0].shot_id, null)
  assert.equal(added.graph.nodes[0].asset_id, 'approved')
  assert.equal(added.graph.nodes[0].settings.visual_profile_revision, 2)
  const repeated = addVisualProfileNode(added.graph, profile, { ...node, id: 'duplicate' })
  assert.equal(repeated.graph, added.graph)
  assert.equal(repeated.nodeId, node.id)
})

test('displayed candidates stay separate from the confirmed image passed downstream', () => {
  assert.equal(visualNodeAsset(node, detail)?.id, 'candidate')
  assert.equal(visualNodeAsset(node, detail, true)?.id, 'approved')
  const unconfirmed = { ...detail, visual_profiles: [{ ...profile, board_asset_id: null }] }
  assert.equal(visualNodeAsset(node, unconfirmed, true), undefined)
})

test('board edges resolve profile references, reject unconfirmed profiles and keep uploaded images', () => {
  const graph = { nodes: [node, { ...node, id: 'upload-node', asset_id: 'upload', settings: {} }], edges: [
    { id: 'e1', source: 'node', target: 'target' }, { id: 'e2', source: 'upload-node', target: 'target' },
  ] } as CanvasGraph
  assert.deepEqual(visualBoardReferences(graph, 'target', detail), { reference_profile_ids: ['linwan'], reference_asset_ids: ['upload'] })
  assert.throws(() => visualBoardReferences(graph, 'target', { ...detail, visual_profiles: [{ ...profile, board_asset_id: null }] }), /请先确认 林晚/)
})

test('candidate history survives board replacement but excludes a prior definition version', () => {
  const job = (id: string, request: object) => ({ id, created_at: id, request: JSON.stringify(request) }) as Job
  const jobs = [job('1', { visual_profile_id: 'linwan', visual_profile_revision: 1, asset_task_id: 'task' }), job('2', { visual_profile_id: 'linwan', visual_profile_revision: 2, asset_task_id: 'task' }), job('3', { visual_profile_id: 'other' })]
  assert.deepEqual(visualBoardJobs(profile, jobs).map(item => item.id), ['2', '1'])
  assert.deepEqual(visualBoardJobs({ ...profile, revision: 3, asset_task_id: null }, jobs), [])
})

test('confirming an older board does not replay the latest completed candidate', () => {
  const completed = { ...node, job_id: 'latest-job', settings: { ...node.settings, visual_profile_revision: 1, visual_completed_job_id: 'latest-job' } }
  const updated = syncVisualProfileNode(completed, profile, { ...detail, asset_tasks: [{ id: 'task', generation_job_id: 'latest-job' }] } as ProjectDetail)
  assert.equal(updated.asset_id, 'approved')
  assert.equal(updated.settings.visual_completed_job_id, 'latest-job')
  const changed = syncVisualProfileNode(completed, { ...profile, asset_task_id: null, board_asset_id: null }, { ...detail, asset_tasks: [] })
  assert.equal(changed.asset_id, null)
  assert.equal(changed.job_id, null)
  assert.equal(changed.settings.visual_completed_job_id, undefined)
})

test('candidate management includes earlier definition versions and uploaded boards without duplicates', () => {
  const history = { ...detail, jobs: [
    { status: 'succeeded', result_asset_id: 'candidate', request: JSON.stringify({ visual_profile_id: profile.id, visual_profile_revision: 1 }) },
    { status: 'succeeded', result_asset_id: 'candidate', request: JSON.stringify({ asset_task_id: profile.asset_task_id }) },
    { status: 'succeeded', result_asset_id: 'foreign', request: JSON.stringify({ visual_profile_id: 'other' }) },
  ], assets: [...detail.assets.map((asset, index) => ({ ...asset, created_at: String(index) })), { id: 'foreign', kind: 'image', created_at: '9' }], asset_tasks: [] } as ProjectDetail
  const saved = { ...profile, candidate_asset_ids: ['upload'], archived_candidate_asset_ids: ['candidate'] }
  assert.deepEqual(visualCandidateAssets(saved, history).map(asset => asset.id), ['upload', 'candidate', 'approved'])
  const synced = syncVisualProfileNode({ ...node, settings: { ...node.settings, visual_profile_revision: 2, visual_completed_job_id: 'job' } }, saved, history)
  assert.equal(synced.asset_id, 'approved')
  assert.equal(synced.settings.visual_completed_job_id, 'job')
})

function referenceFixture() {
  const profiles = [{ ...profile }, { ...profile, id: 'bedroom', board_asset_id: 'room' }, { ...profile, id: 'mark', board_asset_id: 'tattoo' }]
  const referenceDetail = { ...detail, jobs: [], asset_tasks: [], visual_profiles: profiles,
    assets: [...detail.assets, { id: 'room', kind: 'image' }, { id: 'tattoo', kind: 'image' }, { id: 'old-board', kind: 'image' }].map(asset => ({ ...asset, created_at: '2026-10-08' })),
    shot_visual_bindings: profiles.map(item => ({ ...item, shot_id: 'shot', profile_id: item.id, required: true })),
  } as ProjectDetail
  const target = { ...node, id: 'shot-node', asset_id: null, settings: { modality: 'image' } } as CanvasNode
  const graph = { nodes: [...profiles.map(item => ({ ...node, id: item.id, shot_id: null,
    asset_id: item.board_asset_id, settings: { modality: 'image', visual_profile_id: item.id } } as CanvasNode)), target], edges: [], revision: 'revision' } as CanvasGraph
  return { detail: referenceDetail, graph, target }
}

test('bound character, location and prop boards automatically connect existing nodes without changing manual inputs', () => {
  const fixture = referenceFixture()
  const before = structuredClone(fixture)
  const edges = automaticVisualReferenceEdges(fixture.graph, fixture.detail)
  assert.deepEqual(edges.map(({ source, target }) => ({ source, target })), [
    { source: 'linwan', target: 'shot-node' }, { source: 'bedroom', target: 'shot-node' }, { source: 'mark', target: 'shot-node' },
  ])
  assert.equal(new Set(edges.map(edge => edge.id)).size, 3)
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail), edges)
  assert.deepEqual(fixture, before)
  assert.deepEqual(visualBoardReferences(fixture.graph, 'shot-node', fixture.detail), { reference_profile_ids: [], reference_asset_ids: [] })
})

test('a board added later gains its connection and removing a binding removes only its derived line', () => {
  const fixture = referenceFixture()
  const withoutRoom = { ...fixture.graph, nodes: fixture.graph.nodes.filter(item => item.id !== 'bedroom') }
  assert.equal(automaticVisualReferenceEdges(withoutRoom, fixture.detail).length, 2)
  assert.equal(withoutRoom.nodes.length, 3)
  assert.equal(automaticVisualReferenceEdges(fixture.graph, fixture.detail).length, 3)
  const unbound = { ...fixture.detail, shot_visual_bindings: fixture.detail.shot_visual_bindings!.filter(item => item.profile_id !== 'bedroom') }
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, unbound).map(edge => edge.source), ['linwan', 'mark'])
})

test('manual connections and duplicate image nodes do not produce duplicate references', () => {
  const fixture = referenceFixture()
  fixture.graph.nodes.unshift({ ...node, type: 'image', id: 'copy', asset_id: 'approved', settings: {} })
  assert.equal(automaticVisualReferenceEdges(fixture.graph, fixture.detail)[0].source, 'linwan')
  fixture.graph.edges.push({ id: 'manual', source: 'copy', target: 'shot-node' })
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail).map(edge => edge.source), ['bedroom', 'mark'])
  assert.deepEqual(fixture.graph.edges, [{ id: 'manual', source: 'copy', target: 'shot-node' }])
  fixture.graph.edges = []
  fixture.graph.nodes = fixture.graph.nodes.filter(item => item.id !== 'linwan')
  assert.equal(automaticVisualReferenceEdges(fixture.graph, fixture.detail)[0].source, 'copy')
})

test('snapshot matching never substitutes a newer approved board, an unconfirmed candidate or a similarly named asset', () => {
  const fixture = referenceFixture()
  fixture.detail.shot_visual_bindings![0].board_asset_id = 'old-board'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail).map(edge => edge.source), ['bedroom', 'mark'])
  fixture.graph.nodes.push({ ...node, type: 'image', id: 'old-copy', asset_id: 'old-board', settings: {} })
  assert.equal(automaticVisualReferenceEdges(fixture.graph, fixture.detail)[0].source, 'old-copy')
  fixture.detail.shot_visual_bindings![0].board_asset_id = 'candidate'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail).map(edge => edge.source), ['bedroom', 'mark'])
  fixture.detail.visual_profiles![0].board_asset_id = null
  fixture.detail.shot_visual_bindings![0].board_asset_id = 'approved'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail).map(edge => edge.source), ['bedroom', 'mark'])
})

test('only image generation and reference-mode video display automatic profile boards', () => {
  const fixture = referenceFixture()
  for (const mode of ['text_only', 'keyframe'] as const) {
    fixture.target.settings.visual_reference_mode = mode
    assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail), [])
  }
  fixture.target.settings.visual_reference_mode = 'profiles'
  fixture.target.settings.modality = 'video'
  for (const mode of ['text', 'first_frame', 'first_last_frame', 'edit', 'extend'] as const) {
    fixture.target.settings.mode = mode
    assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail), [])
  }
  fixture.target.settings.mode = 'reference'
  assert.equal(automaticVisualReferenceEdges(fixture.graph, fixture.detail).length, 3)
  fixture.target.model_id = 'text-model'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail, [{ id: 'text-model', modality: 'text' }] as Model[]), [])
})

test('unsupported sources, missing images, self references and profile-board targets cannot create automatic lines', () => {
  const fixture = referenceFixture()
  fixture.graph.nodes = [fixture.target, { ...node, id: 'text', type: 'text', asset_id: 'approved', settings: {} },
    { ...node, id: 'video', type: 'video', asset_id: 'room', settings: {} },
    { ...node, id: 'script', type: 'project_script_ref', asset_id: 'tattoo', settings: {} }]
  fixture.target.asset_id = 'approved'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail), [])
  fixture.graph.nodes.push({ ...node, id: 'missing', type: 'image', asset_id: 'missing', settings: {} })
  fixture.detail.shot_visual_bindings = [{ ...fixture.detail.shot_visual_bindings![0], board_asset_id: 'missing' } as ShotVisualBinding]
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, fixture.detail), [])
  fixture.graph.nodes = [...referenceFixture().graph.nodes]
  fixture.graph.nodes[3].settings.visual_profile_id = 'linwan'
  assert.deepEqual(automaticVisualReferenceEdges(fixture.graph, referenceFixture().detail), [])
})

test('missing required boards expose exact existing profile nodes and leave optional references out', () => {
  const fixture = referenceFixture()
  for (const profile of fixture.detail.visual_profiles!) profile.board_asset_id = null
  for (const binding of fixture.detail.shot_visual_bindings!) binding.board_asset_id = null
  for (const node of fixture.graph.nodes) node.asset_id = null
  fixture.detail.shot_visual_bindings![2].required = false
  fixture.graph.nodes = fixture.graph.nodes.filter(node => node.id !== 'bedroom')
  const before = structuredClone(fixture)
  const missing = missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)
  assert.deepEqual(missing.map(item => [item.profileId, item.nodeId, item.action]), [
    ['linwan', 'linwan', 'generate'], ['bedroom', undefined, 'generate'],
  ])
  assert.deepEqual(fixture, before)
  fixture.target.settings.visual_reference_mode = 'text_only'
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail), [])
  fixture.target.settings.visual_reference_mode = 'keyframe'
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail), [])
  fixture.target.model_id = 'text-model'
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail, [{ id: 'text-model', modality: 'text' }]), [])
})

test('manual unconfirmed profile inputs remain actionable in text-only mode and deduplicate shot dependencies', () => {
  const fixture = referenceFixture()
  fixture.detail.visual_profiles![0].board_asset_id = null
  fixture.detail.shot_visual_bindings![0].board_asset_id = null
  fixture.graph.nodes[0].asset_id = null
  fixture.graph.edges.push({ id: 'manual', source: 'linwan', target: fixture.target.id })
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail).map(item => item.profileId), ['linwan'])
  fixture.target.settings.visual_reference_mode = 'text_only'
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail).map(item => [item.nodeId, item.action]), [['linwan', 'generate']])
  fixture.target.settings.visual_profile_id = 'bedroom'
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail).length, 1)
})

test('strict first-frame only checks its pinned image while dormant unconfirmed and old-style profile edges remain available for multi-reference', () => {
  const fixture = referenceFixture()
  const frame = { ...node, id: 'storyboard', type: 'image' as const, asset_id: 'storyboard-image',
    settings: {}, shot_id: 'shot' }
  fixture.graph.nodes.push(frame)
  fixture.detail.assets.push({ ...fixture.detail.assets[0], id: 'storyboard-image', kind: 'image' })
  fixture.detail.project_visual_style = { version: 'new-style', label: '日漫', source: 'settings', details: {} } as ProjectDetail['project_visual_style']
  fixture.detail.visual_profiles![0].board_asset_id = null
  fixture.detail.shot_visual_bindings![0].board_asset_id = null
  fixture.detail.visual_profiles![1].board_style_status = 'needs_review'
  fixture.detail.visual_profiles![1].board_style_version = 'old-style'
  fixture.detail.shot_visual_bindings![1].board_style_version = 'old-style'
  fixture.target.settings = { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', storyboard_reference_asset_id: frame.asset_id }
  fixture.graph.edges = [
    { id: 'frame', source: frame.id, target: fixture.target.id, reference_asset_id: frame.asset_id! },
    { id: 'dormant-unconfirmed', source: 'linwan', target: fixture.target.id },
    { id: 'dormant-style-review', source: 'bedroom', target: fixture.target.id },
  ]
  const before = structuredClone(fixture)
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail), [])
  assert.deepEqual(fixture, before, 'unused references remain connected for a later strategy switch')
  fixture.target.settings.mode = 'reference'
  fixture.target.settings.visual_reference_mode = 'profiles'
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail).map(item => item.profileId), ['linwan', 'bedroom'])
})

test('strict first-frame still checks a manually pinned profile board that actually participates in the request', () => {
  const fixture = referenceFixture()
  fixture.detail.visual_profiles![0].board_style_status = 'needs_review'
  fixture.target.settings = { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', storyboard_reference_asset_id: 'approved' }
  fixture.graph.edges = [{ id: 'first-frame-profile', source: 'linwan', target: fixture.target.id, reference_asset_id: 'approved' }]
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail).map(item => item.profileId), ['linwan'])
})

test('unconfirmed candidates lead to approval, archived candidates to generation and older snapshots to binding management', () => {
  const fixture = referenceFixture()
  fixture.detail.visual_profiles![0].board_asset_id = null
  fixture.detail.shot_visual_bindings![0].board_asset_id = null
  fixture.graph.nodes[0].asset_id = 'candidate'
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)[0].action, 'confirm')
  fixture.detail.visual_profiles![0].archived_candidate_asset_ids = ['candidate']
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)[0].action, 'generate')
  fixture.detail.visual_profiles![0].revision = 3
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)[0].action, 'bindings')
  fixture.detail.visual_profiles![0].revision = 2
  fixture.detail.visual_profiles![0].board_asset_id = 'approved'
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)[0].action, 'bindings')
})

test('confirmed snapshot assets stay ready despite newer profile revisions or an unavailable current profile', () => {
  const fixture = referenceFixture()
  fixture.detail.visual_profiles![0].revision = 99
  fixture.detail.visual_profiles![0].board_asset_id = null
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail), [])
  fixture.detail.visual_profiles = []
  assert.deepEqual(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail), [])
  fixture.detail.shot_visual_bindings![0].board_asset_id = null
  assert.equal(missingVisualReferences(fixture.graph, fixture.target.id, fixture.detail)[0].action, 'bindings')
})
