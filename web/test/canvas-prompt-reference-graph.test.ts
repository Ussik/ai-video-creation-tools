import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { ProjectDetail } from '../src/shared/api/api'
import { freezeLegacyPromptReferenceDrafts, materializePromptReference, promptReferenceSources, replaceConnectedPromptReference } from '../src/features/canvas/canvas-prompt-reference-graph'

function fixture() {
  const node = (id: string, assetId: string | null, settings: CanvasNode['settings'] = {}): CanvasNode => ({ id, type: 'generation',
    x: 500, y: 200, width: 320, height: 240, title: id, text: '', prompt: '', asset_id: assetId, shot_id: 'shot', model_id: null, job_id: null,
    settings: { modality: 'image', ...settings } })
  const target = node('target', null)
  const original = node('人物节点', 'old')
  const profile = node('设定节点', 'candidate', { visual_profile_id: 'profile', visual_profile_revision: 2 })
  const detail = { id: 'project', assets: ['old', 'new', 'board', 'candidate', 'face', 'side', 'back', 'base'].map(id => ({ id, project_id: 'project', kind: 'image',
    filename: `${id}.png`, url: `/${id}.png`, shot_id: 'shot' })),
    visual_profiles: [{ id: 'profile', name: '角色', variant: '战损', revision: 2, board_asset_id: 'board', reference_assets: [
      { asset_id: 'face', status: 'confirmed' }, { asset_id: 'candidate', status: 'candidate' }] },
    { id: 'base-profile', name: '角色', variant: '基础', board_asset_id: 'base' }],
    shots: [{ id: 'shot' }], historical_shots: [],
    shot_visual_bindings: [{ shot_id: 'shot', profile_id: 'profile', name: '角色', variant: '战损', revision: 2, required: true, board_asset_id: 'board',
      reference_assets: [{ asset_id: 'face', view: 'face', purpose: 'identity', label: '面部' }, { asset_id: 'side', view: 'side', purpose: 'costume', label: '衣服' },
        { asset_id: 'back', view: 'back', purpose: 'costume', label: '' }] }], jobs: [] } as unknown as ProjectDetail
  const graph: CanvasGraph = { nodes: [target, original, profile], edges: [], revision: 'revision' }
  let sequence = 0
  const options = { idFactory: (kind: 'node' | 'edge') => `fresh-${kind}-${++sequence}` }
  return { node, target, original, profile, detail, graph, options }
}

test('explicit references reuse visible sources, pin image identity and deduplicate without mutating', () => {
  const f = fixture(), before = structuredClone(f.graph)
  const connected = materializePromptReference(f.graph, f.target.id, 'old', f.detail, f.options)
  assert.deepEqual(f.graph, before)
  assert.equal(connected.nodes, f.graph.nodes)
  assert.deepEqual(connected.edges, [{ id: 'fresh-edge-1', source: '人物节点', target: 'target', reference_asset_id: 'old' }])
  const regenerated = { ...connected, nodes: connected.nodes.map(node => node.id === f.original.id ? { ...node, asset_id: 'new' } : node) }
  assert.equal(materializePromptReference(regenerated, 'target', 'old', f.detail, f.options), regenerated)
  assert.equal(promptReferenceSources(regenerated, 'target', ['old'], f.detail)[0].nodeId, '人物节点')
  assert.equal(connected.revision, f.graph.revision)
})

test('selection snapshots use confirmed profile images but create fixed media for unconfirmed candidates', () => {
  const f = fixture()
  const board = materializePromptReference(f.graph, 'target', 'board', f.detail, { ...f.options, sourceNodeId: f.profile.id })
  assert.equal(board.nodes.length, 3)
  assert.equal(board.edges[0].source, f.profile.id)
  const face = materializePromptReference(f.graph, 'target', 'face', f.detail, f.options)
  assert.equal(face.edges[0].source, f.profile.id)
  const candidate = materializePromptReference(f.graph, 'target', 'candidate', f.detail, { ...f.options, sourceNodeId: f.profile.id })
  assert.equal(candidate.nodes.length, 4)
  const fixed = candidate.nodes.at(-1)!
  assert.equal(fixed.type, 'image')
  assert.equal(fixed.asset_id, 'candidate')
  assert.equal(fixed.settings.visual_profile_id, undefined)
  assert.ok(fixed.x < f.target.x)
  assert.equal(candidate.edges[0].source, fixed.id)
})

