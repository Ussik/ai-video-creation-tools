import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Job, ProjectDetail, VisualProfile } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { activeProfileReferenceSnapshot, profileCandidateReferenceState, resolveCanvasVisualBoardReferences } from '../src/features/canvas/canvas-visual-board-references'

const profile = (id: string, board = `${id}-board`): VisualProfile => ({ id, project_id: 'p', kind: 'character', name: id, variant: '基础',
  definition: '固定外观', view_requirements: '', board_prompt: '制作人物设定', revision: 1, board_asset_id: board, asset_task_id: null })
const node = (id: string, profileId?: string, assetId?: string): CanvasNode => ({ id, type: 'generation', title: id, text: '', prompt: '',
  x: 0, y: 0, width: 200, height: 180, model_id: 'model', asset_id: assetId || null,
  settings: { modality: 'image', ...(profileId ? { visual_profile_id: profileId } : {}) } }) as CanvasNode
function fixture() {
  const base = profile('base'), state = { ...profile('state'), base_profile_id: base.id, board_asset_id: null, state_delta: '左手背溅泥' }
  const target = node('target', state.id)
  const graph = { nodes: [node('base-node', base.id), target], edges: [], revision: 'r' } as CanvasGraph
  const detail = { id: 'p', visual_profiles: [base, state], assets: [
    { id: base.board_asset_id, kind: 'image', filename: '基础.png' }, { id: 'candidate', kind: 'image', filename: '状态.png' },
  ], jobs: [], asset_tasks: [], shot_visual_bindings: [] } as unknown as ProjectDetail
  return { base, state, target, graph, detail }
}
const job = (id: string, refs: string[], options: Partial<Job> & { baseSignature?: string } = {}): Job => {
  const { baseSignature, ...rest } = options
  return { id, project_id: 'p', status: 'succeeded', result_asset_id: 'candidate', created_at: `2026-10-18T00:00:0${id.length}Z`,
    request: JSON.stringify({ visual_profile_id: 'state', reference_asset_ids: refs, ...(baseSignature ? { visual_base_signature: baseSignature } : {}) }), ...rest } as Job
}

test('implicit base is a real first input even without graph edges, so its new candidate is current', () => {
  const { state, target, graph, detail } = fixture()
  detail.jobs = [job('done', ['base-board'], { baseSignature: 'same' })]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  assert.equal(references.error, undefined)
  assert.deepEqual(references.assetIds, ['base-board'])
  assert.deepEqual(references.requiredAssetIds, ['base-board'])
  assert.equal(references.sources[0].role, 'base')
  assert.equal(references.sources[0].profileId, 'base')
  assert.equal(profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references, currentBaseSignature: 'same' }).status, 'current')
})

test('effective order matches backend: base, profile boards, fixed images, with deduplication', () => {
  const { state, target, graph, detail } = fixture(), manual = profile('manual')
  detail.visual_profiles!.push(manual)
  detail.assets.push(...[{ id: 'manual-board', kind: 'image', filename: '手工.png' }, { id: 'fixed', kind: 'image', filename: '固定.png' }] as ProjectDetail['assets'])
  graph.nodes.push(node('fixed-node', undefined, 'fixed'), node('manual-node', manual.id))
  graph.edges.push({ id: 'fixed-edge', source: 'fixed-node', target: target.id }, { id: 'manual-edge', source: 'manual-node', target: target.id },
    { id: 'base-edge', source: 'base-node', target: target.id, reference_asset_id: 'base-board' })
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  assert.deepEqual(references.assetIds, ['base-board', 'manual-board', 'fixed'])
  assert.deepEqual(references.referenceProfileIds, ['manual'])
  assert.deepEqual(references.referenceAssetIds, ['fixed', 'base-board'])
  assert.deepEqual(references.sources.map(item => item.profileId), ['base', 'manual', undefined])
})

test('manual replacements resolve transitively and remain explicit assets without a false profile version', () => {
  const { state, target, graph, detail } = fixture(), manual = profile('manual')
  detail.visual_profiles!.push(manual)
  detail.assets.push(...[{ id: 'manual-board', kind: 'image', filename: '原图.png' }, { id: 'replacement', kind: 'image', filename: '替换素材.png' }] as ProjectDetail['assets'])
  graph.nodes.push(node('manual-node', manual.id))
  graph.edges.push({ id: 'manual-edge', source: 'manual-node', target: target.id })
  target.settings.prompt_reference_overrides = { 'manual-board': 'middle', middle: 'replacement' }
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  assert.equal(references.error, undefined)
  assert.deepEqual(references.assetIds, ['base-board', 'replacement'])
  assert.equal(references.sources[1].profileId, undefined)
  assert.equal(references.sources[1].label, '替换素材.png')
  target.settings.prompt_reference_overrides = { 'manual-board': null }
  assert.deepEqual(resolveCanvasVisualBoardReferences(target, state, graph, detail).assetIds, ['base-board'])
})

