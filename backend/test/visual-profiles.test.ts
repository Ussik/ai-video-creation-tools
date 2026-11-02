import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import sharp from 'sharp'
import Fastify from 'fastify'
import { rightApiImageSettings } from '../src/infrastructure/providers/rightapi-image-settings.js'
import { visualGenerationPrompt, type PromptVisualBinding } from '@video-studio/shared/visuals/visual-prompt'
import { stripManagedPromptBlocks } from '@video-studio/shared/visuals/prompt-document'
import { visualBoardPromptParts } from '@video-studio/shared/visuals/visual-board-document'

const testData = await mkdtemp(join(tmpdir(), 'visual-profiles-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { registerVisualProfileRoutes } = await import('../src/modules/visuals/visual-profiles.js')
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

test('source-backed setting boards need no boilerplate body and retain a primary-only document on submission', async () => {
  const { project, profile } = await setup(), supported = await model()
  assert.equal(stripManagedPromptBlocks(profile.board_prompt), '')
  assert.equal(visualBoardPromptParts(profile.board_prompt).primary.length, 1)
  assert.doesNotMatch(profile.board_prompt, /按照已保存的视觉设定与视图要求/)
  const defaults = await call<{ prompt: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, { model_id: supported.id })
  assert.equal(stripManagedPromptBlocks(defaults.prompt), '')
  assert.match(defaults.prompt, /黑色齐耳短发、深绿雨衣/)

  const primary = '【设定图固定要求】\n只画创作者修改后的蓝色网针，正侧两视图。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n画风：创作者水墨。\n【项目画风约束结束】'
  const prompt = `${primary}\n\n${style}`
  const input = { model_id: supported.id, expected_revision: profile.revision, prompt_override: prompt, prompt_document: true }
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  assert.equal(preview.prompt, prompt)
  assert.doesNotMatch(preview.prompt, /深绿雨衣/)
  const generated = await call<{ job: { request: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, { ...input,
    prompt, reference_signature: preview.reference_signature, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null })
  assert.equal(JSON.parse(generated.job.request).prompt, prompt)
  assert.equal(one<{ definition: string }>('SELECT definition FROM visual_profiles WHERE id=?', profile.id)?.definition, profile.definition)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', project.id).length, 0)
})

test('a full setting document without creative content is rejected without restoring saved profile requirements', async () => {
  const { project, profile } = await setup(), supported = await model()
  const url = `/api/visual-profiles/${profile.id}/board-preview`
  for (const prompt of [undefined,
    '【项目画风约束】\n画风：水墨。\n【项目画风约束结束】',
    '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】',
    '【设定图固定要求】\n\n【设定图固定要求结束】',
    '【基础身份参考】\n只使用已选身份图。\n【基础身份参考结束】',
  ]) {
    const response = await app.inject({ method: 'POST', url, payload: { model_id: supported.id, prompt_document: true,
      ...(prompt === undefined ? {} : { prompt_override: prompt }) } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /请输入设定图内容或补充要求/)
  }
  const bodyOnly = await call<{ prompt: string }>('POST', url, { model_id: supported.id, prompt_document: true,
    prompt_override: '只画创作者的蓝色网针，保持空白背景。' })
  assert.equal(bodyOnly.prompt, '只画创作者的蓝色网针，保持空白背景。')
  const sectionOnlyAppend = await app.inject({ method: 'POST', url, payload: { model_id: supported.id, prompt_document: true,
    prompt_append: '【项目画风约束】\n画风：水墨。\n【项目画风约束结束】' } })
  assert.equal(sectionOnlyAppend.statusCode, 422, sectionOnlyAppend.body)
  const legacyAppend = await app.inject({ method: 'POST', url, payload: { model_id: supported.id, prompt_document: true,
    prompt_append: '旧稿中缓存的三视图要求。' } })
  assert.equal(legacyAppend.statusCode, 422, 'an absent full document cannot fall back to a legacy supplement')
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 0)
})
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
  const unconfigured = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: { ...input, model_id: unsupported.id } })
  assert.equal(unconfigured.statusCode, 422)
  assert.match(unconfigured.body, /本地请求模板未配置参考图字段/)
  assert.doesNotMatch(unconfigured.body, /关键帧承接/)
  const single = await model(true, true)
  image(project.id, 'manual-reference')
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: { ...input, model_id: single.id, reference_asset_ids: ['manual-reference'] } })).statusCode, 422)
  const video = await model(true, false, true)
  const keyframe = await call<{ reference_asset_ids: string[]; prompt: string }>('POST', `/api/projects/${project.id}/generate/preview`, { ...input, model_id: video.id, mode: 'first_frame', visual_reference_mode: 'keyframe', reference_asset_ids: ['manual-reference'] })
  assert.deepEqual(keyframe.reference_asset_ids, ['manual-reference']); assert.match(keyframe.prompt, /黑色齐耳短发/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('RightAPI shot generation sends three confirmed boards and recovers persisted image tasks through restart and retry without another POST', async t => {
  run("DELETE FROM jobs WHERE status='queued'")
  const { project, scene, draft, profile } = await setup()
  const profiles = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { ...draft, kind: 'location', name: '仓库' }, { ...draft, kind: 'prop', name: '铜钥匙' },
  ] })
  const png = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#46765e' } }).png().toBuffer()
  const boardPath = join(testData, 'rightapi-boards.png')
  await writeFile(boardPath, png)
  for (const item of profiles.visual_profiles) {
    const assetId = `rightapi-board-${item.id}`
    image(project.id, assetId)
    run('UPDATE assets SET path=? WHERE id=?', boardPath, assetId)
    await call('PATCH', `/api/visual-profiles/${item.id}`, { expected_revision: 1, board_asset_id: assetId })
  }
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: 'RightAPI 测试', base_url: 'https://www.right.codes/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: 'gpt-image-2.5', remote_id: 'gpt-image-2.5', modality: 'image', protocol: 'image_generations', settings: rightApiImageSettings() })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '带三份视觉设定的镜头', source_scene_id: scene.id })
  const preview = await call<{ prompt: string; mode: string; ratio: string; reference_asset_ids: string[] }>('POST', `/api/projects/${project.id}/generate/preview`, { shot_id: shot.id, model_id: model.id, prompt: '阿宁在仓库拿起钥匙', ratio: '9:16' })
  assert.equal(preview.reference_asset_ids.length, 3)
  assert.ok(preview.reference_asset_ids.includes(`rightapi-board-${profile.id}`))
  assert.equal(preview.mode, 'reference')
  const bodies: Record<string, unknown>[] = []
  const queries: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (init.method === 'POST') {
      assert.equal(String(url), 'https://www.rightapi.ai/draw/v1/images/generations')
      bodies.push(JSON.parse(String(init.body)))
      return Response.json({ task_id: 'task_rightapi_e2e', status: 'processing' })
    }
    assert.equal(init.method, 'GET')
    queries.push(String(url))
    assert.ok(one('SELECT 1 FROM jobs WHERE project_id=? AND external_id=?', project.id, String(url).split('/').at(-1)), 'task ID is already saved')
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  })
  async function finished(jobId: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const job = one<{ status: string; result_asset_id: string; error: string }>('SELECT status, result_asset_id, error FROM jobs WHERE id=?', jobId)!
      if (job.status === 'failed') assert.fail(job.error)
      if (job.status === 'succeeded') return job
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('mock RightAPI task did not complete')
  }
  let stop: (() => void) | undefined
  try {
    const job = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, preview)
    stop = startWorker()
    await finished(job.id)
    stop(); stop = undefined
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0]!.size, '9:16')
    assert.equal(bodies[0]!.async, true)
    assert.deepEqual(bodies[0]!.image, Array(3).fill(`data:image/png;base64,${png.toString('base64')}`))
    assert.ok(String(bodies[0]!.prompt).includes(draft.definition))

    const restarted = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, preview)
    run("UPDATE jobs SET status='running', external_id='task_restart' WHERE id=?", restarted.id)
    initDb()
    assert.equal(one<{ status: string }>('SELECT status FROM jobs WHERE id=?', restarted.id)?.status, 'queued')
    stop = startWorker()
    await finished(restarted.id)
    stop(); stop = undefined

    const retryJob = await call<{ id: string }>('POST', `/api/projects/${project.id}/generate`, preview)
    run("UPDATE jobs SET status='failed', external_id='task_retry', error='query connection interrupted' WHERE id=?", retryJob.id)
    const detail = await call<{ jobs: Array<{ id: string; task_resume_available: boolean }> }>('GET', `/api/projects/${project.id}`)
    assert.equal(detail.jobs.find(item => item.id === retryJob.id)?.task_resume_available, true)
    assert.equal((await app.inject({ method: 'POST', url: `/api/jobs/${retryJob.id}/retry`, payload: { prompt: '新的要求' } })).statusCode, 422)
    await call('POST', `/api/jobs/${retryJob.id}/retry`)
    stop = startWorker()
    await finished(retryJob.id)
    stop(); stop = undefined
    assert.equal(bodies.length, 1, 'restart/retry only query existing task IDs')
    assert.deepEqual(queries, ['https://www.rightapi.ai/v1/tasks/task_rightapi_e2e', 'https://www.rightapi.ai/v1/tasks/task_restart', 'https://www.rightapi.ai/v1/tasks/task_retry'])
  } finally { stop?.() }
})

