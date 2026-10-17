import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Shot } from '@video-studio/shared/api/contracts'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-shot-candidates-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, initDb, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

async function fixture() {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '分镜候选' })
  const shot = await call<Shot>('POST', `/api/projects/${project.id}/shots`, { title: '雨夜船头' })
  return { projectId: project.id, shotId: shot.id }
}

function candidate(projectId: string, shotId: string | null, options: {
  kind?: string; source?: string; request?: unknown; rawRequest?: string; noJob?: boolean; status?: string; jobType?: string
} = {}) {
  const assetId = newId(), jobId = newId(), timestamp = now()
  const kind = options.kind ?? 'image'
  const filename = `candidate.${kind === 'video' ? 'mp4' : kind === 'audio' ? 'wav' : kind === 'text' ? 'txt' : 'png'}`
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '雨夜船头', NULL, ?)`, assetId, projectId, shotId,
  kind, filename, join(testData, filename), options.source ?? 'generated', timestamp)
  if (!options.noJob) run(`INSERT INTO jobs (id, project_id, shot_id, model_id, job_type, request, status,
    external_id, result_asset_id, error, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
  jobId, projectId, shotId, options.jobType ?? 'generation', options.rawRequest ?? JSON.stringify(options.request ?? {}),
  options.status ?? 'succeeded', assetId, timestamp, timestamp)
  return { assetId, jobId }
}

async function detail(projectId: string) {
  return call<{ shots: Shot[]; assets: Array<{ id: string }>; jobs: Array<{ id: string }>; timeline_clips: unknown[] }>(
    'GET', `/api/projects/${projectId}`)
}

