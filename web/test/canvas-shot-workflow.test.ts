import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { rememberModelSelection } from '../src/features/models/model-selection-store'
import { connectImageVideoHandoff, createImageVideoHandoff, fixedReferenceAsset, imageVideoConnection, pendingImageVideoHandoff, resolveImageVideoHandoff, pinnedCanvasReference } from '../src/features/canvas/canvas-shot-workflow'
import type { ImageVideoSemanticPlan } from '../src/features/canvas/canvas-image-video-context'
import { storyboardItems } from '../src/features/storyboard/storyboard'
import { visualNodeAsset } from '../src/features/canvas/canvas-visual-profiles'
import { syncCanvasStoryboardRevision } from '../src/features/canvas/canvas-storyboard-revision'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import type { Model, ProjectDetail } from '../src/shared/api/api'

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

function semanticPlan(text = '刘叔，这两天自来水管没洗吧？'): ImageVideoSemanticPlan {
  return { motion_prompt: '许知夜放下纸巾，看向老板，平稳说出本镜台词。', audio_plan: { version: 1,
    speech: [{ speaker: '许知夜', text, delivery: '平稳', mode: 'dialogue', source_text: `许知夜：“${text}”` }],
    sound_effects: ['雨声'], music: '', silent: false } }
}

test('video handoff prefers the compatible default and preserves an explicit compatible selection', () => {
  const f = fixture()
  const preferred = { ...f.models[1], id: 'default-video', is_default: true } as Model
  const models = [...f.models, preferred]
  const create = (candidates: Model[], selectedId?: string) => createImageVideoHandoff(f.graph, f.source, f.detail,
    candidates, { ...f.fresh, model_id: selectedId || null }, 'edge').graph.nodes[1]
  assert.equal(create(models).model_id, preferred.id)
  assert.equal(create(models, 'compatible').model_id, 'compatible')
  assert.equal(create([{ ...f.models[0], is_default: true }, f.models[1]]).model_id, 'compatible')
})

test('video handoff uses the most recent compatible choice while keeping explicit bindings and capability fallbacks', () => {
  const browser = new JSDOM('', { url: 'http://localhost/' }), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window })
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: browser.window.CustomEvent })
  try {
    const f = fixture(), configured = { ...f.models[1], id: 'configured-video', is_default: true } as Model
    const recent = { ...f.models[1], id: 'recent-video' } as Model
    const models = [...f.models, configured, recent]
    const create = (selectedId?: string) => createImageVideoHandoff(f.graph, f.source, f.detail,
      models, { ...f.fresh, model_id: selectedId || null }, 'edge').graph.nodes[1]!
    rememberModelSelection('video', recent.id)
    assert.equal(create().model_id, recent.id)
    assert.equal(create('compatible').model_id, 'compatible', 'explicit existing binding wins over the shared preference')
    rememberModelSelection('video', 'unsupported')
    assert.equal(create().model_id, configured.id, 'a remembered text-only video generator cannot handle a first-frame handoff')
    rememberModelSelection('video', 'removed-model')
    assert.equal(create().model_id, configured.id)
    assert.equal(f.fresh.model_id, f.source.model_id)
  } finally {
    browser.window.close()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent)
    else Reflect.deleteProperty(globalThis, 'CustomEvent')
  }
})

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
  const { image_video_handoff, ...parameters } = video.settings
  assert.equal(image_video_handoff?.source_node_id, f.source.id)
  assert.equal(image_video_handoff?.source_asset_id, 'chosen')
  assert.deepEqual(parameters, { modality: 'video', mode: 'first_frame', visual_reference_mode: 'keyframe', candidate_count: 1, storyboard_reference_asset_id: 'chosen',
    storyboard_revision: 0, duration: 10, ratio: 'adaptive', resolution: '720p' })
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

