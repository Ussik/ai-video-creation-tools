import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'studio-final-cut-scope-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { resolveFinalCutScope } = await import('../src/modules/final-cut/final-cut-scope.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

type Range = { start_shot_id: string | null; end_shot_id: string | null }
type Detail = { final_cut_canvas_id?: string; shots: Array<{ id: string }>; historical_shots: Array<{ id: string }>; timeline_clips: Array<{ id: string; shot_id: string }>; production_range: Range }
type Cut = { from_shot_id: string; to_shot_id: string; signature: string; status: string; from: { out_ms: number }; to: { in_ms: number } }
async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json<T>()
}
const fullRange = { start_shot_id: null, end_shot_id: null }
const scoped = (url: string, canvasId: string) => `${url}?canvas_id=${canvasId}`

async function fixture() {
  const { id } = await call<{ id: string }>('POST', '/api/projects', { name: '多方案成片' })
  await call('GET', `/api/projects/${id}/canvases`)
  const oldCanvas = await call<{ id: string }>('POST', `/api/projects/${id}/canvases`, { name: '初版方案' })
  const newCanvas = await call<{ id: string }>('POST', `/api/projects/${id}/canvases`, { name: '重规划方案' })
  const oldDesign = `${id}-old`, newDesign = `${id}-new`
  for (const [design, canvas] of [[oldDesign, oldCanvas.id], [newDesign, newCanvas.id]]) run(
    'INSERT INTO storyboard_designs (id, project_id, canvas_id, name, scene_ids, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    design, id, canvas, design, '[]', '', now())
  const oldShots: string[] = [], newShots: string[] = []
  for (const [prefix, design, target] of [['旧', oldDesign, oldShots], ['新', newDesign, newShots]] as const) {
    for (let index = 0; index < 3; index++) {
      const shot = await call<{ id: string }>('POST', `/api/projects/${id}/shots`, { title: `${prefix}${index}`, duration: 2, start_state: `${prefix}开镜`, end_state: `${prefix}收镜` })
      run('UPDATE shots SET design_id=?, superseded_by=?, position=? WHERE id=?', design, design === oldDesign ? newDesign : null, index, shot.id)
      target.push(shot.id)
      const assetId = `${shot.id}-asset`, path = join(directory, `${assetId}.png`)
      await writeFile(path, 'isolated image fixture')
      run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at)
        VALUES (?, ?, ?, 'image', ?, ?, 'upload', ?)`, assetId, id, shot.id, `${assetId}.png`, path, now())
      await call('PUT', `/api/shots/${shot.id}/selection`, { asset_id: assetId })
    }
  }
  return { id, oldCanvas: oldCanvas.id, newCanvas: newCanvas.id, oldDesign, newDesign, oldShots, newShots }
}

test('canvas-scoped details recover historical plans and exact clips without changing legacy active reads', async () => {
  const f = await fixture()
  const url = `/api/projects/${f.id}`
  const active = await call<Detail>('GET', url)
  assert.equal(active.final_cut_canvas_id, undefined)
  assert.deepEqual(active.shots.map(shot => shot.id), f.newShots)
  assert.deepEqual(active.historical_shots.map(shot => shot.id).sort(), [...f.oldShots].sort())
  assert.deepEqual(active.timeline_clips.map(clip => clip.shot_id), f.newShots)
  for (const [canvasId, shotIds] of [[f.oldCanvas, f.oldShots], [f.newCanvas, f.newShots]] as const) {
    const detail = await call<Detail>('GET', scoped(url, canvasId))
    assert.equal(detail.final_cut_canvas_id, canvasId)
    assert.deepEqual(detail.shots.map(shot => shot.id), shotIds)
    assert.deepEqual(detail.timeline_clips.map(clip => clip.shot_id), shotIds)
    assert.deepEqual(detail.historical_shots, [])
  }
  const legacy = await call<{ id: string }>('POST', `/api/projects/${f.id}/shots`, { title: '无方案旧镜头' })
  assert.deepEqual(resolveFinalCutScope(f.id, f.id).shots.map(shot => shot.id), [legacy.id])
  const blank = await call<{ id: string }>('POST', `/api/projects/${f.id}/canvases`, {})
  assert.deepEqual(resolveFinalCutScope(f.id, blank.id).shots.map(shot => shot.id), [legacy.id])
})

test('ranges persist per canvas, inherit only compatible boundaries and reset explicitly', async () => {
  const f = await fixture(), url = `/api/projects/${f.id}`
  const activeRange = { start_shot_id: f.newShots[1]!, end_shot_id: f.newShots[2]! }
  await call('PUT', `${url}/production-range`, activeRange)
  assert.deepEqual((await call<Detail>('GET', scoped(url, f.newCanvas))).production_range, activeRange)
  assert.deepEqual((await call<Detail>('GET', scoped(url, f.oldCanvas))).production_range, fullRange)
  const oldRange = { start_shot_id: f.oldShots[0]!, end_shot_id: f.oldShots[1]! }
  await call('PUT', scoped(`${url}/production-range`, f.oldCanvas), oldRange)
  await call('PUT', scoped(`${url}/production-range`, f.newCanvas), fullRange)
  initDb()
  assert.deepEqual((await call<Detail>('GET', scoped(url, f.oldCanvas))).production_range, oldRange)
  assert.deepEqual((await call<Detail>('GET', scoped(url, f.newCanvas))).production_range, fullRange)
  assert.deepEqual((await call<Detail>('GET', url)).production_range, activeRange)
  for (const range of [
    { start_shot_id: f.newShots[0], end_shot_id: f.oldShots[2] },
    { start_shot_id: f.oldShots[2], end_shot_id: f.oldShots[0] },
  ]) assert.equal((await app.inject({ method: 'PUT', url: scoped(`${url}/production-range`, f.oldCanvas), payload: range })).statusCode, 422)
  assert.deepEqual((await call<Detail>('GET', scoped(url, f.oldCanvas))).production_range, oldRange)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/shots/${f.oldShots[0]}` })).statusCode, 422)
})

