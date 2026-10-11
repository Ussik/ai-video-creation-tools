import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectImageVideoHandoff, createImageVideoHandoff, fixedReferenceAsset, imageVideoConnection, pinnedCanvasReference } from '../src/canvas-shot-workflow'
import { storyboardItems } from '../src/storyboard'
import { visualNodeAsset } from '../src/canvas-visual-profiles'
import type { CanvasGraph, CanvasNode } from '../src/ProjectCanvas'
import type { Model, ProjectDetail } from '../src/api'

function fixture() {
  const source = { id: 'image', type: 'generation', title: '惊醒', x: 0, y: 0, width: 320, height: 240,
    text: '', prompt: '图片构图', asset_id: 'chosen', shot_id: 'shot', job_id: 'latest', settings: { modality: 'image', ratio: '9:16' } } as CanvasNode
  const graph = { nodes: [source], edges: [], revision: 'revision' } as CanvasGraph
  const detail = { id: 'project', name: '剧本', ratio: '9:16', shots: [{ id: 'shot', position: 0, title: '惊醒', duration: 12,
    prompt: '镜头描述', image_prompt: '静态近景', video_prompt: '角色睁眼，缓慢坐起，镜头推近' }],
    assets: [{ id: 'chosen', kind: 'image', shot_id: 'shot', filename: 'chosen.png' }, { id: 'new', kind: 'image', shot_id: 'shot' }],
    jobs: [{ id: 'latest', status: 'succeeded', result_asset_id: 'new' }], script: { artifacts: [], scenes: [], outline: '', characters: '' } } as unknown as ProjectDetail
  const models = [{ id: 'unsupported', modality: 'video', settings: { supported_modes: ['text'] } },
    { id: 'compatible', modality: 'video', settings: { supported_modes: ['first_frame'], min_duration: 4, max_duration: 10,
      resolutions: ['480p', '720p'], default_resolution: '720p' } }] as Model[]
  const fresh = { ...source, id: 'video', x: 500, settings: {} } as CanvasNode
  return { source, graph, detail, models, fresh }
}

test('handoff adds one same-shot video generator, selects a compatible model and pins the chosen candidate', () => {
  const f = fixture(), before = structuredClone(f)
  const result = createImageVideoHandoff(f.graph, f.source, f.detail, f.models, f.fresh, 'frame-edge')
  assert.deepEqual(f, before)
  assert.equal(result.created, true)
  assert.equal(result.graph.nodes.length, 2)
  const video = result.graph.nodes[1]
  assert.equal(video.shot_id, 'shot')
  assert.equal(video.model_id, 'compatible')
  assert.equal(video.prompt, '角色睁眼，缓慢坐起，镜头推近')
  assert.equal(video.asset_id, null)
  assert.equal(video.job_id, null)
  assert.deepEqual(video.settings, { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', candidate_count: 1, storyboard_reference_asset_id: 'chosen',
    duration: 10, ratio: 'adaptive', resolution: '480p' })
  assert.deepEqual(result.graph.edges, [{ id: 'frame-edge', source: 'image', target: 'video', reference_asset_id: 'chosen' }])
  assert.deepEqual(storyboardItems(f.detail, result.graph, f.models).map(item => item.kind), ['image', 'video'])
})

