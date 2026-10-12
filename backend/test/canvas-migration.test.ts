import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-canvas-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData

const legacy = new Database(join(testData, 'studio.db'))
legacy.pragma('foreign_keys = OFF')
legacy.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
    ratio TEXT NOT NULL DEFAULT '16:9', music_asset_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE canvas_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'generation')),
    x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
    title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
    asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
    model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
    UNIQUE (project_id, id)
  );
  CREATE TABLE canvas_edges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source TEXT NOT NULL, target TEXT NOT NULL,
    FOREIGN KEY (project_id, source) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, target) REFERENCES canvas_nodes(project_id, id) ON DELETE CASCADE
  );
  INSERT INTO projects (id, name, created_at, updated_at)
    VALUES ('legacy-project', '旧画布项目', '2026-01-01', '2026-01-01');
  INSERT INTO canvas_nodes (id, project_id, position, type, x, y, width, height, title, text)
    VALUES ('note', 'legacy-project', 0, 'text', 0, 0, 200, 140, '设定', '旧内容'),
           ('reference', 'legacy-project', 1, 'image', 260, 0, 200, 140, '参考图', '');
  INSERT INTO canvas_edges (id, project_id, position, source, target)
    VALUES ('old-edge', 'legacy-project', 0, 'note', 'reference');
`)
legacy.close()

const { buildApp } = await import('../src/app.js')
const { db, initDb, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

test('legacy canvas nodes gain job references without losing nodes or edges', async () => {
  const columns = db.pragma('table_info(canvas_nodes)') as Array<{ name: string }>
  assert.equal(columns.filter(column => column.name === 'job_id').length, 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])

  const url = '/api/projects/legacy-project/canvas'
  const beforeResponse = await app.inject({ method: 'GET', url })
  assert.equal(beforeResponse.statusCode, 200, beforeResponse.body)
  const before = beforeResponse.json<{
    nodes: Array<Record<string, unknown>>
    edges: Array<{ id: string; source: string; target: string }>
    revision: string
  }>()
  assert.deepEqual(before.nodes.map(node => node.id), ['note', 'reference'])
  assert.equal(before.nodes[0]?.text, '旧内容')
  assert.equal(before.nodes[0]?.job_id, null)
  assert.deepEqual(before.edges, [{ id: 'old-edge', source: 'note', target: 'reference' }])

  run(`INSERT INTO jobs (id, project_id, job_type, request, status, created_at, updated_at)
    VALUES ('legacy-canvas-job', 'legacy-project', 'generation', '{}', 'succeeded', '2026-01-01', '2026-01-01')`)
  const graph = {
    nodes: [...before.nodes, {
      id: 'generator', type: 'generation', x: 520, y: 0, width: 280, height: 200,
      title: '视频生成', job_id: 'legacy-canvas-job', prompt: '雨夜走廊', settings: {},
    }, {
      id: 'script-ref', type: 'project_script_ref', x: 860, y: 0, width: 360, height: 240,
      title: '项目剧本', text: '', settings: {},
    }],
    edges: [...before.edges,
      { id: 'new-edge', source: 'reference', target: 'generator' },
      { id: 'script-edge', source: 'generator', target: 'script-ref' },
    ],
    revision: before.revision,
  }
  const savedResponse = await app.inject({ method: 'PUT', url, payload: graph })
  assert.equal(savedResponse.statusCode, 200, savedResponse.body)
  const saved = savedResponse.json<{ nodes: Array<{ id: string; type: string; job_id: string | null }>; edges: unknown[] }>()
  assert.deepEqual(saved.nodes.map(node => node.id), ['note', 'reference', 'generator', 'script-ref'])
  assert.equal(saved.nodes[3]?.type, 'project_script_ref')
  assert.equal(saved.nodes[2]?.job_id, 'legacy-canvas-job')
  assert.equal(saved.edges.length, 3)
  assert.deepEqual(db.pragma('foreign_key_check'), [])

  initDb()
  assert.equal((db.pragma('table_info(canvas_nodes)') as Array<{ name: string }>).filter(column => column.name === 'job_id').length, 1)
  assert.equal(one<{ job_id: string }>('SELECT job_id FROM canvas_nodes WHERE id=?', 'generator')?.job_id, 'legacy-canvas-job')
  assert.equal(one<{ type: string }>('SELECT type FROM canvas_nodes WHERE id=?', 'script-ref')?.type, 'project_script_ref')
  run('DELETE FROM jobs WHERE id=?', 'legacy-canvas-job')
  assert.equal(one<{ job_id: string | null }>('SELECT job_id FROM canvas_nodes WHERE id=?', 'generator')?.job_id, null)
  assert.equal(one<{ source: string }>('SELECT source FROM canvas_edges WHERE id=?', 'script-edge')?.source, 'generator')
})
