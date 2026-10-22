import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'video-reference-usages-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, now, all } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'POST' | 'PUT' | 'PATCH' | 'GET', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await call('POST', '/api/projects', { name: '逐图用途' })
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '先走后坐', video_prompt: '开场站立，走向窗边，结尾坐下。固定机位。' })
  const provider = await call('POST', '/api/providers', { name: '隔离测试', base_url: 'https://example.invalid', adapter: 'http' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '多图视频', remote_id: 'mock', modality: 'video', protocol: 'async_video',
    settings: { create_path: '/video', get_path: '/video/{id}', supported_modes: ['reference', 'first_frame'], request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
  const ids = ['storyboard', 'character'].map(id => `${project.id}-${id}`)
  for (const id of ids) run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image','ref.png','/tmp/ref.png','upload',?)", id, project.id, now())
  const { visual_profiles: [profile] } = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ kind: 'character', name: '林晚', definition: '短发蓝衣', view_requirements: '正侧面' }] })
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: ids[1] })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true }] })
  return { project, shot, model, ids, input: { shot_id: shot.id, model_id: model.id, mode: 'reference', prompt: shot.video_prompt,
    storyboard_reference_asset_id: ids[0], reference_asset_ids: [ids[0]], video_reference_usages: [{ asset_id: ids[0], usage: 'ending' }, { asset_id: ids[1], usage: 'identity' }] } }
}

test('purposes on automatic profile images survive preview, canvas save and queued request without changing old jobs', async () => {
  const { project, shot, model, ids, input } = await fixture()
  const url = `/api/projects/${project.id}/generate`
  const prepared = await call('POST', `${url}/preview`, input)
  assert.deepEqual(prepared.reference_asset_ids, ids)
  assert.deepEqual(prepared.video_reference_usages, input.video_reference_usages)
  assert.match(prepared.prompt, /图片1：分镜构图.*结尾构图.*不提前作为开场/)
  assert.match(prepared.prompt, /图片2：林晚.*只参考对应人物的身份/)
  assert.match(prepared.prompt, /开场站立，走向窗边，结尾坐下/)
  const graphUrl = `/api/projects/${project.id}/canvas`, base = await call('GET', graphUrl)
  await call('PUT', graphUrl, { ...base, nodes: [{ id: 'video-node', type: 'generation', x: 0, y: 0, width: 320, height: 240,
    title: '视频', text: '', prompt: shot.video_prompt, asset_id: null, job_id: null, shot_id: shot.id, model_id: model.id,
    settings: { modality: 'video', mode: 'reference', video_reference_usages: input.video_reference_usages } }], edges: [] })
  assert.deepEqual((await call('GET', graphUrl)).nodes[0].settings.video_reference_usages, input.video_reference_usages)
  await call('POST', url, { ...prepared, prompt_is_final: true })
  const [job] = all<{ id: string; request: string }>('SELECT * FROM jobs WHERE project_id=?', project.id)
  assert.deepEqual(JSON.parse(job!.request).video_reference_usages, input.video_reference_usages)
  assert.deepEqual(JSON.parse(job!.request).reference_asset_ids, ids)
  assert.equal(JSON.parse(job!.request).prompt, prepared.prompt)
  const before = job!.request
  await call('POST', `${url}/preview`, { ...input, video_reference_usages: [{ asset_id: ids[0], usage: 'composition' }] })
  assert.equal(all<{ request: string }>('SELECT request FROM jobs WHERE id=?', job!.id)[0]!.request, before)
})

test('invalid, duplicate, unsubmitted and strict-frame uses fail before creating any job', async () => {
  const { project, ids, input } = await fixture(), url = `/api/projects/${project.id}/generate`
  for (const change of [
    { video_reference_usages: [{ asset_id: ids[0], usage: 'ending' }, { asset_id: ids[0], usage: 'opening' }] },
    { video_reference_usages: [{ asset_id: 'foreign-or-disconnected', usage: 'scale' }] },
    { video_reference_usages: [{ asset_id: ids[0], usage: 'unsupported' }] },
    { mode: 'first_frame', visual_reference_mode: 'keyframe', video_reference_usages: [{ asset_id: ids[0], usage: 'ending' }] },
  ]) {
    const response = await app.inject({ method: 'POST', url, payload: { ...input, ...change } })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  const reviewed = await call('POST', `${url}/preview`, input)
  const stale = await app.inject({ method: 'POST', url, payload: { ...reviewed, video_reference_usages: [{ asset_id: ids[0], usage: 'opening' }] } })
  assert.equal(stale.statusCode, 409, stale.body)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('explicit image removal clears its use while disconnected selections cannot disappear through overrides', async () => {
  const { project, ids, input } = await fixture(), url = `/api/projects/${project.id}/generate/preview`
  const removed = await call('POST', url, { ...input, prompt_reference_overrides: { [ids[0]!]: null } })
  assert.deepEqual(removed.reference_asset_ids, [ids[1]])
  assert.deepEqual(removed.video_reference_usages, [{ asset_id: ids[1], usage: 'identity' }])
  const invalid = await app.inject({ method: 'POST', url, payload: { ...input,
    video_reference_usages: [{ asset_id: 'unsubmitted', usage: 'scale' }], prompt_reference_overrides: { unsubmitted: null } } })
  assert.equal(invalid.statusCode, 422, invalid.body)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})