test('repeated handoff reuses the node; a regenerated source cannot change its pinned frame', () => {
  const f = fixture()
  const first = createImageVideoHandoff(f.graph, f.source, f.detail, f.models, f.fresh, 'frame-edge')
  const repeated = createImageVideoHandoff(first.graph, f.source, f.detail, f.models, { ...f.fresh, id: 'duplicate' }, 'duplicate-edge')
  assert.equal(repeated.graph, first.graph)
  assert.equal(repeated.nodeId, 'video')
  assert.equal(repeated.created, false)
  const regenerated = { ...f.source, asset_id: 'new' }
  const pinned = pinnedCanvasReference(regenerated, first.graph.edges[0].reference_asset_id)
  assert.equal(visualNodeAsset(pinned, f.detail)?.id, 'chosen')
  assert.equal(pinned.job_id, null)
  assert.equal(fixedReferenceAsset(first.graph, 'video', f.detail.assets)[0].asset?.id, 'chosen')
  assert.equal(visualNodeAsset(pinned, { ...f.detail, assets: f.detail.assets.filter(asset => asset.id !== 'chosen') }), undefined)
  assert.equal(fixedReferenceAsset(first.graph, 'video', f.detail.assets.filter(asset => asset.id !== 'chosen'))[0].asset, undefined)
  const newHandoff = createImageVideoHandoff(first.graph, regenerated, f.detail, f.models, { ...f.fresh, id: 'new-video' }, 'new-edge')
  assert.equal(newHandoff.graph.nodes.length, 3)
  assert.equal(newHandoff.graph.edges[1].reference_asset_id, 'new')
})

test('legacy media inherits its asset shot, no compatible model stays unselected, and invalid sources are rejected', () => {
  const f = fixture()
  const media = { ...f.source, type: 'image' as const, shot_id: null, job_id: null }
  const result = createImageVideoHandoff(f.graph, media, f.detail, [], f.fresh, 'edge')
  assert.equal(result.graph.nodes[1].shot_id, 'shot')
  assert.equal(result.graph.nodes[1].model_id, null)
  assert.equal(result.graph.nodes[1].settings.mode, 'first_frame')
  assert.equal(result.graph.nodes[1].settings.ratio, 'adaptive')
  assert.equal(result.graph.nodes[1].settings.resolution, '480p')
  assert.throws(() => createImageVideoHandoff(f.graph, { ...f.source, settings: { visual_profile_id: 'profile' } }, f.detail, f.models, f.fresh, 'edge'), /设定信息图/)
  assert.throws(() => createImageVideoHandoff(f.graph, { ...f.source, asset_id: 'missing' }, f.detail, f.models, f.fresh, 'edge'), /选择一张/)
})

function connectionFixture() {
  const f = fixture()
  const target = { ...f.fresh, title: '已有视频节点', shot_id: null, model_id: 'unsupported', prompt: '', text: '', asset_id: null, job_id: null,
    settings: { modality: 'video', mode: 'text', ratio: '16:9' } } as CanvasNode
  return { ...f, target, graph: { ...f.graph, nodes: [f.source, target] } }
}

test('connecting an existing video generator carries the shot video prompt and pinned frame without adding nodes', () => {
  const f = connectionFixture(), before = structuredClone(f)
  const pair = imageVideoConnection(f.source, f.target, f.detail, f.models)!
  const graph = connectImageVideoHandoff(f.graph, pair, f.detail, f.models, 'edge')
  assert.deepEqual(f, before)
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0], f.source)
  const target = graph.nodes[1]
  assert.equal(target.id, f.target.id)
  assert.equal(target.title, f.target.title)
  assert.equal(target.x, f.target.x)
  assert.equal(target.width, f.target.width)
  assert.equal(target.shot_id, 'shot')
  assert.equal(target.prompt, '角色睁眼，缓慢坐起，镜头推近')
  assert.equal(target.model_id, 'compatible')
  assert.equal(target.settings.mode, 'first_frame')
  assert.equal(target.settings.visual_reference_mode, 'keyframe')
  assert.equal(target.settings.duration, 10)
  assert.equal(target.settings.resolution, '480p')
  assert.equal(target.settings.ratio, '16:9')
  assert.deepEqual(graph.edges, [{ id: 'edge', source: 'image', target: 'video', reference_asset_id: 'chosen' }])
  const repeated = connectImageVideoHandoff(graph, pair, f.detail, f.models, 'duplicate')
  assert.equal(repeated, graph)
  const button = createImageVideoHandoff(graph, f.source, f.detail, f.models, { ...f.fresh, id: 'new-video' }, 'new-edge')
  assert.equal(button.created, false)
  assert.equal(button.nodeId, f.target.id)
  assert.equal(button.graph, graph)
})

