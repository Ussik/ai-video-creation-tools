import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import type { VisualReferenceAsset, VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'

const testData = await mkdtemp(join(tmpdir(), 'visual-reference-assets-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp, startWorker } = await import('../src/app.js')
const { all, db, mediaDir, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
type Profile = { id: string; revision: number; board_asset_id: string | null; asset_task_id: string | null; reference_assets: VisualReferenceAsset[] }
type Binding = { shot_id: string; profile_id: string; revision: number; board_asset_id: string | null; board_style_version: string | null; reference_assets: VisualReferenceSnapshot[] }
type Visuals = { project_visual_style: { version: string }; visual_profiles: Profile[]; shot_visual_bindings: Binding[] }
async function call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
async function image(projectId: string, width = 400, height = 600) {
  const id = crypto.randomUUID(), path = join(mediaDir, `${id}.png`)
  await sharp({ create: { width, height, channels: 3, background: '#446655' } }).png().toFile(path)
  run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,?,'upload',?)", id, projectId, `${id}.png`, path, now())
  return id
}
async function setup(kind: 'character' | 'location' | 'prop' = 'character', board = true) {
  const project = await call('POST', '/api/projects', { name: '独立视角参考' })
  const data = await call<Visuals>('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind, name: '林晚', variant: '雨衣', definition: '黑发，绿色雨衣，银色纽扣', view_requirements: '固定外形与空间关系' },
  ] })
  const profile = data.visual_profiles[0]!, style = data.project_visual_style.version
  const boardId = board ? await image(project.id) : null
  if (boardId) await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: 1, expected_style_version: style, board_asset_id: boardId })
  const provider = await call('POST', '/api/providers', { name: '参考测试', adapter: 'http', base_url: 'https://reference.invalid' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '图片测试', remote_id: 'test', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/images', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
  const base = { expected_revision: 1, expected_style_version: style }
  return { project, profile, kind, style, boardId, model, base, url: `/api/visual-profiles/${profile.id}` }
}
async function register(state: Awaited<ReturnType<typeof setup>>, view: VisualReferenceAsset['view'], isDefault = false, confirmed = true) {
  const assetId = await image(state.project.id)
  const profile = await call<Profile>('POST', `${state.url}/reference-assets`, { ...state.base, asset_id: assetId, view,
    purpose: view === 'face' ? 'identity' : state.kind === 'character' ? 'costume' : state.kind === 'location' ? 'space' : 'structure', status: confirmed ? 'confirmed' : 'candidate', is_default: isDefault })
  return profile.reference_assets.find(item => item.asset_id === assetId)!
}

test('registration enforces ownership/version and confirmation/default state without changing board or revision', async () => {
  const state = await setup(), foreign = await setup(), assetId = await image(state.project.id)
  const payload = { ...state.base, asset_id: assetId, view: 'front', purpose: 'costume' }
  for (const input of [{ ...payload, is_default: true }, { ...payload, expected_revision: 2 }, { ...payload, expected_style_version: 'a'.repeat(64) },
    { ...payload, asset_id: await image(foreign.project.id) }]) {
    const response = await app.inject({ method: 'POST', url: `${state.url}/reference-assets`, payload: input })
    assert.ok([409, 422].includes(response.statusCode), response.body)
  }
  const candidate = await call<Profile>('POST', `${state.url}/reference-assets`, payload)
  assert.equal(candidate.reference_assets[0]?.status, 'candidate')
  assert.equal(candidate.board_asset_id, state.boardId)
  assert.equal(candidate.revision, 1)
  const reference = candidate.reference_assets[0]!
  const confirmed = await call<Profile>('PATCH', `${state.url}/reference-assets/${reference.id}`, { ...state.base, status: 'confirmed', is_default: true })
  assert.equal(confirmed.reference_assets[0]?.is_default, true)
  const second = await register(state, 'front', true)
  const reloaded = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.equal(reloaded.visual_profiles[0]?.reference_assets.find(item => item.id === reference.id)?.is_default, false)
  assert.equal(reloaded.visual_profiles[0]?.reference_assets.find(item => item.id === second.id)?.is_default, true)
  assert.equal((await app.inject({ method: 'PATCH', url: `${foreign.url}/reference-assets/${reference.id}`, payload: foreign.base })).statusCode, 422)
})

test('shot selection uses the described angle, preserves explicit order and stays frozen across defaults/definitions', async () => {
  const state = await setup(), face = await register(state, 'face'), side = await register(state, 'side', true)
  const shot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '侧面', prompt: '林晚侧面站在门口', image_prompt: '人物侧面中景' })
  let data = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true }] })
  let binding = data.shot_visual_bindings.find(item => item.shot_id === shot.id)!
  assert.deepEqual(new Set(binding.reference_assets.map(item => item.id)), new Set([side.id, face.id]))
  data = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [face.id, side.id] }] })
  binding = data.shot_visual_bindings.find(item => item.shot_id === shot.id)!
  assert.deepEqual(binding.reference_assets.map(item => item.id), [face.id, side.id])
  const previewInput = { shot_id: shot.id, model_id: state.model.id, prompt: '人物侧面站在门口', reference_asset_ids: [] }
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, previewInput)
  assert.deepEqual(preview.reference_asset_ids, [face.asset_id, side.asset_id])
  assert.match(preview.prompt, /面部特写|侧面/)
  await call('PATCH', `${state.url}/reference-assets/${face.id}`, { ...state.base, status: 'archived' })
  await register(state, 'side', true)
  await call('PATCH', state.url, { expected_revision: 1, definition: '黑发，蓝色雨衣，新设定' })
  data = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: false }] })
  binding = data.shot_visual_bindings.find(item => item.shot_id === shot.id)!
  assert.equal(binding.revision, 1)
  assert.deepEqual(binding.reference_assets.map(item => item.id), [face.id, side.id])
  const frozen = await call('POST', `/api/projects/${state.project.id}/generate/preview`, previewInput)
  assert.deepEqual(frozen.reference_asset_ids, preview.reference_asset_ids)
  assert.match(frozen.prompt, /绿色雨衣/)
  const cleared = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [] }] })
  assert.deepEqual(cleared.shot_visual_bindings.find(item => item.shot_id === shot.id)?.reference_assets, [])
  assert.deepEqual((await call('POST', `/api/projects/${state.project.id}/generate/preview`, previewInput)).reference_asset_ids, [state.boardId])
  assert.equal((await app.inject({ method: 'PUT', url: `/api/shots/${shot.id}/visual-bindings`, payload: { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [side.id] }], refresh_profile_ids: [state.profile.id] } })).statusCode, 409)
})

