import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { DirectorTaskSnapshot } from '../src/modules/script/director-tasks.js'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-project-deletion-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { all, db, initDb, mediaDir, now, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

run(`INSERT INTO providers (id, name, adapter, base_url, created_at)
  VALUES ('shared-provider', '测试', 'http', 'https://example.invalid', ?)`, now())
run(`INSERT INTO models (id, provider_id, name, remote_id, modality, protocol)
  VALUES ('shared-model', 'shared-provider', '测试', 'test', 'video', 'async_video')`)

// Each project exercises the complete reference graph, including pinned older boards.
async function seedProject(id: string) {
  const stamp = now()
  const key = (suffix: string) => `${id}-${suffix}`
  const file = join(mediaDir, id, 'fixture.txt')
  await mkdir(join(mediaDir, id), { recursive: true })
  await writeFile(file, id)
  db.transaction(() => {
    run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', id, id, stamp, stamp)
    run('INSERT INTO project_canvases (id, project_id, name, position, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)', id, id, '画布 1', stamp, stamp)
    run('INSERT INTO scripts (project_id, outline, characters, updated_at) VALUES (?, ?, ?, ?)', id, '大纲', '人物', stamp)
    run(`INSERT INTO script_scenes (id, project_id, position, heading, created_at, updated_at)
      VALUES (?, ?, 0, '场次', ?, ?)`, key('scene'), id, stamp, stamp)
    run(`INSERT INTO script_conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`, key('conversation'), id, stamp, stamp)
    run(`INSERT INTO script_messages (id, conversation_id, position, role, text, created_at)
      VALUES (?, ?, 0, 'assistant', '内容', ?)`, key('message'), key('conversation'), stamp)
    run(`INSERT INTO script_reply_classifications (project_id, message_id, text_hash, classification, model_id, created_at)
      VALUES (?, ?, 'hash', '{}', 'shared-model', ?)`, id, key('message'), stamp)
    run(`INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, created_at, updated_at)
      VALUES (?, ?, 'characters', '人物设定', '内容', ?, ?)`, key('artifact'), id, stamp, stamp)
    for (const suffix of ['shot', 'next-shot']) {
      run(`INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at)
        VALUES (?, ?, ?, '镜头', ?, ?)`, key(suffix), id, Number(suffix === 'next-shot'), key('scene'), stamp)
    }
    run(`INSERT INTO shot_plan_requests (request_id, project_id, payload_hash, shot_ids, created_at)
      VALUES (?, ?, 'hash', ?, ?)`, key('plan'), id, JSON.stringify([key('shot')]), stamp)
    run('INSERT INTO production_ranges (project_id, start_shot_id, end_shot_id) VALUES (?, ?, ?)', id, key('shot'), key('next-shot'))
    for (const suffix of ['old-board', 'new-board', 'side-reference', 'face-reference', 'video']) {
      run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, created_at)
        VALUES (?, ?, ?, ?, 'fixture.txt', ?, 'generated', 'shared-model', ?)`,
        key(suffix), id, key('shot'), suffix === 'video' ? 'video' : 'image', file, stamp)
    }
    run('UPDATE projects SET music_asset_id=? WHERE id=?', key('video'), id)
    run('UPDATE shots SET selected_asset_id=? WHERE id=?', key('video'), key('shot'))
    run('INSERT INTO saved_assets (asset_id, project_id, created_at) VALUES (?, ?, ?)', key('old-board'), id, stamp)
    run(`INSERT INTO asset_reviews (shot_id, asset_id, status, updated_at) VALUES (?, ?, 'approved', ?)`, key('shot'), key('video'), stamp)
    run(`INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, out_ms, source_duration_ms)
      VALUES (?, ?, ?, ?, 5000, 5000)`, key('clip'), id, key('shot'), key('video'))
    run(`INSERT INTO cut_reviews (project_id, from_shot_id, to_shot_id, status, signature, updated_at)
      VALUES (?, ?, ?, 'approved', 'hash', ?)`, id, key('shot'), key('next-shot'), stamp)
    run(`INSERT INTO continuity_analyses (project_id, model_id, signature, issues, updated_at)
      VALUES (?, 'shared-model', 'hash', '[]', ?)`, id, stamp)
    run(`INSERT INTO jobs (id, project_id, shot_id, model_id, job_type, status, result_asset_id, created_at, updated_at)
      VALUES (?, ?, ?, 'shared-model', 'generation', 'succeeded', ?, ?, ?)`, key('job'), id, key('shot'), key('new-board'), stamp, stamp)
    run(`INSERT INTO job_image_recovery (job_id, result_url_ciphertext, created_at) VALUES (?, 'fixture', ?)`, key('job'), stamp)
    run(`INSERT INTO asset_tasks (id, project_id, focus_artifact, status, generation_job_id, result_asset_id, created_at, updated_at)
      VALUES (?, ?, 'character', 'ready', ?, ?, ?, ?)`, key('task'), id, key('job'), key('new-board'), stamp, stamp)
    run(`INSERT INTO asset_task_events (id, task_id, stage, message, created_at)
      VALUES (?, ?, 'ready', '完成', ?)`, key('event'), key('task'), stamp)
    run(`INSERT INTO visual_profiles (id, project_id, kind, name, definition, view_requirements, revision, board_asset_id, asset_task_id, created_at, updated_at)
      VALUES (?, ?, 'character', '人物', '新版设定', '正侧背', 3, ?, ?, ?, ?)`, key('profile'), id, key('new-board'), key('task'), stamp, stamp)
    run('INSERT INTO scene_visual_bindings (scene_id, profile_id) VALUES (?, ?)', key('scene'), key('profile'))
    for (const suffix of ['old-board', 'new-board']) {
      run('INSERT INTO visual_profile_candidates (profile_id, asset_id, archived, updated_at) VALUES (?, ?, ?, ?)', key('profile'), key(suffix), Number(suffix === 'old-board'), stamp)
    }
    const references = [
      { id: key('reference-side'), asset_id: key('side-reference'), view: 'side', purpose: 'costume', label: '侧面雨衣', revision: 2, style_version: 'a'.repeat(64) },
      { id: key('reference-face'), asset_id: key('face-reference'), view: 'face', purpose: 'identity', label: '面部特写', revision: 2, style_version: 'a'.repeat(64) },
    ]
    for (const reference of references) run(`INSERT INTO visual_profile_reference_assets
      (id,profile_id,asset_id,revision,style_version,view,purpose,label,status,is_default,source_asset_id,source_job_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'confirmed',1,?,?,?,?)`, reference.id, key('profile'), reference.asset_id, reference.revision,
      reference.style_version, reference.view, reference.purpose, reference.label, key('old-board'), key('job'), stamp, stamp)
    run(`INSERT INTO shot_visual_bindings (shot_id, profile_id, required, revision, kind, name, variant, definition, view_requirements, board_asset_id, board_style_version, reference_assets)
      VALUES (?, ?, 0, 2, 'character', '人物', '雨衣', '镜头保存的旧版设定', '正侧背与细节', ?, ?, ?)`, key('shot'), key('profile'), key('old-board'), 'a'.repeat(64), JSON.stringify(references))
    for (const nodeId of ['reference', 'generator']) {
      run(`INSERT INTO canvas_nodes (id, project_id, canvas_id, position, type, x, y, width, height, asset_id, shot_id, model_id, job_id)
        VALUES (?, ?, ?, ?, ?, 0, 0, 280, 200, ?, ?, 'shared-model', ?)`,
        nodeId, id, id, Number(nodeId === 'generator'), nodeId === 'generator' ? 'generation' : 'image', key('old-board'), key('shot'), key('job'))
    }
    run(`INSERT INTO canvas_edges (id, project_id, canvas_id, position, source, target, reference_asset_id)
      VALUES ('reference-edge', ?, ?, 0, 'reference', 'generator', ?)`, id, id, key('old-board'))
  })()
  return { id, file, shotId: key('shot'), profileId: key('profile'), jobId: key('job') }
}

function databaseRows() {
  const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return Object.fromEntries(tables.map(({ name }) => [name, all(`SELECT * FROM "${name}" ORDER BY rowid`)]))
}

// Reproduce the schema shipped before profile deletion was changed to CASCADE.
function restoreLegacyBindingConstraint() {
  const schema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='shot_visual_bindings'")!.sql
  assert.match(schema, /profile_id TEXT NOT NULL REFERENCES visual_profiles\(id\) ON DELETE CASCADE/)
  db.transaction(() => {
    db.exec(schema.replace(/CREATE TABLE "?shot_visual_bindings"?/, 'CREATE TABLE legacy_shot_visual_bindings')
      .replace('REFERENCES visual_profiles(id) ON DELETE CASCADE', 'REFERENCES visual_profiles(id) ON DELETE RESTRICT'))
    db.exec(`INSERT INTO legacy_shot_visual_bindings SELECT * FROM shot_visual_bindings;
      DROP TABLE shot_visual_bindings;
      ALTER TABLE legacy_shot_visual_bindings RENAME TO shot_visual_bindings;`)
  })()
}

test('deleting a linked project cascades every owned row and media without touching another project or shared configuration', async () => {
  const kept = await seedProject('kept')
  const expectedRows = databaseRows()
  const removed = await seedProject('fresh')
  const response = await app.inject({ method: 'DELETE', url: `/api/projects/${removed.id}` })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { ok: true })
  assert.deepEqual(databaseRows(), expectedRows)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  await assert.rejects(access(join(mediaDir, removed.id)), { code: 'ENOENT' })
  assert.equal(await readFile(kept.file, 'utf8'), kept.id)
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${removed.id}` })).statusCode, 404)
})