test('reverse drags normalize to image -> video, excluding profiles, missing results and non-generators', () => {
  const f = connectionFixture()
  const forward = imageVideoConnection(f.source, f.target, f.detail, f.models)!
  assert.deepEqual(imageVideoConnection(f.target, f.source, f.detail, f.models), forward)
  assert.equal(imageVideoConnection({ ...f.source, settings: { visual_profile_id: 'profile' } }, f.target, f.detail, f.models), undefined)
  assert.equal(imageVideoConnection({ ...f.source, asset_id: 'missing' }, f.target, f.detail, f.models), undefined)
  assert.equal(imageVideoConnection({ ...f.source, asset_id: null, job_id: null }, f.target, f.detail, f.models), undefined)
  assert.equal(imageVideoConnection(f.source, { ...f.target, type: 'video' }, f.detail, f.models), undefined)
  const legacy = { ...f.target, settings: {}, model_id: 'compatible' }
  assert.equal(imageVideoConnection(f.source, legacy, f.detail, f.models)?.target, legacy)
})

test('connecting preserves manual prompts, selected compatible model, output history and valid parameters', () => {
  const f = connectionFixture()
  const target = { ...f.target, shot_id: 'shot', model_id: 'compatible', asset_id: 'video-result', job_id: 'old-job',
    prompt: '自己的运镜', text: '已经修改的完整视频提示词',
    settings: { ...f.target.settings, prompt_override: true, prompt_is_final: true, prompt_base: '自己的运镜', prompt_template: '旧模板',
      duration: 7, resolution: '1080p', generate_audio: false, candidate_count: 4 } }
  const graph = { ...f.graph, nodes: [f.source, target] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, f.models)!, f.detail, f.models, 'edge')
  const video = result.nodes[1]
  assert.equal(video.shot_id, 'shot')
  assert.equal(video.prompt, target.prompt)
  assert.equal(video.text, target.text)
  assert.equal(video.asset_id, target.asset_id)
  assert.equal(video.job_id, target.job_id)
  assert.equal(video.settings.prompt_base, target.settings.prompt_base)
  assert.equal(video.settings.prompt_template, target.settings.prompt_template)
  assert.equal(video.model_id, 'compatible')
  assert.equal(video.settings.duration, 7)
  assert.equal(video.settings.resolution, '1080p')
  assert.equal(video.settings.ratio, '16:9')
  assert.equal(video.settings.candidate_count, 4)
  assert.equal(video.settings.generate_audio, false)
  assert.equal(fixedReferenceAsset(result, video.id, f.detail.assets)[0].asset?.id, 'chosen')
  assert.equal(visualNodeAsset(pinnedCanvasReference({ ...f.source, asset_id: 'new' }, result.edges[0].reference_asset_id), f.detail)?.id, 'chosen')
})

test('single-frame reconnection replaces previous image inputs, preserves text/output edges and reuses edge identity', () => {
  const f = connectionFixture()
  const otherImage = { ...f.source, id: 'other-image', asset_id: 'new' }
  const text = { ...f.source, id: 'text', type: 'text' as const, asset_id: null, settings: {} }
  const graph = { ...f.graph, nodes: [...f.graph.nodes, otherImage, text], edges: [
    { id: 'old-frame', source: f.source.id, target: f.target.id, reference_asset_id: 'new' },
    { id: 'extra-frame', source: otherImage.id, target: f.target.id },
    { id: 'text', source: text.id, target: f.target.id },
    { id: 'output', source: f.target.id, target: 'output-node' },
  ] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.target, f.source, f.detail, f.models)!, f.detail, f.models, 'unused')
  assert.deepEqual(result.edges, [{ id: 'old-frame', source: 'image', target: 'video', reference_asset_id: 'chosen' },
    graph.edges[2], graph.edges[3]])
  assert.equal(result.nodes.length, graph.nodes.length)
})

