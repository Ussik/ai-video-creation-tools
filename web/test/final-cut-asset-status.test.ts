import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, Job, ProjectDetail, Shot, VisualProfile, VisualReferenceAsset } from '../src/shared/api/api'
import { finalCutAssetStates, type FinalCutAssetNode } from '../src/features/final-cut/final-cut-asset-status'

const asset = (id: string, patch: Partial<Asset> = {}): Asset => ({ id, project_id: 'p', shot_id: null, kind: 'video',
  filename: `${id}.mp4`, source: 'generated', model_id: null, prompt: null, remote_url: null,
  saved: false, created_at: '2026-11-11T00:00:00Z', url: `/${id}.mp4`, ...patch })
const shot = (id: string, selected: string | null, patch: Partial<Shot> = {}): Shot => ({ id, project_id: 'p',
  position: 0, title: id, prompt: '', duration: 5, selected_asset_id: selected, source_scene_id: null,
  start_state: '', end_state: '', cut_note: '', ...patch })
const profile = (patch: Partial<VisualProfile> = {}): VisualProfile => ({ id: 'profile', project_id: 'p', kind: 'character',
  name: '林昭', variant: '', definition: '', view_requirements: '', revision: 2, board_asset_id: null,
  asset_task_id: null, board_prompt: '', ...patch })
const reference = (id: string, patch: Partial<VisualReferenceAsset> = {}): VisualReferenceAsset => ({ id: `ref-${id}`,
  profile_id: 'profile', asset_id: id, view: 'face', purpose: 'identity', label: '', revision: 2,
  style_version: 'style-current', status: 'candidate', is_default: false, source_asset_id: null, source_job_id: null,
  created_at: '', updated_at: '', ...patch })
const detail = (assets: Asset[], patch: Partial<ProjectDetail> = {}): ProjectDetail => ({ id: 'p', name: '夜班',
  brief: '', ratio: '16:9', music_asset_id: null, created_at: '', updated_at: '',
  production_range: { start_shot_id: null, end_shot_id: null },
  script: { outline: '', characters: '', scenes: [], generation_options: {} }, shots: [], timeline_clips: [],
  asset_reviews: [], assets, jobs: [], asset_tasks: [],
  project_visual_style: { version: 'style-current', label: '水墨', source: 'settings', details: {} }, ...patch })
const visualJob = (assetId: string, patch: Record<string, unknown> = {}): Job => ({ id: `job-${assetId}`, project_id: 'p',
  shot_id: null, model_id: null, job_type: 'generation', status: 'succeeded', external_id: null, result_asset_id: assetId,
  recovery_available: false, error: null, created_at: '', request: JSON.stringify({ project_style_version: 'style-current', ...patch }) })
const node = (asset_id: string, type: FinalCutAssetNode['type'] = 'generation', settings: FinalCutAssetNode['settings'] = {}): FinalCutAssetNode => ({ type, asset_id, settings })

test('source selections establish confirmation while saved assets, approvals and timeline usage do not', () => {
  const input = detail(['selected', 'saved', 'approved', 'timeline-only', 'unassigned'].map(id => asset(id, { saved: id === 'saved' })), {
    shots: [shot('shot', 'selected')],
    asset_reviews: [{ shot_id: 'shot', asset_id: 'approved', status: 'approved', note: '', updated_at: '' }],
    timeline_clips: [{ id: 'clip', project_id: 'p', shot_id: 'shot', asset_id: 'timeline-only',
      in_ms: 0, out_ms: 5000, source_duration_ms: 5000, source_audio_gain: 1, source_audio_fade_ms: 0 }],
  })
  const before = structuredClone(input), states = finalCutAssetStates(input)
  assert.deepEqual(states.get('selected'), { status: 'confirmed', label: '已确认' })
  for (const id of ['saved', 'approved', 'timeline-only', 'unassigned']) assert.deepEqual(states.get(id), { status: 'candidate', label: '候选' })
  assert.deepEqual(input, before)
})