test('restored media makes usable video handoffs while its owner remains recycled', () => {
  const f = connectionFixture()
  f.detail.shots = []
  const source = { ...f.source, type: 'image' as const, shot_id: null, job_id: null }
  const graph = { ...f.graph, nodes: [source, f.target] }
  const before = structuredClone(f.detail)
  const created = createImageVideoHandoff(graph, source, f.detail, f.models, f.fresh, 'created-edge')
  assert.equal(created.graph.nodes.at(-1)!.shot_id, null)
  assert.equal(created.graph.nodes.at(-1)!.settings.storyboard_reference_asset_id, 'chosen')
  const connected = connectImageVideoHandoff(graph, imageVideoConnection(source, f.target, f.detail, f.models)!, f.detail, f.models, 'connected-edge')
  assert.equal(connected.nodes[1].shot_id, null)
  assert.equal(connected.edges[0].reference_asset_id, 'chosen')
  assert.deepEqual(f.detail, before)
})

test('video handoffs retain live historical shot ownership, prompt and revision', () => {
  const f = connectionFixture()
  const historical = { ...f.detail.shots[0], storyboard_revision: 3 }
  f.detail.shots = []
  f.detail.historical_shots = [historical]
  const source = { ...f.source, type: 'image' as const, shot_id: null, job_id: null }
  const graph = { ...f.graph, nodes: [source, f.target] }
  const created = createImageVideoHandoff(graph, source, f.detail, f.models, f.fresh, 'created-edge').graph.nodes.at(-1)!
  assert.equal(created.shot_id, historical.id)
  assert.equal(created.prompt, historical.video_prompt)
  assert.equal(created.settings.storyboard_revision, 3)
  const connected = connectImageVideoHandoff(graph, imageVideoConnection(source, f.target, f.detail, f.models)!, f.detail, f.models, 'connected-edge').nodes[1]
  assert.equal(connected.shot_id, historical.id)
  assert.equal(connected.prompt, historical.video_prompt)
  assert.equal(connected.settings.storyboard_revision, 3)
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
  assert.equal(target.settings.resolution, '720p')
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

test('new video handoffs and newly associated generators carry the current storyboard revision without losing their chosen frame', () => {
  const f = connectionFixture()
  f.detail.shots[0].storyboard_revision = 3
  f.source.settings.storyboard_revision = 3
  const created = createImageVideoHandoff(f.graph, f.source, f.detail, f.models, { ...f.fresh, id: 'new-video' }, 'new-frame')
  const video = created.graph.nodes.find(node => node.id === 'new-video')!
  assert.equal(video.settings.storyboard_revision, 3)
  assert.equal(video.settings.storyboard_reference_asset_id, 'chosen')
  const synchronized = syncCanvasStoryboardRevision(created.graph, f.detail.shots, f.models, f.detail.assets)
  assert.equal(synchronized.nodes.find(node => node.id === video.id), video)
  assert.equal(synchronized.edges.find(edge => edge.target === video.id)?.reference_asset_id, 'chosen')

  const connected = connectImageVideoHandoff(f.graph, imageVideoConnection(f.source, f.target, f.detail, f.models)!, f.detail, f.models, 'existing-frame')
  assert.equal(connected.nodes[1].settings.storyboard_revision, 3)
  assert.equal(syncCanvasStoryboardRevision(connected, f.detail.shots, f.models, f.detail.assets), connected)
  assert.equal(connected.edges[0].reference_asset_id, 'chosen')
})

test('image handoffs reject automatic fallback to an older storyboard job while preserving explicit historical image choices', () => {
  const f = connectionFixture()
  f.detail.shots[0].storyboard_revision = 3
  f.source.settings.storyboard_revision = 3
  f.detail.jobs[0].shot_id = 'shot'; f.detail.jobs[0].request = JSON.stringify({ storyboard_revision: 2 })
  const unselected = { ...f.source, asset_id: null }
  assert.equal(imageVideoConnection(unselected, f.target, f.detail, f.models), undefined)
  assert.throws(() => createImageVideoHandoff(f.graph, unselected, f.detail, f.models, f.fresh, 'edge'), /选择一张/)
  assert.equal(imageVideoConnection(f.source, f.target, f.detail, f.models)!.asset.id, 'chosen', 'an explicit historical candidate remains usable')
  f.detail.jobs[0].request = JSON.stringify({ storyboard_revision: 3 })
  assert.equal(imageVideoConnection(unselected, f.target, f.detail, f.models)!.asset.id, 'new')
  f.detail.jobs[0].request = '{}'
  assert.equal(imageVideoConnection({ ...unselected, settings: { modality: 'image' } }, f.target, f.detail, f.models)!.asset.id, 'new', 'legacy revision zero remains supported')
})

test('the permanent script card does not consume an ordinary node slot during video handoff', () => {
  const f = fixture()
  const script = { ...f.source, id: 'project-script', type: 'project_script_ref' as const, shot_id: null }
  const full = { ...f.graph, nodes: [script, f.source, ...Array.from({ length: 498 }, (_, index) => ({ ...f.source, id: `filler-${index}` }))] }
  const created = createImageVideoHandoff(full, f.source, f.detail, f.models, f.fresh, 'last-slot')
  assert.equal(created.graph.nodes.length, 501)
  assert.throws(() => createImageVideoHandoff(created.graph, { ...f.source, asset_id: 'new' }, f.detail, f.models,
    { ...f.fresh, id: 'overflow' }, 'overflow'), /上限/)
})

function editedImage(f: ReturnType<typeof fixture>, body = '裴砚站在林晚左后方，怀抱卷宗，保持低机位。') {
  return { ...f.source, text: body, settings: { ...f.source.settings,
    prompt_override: true, prompt_is_final: true, prompt_body: body, prompt_base: f.source.prompt } }
}

test('changed image updates an untouched video in place, preserving geometry, parameters and completed media history', () => {
  const f = fixture(), source = editedImage(f)
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
  const video = { ...first.graph.nodes[1], x: 950, width: 480, asset_id: 'saved-video', job_id: 'completed',
    settings: { ...first.graph.nodes[1].settings, duration: 8, resolution: '1080p' } }
  const nextSource = editedImage(f, '裴砚站在林晚右侧，举起卷宗。')
  const graph = { ...first.graph, nodes: [nextSource, video] }
  const detail = { ...f.detail, jobs: [...f.detail.jobs, { id: 'completed', status: 'succeeded' } as ProjectDetail['jobs'][number]] }
  const next = createImageVideoHandoff(graph, nextSource, detail, f.models, { ...f.fresh, id: 'unused' }, 'unused')
  assert.equal(next.updated, true)
  assert.equal(next.created, false)
  assert.equal(next.nodeId, video.id)
  assert.equal(next.graph.nodes.length, 2)
  const refreshed = next.graph.nodes[1]
  assert.match(refreshed.text, /右侧，举起卷宗/)
  assert.doesNotMatch(refreshed.text, /角色睁眼|林晚左后方|单幅首帧/)
  assert.equal(refreshed.x, 950)
  assert.equal(refreshed.width, 480)
  assert.equal(refreshed.asset_id, 'saved-video')
  assert.equal(refreshed.job_id, 'completed')
  assert.equal(refreshed.settings.duration, 8)
  assert.match(refreshed.text, /视频时长：8 秒/)
  assert.match(refreshed.text, /1080p/)
  assert.equal(createImageVideoHandoff(next.graph, nextSource, detail, f.models, f.fresh, 'unused').graph, next.graph)
})

test('changing only shot dialogue refreshes automatic handoffs once and preserves a manually edited video', () => {
  const f = fixture(), source = editedImage(f, '许知夜坐在桌前。')
  const detail = { ...f.detail, shots: [{ ...f.detail.shots[0], video_prompt: '许知夜低沉开口：“原来的台词。”' }] }
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, detail, f.models, f.fresh, 'frame', 'first_frame', semanticPlan('原来的台词。'))
  const changed = { ...detail, shots: [{ ...detail.shots[0], video_prompt: '许知夜低沉开口：“新的台词。”' }] }
  const next = createImageVideoHandoff(first.graph, source, changed, f.models, { ...f.fresh, id: 'unused' }, 'unused', 'first_frame', semanticPlan('新的台词。'))
  assert.equal(next.updated, true)
  assert.equal(next.created, false)
  assert.match(next.graph.nodes[1].text, /新的台词/)
  assert.doesNotMatch(next.graph.nodes[1].text, /原来的台词/)
  assert.equal(createImageVideoHandoff(next.graph, source, changed, f.models, f.fresh, 'unused').graph, next.graph)
  const manual = { ...first.graph.nodes[1], text: '手工视频草稿。本镜无对白。' }
  const manualGraph = { ...first.graph, nodes: [source, manual] }
  const preserved = createImageVideoHandoff(manualGraph, source, changed, f.models, { ...f.fresh, id: 'new-version' }, 'new-frame')
  assert.equal(preserved.created, true)
  assert.deepEqual(preserved.graph.nodes.find(node => node.id === manual.id), manual)
})

test('a structured shot audio plan reaches the video even when its motion prompt contains no speech', () => {
  const f = fixture(), plan = semanticPlan('这句台词只存在结构化字段里。')
  const detail = { ...f.detail, shots: [{ ...f.detail.shots[0], audio_plan: plan.audio_plan }] }
  const result = createImageVideoHandoff(f.graph, f.source, detail, f.models, f.fresh, 'frame')
  const video = result.graph.nodes.find(node => node.id === result.nodeId)!
  assert.match(video.text, /这句台词只存在结构化字段里。/)
  assert.match(video.text, /角色睁眼，缓慢坐起，镜头推近/)
  assert.equal(pendingImageVideoHandoff(result.graph, video, detail, f.models), undefined)
})

test('an analysed plan upgrades an untouched legacy video without metadata rather than returning its silent draft', () => {
  const f = fixture()
  const legacy = { ...f.fresh, type: 'generation' as const, prompt: f.detail.shots[0].video_prompt!, text: '', shot_id: 'shot',
    settings: { modality: 'video' as const, mode: 'first_frame' as const, storyboard_reference_asset_id: 'chosen' } }
  const graph = { ...f.graph, nodes: [f.source, legacy], edges: [{ id: 'frame', source: f.source.id, target: legacy.id, reference_asset_id: 'chosen' }] }
  const result = createImageVideoHandoff(graph, f.source, f.detail, f.models, f.fresh, 'unused', 'first_frame', semanticPlan())
  assert.equal(result.nodeId, legacy.id)
  assert.equal(result.updated, true)
  assert.equal(result.created, false)
  assert.match(result.graph.nodes[1].text, /刘叔，这两天自来水管没洗吧？/)
  assert.ok(result.graph.nodes[1].settings.image_video_handoff?.semantic_plan)
})

test('legacy raw video prose remains explicitly restorable after boundary composition while similar manual prose stays protected', () => {
  const f = fixture(), detail = { ...f.detail, shots: [{ ...f.detail.shots[0], start_state: '躺在床上', end_state: '坐在床沿', cut_note: '视线向右接门口反打' }] }
  const legacy = { ...f.fresh, type: 'generation' as const, prompt: detail.shots[0]!.video_prompt!, text: '', shot_id: 'shot',
    settings: { modality: 'video' as const, mode: 'first_frame' as const, storyboard_reference_asset_id: 'chosen' } }
  const graph = { ...f.graph, nodes: [f.source, legacy], edges: [{ id: 'frame', source: f.source.id, target: legacy.id, reference_asset_id: 'chosen' }] }
  const pending = pendingImageVideoHandoff(graph, legacy, detail, f.models)
  assert.ok(pending, 'an exact pre-composition baseline must retain the explicit restoration action')
  const restored = resolveImageVideoHandoff(graph, legacy.id, pending.context.signature, semanticPlan(), detail, f.models)
  assert.notEqual(restored, graph)
  assert.ok(restored.nodes[1]!.settings.image_video_handoff?.semantic_plan)
  const manual = { ...legacy, prompt: `${legacy.prompt}，再停两秒看向门外。` }, manualGraph = { ...graph, nodes: [f.source, manual] }
  assert.equal(pendingImageVideoHandoff(manualGraph, manual, detail, f.models), undefined)
  assert.equal(resolveImageVideoHandoff(manualGraph, manual.id, pending.context.signature, semanticPlan(), detail, f.models), manualGraph)
  assert.equal(manualGraph.nodes[1]!.prompt, manual.prompt)
})

test('the exact pre-composition fallback is restorable but its edited camera prose is never treated as automatic', () => {
  const f = fixture(), detail = { ...f.detail, shots: [{ ...f.detail.shots[0], video_prompt: '', start_state: '躺在床上', end_state: '坐在床沿', cut_note: '视线向右接门口反打' }] }
  // Pin the actual old serialized format, independently of the new composer.
  const oldFallback = '生成当前分镜的一个连续视频镜头。描述动作先后、表情变化、镜头运动与节奏，保持人物、服装、道具、场景和光线连续；不要拼接无关镜头。\n\n镜头描述\n\n开镜状态：躺在床上\n\n收镜状态：坐在床沿\n\n接镜要求：视线向右接门口反打\n\n仅在首帧或首尾帧生成模式下，从指定首帧的构图、人物位置、姿态和物体状态开始延续动作；多图参考的开场状态按正文设计。不添加画面文字、字幕或水印。'
  const legacy = { ...f.fresh, type: 'generation' as const, prompt: oldFallback, text: '', shot_id: 'shot',
    settings: { modality: 'video' as const, mode: 'first_frame' as const, storyboard_reference_asset_id: 'chosen' } }
  const graph = { ...f.graph, nodes: [f.source, legacy], edges: [{ id: 'frame', source: f.source.id, target: legacy.id, reference_asset_id: 'chosen' }] }
  const pending = pendingImageVideoHandoff(graph, legacy, detail, f.models)
  assert.ok(pending)
  assert.notEqual(resolveImageVideoHandoff(graph, legacy.id, pending.context.signature, semanticPlan(), detail, f.models), graph)
  for (const prompt of [`${oldFallback}\n\n保持固定机位两秒后再摇向门口。`, oldFallback.replace('镜头描述', '创作者改成手持跟拍')]) {
    const manual = { ...legacy, prompt }, manualGraph = { ...graph, nodes: [f.source, manual] }
    assert.equal(pendingImageVideoHandoff(manualGraph, manual, detail, f.models), undefined)
    assert.equal(resolveImageVideoHandoff(manualGraph, manual.id, pending.context.signature, semanticPlan(), detail, f.models), manualGraph)
  }
})

test('asset-linked storyboard images retain their shot audio when the image node has no shot id', () => {
  const f = fixture(), plan = semanticPlan('素材对应的分镜台词。')
  const source = { ...f.source, shot_id: null }
  const detail = { ...f.detail, shots: [{ ...f.detail.shots[0], audio_plan: plan.audio_plan }] }
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, detail, f.models, f.fresh, 'frame')
  const video = first.graph.nodes.find(node => node.id === first.nodeId)!
  assert.equal(video.shot_id, 'shot')
  assert.match(video.text, /素材对应的分镜台词。/)
  assert.equal(pendingImageVideoHandoff(first.graph, video, detail, f.models), undefined)
})