test('explicit first-last-frame and reference modes retain existing ordered inputs and chosen compatible model', () => {
  for (const mode of ['first_last_frame', 'reference'] as const) {
    const f = connectionFixture()
    const model = { ...f.models[1], settings: { ...f.models[1].settings, supported_modes: [mode] } }
    const target = { ...f.target, model_id: model.id, settings: { ...f.target.settings, mode, ratio: '16:9' } }
    const first = { ...f.source, id: 'first', asset_id: 'new' }
    const graph = { ...f.graph, nodes: [f.source, target, first], edges: [{ id: 'first', source: first.id, target: target.id, reference_asset_id: 'new' }] }
    const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, [model])!, f.detail, [model], 'second')
    assert.equal(result.nodes[1].settings.mode, mode)
    assert.equal(result.nodes[1].model_id, model.id)
    assert.deepEqual(result.edges.map(edge => edge.reference_asset_id), ['new', 'chosen'])
    assert.equal(result.nodes[1].settings.ratio, '16:9')
    if (mode === 'first_last_frame') assert.equal(result.nodes[1].settings.visual_reference_mode, 'keyframe')
  }
})

test('asset shot fallback and no compatible model work on an existing video even at the node limit', () => {
  const f = connectionFixture()
  const source = { ...f.source, shot_id: null, type: 'image' as const }
  const graph = { ...f.graph, nodes: [source, f.target, ...Array.from({ length: 498 }, (_,i) => ({ ...f.source, id: `filler-${i}` }))] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(source, f.target, f.detail, f.models)!, f.detail, [], 'edge')
  assert.equal(result.nodes.length, 500)
  assert.equal(result.nodes[1].shot_id, 'shot')
  assert.equal(result.nodes[1].model_id, null)
  assert.equal(result.nodes[1].settings.mode, 'first_frame')
  assert.equal(result.nodes[1].settings.resolution, '480p')
  assert.equal(result.nodes[1].settings.ratio, '16:9')
  assert.equal(result.edges.length, 1)
})

test('connecting a frame preserves every explicit resolution and defaults an unset aspect ratio to adaptive', () => {
  for (const resolution of ['480p', '720p', '1080p', '4k']) {
    const f = connectionFixture()
    const target = { ...f.target, model_id: 'compatible', settings: { ...f.target.settings, ratio: undefined, resolution } }
    const graph = { ...f.graph, nodes: [f.source, target] }
    const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, f.models)!, f.detail, f.models, 'edge')
    assert.equal(result.nodes[1].settings.resolution, resolution)
    assert.equal(result.nodes[1].settings.ratio, 'adaptive')
  }
})

test('switching to a compatible first-frame model preserves an explicitly chosen resolution', () => {
  const f = connectionFixture()
  const target = { ...f.target, settings: { ...f.target.settings, resolution: '1080p' } }
  const graph = { ...f.graph, nodes: [f.source, target] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, f.models)!, f.detail, f.models, 'edge')
  assert.equal(result.nodes[1].model_id, 'compatible')
  assert.equal(result.nodes[1].settings.resolution, '1080p')
  assert.equal(result.nodes[1].settings.ratio, '16:9')
})

test('updating the first-frame candidate of a two-frame video keeps it before the last frame', () => {
  const f = connectionFixture()
  const target = { ...f.target, settings: { ...f.target.settings, mode: 'first_last_frame' as const } }
  const last = { ...f.source, id: 'last', asset_id: 'new' }
  const graph = { ...f.graph, nodes: [f.source, target, last], edges: [
    { id: 'first', source: f.source.id, target: target.id, reference_asset_id: 'new' },
    { id: 'last', source: last.id, target: target.id, reference_asset_id: 'new' },
  ] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, f.models)!, f.detail, f.models, 'unused')
  assert.deepEqual(result.edges.map(edge => [edge.id, edge.reference_asset_id]), [['first', 'chosen'], ['last', 'new']])
})