test('confirming references fills only unresolved exact-version bindings and never replaces an existing board', async () => {
  const state = await setup('character', false), legacy = await setup()
  const create = async (target: typeof state) => {
    const shot = await call('POST', `/api/projects/${target.project.id}/shots`, { title: '正面', image_prompt: '人物正面中景' })
    await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: target.profile.id, required: true }] })
    return shot
  }
  const unresolved = await create(state), old = await create(legacy)
  const reference = await register(state, 'front', true), legacyReference = await register(legacy, 'front', true)
  const data = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.deepEqual(data.shot_visual_bindings.find(item => item.shot_id === unresolved.id)?.reference_assets.map(item => item.id), [reference.id])
  const oldData = await call<Visuals>('GET', `/api/projects/${legacy.project.id}`)
  assert.deepEqual(oldData.shot_visual_bindings.find(item => item.shot_id === old.id)?.reference_assets, [])
  assert.ok(legacyReference.id)
})

test('candidate/foreign selections reject atomically and changed snapshots or project styles invalidate submitted previews', async () => {
  const state = await setup(), foreign = await setup(), face = await register(state, 'face', true), side = await register(state, 'side', true)
  const candidate = await register(state, 'front', false, false), unrelated = await register(foreign, 'face', true)
  const shot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '侧面', image_prompt: '人物侧面' })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [face.id, side.id] }] })
  const input = { shot_id: shot.id, model_id: state.model.id, prompt: '人物站在门边', reference_asset_ids: [] }
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, input)
  for (const ids of [[candidate.id], [unrelated.id], [face.id, face.id]]) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/shots/${shot.id}/visual-bindings`, payload: { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: ids }] } })).statusCode, 422)
  }
  assert.deepEqual((await call<Visuals>('GET', `/api/projects/${state.project.id}`)).shot_visual_bindings[0]?.reference_assets.map(item => item.id), [face.id, side.id])
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [side.id] }] })
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${state.project.id}/generate`, payload: preview })).statusCode, 409)
  await call('PUT', `/api/projects/${state.project.id}/script`, { outline: '故事', characters: '', generation_options: { visual_style: '二维水彩' } })
  const stale = await app.inject({ method: 'POST', url: `/api/projects/${state.project.id}/generate/preview`, payload: input })
  assert.equal(stale.statusCode, 422)
  assert.match(stale.body, /画风已更新/)
  const current = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.equal((await app.inject({ method: 'PATCH', url: `${state.url}/reference-assets/${side.id}`, payload: { ...state.base, expected_style_version: current.project_visual_style.version, status: 'confirmed' } })).statusCode, 409)
  const repeated = await app.inject({ method: 'POST', url: `${state.url}/reference-assets`, payload: { ...state.base,
    expected_style_version: current.project_visual_style.version, asset_id: side.asset_id, view: side.view, purpose: side.purpose } })
  assert.equal(repeated.statusCode, 409)
  assert.match(repeated.body, /旧画风/)
  const unchanged = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.equal(unchanged.visual_profiles.find(profile => profile.id === state.profile.id)?.reference_assets.find(reference => reference.id === side.id)?.style_version, side.style_version)
})