test('legacy automatic handoffs remain pending until a model plan is applied, preserving media and settings', () => {
  const f = fixture(), source = editedImage(f)
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
  const original = first.graph.nodes[1]
  const video = { ...original, x: 980, y: 420, asset_id: 'completed-media', job_id: 'completed',
    settings: { ...original.settings, duration: 8, resolution: '1080p', generation_completed_job_id: 'completed' } }
  const graph = { ...first.graph, nodes: [source, video] }
  const pending = pendingImageVideoHandoff(graph, video, f.detail, f.models)!
  assert.ok(pending)
  assert.equal(video.settings.image_video_handoff?.semantic_plan, undefined)
  const next = resolveImageVideoHandoff(graph, video.id, pending.context.signature, semanticPlan(), f.detail, f.models)
  const resolved = next.nodes[1]
  assert.match(resolved.text, /刘叔，这两天自来水管没洗吧？/)
  assert.match(resolved.text, /放下纸巾/)
  assert.equal(resolved.asset_id, 'completed-media')
  assert.equal(resolved.job_id, 'completed')
  assert.deepEqual([resolved.x, resolved.y, resolved.settings.duration, resolved.settings.resolution], [980, 420, 8, '1080p'])
  assert.equal(resolved.settings.generation_completed_job_id, 'completed')
  assert.equal(pendingImageVideoHandoff(next, resolved, f.detail, f.models), undefined)
  assert.equal(resolveImageVideoHandoff(next, resolved.id, pending.context.signature, semanticPlan(), f.detail, f.models), next)
  assert.equal(video.text, original.text, 'analysis does not mutate its source graph')
})