function withVisualReferences(detail: ProjectDetail): ProjectDetail {
  return { ...detail, shot_visual_bindings: [{ shot_id: 'shot', profile_id: 'character', kind: 'character', name: '林晚',
    variant: '日常服装', required: true, revision: 1, board_asset_id: 'character-board' }] } as ProjectDetail
}

function multiReferenceVideoModel(): Model {
  return { id: 'multi-reference', modality: 'video', settings: {
    supported_modes: ['text', 'first_frame', 'reference'], max_duration: 15,
    request_template: { prompt: '{{prompt}}', images: '{{images}}' },
  } } as Model
}

test('explicit reference handoff selects a supported multi-image video model and pins its composition asset', () => {
  const f = fixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const result = createImageVideoHandoff(f.graph, f.source, detail, [...f.models, model], f.fresh, 'edge', 'reference')
  const video = result.graph.nodes[1]
  assert.equal(video.model_id, model.id)
  assert.equal(video.settings.mode, 'reference')
  assert.equal(video.settings.visual_reference_mode, 'profiles')
  assert.equal(video.settings.storyboard_reference_asset_id, 'chosen')
  assert.equal(video.settings.resolution, '480p')
  assert.equal(video.settings.duration, 12)
  assert.equal(video.prompt, '角色睁眼，缓慢坐起，镜头推近')
  assert.deepEqual(result.graph.edges, [{ id: 'edge', source: 'image', target: 'video', reference_asset_id: 'chosen' }])
  // Missing boards remain bound so the generator can ask the user to prepare them.
  assert.equal(detail.shot_visual_bindings?.[0].board_asset_id, 'character-board')
})

test('default image handoff stays first-frame even when profiles and multi-reference models are available', () => {
  const f = fixture(), model = multiReferenceVideoModel()
  const referenceOnly = { ...model, settings: { ...model.settings, request_template: { prompt: '{{prompt}}', image: '{{image}}' } } }
  for (const [detail, models] of [
    [f.detail, [...f.models, model]],
    [{ ...withVisualReferences(f.detail), shot_visual_bindings: [{ ...withVisualReferences(f.detail).shot_visual_bindings![0], shot_id: 'other' }] }, [...f.models, model]],
    [withVisualReferences(f.detail), [...f.models, referenceOnly]],
  ] as [ProjectDetail, Model[]][]) {
    const video = createImageVideoHandoff(f.graph, f.source, detail, models, f.fresh, 'edge').graph.nodes[1]
    assert.equal(video.settings.mode, 'first_frame')
    assert.equal(video.settings.visual_reference_mode, 'keyframe')
    assert.equal(video.settings.storyboard_reference_asset_id, 'chosen')
  }
})

test('repeated multi-reference handoff reuses the pinned candidate even through another image node', () => {
  const f = fixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const first = createImageVideoHandoff(f.graph, f.source, detail, [model], f.fresh, 'edge', 'reference')
  const alias = { ...f.source, id: 'same-image', asset_id: 'chosen' }
  const graph = { ...first.graph, nodes: [...first.graph.nodes, alias] }
  const repeated = createImageVideoHandoff(graph, alias, detail, [model], { ...f.fresh, id: 'duplicate' }, 'duplicate-edge', 'reference')
  assert.equal(repeated.created, false)
  assert.equal(repeated.nodeId, 'video')
  assert.equal(repeated.graph, graph)
  const regenerated = { ...f.source, asset_id: 'new' }
  const next = createImageVideoHandoff(graph, regenerated, detail, [model], { ...f.fresh, id: 'new-video' }, 'new-edge', 'reference')
  assert.equal(next.created, true)
  assert.equal(next.graph.nodes.at(-1)?.settings.storyboard_reference_asset_id, 'new')
  assert.equal(first.graph.nodes[1].settings.storyboard_reference_asset_id, 'chosen')
})

