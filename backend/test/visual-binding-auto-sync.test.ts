import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'visual-binding-auto-sync-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { prepareVisualGeneration } = await import('../src/modules/visuals/visual-profiles.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<any> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function image(projectId: string) {
  const id = crypto.randomUUID()
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'reference.png', '/tmp/reference.png', 'upload', ?)", id, projectId, now())
  return id
}
async function setup() {
  const project = await call('POST', '/api/projects', { name: '自动跟随引用' })
  const data = await call('POST', `/api/projects/${project.id}/visual-profiles`, { profiles: [
    { kind: 'prop', name: '钥匙', variant: '默认', definition: '旧版铜钥匙', view_requirements: '展示材质' },
  ] })
  const profile = data.visual_profiles[0], style = data.project_visual_style.version, board = image(project.id)
  const url = `/api/visual-profiles/${profile.id}`
  await call('PATCH', url, { expected_revision: 1, expected_style_version: style, board_asset_id: board })
  const provider = await call('POST', '/api/providers', { name: '隔离测试', adapter: 'http', base_url: 'https://reference.invalid' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '隔离模型', remote_id: 'test', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/images', image_base64_path: 'data.0.b64_json', request_template: { prompt: '{{prompt}}', images: '{{images}}' } } })
  return { project, profile, style, board, url, model }
}
async function shot(state: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) {
  const value = await call('POST', `/api/projects/${state.project.id}/shots`, { title: '钥匙特写', image_prompt: '人工正文：手持钥匙特写' })
  await call('PUT', `/api/shots/${value.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: false, usage: 'image', ...extra }] })
  return value
}
const raw = (shotId: string) => one<any>('SELECT * FROM shot_visual_bindings WHERE shot_id=?', shotId)!
async function binding(state: Awaited<ReturnType<typeof setup>>, shotId: string) {
  const data = await call('GET', `/api/projects/${state.project.id}`)
  return data.shot_visual_bindings.find((value: { shot_id: string }) => value.shot_id === shotId)
}
async function revise(state: Awaited<ReturnType<typeof setup>>) {
  await call('PATCH', state.url, { expected_revision: 1, definition: '新版银钥匙' })
  const board = image(state.project.id)
  return { board, confirm: () => call('PATCH', state.url, { expected_revision: 2, expected_style_version: state.style, board_asset_id: board }) }
}
async function reference(state: Awaited<ReturnType<typeof setup>>, status: 'candidate' | 'confirmed' = 'confirmed') {
  const assetId = image(state.project.id)
  const value = await call('POST', `${state.url}/reference-assets`, { expected_revision: 1, expected_style_version: state.style,
    asset_id: assetId, view: 'detail', purpose: 'detail', status, is_default: status === 'confirmed' })
  return value.reference_assets.find((item: { asset_id: string }) => item.asset_id === assetId)
}

test('confirmed boards update active followers while drafts, locked shots and history retain their snapshots', async () => {
  const state = await setup(), active = await shot(state), locked = await shot(state, { sync_mode: 'locked' }), historical = await shot(state)
  const designId = crypto.randomUUID()
  run("INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,'历史后继','[]',?)", designId, state.project.id, now())
  run('UPDATE shots SET superseded_by=? WHERE id=?', designId, historical.id)
  const oldLocked = raw(locked.id), oldHistorical = raw(historical.id), next = await revise(state)
  assert.equal(raw(active.id).board_asset_id, state.board)
  assert.equal((await binding(state, active.id)).sync_status, 'waiting_confirmation')
  await next.confirm()
  const current = await binding(state, active.id)
  assert.equal(current.revision, 2)
  assert.equal(current.board_asset_id, next.board)
  assert.equal(current.definition, '新版银钥匙')
  assert.equal(current.sync_mode, 'follow')
  assert.equal(current.reference_selection, 'auto')
  assert.equal(current.sync_status, 'current')
  assert.equal(current.required, false)
  assert.equal(current.usage, 'image')
  assert.equal(one<any>('SELECT image_prompt FROM shots WHERE id=?', active.id)?.image_prompt, '人工正文：手持钥匙特写')
  assert.deepEqual(raw(locked.id), oldLocked)
  assert.deepEqual(raw(historical.id), oldHistorical)
})

test('automatic references follow confirmed defaults; candidates never replace references and manual selections retain order', async () => {
  const state = await setup(), auto = await shot(state), first = await reference(state)
  assert.deepEqual((await binding(state, auto.id)).reference_assets.map((value: { id: string }) => value.id), [first.id])
  const manual = await shot(state, { reference_asset_ids: [first.id] }), manualSnapshot = raw(manual.id)
  const candidate = await reference(state, 'candidate')
  assert.ok(!(await binding(state, auto.id)).reference_assets.some((value: { id: string }) => value.id === candidate.id))
  const latest = await reference(state)
  assert.deepEqual((await binding(state, auto.id)).reference_assets.map((value: { id: string }) => value.id), [latest.id])
  assert.deepEqual(raw(manual.id), manualSnapshot)
  assert.equal((await binding(state, manual.id)).reference_selection, 'manual')
})

test('manual images preserve the complete old snapshot across revisions until an explicit restore of automatic matching', async () => {
  const state = await setup(), selected = await reference(state), target = await shot(state, { reference_asset_ids: [selected.id] })
  const previous = raw(target.id), next = await revise(state)
  await next.confirm()
  assert.deepEqual(raw(target.id), previous)
  const waiting = await binding(state, target.id)
  assert.equal(waiting.sync_status, 'manual_review')
  assert.equal(waiting.definition, '旧版铜钥匙')
  await call('PUT', `/api/shots/${target.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: false, sync_mode: 'locked' }] })
  await call('PUT', `/api/shots/${target.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: false, sync_mode: 'follow' }] })
  assert.equal((await binding(state, target.id)).sync_status, 'manual_review')
  const updated = await call('PUT', `/api/shots/${target.id}/visual-bindings`, { bindings: [{ profile_id: state.profile.id, required: false,
    sync_mode: 'follow', reference_selection: 'auto' }], refresh_profile_ids: [state.profile.id] })
  const current = updated.shot_visual_bindings.find((value: { shot_id: string }) => value.shot_id === target.id)
  assert.equal(current.reference_selection, 'auto')
  assert.equal(current.revision, 2)
  assert.equal(current.board_asset_id, next.board)
  assert.deepEqual(current.reference_assets, [])
})

test('preview resolves legacy stale followers without writes, removes their old automatic inputs and rejects old submitted signatures', async () => {
  const state = await setup(), target = await shot(state)
  const input = { shot_id: target.id, model_id: state.model.id, prompt: '人工正文：钥匙特写', reference_asset_ids: [] }
  const oldPreview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, input)
  const old = raw(target.id), next = await revise(state)
  await next.confirm()
  // Simulate a legacy binding missed by prior confirmation, without using the
  // project GET endpoint (which intentionally repairs active followers).
  run(`UPDATE shot_visual_bindings SET revision=?, definition=?, board_asset_id=?, board_style_version=? WHERE shot_id=?`,
    old.revision, old.definition, old.board_asset_id, old.board_style_version, target.id)
  const before = one<{ count: number }>('SELECT total_changes() AS count')!.count
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input, reference_asset_ids: [state.board] })
  assert.equal(raw(target.id).revision, 1)
  assert.equal(one<{ count: number }>('SELECT total_changes() AS count')!.count, before)
  assert.deepEqual(preview.reference_asset_ids, [next.board])
  assert.match(preview.prompt, /新版银钥匙/)
  assert.match(preview.prompt, /人工正文：钥匙特写/)
  assert.equal(all('SELECT id FROM jobs WHERE project_id=?', state.project.id).length, 0)
  const preserved = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input,
    reference_asset_ids: [state.board], explicit_reference_asset_ids: [state.board] })
  assert.deepEqual(preserved.reference_asset_ids, [state.board, next.board])
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${state.project.id}/generate`, payload: oldPreview })).statusCode, 409)
  const model = one<any>('SELECT * FROM models WHERE id=?', state.model.id)!
  prepareVisualGeneration({ ...input, mode: 'reference', reference_asset_ids: preview.reference_asset_ids,
    visual_signature: preview.visual_signature }, model)
  assert.equal(raw(target.id).revision, 2)
})