test('confirmed boards fill unresolved snapshots and followers automatically advance after confirmation', async () => {
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
  assert.equal(data.shot_visual_bindings[0]?.revision, 2)
  assert.equal(data.shot_visual_bindings[0]?.board_asset_id, 'snapshot-new')
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

test('editable final prompts stay identical through preview and queue, while keyframes need no confirmed information board', async () => {
  const { project, scene } = await setup()
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '拿起钥匙', source_scene_id: scene.id })
  const video = await model(true, false, true)
  image(project.id, 'final-pinned-frame')
  const detail = await call<{ shot_visual_bindings: PromptVisualBinding[] }>('GET', `/api/projects/${project.id}`)
  const template = visualGenerationPrompt('连续动作\n\n【视频生成要求】\n视频时长：5 秒\n首帧要求：承接参考图', detail.shot_visual_bindings, ['final-pinned-frame'], 'keyframe', { mode: 'first_frame' })
  const edited = template.replace('连续动作', '阿宁停顿后拿起钥匙，镜头缓慢推近').replace('深绿雨衣', '雨衣保留湿润的深绿色')
  const input = { shot_id: shot.id, model_id: video.id, mode: 'first_frame', visual_reference_mode: 'keyframe', ratio: 'adaptive',
    prompt: edited, prompt_is_final: true, prompt_template: template, visual_source_prompt: '连续动作', reference_asset_ids: ['final-pinned-frame'] }
  const preview = await call<{ prompt: string; prompt_template: string; reference_asset_ids: string[] }>('POST', `/api/projects/${project.id}/generate/preview`, input)
  assert.equal(preview.prompt, edited)
  assert.equal(preview.prompt_template, template)
  assert.deepEqual(preview.reference_asset_ids, ['final-pinned-frame'])
  assert.equal((preview.prompt.match(/【镜头视觉设定】/g) || []).length, 1)
  const job = await call<{ request: string }>('POST', `/api/projects/${project.id}/generate`, preview)
  assert.equal(JSON.parse(job.request).prompt, edited)
  assert.equal(JSON.parse(job.request).shot_id, shot.id)
  for (const references of [[], ['final-pinned-frame', 'final-pinned-frame']]) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: { ...input, reference_asset_ids: references } })).statusCode, 422)
  }
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [] })
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate`, payload: preview })).statusCode, 409)
  run('DELETE FROM jobs WHERE project_id=?', project.id)
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
    assert.equal(response.statusCode, 200); assert.deepEqual(response.json().profiles, [draft])
    assert.deepEqual(response.json().skills, []); assert.deepEqual(response.json().loaded_files, [])
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
  assert.deepEqual((await call<{ reference_asset_ids: string[] }>('POST', url, { ...input, reference_asset_ids: preview.reference_asset_ids })).reference_asset_ids,
    preview.reference_asset_ids, 'profile and asset selections resolve to one copy of the same image')
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
  assert.match(result.body, /本地请求模板未配置参考图字段/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
})

test('profile candidate counts enqueue exactly one, two or four jobs atomically without extra shots or approval', async () => {
  const supported = await model()
  for (const count of [undefined, 2, 4]) {
    const { project, profile } = await setup()
    const input = { model_id: supported.id, expected_revision: profile.revision }
    const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
    const payload = { ...input, prompt: preview.prompt, reference_signature: preview.reference_signature, ratio: '9:16', resolution: null, clarity: '2K', quality: 'standard', background: 'auto', ...(count ? { candidate_count: count } : {}) }
    const response = await call<{ job: { id: string }; jobs: Array<{ id: string; request: string }>; task: { id: string; generation_job_id: string; status: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, payload)
    assert.equal(response.jobs.length, count || 1)
    assert.equal(response.job.id, response.jobs.at(-1)?.id)
    assert.equal(response.task.generation_job_id, response.job.id)
    assert.equal(response.task.status, 'generating')
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, count || 1)
    assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 1)
    assert.equal(all('SELECT * FROM shots WHERE project_id=?', project.id).length, 0)
    for (const job of response.jobs) {
      const request = JSON.parse(job.request)
      assert.equal(request.visual_profile_id, profile.id)
      assert.equal(request.asset_task_id, response.task.id)
      assert.equal(request.prompt, preview.prompt)
      assert.equal(request.ratio, '9:16')
      assert.equal(request.clarity, '2K')
      assert.equal(request.quality, 'standard')
      assert.equal(request.background, 'auto')
    }
    assert.equal(new Set(response.jobs.map(job => JSON.parse(job.request).asset_task_batch_id)).size, 1)
    assert.equal((await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/generate`, payload })).statusCode, 422, 'a repeated click cannot enqueue another batch')
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, count || 1)
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/visual-profiles/${profile.id}`, payload: { expected_revision: 1, definition: 'cannot change during a batch' } })).statusCode, 422)
    assert.equal(one<{ board_asset_id: string | null }>('SELECT board_asset_id FROM visual_profiles WHERE id=?', profile.id)?.board_asset_id, null)
    run('DELETE FROM jobs WHERE project_id=?', project.id)
    await call('DELETE', `/api/projects/${project.id}`)
  }
  const { project, profile } = await setup()
  const input = { model_id: supported.id, expected_revision: profile.revision }
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  for (const count of [0, 3, 5, 2.5]) {
    const result = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/generate`, payload: { ...input, prompt: preview.prompt, reference_signature: preview.reference_signature, ratio: '9:16', resolution: null, clarity: '2K', quality: 'standard', background: 'auto', candidate_count: count } })
    assert.equal(result.statusCode, 422)
  }
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 0)
})