test('connecting to default text video upgrades to multi-reference while retaining manual settings and all input edges', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const character = { ...f.source, id: 'character-board', shot_id: null, settings: { modality: 'image' as const, visual_profile_id: 'character' } }
  const target = { ...f.target, prompt: '自定义动作', text: '手工完整版', job_id: 'video-job', asset_id: 'video-result',
    settings: { ...f.target.settings, prompt_override: true, duration: 30, resolution: '4k', candidate_count: 4, generate_audio: false } }
  const graph = { ...f.graph, nodes: [f.source, target, character], edges: [{ id: 'character-input', source: character.id, target: target.id }] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, detail, [model])!, detail, [model], 'shot-input')
  const video = result.nodes[1]
  assert.equal(video.settings.mode, 'reference')
  assert.equal(video.settings.visual_reference_mode, 'profiles')
  assert.equal(video.settings.storyboard_reference_asset_id, 'chosen')
  assert.equal(video.model_id, model.id)
  assert.equal(video.settings.ratio, '16:9')
  assert.equal(video.settings.resolution, '4k')
  assert.equal(video.settings.duration, 30)
  assert.equal(video.settings.generate_audio, false)
  assert.equal(video.settings.candidate_count, 4)
  assert.equal(video.prompt, target.prompt)
  assert.equal(video.text, target.text)
  assert.equal(video.job_id, target.job_id)
  assert.equal(video.asset_id, target.asset_id)
  assert.equal(video.x, target.x)
  assert.equal(video.width, target.width)
  assert.deepEqual(result.edges.map(edge => edge.id), ['character-input', 'shot-input'])
})

test('an explicitly selected first-frame strategy is retained despite available bound multi-reference models', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const target = { ...f.target, model_id: model.id, settings: { ...f.target.settings, mode: 'first_frame' as const, visual_reference_mode: 'keyframe' as const } }
  const graph = { ...f.graph, nodes: [f.source, target] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, detail, [model])!, detail, [model], 'edge')
  assert.equal(result.nodes[1].settings.mode, 'first_frame')
  assert.equal(result.nodes[1].settings.visual_reference_mode, 'keyframe')
  assert.equal(result.nodes[1].settings.storyboard_reference_asset_id, undefined)
})

test('connecting another reference cannot replace an explicit primary composition or remove earlier profile inputs', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const primary = { ...f.source, id: 'primary', asset_id: 'new' }
  const target = { ...f.target, model_id: model.id, shot_id: 'shot', settings: { ...f.target.settings, mode: 'reference' as const,
    visual_reference_mode: 'profiles' as const, storyboard_reference_asset_id: 'new' } }
  const graph = { ...f.graph, nodes: [f.source, target, primary], edges: [{ id: 'primary-input', source: primary.id, target: target.id, reference_asset_id: 'new' }] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, detail, [model])!, detail, [model], 'another-input')
  assert.equal(result.nodes[1].settings.storyboard_reference_asset_id, 'new')
  assert.deepEqual(result.edges.map(edge => edge.reference_asset_id), ['new', 'chosen'])
})

test('legacy reference connection receives a composition pin and repeated connection uses the updated node', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel()
  const target = { ...f.target, shot_id: 'shot', model_id: model.id, settings: { ...f.target.settings, mode: 'reference' as const } }
  const graph = { ...f.graph, nodes: [f.source, target], edges: [{ id: 'edge', source: f.source.id, target: target.id, reference_asset_id: 'chosen' }] }
  const pair = imageVideoConnection(f.source, target, f.detail, [model])!
  const result = connectImageVideoHandoff(graph, pair, f.detail, [model], 'unused')
  assert.equal(result.nodes[1].settings.storyboard_reference_asset_id, 'chosen')
  assert.equal(result.edges[0].id, 'edge')
  assert.equal(connectImageVideoHandoff(result, pair, f.detail, [model], 'unused'), result)
})

