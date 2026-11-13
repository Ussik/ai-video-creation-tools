import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import sharp from 'sharp'

const directory = await mkdtemp(join(tmpdir(), 'visual-state-inheritance-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, initDb, now, one, required, run } = await import('../src/infrastructure/database/db.js')
const { autoConfirmGeneratedProfileBoard, registerVisualProfileRoutes } = await import('../src/modules/visuals/visual-profiles.js')
const { generate } = await import('../src/infrastructure/providers/providers.js')
type Profile = { id: string; name: string; variant: string; revision: number; base_profile_id: string | null; state_delta: string;
  identity_profile_id: string; base_reference_status: string; board_asset_id: string | null }
type Visuals = { visual_profiles: Profile[]; shot_visual_bindings: Array<{ profile_id: string }> }
type Preview = { mode: string; prompt: string; reference_asset_ids: string[]; reference_signature: string; base_reference_signature: string;
  reference_sources: Array<{ asset_id: string; role: string }> }
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, status, response.body)
  return response.json() as T
}
const draft = (variant: string, extra: object = {}) => ({ kind: 'character', name: '姜望', variant,
  definition: '短发、深绿补网装、身材清瘦；身份和服装特征固定。', view_requirements: '正侧背及右手背细节', scene_ids: [], ...extra })
async function setup() {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '角色状态继承' })
  const result = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    draft('右手背溅泥', { draft_key: 'mud', base_draft_key: 'clean', state_delta: '仅右手背增加少量泥点。' }),
    draft('渡口补网装', { draft_key: 'clean' }),
    draft('同名但未建立身份关系'),
  ] })
  return { id: project.id, base: result.visual_profiles.find(profile => profile.variant === '渡口补网装')!,
    state: result.visual_profiles.find(profile => profile.variant === '右手背溅泥')!, independent: result.visual_profiles.find(profile => profile.variant === '同名但未建立身份关系')! }
}
function asset(projectId: string, id: string) {
  run(`INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', ?, '/tmp/unused-board.png', 'upload', ?)`, id, projectId, `${id}.png`, now())
}
async function confirm(profile: Profile, id: string, projectId: string) {
  asset(projectId, id)
  return call<Profile>('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, board_asset_id: id })
}
async function model(video = false) {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '隔离模型', base_url: 'https://example.invalid' })
  return call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '参考图模型', remote_id: video ? 'video' : 'image', modality: video ? 'video' : 'image', protocol: video ? 'async_video' : 'image_generations',
    settings: { ...(video ? { create_path: '/videos', get_path: '/videos/{id}', supported_modes: ['text', 'reference', 'first_frame'] } : { request_path: '/images', image_base64_path: 'data.0.b64_json' }),
      request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
}

