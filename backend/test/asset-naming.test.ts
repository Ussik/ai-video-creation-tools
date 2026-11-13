import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'
import type { Asset as PublicAsset } from '@video-studio/shared/api/contracts'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-asset-naming-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const legacyPath = join(testData, 'legacy.png')
await writeFile(legacyPath, Buffer.from('legacy-image'))
const legacy = new Database(join(testData, 'studio.db'))
legacy.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '', ratio TEXT NOT NULL DEFAULT '16:9',
    music_asset_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 5, selected_asset_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
    kind TEXT NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL,
    source TEXT NOT NULL, model_id TEXT, prompt TEXT, remote_url TEXT, created_at TEXT NOT NULL
  );
  INSERT INTO projects (id,name,created_at,updated_at) VALUES ('legacy-project','已有项目','2026-01-01','2026-01-01');
`)
legacy.prepare(`INSERT INTO assets (id,project_id,kind,filename,path,source,created_at)
  VALUES ('legacy-asset','legacy-project','image','legacy.png',?,'generated','2026-01-01')`).run(legacyPath)
legacy.close()

const { buildApp } = await import('../src/app.js')
const { all, db, initDb, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function project() {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '素材命名' } })
  assert.equal(response.statusCode, 200)
  return response.json<{ id: string }>().id
}

async function asset(projectId: string, options: { kind?: PublicAsset['kind']; source?: PublicAsset['source']; shotId?: string } = {}) {
  const id = newId(), path = join(testData, id), content = Buffer.from(`original-${id}`)
  await writeFile(path, content)
  run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,prompt,remote_url,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, id, projectId, options.shotId || null, options.kind || 'image', `${id}.png`, path,
  options.source || 'generated', '原始提示词', 'https://example.invalid/original', now())
  return { id, path, content }
}

async function rename(id: string, display_name: unknown) {
  return app.inject({ method: 'PATCH', url: `/api/assets/${id}`, payload: { display_name } })
}

test('old assets migrate without losing media and custom names persist through repeated initialization', async () => {
  const initial = await app.inject({ method: 'GET', url: '/api/projects/legacy-project' })
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.json<{ assets: PublicAsset[] }>().assets[0]!.display_name, null)

  const response = await rename('legacy-asset', '  傩面 · 夜景  ')
  assert.equal(response.statusCode, 200, response.body)
  const renamed = response.json<PublicAsset>()
  assert.equal(renamed.display_name, '傩面 · 夜景')
  assert.equal(renamed.filename, 'legacy.png')
  assert.equal(renamed.url, '/api/assets/legacy-asset/file')
  assert.equal('path' in renamed, false)
  initDb(); initDb()

  const detail = await app.inject({ method: 'GET', url: '/api/projects/legacy-project' })
  assert.equal(detail.json<{ assets: PublicAsset[] }>().assets[0]!.display_name, '傩面 · 夜景')
  assert.equal((all<{ name: string }>('PRAGMA table_info(assets)')).filter(column => column.name === 'display_name').length, 1)
  const media = await app.inject({ method: 'GET', url: renamed.url })
  assert.equal(media.statusCode, 200)
  assert.deepEqual(media.rawPayload, await readFile(legacyPath))
})

test('renaming preserves storage, saved status, shot selection and timeline references', async () => {
  const projectId = await project()
  const shotResponse = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/shots`, payload: { title: '原始分镜' } })
  assert.equal(shotResponse.statusCode, 200)
  const shotId = shotResponse.json<{ id: string }>().id
  const file = await asset(projectId, { shotId })
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', file.id, shotId)
  run('INSERT INTO saved_assets (asset_id,project_id,created_at) VALUES (?,?,?)', file.id, projectId, now())
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,in_ms,out_ms) VALUES (?,?,?,?,0,5000)', newId(), projectId, shotId, file.id)
  run('UPDATE projects SET updated_at=? WHERE id=?', '2026-01-01', projectId)
  const before = one<Record<string, unknown>>('SELECT * FROM assets WHERE id=?', file.id)!
  const shotBefore = one('SELECT * FROM shots WHERE id=?', shotId)
  const clipBefore = one('SELECT * FROM timeline_clips WHERE shot_id=?', shotId)

  const response = await rename(file.id, '蓝色傩面三视图')
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json<PublicAsset>().saved, true)
  assert.deepEqual(one('SELECT * FROM assets WHERE id=?', file.id), { ...before, display_name: '蓝色傩面三视图' })
  assert.deepEqual(one('SELECT * FROM shots WHERE id=?', shotId), shotBefore)
  assert.deepEqual(one('SELECT * FROM timeline_clips WHERE shot_id=?', shotId), clipBefore)
  assert.deepEqual(await readFile(file.path), file.content)
  assert.notEqual(one<{ updated_at: string }>('SELECT updated_at FROM projects WHERE id=?', projectId)!.updated_at, '2026-01-01')
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('custom names apply to generated, uploaded and exported assets of every media kind', async () => {
  const projectId = await project()
  for (const [kind, source] of [['image', 'generated'], ['video', 'upload'], ['audio', 'generated'], ['text', 'export']] as const) {
    const file = await asset(projectId, { kind, source })
    const response = await rename(file.id, `${kind} 素材`)
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json<PublicAsset>()
    assert.equal(result.display_name, `${kind} 素材`)
    assert.equal(result.kind, kind)
    assert.equal(result.source, source)
    if (kind === 'text') assert.equal(result.text, file.content.toString())
  }
})

test('invalid names and unrelated patch fields cannot overwrite a valid custom name', async () => {
  const file = await asset(await project())
  assert.equal((await rename(file.id, '原名')).statusCode, 200)
  for (const name of ['', '   ', '\u3000', '名'.repeat(121), null, 42, '傩\u0000面', '\n傩面', '傩面\t', '傩\u007f面', '傩\u0085面']) {
    const response = await rename(file.id, name)
    assert.equal(response.statusCode, 422, JSON.stringify(name))
    assert.equal(one<{ display_name: string }>('SELECT display_name FROM assets WHERE id=?', file.id)!.display_name, '原名')
  }
  for (const payload of [{}, { display_name: '新名', filename: 'changed.png' }]) {
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/assets/${file.id}`, payload })).statusCode, 422)
  }
  assert.equal((await rename(file.id, ` ${'名'.repeat(120)} `)).statusCode, 200)
})

test('missing and recycled assets cannot be renamed', async () => {
  assert.equal((await rename('missing-asset', '名称')).statusCode, 404)
  const file = await asset(await project())
  run('UPDATE assets SET deleted_at=? WHERE id=?', now(), file.id)
  assert.equal((await rename(file.id, '名称')).statusCode, 404)
  assert.equal(one<{ display_name: string | null }>('SELECT display_name FROM assets WHERE id=?', file.id)!.display_name, null)
})