test('shot image archives restore idempotently and survive a refreshed project and repeated schema initialization', async () => {
  const f = await fixture(), first = candidate(f.projectId, f.shotId), second = candidate(f.projectId, f.shotId)
  const url = `/api/shots/${f.shotId}/candidates/${first.assetId}`
  assert.deepEqual((await detail(f.projectId)).shots[0]?.archived_candidate_asset_ids, [])
  for (let i = 0; i < 2; i++) {
    const shot = await call<Shot>('PUT', url, { archived: true })
    assert.deepEqual(shot.archived_candidate_asset_ids, [first.assetId])
  }
  assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM shot_candidate_archives WHERE shot_id=?', f.shotId)?.count, 1)
  initDb()
  const refreshed = await detail(f.projectId)
  assert.deepEqual(refreshed.shots[0]?.archived_candidate_asset_ids, [first.assetId])
  assert.deepEqual(new Set(refreshed.assets.map(asset => asset.id)), new Set([first.assetId, second.assetId]))
  assert.deepEqual(new Set(refreshed.jobs.map(job => job.id)), new Set([first.jobId, second.jobId]))
  assert.equal(refreshed.shots[0]?.selected_asset_id, null)
  assert.deepEqual(refreshed.timeline_clips, [])
  for (let i = 0; i < 2; i++) assert.deepEqual((await call<Shot>('PUT', url, { archived: false })).archived_candidate_asset_ids, [])
  assert.deepEqual((await detail(f.projectId)).shots[0]?.archived_candidate_asset_ids, [])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('shot video archives restore idempotently without changing media, jobs or timeline selections', async () => {
  const f = await fixture(), video = candidate(f.projectId, f.shotId, { kind: 'video' }), image = candidate(f.projectId, f.shotId)
  const url = `/api/shots/${f.shotId}/candidates/${video.assetId}`
  const before = await detail(f.projectId)
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await call<Shot>('PUT', url, { archived: true })).archived_candidate_asset_ids, [video.assetId])
  }
  assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM shot_candidate_archives WHERE shot_id=?', f.shotId)?.count, 1)
  const archived = await detail(f.projectId)
  assert.deepEqual(archived.shots[0]?.archived_candidate_asset_ids, [video.assetId])
  assert.deepEqual(new Set(archived.assets.map(asset => asset.id)), new Set([video.assetId, image.assetId]))
  assert.deepEqual(archived.assets, before.assets)
  assert.deepEqual(archived.jobs, before.jobs)
  assert.deepEqual(archived.timeline_clips, before.timeline_clips)
  assert.equal(archived.shots[0]?.selected_asset_id, null)
  for (let i = 0; i < 2; i++) assert.deepEqual((await call<Shot>('PUT', url, { archived: false })).archived_candidate_asset_ids, [])
  assert.deepEqual((await detail(f.projectId)).shots[0]?.archived_candidate_asset_ids, [])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('archive mutations reject foreign, uploaded, audio, text and non-storyboard results without creating entries', async () => {
  const f = await fixture(), other = await fixture()
  const otherShot = await call<Shot>('POST', `/api/projects/${f.projectId}/shots`, { title: '另一个镜头' })
  const invalidAssets = [
    candidate(other.projectId, other.shotId), candidate(f.projectId, otherShot.id), candidate(f.projectId, null),
    candidate(f.projectId, f.shotId, { kind: 'audio' }), candidate(f.projectId, f.shotId, { kind: 'text' }),
    candidate(f.projectId, f.shotId, { source: 'upload' }),
    candidate(f.projectId, f.shotId, { noJob: true }), candidate(f.projectId, f.shotId, { status: 'failed' }),
    candidate(f.projectId, f.shotId, { jobType: 'export' }),
    candidate(f.projectId, f.shotId, { request: { visual_profile_id: 'a-profile' } }),
    candidate(f.projectId, f.shotId, { request: { visual_reference_generation: true } }),
    candidate(f.projectId, f.shotId, { request: { visual_reference_view: 'front' } }),
    candidate(f.projectId, f.shotId, { request: { asset_task_id: 'legacy-task' } }),
    ...['character', 'location', 'prop'].map(source_artifact_type => candidate(f.projectId, f.shotId, { request: { source_artifact_type } })),
    candidate(f.projectId, f.shotId, { rawRequest: '{incomplete' }),
    candidate(other.projectId, other.shotId, { kind: 'video' }), candidate(f.projectId, otherShot.id, { kind: 'video' }),
    candidate(f.projectId, f.shotId, { kind: 'video', source: 'upload' }),
    candidate(f.projectId, f.shotId, { kind: 'video', noJob: true }),
    candidate(f.projectId, f.shotId, { kind: 'video', status: 'running' }),
    candidate(f.projectId, f.shotId, { kind: 'video', jobType: 'export' }),
    candidate(f.projectId, f.shotId, { kind: 'video', request: { visual_profile_id: 'a-profile' } }),
    candidate(f.projectId, f.shotId, { kind: 'video', request: { asset_task_id: 'legacy-task' } }),
  ]
  for (const { assetId } of invalidAssets) {
    for (const archived of [true, false]) {
      const response = await app.inject({ method: 'PUT', url: `/api/shots/${f.shotId}/candidates/${assetId}`, payload: { archived } })
      assert.equal(response.statusCode, 422, `${assetId}: ${response.body}`)
    }
  }
  const valid = candidate(f.projectId, f.shotId)
  for (const payload of [{ archived: 'true' }, { archived: true, shot_id: otherShot.id }, {}]) {
    const response = await app.inject({ method: 'PUT', url: `/api/shots/${f.shotId}/candidates/${valid.assetId}`, payload })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.deepEqual((await detail(f.projectId)).shots.map(shot => shot.archived_candidate_asset_ids), [[], []])
})

test('archiving cannot remove a selected shot image or video or change its timeline selection', async () => {
  for (const kind of ['image', 'video']) {
    const f = await fixture(), selected = candidate(f.projectId, f.shotId, { kind })
    const clipId = newId()
    run('UPDATE shots SET selected_asset_id=? WHERE id=?', selected.assetId, f.shotId)
    run('INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, in_ms, out_ms) VALUES (?, ?, ?, ?, 0, 5000)',
      clipId, f.projectId, f.shotId, selected.assetId)
    const before = await detail(f.projectId)
    const response = await app.inject({ method: 'PUT', url: `/api/shots/${f.shotId}/candidates/${selected.assetId}`, payload: { archived: true } })
    assert.equal(response.statusCode, 422)
    assert.match(response.body, /已选入成片/)
    assert.equal(one<{ selected_asset_id: string }>('SELECT selected_asset_id FROM shots WHERE id=?', f.shotId)?.selected_asset_id, selected.assetId)
    assert.equal(one<{ asset_id: string }>('SELECT asset_id FROM timeline_clips WHERE id=?', clipId)?.asset_id, selected.assetId)
    const after = await detail(f.projectId)
    assert.deepEqual(after.timeline_clips, before.timeline_clips)
    assert.deepEqual(after.assets, before.assets)
    assert.deepEqual(after.jobs, before.jobs)
    assert.deepEqual(after.shots[0]?.archived_candidate_asset_ids, [])
  }
})

test('deleting a shot cleans its archive metadata while retaining generated media', async () => {
  const f = await fixture(), image = candidate(f.projectId, f.shotId)
  await call('PUT', `/api/shots/${f.shotId}/candidates/${image.assetId}`, { archived: true })
  await call('DELETE', `/api/shots/${f.shotId}`)
  assert.equal(one('SELECT 1 FROM shot_candidate_archives WHERE asset_id=?', image.assetId), undefined)
  assert.deepEqual(one('SELECT shot_id FROM assets WHERE id=?', image.assetId), { shot_id: null })
  assert.ok(one('SELECT 1 FROM jobs WHERE id=?', image.jobId))
})

test('canvas keeps the acknowledged completion marker when a historical shot candidate is displayed', async () => {
  for (const kind of ['image', 'video']) {
    const f = await fixture(), latest = candidate(f.projectId, f.shotId, { kind }), historical = candidate(f.projectId, f.shotId, { kind })
    const url = `/api/projects/${f.projectId}/canvas`
    const canvas = await call<{ nodes: unknown[]; edges: unknown[]; revision: string }>('GET', url)
    await call('PUT', url, { revision: canvas.revision, edges: [], nodes: [{ id: newId(), type: 'generation', x: 0, y: 0,
      width: 320, height: 240, title: kind === 'video' ? '分镜视频' : '分镜图', text: '雨夜船头', prompt: '雨夜船头', asset_id: historical.assetId,
      shot_id: f.shotId, job_id: latest.jobId, model_id: null,
      settings: { modality: kind, generation_completed_job_id: latest.jobId } }] })
    const refreshed = await call<{ nodes: Array<{ asset_id: string; job_id: string; settings: { modality: string; generation_completed_job_id: string } }> }>('GET', url)
    assert.equal(refreshed.nodes[0]?.asset_id, historical.assetId)
    assert.equal(refreshed.nodes[0]?.job_id, latest.jobId)
    assert.equal(refreshed.nodes[0]?.settings.modality, kind)
    assert.equal(refreshed.nodes[0]?.settings.generation_completed_job_id, latest.jobId)
  }
})
