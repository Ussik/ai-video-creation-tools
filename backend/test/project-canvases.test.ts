import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'studio-project-canvases-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/server.js')
const { all, db, initDb, now, one, run } = await import('../src/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
type Info = { id: string; name: string; is_default: boolean; node_count: number; viewport: unknown }
type Graph = { nodes: Array<Record<string, any>>; edges: Array<Record<string, any>>; revision: string }
async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json<T>()
}
const node = (id: string, text = id) => ({ id, type: 'text', x: 80, y: 80, width: 320, height: 240, text })
const path = (projectId: string, canvasId: string) => `/api/projects/${projectId}/canvases/${canvasId}`
async function project() { return call<{ id: string }>('POST', '/api/projects', { name: '多画布' }) }

test('default graph stays compatible; independent saves, names and viewport updates do not invalidate another graph', async () => {
  const { id } = await project()
  const list = await call<Info[]>('GET', `/api/projects/${id}/canvases`)
  assert.equal(list.length, 1); assert.equal(list[0]!.id, id); assert.equal(list[0]!.name, '画布 1')
  const initial = await call<Graph>('GET', `/api/projects/${id}/canvas`)
  const first = await call<Graph>('PUT', `/api/projects/${id}/canvas`, { ...initial, nodes: [node('old-node')], edges: [] })
  const second = await call<Info>('POST', `/api/projects/${id}/canvases`, {})
  assert.equal(second.name, '画布 2'); assert.equal(second.node_count, 0)
  const empty = await call<Graph>('GET', path(id, second.id))
  const saved = await call<Graph>('PUT', path(id, second.id), { ...empty, nodes: [node('second-node')], edges: [] })
  assert.deepEqual(await call('GET', `/api/projects/${id}/canvas`), first)
  const changed = await call<Info>('PATCH', path(id, second.id), { name: '第二场·调查', viewport: { x: -250, y: 33, zoom: 0.5 } })
  assert.equal(changed.name, '第二场·调查'); assert.deepEqual(changed.viewport, { x: -250, y: 33, zoom: 0.5 })
  assert.deepEqual(await call('GET', path(id, second.id)), saved)
  const edited = await call<Graph>('PUT', path(id, id), { ...first, nodes: [node('old-node', '新编辑')] })
  assert.deepEqual(await call('GET', path(id, second.id)), saved)
  initDb()
  assert.deepEqual(await call('GET', path(id, id)), edited)
  assert.equal((await call<Info[]>('GET', `/api/projects/${id}/canvases`)).length, 2)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('foreign canvases, duplicate identities and cross-canvas edges are rejected without changing either graph', async () => {
  const local = await project(), foreign = await project()
  const [first] = await call<Info[]>('GET', `/api/projects/${local.id}/canvases`)
  const second = await call<Info>('POST', `/api/projects/${local.id}/canvases`, {})
  const base = await call<Graph>('GET', path(local.id, first!.id))
  const saved = await call<Graph>('PUT', path(local.id, first!.id), { ...base, nodes: [node('local-node')], edges: [] })
  const empty = await call<Graph>('GET', path(local.id, second.id))
  for (const payload of [
    { ...empty, nodes: [node('local-node')] },
    { ...empty, nodes: [node('new-node')], edges: [{ id: 'invalid-edge', source: 'local-node', target: 'new-node' }] },
  ]) {
    assert.equal((await app.inject({ method: 'PUT', url: path(local.id, second.id), payload })).statusCode, 422)
    assert.deepEqual(await call('GET', path(local.id, first!.id)), saved)
    assert.deepEqual(await call('GET', path(local.id, second.id)), empty)
  }
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
    const payload = method === 'PUT' ? empty : method === 'PATCH' ? { name: '攻击' } : { revision: empty.revision }
    assert.equal((await app.inject({ method, url: path(foreign.id, second.id), ...(method === 'GET' ? {} : { payload }) })).statusCode, 404)
  }
})

test('moving nodes preserves identities, snapshots, relative layout and internal edges; checks both revisions atomically', async () => {
  const { id } = await project()
  await call('GET', `/api/projects/${id}/canvases`)
  const target = await call<Info>('POST', `/api/projects/${id}/canvases`, {})
  const sourceBase = await call<Graph>('GET', path(id, id)), targetBase = await call<Graph>('GET', path(id, target.id))
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES ('move-reference', ?, 'image', 'image.png', '/missing.png', 'upload', ?)", id, now())
  const source = await call<Graph>('PUT', path(id, id), { ...sourceBase,
    nodes: [node('move-a'), { ...node('move-b'), x: 480, settings: { text_mode: 'write' } }, node('stay')],
    edges: [{ id: 'inside', source: 'move-a', target: 'move-b', reference_asset_id: 'move-reference' }, { id: 'boundary', source: 'move-b', target: 'stay' }],
  })
  const payload = { target_canvas_id: target.id, node_ids: ['move-a', 'move-b'], revision: source.revision, target_revision: targetBase.revision }
  assert.equal((await app.inject({ method: 'POST', url: `${path(id, id)}/move-nodes`, payload: { ...payload, target_revision: '0'.repeat(64) } })).statusCode, 409)
  assert.deepEqual(await call('GET', path(id, id)), source)
  run("DELETE FROM assets WHERE id='move-reference'")
  const result = await call<{ source: Graph; target: Graph }>('POST', `${path(id, id)}/move-nodes`, payload)
  assert.deepEqual(result.source.nodes.map(item => item.id), ['stay']); assert.deepEqual(result.source.edges, [])
  assert.deepEqual(result.target.nodes.map(item => item.id), ['move-a', 'move-b'])
  assert.equal(result.target.nodes[1]!.x - result.target.nodes[0]!.x, 400)
  assert.deepEqual(result.target.nodes[1]!.settings, { text_mode: 'write' })
  assert.deepEqual(result.target.edges, [{ id: 'inside', source: 'move-a', target: 'move-b', reference_asset_id: 'move-reference' }])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('deleting a canvas preserves project resources, rejects stale deletion and keeps at least one canvas', async () => {
  const { id } = await project()
  await call('GET', `/api/projects/${id}/canvases`)
  const other = await call<Info>('POST', `/api/projects/${id}/canvases`, {})
  const shot = await call<{ id: string }>('POST', `/api/projects/${id}/shots`, { title: '保留镜头' })
  run("INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at) VALUES ('canvas-keep-asset', ?, ?, 'image', 'image.png', '/missing.png', 'upload', ?)", id, shot.id, now())
  run("INSERT INTO jobs (id, project_id, shot_id, job_type, request, status, created_at, updated_at) VALUES ('canvas-keep-job', ?, ?, 'generation', '{}', 'running', ?, ?)", id, shot.id, now(), now())
  const empty = await call<Graph>('GET', path(id, id))
  const graph = await call<Graph>('PUT', path(id, id), { ...empty, nodes: [{ ...node('keep-generation'), type: 'generation', shot_id: shot.id, asset_id: 'canvas-keep-asset', job_id: 'canvas-keep-job' }], edges: [] })
  assert.equal((await app.inject({ method: 'DELETE', url: path(id, id), payload: { revision: empty.revision } })).statusCode, 409)
  await call('DELETE', path(id, id), { revision: graph.revision })
  assert.ok(one('SELECT 1 FROM shots WHERE id=?', shot.id)); assert.ok(one("SELECT 1 FROM assets WHERE id='canvas-keep-asset'")); assert.ok(one("SELECT 1 FROM jobs WHERE id='canvas-keep-job'"))
  assert.equal(all('SELECT * FROM canvas_nodes WHERE project_id=?', id).length, 0)
  const remaining = await call<Info[]>('GET', `/api/projects/${id}/canvases`)
  assert.equal(remaining[0]!.id, other.id); assert.equal(remaining[0]!.is_default, true)
  const current = await call<Graph>('GET', `/api/projects/${id}/canvas`)
  assert.equal((await app.inject({ method: 'DELETE', url: path(id, other.id), payload: { revision: current.revision } })).statusCode, 422)
  initDb(); assert.equal((await call<Info[]>('GET', `/api/projects/${id}/canvases`)).length, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
