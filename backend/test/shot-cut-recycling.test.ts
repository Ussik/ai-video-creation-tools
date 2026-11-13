import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'
import type { EditingCut, EditingCutInput } from '@video-studio/shared/media/editing-cut'
import type { CanvasDeletionPreview, ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'

const directory = await mkdtemp(join(tmpdir(), 'studio-shot-cut-recycling-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp, startWorker } = await import('../src/app.js')
const { db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { probeVideoDurationMs } = await import('../src/infrastructure/media/render.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json<T>()
}
function cutInput(cut: EditingCut): EditingCutInput {
  const { id: _id, project_id: _project, created_at: _created, updated_at: _updated, ...input } = cut
  return input
}
const management = (projectId: string) => `/api/projects/${projectId}/shot-management`
async function action(projectId: string, input: Record<string, unknown>) {
  const state = await call<ShotManagementSnapshot>('GET', management(projectId))
  return call<ShotManagementSnapshot>('POST', management(projectId) + '/actions', { revision: state.revision, ...input })
}
async function fixture(count = 1) {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '保留独立剪辑', ratio: '16:9' })
  await call('GET', `/api/projects/${project.id}/canvases`)
  const shots: Array<{ id: string; assetId: string; path: string }> = []
  for (let index = 0; index < count; index++) {
    const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: `镜头 ${index + 1}`, duration: 2 })
    const assetId = newId(), path = join(directory, assetId + '.png')
    await writeFile(path, await sharp({ create: { width: 160, height: 90, channels: 3, background: '#17425c' } }).png().toBuffer())
    run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at)
      VALUES (?,?,?,'image',?,?,'generated',?)`, assetId, project.id, shot.id, assetId + '.png', path, now())
    shots.push({ id: shot.id, assetId, path })
  }
  const base = `/api/projects/${project.id}/editing-cuts`
  const created = await call<EditingCut>('POST', base, { name: '需要保留的剪辑' })
  const cut = await call<EditingCut>('PUT', `${base}/${created.id}`, { ...cutInput(created), clips: shots.map((shot, index) => ({
    id: `clip-${index}`, asset_id: shot.assetId, title: `入片画面 ${index + 1}`, in_ms: 0, out_ms: 1000,
    source_audio_gain: 0, source_audio_fade_ms: 0,
  })) })
  return { projectId: project.id, shots, cut, cutUrl: `${base}/${cut.id}` }
}
async function preserved(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await call('GET', f.cutUrl), f.cut)
  for (const shot of f.shots) {
    const asset = one<{ deleted_at: string | null; path: string }>('SELECT deleted_at,path FROM assets WHERE id=?', shot.assetId)!
    assert.equal(asset.deleted_at, null)
    assert.equal(asset.path, shot.path)
    assert.equal((await sharp(await readFile(asset.path)).metadata()).format, 'png')
    const media = await app.inject({ method: 'GET', url: `/api/assets/${shot.assetId}/file` })
    assert.equal(media.statusCode, 200, media.body)
  }
}

for (const mode of ['trash', 'trash_many', 'trash_design'] as const) {
  test(`${mode} recycles shots whose media is used by an independent cut without changing media or cut`, async () => {
    const f = await fixture(mode === 'trash' ? 1 : 2)
    const input = mode === 'trash' ? { action: mode, shot_id: f.shots[0]!.id }
      : mode === 'trash_many' ? { action: mode, shot_ids: f.shots.map(shot => shot.id) }
      : { action: mode, design_id: null }
    const snapshot = await action(f.projectId, input)
    assert.ok(snapshot.shots.every(entry => entry.deleted_at))
    await preserved(f)
  })
}

test('permanent shot deletion retains cut media and permits saving and exporting the independent cut', { timeout: 90000 }, async () => {
  const f = await fixture(), shot = f.shots[0]!
  await action(f.projectId, { action: 'trash', shot_id: shot.id })
  const purged = await action(f.projectId, { action: 'purge', shot_id: shot.id })
  assert.deepEqual(purged.shots, [])
  assert.equal(one('SELECT 1 FROM shots WHERE id=?', shot.id), undefined)
  assert.equal(one<{ shot_id: string | null }>('SELECT shot_id FROM assets WHERE id=?', shot.assetId)!.shot_id, null)
  await preserved(f)
  const saved = await call<EditingCut>('PUT', f.cutUrl, { ...cutInput(f.cut), name: '镜头删除后继续剪辑' })
  const job = await call<{ id: string; request: string; status: string }>('POST', f.cutUrl + '/export', { revision: saved.revision })
  assert.equal(job.status, 'queued')
  assert.deepEqual(JSON.parse(job.request).clips.map((clip: { asset_id: string }) => clip.asset_id), [shot.assetId])
  const stop = startWorker()
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const current = one<{ status: string; error: string | null }>('SELECT status,error FROM jobs WHERE id=?', job.id)!
      if (current.status === 'succeeded' || current.status === 'failed') {
        assert.equal(current.status, 'succeeded', current.error ?? '')
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally { await stop() }
  const completed = one<{ status: string; result_asset_id: string }>('SELECT status,result_asset_id FROM jobs WHERE id=?', job.id)!
  assert.equal(completed.status, 'succeeded')
  const output = one<{ path: string }>('SELECT path FROM assets WHERE id=?', completed.result_asset_id)!.path
  assert.ok(Math.abs(probeVideoDurationMs(output) - 1000) < 100)
  assert.equal(one<{ deleted_at: string | null }>('SELECT deleted_at FROM assets WHERE id=?', shot.assetId)!.deleted_at, null)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('canvas cleanup recycles its exclusive shot while retaining cut media even when asset cleanup is requested', async () => {
  const f = await fixture(), shot = f.shots[0]!
  const canvas = await call<{ id: string }>('POST', `/api/projects/${f.projectId}/canvases`, { name: '待删除画布' })
  const url = `/api/projects/${f.projectId}/canvases/${canvas.id}`
  const graph = await call<{ revision: string; nodes: unknown[]; edges: unknown[] }>('GET', url)
  await call('PUT', url, { ...graph, nodes: [{ id: 'cut-media-node', type: 'generation', x: 0, y: 0, width: 320, height: 240,
    title: '已剪辑画面', prompt: '画面', settings: { modality: 'image' }, shot_id: shot.id, asset_id: shot.assetId }] })
  const preview = await call<CanvasDeletionPreview>('GET', url + '/deletion-preview')
  assert.deepEqual(preview.exclusive_shots.map(item => item.id), [shot.id])
  assert.deepEqual(preview.exclusive_assets, [])
  assert.equal(preview.protected_asset_count, 1)
  await call('DELETE', url, { revision: preview.revision, cleanup_revision: preview.cleanup_revision, cleanup_shots: true, cleanup_assets: true })
  assert.ok(one<{ deleted_at: string | null }>('SELECT deleted_at FROM shots WHERE id=?', shot.id)!.deleted_at)
  assert.equal(one('SELECT 1 FROM project_canvases WHERE id=?', canvas.id), undefined)
  await preserved(f)
})

test('permanent asset deletion remains blocked by an independent cut after the asset enters trash', async () => {
  const f = await fixture(), asset = f.shots[0]!
  // Model an older recycled record that acquired an independent reference later.
  run('UPDATE assets SET deleted_at=? WHERE id=?', now(), asset.assetId)
  const state = await call<ShotManagementSnapshot>('GET', management(f.projectId))
  assert.ok(state.trashed_assets.find(item => item.id === asset.assetId)?.purge_blockers?.length)
  const response = await app.inject({ method: 'POST', url: management(f.projectId) + '/actions',
    payload: { revision: state.revision, action: 'purge_asset', asset_id: asset.assetId } })
  assert.equal(response.statusCode, 422, response.body)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?', asset.assetId))
  assert.deepEqual(await call('GET', f.cutUrl), f.cut)
  assert.equal((await sharp(await readFile(asset.path)).metadata()).format, 'png')
})