test('an archived reference already frozen on a shot can be retained while adding a new confirmed view without replacing its metadata', async () => {
  const state = await setup('character', false), face = await register(state, 'face', true)
  const shot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '特写', image_prompt: '人物面部特写' })
  const initial = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [face.id] }] })
  const frozen = initial.shot_visual_bindings[0]!.reference_assets[0]!
  await call('PATCH', `${state.url}/reference-assets/${face.id}`, { ...state.base, status: 'archived', label: '归档后修改的标签' })
  const repeated = await app.inject({ method: 'POST', url: `${state.url}/reference-assets`, payload: { ...state.base,
    asset_id: face.asset_id, view: face.view, purpose: face.purpose } })
  assert.equal(repeated.statusCode, 409)
  assert.match(repeated.body, /已归档列表/)
  const side = await register(state, 'side', true)
  const saved = await call<Visuals>('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [face.id, side.id] }] })
  assert.deepEqual(saved.shot_visual_bindings[0]!.reference_assets[0], frozen)
  assert.deepEqual(saved.shot_visual_bindings[0]!.reference_assets.map(item => item.id), [face.id, side.id])
  const otherShot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '新镜头', image_prompt: '人物侧面' })
  assert.equal((await app.inject({ method: 'PUT', url: `/api/shots/${otherShot.id}/visual-bindings`, payload: { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [face.id] }] } })).statusCode, 422)
  assert.equal(all('SELECT * FROM shot_visual_bindings WHERE shot_id=?', otherShot.id).length, 0)
})