test('batch deletion removes selected projects and their complete reference graphs, deduplicating IDs', async () => {
  const expectedRows = databaseRows()
  const first = await seedProject('batch-first'), second = await seedProject('batch-second')
  const response = await app.inject({ method: 'POST', url: '/api/projects/batch-delete',
    payload: { project_ids: [first.id, second.id, first.id] } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), { ok: true, deleted_ids: [first.id, second.id] })
  assert.deepEqual(databaseRows(), expectedRows, 'unselected projects and shared settings are preserved')
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  for (const project of [first, second]) await assert.rejects(access(join(mediaDir, project.id)), { code: 'ENOENT' })
})

test('batch deletion rejects invalid or missing IDs before deleting any selected project', async () => {
  const project = await seedProject('batch-invalid')
  const expectedRows = databaseRows()
  for (const payload of [{ project_ids: [] }, { project_ids: [' '] }, { project_ids: [123] },
    { project_ids: [project.id], unexpected: true }, { project_ids: [project.id, 'missing-project'] }]) {
    const response = await app.inject({ method: 'POST', url: '/api/projects/batch-delete', payload })
    assert.equal(response.statusCode, payload.project_ids.some(id => id === 'missing-project') ? 404 : 422, response.body)
    assert.deepEqual(databaseRows(), expectedRows)
    assert.equal(await readFile(project.file, 'utf8'), project.id)
  }
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })
})