test('restored reference media retains its historical owner without attaching recycled shots to new nodes', () => {
  const f = fixture()
  f.detail.historical_shots = [{ ...f.detail.shots[0], id: 'historical-shot' }]
  for (const shotId of ['shot', 'historical-shot', 'recycled-shot']) {
    const asset = { ...f.detail.assets[0], id: `reference-${shotId}`, shot_id: shotId }
    f.detail.assets.push(asset)
    const before = structuredClone(f.detail)
    const graph = materializePromptReference(f.graph, 'target', asset.id, f.detail, f.options)
    const node = graph.nodes.at(-1)!
    assert.equal(node.asset_id, asset.id)
    assert.equal(node.shot_id, shotId === 'recycled-shot' ? null : shotId)
    assert.deepEqual(f.detail, before, 'resource ownership and history stay unchanged')
  }
})

test('an existing single-image unpinned edge becomes fixed; preferred valid source wins', () => {
  const f = fixture(), alternate = f.node('alternate', 'old')
  const graph = { ...f.graph, nodes: [...f.graph.nodes, alternate], edges: [{ id: 'edge', source: 'alternate', target: 'target' }] }
  const result = materializePromptReference(graph, 'target', 'old', f.detail, { ...f.options, sourceNodeId: 'alternate' })
  assert.deepEqual(result.edges, [{ id: 'edge', source: 'alternate', target: 'target', reference_asset_id: 'old' }])
  assert.equal(result.nodes.length, graph.nodes.length)
})

test('reselecting the same disconnected image restores its visible fixed connection', () => {
  const f = fixture()
  const restored = replaceConnectedPromptReference(f.graph, 'target', 'old', 'old', f.detail, f.options)
  assert.deepEqual(restored.edges, [{ id: 'fresh-edge-1', source: f.original.id, target: 'target', reference_asset_id: 'old' }])
  assert.equal(replaceConnectedPromptReference(restored, 'target', 'old', 'old', f.detail, f.options), restored)
})

test('references reject missing/foreign/non-image assets and never self-connect', () => {
  const f = fixture()
  f.detail.assets.push({ ...f.detail.assets[0], id: 'foreign', project_id: 'other' }, { ...f.detail.assets[0], id: 'video', kind: 'video' })
  for (const id of ['missing', 'foreign', 'video']) assert.throws(() => materializePromptReference(f.graph, 'target', id, f.detail, f.options), /引用图片/)
  assert.throws(() => materializePromptReference(f.graph, 'missing', 'old', f.detail, f.options), /当前节点/)
  const self = { ...f.graph, nodes: f.graph.nodes.map(node => node.id === 'target' ? { ...node, asset_id: 'new' } : node) }
  const result = materializePromptReference(self, 'target', 'new', f.detail, { ...f.options, sourceNodeId: 'target' })
  assert.notEqual(result.edges[0].source, 'target')
})

test('capacity validation is atomic and allows reuse at the node limit', () => {
  const f = fixture(), nodes = Array.from({ length: 500 }, (_, index) => f.node(index === 0 ? 'target' : `node-${index}`, index === 1 ? 'old' : null))
  const graph = { ...f.graph, nodes }
  assert.throws(() => materializePromptReference(graph, 'target', 'new', f.detail, f.options), /上限/)
  assert.equal(materializePromptReference(graph, 'target', 'old', f.detail, f.options).nodes.length, 500)
  const fullEdges = { ...graph, edges: Array.from({ length: 1000 }, (_, index) => ({ id: `edge-${index}`, source: 'target', target: 'node-2' })) }
  assert.throws(() => materializePromptReference(fullEdges, 'target', 'old', f.detail, f.options), /上限/)
  assert.equal(graph.edges.length, 0)
})

test('replacing a profile-expanded input freezes all unaffected views and changes only this target', () => {
  const f = fixture()
  const graph = { ...f.graph, nodes: [...f.graph.nodes, f.node('other-target', null)], edges: [
    { id: 'profile-edge', source: f.profile.id, target: 'target' },
    { id: 'other-edge', source: f.profile.id, target: 'other-target' },
    { id: 'text-edge', source: f.original.id, target: 'target', reference_asset_id: 'old' },
  ] }
  const result = replaceConnectedPromptReference(graph, 'target', 'side', 'new', f.detail, f.options)
  assert.deepEqual(result.edges.filter(edge => edge.source === f.profile.id && edge.target === 'target').map(edge => edge.reference_asset_id), ['face', 'back'])
  assert.deepEqual(result.edges.find(edge => edge.id === 'other-edge'), graph.edges[1])
  assert.deepEqual(result.edges.find(edge => edge.id === 'text-edge'), graph.edges[2])
  assert.equal(result.edges.filter(edge => edge.reference_asset_id === 'new').length, 1)
  const originalBindings = structuredClone(f.detail.shot_visual_bindings)
  f.detail.shot_visual_bindings![0].reference_assets = [{ ...f.detail.shot_visual_bindings![0].reference_assets![0], asset_id: 'candidate' }]
  const sources = promptReferenceSources(result, 'target', ['face', 'back', 'new'], f.detail)
  assert.equal(sources.find(source => source.assetId === 'face')?.nodeId, f.profile.id)
  assert.equal(originalBindings![0].reference_assets!.length, 3)
  assert.equal(graph.edges[0].reference_asset_id, undefined)
})

