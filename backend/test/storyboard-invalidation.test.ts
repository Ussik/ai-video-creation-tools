import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { CanvasEdge, CanvasNode, Shot } from '../src/infrastructure/database/db.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-storyboard-invalidation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { all, db, initDb, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { invalidateStoryboardShot } = await import('../src/modules/storyboard/storyboard-invalidation.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture(reference: 'local' | 'remote' | 'dynamic') {
  const projectId = newId(), sourceShotId = newId(), targetShotId = newId(), assetId = newId(), jobId = newId()
  const timestamp = now(), remoteUrl = `https://cdn.example.test/${assetId}.mp4`, localUrl = `/api/assets/${assetId}/file`
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, '分镜失效回归', timestamp, timestamp)
  for (const [position, id] of [sourceShotId, targetShotId].entries()) {
    run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, created_at, image_prompt, video_prompt, storyboard_revision)
      VALUES (?, ?, ?, ?, ?, 8, ?, ?, ?, ?)`, id, projectId, position, '站台', '林晚在站台回望', timestamp, '新的首帧', '新的连续动作', position ? 3 : 0)
  }
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, remote_url, created_at)
    VALUES (?, ?, ?, 'video', 'old.mp4', '/missing/old.mp4', 'generated', ?, ?)`, assetId, projectId, sourceShotId, remoteUrl, timestamp)
  run(`INSERT INTO jobs (id, project_id, shot_id, job_type, request, status, result_asset_id, created_at, updated_at)
    VALUES (?, ?, ?, 'generation', '{"storyboard_revision":0}', 'succeeded', ?, ?, ?)`, jobId, projectId, sourceShotId, assetId, timestamp, timestamp)
  const sourceId = 'source', targetId = 'target', manualId = 'manual-card', manualTargetId = 'manual-target'
  function addNode(id: string, type: string, shotId: string | null, settings: Record<string, unknown>, asset: string | null = null, job: string | null = null) {
    run(`INSERT INTO canvas_nodes (id, project_id, position, type, x, y, width, height, title, text, prompt, shot_id, asset_id, job_id, settings)
      VALUES (?, ?, ?, ?, 120, 240, 640, 480, '原始节点', '原完整稿', '原提示词', ?, ?, ?, ?)`,
    id, projectId, all('SELECT id FROM canvas_nodes WHERE project_id=?', projectId).length, type, shotId, asset, job, JSON.stringify(settings))
  }
  addNode(sourceId, 'generation', sourceShotId, { modality: 'video', storyboard_revision: 0, prompt_override: true,
    prompt_is_final: true, prompt_document: true, prompt_sections: { version: 1, blocks: [{ id: 'body-1', kind: 'body', text: '旧结构文档' }] },
    prompt_base: '原稿', prompt_template: '原完整稿', prompt_body: '原整理正文', generation_completed_job_id: jobId }, assetId, jobId)
  addNode(targetId, 'generation', targetShotId, { modality: 'video', storyboard_revision: 3, mode: 'extend',
    ...(reference !== 'dynamic' ? { reference_video_url: reference === 'local' ? localUrl : remoteUrl } : {}) })
  // This independent card is an explicitly retained historical video, not the
  // output slot of the source shot's generator.
  addNode(manualId, 'video', null, {}, assetId)
  addNode(manualTargetId, 'generation', targetShotId, { modality: 'video', storyboard_revision: 3, mode: 'extend', reference_video_url: localUrl })
  run('INSERT INTO canvas_edges (id, project_id, position, source, target) VALUES (?, ?, 0, ?, ?)', 'source-input', projectId, sourceId, targetId)
  run('INSERT INTO canvas_edges (id, project_id, position, source, target) VALUES (?, ?, 1, ?, ?)', 'manual-input', projectId, manualId, manualTargetId)
  const node = (id: string) => one<CanvasNode>('SELECT * FROM canvas_nodes WHERE project_id=? AND id=?', projectId, id)!
  return { projectId, sourceShotId, targetShotId, assetId, jobId, sourceId, targetId, manualId, manualTargetId, node,
    source: one<Shot>('SELECT * FROM shots WHERE id=?', sourceShotId)!,
    edges: () => all<CanvasEdge>('SELECT * FROM canvas_edges WHERE project_id=? ORDER BY position', projectId) }
}

for (const reference of ['local', 'remote'] as const) {
  test(`replanning releases a downstream ${reference} video URL while retaining historical media and manual cards`, () => {
    const f = fixture(reference), manual = f.node(f.manualId), manualTarget = f.node(f.manualTargetId), target = f.node(f.targetId)
    db.transaction(() => invalidateStoryboardShot(f.source, 1))()
    const current = f.node(f.sourceId), settings = JSON.parse(current.settings)
    assert.equal(current.asset_id, null); assert.equal(current.job_id, null); assert.equal(current.text, '')
    assert.equal(current.prompt, '新的连续动作'); assert.equal(settings.storyboard_revision, 1)
    assert.equal(current.x, 120); assert.equal(current.y, 240)
    for (const field of ['prompt_override', 'prompt_is_final', 'prompt_document', 'prompt_sections', 'prompt_base', 'prompt_template', 'prompt_body', 'generation_completed_job_id']) assert.equal(settings[field], undefined)
    const downstream = f.node(f.targetId)
    assert.equal(JSON.parse(downstream.settings).reference_video_url, undefined)
    assert.equal(JSON.parse(downstream.settings).storyboard_revision, 3)
    assert.equal(downstream.prompt, target.prompt); assert.equal(downstream.text, target.text)
    assert.deepEqual(f.edges().map(edge => edge.id), ['manual-input'])
    assert.deepEqual(f.node(f.manualId), manual)
    assert.deepEqual(f.node(f.manualTargetId), manualTarget, 'a separately pinned historical card remains an explicit choice')
    assert.ok(one('SELECT id FROM assets WHERE id=?', f.assetId))
    assert.ok(one('SELECT id FROM jobs WHERE id=? AND result_asset_id=?', f.jobId, f.assetId))
    assert.equal(one<Shot>('SELECT * FROM shots WHERE id=?', f.sourceShotId)!.storyboard_revision, 1)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })
}

test('replanning preserves a dynamic unpinned downstream connection for the next generated result', () => {
  const f = fixture('dynamic'), target = f.node(f.targetId), edges = f.edges()
  db.transaction(() => invalidateStoryboardShot(f.source, 1))()
  assert.deepEqual(f.edges(), edges)
  assert.deepEqual(f.node(f.targetId), target)
  assert.equal(f.node(f.sourceId).asset_id, null)
  assert.equal(f.node(f.manualId).asset_id, f.assetId)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