test('required base cannot be removed or substituted; missing images and unconfirmed bases remain blocked', () => {
  const { base, state, target, graph, detail } = fixture()
  target.settings.prompt_reference_overrides = { 'base-board': null }
  assert.match(resolveCanvasVisualBoardReferences(target, state, graph, detail).error || '', /基础身份参考图必须保留/)
  target.settings.prompt_reference_overrides = { 'base-board': 'candidate' }
  assert.match(resolveCanvasVisualBoardReferences(target, state, graph, detail).error || '', /基础身份参考图必须保留/)
  target.settings.prompt_reference_overrides = {}
  detail.assets = detail.assets.filter(asset => asset.id !== 'base-board')
  assert.match(resolveCanvasVisualBoardReferences(target, state, graph, detail).error || '', /参考图片已不存在/)
  base.board_asset_id = null
  assert.match(resolveCanvasVisualBoardReferences(target, state, graph, detail).error || '', /请先生成并确认/)
})

test('displayed candidate uses its own successful request rather than a more recent selected node job', () => {
  const { state, target, graph, detail } = fixture()
  detail.jobs = [job('old', ['old-base']), job('newer', ['base-board'], { result_asset_id: 'another-candidate' })]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  const candidate = profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references })
  assert.equal(candidate.status, 'changed')
  assert.equal(candidate.job?.id, 'old')
  assert.deepEqual(candidate.reasons, ['images'])
  assert.match(candidate.message!, /当前候选使用的参考图片/)
})

test('base revision signatures detect a true base change even if its image stays the same', () => {
  const { state, target, graph, detail } = fixture()
  detail.jobs = [job('done', ['base-board'], { baseSignature: 'earlier-base-version' })]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  const candidate = profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references, currentBaseSignature: 'current-base-version' })
  assert.equal(candidate.status, 'changed')
  assert.deepEqual(candidate.reasons, ['base'])
  assert.match(candidate.message!, /基础版本已更新/)
})

test('reference order changes are reported without treating them as image replacement', () => {
  const { state, target, graph, detail } = fixture()
  detail.assets.push({ id: 'extra', kind: 'image' } as ProjectDetail['assets'][number])
  graph.nodes.push(node('extra-node', undefined, 'extra'))
  graph.edges.push({ id: 'extra-edge', source: 'extra-node', target: target.id })
  detail.jobs = [job('done', ['extra', 'base-board'])]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  const candidate = profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references })
  assert.deepEqual(candidate.reasons, ['order'])
  assert.match(candidate.message!, /顺序/)
})

test('pending tasks expose their frozen input list and suppress old candidate notices', () => {
  const { state, target, graph, detail } = fixture()
  detail.jobs = [job('old', ['obsolete']), job('running', ['submitted-base'], { status: 'running', result_asset_id: null, baseSignature: 'submitted-version' })]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  const running = activeProfileReferenceSnapshot(state, detail)
  assert.deepEqual(running?.assetIds, ['submitted-base'])
  assert.equal(running?.baseSignature, 'submitted-version')
  const candidate = profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references })
  assert.equal(candidate.status, 'pending')
  assert.equal(candidate.message, undefined)
})

test('no candidate, unavailable current inputs and legacy or unrelated jobs do not produce stale notices', () => {
  const { state, target, graph, detail } = fixture()
  detail.jobs = [job('done', ['obsolete'])]
  const references = resolveCanvasVisualBoardReferences(target, state, graph, detail)
  assert.equal(profileCandidateReferenceState({ profile: state, detail, references }).status, 'missing')
  assert.equal(profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references, generating: true }).status, 'pending')
  references.error = '基础图尚未确认'
  assert.deepEqual(profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references }).status, 'blocked')
  references.error = undefined
  detail.jobs = [job('legacy', [], { request: JSON.stringify({ visual_profile_id: 'state' }) })]
  assert.equal(profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references }).status, 'unknown')
  detail.jobs = [job('unrelated', [], { request: JSON.stringify({ visual_profile_id: 'another-profile', reference_asset_ids: [] }) })]
  assert.equal(profileCandidateReferenceState({ profile: state, detail, displayedAssetId: 'candidate', references }).status, 'unknown')
})