test('analysis cannot overwrite a manual draft, active job, changed source or wrong source signature', () => {
  for (const change of ['manual', 'active', 'source', 'signature'] as const) {
    const f = fixture(), source = editedImage(f)
    const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
    const pending = pendingImageVideoHandoff(first.graph, first.graph.nodes[1], f.detail, f.models)!
    const target = change === 'manual' ? { ...first.graph.nodes[1], text: '创作者独立写的完整视频。' }
      : change === 'active' ? { ...first.graph.nodes[1], job_id: 'running' } : first.graph.nodes[1]
    const detail = change === 'active' ? { ...f.detail, jobs: [...f.detail.jobs,
      { id: 'running', status: 'running' } as ProjectDetail['jobs'][number]] } : f.detail
    const graph = { ...first.graph, nodes: [change === 'source' ? editedImage(f, '新人物站在车门边。') : source, target] }
    const next = resolveImageVideoHandoff(graph, target.id, change === 'signature' ? 'wrong' : pending.context.signature, semanticPlan(), detail, f.models)
    assert.equal(next, graph, change)
  }
})

test('a missing or changed source cannot be mistaken for an analysed handoff', () => {
  const f = fixture(), source = editedImage(f)
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
  const video = first.graph.nodes[1]
  assert.throws(() => pendingImageVideoHandoff({ ...first.graph, nodes: [video] }, video, f.detail, f.models), /来源图片节点已移除/)
  const movedSource = { ...source, asset_id: 'new' }
  assert.throws(() => pendingImageVideoHandoff({ ...first.graph, nodes: [movedSource, video] }, video, f.detail, f.models), /来源图片已变化/)
})

