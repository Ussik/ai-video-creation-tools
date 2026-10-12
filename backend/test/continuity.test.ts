import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-continuity-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, now, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

interface ContinuityIssue {
  code: string
  severity: 'error' | 'warning'
  shot_id?: string
  related_shot_id?: string
}

interface ContinuityResponse {
  production_range: { start_shot_id: string | null; end_shot_id: string | null }
  shots: Array<{
    shot_id: string
    selected_asset_id: string | null
    review_status: string | null
    has_material: boolean
    material_ready: boolean
    issues: ContinuityIssue[]
  }>
  issues: ContinuityIssue[]
  summary: {
    total_shots: number
    checked_shots: number
    pass_count: number
    warning_count: number
    error_count: number
    status: string
  }
}

function insertImageAsset(id: string, projectId: string, shotId: string, path: string): void {
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, ?, 'image', ?, ?, 'upload', NULL, NULL, NULL, ?)`, id, projectId, shotId, `${id}.png`, path, now())
}

test('continuity checks only the production range and reports material and state risks', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '接镜检查' })
  const scene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '同一角色连续动作', characters: '角色', duration: 10,
  })
  const first = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, {
    title: '起势', duration: 3, source_scene_id: scene.id,
    start_state: '角色在左侧，站立，手持长剑，戴着面具',
    end_state: '角色在左侧，站立，手持长剑，戴着面具',
  })
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, {
    title: '冲突', duration: 2, source_scene_id: scene.id,
    start_state: '角色在右侧，跪地，手持长枪，露出真容',
    end_state: '角色在右侧，跪地，手持长枪，露出真容',
  })
  const third = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, {
    title: '落点', duration: 4, source_scene_id: scene.id,
    start_state: '角色在右侧，站立，手持长枪',
    end_state: '角色在右侧，站立，手持长枪',
  })
  const missing = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '留白', duration: 2 })
  const outside = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '范围外', duration: 2 })

  const imagePath = join(testData, 'continuity.png')
  await writeFile(imagePath, 'test image')
  insertImageAsset('continuity-first', project.id, first.id, imagePath)
  insertImageAsset('continuity-second', project.id, second.id, imagePath)
  insertImageAsset('continuity-third', project.id, third.id, imagePath)
  insertImageAsset('continuity-outside', project.id, outside.id, imagePath)
  await call('PUT', `/api/shots/${first.id}/selection`, { asset_id: 'continuity-first' })
  await call('PUT', `/api/shots/${second.id}/selection`, { asset_id: 'continuity-second' })
  await call('PUT', `/api/shots/${third.id}/selection`, { asset_id: 'continuity-third' })
  await call('PUT', `/api/shots/${outside.id}/selection`, { asset_id: 'continuity-outside' })
  await call('PUT', `/api/shots/${first.id}/assets/continuity-first/review`, { status: 'approved', note: '角色状态稳定' })
  run(`INSERT INTO asset_reviews (shot_id, asset_id, status, note, updated_at) VALUES (?, ?, 'rejected', ?, ?)`,
    third.id, 'continuity-third', '动作落点穿帮', now())
  run('UPDATE timeline_clips SET out_ms=? WHERE shot_id=?', 100, third.id)

  const range = await call<{ start_shot_id: string | null; end_shot_id: string | null }>(
    'PUT', `/api/projects/${project.id}/production-range`, { start_shot_id: first.id, end_shot_id: missing.id })
  assert.deepEqual(range, { start_shot_id: first.id, end_shot_id: missing.id })

  const report = await call<ContinuityResponse>('GET', `/api/projects/${project.id}/continuity`)
  assert.deepEqual(report.production_range, range)
  assert.equal(report.summary.total_shots, 4)
  assert.equal(report.summary.checked_shots, 4)
  assert.equal(report.shots.some(shot => shot.shot_id === outside.id), false)
  assert.equal(report.shots.find(shot => shot.shot_id === first.id)?.material_ready, true)
  assert.equal(report.shots.find(shot => shot.shot_id === second.id)?.review_status, null)
  assert.equal(report.shots.find(shot => shot.shot_id === third.id)?.material_ready, false)

  const issueCodes = new Set(report.issues.map(issue => issue.code))
  assert.ok(issueCodes.has('missing_material'), '范围内未选片镜头应被报告')
  assert.ok(issueCodes.has('pending_review'), '没有审核记录的选片应被报告')
  assert.ok(issueCodes.has('rejected_material'), '被拒绝的选片应被报告')
  assert.ok(issueCodes.has('invalid_clip'), '过短时间线片段应被报告')
  assert.equal(issueCodes.has('position_conflict'), false, '基础检查不得用关键词猜测镜头语义')
  assert.equal(issueCodes.has('weapon_conflict'), false)
  assert.equal(issueCodes.has('pose_conflict'), false)
  assert.equal(issueCodes.has('mask_conflict'), false)
  assert.ok(report.summary.error_count > 0)
  assert.ok(report.summary.warning_count > 0)
  assert.equal(report.summary.status, 'blocked')
})

test('continuity returns a ready empty report for a project without shots', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '空项目' })
  const report = await call<ContinuityResponse>('GET', `/api/projects/${project.id}/continuity`)
  assert.deepEqual(report.production_range, { start_shot_id: null, end_shot_id: null })
  assert.equal(report.shots.length, 0)
  assert.equal(report.issues.length, 0)
  assert.equal(report.summary.status, 'ready')
})

test('different characters do not trigger a weapon continuity warning', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '角色切换' })
  const firstScene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '剑客', characters: '沈霁', duration: 3,
  })
  const secondScene = await call<{ id: string }>('POST', `/api/projects/${project.id}/script/scenes`, {
    heading: '枪客', characters: '陆烬', duration: 3,
  })
  await call('POST', `/api/projects/${project.id}/shots`, {
    title: '沈霁', source_scene_id: firstScene.id, end_state: '沈霁手持长剑站在右侧',
  })
  await call('POST', `/api/projects/${project.id}/shots`, {
    title: '陆烬', source_scene_id: secondScene.id, start_state: '陆烬手持长枪站在左侧',
  })
  const report = await call<ContinuityResponse>('GET', `/api/projects/${project.id}/continuity`)
  assert.equal(report.issues.some(issue => issue.code === 'weapon_conflict'), false)
})

test('continuity returns not found for an unknown project', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/projects/missing-project/continuity' })
  assert.equal(response.statusCode, 404)
})

test('model continuity analysis is explicit, cached, scoped and invalidated when states change', async t => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '语义接镜' })
  const first = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '交接', end_state: '林将伞交给周' })
  const second = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '接伞', start_state: '周空着双手，林仍拿着伞' })
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '校验模型', base_url: 'https://continuity.example/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '文本校验', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  let requests = 0
  let raw = JSON.stringify({ issues: [{ code: 'prop_conflict', shot_id: second.id, related_shot_id: first.id,
    category: '道具归属', message: '上一镜伞交给周，下一镜仍由林持伞，需要交代交回动作。' }] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    requests++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.match(prompt, /不能靠左右、武器、面具等关键词/)
    assert.match(prompt, /林将伞交给周/)
    return new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const url = `/api/projects/${project.id}/continuity`
  const before = await call<ContinuityResponse & { semantic_review: { status: string } }>('GET', url)
  assert.equal(before.semantic_review.status, 'not_checked')
  assert.equal(requests, 0)
  await call('POST', `${url}/analyze`, { model_id: model.id })
  const checked = await call<ContinuityResponse & { semantic_review: { status: string } }>('GET', url)
  assert.equal(checked.semantic_review.status, 'checked')
  assert.ok(checked.issues.some(issue => issue.code === 'prop_conflict'))
  await call('GET', url)
  assert.equal(requests, 1, '刷新不得重复调用模型')
  run('UPDATE shots SET start_state=? WHERE id=?', '周接住伞', second.id)
  const stale = await call<ContinuityResponse & { semantic_review: { status: string } }>('GET', url)
  assert.equal(stale.semantic_review.status, 'stale')
  assert.equal(stale.issues.some(issue => issue.code === 'prop_conflict'), false)
  raw = JSON.stringify({ issues: [{ code: 'prop_conflict', shot_id: first.id, related_shot_id: second.id, category: '道具', message: '顺序错误的模型输出' }] })
  const invalid = await app.inject({ method: 'POST', url: `${url}/analyze`, payload: { model_id: model.id } })
  assert.equal(invalid.statusCode, 422)
  assert.equal((await call<ContinuityResponse & { semantic_review: { status: string } }>('GET', url)).semantic_review.status, 'stale')
})
