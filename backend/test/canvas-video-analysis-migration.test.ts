import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'canvas-video-analysis-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, all, one } = await import('../src/infrastructure/database/db.js')
initDb()
run("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','测试','now','now')")
initDb()
run("INSERT INTO project_canvases (id,project_id,name,position,is_default,created_at,updated_at) VALUES ('secondary','project','独立画布',1,0,'now','now')")
run(`INSERT INTO canvas_nodes (id,project_id,canvas_id,position,type,x,y,width,height,title,text,settings)
  VALUES ('note','project','secondary',0,'text',12,34,300,200,'手工笔记','保留全部文字','{"custom":"retained"}'),
    ('generator','project','secondary',1,'generation',500,34,300,200,'图片节点','','{}')`)
run(`INSERT INTO canvas_edges (id,project_id,canvas_id,position,source,target,reference_asset_id)
  VALUES ('snapshot','project','secondary',0,'note','generator','deleted-asset-snapshot')`)

// Recreate the immediately preceding production schema, keeping all later
// columns and indexes. This tests upgrades after multiple canvases were added.
const schema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='canvas_nodes'")!.sql
const indexes = all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='canvas_nodes' AND sql IS NOT NULL")
db.pragma('foreign_keys = OFF')
db.transaction(() => {
  db.exec(schema.replace(/CREATE TABLE\s+(?:"canvas_nodes"|canvas_nodes)/i, 'CREATE TABLE canvas_nodes_legacy').replace(", 'video_analysis'", ''))
  db.exec('INSERT INTO canvas_nodes_legacy SELECT * FROM canvas_nodes')
  db.exec('DROP TABLE canvas_nodes')
  db.exec('ALTER TABLE canvas_nodes_legacy RENAME TO canvas_nodes')
  for (const index of indexes) db.exec(index.sql)
})()
db.pragma('foreign_keys = ON')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('video analysis migration retains every existing node, canvas assignment, edge snapshot and index', () => {
  const beforeNodes = all('SELECT * FROM canvas_nodes'), beforeEdges = all('SELECT * FROM canvas_edges')
  initDb()
  assert.deepEqual(all('SELECT * FROM canvas_nodes'), beforeNodes)
  assert.deepEqual(all('SELECT * FROM canvas_edges'), beforeEdges)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
  const afterIndexes = all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='canvas_nodes' AND sql IS NOT NULL")
  assert.deepEqual(afterIndexes, indexes)
  run(`INSERT INTO canvas_nodes (id,project_id,canvas_id,position,type,x,y,width,height,title,text,settings)
    VALUES ('analysis','project','secondary',2,'video_analysis',900,34,420,500,'视频反推','分析结果','{}')`)
  const upgraded = all('SELECT * FROM canvas_nodes')
  initDb()
  assert.deepEqual(all('SELECT * FROM canvas_nodes'), upgraded)
  assert.deepEqual(all('SELECT * FROM canvas_edges'), beforeEdges)
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
  run("DELETE FROM canvas_nodes WHERE id='note'")
  assert.deepEqual(all('SELECT * FROM canvas_edges'), [], 'foreign-key edge deletion still works after the table migration')
})