test('changed sources create a new version when the prior video has manual prose, reference edits or an active job', () => {
  for (const change of ['prose', 'reference', 'running', 'queued'] as const) {
    const f = fixture(), source = editedImage(f)
    const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
    const video = change === 'prose' ? { ...first.graph.nodes[1], text: '我的视频动作与运镜，完整保留' }
      : ['running', 'queued'].includes(change) ? { ...first.graph.nodes[1], job_id: 'active' } : first.graph.nodes[1]
    const detail = ['running', 'queued'].includes(change) ? { ...f.detail,
      jobs: [...f.detail.jobs, { id: 'active', status: change } as ProjectDetail['jobs'][number]] } : f.detail
    const nextSource = editedImage(f, '林晚向右走，裴砚停在原地。')
    const graph = { ...first.graph, nodes: [nextSource, video], edges: change === 'reference'
      ? first.graph.edges.map(edge => ({ ...edge, reference_asset_id: 'new' })) : first.graph.edges }
    const before = structuredClone(graph)
    const next = createImageVideoHandoff(graph, nextSource, detail, f.models, { ...f.fresh, id: 'next' }, 'new-frame')
    assert.equal(next.created, true, change)
    assert.equal(next.preserved, true, change)
    assert.equal(next.nodeId, 'next')
    assert.deepEqual(next.graph.nodes.find(node => node.id === video.id), video)
    assert.deepEqual(graph, before)
    assert.match(next.graph.nodes.at(-1)!.text, /裴砚停在原地/)
  }
})

