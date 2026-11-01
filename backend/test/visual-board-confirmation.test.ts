import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'

const directory = await mkdtemp(join(tmpdir(), 'visual-board-confirmation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { autoConfirmGeneratedProfileBoard } = await import('../src/modules/visuals/visual-profiles.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
type Job = import('../src/infrastructure/database/db.js').Job
type Profile = import('../src/modules/visuals/visual-profiles.js').VisualProfile
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture(count = 2) {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '默认候选测试' })
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '渡口' })
  const visuals = await call<{ visual_profiles: Profile[] }>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{
    kind: 'character', name: '船工', variant: '常服', definition: '蓝色粗布衣，短发', view_requirements: '正侧背视图', scene_ids: [scene.id],
  }] })
  const profile = visuals.visual_profiles[0]!
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '船工', source_scene_id: scene.id })
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '隔离测试', base_url: 'https://example.invalid' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '测试', remote_id: 'test', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/image', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}' } } })
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, { model_id: model.id, expected_revision: 1 })
  const batch = await call<{ jobs: Job[]; task: { id: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, {
    model_id: model.id, expected_revision: 1, prompt: preview.prompt, reference_signature: preview.reference_signature,
    ratio: '16:9', resolution: null, quality: null, clarity: null, background: null, candidate_count: count,
  })
  return { project, profile, shot, ...batch }
}
function succeed(job: Job) {
  const assetId = newId()
  run(`INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'board.png', '/tmp/board.png', 'generated', ?)`, assetId, job.project_id, now())
  run("UPDATE jobs SET status='succeeded', result_asset_id=? WHERE id=?", assetId, job.id)
  return assetId
}
function ready(taskId: string) { run("UPDATE asset_tasks SET status='ready' WHERE id=?", taskId) }
function selected(profileId: string) { return one<Profile>('SELECT * FROM visual_profiles WHERE id=?', profileId)! }
async function confirm(f: Awaited<ReturnType<typeof fixture>>) {
  return call<{ confirmed: Profile[]; skipped: Array<{ message: string }> }>('POST', `/api/projects/${f.project.id}/visual-profiles/confirm-first`, {
    profiles: [{ id: f.profile.id, expected_revision: f.profile.revision }], expected_style_version: projectVisualStyle(f.project.id).version,
  })
}

test('automatic confirmation chooses submission order, fills unresolved shot references and retains all candidates', async () => {
  const f = await fixture()
  assert.deepEqual(f.jobs.map(job => JSON.parse(job.request).visual_candidate_index), [0, 1])
  const second = succeed(f.jobs[1]!)
  autoConfirmGeneratedProfileBoard(f.jobs[1]!)
  assert.equal(selected(f.profile.id).board_asset_id, null, 'an incomplete batch stays unresolved')
  const first = succeed(f.jobs[0]!)
  ready(f.task.id)
  autoConfirmGeneratedProfileBoard(f.jobs[0]!)
  assert.equal(selected(f.profile.id).board_asset_id, first)
  assert.equal(selected(f.profile.id).revision, 1)
  assert.equal(one<{ board_asset_id: string }>('SELECT board_asset_id FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', f.shot.id, f.profile.id)?.board_asset_id, first)
  assert.equal(all('SELECT * FROM assets WHERE project_id=?', f.project.id).length, 2)
  assert.notEqual(first, second)
  assert.equal((await confirm(f)).confirmed.length, 0, 'repeated clicks preserve the choice')
})

test('last-candidate failure still confirms the first successful candidate, excluding archived results', async () => {
  const f = await fixture(4)
  const archived = succeed(f.jobs[0]!)
  run('INSERT INTO visual_profile_candidates (profile_id, asset_id, archived, updated_at) VALUES (?, ?, 1, ?)', f.profile.id, archived, now())
  const firstAvailable = succeed(f.jobs[1]!)
  succeed(f.jobs[2]!)
  run("UPDATE jobs SET status='failed' WHERE id=?", f.jobs[3]!.id)
  ready(f.task.id)
  autoConfirmGeneratedProfileBoard(f.jobs[3]!)
  assert.equal(selected(f.profile.id).board_asset_id, firstAvailable)
})

test('manual batch confirmation supports legacy jobs without auto approval and preserves frozen shot snapshots', async () => {
  const f = await fixture()
  for (const job of f.jobs) {
    const { auto_confirm_first, visual_candidate_index, ...legacy } = JSON.parse(job.request)
    run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify(legacy), job.id)
  }
  const first = succeed(f.jobs[0]!)
  const frozen = succeed(f.jobs[1]!)
  run("UPDATE shot_visual_bindings SET board_asset_id=?, sync_mode='locked' WHERE shot_id=? AND profile_id=?", frozen, f.shot.id, f.profile.id)
  ready(f.task.id)
  const result = await confirm(f)
  assert.equal(result.confirmed[0]?.board_asset_id, first)
  assert.equal(one<{ board_asset_id: string }>('SELECT board_asset_id FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', f.shot.id, f.profile.id)?.board_asset_id, frozen)
})

test('neither automatic nor bulk confirmation overwrites an existing user selection', async () => {
  const f = await fixture()
  const first = succeed(f.jobs[0]!), preferred = succeed(f.jobs[1]!)
  ready(f.task.id)
  await call('PATCH', `/api/visual-profiles/${f.profile.id}`, { expected_revision: 1, board_asset_id: preferred })
  autoConfirmGeneratedProfileBoard(f.jobs[0]!)
  const result = await confirm(f)
  assert.equal(selected(f.profile.id).board_asset_id, preferred)
  assert.notEqual(first, preferred)
  assert.equal(result.confirmed.length, 0)
})

test('old definition versions and old styles cannot be confirmed in bulk or automatically', async () => {
  for (const changed of ['revision', 'style']) {
    const f = await fixture()
    succeed(f.jobs[0]!)
    run("UPDATE jobs SET status='failed' WHERE id=?", f.jobs[1]!.id)
    ready(f.task.id)
    if (changed === 'revision') run('UPDATE visual_profiles SET revision=2 WHERE id=?', f.profile.id)
    else for (const job of f.jobs) run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify({ ...JSON.parse(job.request), project_style_version: '0'.repeat(64) }), job.id)
    autoConfirmGeneratedProfileBoard(f.jobs[1]!)
    assert.equal(selected(f.profile.id).board_asset_id, null)
    assert.equal((await confirm(f)).confirmed.length, 0)
  }
})

test('foreign profiles reject the entire bulk operation before any selection changes', async () => {
  const f = await fixture(), foreign = await fixture()
  succeed(f.jobs[0]!); ready(f.task.id)
  const result = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/visual-profiles/confirm-first`, payload: {
    profiles: [{ id: f.profile.id, expected_revision: 1 }, { id: foreign.profile.id, expected_revision: 1 }],
  } })
  assert.equal(result.statusCode, 422)
  assert.equal(selected(f.profile.id).board_asset_id, null)
})

test('the worker persists automatic confirmation without a canvas open or extra generation calls', async t => {
  run("DELETE FROM jobs WHERE status='queued'")
  const f = await fixture(1)
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#46765e' } }).png().toBuffer()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ data: [{ b64_json: png.toString('base64') }] }) })
  const stop = startWorker()
  try {
    for (let attempt = 0; attempt < 80 && !selected(f.profile.id).board_asset_id; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(selected(f.profile.id).board_asset_id)
    assert.equal(selected(f.profile.id).board_asset_id, one<Job>('SELECT * FROM jobs WHERE id=?', f.jobs[0]!.id)?.result_asset_id)
    assert.equal(calls, 1)
  } finally { await stop() }
})
