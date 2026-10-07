import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import sharp from 'sharp'
import Fastify from 'fastify'

const testData = await mkdtemp(join(tmpdir(), 'visual-profiles-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/server.js')
const { all, db, initDb, now, run } = await import('../src/db.js')
const { registerVisualProfileRoutes } = await import('../src/visual-profiles.js')
type Profile = { id: string; revision: number; definition: string; board_asset_id: string | null; board_prompt: string; asset_task_id: string | null }
type Binding = { profile_id: string; revision: number; definition: string; board_asset_id: string | null; required: boolean }
type Visuals = { visual_profiles: Profile[]; shot_visual_bindings: Binding[]; scene_visual_bindings: Array<{ scene_id: string; profile_id: string }> }
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function setup() {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '视觉一致性' })
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, { heading: '仓库', characters: '阿宁', action: '阿宁拿起旧铜钥匙' })
  const draft = { kind: 'character', name: '阿宁', variant: '雨衣', definition: '黑色齐耳短发、深绿雨衣、银色扣子，身高一米六八。', view_requirements: '正侧背、四分之三视角，面部与服装细节，颜色材质说明', scene_ids: [scene.id] }
  const data = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [draft] })
  return { project, scene, draft, profile: data.visual_profiles[0]! }
}
function image(projectId: string, id: string) {
  run(`INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'board.png', '/tmp/board.png', 'upload', ?)`, id, projectId, now())
}
async function model(reference = true, single = false, video = false) {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '隔离测试', base_url: 'https://example.invalid', adapter: 'http' })
  return call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '测试', remote_id: 'test', modality: video ? 'video' : 'image', protocol: video ? 'async_video' : 'image_generations', settings: {
    ...(video ? { create_path: '/video', get_path: '/video/{id}', supported_modes: ['text', 'reference', 'first_frame'] } : { request_path: '/image', image_base64_path: 'data.0.b64_json' }),
    request_template: { prompt: '{{prompt}}', ...(reference ? { images: single ? '{{image}}' : '{{images}}' } : {}) },
  } })
}

test('profile reuse, multiview board tasks and scene-to-shot inheritance do not enqueue generation', async () => {
  const { project, scene, draft, profile } = await setup()
  const reused = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ ...draft, definition: '不会覆盖已确认设定' }] })
  assert.equal(reused.visual_profiles.length, 1)
  assert.equal(reused.visual_profiles[0]?.definition, draft.definition)
  assert.match(profile.board_prompt, /正侧背/)
  assert.match(profile.board_prompt, /材质/)
  const task = await call<{ task_id: string }>('POST', `/api/visual-profiles/${profile.id}/board-task`, {})
  assert.deepEqual(await call('POST', `/api/visual-profiles/${profile.id}/board-task`, {}), { ...task, prompt: profile.board_prompt })
  const result = await call<{ shots: Array<{ id: string }> }>('POST', `/api/projects/${project.id}/script/convert-to-shots`, { scene_ids: [scene.id] })
  assert.equal(result.shots.length, 1)
  initDb()
  const detail = await call<Visuals>('GET', `/api/projects/${project.id}`)
  assert.equal(detail.shot_visual_bindings[0]?.definition, draft.definition)
  assert.equal(detail.shot_visual_bindings[0]?.required, true)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  await call('DELETE', `/api/projects/${project.id}`)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', project.id).length, 0)
})