test('profile batches stay generating until all candidates finish, retain successes and preserve the approved board', async t => {
  run("DELETE FROM jobs WHERE status='queued'")
  const { project, profile } = await setup()
  image(project.id, 'batch-approved')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'batch-approved' })
  const supported = await model()
  const png = await sharp({ create: { width: 18, height: 32, channels: 3, background: '#46765e' } }).png().toBuffer()
  let calls = 0, allFail = false
  let releaseLast: (() => void) | undefined
  const lastGate = new Promise<void>(resolve => { releaseLast = resolve })
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 4) await lastGate
    if (allFail || calls === 1) return Response.json({ error: { message: 'isolated candidate failure' } }, { status: 400 })
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  })
  const input = { model_id: supported.id, expected_revision: 1 }
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  const payload = { ...input, prompt: preview.prompt, reference_signature: preview.reference_signature, ratio: '9:16', resolution: null, clarity: '2K', quality: 'standard', background: 'auto', candidate_count: 4 }
  const batch = await call<{ jobs: Array<{ id: string }>; task: { id: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, payload)
  async function until(condition: () => boolean) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail('isolated batch did not reach the expected state')
  }
  let stop: (() => void) | undefined
  try {
    stop = startWorker()
    await until(() => calls === 4)
    const active = await call<{ status: string }>('GET', `/api/asset-tasks/${batch.task.id}`)
    assert.equal(active.status, 'generating', 'partial success/failure must not unlock the profile')
    assert.equal((await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/generate`, payload })).statusCode, 422)
    releaseLast!()
    await until(() => all<{ status: string }>('SELECT status FROM jobs WHERE project_id=?', project.id).every(job => ['failed', 'succeeded'].includes(job.status)))
    stop(); stop = undefined
    const ready = await call<{ status: string; result_asset_id: string; generation_job_id: string }>('GET', `/api/asset-tasks/${batch.task.id}`)
    assert.equal(ready.status, 'ready')
    const successes = all<{ id: string; result_asset_id: string }>("SELECT id, result_asset_id FROM jobs WHERE project_id=? AND status='succeeded'", project.id)
    assert.equal(successes.length, 3)
    assert.ok(successes.some(job => job.id === ready.generation_job_id && job.result_asset_id === ready.result_asset_id))
    const detail = await call<{ assets: Array<{ id: string }>; jobs: Array<{ id: string }>; visual_profiles: Profile[] }>('GET', `/api/projects/${project.id}`)
    assert.ok(successes.every(job => detail.assets.some(asset => asset.id === job.result_asset_id)))
    assert.ok(batch.jobs.every(job => detail.jobs.some(item => item.id === job.id)))
    assert.equal(detail.visual_profiles[0]?.board_asset_id, 'batch-approved')
    assert.equal(calls, 4)

    allFail = true
    const failedBatch = await call<{ task: { id: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, { ...payload, candidate_count: 2 })
    stop = startWorker()
    await until(() => one<{ status: string }>('SELECT status FROM asset_tasks WHERE id=?', failedBatch.task.id)?.status === 'failed')
    stop(); stop = undefined
    assert.equal(calls, 6)
    assert.equal(one<{ board_asset_id: string }>('SELECT board_asset_id FROM visual_profiles WHERE id=?', profile.id)?.board_asset_id, 'batch-approved')
  } finally { releaseLast!(); stop?.() }
})

test('profile canvas identity persists without shots; duplicate and foreign profiles are rejected', async () => {
  const { project, profile } = await setup()
  const other = await setup()
  const graph = await call<{ revision: string; nodes: unknown[]; edges: unknown[] }>('GET', `/api/projects/${project.id}/canvas`)
  const node = { id: 'profile-node', type: 'generation', x: 0, y: 0, width: 440, height: 420,
    settings: { modality: 'image', visual_profile_id: profile.id, visual_profile_revision: 1 } }
  const saved = await call<typeof graph>('PUT', `/api/projects/${project.id}/canvas`, { ...graph, nodes: [node] })
  const duplicate = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: { ...saved, nodes: [node, { ...node, id: 'duplicate' }] } })
  assert.equal(duplicate.statusCode, 422)
  const foreign = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: { ...saved, nodes: [{ ...node, settings: { ...node.settings, visual_profile_id: other.profile.id } }] } })
  assert.equal(foreign.statusCode, 422)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', project.id).length, 0)
  await call('PUT', `/api/projects/${project.id}/canvas`, { ...saved, nodes: [] })
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', project.id).length, 1)
})

test('candidate archive persists independently of canvas nodes and protects the approved board', async () => {
  const { project, profile } = await setup()
  image(project.id, 'archive-old')
  image(project.id, 'archive-approved')
  image(project.id, 'unrelated-candidate')
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'archive-old' })
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, board_asset_id: 'archive-approved' })
  const endpoint = (assetId: string) => `/api/visual-profiles/${profile.id}/candidates/${assetId}`
  assert.equal((await app.inject({ method: 'PUT', url: endpoint('archive-approved'), payload: { archived: true } })).statusCode, 422)
  assert.equal((await app.inject({ method: 'PUT', url: endpoint('unrelated-candidate'), payload: { archived: true } })).statusCode, 422)
  const archived = await call<{ revision: number; candidate_asset_ids: string[]; archived_candidate_asset_ids: string[] }>('PUT', endpoint('archive-old'), { archived: true })
  assert.equal(archived.revision, 2)
  assert.deepEqual(archived.archived_candidate_asset_ids, ['archive-old'])
  assert.equal(archived.candidate_asset_ids.length, 2)
  initDb()
  const reloaded = await call<{ visual_profiles: typeof archived[] }>('GET', `/api/projects/${project.id}/visual-profiles`)
  assert.deepEqual(reloaded.visual_profiles[0].archived_candidate_asset_ids, ['archive-old'])
  assert.equal(all('SELECT * FROM assets WHERE project_id=?', project.id).length, 3)
  assert.equal(all('SELECT * FROM canvas_nodes WHERE project_id=?', project.id).length, 0)
  const restored = await call<typeof archived>('PUT', endpoint('archive-old'), { archived: false })
  assert.deepEqual(restored.archived_candidate_asset_ids, [])
  await call('PUT', endpoint('archive-old'), { archived: true })
  const confirmed = await call<typeof archived>('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 2, board_asset_id: 'archive-old' })
  assert.deepEqual(confirmed.archived_candidate_asset_ids, [])
})

test('atomic board submission validates reference signatures and creates only one asset task and no shot', async () => {
  const { project, profile } = await setup()
  const imageModel = await model()
  const input = { model_id: imageModel.id, expected_revision: 1, prompt_append: '增加围裙细节' }
  const preview = await call<{ prompt: string; reference_signature: string }>('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
  const submission = { ...input, reference_signature: preview.reference_signature, prompt: preview.prompt, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null }
  const stale = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/generate`, payload: { ...submission, prompt_append: '已变化' } })
  assert.equal(stale.statusCode, 409)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 0)
  const created = await call<{ job: { id: string; shot_id: string | null; request: string } }>('POST', `/api/visual-profiles/${profile.id}/generate`, submission)
  assert.equal(created.job.shot_id, null)
  assert.equal(JSON.parse(created.job.request).visual_profile_id, profile.id)
  const repeat = await app.inject({ method: 'POST', url: `/api/visual-profiles/${profile.id}/generate`, payload: submission })
  assert.equal(repeat.statusCode, 422)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 1)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id).length, 1)
  assert.equal(all('SELECT * FROM shots WHERE project_id=?', project.id).length, 0)
  image(project.id, 'previous-definition-candidate')
  run("UPDATE jobs SET status='succeeded', result_asset_id=? WHERE id=?", 'previous-definition-candidate', created.job.id)
  run("UPDATE asset_tasks SET status='ready' WHERE project_id=?", project.id)
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, definition: profile.definition + '增加蓝色袖口。' })
  const oldCandidate = await call<{ archived_candidate_asset_ids: string[] }>('PUT', `/api/visual-profiles/${profile.id}/candidates/previous-definition-candidate`, { archived: true })
  assert.deepEqual(oldCandidate.archived_candidate_asset_ids, ['previous-definition-candidate'])
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
    const relatedJob = await call<{ job: { id: string } }>('POST', `/api/visual-profiles/${relatedProfile.id}/generate`, {
      ...boardInput, reference_signature: relatedPreview.reference_signature, prompt: relatedPreview.prompt,
      ratio: '16:9', resolution: null, quality: null, clarity: null, background: null,
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