test('removal preserves sibling views and unrelated edges, including an orphaned fixed image', () => {
  const f = fixture(), graph = { ...f.graph, edges: [{ id: 'views', source: f.profile.id, target: 'target' }] }
  const result = replaceConnectedPromptReference(graph, 'target', 'face', null, f.detail, f.options)
  assert.deepEqual(result.edges.map(edge => edge.reference_asset_id), ['side', 'back'])
  const orphan = { ...f.graph, edges: [{ id: 'gone', source: f.original.id, target: 'target', reference_asset_id: 'gone' }] }
  assert.deepEqual(replaceConnectedPromptReference(orphan, 'target', 'gone', null, f.detail).edges, [])
  assert.equal(replaceConnectedPromptReference(f.graph, 'target', 'face', null, f.detail), f.graph)
})

test('a binding-only replacement materializes its explicit image edge even without manual inputs', () => {
  const f = fixture()
  const result = replaceConnectedPromptReference(f.graph, 'target', 'face', 'new', f.detail, f.options)
  assert.equal(result.nodes.at(-1)?.asset_id, 'new')
  assert.equal(result.edges.length, 1)
  assert.equal(result.edges[0].reference_asset_id, 'new')
})

test('source metadata follows final IDs, snapshot details, direct base and node-local replacements', () => {
  const f = fixture()
  let graph = materializePromptReference(f.graph, 'target', 'new', f.detail, f.options)
  graph = { ...graph, nodes: graph.nodes.map(node => node.id === 'target' ? { ...node, settings: { ...node.settings,
    prompt_reference_overrides: { old: 'new', face: 'new' } } } : node) }
  const sources = promptReferenceSources(graph, 'target', ['new', 'face', 'new', 'candidate', 'missing'], f.detail)
  assert.deepEqual(sources.map(source => source.assetId), ['new', 'face', 'candidate'])
  assert.equal(sources[0].label, 'new.png')
  assert.match(sources[0].description, /本节点替换/)
  assert.equal(sources[1].label, '角色 · 战损')
  assert.match(sources[1].description, /面部特写.*身份与外貌.*面部/)
  assert.equal(sources[1].provenance, 'binding')
  assert.equal(sources[1].nodeId, f.profile.id)
  assert.equal(sources[2].provenance, 'explicit')
  assert.match(sources[2].description, /未连接/)
  f.detail.visual_profiles![0].base_profile_id = 'base-profile'
  const baseGraph = { ...f.graph, nodes: f.graph.nodes.map(node => node.id === 'target' ? { ...node, settings: { ...node.settings, visual_profile_id: 'profile' } } : node) }
  const base = promptReferenceSources(baseGraph, 'target', ['base'], f.detail)[0]
  assert.equal(base.required, true)
  assert.equal(base.provenance, 'base')
  assert.equal(base.label, '角色 · 基础')
})

test('inactive/excluded bindings do not mark disconnected @ choices as active', () => {
  const f = fixture()
  f.detail.shot_visual_bindings![0].usage = 'video'
  assert.equal(promptReferenceSources(f.graph, 'target', ['face'], f.detail)[0].provenance, 'explicit')
  f.detail.shot_visual_bindings![0].usage = 'image'
  f.detail.shot_visual_bindings![0].required = false
  f.target.settings.excluded_visual_profile_ids = ['profile']
  assert.equal(promptReferenceSources(f.graph, 'target', ['face'], f.detail)[0].provenance, 'explicit')
})

test('unselected legacy drafts freeze image identity before a source is removed and the remaining numbers shift', () => {
  const f = fixture()
  f.target.settings = { modality: 'image', visual_reference_mode: 'text_only', prompt_is_final: true,
    prompt_template: '参考图 1 是人物，参考图 2 是场景' }
  f.target.text = '参考图 1 的人物站在参考图 2 的左侧，4K画面，图片4K参数保持原样'
  const graph = { ...f.graph, edges: [{ id: 'first', source: f.original.id, target: 'target', reference_asset_id: 'old' },
    { id: 'second', source: f.profile.id, target: 'target', reference_asset_id: 'board' }] }
  const frozen = freezeLegacyPromptReferenceDrafts(graph, f.detail)
  const disconnected = { ...frozen, nodes: frozen.nodes.filter(node => node.id !== f.original.id), edges: frozen.edges.filter(edge => edge.source !== f.original.id) }
  assert.equal(disconnected.nodes[0].text, '[[ref:old]] 的人物站在[[ref:board]] 的左侧，4K画面，图片4K参数保持原样')
  assert.equal(disconnected.nodes[0].settings.prompt_template, '[[ref:old]] 是人物，[[ref:board]] 是场景')
  assert.equal(graph.nodes[0].text, f.target.text)
  assert.equal(freezeLegacyPromptReferenceDrafts(frozen, f.detail), frozen)
})

