import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { EditingCut, EditingCutInput } from '@video-studio/shared/media/editing-cut'
import type { ScriptScene, Shot } from '../src/infrastructure/database/db.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-active-resource-guards-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, now, one, run } = await import('../src/infrastructure/database/db.js')
const { resolveFinalCutScope } = await import('../src/modules/final-cut/final-cut-scope.js')
const { scriptCanvasPreparationSnapshot } = await import('../src/modules/canvas/script-canvas-preparation.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json<T>()
}
async function project() {
  const { id } = await call<{ id: string }>('POST', '/api/projects', { name: '回收站引用隔离' })
  await call('GET', `/api/projects/${id}/canvases`)
  return id
}
async function shot(projectId: string, title: string) {
  return call<Shot>('POST', `/api/projects/${projectId}/shots`, { title })
}
async function asset(projectId: string, kind: 'image' | 'video' | 'audio') {
  const id = crypto.randomUUID(), path = join(directory, id)
  await writeFile(path, 'preserved original media')
  run('INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,?,?,?,?,?)',
    id, projectId, kind, id, path, 'upload', now())
  return id
}

test('final cut scopes exclude recycled shots in active, legacy and historical canvas plans', async () => {
  const p = await project(), active = await shot(p, '保留镜头'), trashed = await shot(p, '回收镜头')
  run('UPDATE shots SET deleted_at=? WHERE id=?', now(), trashed.id)
  assert.deepEqual(resolveFinalCutScope(p).shots.map(value => value.id), [active.id])
  assert.deepEqual(resolveFinalCutScope(p, p).shots.map(value => value.id), [active.id])
  const canvas = await call<{ id: string }>('POST', `/api/projects/${p}/canvases`, { name: '历史方案' })
  const designId = crypto.randomUUID()
  run('INSERT INTO storyboard_designs (id,project_id,canvas_id,name,scene_ids,created_at) VALUES (?,?,?,?,?,?)',
    designId, p, canvas.id, '历史方案', '[]', now())
  run('UPDATE shots SET design_id=?,superseded_by=? WHERE project_id=?', designId, designId, p)
  assert.deepEqual(resolveFinalCutScope(p, canvas.id).shots.map(value => value.id), [active.id], 'historical plans remain accessible without resurrecting recycled shots')
})

test('canvas preparation and visual refresh omit trash while preserving binding snapshots', async () => {
  const p = await project()
  const scene = await call<ScriptScene>('POST', `/api/projects/${p}/script/scenes`, { heading: '庭院' })
  const active = await shot(p, '庭院全景'), trashed = await shot(p, '旧庭院')
  run('UPDATE shots SET source_scene_id=? WHERE project_id=?', scene.id, p)
  const data = await call<{ visual_profiles: Array<{ id: string }> }>('POST', `/api/projects/${p}/visual-profiles`, {
    profiles: [{ kind: 'location', name: '庭院', variant: '默认', definition: '石墙庭院', view_requirements: '展示空间' }],
  })
  const profileId = data.visual_profiles[0]!.id
  await call('PUT', `/api/shots/${trashed.id}/visual-bindings`, { bindings: [{ profile_id: profileId, usage: 'image' }] })
  const oldBinding = one('SELECT * FROM shot_visual_bindings WHERE shot_id=?', trashed.id)
  run('UPDATE shots SET deleted_at=? WHERE id=?', now(), trashed.id)
  await call('PATCH', `/api/visual-profiles/${profileId}`, { expected_revision: 1, definition: '新的石墙庭院' })
  const detail = await call<{ shot_visual_bindings: unknown[] }>('GET', `/api/projects/${p}`)
  assert.deepEqual(detail.shot_visual_bindings, [])
  assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE shot_id=?', trashed.id), oldBinding)
  const state = scriptCanvasPreparationSnapshot(p, [scene.id], {
    script: () => ({ outline: '', characters: '', scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', p) }),
  })
  assert.deepEqual(state.shots.map(value => value.id), [active.id])
  assert.deepEqual(state.visuals.shot_visual_bindings, [])
})

test('recycled candidates cannot start analysis, reviews or downloads, including prepared downloads', async () => {
  const p = await project(), image = await asset(p, 'image'), video = await asset(p, 'video')
  const download = await call<{ url: string }>('POST', `/api/projects/${p}/asset-downloads`, { asset_ids: [image] })
  run('UPDATE assets SET deleted_at=? WHERE project_id=?', now(), p)
  for (const [url, payload] of [
    [`/api/projects/${p}/canvas/image-prompt-analysis`, { asset_id: image, model_id: 'no-provider-call' }],
    [`/api/projects/${p}/canvas/video-prompt-analysis`, { asset_id: video, model_id: 'no-provider-call' }],
    [`/api/projects/${p}/assets/${video}/video-reviews`, { model_id: 'no-provider-call' }],
  ] as const) {
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /当前项目/)
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${p}/asset-downloads`, payload: { asset_ids: [image] } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: download.url })).statusCode, 404)
})

test('new editing cuts and project music cannot reference recycled candidate assets', async () => {
  const p = await project(), image = await asset(p, 'image'), audio = await asset(p, 'audio')
  const cut = await call<EditingCut>('POST', `/api/projects/${p}/editing-cuts`, { name: '独立预告' })
  run('UPDATE assets SET deleted_at=? WHERE project_id=?', now(), p)
  const { id: _id, project_id: _project, created_at: _created, updated_at: _updated, ...input } = cut
  const edited: EditingCutInput = { ...input, clips: [{ id: 'clip', asset_id: image, title: '回收素材', in_ms: 0, out_ms: 1000, source_audio_gain: 0, source_audio_fade_ms: 0 }] }
  const response = await app.inject({ method: 'PUT', url: `/api/projects/${p}/editing-cuts/${cut.id}`, payload: edited })
  assert.equal(response.statusCode, 422, response.body)
  assert.equal((await call<EditingCut>('GET', `/api/projects/${p}/editing-cuts/${cut.id}`)).revision, 1)
  const music = await app.inject({ method: 'PUT', url: `/api/projects/${p}/audio-settings`, payload: {
    music_asset_id: audio, music_gain: 0.24, duck_music: true, duck_source: true,
  } })
  assert.equal(music.statusCode, 400, music.body)
  assert.equal(one<{ music_asset_id: string | null }>('SELECT music_asset_id FROM projects WHERE id=?', p)!.music_asset_id, null)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