test('batch deletion keeps the entire selection when any generation or director task is active', async () => {
  const idle = await seedProject('batch-idle'), active = await seedProject('batch-active')
  async function expectBlocked() {
    const expectedRows = databaseRows()
    const response = await app.inject({ method: 'POST', url: '/api/projects/batch-delete', payload: { project_ids: [idle.id, active.id] } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.json().detail, /batch-active.*进行中/)
    assert.deepEqual(databaseRows(), expectedRows)
    for (const project of [idle, active]) assert.equal(await readFile(project.file, 'utf8'), project.id)
  }
  for (const status of ['queued', 'running']) {
    run('UPDATE jobs SET status=? WHERE id=?', status, active.jobId)
    await expectBlocked()
  }
  run("UPDATE jobs SET status='succeeded' WHERE id=?", active.jobId)
  const snapshot: DirectorTaskSnapshot = { id: 'batch-director', project_id: active.id, conversation_id: `${active.id}-conversation`,
    message_id: 'reply', status: 'running', started_at: Date.now(), events: [],
    execution: { title: '删除保护测试', request: '本地夹具任务', started_at: Date.now(), mode: 'script' } }
  run(`INSERT INTO script_director_tasks (id, project_id, conversation_id, user_message_id, message_id, request_hash, status, snapshot, created_at, updated_at)
    VALUES ('batch-director', ?, ?, 'user', 'reply', 'hash', 'running', ?, ?, ?)`, active.id, snapshot.conversation_id, JSON.stringify(snapshot), now(), now())
  await expectBlocked()
  const single = await app.inject({ method: 'DELETE', url: `/api/projects/${active.id}` })
  assert.equal(single.statusCode, 422, single.body)
  run("UPDATE script_director_tasks SET status='cancelled' WHERE id='batch-director'")
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/batch-delete', payload: { project_ids: [idle.id, active.id] } })).statusCode, 200)
})

test('batch deletion rolls back every database change if a later project cannot be deleted', async () => {
  const first = await seedProject('batch-rollback-first'), second = await seedProject('batch-rollback-second')
  const expectedRows = databaseRows()
  db.exec(`CREATE TRIGGER reject_batch_delete BEFORE DELETE ON projects
    WHEN OLD.id='batch-rollback-second' BEGIN SELECT RAISE(ABORT, 'fixture delete failure'); END`)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/projects/batch-delete', payload: { project_ids: [first.id, second.id] } })
    assert.equal(response.statusCode, 500, response.body)
    assert.deepEqual(databaseRows(), expectedRows)
    for (const project of [first, second]) assert.equal(await readFile(project.file, 'utf8'), project.id)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally { db.exec('DROP TRIGGER reject_batch_delete') }
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects/batch-delete', payload: { project_ids: [first.id, second.id] } })).statusCode, 200)
})

test('legacy RESTRICT bindings migrate without changing snapshots and project deletion succeeds after restart', async () => {
  const expectedRows = databaseRows()
  const project = await seedProject('legacy')
  restoreLegacyBindingConstraint()
  const beforeMigration = databaseRows()
  const frozen = one<{ board_style_version: string; reference_assets: string }>('SELECT board_style_version, reference_assets FROM shot_visual_bindings WHERE shot_id=?', project.shotId)!
  assert.equal(frozen.board_style_version, 'a'.repeat(64))
  assert.deepEqual(JSON.parse(frozen.reference_assets).map((reference: { view: string }) => reference.view), ['side', 'face'])
  assert.throws(() => run('DELETE FROM projects WHERE id=?', project.id), { code: 'SQLITE_CONSTRAINT_TRIGGER' })
  assert.deepEqual(databaseRows(), beforeMigration, 'failed deletion is atomic')
  assert.deepEqual(db.pragma('foreign_key_check'), [])

  // buildApp runs the same migration when the backend restarts.
  const restartedApp = buildApp()
  try {
    assert.deepEqual(databaseRows(), beforeMigration, 'all snapshots and candidate selections survive migration')
    assert.deepEqual(one('SELECT board_style_version, reference_assets FROM shot_visual_bindings WHERE shot_id=?', project.shotId), frozen)
    const foreignKeys = db.pragma('foreign_key_list(shot_visual_bindings)') as Array<{ from: string; on_delete: string }>
    assert.equal(foreignKeys.find(key => key.from === 'profile_id')?.on_delete, 'CASCADE')
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    initDb()
    assert.deepEqual(databaseRows(), beforeMigration, 'migration is idempotent')
    assert.deepEqual(db.pragma('foreign_key_check'), [])

    const protectedProfile = await restartedApp.inject({ method: 'DELETE', url: `/api/visual-profiles/${project.profileId}` })
    assert.equal(protectedProfile.statusCode, 422, protectedProfile.body)
    assert.match(protectedProfile.body, /已有镜头绑定此档案/)
    assert.deepEqual(databaseRows(), beforeMigration)
    const response = await restartedApp.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(databaseRows(), expectedRows)
    await assert.rejects(access(join(mediaDir, project.id)), { code: 'ENOENT' })
  } finally { await restartedApp.close() }
})

test('queued and running jobs block deletion and keep all project rows and media', async t => {
  for (const status of ['queued', 'running']) {
    await t.test(status, async () => {
      const expectedRows = databaseRows()
      const project = await seedProject(status)
      run('UPDATE jobs SET status=? WHERE id=?', status, project.jobId)
      const beforeDeletion = databaseRows()
      const response = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })
      assert.equal(response.statusCode, 422, response.body)
      assert.match(response.body, /项目还有进行中的任务/)
      assert.deepEqual(databaseRows(), beforeDeletion)
      assert.equal(await readFile(project.file, 'utf8'), project.id)
      run("UPDATE jobs SET status='failed' WHERE id=?", project.jobId)
      assert.equal((await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })).statusCode, 200)
      assert.deepEqual(databaseRows(), expectedRows)
    })
  }
})