test('historical shot selections remain confirmed and active records override duplicate shot snapshots', () => {
  const states = finalCutAssetStates(detail(['historical', 'superseded', 'active'].map(id => asset(id)), {
    historical_shots: [shot('old-shot', 'historical', { superseded_by: 'new-shot' }), shot('duplicate', 'superseded')],
    shots: [shot('duplicate', 'active')],
  }))
  assert.equal(states.get('historical')?.status, 'confirmed')
  assert.equal(states.get('active')?.status, 'confirmed')
  assert.equal(states.get('superseded')?.status, 'candidate')
})

test('current canvas images and videos are confirmed before selecting any shot into a cut', () => {
  const input = detail([asset('current-image', { kind: 'image', shot_id: 'shot' }),
    asset('current-video', { shot_id: 'shot' }), asset('alternate', { shot_id: 'shot' })], { shots: [shot('shot', null)] })
  const nodes = [node('current-image'), node('current-video')]
  const before = structuredClone({ input, nodes }), states = finalCutAssetStates(input, nodes)
  assert.deepEqual(states.get('current-image'), { status: 'confirmed', label: '已确认' })
  assert.deepEqual(states.get('current-video'), { status: 'confirmed', label: '已确认' })
  assert.equal(states.get('alternate')?.status, 'candidate')
  assert.deepEqual({ input, nodes }, before)
})

test('changing current canvas media returns the previous image and video versions to candidates', () => {
  const input = detail([asset('old-image', { kind: 'image' }), asset('new-image', { kind: 'image' }),
    asset('old-video'), asset('new-video')])
  const previous = finalCutAssetStates(input, [node('old-image', 'image'), node('old-video', 'video')])
  assert.equal(previous.get('old-image')?.status, 'confirmed')
  assert.equal(previous.get('old-video')?.status, 'confirmed')
  const current = finalCutAssetStates(input, [node('new-image', 'image'), node('new-video', 'video')])
  for (const id of ['old-image', 'old-video']) assert.equal(current.get(id)?.status, 'candidate')
  for (const id of ['new-image', 'new-video']) assert.equal(current.get(id)?.status, 'confirmed')
})

test('analysis inputs, text nodes, missing or nonvisual assets and profile candidates do not imply confirmation', () => {
  const input = detail(['image-analysis', 'video-analysis', 'text-input', 'script-input', 'profile-candidate'].map(id => asset(id)), {
    visual_profiles: [profile({ candidate_asset_ids: ['profile-candidate'] })],
  })
  input.assets.push(asset('audio-input', { kind: 'audio' }), asset('text-output', { kind: 'text' }))
  const states = finalCutAssetStates(input, [node('image-analysis', 'image_analysis'), node('video-analysis', 'video_analysis'),
    node('text-input', 'text'), node('script-input', 'project_script_ref'), node('audio-input'), node('text-output'),
    node('missing'), node('profile-candidate', 'generation', { visual_profile_id: 'profile' })])
  for (const state of states.values()) assert.equal(state.status, 'candidate')
  assert.equal(states.has('missing'), false)
})

test('speech confirms only selected takes and leaves other audio available as candidates', () => {
  const states = finalCutAssetStates(detail([asset('voice', { kind: 'audio' }), asset('alternate', { kind: 'audio' })], {
    speech: { voices: [], lines: [{ id: 'line', project_id: 'p', position: 0, selected_asset_id: 'voice', voice_id: null,
      scene_id: null, text: '', instructions: '', context_text: '', created_at: '', updated_at: '', takes: [] }] },
  }))
  assert.equal(states.get('voice')?.status, 'confirmed')
  assert.equal(states.get('alternate')?.status, 'candidate')
})

test('changed or stale selected speech needs review and removed source speech stays historical', () => {
  const input = detail(['stale', 'changed', 'removed'].map(id => asset(id, { kind: 'audio' })), {
    speech: { voices: [], lines: ['stale', 'changed', 'removed'].map(id => ({ id: `line-${id}`, project_id: 'p',
      position: 0, selected_asset_id: id, voice_id: null, scene_id: null, text: '', instructions: '', context_text: '',
      created_at: '', updated_at: '', takes: [], selected_is_stale: id !== 'changed',
      source_status: id === 'changed' ? 'changed' as const : id === 'removed' ? 'removed' as const : 'current' as const })) },
  })
  const before = structuredClone(input), states = finalCutAssetStates(input)
  for (const id of ['stale', 'changed']) assert.deepEqual(states.get(id), { status: 'candidate', label: '待复核' })
  assert.deepEqual(states.get('removed'), { status: 'other', label: '历史配音' })
  assert.deepEqual(input, before)
})