test('missing boards, capability limits and foreign references block generation; explicit text-only can proceed', async () => {
  const { project, scene, profile } = await setup()
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '近景', source_scene_id: scene.id })
  const supported = await model()
  const input = { shot_id: shot.id, model_id: supported.id, prompt: '阿宁转身，单一画面', mode: 'text' }
  const missing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: input })
  assert.equal(missing.statusCode, 422); assert.match(missing.body, /阿宁/)
  const text = await call<{ prompt: string; reference_asset_ids: string[] }>('POST', `/api/projects/${project.id}/generate/preview`, { ...input, visual_reference_mode: 'text_only' })
  assert.match(text.prompt, /黑色齐耳短发/); assert.deepEqual(text.reference_asset_ids, [])
  const other = await call<{ id: string }>('POST', '/api/projects', { name: '外部' })
  image(other.id, 'foreign-board')
  const foreign = await app.inject({ method: 'PATCH', url: `/api/visual-profiles/${profile.id}`, payload: { expected_revision: 1, board_asset_id: 'foreign-board' } })
  assert.equal(foreign.statusCode, 422)
  image(project.id, 'board-one')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'board-one' })
  const unsupported = await model(false)
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: { ...input, model_id: unsupported.id } })).statusCode, 422)
  const single = await model(true, true)
  image(project.id, 'manual-reference')
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: { ...input, model_id: single.id, reference_asset_ids: ['manual-reference'] } })).statusCode, 422)
  const video = await model(true, false, true)
  const keyframe = await call<{ reference_asset_ids: string[]; prompt: string }>('POST', `/api/projects/${project.id}/generate/preview`, { ...input, model_id: video.id, mode: 'first_frame', visual_reference_mode: 'keyframe', reference_asset_ids: ['manual-reference'] })
  assert.deepEqual(keyframe.reference_asset_ids, ['manual-reference']); assert.match(keyframe.prompt, /黑色齐耳短发/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('confirmed boards fill unresolved snapshots; definition/board revisions stay frozen until explicitly refreshed', async () => {
  const { project, scene, profile } = await setup()
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '阿宁近景', source_scene_id: scene.id })
  image(project.id, 'snapshot-old'); image(project.id, 'snapshot-new')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'snapshot-old' })
  const updated = await call<Profile>('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, definition: '白色外套与短发' })
  assert.equal(updated.revision, 2); assert.equal(updated.board_asset_id, null)
  const stale = await app.inject({ method: 'PATCH', url: `/api/visual-profiles/${profile.id}`, payload: { expected_revision: 1, name: '过期修改' } })
  assert.equal(stale.statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/board-task`, payload: { expected_revision: 1 } })).statusCode, 409)
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 2, board_asset_id: 'snapshot-new' })
  let data = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: false }] })
  assert.equal(data.shot_visual_bindings[0]?.revision, 1)
  assert.equal(data.shot_visual_bindings[0]?.board_asset_id, 'snapshot-old')
  data = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true }], refresh_profile_ids: [profile.id] })
  assert.equal(data.shot_visual_bindings[0]?.revision, 2)
  assert.equal(data.shot_visual_bindings[0]?.board_asset_id, 'snapshot-new')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 2, definition: '新的设定文字' })
  const prop = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ kind: 'prop', name: '钥匙', variant: '旧化', definition: '铜制长柄钥匙', view_requirements: '多视角与齿纹细节', scene_ids: [scene.id] }] })
  const inherited = await call<Visuals>('POST', `/api/script-scenes/${scene.id}/visual-bindings/apply-to-shots`, {})
  assert.equal(inherited.shot_visual_bindings.length, 2)
  assert.equal(inherited.shot_visual_bindings.find(binding => binding.profile_id === profile.id)?.revision, 2, 'applying scene dependencies preserves existing snapshots')
  assert.equal(prop.visual_profiles.length, 2)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/visual-profiles/${profile.id}` })).statusCode, 422)
})

test('preview and queued requests match without duplicate context; changed or removed bindings invalidate confirmation', async () => {
  const { project, scene, profile } = await setup()
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '近景', source_scene_id: scene.id })
  const supported = await model()
  image(project.id, 'preview-board')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'preview-board' })
  const preview = await call<{ prompt: string; reference_asset_ids: string[]; visual_signature: string }>('POST', `/api/projects/${project.id}/generate/preview`, { shot_id: shot.id, model_id: supported.id, prompt: '阿宁站在门边', reference_asset_ids: ['preview-board'] })
  assert.deepEqual(preview.reference_asset_ids, ['preview-board'])
  const job = await call<{ request: string }>('POST', `/api/projects/${project.id}/generate`, preview)
  assert.equal(JSON.parse(job.request).prompt, preview.prompt)
  assert.equal((preview.prompt.match(/【镜头视觉设定】/g) || []).length, 1)
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [] })
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: preview })).statusCode, 409)
})

