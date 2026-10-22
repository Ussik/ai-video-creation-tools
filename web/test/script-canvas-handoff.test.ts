import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Asset, Model, ProjectDetail, ScriptCanvasResult } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { addScriptCanvasNodes, bindScriptCanvasRequest, clearScriptCanvasRequest, readScriptCanvasRequest, requestScriptCanvas, scriptCanvasInitialFocus, scriptCanvasRequestKey } from '../src/features/script/script-canvas-handoff'
import { rememberCanvas } from '../src/features/canvas/project-canvases'
import { automaticVisualReferenceEdges } from '../src/features/canvas/canvas-visual-profiles'
import { canvasNodeGap } from '../src/features/canvas/canvas-node-placement'

const imageModel = { id: 'image-new', modality: 'image', settings: {} } as Model
const models = [imageModel, { id: 'image-old', modality: 'image', settings: {} }, { id: 'video', modality: 'video', settings: {} }] as Model[]
const result = { scene_ids: ['scene'], created_profiles: 1, created_shots: 1,
  visual_profiles: [{ id: 'profile', name: '林晚', variant: '默认', definition_status: 'draft', revision: 1, board_asset_id: null }],
  shots: [{ id: 'shot', title: '车站', prompt: '林晚等待', position: 0, duration: 5 }],
  shot_visual_bindings: [{ shot_id: 'shot', profile_id: 'profile', revision: 1, name: '林晚', variant: '默认', required: true, board_asset_id: null }],
} as ScriptCanvasResult
function node(id: string, settings: CanvasNode['settings'] = {}): CanvasNode {
  return { id, type: 'generation', x: 0, y: 0, width: 440, height: 420, title: id, text: '',
    asset_id: null, shot_id: null, model_id: null, job_id: null, prompt: '', settings }
}
const graph = (nodes: CanvasNode[] = []): CanvasGraph => ({ nodes, edges: [], revision: 'version', viewport: { x: 7, y: 8, zoom: 0.6 } })
const detail = (input = result) => ({ assets: [], jobs: [], asset_tasks: [], visual_profiles: input.visual_profiles, shot_visual_bindings: input.shot_visual_bindings } as unknown as ProjectDetail)

