import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dataDir = await mkdtemp(join(tmpdir(), 'storyboard-generation-revision-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { buildApp } = await import('../src/app.js')
const { db, now, run } = await import('../src/infrastructure/database/db.js')
const { retainCandidateReview } = await import('../src/modules/generation/candidate-review-evidence.js')
const { storyboardCandidateScenes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { invalidateStoryboardShot } = await import('../src/modules/storyboard/storyboard-invalidation.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
async function call(method: 'POST' | 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  if (url.endsWith('/storyboard/commit')) {
    const body = payload as { signature: string; scenes: unknown }
    const projectId = url.split('/')[3]!
    payload = { ...body, review_id: retainCandidateReview({ projectId, family: 'storyboard', candidate: storyboardCandidateScenes(body.scenes), source: body.signature, modelId: 'fixture-review', status: 'passed', report: { issues: [] } }).review_id }
  }
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '分镜版本生成回归' })
  const scene = await call('POST', `/api/projects/${project.id}/script/scenes`, { heading: '天台', episode_number: 1, action: '主角看向远方', duration: 5 })
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '天台远景', source_scene_id: scene.id, prompt: '远景看城市', duration: 5 })
  const context = await call('POST', `/api/projects/${project.id}/script/storyboard/context`, { scene_ids: [scene.id] })
  await call('POST', `/api/projects/${project.id}/script/storyboard/commit`, { request_id: randomUUID(), signature: context.signature,
    scenes: [{ scene_id: scene.id, scene_duration: 5, shots: [{ shot_id: shot.id, title: '天台远景', prompt: '主角看向远方',
      image_prompt: '天台远景首帧', video_prompt: '主角转头看向远方',
      audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: true },
      duration: 5, start_state: '站立', end_state: '远眺', cut_note: '' }] }] })
  const detail = await call('GET', `/api/projects/${project.id}`)
  const provider = await call('POST', '/api/providers', { name: '隔离测试', base_url: 'https://generation.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '测试图片模型', remote_id: 'image', modality: 'image',
    protocol: 'image_generations', settings: { request_path: 'images/generations', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}' } } })
  return { project, scene, shot: detail.shots[0], input: { model_id: model.id, shot_id: shot.id, prompt: '天台远景首帧', mode: 'text', ratio: '16:9' } }
}

test('generation stamps the confirmed storyboard revision and rejects a preview from an older plan', async () => {
  const f = await fixture()
  const preview = await call('POST', `/api/projects/${f.project.id}/generate/preview`, f.input)
  assert.equal(preview.storyboard_revision, f.shot.storyboard_revision)
  const job = await call('POST', `/api/projects/${f.project.id}/generate`, preview)
  assert.equal(JSON.parse(job.request).storyboard_revision, f.shot.storyboard_revision)
  run('UPDATE shots SET storyboard_revision=storyboard_revision+1 WHERE id=?', f.shot.id)
  for (const suffix of ['generate/preview', 'generate']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/${suffix}`, payload: preview })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.json().detail, /分镜已重新规划/)
  }
  const detail = await call('GET', `/api/projects/${f.project.id}`)
  assert.equal(detail.jobs.length, 1, 'rejected requests cannot create paid work')
  assert.equal(detail.jobs[0].id, job.id, 'old work stays in history')
})

test('editing the screenplay blocks generation until its scene has been replanned', async () => {
  const f = await fixture()
  const preview = await call('POST', `/api/projects/${f.project.id}/generate/preview`, f.input)
  await call('PATCH', `/api/script-scenes/${f.scene.id}`, { action: '主角奔跑离开天台' })
  for (const suffix of ['generate/preview', 'generate']) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/${suffix}`, payload: preview })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.json().detail, /剧本已更新.*重新规划/)
  }
  assert.equal((await call('GET', `/api/projects/${f.project.id}`)).jobs.length, 0)
})

test('a stale local canvas cannot restore old results with a fresh graph token; deliberate historical reuse is allowed', async () => {
  const f = await fixture()
  const path = `/api/projects/${f.project.id}/canvas`
  const empty = await call('GET', path)
  const node = { id: 'shot-generator', type: 'generation', x: 40, y: 80, width: 320, height: 280,
    shot_id: f.shot.id, title: f.shot.title, prompt: f.shot.image_prompt, settings: { modality: 'image', storyboard_revision: f.shot.storyboard_revision } }
  const saved = await call('PUT', path, { ...empty, nodes: [node] })
  invalidateStoryboardShot(f.shot, f.shot.storyboard_revision + 1)
  const current = await call('GET', path)
  const stale = await app.inject({ method: 'PUT', url: path, payload: { ...saved, revision: current.revision } })
  assert.equal(stale.statusCode, 409, stale.body)
  run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at)
    VALUES ('historical-image',?,?,'image','history.png','/test/history.png','generated',?)`, f.project.id, f.shot.id, now())
  const selected = await call('PUT', path, { ...current, nodes: [{ ...node, asset_id: 'historical-image',
    settings: { ...node.settings, storyboard_revision: f.shot.storyboard_revision + 1 } }] })
  assert.equal(selected.nodes[0].asset_id, 'historical-image')
  assert.equal(selected.nodes[0].settings.storyboard_revision, f.shot.storyboard_revision + 1)
})
