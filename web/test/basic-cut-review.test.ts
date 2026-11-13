import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EditingCut } from '@video-studio/shared/media/editing-cut'
import { basicCutReviewCandidate, basicCutReviewSignature } from '../src/features/final-cut/basic-cut-review'
import { fixture } from './fixtures/final-cut'

function data() {
  const { detail } = fixture()
  detail.assets.push({ ...detail.assets[0], id: 'voice', kind: 'audio', url: '/voice.mp3' })
  const cut: EditingCut = { id: 'cut', project_id: detail.id, name: '接镜', source_canvas_id: null, revision: 1, ratio: '16:9',
    clips: [
      { id: 'before', asset_id: 'still', title: '之前', in_ms: 0, out_ms: 3000, source_audio_gain: 1, source_audio_fade_ms: 0 },
      { id: 'first-use', asset_id: 'video', title: '前镜', in_ms: 1000, out_ms: 5000, source_audio_gain: .7, source_audio_fade_ms: 300 },
      { id: 'second-use', asset_id: 'video', title: '后镜', in_ms: 2000, out_ms: 6000, source_audio_gain: .9, source_audio_fade_ms: 200 },
    ], speech: [{ id: 'voice-placement', asset_id: 'voice', label: '跨接点完整对白', start_ms: 5000, in_ms: 1000, out_ms: 6000, gain: .8 }],
    music_asset_id: 'voice', audio_settings: { music_gain: .3, duck_music: true, duck_source: true },
    captions: [{ id: 'caption', start_ms: 6000, end_ms: 9000, text: '当前字幕' }], created_at: '', updated_at: '' }
  return { cut, assets: detail.assets, durations: new Map([['video', 8000]]) }
}

test('candidate windows use clip identities, proposed timing and the original full mix position without mutating the cut', () => {
  const { cut, assets, durations } = data(), before = structuredClone(cut)
  const result = basicCutReviewCandidate(cut, 1, 4500, 2500, assets, durations)!
  assert.ok(result)
  assert.deepEqual(result.clips.map(item => [item.id, item.in_ms, item.out_ms, item.source_audio_gain]), [
    ['first-use', 3300, 4500, .7], ['second-use', 2500, 3700, .9],
  ])
  assert.deepEqual(result.shots.map(item => item.id), ['first-use', 'second-use'])
  assert.equal(result.musicOffsetMs, 5300)
  assert.equal(result.deltaMs, -1000)
  assert.deepEqual(result.speechAudio.map(item => [item.start_ms, item.end_ms, item.in_ms, item.out_ms, item.gain]), [[0, 2400, 1300, 3700, .8]])
  assert.equal(result.speechAudio[0].fade_in_ms, 0)
  assert.equal(result.speechAudio[0].fade_out_ms, 0)
  assert.deepEqual(result.captions.map(item => [item.start_ms, item.end_ms]), [[700, 2400]])
  assert.deepEqual(result.clips.map(item => [item.source_audio_envelope_in_ms, item.source_audio_envelope_out_ms, item.source_audio_fade_ms]), [[1000, 4500, 300], [2500, 6000, 200]])
  assert.deepEqual(cut, before)
})

test('review signatures invalidate after a repeated use is moved, trimmed, replaced or remixed', () => {
  const { cut, assets } = data(), signature = basicCutReviewSignature(cut, 'first-use', 'second-use', assets)
  const mutations: Array<(draft: EditingCut) => void> = [
    value => value.clips.reverse(), value => { value.clips[1].out_ms-- }, value => { value.clips[1].asset_id = 'still' },
    value => { value.clips[1].source_audio_gain = .4 }, value => { value.clips[1].source_audio_fade_ms = 0 },
    value => { value.speech[0].start_ms++ }, value => { value.music_asset_id = null }, value => { value.audio_settings.duck_source = false },
  ]
  for (const mutate of mutations) {
    const next = structuredClone(cut); mutate(next)
    assert.notEqual(basicCutReviewSignature(next, 'first-use', 'second-use', assets), signature)
  }
  assert.notEqual(basicCutReviewSignature(cut, 'first-use', 'second-use', assets.map(asset => asset.id === 'video' ? { ...asset, url: '/replacement.mp4' } : asset)), signature)
  assert.equal(basicCutReviewSignature({ ...cut, name: '改名', revision: 2 }, 'first-use', 'second-use', assets), signature)
})

test('invalid and missing media candidates cannot be applied, and still-image boundaries remain fixed', () => {
  const { cut, assets, durations } = data()
  for (const [index, fromOut, toIn] of [[1, 1199, 2000], [1, 8001, 2000], [1, 4500, -1], [1, 4500, 5801], [2, 4500, 2000], [1, NaN, 2000]]) {
    assert.equal(basicCutReviewCandidate(cut, index, fromOut, toIn, assets, durations), null)
  }
  assert.equal(basicCutReviewCandidate(cut, 1, 4500, 2000, assets.filter(asset => asset.id !== 'video'), durations), null)
  assert.equal(basicCutReviewCandidate(cut, 0, 2500, 1000, assets, durations), null)
  assert.ok(basicCutReviewCandidate(cut, 0, 3000, 1000, assets, durations))
})