function browserStorage(t: TestContext) {
  const storage = () => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: string[] = []
  const browser = { localStorage: storage(), sessionStorage: storage(), dispatchEvent: (event: Event) => { events.push(event.type); return true } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { ...browser, events }
}

test('explicit handoff captures the active canvas independently for each project', t => {
  const browser = browserStorage(t)
  rememberCanvas('project-a', 'canvas-a')
  rememberCanvas('project-b', 'canvas-b')
  requestScriptCanvas('project-a', '9:16', result)
  const request = readScriptCanvasRequest('project-a')!
  assert.equal(request.canvas_id, 'canvas-a')
  assert.equal(request.ratio, '9:16')
  assert.deepEqual(request.result, result)
  rememberCanvas('project-a', 'another-canvas')
  assert.equal(readScriptCanvasRequest('project-a')!.canvas_id, 'canvas-a', 'switching later cannot move a pending import')
  requestScriptCanvas('project-b', '16:9', result)
  assert.equal(readScriptCanvasRequest('project-b')!.canvas_id, 'canvas-b')
  assert.equal(readScriptCanvasRequest('project-a')!.id, request.id)
  assert.deepEqual(browser.events, ['script-canvas-open', 'script-canvas-open'])
})

test('a new design targets its dedicated canvas rather than the remembered old canvas', t => {
  browserStorage(t)
  rememberCanvas('project', 'old-canvas')
  const fresh = { ...result, design_id: 'fresh-design', target_canvas_id: 'fresh-canvas' }
  requestScriptCanvas('project', '9:16', fresh)
  const request = readScriptCanvasRequest('project')!
  assert.equal(request.canvas_id, 'fresh-canvas')
  assert.equal(bindScriptCanvasRequest('project', request.id, 'old-canvas'), null)
  assert.equal(bindScriptCanvasRequest('project', request.id, 'fresh-canvas')?.result.design_id, 'fresh-design')
  assert.throws(() => requestScriptCanvas('project', '9:16', { ...fresh, target_canvas_id: undefined }), /缺少目标画布/)
  assert.equal(readScriptCanvasRequest('project')!.id, request.id, 'invalid new requests cannot overwrite a recoverable design import')
})

test('an unbound legacy handoff binds to the first consuming canvas and rejects other canvases', t => {
  const browser = browserStorage(t)
  const legacy = { id: 'legacy', project_id: 'project', ratio: '9:16', result }
  browser.sessionStorage.setItem(scriptCanvasRequestKey('project'), JSON.stringify(legacy))
  assert.equal(bindScriptCanvasRequest('project', 'unrelated', 'wrong-canvas'), null)
  assert.deepEqual(readScriptCanvasRequest('project'), legacy, 'a stale callback cannot bind another request')
  const bound = bindScriptCanvasRequest('project', 'legacy', 'canvas-a')!
  assert.equal(bound.canvas_id, 'canvas-a')
  assert.deepEqual(readScriptCanvasRequest('project'), bound)
  assert.equal(bindScriptCanvasRequest('project', 'legacy', 'canvas-b'), null)
  assert.deepEqual(bindScriptCanvasRequest('project', 'legacy', 'canvas-a'), bound)
  clearScriptCanvasRequest('project', 'legacy', 'canvas-b')
  assert.deepEqual(readScriptCanvasRequest('project'), bound, 'another canvas cannot consume the request')
  clearScriptCanvasRequest('project', 'legacy', 'canvas-a')
  assert.equal(readScriptCanvasRequest('project'), null)
})

test('a delayed import completion cannot clear or bind a newer handoff request', t => {
  browserStorage(t)
  rememberCanvas('project', 'canvas-a')
  requestScriptCanvas('project', '9:16', result)
  const earlier = readScriptCanvasRequest('project')!
  assert.ok(bindScriptCanvasRequest('project', earlier.id, 'canvas-a'))
  rememberCanvas('project', 'canvas-b')
  requestScriptCanvas('project', '16:9', result)
  const replacement = readScriptCanvasRequest('project')!
  assert.notEqual(replacement.id, earlier.id)
  clearScriptCanvasRequest('project', earlier.id, 'canvas-a')
  assert.equal(bindScriptCanvasRequest('project', earlier.id, 'canvas-a'), null)
  assert.deepEqual(readScriptCanvasRequest('project'), replacement)
  assert.equal(bindScriptCanvasRequest('project', replacement.id, 'canvas-a'), null)
  clearScriptCanvasRequest('project', replacement.id, 'canvas-a')
  assert.deepEqual(readScriptCanvasRequest('project'), replacement)
  clearScriptCanvasRequest('project', replacement.id, 'canvas-b')
  assert.equal(readScriptCanvasRequest('project'), null)
})

test('requests without a remembered canvas remain compatible and can be consumed by matching id', t => {
  browserStorage(t)
  requestScriptCanvas('project', '9:16', result)
  const request = readScriptCanvasRequest('project')!
  assert.equal(request.canvas_id, undefined)
  clearScriptCanvasRequest('project', 'other-request', 'canvas')
  assert.equal(readScriptCanvasRequest('project')!.id, request.id)
  clearScriptCanvasRequest('project', request.id, 'canvas')
  assert.equal(readScriptCanvasRequest('project'), null)
  assert.equal(bindScriptCanvasRequest('project', request.id, 'canvas'), null)
  assert.doesNotThrow(() => clearScriptCanvasRequest('project', request.id, 'canvas'))
})

test('handoff parsing rejects malformed canvas targets without accepting them as legacy requests', t => {
  const browser = browserStorage(t)
  for (const canvas_id of [null, 42, {}, [], '', '   ']) {
    browser.sessionStorage.setItem(scriptCanvasRequestKey('project'), JSON.stringify({ id: 'request', project_id: 'project', canvas_id, ratio: '9:16', result }))
    assert.throws(() => readScriptCanvasRequest('project'), /加入画布的数据不完整/)
  }
  browser.sessionStorage.setItem(scriptCanvasRequestKey('project'), JSON.stringify({ id: 'valid', project_id: 'project', canvas_id: 'canvas', ratio: '9:16', result }))
  assert.equal(readScriptCanvasRequest('project')!.canvas_id, 'canvas')
})

test('import first focuses a required ungenerated profile and keeps its pending dependency visible', () => {
  const imported = addScriptCanvasNodes(graph(), result, '9:16', imageModel, models)
  const before = structuredClone(imported)
  assert.deepEqual(scriptCanvasInitialFocus(imported, result, detail(), models), {
    targetNodeId: imported.profileNodeIds[0], missingReferenceCount: 1, bindingUpdateCount: 0,
  })
  assert.deepEqual(automaticVisualReferenceEdges(imported.graph, detail(), models).map(edge => [edge.source, edge.target]),
    [[imported.profileNodeIds[0], imported.shotNodeIds[0]]])
  assert.deepEqual(imported, before)
})

test('an unconfirmed generated candidate still focuses the profile; optional missing boards allow the shot', () => {
  const imported = addScriptCanvasNodes(graph(), result, '9:16', imageModel, models)
  imported.graph.nodes[0].asset_id = 'candidate'
  const candidateDetail = { ...detail(), assets: [{ id: 'candidate', kind: 'image', created_at: '2026-10-10' }] } as ProjectDetail
  assert.deepEqual(scriptCanvasInitialFocus(imported, result, candidateDetail, models), {
    targetNodeId: imported.profileNodeIds[0], missingReferenceCount: 1, bindingUpdateCount: 0,
  })
  const optional = structuredClone(result)
  optional.shot_visual_bindings[0].required = false
  assert.deepEqual(scriptCanvasInitialFocus(imported, optional, detail(optional), models), {
    targetNodeId: imported.shotNodeIds[0], missingReferenceCount: 0, bindingUpdateCount: 0,
  })
})

test('confirmed shot snapshots allow the first shot, even when the current profile uses a newer board', () => {
  const input = structuredClone(result)
  input.visual_profiles[0].board_asset_id = 'new-board'; input.visual_profiles[0].revision = 2
  input.shot_visual_bindings[0].board_asset_id = 'old-board'
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  const readyDetail = { ...detail(input), assets: [{ id: 'old-board', kind: 'image' }, { id: 'new-board', kind: 'image' }] } as ProjectDetail
  assert.deepEqual(scriptCanvasInitialFocus(imported, input, readyDetail, models), {
    targetNodeId: imported.shotNodeIds[0], missingReferenceCount: 0, bindingUpdateCount: 0,
  })
  assert.equal(imported.addedReferences, 1)
  assert.deepEqual(automaticVisualReferenceEdges(imported.graph, readyDetail, models).map(edge => edge.source),
    [imported.graph.nodes.find(item => item.asset_id === 'old-board')!.id])
})

test('independent views import inside their profile without unused old-board or per-angle canvas nodes', () => {
  const input = structuredClone(result)
  input.visual_profiles[0].board_asset_id = 'new-board'
  input.shot_visual_bindings[0].board_asset_id = 'old-board'
  input.shot_visual_bindings[0].reference_assets = [
    { id: 'side-ref', asset_id: 'side-image', revision: 1, style_version: null, view: 'side', purpose: 'costume', label: '侧面' },
    { id: 'face-ref', asset_id: 'face-image', revision: 1, style_version: null, view: 'face', purpose: 'identity', label: '面部' },
  ]
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  assert.equal(imported.graph.nodes.length, 2)
  assert.equal(imported.addedReferences, 0)
  const ready = { ...detail(input), assets: [{ id: 'side-image', kind: 'image' }, { id: 'face-image', kind: 'image' }] } as ProjectDetail
  assert.equal(scriptCanvasInitialFocus(imported, input, ready, models).missingReferenceCount, 0)
  assert.deepEqual(automaticVisualReferenceEdges(imported.graph, ready, models).map(edge => edge.reference_asset_id), ['side-image', 'face-image'])
})

test('a current approved profile does not fill an empty or deleted historical shot reference', () => {
  const input = structuredClone(result)
  input.visual_profiles[0].board_asset_id = 'current-board'; input.visual_profiles[0].revision = 2
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  const readyProfile = { ...detail(input), assets: [{ id: 'current-board', kind: 'image' }] } as ProjectDetail
  assert.deepEqual(scriptCanvasInitialFocus(imported, input, readyProfile, models), {
    targetNodeId: imported.profileNodeIds[0], missingReferenceCount: 1, bindingUpdateCount: 1,
  })
  input.shot_visual_bindings[0].board_asset_id = 'deleted-board'
  assert.deepEqual(scriptCanvasInitialFocus(imported, input, readyProfile, models), {
    targetNodeId: imported.profileNodeIds[0], missingReferenceCount: 1, bindingUpdateCount: 1,
  })
})

test('import readiness uses incoming bindings over stale project data and deduplicates shared references', () => {
  const input = structuredClone(result)
  input.shots.push({ ...input.shots[0], id: 'shot-2', position: 1 })
  input.shot_visual_bindings.push({ ...input.shot_visual_bindings[0], shot_id: 'shot-2' })
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  const stale = { ...detail(), assets: [{ id: 'stale-board', kind: 'image' }],
    visual_profiles: [{ ...result.visual_profiles[0], board_asset_id: 'stale-board' }],
    shot_visual_bindings: [{ ...result.shot_visual_bindings[0], board_asset_id: 'stale-board' }],
  } as ProjectDetail
  assert.deepEqual(scriptCanvasInitialFocus(imported, input, stale, models), {
    targetNodeId: imported.profileNodeIds[0], missingReferenceCount: 1, bindingUpdateCount: 0,
  })
})

test('a newer saved replan updates image and video prompts, resets old results and preserves node positions', () => {
  const image = { ...node('image', { modality: 'image' }), shot_id: 'shot', asset_id: 'old-frame', x: 200, y: 150, prompt: 'old image' }
  const video = { ...node('video', { modality: 'video' }), shot_id: 'shot', asset_id: 'old-video', x: 750, y: 150, prompt: 'old video' }
  const input = structuredClone(result)
  input.updated_shot_ids = ['shot']; input.shots[0].image_prompt = '新首帧'; input.shots[0].video_prompt = '新动作'; input.shots[0].duration = 8
  input.shots[0].storyboard_revision = 1
  const previous = graph([image, video]), updated = addScriptCanvasNodes(previous, input, '9:16', imageModel, models)
  assert.equal(updated.addedShots, 0)
  for (const [index, source] of [image, video].entries()) {
    const target = updated.graph.nodes[index]
    assert.equal(target.id, source.id); assert.equal(target.x, source.x); assert.equal(target.y, source.y); assert.equal(target.asset_id, null)
    assert.equal(target.settings.storyboard_revision, 1)
    assert.equal(target.prompt, index ? '新动作' : '新首帧'); assert.equal(target.settings.duration, 8)
  }
  assert.equal(previous.nodes[0].prompt, 'old image'); assert.equal(previous.nodes[1].prompt, 'old video')
})

test('setting revisions refresh reused profile nodes and discard old final prompt caches after replan', () => {
  const profile = { ...node('profile-node', { visual_profile_id: 'profile', visual_profile_revision: 1,
    profile_prompt_override: '林晚21岁', visual_completed_job_id: 'old-job' }), asset_id: 'old-board', job_id: 'old-job', x: 150 }
  const cache = { prompt_override: true, prompt_is_final: true, prompt_base: '林晚21岁', prompt_template: '林晚21岁' }
  const image = { ...node('legacy-image', cache), shot_id: 'shot', asset_id: 'old-frame', prompt: '林晚21岁', text: '林晚21岁', x: 800 }
  const video = { ...node('video', { ...cache, modality: 'video' }), shot_id: 'shot', asset_id: 'old-video', prompt: '林晚21岁', x: 1400 }
  const other = { ...node('other', cache), shot_id: 'other-shot', prompt: '历史镜头' }
  const input = structuredClone(result)
  input.updated_shot_ids = ['shot']; input.visual_profiles[0].revision = 2
  input.shots[0].storyboard_revision = 1
  input.visual_profiles[0].definition = '林晚32岁'; input.visual_profiles[0].board_prompt = '林晚32岁正侧背'
  input.shot_visual_bindings[0].revision = 2; input.shot_visual_bindings[0].definition = '林晚32岁'
  input.shots[0].image_prompt = '林晚32岁开镜'; input.shots[0].video_prompt = '林晚32岁向前走'
  const previous = graph([profile, image, video, other]), before = structuredClone(previous)
  const imported = addScriptCanvasNodes(previous, input, '9:16', imageModel, models)
  assert.deepEqual(previous, before)
  assert.equal(imported.addedProfiles, 0); assert.equal(imported.addedShots, 0)
  const updated = imported.graph.nodes[0]
  assert.equal(updated.id, profile.id); assert.equal(updated.x, profile.x)
  assert.equal(updated.settings.visual_profile_revision, 2)
  assert.equal(updated.settings.profile_prompt_override, undefined)
  assert.equal(updated.settings.visual_completed_job_id, undefined)
  assert.equal(updated.asset_id, null); assert.equal(updated.job_id, null)
  for (const [index, source] of [image, video].entries()) {
    const target = imported.graph.nodes[index + 1]
    assert.equal(target.id, source.id); assert.equal(target.x, source.x); assert.equal(target.asset_id, null)
    assert.equal(target.text, ''); assert.equal(target.job_id, null)
    assert.equal(target.prompt, index ? '林晚32岁向前走' : '林晚32岁开镜')
    for (const key of Object.keys(cache)) assert.equal(target.settings[key as keyof typeof cache], undefined)
  }
  assert.equal(imported.graph.nodes[3], other)
  assert.equal(scriptCanvasInitialFocus(imported, input, detail(input), models).missingReferenceCount, 1)
})

test('a current-version handoff preserves a chosen historical candidate and the current prompt draft', () => {
  const image = { ...node('image', { modality: 'image', storyboard_revision: 2, visual_dependencies: true,
    prompt_override: true, prompt_is_final: true, prompt_base: '当前草稿', prompt_template: '当前完整稿' }),
    shot_id: 'shot', asset_id: 'explicit-historical-candidate', job_id: 'older-job', prompt: '当前手动修改', text: '当前最终稿' }
  const input = structuredClone(result)
  input.updated_shot_ids = ['shot']; input.shots[0].storyboard_revision = 2
  const previous = graph([image]), imported = addScriptCanvasNodes(previous, input, '9:16', imageModel, models)
  assert.equal(imported.graph.nodes.find(node => node.id === image.id), image)
  assert.equal(imported.addedShots, 0)
})

test('new handoff generators carry the current storyboard revision and stale pinned edges are removed', () => {
  const input = structuredClone(result)
  input.shots[0].storyboard_revision = 4
  const initial = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  assert.equal(initial.graph.nodes.find(node => node.shot_id === 'shot')!.settings.storyboard_revision, 4)
  const image = { ...node('image', { modality: 'image', storyboard_revision: 3 }), shot_id: 'shot', asset_id: 'old-frame' }
  const video = { ...node('video', { modality: 'video', storyboard_revision: 3,
    storyboard_reference_asset_id: 'old-frame' }), shot_id: 'shot' }
  const previous = { ...graph([image, video]), edges: [{ id: 'old-first-frame', source: image.id, target: video.id, reference_asset_id: 'old-frame' }] }
  const imported = addScriptCanvasNodes(previous, input, '9:16', imageModel, models)
  assert.deepEqual(imported.graph.edges, [])
  assert.equal(imported.graph.nodes.find(node => node.id === video.id)!.settings.storyboard_reference_asset_id, undefined)
})

test('adds related nodes with ratio/defaults and pending-board lines, preserving local edits and geometry', () => {
  const existing = { ...node('old'), width: 900, height: 800, prompt: '未保存提示词' }
  const previous = graph([existing]), before = structuredClone(previous)
  const added = addScriptCanvasNodes(previous, result, '9:16', imageModel, models)
  assert.deepEqual(previous, before); assert.equal(added.graph.nodes[0], existing)
  assert.equal(added.graph.viewport, previous.viewport); assert.equal(added.graph.edges, previous.edges)
  assert.equal(added.addedProfiles, 1); assert.equal(added.addedShots, 1)
  for (let i = 1; i < added.graph.nodes.length; i++) {
    const fresh = added.graph.nodes[i]
    assert.equal(fresh.settings.ratio, fresh.settings.visual_profile_id ? '16:9' : '9:16')
    assert.equal(fresh.settings.modality, 'image')
    assert.equal(fresh.settings.resolution, '4K'); assert.equal(fresh.settings.clarity, '4K')
    assert.equal(fresh.settings.quality, 'extreme'); assert.equal(fresh.settings.background, 'auto')
    assert.equal(fresh.settings.candidate_count, 1)
    for (const other of added.graph.nodes.slice(0, i)) assert.ok(
      fresh.x >= other.x + other.width + canvasNodeGap || other.x >= fresh.x + fresh.width + canvasNodeGap
      || fresh.y >= other.y + other.height + canvasNodeGap || other.y >= fresh.y + fresh.height + canvasNodeGap)
  }
  const edges = automaticVisualReferenceEdges(added.graph, detail(), models)
  assert.deepEqual(edges.map(edge => [edge.source, edge.target]), [[added.profileNodeIds[0], added.shotNodeIds[0]]])
  const repeated = addScriptCanvasNodes(added.graph, result, '16:9', imageModel, models)
  assert.equal(repeated.addedProfiles, 0); assert.equal(repeated.addedShots, 0)
  assert.deepEqual(repeated.graph, added.graph)
})

test('legacy image nodes and existing profile nodes reuse exact drafts while video nodes remain unchanged', () => {
  const profile = { ...node('existing-profile', { visual_profile_id: 'profile', visual_profile_revision: 1 }), prompt: '自定义设定' }
  const image = { ...node('image'), shot_id: 'shot', model_id: 'image-old', x: 1000, prompt: '修改过的首帧' }
  const video = { ...node('video-node', { modality: 'video' }), shot_id: 'shot', model_id: 'video', x: 2000, prompt: '视频动作' }
  const previous = graph([profile, image, video]), added = addScriptCanvasNodes(previous, result, '9:16', imageModel, models)
  assert.equal(added.addedProfiles, 0); assert.equal(added.addedShots, 0)
  assert.equal(added.graph.nodes[0], profile); assert.equal(added.graph.nodes[2], video)
  assert.equal(added.graph.nodes[1].prompt, image.prompt); assert.equal(added.graph.nodes[1].x, image.x)
  assert.deepEqual(added.shotNodeIds, ['image'])
  const videoOnly = addScriptCanvasNodes(graph([video]), result, '9:16', imageModel, models)
  assert.equal(videoOnly.addedShots, 1); assert.equal(videoOnly.graph.nodes[0], video)
})

test('readding a deleted shot restores its saved image and preserves surviving node edits without duplicates or overlap', () => {
  const input = structuredClone(result)
  input.shots[0].selected_asset_id = 'saved-first-frame'
  input.shots.push({ ...input.shots[0], id: 'shot-2', position: 1, selected_asset_id: 'saved-second-frame' })
  const assets: Pick<Asset, 'id' | 'kind'>[] = [
    { id: 'saved-first-frame', kind: 'image' }, { id: 'saved-second-frame', kind: 'image' }, { id: 'local-second-frame', kind: 'image' },
  ]
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models, assets)
  const deleted = imported.graph.nodes.find(item => item.shot_id === 'shot')!
  const survivor = { ...imported.graph.nodes.find(item => item.shot_id === 'shot-2')!,
    x: 1300, y: 170, width: 900, height: 600, prompt: '保留画布编辑', asset_id: 'local-second-frame' }
  const previous = { ...imported.graph, nodes: imported.graph.nodes.filter(item => item.id !== deleted.id)
    .map(item => item.id === survivor.id ? survivor : item) }
  const before = structuredClone(previous)
  const restored = addScriptCanvasNodes(previous, input, '16:9', imageModel, models, assets)
  assert.deepEqual(previous, before)
  assert.equal(restored.addedProfiles, 0); assert.equal(restored.addedShots, 1)
  const first = restored.graph.nodes.find(item => item.shot_id === 'shot')!
  assert.notEqual(first.id, deleted.id); assert.equal(first.asset_id, 'saved-first-frame')
  assert.equal(first.settings.modality, 'image'); assert.equal(first.settings.group_id, 'shot')
  assert.equal(restored.graph.nodes.find(item => item.shot_id === 'shot-2'), survivor)
  for (const other of restored.graph.nodes.filter(item => item.id !== first.id)) assert.ok(
    first.x >= other.x + other.width + canvasNodeGap || other.x >= first.x + first.width + canvasNodeGap
    || first.y >= other.y + other.height + canvasNodeGap || other.y >= first.y + first.height + canvasNodeGap)
  const repeated = addScriptCanvasNodes(restored.graph, input, '9:16', imageModel, models, assets)
  assert.equal(repeated.addedShots, 0); assert.deepEqual(repeated.graph, restored.graph)
})

