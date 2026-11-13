import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

const testData = await mkdtemp(join(tmpdir(), 'storyboard-design-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
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
  CREATE TABLE visual_profiles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, name TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '默认',
    definition TEXT NOT NULL, view_requirements TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    board_asset_id TEXT, asset_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(project_id,kind,name,variant)
  );
  INSERT INTO projects (id,name,created_at,updated_at) VALUES ('legacy-design-project','已有制作项目','2026-01-01','2026-01-01');
  INSERT INTO shots (id,project_id,position,title,prompt,duration,created_at)
    VALUES ('legacy-design-shot','legacy-design-project',0,'旧镜头','旧镜头内容',12,'2026-01-01');
  INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at)
    VALUES ('legacy-design-profile','legacy-design-project','character','主角','旧外貌定义','三视图','2026-01-01','2026-01-01');
`)
legacy.close()

const { db, initDb, all, one } = await import('../src/infrastructure/database/db.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

test('design migration preserves legacy shots and profiles as the active legacy scheme and is repeatable', () => {
  const shot = one<any>('SELECT * FROM shots WHERE id=?', 'legacy-design-shot')!
  const profile = one<any>('SELECT * FROM visual_profiles WHERE id=?', 'legacy-design-profile')!
  assert.equal(shot.prompt, '旧镜头内容'); assert.equal(shot.duration, 12)
  assert.equal(shot.design_id, null); assert.equal(shot.superseded_by, null)
  assert.equal(profile.definition, '旧外貌定义'); assert.equal(profile.design_id, null)
  assert.deepEqual(all('SELECT * FROM storyboard_designs'), [])
  assert.equal(all('SELECT * FROM project_canvases WHERE project_id=?', 'legacy-design-project').length, 1)
  initDb()
  assert.deepEqual(one('SELECT * FROM shots WHERE id=?', shot.id), shot)
  assert.deepEqual(one('SELECT * FROM visual_profiles WHERE id=?', profile.id), profile)
  for (const [table, fields] of [['shots', ['design_id', 'superseded_by']], ['visual_profiles', ['design_id']]] as const) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    for (const field of fields) assert.equal(columns.filter(column => column.name === field).length, 1)
  }
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('the pending-canvas migration is repeatable and distinguishes unattached plans from deleted canvases', () => {
  db.prepare(`INSERT INTO storyboard_designs (id,project_id,canvas_id,name,scene_ids,created_at)
    VALUES ('legacy-deleted-design','legacy-design-project',NULL,'已删除画布的旧方案','[]','2026-01-01')`).run()
  db.prepare(`INSERT INTO storyboard_designs (id,project_id,canvas_id,canvas_pending,name,scene_ids,created_at)
    VALUES ('new-pending-design','legacy-design-project',NULL,1,'尚未加入画布的新方案','[]','2026-01-02')`).run()
  initDb(); initDb()
  assert.equal(one<any>('SELECT canvas_pending FROM storyboard_designs WHERE id=?', 'legacy-deleted-design')!.canvas_pending, 0)
  assert.equal(one<any>('SELECT canvas_pending FROM storyboard_designs WHERE id=?', 'new-pending-design')!.canvas_pending, 1)
  assert.equal(one<any>('SELECT source_fingerprints FROM storyboard_designs WHERE id=?', 'legacy-deleted-design')!.source_fingerprints, '{}')
  const columns = db.pragma('table_info(storyboard_designs)') as Array<{ name: string }>
  assert.equal(columns.filter(column => column.name === 'canvas_pending').length, 1)
  assert.equal(columns.filter(column => column.name === 'source_fingerprints').length, 1)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})
