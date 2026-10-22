import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'storyboard-design-history-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, initDb, now, one, run } = await import('../src/infrastructure/database/db.js')
const { resourceTools } = await import('../src/modules/script/script-resource-tools.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('current project, continuity and imports exclude historical shots while the old canvas and media survive', async () => {
  const project = await call('POST', '/api/projects', { name: '独立方案' })
  const root = `/api/projects/${project.id}`
  const scene = await call('POST', `${root}/script/scenes`, { heading: '河边', duration: 8 })
  const otherScene = await call('POST', `${root}/script/scenes`, { heading: '山中', duration: 4 })
  const old = await call('POST', `${root}/shots`, { title: '旧镜头', duration: 8, source_scene_id: scene.id })
  const other = await call('POST', `${root}/shots`, { title: '选外镜头', duration: 4, source_scene_id: otherScene.id })
  await call('GET', `${root}/canvases`)
  const before = await call('GET', `${root}/canvas`)
  const oldGraph = await call('PUT', `${root}/canvas`, { ...before, nodes: [{ id: 'old-design-node', type: 'generation', x: 80, y: 80,
    width: 440, height: 420, title: old.title, shot_id: old.id, settings: { modality: 'image' } }], edges: [] })
  const canvas = await call('POST', `${root}/canvases`, { name: '分镜方案 2' })
  const designId = 'history-test-design'
  run('INSERT INTO storyboard_designs (id, project_id, canvas_id, name, scene_ids, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    designId, project.id, canvas.id, canvas.name, JSON.stringify([scene.id]), '重新设计', now())
  run("INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at) VALUES ('history-image', ?, ?, 'image', 'old.png', '/missing-old.png', 'upload', ?)", project.id, old.id, now())
  run("UPDATE shots SET selected_asset_id='history-image', superseded_by=? WHERE id=?", designId, old.id)
  run("INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, in_ms, out_ms, source_duration_ms) VALUES ('history-clip', ?, ?, 'history-image', 0, 8000, NULL)", project.id, old.id)
  const current = await call('POST', `${root}/shots`, { title: '新镜头', duration: 8, source_scene_id: scene.id })
  run('UPDATE shots SET design_id=?, position=0 WHERE id=?', designId, current.id)
  run('UPDATE shots SET position=1 WHERE id=?', other.id)

  const detail = await call('GET', root)
  assert.deepEqual(detail.shots.map((shot: any) => shot.id), [current.id, other.id])
  assert.equal(detail.historical_shots.length, 1)
  assert.equal(detail.historical_shots[0].id, old.id)
  assert.equal(detail.historical_shots[0].selected_asset_id, 'history-image')
  assert.equal(detail.historical_shots[0].superseded_by, designId)
  assert.deepEqual(detail.timeline_clips, [])
  assert.ok(detail.assets.some((asset: any) => asset.id === 'history-image'))
  assert.ok(one('SELECT 1 FROM timeline_clips WHERE id=?', 'history-clip'))
  assert.deepEqual(await call('GET', `${root}/canvas`), oldGraph)
  const info = (await call('GET', `${root}/canvases`)).find((item: any) => item.id === canvas.id)
  assert.equal(info.design_id, designId)
  assert.equal(info.node_count, 0)
  const continuity = await call('GET', `${root}/continuity`)
  assert.deepEqual(continuity.shots.map((shot: any) => shot.shot_id), [current.id, other.id])
  const context = resourceTools(project.id).execute('get_storyboard_context', { scene_ids: [scene.id], limit: 10 }) as any
  assert.deepEqual(context.objects.filter((item: any) => item.type === 'shot').map((item: any) => item.id), [current.id])

  const appended = await call('POST', `${root}/shots`, { title: '当前方案补充镜头', duration: 2, source_scene_id: scene.id })
  assert.equal(appended.design_id, designId)
  assert.equal(appended.superseded_by, null)
  const obsoleteRange = await app.inject({ method: 'PUT', url: `${root}/production-range`, payload: { start_shot_id: old.id, end_shot_id: null } })
  assert.equal(obsoleteRange.statusCode, 422, obsoleteRange.body)
  const reorder = await app.inject({ method: 'PATCH', url: `/api/shots/${old.id}`, payload: { position: 0 } })
  assert.equal(reorder.statusCode, 422, reorder.body)
  await call('DELETE', `/api/shots/${appended.id}`)
  await call('DELETE', `/api/shots/${current.id}`)
  const recreated = await call('POST', `${root}/script/convert-to-shots`, { scene_ids: [scene.id] })
  assert.equal(recreated.shots[0].design_id, designId, 'empty scenes retain their current design instead of inheriting the legacy domain')
  assert.equal(recreated.shots[0].selected_asset_id, null)
  initDb()
  assert.ok(one('SELECT 1 FROM timeline_clips WHERE id=?', 'history-clip'))
  assert.equal((await call('GET', root)).historical_shots.length, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