test('history reorder, selection and clip edits validate the selected plan and leave other order intact', async () => {
  const f = await fixture()
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/shots/${f.oldShots[2]}`, payload: { position: 0 } })).statusCode, 422)
  await call('PATCH', scoped(`/api/shots/${f.oldShots[2]}`, f.oldCanvas), { position: 0 })
  assert.deepEqual(resolveFinalCutScope(f.id, f.oldCanvas).shots.map(shot => shot.id), [f.oldShots[2], f.oldShots[0], f.oldShots[1]])
  assert.deepEqual(resolveFinalCutScope(f.id, f.newCanvas).shots.map(shot => shot.id), f.newShots)
  const oldClip = resolveFinalCutScope(f.id, f.oldCanvas).clips[0]!
  for (const [method, url, payload] of [
    ['PATCH', `/api/shots/${f.oldShots[0]}`, { position: 0 }],
    ['PUT', `/api/shots/${f.oldShots[0]}/selection`, { asset_id: null }],
    ['PATCH', `/api/timeline-clips/${oldClip.id}`, { out_ms: 1500 }],
  ] as const) assert.equal((await app.inject({ method, url: scoped(url, f.newCanvas), payload })).statusCode, 422)
  await call('PATCH', scoped(`/api/timeline-clips/${oldClip.id}`, f.oldCanvas), { out_ms: 1500 })
  assert.equal(resolveFinalCutScope(f.id, f.oldCanvas).clips[0]?.out_ms, 1500)
  assert.equal(resolveFinalCutScope(f.id, f.newCanvas).clips[0]?.out_ms, 2000)
})

test('asset review validates canvas scope before changing selection or removing timeline clips', async () => {
  const f = await fixture()
  const shotId = f.oldShots[0]!, assetId = `${shotId}-asset`
  const url = `/api/shots/${shotId}/assets/${assetId}/review`
  const reject = { status: 'rejected', note: '旧方案画面需重做' }
  for (const [canvasId, status] of [[f.newCanvas, 422], ['missing-canvas', 404]] as const) {
    assert.equal((await app.inject({ method: 'PUT', url: scoped(url, canvasId), payload: reject })).statusCode, status)
    assert.equal(one<{ selected_asset_id: string }>('SELECT selected_asset_id FROM shots WHERE id=?', shotId)?.selected_asset_id, assetId)
    assert.ok(one('SELECT 1 FROM timeline_clips WHERE shot_id=?', shotId))
    assert.equal(one('SELECT 1 FROM asset_reviews WHERE shot_id=? AND asset_id=?', shotId, assetId), undefined)
  }
  await call('PUT', scoped(url, f.oldCanvas), reject)
  assert.equal(one<{ selected_asset_id: string | null }>('SELECT selected_asset_id FROM shots WHERE id=?', shotId)?.selected_asset_id, null)
  assert.equal(one('SELECT 1 FROM timeline_clips WHERE shot_id=?', shotId), undefined)
  assert.equal(resolveFinalCutScope(f.id, f.newCanvas).clips.length, 3)
  await call('PUT', scoped(url, f.oldCanvas), { status: 'approved', note: '重新确认旧方案候选' })
  await call('PUT', scoped(`/api/shots/${shotId}/selection`, f.oldCanvas), { asset_id: assetId })
  assert.equal(resolveFinalCutScope(f.id, f.oldCanvas).clips.length, 3)
  await call('PUT', url, { status: 'pending', note: '' })
  assert.equal(one<{ status: string }>('SELECT status FROM asset_reviews WHERE shot_id=? AND asset_id=?', shotId, assetId)?.status, 'pending')
})

test('scoped reorder rolls back if it would reverse a separately saved compatible production range', async () => {
  const f = await fixture(), url = `/api/projects/${f.id}`
  await call('PUT', `${url}/production-range`, { start_shot_id: f.newShots[0], end_shot_id: f.newShots[1] })
  await call('PUT', scoped(`${url}/production-range`, f.newCanvas), fullRange)
  assert.equal((await app.inject({ method: 'PATCH', url: scoped(`/api/shots/${f.newShots[1]}`, f.newCanvas), payload: { position: 0 } })).statusCode, 422)
  assert.deepEqual(resolveFinalCutScope(f.id, f.newCanvas).shots.map(shot => shot.id), f.newShots)
  await call('PUT', `${url}/production-range`, fullRange)
  await call('PUT', scoped(`${url}/production-range`, f.newCanvas), { start_shot_id: f.newShots[0], end_shot_id: f.newShots[1] })
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/shots/${f.newShots[1]}`, payload: { position: 0 } })).statusCode, 422)
  assert.deepEqual(resolveFinalCutScope(f.id, f.newCanvas).shots.map(shot => shot.id), f.newShots)
})