test('a failed legacy migration rolls back its table rebuild and leaves foreign keys enabled', () => {
  restoreLegacyBindingConstraint()
  db.pragma('foreign_keys=OFF')
  try {
    run(`INSERT INTO shot_visual_bindings (shot_id, profile_id, revision, kind, name, variant, definition, view_requirements)
      VALUES ('missing-shot', 'missing-profile', 1, 'character', '孤立引用', '默认', '内容', '正侧背')`)
  } finally { db.pragma('foreign_keys=ON') }
  const beforeMigration = databaseRows()
  const beforeSchema = one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='shot_visual_bindings'")!.sql
  assert.throws(() => initDb(), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
  assert.deepEqual(databaseRows(), beforeMigration)
  assert.equal(one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='shot_visual_bindings'")!.sql, beforeSchema)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.equal(one("SELECT 1 FROM sqlite_master WHERE name='shot_visual_bindings_cascade'"), undefined)
  run('DELETE FROM shot_visual_bindings WHERE shot_id=?', 'missing-shot')
  initDb()
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('older RESTRICT schemas without optional reference columns migrate with safe defaults', async () => {
  const project = await seedProject('pre-reference-schema')
  restoreLegacyBindingConstraint()
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN board_style_version')
  db.exec('ALTER TABLE shot_visual_bindings DROP COLUMN reference_assets')
  const legacyRows = databaseRows()
  initDb()
  const expectedBindings = (legacyRows.shot_visual_bindings as Array<Record<string, unknown>>)
    .map(binding => ({ ...binding, board_style_version: null, reference_assets: '[]' }))
  assert.deepEqual(databaseRows(), { ...legacyRows, shot_visual_bindings: expectedBindings })
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  const response = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(one('SELECT 1 FROM visual_profile_reference_assets WHERE profile_id=?', project.profileId), undefined)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  await assert.rejects(access(join(mediaDir, project.id)), { code: 'ENOENT' })
})