test('readding after removing all canvas nodes retains saved shot identities and selected images', () => {
  const input = structuredClone(result)
  input.shots[0].selected_asset_id = 'saved-first-frame'
  input.shots.push({ ...input.shots[0], id: 'shot-2', position: 1, selected_asset_id: 'saved-second-frame' })
  const assets: Pick<Asset, 'id' | 'kind'>[] = [
    { id: 'saved-first-frame', kind: 'image' }, { id: 'saved-second-frame', kind: 'image' },
  ]
  const imported = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models, assets)
  const removed = { ...imported.graph, nodes: [], edges: [] }
  const restored = addScriptCanvasNodes(removed, input, '9:16', imageModel, models, assets)
  assert.equal(restored.addedProfiles, 1); assert.equal(restored.addedShots, 2)
  assert.deepEqual(restored.graph.nodes.filter(item => item.shot_id).map(item => [item.shot_id, item.asset_id]),
    [['shot', 'saved-first-frame'], ['shot-2', 'saved-second-frame']])
  assert.ok(restored.graph.nodes.every(item => !imported.graph.nodes.some(old => old.id === item.id)))
  assert.deepEqual(addScriptCanvasNodes(restored.graph, input, '9:16', imageModel, models, assets).graph, restored.graph)
})

test('new image shot nodes ignore selected video and missing assets instead of restoring incompatible media', () => {
  const input = structuredClone(result)
  input.shots[0].selected_asset_id = 'saved-video'
  input.shots.push({ ...input.shots[0], id: 'missing-shot', position: 1, selected_asset_id: 'removed-image' })
  const restored = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models,
    [{ id: 'saved-video', kind: 'video' }, { id: 'unselected-image', kind: 'image' }])
  assert.deepEqual(restored.graph.nodes.filter(item => item.shot_id).map(item => [item.shot_id, item.asset_id, item.settings.modality]),
    [['shot', null, 'image'], ['missing-shot', null, 'image']])
})