test('current profile boards and references confirm while older revisions and archived references stay separate', () => {
  const states = finalCutAssetStates(detail(['board', 'current', 'candidate', 'old', 'archived', 'reused'].map(id => asset(id, { kind: 'image' })), {
    visual_profiles: [profile({ board_asset_id: 'board', reference_assets: [reference('current', { status: 'confirmed' }),
      reference('candidate'), reference('old', { revision: 1, status: 'confirmed' }), reference('archived', { status: 'archived' }),
      reference('reused', { revision: 1, status: 'confirmed' }), reference('reused')] })],
  }))
  for (const id of ['board', 'current']) assert.equal(states.get(id)?.status, 'confirmed')
  for (const id of ['candidate', 'reused']) assert.equal(states.get(id)?.status, 'candidate')
  assert.deepEqual(states.get('old'), { status: 'other', label: '旧版参考' })
  assert.deepEqual(states.get('archived'), { status: 'other', label: '已归档' })
})

test('boards needing style or base review stay in candidates with a review label', () => {
  for (const patch of [{ board_style_status: 'needs_review' as const }, { base_reference_status: 'waiting' as const }, { base_reference_status: 'needs_review' as const }]) {
    const states = finalCutAssetStates(detail([asset('board')], { visual_profiles: [profile({ board_asset_id: 'board', ...patch })] }))
    assert.deepEqual(states.get('board'), { status: 'candidate', label: '待复核' })
  }
})

test('confirmed references with old or missing style records still require review', () => {
  for (const style_version of ['style-old', null]) {
    const states = finalCutAssetStates(detail([asset('reference')], {
      visual_profiles: [profile({ reference_assets: [reference('reference', { status: 'confirmed', style_version })] })],
    }))
    assert.deepEqual(states.get('reference'), { status: 'candidate', label: '待复核' })
  }
  const states = finalCutAssetStates(detail([asset('reference')], { project_visual_style: undefined,
    visual_profiles: [profile({ reference_assets: [reference('reference', { status: 'confirmed' })] })],
  }))
  assert.deepEqual(states.get('reference'), { status: 'candidate', label: '待复核' })
})

test('custom style reference provenance needs a matching human style review before confirmation is current', () => {
  const input = detail([asset('reference')], {
    visual_profiles: [profile({ reference_assets: [reference('reference', { status: 'confirmed' })] })],
    jobs: [visualJob('reference', { effective_visual_style: { origin: 'custom', fingerprint: 'a'.repeat(64) } })],
  })
  assert.deepEqual(finalCutAssetStates(input).get('reference'), { status: 'candidate', label: '待复核' })
  input.jobs = [visualJob('reference', { effective_visual_style: { origin: 'custom', fingerprint: 'a'.repeat(64) },
    visual_style_reviews: [{ profile_id: 'profile', style_version: 'style-current' }] })]
  assert.deepEqual(finalCutAssetStates(input).get('reference'), { status: 'confirmed', label: '已确认' })
})

test('confirmation beats archives and sources, while archives retain precedence over imported or exported labels', () => {
  const states = finalCutAssetStates(detail([asset('imported', { source: 'upload' }), asset('exported', { source: 'export' }),
    asset('selected-upload', { source: 'upload' }), asset('archived-upload', { source: 'upload' }), asset('archived-board')], {
    shots: [shot('shot', 'selected-upload', { archived_candidate_asset_ids: ['selected-upload', 'archived-upload'] })],
    visual_profiles: [profile({ board_asset_id: 'archived-board', archived_candidate_asset_ids: ['archived-board'] })],
  }))
  assert.deepEqual(states.get('imported'), { status: 'other', label: '已导入' })
  assert.deepEqual(states.get('exported'), { status: 'other', label: '已导出' })
  assert.deepEqual(states.get('selected-upload'), { status: 'confirmed', label: '已确认' })
  assert.deepEqual(states.get('archived-upload'), { status: 'other', label: '已归档' })
  assert.deepEqual(states.get('archived-board'), { status: 'confirmed', label: '已确认' })
})
