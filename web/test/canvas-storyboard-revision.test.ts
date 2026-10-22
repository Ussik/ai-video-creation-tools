import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, Job, Model, ProjectDetail, Shot } from '../src/shared/api/api'
import type { CanvasGraph, CanvasNode } from '../src/features/canvas/ProjectCanvas'
import { canvasJobMatchesStoryboard, storyboardRevision, syncCanvasStoryboardRevision } from '../src/features/canvas/canvas-storyboard-revision'
import { shotMediaCandidates } from '../src/features/canvas/canvas-shot-candidates'

const shot = { id: 'shot', title: '新的站台', prompt: '新剧情', image_prompt: '新的首帧', video_prompt: '新的动作',
  position: 2, duration: 8, storyboard_revision: 2 } as Shot
function node(id: string, settings: CanvasNode['settings'] = {}): CanvasNode {
  return { id, type: 'generation', x: 120, y: 240, width: 640, height: 480, title: '旧镜头', text: '旧的完整提示词',
    prompt: '旧原始提示词', model_id: 'custom-image', asset_id: 'old-frame', job_id: 'old-job', shot_id: shot.id,
    settings: { modality: 'image', storyboard_revision: 1, ...settings } }
}
const graph = (nodes: CanvasNode[], edges: CanvasGraph['edges'] = []): CanvasGraph => ({ nodes, edges, revision: 'saved' })
const models = [{ id: 'custom-image', modality: 'image' }, { id: 'custom-video', modality: 'video' }] as Model[]

test('storyboard revisions keep legacy metadata at zero and reject invalid version values', () => {
  for (const value of [undefined, null, '1', -1, 1.5, NaN, Infinity]) assert.equal(storyboardRevision(value), 0)
  assert.equal(storyboardRevision(0), 0); assert.equal(storyboardRevision(2), 2)
})

test('a newer storyboard resets image and video results while preserving geometry, models and generation choices', () => {
  const settings = { prompt_override: true, prompt_is_final: true, prompt_base: '旧稿', prompt_template: '旧完整稿', prompt_body: '旧整理正文',
    generation_completed_job_id: 'old-job', duration: 5, quality: 'extreme', resolution: '4K', candidate_count: 4,
    group_id: shot.id, group_title: '旧镜头标题' }
  const image = node('image', settings)
  const video = { ...node('video', { ...settings, modality: 'video', mode: 'reference', ratio: '16:9',
    storyboard_reference_asset_id: 'old-frame', reference_video_url: '/api/assets/old-video/file',
    video_reference_usages: [{ asset_id: 'old-frame', usage: 'opening' }, { asset_id: 'manual-image', usage: 'detail' }] }),
    model_id: 'custom-video', asset_id: 'old-video', x: 1200 }
  const source = graph([image, video]), before = structuredClone(source)
  const updated = syncCanvasStoryboardRevision(source, [shot], models)
  assert.deepEqual(source, before)
  for (const [index, original] of [image, video].entries()) {
    const current = updated.nodes[index]
    for (const key of ['id', 'x', 'y', 'width', 'height', 'model_id', 'shot_id'] as const) assert.equal(current[key], original[key], key)
    assert.equal(current.title, shot.title); assert.equal(current.prompt, index ? shot.video_prompt : shot.image_prompt)
    assert.equal(current.text, ''); assert.equal(current.asset_id, null); assert.equal(current.job_id, null)
    for (const key of ['prompt_override', 'prompt_is_final', 'prompt_base', 'prompt_template', 'prompt_body', 'generation_completed_job_id',
      'storyboard_reference_asset_id', 'reference_video_url'] as const) assert.equal(current.settings[key], undefined, key)
    assert.equal(current.settings.storyboard_revision, 2); assert.equal(current.settings.duration, 8)
    assert.equal(current.settings.quality, 'extreme'); assert.equal(current.settings.resolution, '4K')
    assert.equal(current.settings.candidate_count, 4); assert.equal(current.settings.group_title, '镜头 03 · 新的站台')
  }
  assert.equal(updated.nodes[1].settings.mode, 'reference'); assert.equal(updated.nodes[1].settings.ratio, '16:9')
  assert.deepEqual(updated.nodes[1].settings.video_reference_usages, [{ asset_id: 'manual-image', usage: 'detail' }])
  assert.equal(syncCanvasStoryboardRevision(updated, [shot], models), updated, 'synchronization is idempotent')
})

test('obsolete shot-frame pins detach without deleting manual media cards, profile references or unrelated edges', () => {
  const image = node('image')
  const video = { ...node('video', { modality: 'video', storyboard_reference_asset_id: 'old-frame' }), model_id: 'custom-video' }
  const oldFrame = { ...node('old-frame-card'), type: 'image', shot_id: shot.id } as CanvasNode
  const manual = { ...node('manual'), type: 'image', asset_id: 'manual-image', shot_id: null } as CanvasNode
  const profile = { ...node('profile', { visual_profile_id: 'hero', visual_profile_revision: 1 }), shot_id: null }
  const other = { ...node('other'), shot_id: 'other-shot' }
  const source = graph([image, video, oldFrame, manual, profile, other], [
    { id: 'old-frame-pin', source: image.id, target: video.id, reference_asset_id: 'old-frame' },
    { id: 'old-frame-card', source: oldFrame.id, target: video.id },
    { id: 'detached-pin', source: manual.id, target: video.id, reference_asset_id: 'old-detached-frame' },
    { id: 'manual-image', source: manual.id, target: video.id, reference_asset_id: 'manual-image' },
    { id: 'profile-edge', source: profile.id, target: video.id, reference_asset_id: 'old-frame' },
    { id: 'unrelated-edge', source: oldFrame.id, target: other.id, reference_asset_id: 'old-frame' },
  ])
  const updated = syncCanvasStoryboardRevision(source, [shot], models, [{ id: 'old-detached-frame', kind: 'image', shot_id: shot.id }])
  assert.deepEqual(updated.edges.map(edge => edge.id), ['manual-image', 'profile-edge', 'unrelated-edge'])
  for (const preserved of [oldFrame, manual, profile, other]) assert.equal(updated.nodes.find(node => node.id === preserved.id), preserved)
})