test('older approved snapshot boards gain fixed image nodes, exact connections and no duplicate images on retry', () => {
  const input = structuredClone(result)
  input.visual_profiles[0].board_asset_id = 'new-board'
  input.shot_visual_bindings[0].board_asset_id = 'old-board'
  const added = addScriptCanvasNodes(graph(), input, '9:16', imageModel, models)
  assert.equal(added.addedReferences, 1)
  const snapshot = added.graph.nodes.find(node => node.asset_id === 'old-board')!
  assert.equal(snapshot.type, 'image'); assert.equal(snapshot.settings.visual_profile_id, undefined)
  const d = { ...detail(input), assets: [{ id: 'new-board', kind: 'image' }, { id: 'old-board', kind: 'image' }] } as ProjectDetail
  assert.deepEqual(automaticVisualReferenceEdges(added.graph, d, models).map(edge => edge.source), [snapshot.id])
  assert.equal(addScriptCanvasNodes(added.graph, input, '9:16', imageModel, models).addedReferences, 0)
})

test('pending dependencies turn into approved-board links; manual links and optional bindings are respected', () => {
  const added = addScriptCanvasNodes(graph(), result, '9:16', imageModel, models)
  const [source, target] = [added.profileNodeIds[0], added.shotNodeIds[0]]
  added.graph.edges.push({ id: 'manual', source, target })
  assert.deepEqual(automaticVisualReferenceEdges(added.graph, detail(), models), [])
  added.graph.edges = []
  const optional = structuredClone(result); optional.shot_visual_bindings[0].required = false
  assert.deepEqual(automaticVisualReferenceEdges(added.graph, detail(optional), models), [])
  const approved = structuredClone(result)
  approved.visual_profiles[0].board_asset_id = 'approved'; approved.shot_visual_bindings[0].board_asset_id = 'approved'
  const d = { ...detail(approved), assets: [{ id: 'approved', kind: 'image' }] } as ProjectDetail
  assert.equal(automaticVisualReferenceEdges(added.graph, d, models)[0].source, source)
  assert.match(automaticVisualReferenceEdges(added.graph, d, models)[0].id, /^auto-visual:/)
})

