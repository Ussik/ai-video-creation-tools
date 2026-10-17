import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSpeechTimeline, type SpeechAudioClip, type SpeechPlacement } from '@video-studio/shared/media/speech-timeline'
import type { Asset, AssetReview, Shot, TimelineClip } from '../src/shared/api/api'
import { buildPartialTimelinePreview } from '../src/features/final-cut/partial-timeline-preview'

function fixture() {
  const shots: Shot[] = [0, 1, 2, 3].map(position => ({ id: `s${position + 1}`, project_id: 'p', position,
    title: `镜头 ${position + 1}`, prompt: '', duration: 3, selected_asset_id: `a${position + 1}`,
    source_scene_id: null, start_state: '', end_state: '', cut_note: '' }))
  const clips: TimelineClip[] = shots.map(shot => ({ id: `c${shot.id}`, project_id: 'p', shot_id: shot.id,
    asset_id: shot.selected_asset_id!, in_ms: 1000, out_ms: 3000, source_duration_ms: 5000,
    source_audio_gain: 0.7, source_audio_fade_ms: 200 }))
  const assets: Asset[] = shots.map(shot => ({ id: shot.selected_asset_id!, project_id: 'p', shot_id: shot.id,
    kind: 'video', filename: `${shot.id}.mp4`, source: 'generated', model_id: null, prompt: '', remote_url: null,
    saved: true, created_at: '', url: `/assets/${shot.id}.mp4` }))
  return { shots, clips, assets, assetReviews: [] as AssetReview[], speechAudio: [] as SpeechAudioClip[] }
}

function placement(patch: Partial<SpeechPlacement> = {}): SpeechPlacement {
  return { id: 'voice', project_id: 'p', line_id: 'line', shot_id: 's1', asset_id: 'speech', offset_ms: 500,
    in_ms: 1000, out_ms: 8500, gain: 1, text: '连贯的旁白', voice_name: '旁白', stale: false, ...patch }
}

test('partial preview retains valid clips in shot order and leaves the original timeline untouched', () => {
  const data = fixture()
  data.clips = [data.clips[2], data.clips[0]]
  data.shots.reverse()
  const before = structuredClone(data)
  const preview = buildPartialTimelinePreview(data)
  assert.deepEqual(preview.shots.map(shot => shot.id), ['s1', 's3'])
  assert.deepEqual(preview.clips.map(clip => clip.shot_id), ['s1', 's3'])
  assert.deepEqual(preview.missingShots.map(shot => shot.id), ['s2', 's4'])
  assert.equal(preview.durationMs, 4000)
  assert.equal(preview.complete, false)
  assert.deepEqual(data, before)
})

test('speech across a missing shot keeps the correct source segments with distinct playback ids', () => {
  const data = fixture()
  data.clips = [data.clips[0], data.clips[2]]
  data.speechAudio = resolveSpeechTimeline(data.shots, data.clips, [placement()]).audio
  // Original timing: ready s1 0–2s, missing s2 2–5s, ready s3 5–7s, missing s4 7–10s.
  const preview = buildPartialTimelinePreview(data)
  assert.deepEqual(preview.audio.map(({ start_ms, end_ms, in_ms, out_ms }) => ({ start_ms, end_ms, in_ms, out_ms })), [
    { start_ms: 500, end_ms: 2000, in_ms: 1000, out_ms: 2500 },
    { start_ms: 2000, end_ms: 4000, in_ms: 5500, out_ms: 7500 },
  ])
  assert.equal(new Set(preview.audio.map(item => item.id)).size, 2)
  assert.equal(preview.audio[0].fade_out_ms, 0)
  assert.equal(preview.audio[1].fade_in_ms, 0)
  assert.equal(preview.audio[1].asset_id, 'speech')
})

test('adjacent ready shots preserve one continuous speech element and its source offset', () => {
  const data = fixture()
  data.clips = data.clips.slice(1, 3)
  data.speechAudio = resolveSpeechTimeline(data.shots, data.clips, [placement({ shot_id: 's2', offset_ms: 500, in_ms: 1200, out_ms: 4200 })]).audio
  const preview = buildPartialTimelinePreview(data)
  assert.equal(preview.audio.length, 1)
  assert.deepEqual(preview.audio.map(({ start_ms, end_ms, in_ms, out_ms }) => ({ start_ms, end_ms, in_ms, out_ms })), [
    { start_ms: 500, end_ms: 3500, in_ms: 1200, out_ms: 4200 },
  ])
})

test('rejected clips retain their original edited duration when mapping already resolved speech', () => {
  const data = fixture()
  data.assetReviews.push({ shot_id: 's2', asset_id: 'a2', status: 'rejected', note: '', updated_at: '' })
  data.speechAudio = resolveSpeechTimeline(data.shots, data.clips, [placement({ shot_id: 's3', offset_ms: 100, in_ms: 800, out_ms: 1800 })]).audio
  const preview = buildPartialTimelinePreview(data)
  assert.deepEqual(preview.audio.map(({ start_ms, end_ms, in_ms, out_ms }) => ({ start_ms, end_ms, in_ms, out_ms })), [
    { start_ms: 2100, end_ms: 3100, in_ms: 800, out_ms: 1800 },
  ])
})