test('confirming a later board leaves completed independent snapshots untouched and fills only unresolved shots', async () => {
  const state = await setup('character', false), reference = await register(state, 'front', true)
  const frozenShot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '独立图镜头', image_prompt: '人物正面中景' })
  const initial = await call<Visuals>('PUT', `/api/shots/${frozenShot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true }] })
  const frozen = initial.shot_visual_bindings.find(item => item.shot_id === frozenShot.id)!
  assert.equal(frozen.board_asset_id, null)
  assert.deepEqual(frozen.reference_assets.map(item => item.id), [reference.id])
  const unresolvedShot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '待参考镜头', image_prompt: '人物正面中景' })
  await call('PUT', `/api/shots/${unresolvedShot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [] }] })
  await call('PATCH', state.url, { ...state.base, definition_status: 'draft' })
  await call('PATCH', state.url, { expected_revision: 1, definition: '红色雨衣，修订后的草稿定义' })
  const edited = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.deepEqual(edited.shot_visual_bindings.find(item => item.shot_id === frozenShot.id), frozen)
  assert.equal(edited.shot_visual_bindings.find(item => item.shot_id === unresolvedShot.id)?.revision, 2)
  const boardId = await image(state.project.id)
  await call('PATCH', state.url, { ...state.base, expected_revision: 2, board_asset_id: boardId })
  const reloaded = await call<Visuals>('GET', `/api/projects/${state.project.id}`)
  assert.deepEqual(reloaded.shot_visual_bindings.find(item => item.shot_id === frozenShot.id), frozen)
  const unresolved = reloaded.shot_visual_bindings.find(item => item.shot_id === unresolvedShot.id)!
  assert.equal(unresolved.board_asset_id, boardId)
  assert.equal(unresolved.board_style_version, state.style)
  assert.deepEqual(unresolved.reference_assets, [])
})

test('video previews inherit the same selected independent assets and stable numbering as storyboard images', async () => {
  const state = await setup(), face = await register(state, 'face'), side = await register(state, 'side', true)
  const shot = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '侧面', image_prompt: '人物侧面中景' })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: true, reference_asset_ids: [side.id, face.id] }] })
  const provider = one<{ provider_id: string }>('SELECT provider_id FROM models WHERE id=?', state.model.id)!
  const video = await call('POST', '/api/models', { provider_id: provider.provider_id, name: '视频测试', remote_id: 'test-video', modality: 'video', protocol: 'async_video',
    settings: { create_path: '/videos', get_path: '/videos/{id}', supported_modes: ['reference'], request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
  const storyboardId = await image(state.project.id)
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { shot_id: shot.id, model_id: video.id, mode: 'reference',
    prompt: '林晚转身', reference_asset_ids: [storyboardId], storyboard_reference_asset_id: storyboardId })
  assert.deepEqual(preview.reference_asset_ids, [storyboardId, side.asset_id, face.asset_id])
  assert.match(preview.prompt, /图片1：分镜构图/)
  assert.match(preview.prompt, /图片2：.*侧面/)
  assert.match(preview.prompt, /图片3：.*面部特写/)
  assert.ok(!preview.reference_asset_ids.includes(state.boardId))
})