test('model extraction returns editable unsaved drafts and rejects out-of-scope scenes', async () => {
  const { project, scene, draft } = await setup()
  const isolated = Fastify()
  let output = JSON.stringify({ profiles: [draft] })
  registerVisualProfileRoutes(isolated, { script: () => ({ outline: '雨夜', characters: '阿宁', scenes: [{ id: scene.id } as never] }), generateText: async () => output })
  try {
    const payload = { model_id: 'mock', scene_ids: [scene.id] }
    const before = all('SELECT * FROM visual_profiles WHERE project_id=?', project.id).length
    const response = await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/visual-profiles/analyze`, payload })
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { profiles: [draft] })
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', project.id).length, before)
    output = JSON.stringify({ profiles: [{ ...draft, scene_ids: ['foreign-scene'] }] })
    assert.equal((await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/visual-profiles/analyze`, payload })).statusCode, 422)
  } finally { await isolated.close() }
})

test('information boards preview confirmed reference profiles, validate selections and reject changed references before creating tasks', async () => {
  const { project, draft, profile } = await setup()
  const references = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ ...draft, name: '林晚', variant: '夜探旧祠堂' }] })
  const reference = references.visual_profiles.find(item => item.id !== profile.id)!
  const supported = await model()
  const input = { model_id: supported.id, expected_revision: profile.revision, reference_profile_ids: [reference.id] }
  const url = `/api/visual-profiles/${profile.id}/board-preview`
  assert.equal((await app.inject({ method: 'POST', url, payload: input })).statusCode, 422, 'an unconfirmed profile cannot be used as a reference')
  image(project.id, 'linwan-reference-board')
  await call('PATCH', `/api/visual-profiles/${reference.id}`, { expected_revision: 1, board_asset_id: 'linwan-reference-board' })
  const preview = await call<{ prompt: string; mode: string; reference_asset_ids: string[]; reference_names: string[]; reference_signature: string }>('POST', url, input)
  assert.equal(preview.mode, 'reference')
  assert.deepEqual(preview.reference_asset_ids, ['linwan-reference-board'])
  assert.deepEqual(preview.reference_names, ['林晚 · 夜探旧祠堂 · v1'])
  assert.match(preview.prompt, /参考图 1：林晚/)
  assert.match(preview.prompt, /同框、互动或尺度对比/)
  assert.doesNotMatch(preview.prompt, /不要混入其他人物/)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 0)
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, reference_asset_ids: preview.reference_asset_ids } })).statusCode, 422, 'profile and asset selections cannot duplicate the same image')
  const unsupported = await model(false)
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, model_id: unsupported.id } })).statusCode, 422)
  image(project.id, 'extra-reference')
  const single = await model(true, true)
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, model_id: single.id, reference_asset_ids: ['extra-reference'] } })).statusCode, 422)
  const other = await setup()
  image(other.project.id, 'foreign-reference')
  await call('PATCH', `/api/visual-profiles/${other.profile.id}`, { expected_revision: 1, board_asset_id: 'foreign-reference' })
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, reference_profile_ids: [other.profile.id] } })).statusCode, 422)
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...input, reference_profile_ids: [], reference_asset_ids: ['foreign-reference'] } })).statusCode, 422)
  image(project.id, 'linwan-updated-board')
  await call('PATCH', `/api/visual-profiles/${reference.id}`, { expected_revision: 1, board_asset_id: 'linwan-updated-board' })
  const changed = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/board-task`, payload: { ...input, reference_signature: preview.reference_signature } })
  assert.equal(changed.statusCode, 409)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 0)
})

test('asset task generation rejects missing reference mappings without creating a queued job', async () => {
  const { project, profile } = await setup()
  const task = await call<{ task_id: string }>('POST', `/api/visual-profiles/${profile.id}/board-task`, {})
  image(project.id, 'task-reference')
  const unsupported = await model(false)
  const result = await app.inject({ method: 'POST', url: `/api/asset-tasks/${task.task_id}/generate`, payload: { model_id: unsupported.id, mode: 'reference', reference_asset_ids: ['task-reference'] } })
  assert.equal(result.statusCode, 422)
  assert.match(result.body, /尚未配置参考图传递/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('mock provider receives a confirmed multiview board and frozen text when rendering a shot', async () => {
  // Previous tests assert queue contents without running a provider; isolate this worker's inputs.
  run("DELETE FROM jobs WHERE status='queued'")
  const requests: Array<{ prompt: string; images?: string[] }> = []
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#46765e' } }).png().toBuffer()
  const mock = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve))
  let stop: (() => void) | undefined
  try {
    const address = mock.address()
    if (!address || typeof address === 'string') throw new Error('测试服务地址不可用')
    const provider = await call<{ id: string }>('POST', '/api/providers', { name: '本地模拟', base_url: `http://127.0.0.1:${address.port}`, adapter: 'http' })
    const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '模拟绘图', remote_id: 'mock-image', modality: 'image', protocol: 'image_generations', settings: { request_path: '/image', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
    const { project, scene, profile, draft } = await setup()
    const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '单一镜头', source_scene_id: scene.id })
    const task = await call<{ task_id: string }>('POST', `/api/visual-profiles/${profile.id}/board-task`, {})
    const boardJob = await call<{ job: { id: string } }>('POST', `/api/asset-tasks/${task.task_id}/generate`, { model_id: model.id })
    stop = startWorker()
    async function finished(jobId: string) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const rows = all<{ status: string; result_asset_id: string; error: string }>('SELECT status, result_asset_id, error FROM jobs WHERE id=?', jobId)
        if (rows[0]?.status === 'failed') assert.fail(rows[0].error)
        if (rows[0]?.status === 'succeeded') return rows[0].result_asset_id
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('模拟生成超时')
    }
    const boardAssetId = await finished(boardJob.job.id)
    await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: boardAssetId })
    const related = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [{ ...draft, name: '周蕙兰', view_requirements: '正侧背视图，与阿宁同框展示身高关系' }] })
    const relatedProfile = related.visual_profiles.find(item => item.id !== profile.id)!
    const boardInput = { model_id: model.id, expected_revision: 1, reference_profile_ids: [profile.id] }
    const relatedPreview = await call<{ prompt: string; mode: string; reference_asset_ids: string[]; reference_signature: string }>('POST', `/api/visual-profiles/${relatedProfile.id}/board-preview`, boardInput)
    const relatedTask = await call<{ task_id: string; prompt: string }>('POST', `/api/visual-profiles/${relatedProfile.id}/board-task`, { ...boardInput, reference_signature: relatedPreview.reference_signature })
    const relatedJob = await call<{ job: { id: string } }>('POST', `/api/asset-tasks/${relatedTask.task_id}/generate`, {
      model_id: model.id, prompt: relatedTask.prompt, mode: relatedPreview.mode, reference_asset_ids: relatedPreview.reference_asset_ids,
    })
    await finished(relatedJob.job.id)
    const preview = await call('POST', `/api/projects/${project.id}/generate/preview`, { shot_id: shot.id, model_id: model.id, prompt: '阿宁在仓库拿起钥匙，近景' })
    const shotJob = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, preview)
    await finished(shotJob.id)
    assert.equal(requests.length, 3)
    assert.match(requests[0]!.prompt, /视觉设定信息图/)
    assert.equal(requests[1]!.images?.length, 1)
    assert.match(requests[1]!.images![0]!, /^data:image\/png;base64,/)
    assert.match(requests[1]!.prompt, /对象：周蕙兰/)
    assert.match(requests[1]!.prompt, /参考图 1：阿宁/)
    assert.equal(requests[1]!.prompt, relatedPreview.prompt)
    assert.equal(requests[2]!.images?.length, 1)
    assert.ok(requests[2]!.prompt.includes(draft.definition))
    assert.match(requests[2]!.prompt, /不要复制设定板/)
  } finally {
    stop?.()
    mock.closeAllConnections()
    await new Promise<void>(resolve => mock.close(() => resolve()))
  }
})
