import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asset, Job, ProjectDetail, VisualProfile } from '../src/api'
import { assetPresentations } from '../src/asset-presentation'
import { filterLibraryAssets } from '../src/asset-library'

const asset = (id: string, patch: Partial<Asset> = {}): Asset => ({ id, project_id: 'p', shot_id: null, kind: 'image',
  filename: 'f765def3-95b0-490e-ba85-f8cecc65e639.png', source: 'generated', model_id: null, prompt: null,
  remote_url: null, saved: false, created_at: '2026-10-11T06:00:00Z', url: `/api/assets/${id}/file`, ...patch })
const profile = (patch: Partial<VisualProfile> = {}): VisualProfile => ({ id: 'profile', project_id: 'p', name: '林昭',
  variant: 'EP001医院护士制服', kind: 'character', revision: 2, definition: '', view_requirements: '',
  board_asset_id: 'board', asset_task_id: null, board_prompt: '', candidate_asset_ids: ['candidate'], ...patch })
const job = (id: string, result: string, request: unknown): Job => ({ id, project_id: 'p', shot_id: null,
  model_id: null, job_type: 'generation', request: JSON.stringify(request), status: 'succeeded', external_id: null,
  result_asset_id: result, recovery_available: false, error: null, created_at: '2026-10-11' })
const detail = (assets: Asset[], patch: Partial<ProjectDetail> = {}): ProjectDetail => ({ id: 'p', name: '医院夜班',
  brief: '', ratio: '9:16', music_asset_id: null, created_at: '', updated_at: '', production_range: { start_shot_id: null, end_shot_id: null },
  script: { outline: '', characters: '', scenes: [], generation_options: {} }, shots: [], timeline_clips: [], asset_reviews: [],
  assets, jobs: [], asset_tasks: [], visual_profiles: [], ...patch })

test('current boards, candidates and old job outputs recover profile titles without changing stored asset metadata', () => {
  const input = detail(['board', 'candidate', 'old'].map(id => asset(id)), { visual_profiles: [profile()],
    jobs: [job('old-job', 'old', { visual_profile_id: 'profile', visual_profile_revision: 1, resolution: '2K', ratio: '16:9' })] })
  const before = JSON.stringify(input)
  const names = assetPresentations(input)
  for (const id of ['board', 'candidate', 'old']) assert.equal(names.get(id)?.title, '林昭 · EP001医院护士制服')
  assert.equal(names.get('old')?.context, '人物设定 · v1 · 设定图')
  assert.equal(names.get('old')?.specs, '2K · 16:9')
  assert.equal(JSON.stringify(input), before)
})

test('named references and generation requests retain their view labels and revisions', () => {
  const input = detail([asset('reference')], { visual_profiles: [profile()], jobs: [job('r', 'reference', {
    visual_profile_id: 'profile', visual_profile_revision: 1, visual_reference_label: '面部特写',
  })] })
  assert.equal(assetPresentations(input).get('reference')?.title, '林昭 · EP001医院护士制服 · 面部特写')
})

test('shot outputs use type-specific names and canvas titles recover outputs with no shot or profile', () => {
  const input = detail([asset('image', { shot_id: 'shot' }), asset('video', { shot_id: 'shot', kind: 'video' }), asset('custom')], {
    shots: [{ id: 'shot', title: '警报归直线' } as ProjectDetail['shots'][number]], jobs: [job('custom-job', 'custom', {}),
      job('image-job', 'image', { clarity: '2K', resolution: '2560x1440', ratio: '16:9' }),
      job('video-job', 'video', { resolution: '480p', ratio: 'adaptive' })],
  })
  const names = assetPresentations(input, [{ title: '抢救室 · 特写', asset_id: null, job_id: 'custom-job' }])
  assert.equal(names.get('image')?.title, '警报归直线 · 分镜图')
  assert.equal(names.get('video')?.title, '警报归直线 · 视频')
  assert.equal(names.get('image')?.specs, '2K · 16:9')
  assert.equal(names.get('video')?.specs, '480p · 自适应')
  assert.equal(names.get('custom')?.title, '抢救室 · 特写')
})

test('uploads keep user filenames; exports and unmapped UUIDs get readable fallbacks; malformed jobs are tolerated', () => {
  const input = detail([asset('upload', { source: 'upload', filename: '护士参考.png' }), asset('export', { source: 'export', kind: 'video' }), asset('unknown')], {
    jobs: [{ ...job('broken', 'unknown', {}), request: '{broken' }],
  })
  const names = assetPresentations(input)
  assert.equal(names.get('upload')?.title, '护士参考.png')
  assert.equal(names.get('export')?.title, '医院夜班 · 成片')
  assert.match(names.get('unknown')!.title, /^生成图片 · /)
  assert.equal(assetPresentations(null).size, 0)
})

test('search matches display names and still matches original filenames while retaining filters', () => {
  const input = detail([asset('board')], { visual_profiles: [profile()] })
  const names = new Map([...assetPresentations(input)].map(([id, label]) => [id, label.title]))
  const filters = { kind: 'all', source: 'all', sort: 'newest' } as const
  for (const query of ['林昭', '医院护士制服', 'f765def3']) assert.equal(filterLibraryAssets(input.assets, [], { ...filters, query }, names).length, 1)
  assert.equal(filterLibraryAssets(input.assets, [], { ...filters, query: '林昭', kind: 'video' }, names).length, 0)
})