test('empty or unusable selections cannot enter preview', () => {
  const mutations: Array<(data: ReturnType<typeof fixture>) => void> = [
    data => { data.shots[0].selected_asset_id = null },
    data => { data.shots[0].selected_asset_id = 'different' },
    data => { data.assets[0].url = '   ' },
    data => { data.assets[0].kind = 'audio' },
    data => { data.assets[0].project_id = 'other-project' },
    data => { data.clips[0].project_id = 'other-project' },
    data => { data.clips[0].in_ms = -1 },
    data => { data.clips[0].out_ms = data.clips[0].in_ms + 199 },
    data => { data.clips[0].out_ms = NaN },
    data => { data.clips[0].source_duration_ms = null },
    data => { data.clips[0].source_duration_ms = Infinity },
    data => { data.clips[0].out_ms = 5001 },
    data => { data.assets[0].kind = 'image' },
    data => { data.assets[0].kind = 'image'; data.clips[0].in_ms = 0; data.clips[0].out_ms = 30001; data.clips[0].source_duration_ms = null },
    data => { data.assetReviews.push({ shot_id: 's1', asset_id: 'a1', status: 'rejected', note: '', updated_at: '' }) },
  ]
  for (const mutate of mutations) {
    const data = fixture()
    data.shots = data.shots.slice(0, 1); data.clips = data.clips.slice(0, 1)
    mutate(data)
    const preview = buildPartialTimelinePreview(data)
    assert.equal(preview.shots.length, 0)
    assert.equal(preview.missingShots.length, 1)
    assert.equal(preview.durationMs, 0)
    assert.equal(preview.complete, false)
  }
  assert.deepEqual(buildPartialTimelinePreview({ shots: [], clips: [], assets: [], assetReviews: [] }), {
    shots: [], clips: [], missingShots: [], audio: [], durationMs: 0, complete: false,
  })
})

test('minimum video duration and a thirty-second still remain eligible', () => {
  const data = fixture()
  data.shots = data.shots.slice(0, 2); data.clips = data.clips.slice(0, 2)
  data.clips[0].out_ms = data.clips[0].in_ms + 200
  data.assets[1].kind = 'image'; data.clips[1].in_ms = 0; data.clips[1].out_ms = 30000; data.clips[1].source_duration_ms = null
  const preview = buildPartialTimelinePreview(data)
  assert.equal(preview.complete, true)
  assert.equal(preview.durationMs, 30200)
})

test('production range excludes outside clips and speech without pulling their timing into the preview', () => {
  const data = fixture()
  const productionShots = data.shots.slice(1, 3)
  data.speechAudio = resolveSpeechTimeline(productionShots, data.clips, [
    placement({ id: 'outside', shot_id: 's1' }),
    placement({ id: 'inside', shot_id: 's3', offset_ms: 100, in_ms: 200, out_ms: 1200 }),
  ]).audio
  const preview = buildPartialTimelinePreview({ ...data, shots: productionShots })
  assert.deepEqual(preview.shots.map(shot => shot.id), ['s2', 's3'])
  assert.deepEqual(preview.clips.map(clip => clip.shot_id), ['s2', 's3'])
  assert.equal(preview.complete, true)
  assert.equal(preview.durationMs, 4000)
  assert.deepEqual(preview.audio.map(item => [item.id, item.start_ms, item.in_ms]), [['inside', 2100, 200]])
})

test('duplicate and orphan clips never add another shot or distort the preview duration', () => {
  const data = fixture()
  data.clips = [data.clips[0], { ...data.clips[0], id: 'older', out_ms: 4000 }, data.clips[0],
    { ...data.clips[0], id: 'orphan', shot_id: 'not-in-production' }]
  const preview = buildPartialTimelinePreview(data)
  assert.equal(preview.clips.length, 1)
  assert.equal(preview.clips[0].id, 'cs1')
  assert.equal(preview.durationMs, 2000)
})

test('a complete range preserves all resolved speech timing, fades and ids', () => {
  const data = fixture()
  data.assets[0].kind = 'image'; data.clips[0].in_ms = 0; data.clips[0].source_duration_ms = null
  data.speechAudio = resolveSpeechTimeline(data.shots, data.clips, [placement({ out_ms: 5000 })]).audio
    .map(item => ({ ...item, fade_in_ms: 80, fade_out_ms: 120 }))
  const preview = buildPartialTimelinePreview(data)
  assert.equal(preview.complete, true)
  assert.equal(preview.durationMs, 9000)
  assert.deepEqual(preview.audio, data.speechAudio)
  assert.deepEqual(preview.missingShots, [])
})