test('changing an approved source after queueing keeps the job request immutable', async () => {
  const state = await setup(), target = await shot(state)
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { shot_id: target.id, model_id: state.model.id,
    prompt: '人工正文：钥匙特写', reference_asset_ids: [] })
  const queued = await call('POST', `/api/projects/${state.project.id}/generate`, preview)
  const request = one<any>('SELECT request FROM jobs WHERE id=?', queued.id)!.request
  const next = await revise(state)
  await next.confirm()
  assert.equal(raw(target.id).board_asset_id, next.board)
  assert.equal(one<any>('SELECT request FROM jobs WHERE id=?', queued.id)!.request, request)
  assert.deepEqual(JSON.parse(request).reference_asset_ids, [state.board])
  assert.match(JSON.parse(request).prompt, /旧版铜钥匙/)
})

test('a stale client cannot reintroduce historical automatic images after sync, while explicit choices and manual tokens remain usable', async () => {
  const state = await setup(), target = await shot(state), next = await revise(state)
  await next.confirm()
  assert.equal(raw(target.id).board_asset_id, next.board)
  const input = { shot_id: target.id, model_id: state.model.id, prompt: '人工正文：钥匙特写', reference_asset_ids: [state.board] }
  const preview = await call('POST', `/api/projects/${state.project.id}/generate/preview`, input)
  assert.deepEqual(preview.reference_asset_ids, [next.board])
  const explicit = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input, explicit_reference_asset_ids: [state.board] })
  assert.deepEqual(explicit.reference_asset_ids, [state.board, next.board])
  const token = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input, prompt: `保留人工选择 [[ref:${state.board}]]` })
  assert.deepEqual(token.reference_asset_ids, [state.board, next.board])
  const tokenJob = await call('POST', `/api/projects/${state.project.id}/generate`, token)
  assert.deepEqual(JSON.parse(one<any>('SELECT request FROM jobs WHERE id=?', tokenJob.id)!.request).reference_asset_ids, token.reference_asset_ids)
  for (const extra of [{ prompt_document: true }, { prompt_is_final: true },
    { prompt_body: `正文选择 [[ref:${state.board}]]` }]) {
    const prepared = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input,
      prompt: `保留人工选择 [[ref:${state.board}]]`, ...extra })
    assert.deepEqual(prepared.reference_asset_ids, [state.board, next.board])
    assert.deepEqual(prepared.explicit_reference_asset_ids, [state.board])
    const job = await call('POST', `/api/projects/${state.project.id}/generate`, prepared)
    const queued = JSON.parse(one<any>('SELECT request FROM jobs WHERE id=?', job.id)!.request)
    assert.deepEqual(queued.reference_asset_ids, prepared.reference_asset_ids)
    assert.equal(queued.visual_signature, prepared.visual_signature)
    assert.equal(queued.prompt, prepared.prompt)
  }
  const manualId = image(state.project.id)
  const override = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input,
    prompt_reference_overrides: { [state.board]: manualId } })
  assert.deepEqual(override.reference_asset_ids, [manualId, next.board])
  const storyboard = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input, storyboard_reference_asset_id: state.board })
  assert.deepEqual(storyboard.reference_asset_ids, [state.board, next.board])
  for (const prepared of [explicit, override, storyboard]) {
    const job = await call('POST', `/api/projects/${state.project.id}/generate`, prepared)
    const queued = JSON.parse(one<any>('SELECT request FROM jobs WHERE id=?', job.id)!.request)
    assert.deepEqual(queued.reference_asset_ids, prepared.reference_asset_ids)
    assert.equal(queued.visual_signature, prepared.visual_signature)
  }
  const text = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...input, visual_reference_mode: 'text_only' })
  assert.deepEqual(text.reference_asset_ids, [state.board])
  const staleDocument = { ...input, prompt_document: true,
    prompt: `人工正文\n\n【图片参考图用途】\n自动旧图 [[ref:${state.board}]]\n【图片参考图用途结束】` }
  const rejected = await app.inject({ method: 'POST', url: `/api/projects/${state.project.id}/generate/preview`, payload: staleDocument })
  assert.equal(rejected.statusCode, 409)
  assert.match(rejected.body, /刷新画布/)
  const keptDocument = await call('POST', `/api/projects/${state.project.id}/generate/preview`, { ...staleDocument, explicit_reference_asset_ids: [state.board] })
  assert.deepEqual(keptDocument.reference_asset_ids, [state.board, next.board])
})

test('independent references cannot bypass a changed base board on a derived profile', async () => {
  const state = await setup()
  const created = await call('POST', `/api/projects/${state.project.id}/visual-profiles`, { profiles: [{ kind: 'prop', name: '钥匙', variant: '破损',
    definition: '破损铜钥匙', view_requirements: '展示破口', base_profile_id: state.profile.id, state_delta: '钥匙末端折断' }] })
  const profile = created.visual_profiles.find((value: { variant: string }) => value.variant === '破损')
  const derived = { ...state, profile, url: `/api/visual-profiles/${profile.id}` }
  await call('PATCH', derived.url, { expected_revision: 1, expected_style_version: state.style, board_asset_id: image(state.project.id) })
  await reference(derived)
  const target = await shot(derived), previous = raw(target.id)
  await call('PATCH', state.url, { expected_revision: 1, expected_style_version: state.style, board_asset_id: image(state.project.id) })
  // A newly confirmed/default independent image still cannot certify which
  // base revision the derived board was built from.
  await reference(derived)
  assert.deepEqual(raw(target.id), previous)
  assert.equal((await binding(derived, target.id)).sync_status, 'waiting_confirmation')
  assert.deepEqual(raw(target.id), previous)
})
