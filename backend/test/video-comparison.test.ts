import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { videoDurationPlan } from '@video-studio/shared/media/video-comparison'

const directory = await mkdtemp(join(tmpdir(), 'studio-video-comparison-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, mediaDir, run, required, one } = await import('../src/infrastructure/database/db.js')
const { registerVideoComparisonRoutes, initializeVideoComparisonSchema } = await import('../src/modules/generation/video-comparison.js')
initDb(); initializeVideoComparisonSchema(); initializeVideoComparisonSchema()
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
let enqueues = 0
registerVideoComparisonRoutes(app, { enqueue: async (projectId, shotId, modelId, request, jobId) => {
  enqueues++
  run(`INSERT INTO jobs (id,project_id,shot_id,model_id,job_type,request,status,created_at,updated_at)
    VALUES (?,?,?,?,'generation',?,'queued','2026-10-26','2026-10-26')`, jobId, projectId, shotId, modelId, JSON.stringify(request))
  return required('jobs', jobId) as any
} })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

let sequence = 0
async function fixture() {
  const id = `comparison-${sequence++}`, path = join(mediaDir, id)
  await mkdir(path, { recursive: true })
  const video = join(path, 'baseline.mp4'), first = join(path, 'first.png'), second = join(path, 'second.png')
  await Promise.all([writeFile(video, 'test-video-bytes'), writeFile(first, 'first-reference'), writeFile(second, 'second-reference')])
  run("INSERT INTO projects(id,name,ratio,created_at,updated_at) VALUES (?,?,'16:9','2026-10-26','2026-10-26')", id, id)
  run("INSERT INTO providers(id,name,adapter,base_url,created_at) VALUES (?,?,'http','https://example.invalid','2026-10-26')", `${id}-provider`, 'test-provider')
  run("INSERT INTO models(id,provider_id,name,remote_id,modality,protocol,settings) VALUES (?,?,?,'seedance-fast','video','async_video','{}')", `${id}-model`, `${id}-provider`, 'Fast')
  run("INSERT INTO shots(id,project_id,position,title,prompt,duration,selected_asset_id,created_at,video_prompt,start_state,end_state) VALUES (?,?,0,'反应','原剧情',2,?,'2026-10-26','笑容消失，背景静止','带笑','迟疑')", `${id}-shot`, id, `${id}-video`)
  for (const [suffix, kind, filename, file] of [['video','video','baseline.mp4',video],['ref1','image','first.png',first],['ref2','image','second.png',second]]) {
    run("INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,model_id,created_at) VALUES (?,?,?,?,?,?,'generated',?,'2026-10-26')", `${id}-${suffix}`, id, `${id}-shot`, kind, filename, file, `${id}-model`)
  }
  const request = { model_id: `${id}-model`, shot_id: `${id}-shot`, prompt: '带笑望向老陈，背景静止。', prompt_body: '带笑望向老陈，背景静止。',
    duration: 4, ratio: '16:9', resolution: '480p', mode: 'reference', generate_audio: true, draft: false, seed: 314,
    reference_asset_ids: [`${id}-ref2`, `${id}-ref1`], video_reference_usages: [{ asset_id: `${id}-ref2`, usage: 'identity' }],
    storyboard_reference_asset_id: `${id}-ref1`, project_style_version: 'style-fixture' }
  run("INSERT INTO jobs(id,project_id,shot_id,model_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,?,?,'generation',?,'succeeded',?,'2026-10-26','2026-10-26')", `${id}-job`, id, `${id}-shot`, `${id}-model`, JSON.stringify(request), `${id}-video`)
  return { id, path, first, second, request, url: `/api/projects/${id}/video-comparisons`, candidate: '带笑望向老陈，无人回应后嘴角收平，右手抬起停住。背景静止。' }
}
async function prepare(state: Awaited<ReturnType<typeof fixture>>) {
  const response = await app.inject({ method: 'POST', url: state.url, payload: { baseline_asset_id: `${state.id}-video`, candidate_prompt: state.candidate } })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('preparation freezes ordered references and parameters without generating or changing selected footage', async () => {
  const state = await fixture(), before = enqueues, result = await prepare(state)
  assert.equal(result.status, 'prepared')
  assert.equal(result.generation_duration_ms, 4000)
  assert.equal(result.edit_duration_ms, 2000)
  assert.equal(result.trim_target_ms, 2000)
  assert.equal(result.seed_locked, true)
  assert.deepEqual(result.parameters.reference_asset_ids, state.request.reference_asset_ids)
  assert.deepEqual(result.changed_fields, ['prompt'])
  assert.equal(enqueues, before)
  assert.equal((required('shots', `${state.id}-shot`) as any).selected_asset_id, `${state.id}-video`)
  assert.equal(one('SELECT * FROM timeline_clips WHERE project_id=?', state.id), undefined)
})

test('starting enqueues the exact baseline with only prompt and editor body changed, and duplicate starts reuse the job', async () => {
  const state = await fixture(), result = await prepare(state), before = enqueues
  const response = await app.inject({ method: 'POST', url: `${state.url}/${result.id}/start`, payload: {} })
  assert.equal(response.statusCode, 200, response.body)
  const started = response.json(), job = required('jobs', started.candidate_job_id) as any
  assert.deepEqual(JSON.parse(job.request), { ...state.request, prompt: state.candidate, prompt_body: state.candidate })
  assert.equal(started.status, 'queued')
  assert.equal((required('shots', `${state.id}-shot`) as any).duration, 2)
  const duplicate = await app.inject({ method: 'POST', url: `${state.url}/${result.id}/start`, payload: {} })
  assert.equal(duplicate.statusCode, 200)
  assert.equal(duplicate.json().candidate_job_id, job.id)
  assert.equal(enqueues, before + 1)
})

test('changed reference bytes invalidate a prepared comparison before any generation', async () => {
  const state = await fixture(), result = await prepare(state), before = enqueues
  await writeFile(state.first, 'changed-reference')
  const response = await app.inject({ method: 'POST', url: `${state.url}/${result.id}/start`, payload: {} })
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /参考图片内容已变化/)
  assert.equal(enqueues, before)
  const listing = await app.inject({ method: 'GET', url: `${state.url}?asset_id=${state.id}-video` })
  assert.equal(listing.json().comparisons[0].stale, true)
})

test('changed model config or story intent invalidates comparison rather than silently switching inputs', async () => {
  const state = await fixture(), result = await prepare(state)
  run('UPDATE models SET settings=? WHERE id=?', JSON.stringify({ min_duration: 5 }), `${state.id}-model`)
  run("UPDATE shots SET video_prompt='修改后的剧情与对白' WHERE id=?", `${state.id}-shot`)
  const response = await app.inject({ method: 'POST', url: `${state.url}/${result.id}/start`, payload: {} })
  assert.equal(response.statusCode, 409)
  assert.match(response.body, /模型或提供商配置已变化/)
  assert.match(response.body, /镜头剧情、状态或剪辑时长已变化/)
})

test('cross-project and unchanged baselines are rejected', async () => {
  const first = await fixture(), second = await fixture()
  const foreign = await app.inject({ method: 'POST', url: first.url, payload: { baseline_asset_id: `${second.id}-video`, candidate_prompt: first.candidate } })
  assert.equal(foreign.statusCode, 422)
  const unchanged = await app.inject({ method: 'POST', url: first.url, payload: { baseline_asset_id: `${first.id}-video`, candidate_prompt: first.request.prompt } })
  assert.equal(unchanged.statusCode, 422)
  assert.match(unchanged.body, /与基准相同/)
})

test('generation and edit durations remain separate, including source shortfalls', () => {
  assert.deepEqual(videoDurationPlan(4, 2), { generation_ms: 4000, edit_ms: 2000, trim_target_ms: 2000, needs_trim: true, shortfall_ms: 0 })
  assert.deepEqual(videoDurationPlan(4, 6), { generation_ms: 4000, edit_ms: 6000, trim_target_ms: 4000, needs_trim: false, shortfall_ms: 2000 })
})
