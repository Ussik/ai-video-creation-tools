import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canvasContinuityBlocks, canvasContinuitySource } from '../src/features/canvas/canvas-continuity-review'
import { imageVideoSourceContext } from '../src/features/canvas/canvas-image-video-context'
import { continuityFixture, continuityReport } from './fixtures/canvas-continuity'

test('generation review signature follows selected predecessor takes, accepted trims and shared sound', () => {
  const f = continuityFixture(), initial = canvasContinuitySource(f.detail, f.request)
  assert.equal(initial.context.previous?.media.asset?.id, 'video')
  assert.equal(initial.context.previous?.media.tail_time_ms, 4950)
  for (const mutate of [
    (value: typeof f.detail) => { value.shots[0].selected_asset_id = 'other-take'; value.timeline_clips[0].asset_id = 'other-take' },
    (value: typeof f.detail) => { value.timeline_clips[0].out_ms = 4000 },
    (value: typeof f.detail) => { value.timeline_clips[0].in_ms = 1000 },
    (value: typeof f.detail) => { value.timeline_clips[0].source_audio_gain = .7 },
    (value: typeof f.detail) => { value.shots[0].audio_plan!.scene_sound!.ambience = ['同场雨声'] },
  ]) {
    const detail = structuredClone(f.detail); mutate(detail)
    assert.notEqual(canvasContinuitySource(detail, f.request).signature, initial.signature)
    assert.notEqual(imageVideoSourceContext(f.graph, f.source, detail, []).signature,
      imageVideoSourceContext(f.graph, f.source, f.detail, []).signature)
  }
})

test('final generation parameters and storyboard source changes invalidate earlier review evidence', () => {
  const f = continuityFixture(), initial = canvasContinuitySource(f.detail, f.request).signature
  const updates = [
    { prompt: '修订后的实际提交提示词' }, { duration: 8 }, { mode: 'first_frame' as const }, { model_id: 'another-video-model' },
    { generate_audio: false }, { reference_asset_ids: ['alternate'] }, { storyboard_reference_asset_id: 'alternate' },
    { reference_video_url: '/previous-take.mp4' },
  ]
  for (const update of updates) assert.notEqual(canvasContinuitySource(f.detail, { ...f.request, ...update }).signature, initial)
  const detail = structuredClone(f.detail)
  detail.assets.find(asset => asset.id === 'still')!.prompt = '修改后的首帧内容'
  assert.notEqual(canvasContinuitySource(detail, f.request).signature, initial)
})

test('only matching current reports block generation and acknowledgement belongs to that exact version', () => {
  const f = continuityFixture(), current = canvasContinuitySource(f.detail, f.request).signature
  const report = continuityReport(current)
  assert.equal(canvasContinuityBlocks(undefined, current), false)
  assert.equal(canvasContinuityBlocks({ report, acknowledged: false }, current), true)
  assert.equal(canvasContinuityBlocks({ report, acknowledged: true }, current), false)
  assert.equal(canvasContinuityBlocks({ report, acknowledged: false }, 'another-version'), false)
  assert.equal(canvasContinuityBlocks({ report, acknowledged: true }, 'another-version'), false)
  assert.equal(canvasContinuityBlocks({ report: { ...report, findings: report.findings.map(item => ({ ...item, severity: 'warning' })) }, acknowledged: false }, current), false)
  const updated = canvasContinuitySource(f.detail, { ...f.request, prompt: '当前已统一首帧。' }).signature
  assert.notEqual(updated, current)
  assert.equal(canvasContinuityBlocks({ report: continuityReport(updated), acknowledged: false }, updated), true)
})

test('audio permission is explicit, affects the reviewed version, and cannot reuse earlier approval', () => {
  const f = continuityFixture(), implicit = canvasContinuitySource(f.detail, f.request)
  assert.equal(implicit.signature, canvasContinuitySource(f.detail, f.request, false).signature)
  assert.notEqual(implicit.signature, canvasContinuitySource(f.detail, f.request, true).signature)
  const initial = imageVideoSourceContext(f.graph, f.source, f.detail, []).signature
  const source = { ...f.source, settings: { ...f.source.settings, modify_confirmed_audio: true } }
  assert.notEqual(imageVideoSourceContext({ ...f.graph, nodes: [source] }, source, f.detail, []).signature, initial)
})

test('historical shots stay in their own design, and current metadata wins over a historical duplicate', () => {
  const f = continuityFixture()
  f.detail.historical_shots = [{ ...f.detail.shots[0], end_state: '历史旧末态' }, { ...f.detail.shots[0], id: 'other-design', position: .5, design_id: 'other' }]
  const current = canvasContinuitySource(f.detail, f.request)
  assert.equal(current.context.previous?.id, 's1')
  assert.notEqual(current.context.previous?.end_state, '历史旧末态')
  const unrelated = structuredClone(f.detail); unrelated.historical_shots![1].end_state = '修改其他方案'
  assert.equal(canvasContinuitySource(unrelated, f.request).signature, current.signature)
  const archived = structuredClone(f.detail)
  archived.historical_shots = archived.shots.map(shot => ({ ...shot, design_id: 'archive' }))
  archived.shots = [{ ...archived.shots[0], id: 'new-current', design_id: 'new-design' }]
  assert.equal(canvasContinuitySource(archived, f.request).context.previous?.id, 's1')
})

test('mismatched or ambiguous accepted footage cannot be presented as a valid predecessor tail', () => {
  const f = continuityFixture()
  f.detail.timeline_clips[0].asset_id = 'still'
  assert.equal(canvasContinuitySource(f.detail, f.request).context.previous?.media.tail_time_ms, null)
  f.detail.timeline_clips[0].asset_id = 'video'
  f.detail.timeline_clips.push({ ...f.detail.timeline_clips[0], id: 'duplicate' })
  assert.equal(canvasContinuitySource(f.detail, f.request).context.previous?.media.range_status, 'ambiguous')
  assert.equal(canvasContinuitySource(f.detail, f.request).context.previous?.media.tail_time_ms, null)
})