test('legacy migration follows shot snapshot ordering, override outputs and base identity precedence', () => {
  const f = fixture()
  f.target.text = '参考图1、2、3分别用于面部、服装和背面，画面4K'
  f.target.settings = { modality: 'image', prompt_is_final: true, prompt_reference_overrides: { face: 'new' } }
  let migrated = freezeLegacyPromptReferenceDrafts(f.graph, f.detail)
  assert.equal(migrated.nodes[0].text, '[[ref:new]]、[[ref:side]]、[[ref:back]]分别用于面部、服装和背面，画面4K')
  f.detail.visual_profiles![0].base_profile_id = 'base-profile'
  f.target.settings = { modality: 'image', visual_profile_id: 'profile', prompt_is_final: true }
  f.target.text = '参考图1保持身份，参考图2辅助服装'
  migrated = freezeLegacyPromptReferenceDrafts({ ...f.graph, edges: [{ id: 'extra', source: f.original.id, target: 'target', reference_asset_id: 'old' }] }, f.detail)
  assert.equal(migrated.nodes[0].text, '[[ref:base]]保持身份，[[ref:old]]辅助服装')
})

test('strict frame legacy migration uses the actual pinned frame and never rewrites source prose or 4K text', () => {
  const f = fixture()
  f.target.settings = { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', storyboard_reference_asset_id: 'board',
    prompt_is_final: true, profile_prompt_override: '图片1作为开镜图片，图片4K并非引用' }
  f.target.text = '图片1作为首帧'
  const graph = { ...f.graph, edges: [{ id: 'dormant', source: f.original.id, target: 'target', reference_asset_id: 'old' },
    { id: 'frame', source: f.profile.id, target: 'target', reference_asset_id: 'board' }] }
  const migrated = freezeLegacyPromptReferenceDrafts(graph, f.detail)
  assert.equal(migrated.nodes[0].text, '[[ref:board]]作为首帧')
  assert.equal(migrated.nodes[0].settings.profile_prompt_override, '[[ref:board]]作为开镜图片，图片4K并非引用')
  const unedited = { ...f.graph, nodes: f.graph.nodes.map(node => ({ ...node, text: '参考图1，图片4K', prompt: '参考图2', settings: {} })) }
  assert.equal(freezeLegacyPromptReferenceDrafts(unedited, f.detail), unedited)
})

test('unselected profile legacy drafts freeze backend profile-before-asset order and required base with overrides', () => {
  const f = fixture()
  f.detail.visual_profiles!.push({ ...f.detail.visual_profiles![0], id: 'target-profile', name: '派生角色', board_asset_id: null,
    base_profile_id: 'base-profile', reference_assets: [] })
  f.target.settings = { modality: 'image', visual_profile_id: 'target-profile',
    profile_prompt_override: '参考图1保持身份，参考图2补充光线，参考图3补充衣服，4K画面',
    prompt_reference_overrides: { board: 'new' } }
  // A different node can be selected when any graph edit triggers the global
  // freeze. Stored edge order intentionally differs from board-preview order.
  const graph = { ...f.graph, nodes: [...f.graph.nodes, f.node('selected-elsewhere', null)], edges: [
    { id: 'first-fixed', source: f.original.id, target: f.target.id, reference_asset_id: 'old' },
    { id: 'second-profile', source: f.profile.id, target: f.target.id },
  ] }
  const before = structuredClone(graph)
  const migrated = freezeLegacyPromptReferenceDrafts(graph, f.detail)
  assert.equal(migrated.nodes[0].settings.profile_prompt_override,
    '[[ref:base]]保持身份，[[ref:new]]补充光线，[[ref:old]]补充衣服，4K画面')
  assert.deepEqual(migrated.nodes.at(-1), before.nodes.at(-1))
  assert.deepEqual(graph, before)
  assert.equal(freezeLegacyPromptReferenceDrafts(migrated, f.detail), migrated)
})

test('unselected profile numeric drafts remain untouched when their required base cannot be resolved', () => {
  const f = fixture()
  f.detail.visual_profiles![0].base_profile_id = 'base-profile'
  f.target.settings = { modality: 'image', visual_profile_id: 'profile', profile_prompt_override: '参考图1保持身份',
    prompt_reference_overrides: { base: null } }
  assert.equal(freezeLegacyPromptReferenceDrafts(f.graph, f.detail), f.graph)
})