test('cuts, continuity and exports use the selected historical plan and its own range', async () => {
  const f = await fixture(), url = `/api/projects/${f.id}`
  const oldCutsUrl = scoped(`${url}/cut-reviews`, f.oldCanvas)
  const cuts = await call<{ cuts: Cut[] }>('GET', oldCutsUrl)
  assert.deepEqual(cuts.cuts.map(cut => [cut.from_shot_id, cut.to_shot_id]), [[f.oldShots[0], f.oldShots[1]], [f.oldShots[1], f.oldShots[2]]])
  const cut = cuts.cuts[0]!
  const review = { from_shot_id: cut.from_shot_id, to_shot_id: cut.to_shot_id, signature: cut.signature, status: 'approved', note: '旧方案接镜可用' }
  await call('PUT', oldCutsUrl, review)
  assert.equal((await call<{ cuts: Cut[] }>('GET', oldCutsUrl)).cuts[0]?.status, 'approved')
  assert.equal((await app.inject({ method: 'PUT', url: scoped(`${url}/cut-reviews`, f.newCanvas), payload: review })).statusCode, 422)
  const points = { from_shot_id: cut.from_shot_id, to_shot_id: cut.to_shot_id, signature: cut.signature, from_out_ms: cut.from.out_ms, to_in_ms: cut.to.in_ms }
  await call('PUT', scoped(`${url}/cut-points`, f.oldCanvas), points)
  assert.equal((await app.inject({ method: 'PUT', url: scoped(`${url}/cut-points`, f.newCanvas), payload: points })).statusCode, 422)
  await call('PUT', scoped(`${url}/production-range`, f.oldCanvas), { start_shot_id: f.oldShots[1], end_shot_id: f.oldShots[2] })
  const report = await call<{ shots: Array<{ shot_id: string }> }>('GET', scoped(`${url}/continuity`, f.oldCanvas))
  assert.deepEqual(report.shots.map(shot => shot.shot_id), f.oldShots.slice(1))
  for (const [canvasId, expected] of [[f.oldCanvas, f.oldShots.slice(1)], [f.newCanvas, f.newShots], [undefined, f.newShots]] as const) {
    const exportJob = await call<{ request: string }>('POST', canvasId ? scoped(`${url}/export`, canvasId) : `${url}/export`, {})
    const snapshot = JSON.parse(exportJob.request) as { final_cut_canvas_id?: string; clips: Array<{ asset_id: string }> }
    assert.equal(snapshot.final_cut_canvas_id, canvasId)
    assert.deepEqual(snapshot.clips.map(clip => clip.asset_id), expected.map(id => `${id}-asset`))
  }
})