test('same or older storyboard versions preserve explicit historical choices and canvas drafts', () => {
  const current = node('current', { storyboard_revision: 2, prompt_is_final: true, prompt_override: true })
  const newer = node('newer', { storyboard_revision: 3 })
  const source = graph([current, newer])
  assert.equal(syncCanvasStoryboardRevision(source, [shot], models), source)
  assert.equal(current.asset_id, 'old-frame'); assert.equal(current.text, '旧的完整提示词')
  const legacy = node('legacy', { storyboard_revision: undefined })
  assert.equal(syncCanvasStoryboardRevision(graph([legacy]), [{ ...shot, storyboard_revision: undefined }], models).nodes[0], legacy)
})

test('downstream shots release fixed old inputs while dynamic connections and their own chosen results survive', () => {
  const source = node('source')
  const downstream = { ...node('downstream', { modality: 'video', storyboard_revision: 4,
    storyboard_reference_asset_id: 'old-frame', reference_video_url: 'https://cdn.test/old-video.mp4',
    video_reference_usages: [{ asset_id: 'old-frame', usage: 'opening' }, { asset_id: 'manual-image', usage: 'detail' }] }),
    shot_id: 'other-shot', asset_id: 'chosen-result', job_id: 'current-other-job' }
  const dynamic = { ...node('dynamic', { modality: 'video', storyboard_revision: 4 }), shot_id: 'dynamic-shot' }
  const ownHistorical = node('chosen-same-shot', { storyboard_revision: 2, storyboard_reference_asset_id: 'old-frame' })
  const previous = graph([source, downstream, dynamic, ownHistorical], [
    { id: 'fixed', source: source.id, target: downstream.id, reference_asset_id: 'old-frame' },
    { id: 'dynamic', source: source.id, target: dynamic.id },
  ])
  const updated = syncCanvasStoryboardRevision(previous, [shot], models, [
    { id: 'old-video', kind: 'video', shot_id: shot.id, remote_url: 'https://cdn.test/old-video.mp4' },
  ])
  assert.deepEqual(updated.edges.map(edge => edge.id), ['dynamic'])
  const released = updated.nodes[1]
  assert.equal(released.asset_id, 'chosen-result'); assert.equal(released.job_id, 'current-other-job')
  assert.equal(released.prompt, downstream.prompt); assert.equal(released.settings.storyboard_revision, 4)
  assert.equal(released.settings.storyboard_reference_asset_id, undefined)
  assert.equal(released.settings.reference_video_url, undefined)
  assert.deepEqual(released.settings.video_reference_usages, [{ asset_id: 'manual-image', usage: 'detail' }])
  assert.equal(updated.nodes[2], dynamic)
  assert.equal(updated.nodes[3], ownHistorical, 'do not disturb a current-version explicit historical choice')
})

test('resynchronizing canvas selections leaves all old shot image and video candidates available', () => {
  const assets = ['image', 'video'].map((kind, index) => ({ id: `candidate-${kind}`, project_id: 'project', shot_id: shot.id,
    kind, source: 'generated', created_at: `2026-10-${18 - index}T00:00:00Z` })) as Asset[]
  const jobs = assets.map(asset => ({ id: `job-${asset.id}`, project_id: 'project', shot_id: shot.id, job_type: 'generation',
    status: 'succeeded', request: JSON.stringify({ storyboard_revision: 1 }), result_asset_id: asset.id })) as Job[]
  const detail = { id: 'project', assets, jobs } as ProjectDetail, before = structuredClone(detail)
  const source = graph([node('image')])
  syncCanvasStoryboardRevision(source, [shot], models, assets)
  assert.deepEqual(detail, before)
  assert.deepEqual(shotMediaCandidates(shot.id, detail, 'image').map(asset => asset.id), ['candidate-image'])
  assert.deepEqual(shotMediaCandidates(shot.id, detail, 'video').map(asset => asset.id), ['candidate-video'])
})

test('automatic job completion checks storyboard provenance while legacy and non-shot jobs remain compatible', () => {
  const current = node('image', { storyboard_revision: 2 })
  const job = (request: string, shot_id: string | null = shot.id) => ({ request, shot_id })
  assert.equal(canvasJobMatchesStoryboard(current, job('{"storyboard_revision":2}')), true)
  for (const request of ['{}', '{"storyboard_revision":1}', '{"storyboard_revision":3}', 'bad json', 'null', '[]']) {
    assert.equal(canvasJobMatchesStoryboard(current, job(request)), false, request)
  }
  assert.equal(canvasJobMatchesStoryboard(current, job('{"storyboard_revision":2}', 'another-shot')), false)
  assert.equal(canvasJobMatchesStoryboard(current, undefined), false)
  assert.equal(canvasJobMatchesStoryboard(node('legacy', { storyboard_revision: undefined }), job('{}')), true)
  assert.equal(canvasJobMatchesStoryboard(node('profile', { visual_profile_id: 'hero' }), job('{}')), true)
  assert.equal(canvasJobMatchesStoryboard({ ...current, shot_id: null }, job('{}', null)), true)
})
