import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'visual-binding-sync-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, all, one, run } = await import('../src/infrastructure/database/db.js')
initDb()
run("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','迁移测试','now','now')")
for (const id of ['board', 'selected']) {
  run("INSERT INTO shots (id,project_id,position,title,created_at) VALUES (?,'project',0,?,'now')", id, id)
}
run(`INSERT INTO visual_profiles (id,project_id,kind,name,variant,definition,view_requirements,revision,created_at,updated_at)
  VALUES ('profile','project','character','主角','常服','保留定义','侧面',1,'now','now')`)
for (const id of ['board', 'selected']) {
  run(`INSERT INTO shot_visual_bindings
    (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements,reference_assets,usage)
    VALUES (?,'profile',0,1,'character','主角','常服','保留定义','侧面',?,'video')`, id,
  id === 'selected' ? '[{"id":"manual","asset_id":"old-image","revision":1,"view":"side","purpose":"costume","label":"手选图","style_version":null}]' : '[]')
}
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('legacy reference selections stay manual while ordinary boards default to following confirmed updates', () => {
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN sync_mode')
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN reference_selection')
  const before = all<Record<string, unknown>>('SELECT * FROM shot_visual_bindings ORDER BY shot_id')
  initDb()
  const migrated = all<Record<string, unknown>>('SELECT * FROM shot_visual_bindings ORDER BY shot_id')
  for (const [index, binding] of migrated.entries()) {
    const { sync_mode, reference_selection, ...original } = binding
    assert.deepEqual(original, before[index])
    assert.equal(sync_mode, 'follow')
    assert.equal(reference_selection, binding.shot_id === 'selected' ? 'manual' : 'auto')
  }
  run("UPDATE shot_visual_bindings SET sync_mode='locked' WHERE shot_id='selected'")
  const locked = all('SELECT * FROM shot_visual_bindings ORDER BY shot_id')
  initDb()
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings ORDER BY shot_id'), locked, 'restarting never resets manual choices or locks')
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

function legacyForeignKey() {
  const schema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='shot_visual_bindings'")!.sql
  db.transaction(() => {
    db.exec(schema.replace(/CREATE TABLE\s+(?:"shot_visual_bindings"|shot_visual_bindings)/i, 'CREATE TABLE binding_legacy')
      .replace(/REFERENCES visual_profiles\(id\) ON DELETE CASCADE/i, 'REFERENCES visual_profiles(id) ON DELETE RESTRICT'))
    db.exec('INSERT INTO binding_legacy SELECT * FROM shot_visual_bindings')
    db.exec('DROP TABLE shot_visual_bindings')
    db.exec('ALTER TABLE binding_legacy RENAME TO shot_visual_bindings')
  })()
}

test('foreign-key repair retains saved follow modes and manual selections', () => {
  const before = all('SELECT * FROM shot_visual_bindings ORDER BY shot_id')
  legacyForeignKey()
  initDb()
  assert.deepEqual(all('SELECT * FROM shot_visual_bindings ORDER BY shot_id'), before)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})

test('foreign-key repair also upgrades legacy selections without sync fields', () => {
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN sync_mode')
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN reference_selection')
  legacyForeignKey()
  initDb()
  assert.equal(one<{ reference_selection: string }>("SELECT reference_selection FROM shot_visual_bindings WHERE shot_id='selected'")!.reference_selection, 'manual')
  assert.equal(one<{ sync_mode: string }>("SELECT sync_mode FROM shot_visual_bindings WHERE shot_id='board'")!.sync_mode, 'follow')
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})