test('reconnecting a strict first-frame video updates a primary pin retained from a prior multi-reference strategy', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const source = { ...f.source, asset_id: 'new' }
  const target = { ...f.target, shot_id: 'shot', model_id: model.id, settings: { ...f.target.settings, mode: 'first_frame' as const,
    visual_reference_mode: 'keyframe' as const, storyboard_reference_asset_id: 'chosen' } }
  const graph = { ...f.graph, nodes: [source, target], edges: [{ id: 'first-frame', source: source.id, target: target.id, reference_asset_id: 'chosen' }] }
  const result = connectImageVideoHandoff(graph, imageVideoConnection(source, target, detail, [model])!, detail, [model], 'unused')
  assert.equal(result.nodes[1].settings.storyboard_reference_asset_id, 'new')
  assert.equal(result.nodes[1].settings.mode, 'first_frame')
  assert.deepEqual(result.edges, [{ id: 'first-frame', source: source.id, target: target.id, reference_asset_id: 'new' }])
  const stalePin = { ...result, nodes: [source, target] }
  const repaired = connectImageVideoHandoff(stalePin, imageVideoConnection(source, target, detail, [model])!, detail, [model], 'unused')
  assert.equal(repaired.nodes[1].settings.storyboard_reference_asset_id, 'new')
})

test('cross-shot assets and existing video targets are rejected before any mutation or repeated-edge shortcut', () => {
  const f = connectionFixture(), before = structuredClone(f.graph)
  const target = { ...f.target, shot_id: 'different-shot' }
  const graph = { ...f.graph, nodes: [f.source, target], edges: [{ id: 'edge', source: f.source.id, target: target.id, reference_asset_id: 'chosen' }] }
  assert.throws(() => connectImageVideoHandoff(graph, imageVideoConnection(f.source, target, f.detail, f.models)!, f.detail, f.models, 'new'), /不同镜头/)
  const wrongAsset = { ...f.source, shot_id: 'different-shot' }
  assert.throws(() => createImageVideoHandoff(f.graph, wrongAsset, f.detail, f.models, f.fresh, 'edge'), /不同镜头/)
  assert.throws(() => connectImageVideoHandoff(f.graph, imageVideoConnection(wrongAsset, f.target, f.detail, f.models)!, f.detail, f.models, 'edge'), /不同镜头/)
  assert.deepEqual(f.graph, before)
})


test('explicit first-frame and reference actions create separate strategies for the same source and retain drafts', () => {
  const f = fixture(), model = multiReferenceVideoModel(), detail = withVisualReferences(f.detail)
  const first = createImageVideoHandoff(f.graph, f.source, detail, [model], f.fresh, 'first-edge', 'first_frame')
  first.graph.nodes[1].text = '我的动作设计'
  first.graph.nodes[1].settings.prompt_is_final = true
  const reference = createImageVideoHandoff(first.graph, f.source, detail, [model], { ...f.fresh, id: 'ref-video' }, 'ref-edge', 'reference')
  assert.equal(reference.created, true)
  assert.equal(reference.graph.nodes.length, 3)
  assert.equal(reference.graph.nodes[1].settings.mode, 'first_frame')
  assert.equal(reference.graph.nodes[1].text, '我的动作设计')
  assert.equal(reference.graph.nodes[2].settings.mode, 'reference')
  assert.equal(createImageVideoHandoff(reference.graph, f.source, detail, [model], f.fresh, 'unused', 'reference').nodeId, 'ref-video')
  assert.throws(() => createImageVideoHandoff(f.graph, f.source, detail, f.models, f.fresh, 'edge', 'reference'), /没有支持多图参考/)
})

test('image-only and inactive bindings do not automatically switch dragged images to reference video', () => {
  const f = connectionFixture(), model = multiReferenceVideoModel()
  for (const usage of ['image', 'none'] as const) {
    const detail = withVisualReferences(f.detail)
    detail.shot_visual_bindings![0].usage = usage
    const result = connectImageVideoHandoff(f.graph, imageVideoConnection(f.source, f.target, detail, [model])!, detail, [model], 'edge')
    assert.equal(result.nodes[1].settings.mode, 'first_frame')
  }
})
