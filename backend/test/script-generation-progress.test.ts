import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'script-generation-progress-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, now, newId } = await import('../src/infrastructure/database/db.js')
const { scriptGenerationProgress, bindScriptGenerationProgressSource, discardScriptGenerationProgress, scriptGenerationProgressCheckpoint } = await import('../src/modules/script/script-generation-progress.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-identity.js')
assert.equal(db.name, join(directory, 'studio.db'))
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture() {
  const id = newId(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '逐栏目保留', timestamp, timestamp)
  const store = generationCheckpointStore(id, { project: id })
  const steps = createGenerationSteps(store)
  return { id, steps, save: () => store.save(steps.checkpoint) }
}
const artifact = (artifact_type = 'outline', content = '林舟归还钥匙，完成旧约。') => ({ artifact_type, title: `${artifact_type}草稿`, content })
const draft = (artifact_type = 'outline', content?: string) => ({ stage: 'outline', intent: 'stage_design', artifact_types: [artifact_type], scope: 'project', episode_number: 0,
  artifacts: [artifact(artifact_type, content)], scenes: [] })
function retain(f: ReturnType<typeof fixture>, key: string, value: unknown) {
  f.steps.retain(key, '测试草稿', key, value, value => value)
}

test('only complete validated document checkpoints are public, and rereading leaves formal data unchanged', () => {
  const f = fixture()
  bindScriptGenerationProgressSource(f.steps, null)
  retain(f, 'work:document:outline:outline/draft', draft())
  retain(f, 'work:document:outline:synopsis/draft', draft('synopsis'))
  retain(f, 'work:document:outline:world/draft', { ...draft('world'), artifacts: [artifact('world', '')] })
  retain(f, 'work:document:outline:hooks/draft:stream:state', { blocks: [artifact('hooks')], initialEnded: true })
  retain(f, 'other/draft', draft('constraints'))
  const expected = { updated_at: scriptGenerationProgress(f.id)!.updated_at, checkpoint_key: scriptGenerationProgress(f.id)!.checkpoint_key, documents: [
    { ...artifact(), episode_number: 0 }, { ...artifact('synopsis'), episode_number: 0 },
  ] }
  assert.deepEqual(scriptGenerationProgress(f.id), expected)
  assert.deepEqual(scriptGenerationProgress(f.id), expected, 'a fresh read recovers persisted columns without process memory')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM script_artifacts WHERE project_id=?').get(f.id)?.n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scripts WHERE project_id=?').get(f.id)?.n, 0)
})

test('source metadata rejects changed or removed manuscripts without deleting recovery work', () => {
  const f = fixture(), source = { filename: '原稿.txt', content: '原稿完整正文。', updated_at: '2026-11-09T10:00:00.000Z' }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', f.id, source.filename, source.content, source.updated_at)
  bindScriptGenerationProgressSource(f.steps, scriptDocumentVersion(source))
  retain(f, 'work:document:outline:outline/draft', draft())
  assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1)
  run('UPDATE script_source_documents SET content=? WHERE project_id=?', '已替换的新原稿。', f.id)
  assert.equal(scriptGenerationProgress(f.id), null)
  run('DELETE FROM script_source_documents WHERE project_id=?', f.id)
  assert.equal(scriptGenerationProgress(f.id), null)
  assert.ok(db.prepare('SELECT payload FROM script_generation_checkpoints WHERE project_id=?').get(f.id))
})

test('legacy complete checkpoints are readable only with evidence for the current manuscript', () => {
  const f = fixture(), source = { filename: '旧版原稿.txt', content: '第一幕\n林舟说：“归还钥匙。”', updated_at: '2026-11-09T10:00:00.000Z' }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', f.id, source.filename, source.content, source.updated_at)
  f.steps.checkpoint.prompt = `当前有效稿资料：${JSON.stringify({ source_version: scriptDocumentVersion(source) })}\n当前有效稿完整原文：\n${JSON.stringify(source.content)}`
  retain(f, 'work:document:outline:outline/draft', draft())
  assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1)
  run('UPDATE script_source_documents SET content=? WHERE project_id=?', '完全不同的原稿。', f.id)
  assert.equal(scriptGenerationProgress(f.id), null)
})

test('pending creation drafts keep columns visible after checkpoint clearing, and confirmation or discard removes them', () => {
  for (const status of ['saved', 'discarded']) {
    const f = fixture(), id = newId(), timestamp = now(), value = draft()
    bindScriptGenerationProgressSource(f.steps, null)
    retain(f, 'work:document:outline:outline/draft', value)
    run('INSERT INTO script_tool_drafts (id,project_id,version,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, f.id, newId(),
      JSON.stringify({ kind: 'create', source_version: null, workflow: value, documents: value.artifacts.map(item => ({ ...item, episode_number: 0 })) }), timestamp, timestamp)
    clearGenerationCheckpoint(f.id)
    assert.deepEqual(scriptGenerationProgress(f.id)?.documents, [{ ...artifact(), episode_number: 0 }])
    run('UPDATE script_tool_drafts SET status=? WHERE id=?', status, id)
    assert.equal(scriptGenerationProgress(f.id), null)
  }
})