test('semantic analysis caches are isolated and revalidation remains within the same plan', async t => {
  const f = await fixture(), url = `/api/projects/${f.id}`
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: 'isolated mock', base_url: 'https://final-cut-test.invalid/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: 'mock', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.match(prompt, /旧开镜/)
    assert.doesNotMatch(prompt, /新开镜/)
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[]}' } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  await call('POST', scoped(`${url}/continuity/analyze`, f.oldCanvas), { model_id: model.id })
  type Report = { semantic_review: { status: string } }
  assert.equal((await call<Report>('GET', scoped(`${url}/continuity`, f.oldCanvas))).semantic_review.status, 'checked')
  assert.equal((await call<Report>('GET', scoped(`${url}/continuity`, f.newCanvas))).semantic_review.status, 'not_checked')
  assert.equal((await call<Report>('GET', `${url}/continuity`)).semantic_review.status, 'not_checked')
  run('UPDATE shots SET start_state=? WHERE id=?', '新方案单独变化', f.newShots[0])
  assert.equal((await call<Report>('GET', scoped(`${url}/continuity`, f.oldCanvas))).semantic_review.status, 'checked')
  run('UPDATE shots SET start_state=? WHERE id=?', '旧方案变化', f.oldShots[0])
  assert.equal((await call<Report>('GET', scoped(`${url}/continuity`, f.oldCanvas))).semantic_review.status, 'stale')
  assert.equal(requests, 1)
})

test('unknown, foreign and malformed canvas scopes fail across final cut endpoints', async () => {
  const f = await fixture()
  const foreign = await call<{ id: string }>('POST', '/api/projects', { name: '另一个项目' })
  await call('GET', `/api/projects/${foreign.id}/canvases`)
  for (const canvasId of ['missing', foreign.id]) {
    for (const [method, suffix, payload] of [
      ['GET', '', undefined], ['GET', '/continuity', undefined], ['GET', '/cut-reviews', undefined],
      ['POST', '/continuity/analyze', { model_id: 'missing' }],
      ['POST', '/export', {}], ['PUT', '/production-range', fullRange],
    ] as const) assert.equal((await app.inject({ method, url: scoped(`/api/projects/${f.id}${suffix}`, canvasId), ...(payload === undefined ? {} : { payload }) })).statusCode, 404)
  }
  for (const query of ['canvas_id=', `canvas_id=${f.oldCanvas}&canvas_id=${f.newCanvas}`]) {
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${f.id}?${query}` })).statusCode, 422)
  }
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.ok(all('SELECT * FROM canvas_production_ranges').length > 0)
})