test('capacity failure is atomic and adding works without an image model configured', () => {
  const previous = graph(Array.from({ length: 499 }, (_, i) => ({ ...node(String(i)), x: i * 500 })))
  const before = structuredClone(previous)
  assert.throws(() => addScriptCanvasNodes(previous, result, '9:16', imageModel, models), /500/)
  assert.deepEqual(previous, before)
  const added = addScriptCanvasNodes(graph(), result, '9:16')
  assert.equal(added.graph.nodes[1].model_id, null)
  assert.equal(automaticVisualReferenceEdges(added.graph, detail()).length, 1)
})

test('the permanent script card keeps its reserved slot when importing the 500th ordinary node', () => {
  const script = { ...node('project-script'), type: 'project_script_ref' as const }
  const previous = graph([script, ...Array.from({ length: 498 }, (_, i) => ({ ...node(String(i)), x: i * 500 }))])
  const imported = addScriptCanvasNodes(previous, result, '9:16', imageModel, models)
  assert.equal(imported.graph.nodes.length, 501)
  assert.equal(imported.graph.nodes[0], script)
  assert.equal(imported.graph.nodes.filter(node => node.type !== 'project_script_ref').length, 500)
  const tooFull = graph([...previous.nodes, node('overflow')]), before = structuredClone(tooFull)
  assert.throws(() => addScriptCanvasNodes(tooFull, result, '9:16', imageModel, models), /500/)
  assert.deepEqual(tooFull, before)
})