test('only the exact bound durable task can hide its discarded checkpoint', () => {
  const f = fixture(), taskId = newId(), otherTaskId = newId(), conversationId = newId(), timestamp = now()
  run('INSERT INTO script_conversations (id,project_id,label,created_at,updated_at) VALUES (?,?,?,?,?)', conversationId, f.id, '任务', timestamp, timestamp)
  for (const [id, kind] of [[taskId, 'draft'], [otherTaskId, 'discarded']]) {
    run('INSERT INTO script_director_tasks (id,project_id,conversation_id,user_message_id,message_id,request_hash,status,snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, f.id, conversationId, newId(), newId(), newId(), 'succeeded', JSON.stringify({ execution: { outcome: { kind } } }), timestamp, timestamp)
  }
  bindScriptGenerationProgressSource(f.steps, null, taskId)
  retain(f, 'work:document:outline:outline/draft', draft())
  assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1, 'an unrelated discarded task cannot hide this draft')
  run('UPDATE script_director_tasks SET snapshot=? WHERE id=?', JSON.stringify({ execution: { outcome: { kind: 'discarded' } } }), taskId)
  assert.equal(scriptGenerationProgress(f.id), null)
  assert.ok(db.prepare('SELECT payload FROM script_generation_checkpoints WHERE project_id=?').get(f.id), 'display does not delete recovery state')
  bindScriptGenerationProgressSource(f.steps, null)
  assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1, 'a new non-durable run does not inherit a discarded durable task binding')
})

test('confirmed JSON documents are not shown again, while new redesign candidates preserve accepted originals', () => {
  const f = fixture(), accepted = artifact(), timestamp = '2026-11-09T09:00:00.000Z'
  run('INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,position,status,created_at,updated_at,episode_number) VALUES (?,?,?,?,?,?,\'ready\',?,?,0)',
    newId(), f.id, accepted.artifact_type, accepted.title, accepted.content, 0, timestamp, timestamp)
  bindScriptGenerationProgressSource(f.steps, null)
  retain(f, 'work:document:outline:outline/draft', draft())
  assert.equal(scriptGenerationProgress(f.id), null, 'an unchanged saved column needs no pending duplicate')
  retain(f, 'work:document:outline:outline/draft', draft('outline', '新设计：林舟先查明钥匙来历，再完成旧约。'))
  assert.equal(scriptGenerationProgress(f.id)?.documents[0]?.content, '新设计：林舟先查明钥匙来历，再完成旧约。')
  run('UPDATE script_artifacts SET content=?,updated_at=? WHERE project_id=?', '新设计：林舟先查明钥匙来历，再完成旧约。', now(), f.id)
  assert.equal(scriptGenerationProgress(f.id), null)
})

test('resolution candidates survive checkpoint handoff and are bound to the canonical project version', () => {
  const f = fixture(), version = 'canonical-project-version', timestamp = now()
  bindScriptGenerationProgressSource(f.steps, null)
  retain(f, 'work:document:outline:outline/draft', draft())
  run('INSERT INTO script_draft_resolutions (project_id,payload,updated_at) VALUES (?,?,?)', f.id,
    JSON.stringify({ source_version: version, draft: draft() }), timestamp)
  clearGenerationCheckpoint(f.id)
  assert.deepEqual(scriptGenerationProgress(f.id, version)?.documents, [{ ...artifact(), episode_number: 0 }])
  assert.equal(scriptGenerationProgress(f.id, version)?.checkpoint_key, undefined)
  assert.equal(scriptGenerationProgress(f.id, 'changed-project-version'), null)
  run('UPDATE script_draft_resolutions SET payload=? WHERE project_id=?', JSON.stringify({ source_version: version, draft: { ...draft(), artifacts: [artifact('outline', '')] } }), f.id)
  assert.equal(scriptGenerationProgress(f.id, version), null, 'invalid candidates are not displayed')
  run('DELETE FROM script_draft_resolutions WHERE project_id=?', f.id)
  assert.equal(scriptGenerationProgress(f.id, version), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM script_artifacts WHERE project_id=?').get(f.id)?.n, 0)
})

test('JSON discard hides only an exact current token and preserves reusable completed work', () => {
  const f = fixture()
  bindScriptGenerationProgressSource(f.steps, null)
  retain(f, 'work:document:outline:outline/draft', draft())
  run('UPDATE script_generation_checkpoints SET updated_at=? WHERE project_id=?', '2026-11-09T10:00:00.000Z', f.id)
  const token = scriptGenerationProgressCheckpoint(f.id)!
  for (const invalid of [{ ...token, checkpoint_key: 'a-different-run' }, { ...token, updated_at: '2026-11-09T09:59:59.000Z' }]) {
    assert.throws(() => discardScriptGenerationProgress(f.id, invalid.checkpoint_key, invalid.updated_at), { statusCode: 409 })
    assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1)
  }
  const original = JSON.parse(String(db.prepare('SELECT payload FROM script_generation_checkpoints WHERE project_id=?').get(f.id)?.payload))
  discardScriptGenerationProgress(f.id, token.checkpoint_key, token.updated_at)
  assert.equal(scriptGenerationProgress(f.id), null)
  assert.equal(scriptGenerationProgress(f.id), null, 'a new read keeps the display hidden')
  const saved = JSON.parse(String(db.prepare('SELECT payload FROM script_generation_checkpoints WHERE project_id=?').get(f.id)?.payload))
  assert.deepEqual(saved.steps['work:document:outline:outline/draft'], original.steps['work:document:outline:outline/draft'])
  assert.equal(saved.steps['progress:source'].input_hash, original.steps['progress:source'].input_hash)
  assert.equal(saved.steps['progress:source'].value.hidden, true)
  const resumed = createGenerationSteps(generationCheckpointStore(f.id, { project: f.id }))
  bindScriptGenerationProgressSource(resumed, null)
  assert.equal(scriptGenerationProgress(f.id)?.documents.length, 1, 'an explicit new generation can display reusable work again')
})