test('legacy automatic video prompts inherit latest image edits, while manual legacy video drafts are preserved', () => {
  for (const manual of [false, true]) {
    const f = connectionFixture(), source = editedImage(f)
    const target = { ...f.target, shot_id: 'shot', prompt: manual ? '独立设计的运镜' : f.detail.shots[0].video_prompt! }
    const graph = { ...f.graph, nodes: [source, target] }
    const next = connectImageVideoHandoff(graph, imageVideoConnection(source, target, f.detail, f.models)!, f.detail, f.models, 'frame')
    assert.equal(next.nodes[1].id, target.id)
    if (manual) {
      assert.equal(next.nodes[1].prompt, target.prompt)
      assert.equal(next.nodes[1].text, target.text)
    } else {
      assert.match(next.nodes[1].text, /裴砚站在林晚左后方/)
      assert.doesNotMatch(next.nodes[1].text, /角色睁眼/)
      const nextSource = editedImage(f, '裴砚转身离开，林晚留在原地。')
      const changed = { ...next, nodes: next.nodes.map(node => node.id === source.id ? nextSource : node) }
      const refreshed = connectImageVideoHandoff(changed, imageVideoConnection(nextSource, next.nodes[1], f.detail, f.models)!, f.detail, f.models, 'unused')
      assert.match(refreshed.nodes[1].text, /裴砚转身离开/)
      assert.equal(refreshed.edges[0].id, 'frame')
      assert.equal(connectImageVideoHandoff(refreshed, imageVideoConnection(nextSource, refreshed.nodes[1], f.detail, f.models)!, f.detail, f.models, 'unused'), refreshed)
    }
  }
})