test('crop validates normalized bounds, decoded images and local file ownership; output is a candidate at original pixel scale', async () => {
  const state = await setup(), foreign = await setup(), sourceId = await image(state.project.id, 400, 600)
  const payload = { ...state.base, asset_id: sourceId, view: 'face', purpose: 'identity', crop: { x: .25, y: .25, width: .5, height: .5 } }
  const profile = await call<Profile>('POST', `${state.url}/reference-crop`, payload), reference = profile.reference_assets[0]!
  assert.equal(reference.status, 'candidate')
  assert.equal(reference.source_asset_id, sourceId)
  assert.equal(reference.style_version, state.style)
  const asset = one<{ path: string }>('SELECT path FROM assets WHERE id=?', reference.asset_id)!
  const dimensions = await sharp(asset.path).metadata()
  assert.deepEqual([dimensions.width, dimensions.height], [200, 300])
  for (const input of [{ ...payload, crop: { ...payload.crop, x: .8 } }, { ...payload, crop: { ...payload.crop, width: .0001 } },
    { ...payload, crop: { ...payload.crop, width: -1 } }, { ...payload, asset_id: await image(foreign.project.id) }]) {
    assert.equal((await app.inject({ method: 'POST', url: `${state.url}/reference-crop`, payload: input })).statusCode, 422)
  }
  const invalidId = await image(state.project.id)
  run('UPDATE assets SET path=? WHERE id=?', '/etc/hosts', invalidId)
  assert.equal((await app.inject({ method: 'POST', url: `${state.url}/reference-crop`, payload: { ...payload, asset_id: invalidId } })).statusCode, 422)
  const svgId = await image(state.project.id), svgPath = join(mediaDir, `${svgId}.svg`)
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"></svg>')
  run('UPDATE assets SET path=? WHERE id=?', svgPath, svgId)
  assert.equal((await app.inject({ method: 'POST', url: `${state.url}/reference-crop`, payload: { ...payload, asset_id: svgId } })).statusCode, 422)
})

test('preview is read-only; explicit generation saves edited prompt and independent job metadata, then records late results as candidates', async t => {
  const state = await setup()
  const input = { ...state.base, model_id: state.model.id, view: 'side', purpose: 'costume', reference_asset_ids: [state.boardId] }
  const preview = await call('POST', `${state.url}/reference-preview`, input)
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', state.project.id).length, 0)
  assert.match(preview.prompt, /单视角|禁止多视角拼版/)
  assert.equal((await app.inject({ method: 'POST', url: `${state.url}/reference-generate`, payload: { ...input, reference_signature: 'a'.repeat(64), prompt: preview.prompt, ratio: '3:4' } })).statusCode, 409)
  const batch = await call('POST', `${state.url}/reference-generate`, { ...input, reference_signature: preview.reference_signature, prompt: '创作者编辑：雨衣侧面站姿，银色纽扣清楚', ratio: '3:4', candidate_count: 2 })
  assert.equal(batch.jobs.length, 2)
  const request = JSON.parse(batch.job.request)
  assert.match(request.prompt, /创作者编辑/)
  assert.match(request.prompt, /绿色雨衣/)
  assert.match(request.prompt, /禁止多视角拼版/)
  assert.equal(request.visual_reference_view, 'side')
  assert.equal(request.visual_profile_revision, 1)
  assert.equal(request.project_style_version, state.style)
  assert.equal(request.asset_task_id, undefined)
  assert.equal(all('SELECT id FROM asset_tasks WHERE project_id=?', state.project.id).length, 0)
  await call('PATCH', state.url, { expected_revision: 1, definition: '新的蓝雨衣设定' })
  const imageBytes = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#224477' } }).png().toBuffer()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: imageBytes.toString('base64') }] }))
  const stop = startWorker()
  try {
    for (let attempt = 0; attempt < 100 && one<{ status: string }>('SELECT status FROM jobs WHERE id=?', batch.job.id)?.status !== 'succeeded'; attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(one<{ status: string }>('SELECT status FROM jobs WHERE id=?', batch.job.id)?.status, 'succeeded')
  } finally { stop() }
  const detail = await call<Visuals>('GET', `/api/projects/${state.project.id}`), profile = detail.visual_profiles[0]!
  assert.equal(profile.reference_assets.length, 2)
  assert.ok(profile.reference_assets.every(item => item.status === 'candidate' && item.revision === 1 && item.style_version === state.style))
  assert.equal(profile.board_asset_id, null)
  const reference = profile.reference_assets[0]!
  assert.equal((await app.inject({ method: 'PATCH', url: `${state.url}/reference-assets/${reference.id}`, payload: { ...state.base, expected_revision: 2, status: 'confirmed' } })).statusCode, 409)
  await call('PATCH', `${state.url}/reference-assets/${reference.id}`, { ...state.base, expected_revision: 2, status: 'archived' })
})