test('forward draft keys persist explicit identity without guessing from the same name, including after reinitialization', async () => {
  const { id, base, state, independent } = await setup()
  assert.equal(state.base_profile_id, base.id)
  assert.equal(state.identity_profile_id, base.id)
  assert.equal(base.identity_profile_id, base.id)
  assert.equal(independent.base_profile_id, null)
  assert.equal(independent.identity_profile_id, independent.id)
  assert.equal(state.base_reference_status, 'waiting')
  assert.equal((state as unknown as Record<string, unknown>).draft_key, undefined)
  initDb()
  assert.equal((await call<Visuals>('GET', `/api/projects/${id}`)).visual_profiles.find(profile => profile.id === state.id)?.base_profile_id, base.id)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('missing bases block text fallback; confirmed base and manual images are transmitted once with precise state constraints', async () => {
  const { id, base, state } = await setup(), supported = await model()
  const input = { model_id: supported.id, expected_revision: state.revision }
  const missing = await call<{ detail: string }>('POST', `/api/visual-profiles/${state.id}/board-preview`, input, 422)
  assert.match(missing.detail, /等待基础设定图/)
  assert.equal(all('SELECT * FROM asset_tasks WHERE project_id=?', id).length, 0)
  await confirm(base, 'base-actual-image', id)
  asset(id, 'manual-extra-image')
  const preview = await call<Preview>('POST', `/api/visual-profiles/${state.id}/board-preview`, {
    ...input, reference_profile_ids: [base.id], reference_asset_ids: ['base-actual-image', 'manual-extra-image'], prompt_override: '检查过的自定义状态提示词',
  })
  assert.equal(preview.mode, 'reference')
  assert.deepEqual(preview.reference_asset_ids, ['base-actual-image', 'manual-extra-image'])
  assert.deepEqual(preview.reference_sources.map(source => source.role), ['base', 'manual'])
  assert.match(preview.prompt, /只修改以下明确差异：仅右手背增加少量泥点/)
  assert.match(preview.prompt, /不扩展到全身/)
  assert.match(preview.prompt, /检查过的自定义状态提示词/)
  const queued = await call<{ job: { request: string } }>('POST', `/api/visual-profiles/${state.id}/generate`, {
    ...input, reference_asset_ids: ['manual-extra-image'], prompt_override: '检查过的自定义状态提示词',
    prompt: preview.prompt, reference_signature: (await call<Preview>('POST', `/api/visual-profiles/${state.id}/board-preview`, {
      ...input, reference_asset_ids: ['manual-extra-image'], prompt_override: '检查过的自定义状态提示词',
    })).reference_signature, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null,
  })
  assert.deepEqual(JSON.parse(queued.job.request).reference_asset_ids, ['base-actual-image', 'manual-extra-image'])
  assert.equal(JSON.parse(queued.job.request).visual_base_signature, preview.base_reference_signature)
})

test('relation cycles, missing temporary keys, foreign projects and mismatched kinds are rejected atomically', async () => {
  const { id, base, state } = await setup()
  const count = all('SELECT id FROM visual_profiles WHERE project_id=?', id).length
  for (const profiles of [
    [draft('环1', { draft_key: 'a', base_draft_key: 'b', state_delta: '变化1' }), draft('环2', { draft_key: 'b', base_draft_key: 'a', state_delta: '变化2' })],
    [draft('丢失基础', { base_draft_key: 'missing', state_delta: '变化' })],
    [draft('道具派生', { kind: 'prop', base_profile_id: base.id, state_delta: '变化' })],
    [draft('无变化说明', { base_profile_id: base.id })],
  ]) {
    await call('POST', `/api/projects/${id}/visual-profiles`, { profiles }, 422)
    assert.equal(all('SELECT id FROM visual_profiles WHERE project_id=?', id).length, count)
  }
  const foreign = await setup()
  await call('POST', `/api/projects/${id}/visual-profiles`, { profiles: [draft('外部来源', { base_profile_id: foreign.base.id, state_delta: '变化' })] }, 422)
  await call('PATCH', `/api/visual-profiles/${base.id}`, { expected_revision: base.revision, base_profile_id: state.id, state_delta: '反向修改' }, 422)
  await call('DELETE', `/api/visual-profiles/${base.id}`, undefined, 422)
  await call('DELETE', `/api/projects/${id}`)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('descendant images cannot feed the base backwards while unrelated manual inputs and prior own images stay available', async () => {
  const { id, base, state, independent } = await setup(), supported = await model()
  await confirm(base, 'reverse-base', id)
  await confirm(state, 'reverse-child', id)
  await confirm(independent, 'unrelated-manual', id)
  for (const references of [{ reference_profile_ids: [state.id] }, { reference_asset_ids: ['reverse-child'] }]) {
    const response = await call<{ detail: string }>('POST', `/api/visual-profiles/${base.id}/board-preview`, { model_id: supported.id, ...references }, 422)
    assert.match(response.detail, /反向生成基础设定/)
  }
  const preview = await call<Preview>('POST', `/api/visual-profiles/${base.id}/board-preview`, { model_id: supported.id, reference_asset_ids: ['reverse-base', 'unrelated-manual'] })
  assert.deepEqual(preview.reference_asset_ids, ['reverse-base', 'unrelated-manual'])
})

test('changing a base invalidates preview and prevents stale candidate auto-confirmation without deleting historical outputs', async () => {
  const { id, base, state } = await setup(), supported = await model()
  await confirm(base, 'old-base', id)
  const input = { model_id: supported.id, expected_revision: state.revision }
  const preview = await call<Preview>('POST', `/api/visual-profiles/${state.id}/board-preview`, input)
  const queued = await call<{ job: { id: string }; task: { id: string } }>('POST', `/api/visual-profiles/${state.id}/generate`, {
    ...input, prompt: preview.prompt, reference_signature: preview.reference_signature, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null,
  })
  asset(id, 'old-derived-result')
  run("UPDATE jobs SET status='succeeded', result_asset_id='old-derived-result' WHERE id=?", queued.job.id)
  run("UPDATE asset_tasks SET status='ready' WHERE id=?", queued.task.id)
  await confirm(base, 'new-base', id)
  await call('POST', `/api/visual-profiles/${state.id}/board-task`, { ...input, reference_signature: preview.reference_signature }, 409)
  autoConfirmGeneratedProfileBoard(required('jobs', queued.job.id))
  assert.equal(one<{ board_asset_id: string | null }>('SELECT board_asset_id FROM visual_profiles WHERE id=?', state.id)?.board_asset_id, null)
  await call('PATCH', `/api/visual-profiles/${state.id}`, { expected_revision: state.revision, board_asset_id: 'old-derived-result' }, 422)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?', 'old-derived-result'))
})

test('script canvas commit includes base dependencies without adding them as duplicate shot references', async () => {
  const { id, base } = await setup()
  const scene = await call<{ id: string }>('POST', `/api/projects/${id}/script/scenes`, { heading: '渡口', characters: '姜望', action: '右手背又出现一道擦伤' })
  const checked = await call<{ signature: string; scene_ids: string[] }>('POST', `/api/projects/${id}/script/canvas/check`, { scene_ids: [scene.id] })
  const result = await call<Visuals>('POST', `/api/projects/${id}/script/canvas/commit`, { signature: checked.signature, scene_ids: checked.scene_ids, profiles: [draft('右手背擦伤', {
    base_profile_id: base.id, state_delta: '仅右手背增加一道浅擦伤', scene_ids: [scene.id],
  })], coverage_version: 1, visual_coverage: [{ scene_id: scene.id, shot_id: null, source_excerpt: '右手背又出现一道擦伤',
    objects: [{ kind: 'character', name: '姜望', variant: '右手背擦伤', usage: 'both', requires_profile: true, reason: '姜望手背的局部状态需要与基础外貌保持一致。' }], no_reference_reason: '' }] })
  assert.ok(result.visual_profiles.some(profile => profile.id === base.id))
  assert.equal(result.shot_visual_bindings.length, 1)
  assert.notEqual(result.shot_visual_bindings[0]!.profile_id, base.id)
})

test('analysis emits reviewable relations and refuses invalid links without saving profiles', async () => {
  const { id, base } = await setup()
  const scene = await call<{ id: string }>('POST', `/api/projects/${id}/script/scenes`, { heading: '渡口', characters: '姜望' })
  const isolated = Fastify()
  let output = { profiles: [draft('分析出的状态', { draft_key: 'state', base_profile_id: base.id, state_delta: '仅右手背溅泥', scene_ids: [scene.id] })] }
  registerVisualProfileRoutes(isolated, { script: () => ({ outline: '', characters: '', scenes: [required('script_scenes', scene.id)] }),
    generateText: async (_projectId, _modelId, prompt) => { assert.match(prompt, /不能只写相同名称/); return JSON.stringify(output) } })
  try {
    const before = all('SELECT * FROM visual_profiles WHERE project_id=?', id).length
    const result = await isolated.inject({ method: 'POST', url: `/api/projects/${id}/visual-profiles/analyze`, payload: { model_id: 'mock', scene_ids: [scene.id] } })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().profiles[0].base_profile_id, base.id)
    output = { profiles: [draft('错误关系', { draft_key: 'self', base_draft_key: 'self', state_delta: '变化', scene_ids: [scene.id] })] }
    assert.equal((await isolated.inject({ method: 'POST', url: `/api/projects/${id}/visual-profiles/analyze`, payload: { model_id: 'mock', scene_ids: [scene.id] } })).statusCode, 422)
    assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', id).length, before)
  } finally { await isolated.close() }
})

test('board prompt image tokens add real assets and override manual sources while protecting the inherited base', async () => {
  const { id, base, state } = await setup(), supported = await model()
  await confirm(base, 'token-base', id)
  for (const image of ['token-old', 'token-new', 'token-extra']) asset(id, image)
  const input = { model_id: supported.id, reference_asset_ids: ['token-old'],
    prompt_override: '保留[[ref:token-base]]的人物，配色参考[[ref:token-old]]，纹理参考[[ref:token-extra]]',
    prompt_reference_overrides: { 'token-old': 'token-new' } }
  const preview = await call<Preview>('POST', `/api/visual-profiles/${state.id}/board-preview`, input)
  assert.deepEqual(preview.reference_asset_ids, ['token-base', 'token-new', 'token-extra'])
  assert.match(preview.prompt, /保留参考图 1的人物，配色参考参考图 2，纹理参考参考图 3/)
  assert.doesNotMatch(preview.prompt, /\[\[ref:/)
  for (const replacement of [null, 'token-new']) {
    await call('POST', `/api/visual-profiles/${state.id}/board-preview`, {
      ...input, prompt_reference_overrides: { 'token-base': replacement },
    }, 422)
  }
  const foreign = await setup()
  asset(foreign.id, 'token-foreign')
  await call('POST', `/api/visual-profiles/${state.id}/board-preview`, { ...input, prompt_override: '参考[[ref:token-foreign]]' }, 422)
})

test('shot prompt replacements update actual assets and reference numbering without reintroducing old automatic images', async () => {
  const { id, base } = await setup(), supported = await model()
  const scene = await call<{ id: string }>('POST', `/api/projects/${id}/script/scenes`, { heading: '渡口', characters: '姜望' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${id}/shots`, { title: '正面', source_scene_id: scene.id })
  await confirm(base, 'shot-old', id)
  await call('POST', `/api/projects/${id}/visual-profiles`, { profiles: [draft('渡口补网装', { scene_ids: [scene.id],
    shot_usage: [{ shot_id: shot.id, usage: 'both' }] })] })
  asset(id, 'shot-new'); asset(id, 'shot-extra')
  const input = { shot_id: shot.id, model_id: supported.id, prompt: '人物使用[[ref:shot-old]]；道具纹理参考[[ref:shot-extra]]',
    prompt_reference_overrides: { 'shot-old': 'shot-new' } }
  const preview = await call<Preview>('POST', `/api/projects/${id}/generate/preview`, input)
  assert.deepEqual(preview.reference_asset_ids, ['shot-new', 'shot-extra'])
  assert.match(preview.prompt, /人物使用参考图 1/)
  assert.match(preview.prompt, /道具纹理参考参考图 2/)
  assert.match(preview.prompt, /姜望（渡口补网装，版本 1）；参考图 1/)
  const queued = await call<{ request: string }>('POST', `/api/projects/${id}/generate`, preview)
  assert.deepEqual(JSON.parse(queued.request).reference_asset_ids, ['shot-new', 'shot-extra'])
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
  const removed = await call<Preview>('POST', `/api/projects/${id}/generate/preview`, {
    ...input, prompt_reference_overrides: { 'shot-old': null },
  })
  assert.deepEqual(removed.reference_asset_ids, ['shot-extra'])
  assert.match(removed.prompt, /道具纹理参考参考图 1/)
  assert.doesNotMatch(removed.prompt, /渡口补网装，版本 1）；参考图/)
})

test('video replacement remaps identities, storyboard usage and numbers through canonical preview submission', async () => {
  const { id, base } = await setup(), supported = await model(true)
  const scene = await call<{ id: string }>('POST', `/api/projects/${id}/script/scenes`, { heading: '渡口' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${id}/shots`, { title: '过渡', source_scene_id: scene.id })
  await confirm(base, 'video-old', id)
  await call('POST', `/api/projects/${id}/visual-profiles`, { profiles: [draft('渡口补网装', { scene_ids: [scene.id],
    shot_usage: [{ shot_id: shot.id, usage: 'both' }] })] })
  asset(id, 'video-new'); asset(id, 'video-detail')
  const preview = await call<Preview & { storyboard_reference_asset_id: string; video_reference_usages: unknown[] }>('POST', `/api/projects/${id}/generate/preview`, {
    shot_id: shot.id, model_id: supported.id, mode: 'reference', prompt: '人物身份参考[[ref:video-old]]，右手细节参考[[ref:video-detail]]',
    reference_asset_ids: ['video-old'], storyboard_reference_asset_id: 'video-old',
    video_reference_usages: [{ asset_id: 'video-old', usage: 'identity' }], prompt_reference_overrides: { 'video-old': 'video-new' },
  })
  assert.deepEqual(preview.reference_asset_ids, ['video-new', 'video-detail'])
  assert.equal(preview.storyboard_reference_asset_id, 'video-new')
  assert.deepEqual(preview.video_reference_usages, [{ asset_id: 'video-new', usage: 'identity' }])
  assert.match(preview.prompt, /人物身份参考图片 1/)
  assert.match(preview.prompt, /图片1：分镜构图 \/ 姜望/)
  assert.match(preview.prompt, /图片2：手动参考/)
  const queued = await call<{ request: string }>('POST', `/api/projects/${id}/generate`, preview)
  assert.deepEqual(JSON.parse(queued.request).reference_asset_ids, preview.reference_asset_ids)
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
})

test('provider payload contains replacement file bytes rather than the old image or a textual token', async t => {
  const { id } = await setup(), supported = await model()
  asset(id, 'bytes-old'); asset(id, 'bytes-new')
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#98523c' } }).png().toBuffer()
  const path = join(directory, 'replacement.png')
  await writeFile(path, png)
  run('UPDATE assets SET path=? WHERE id=?', path, 'bytes-new')
  const preview = await call<Preview>('POST', `/api/projects/${id}/generate/preview`, { model_id: supported.id,
    source_artifact_type: 'character', prompt: '精确保留[[ref:bytes-old]]的人物', reference_asset_ids: ['bytes-old'], prompt_reference_overrides: { 'bytes-old': 'bytes-new' } })
  const queued = await call<{ request: string }>('POST', `/api/projects/${id}/generate`, preview)
  const payloads: Array<{ prompt: string; images: string[] }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body)))
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  })
  const savedModel = required<import('../src/infrastructure/database/db.js').Model>('models', supported.id)
  const request = JSON.parse(queued.request)
  await generate(savedModel, required('providers', savedModel.provider_id), request,
    request.reference_asset_ids.map((assetId: string) => required('assets', assetId)), id, () => {})
  assert.equal(payloads.length, 1)
  assert.deepEqual(payloads[0]!.images, [`data:image/png;base64,${png.toString('base64')}`])
  assert.match(payloads[0]!.prompt, /精确保留参考图 1的人物/)
  assert.doesNotMatch(payloads[0]!.prompt, /\[\[ref:/)
})

test('preview and enqueue preserve legacy reference identity when an earlier image is removed', async () => {
  const { id } = await setup(), supported = await model()
  for (const image of ['legacy-unused', 'legacy-hero', 'legacy-texture']) asset(id, image)
  const preview = await call<Preview>('POST', `/api/projects/${id}/generate/preview`, { model_id: supported.id,
    source_artifact_type: 'character', prompt: '人物身份参考图2，服装纹理参考图3。',
    reference_asset_ids: ['legacy-unused', 'legacy-hero', 'legacy-texture'], prompt_reference_overrides: { 'legacy-unused': null } })
  assert.deepEqual(preview.reference_asset_ids, ['legacy-hero', 'legacy-texture'])
  assert.match(preview.prompt, /人物身份参考图 1，服装纹理参考图 2/)
  const queued = await call<{ request: string }>('POST', `/api/projects/${id}/generate`, preview)
  assert.equal(JSON.parse(queued.request).prompt, preview.prompt)
  assert.deepEqual(JSON.parse(queued.request).reference_asset_ids, preview.reference_asset_ids)
})

test('missing or foreign token assets block preview before any job is queued', async () => {
  const { id } = await setup(), supported = await model(), foreign = await setup()
  asset(foreign.id, 'foreign-token-image')
  const before = all('SELECT * FROM jobs WHERE project_id=?', id).length
  const input = { model_id: supported.id, source_artifact_type: 'character' }
  const missing = await app.inject({ method: 'POST', url: `/api/projects/${id}/generate/preview`,
    payload: { ...input, prompt: '人物[[ref:missing-token-image]]' } })
  assert.equal(missing.statusCode, 404, missing.body)
  await call('POST', `/api/projects/${id}/generate/preview`, { ...input, prompt: '人物[[ref:foreign-token-image]]' }, 422)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', id).length, before)
})