test('multi-reference refresh removes obsolete inherited fixed images and uses only the current image references', () => {
  const f = fixture(), model = multiReferenceVideoModel()
  const input = { ...f.source, id: 'reference-image', type: 'image' as const, shot_id: null, asset_id: 'new', settings: {} }
  const source = editedImage(f, '裴砚在左侧，[[ref:new]]用于裴砚的外形。')
  const graph = { ...f.graph, nodes: [source, input], edges: [{ id: 'source-ref', source: input.id, target: source.id, reference_asset_id: 'new' }] }
  const first = createImageVideoHandoff(graph, source, f.detail, [model], f.fresh, 'frame', 'reference')
  assert.deepEqual(fixedReferenceAsset(first.graph, 'video', f.detail.assets).map(item => item.asset?.id), ['chosen', 'new'])
  const nextSource = editedImage(f, '裴砚在右侧，不再使用之前的外形参考。')
  const removed = { ...first.graph, nodes: first.graph.nodes.map(node => node.id === source.id ? nextSource : node),
    edges: first.graph.edges.filter(edge => edge.id !== 'source-ref') }
  const next = createImageVideoHandoff(removed, nextSource, f.detail, [model], { ...f.fresh, id: 'unused' }, 'unused', 'reference')
  assert.equal(next.updated, true)
  assert.deepEqual(fixedReferenceAsset(next.graph, 'video', f.detail.assets).map(item => item.asset?.id), ['chosen'])
  assert.doesNotMatch(next.graph.nodes.find(node => node.id === 'video')!.text, /\[\[ref:new\]\]/)
  assert.equal(next.graph.nodes.find(node => node.id === source.id), nextSource)
})

test('restoring the uncustomized source resets inherited prose without disturbing its historical video result', () => {
  const f = fixture(), source = editedImage(f)
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, f.models, f.fresh, 'frame')
  const graph = { ...first.graph, nodes: [f.source, { ...first.graph.nodes[1], asset_id: 'historical-video' }] }
  const next = createImageVideoHandoff(graph, f.source, f.detail, f.models, { ...f.fresh, id: 'unused' }, 'unused')
  assert.equal(next.updated, true)
  assert.equal(next.graph.nodes[1].prompt, f.detail.shots[0].video_prompt)
  assert.equal(next.graph.nodes[1].text, '')
  assert.equal(next.graph.nodes[1].settings.prompt_body, undefined)
  assert.equal(next.graph.nodes[1].asset_id, 'historical-video')
})

test('a second image added to an automatic reference video preserves its primary creative design and handoff source', () => {
  const f = fixture(), model = multiReferenceVideoModel(), source = editedImage(f, '林晚在站台左侧等车。')
  const first = createImageVideoHandoff({ ...f.graph, nodes: [source] }, source, f.detail, [model], f.fresh, 'primary', 'reference')
  const video = first.graph.nodes[1]
  const extra = { ...editedImage(f, '裴砚独自站在街头。'), id: 'extra-image', asset_id: 'new' }
  const graph = { ...first.graph, nodes: [...first.graph.nodes, extra], edges: [...first.graph.edges,
    { id: 'extra-old-input', source: source.id, target: extra.id, reference_asset_id: 'unavailable-old-input' }] }
  const next = connectImageVideoHandoff(graph, imageVideoConnection(extra, video, f.detail, [model])!, f.detail, [model], 'supplement')
  const connected = next.nodes.find(node => node.id === video.id)!
  assert.equal(connected.prompt, video.prompt)
  assert.equal(connected.text, video.text)
  assert.equal(connected.settings.storyboard_reference_asset_id, 'chosen')
  assert.deepEqual(connected.settings.image_video_handoff, video.settings.image_video_handoff)
  assert.deepEqual(next.edges.filter(edge => edge.target === video.id).map(edge => edge.reference_asset_id), ['chosen', 'new'])
})
