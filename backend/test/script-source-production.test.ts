import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceProductionDirectory } from '@video-studio/shared/script/script-source-production'
import { stageOperationError } from '@video-studio/shared/script/script-stage-access'
const directory = await mkdtemp(join(tmpdir(), 'source-production-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, now, newId } = await import('../src/infrastructure/database/db.js')
const { sourceProductionState, prepareSourceProduction } = await import('../src/modules/script/script-source-production.js')
const { createScriptSourceAnalyzer } = await import('../src/modules/script/script-source-analysis.js')
const { clearGenerationCheckpoint, generationCheckpointStore } = await import('../src/modules/script/script-generation-checkpoints.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const sourceText = '# 第1集 未解之谜\n1-1 夜 外 巷口\n风停了。\n林舟："别回头。"\n1-2 夜 内 门厅\n钟响，来历仍然未知。\n# 第2集 开放结局\n2-1 日 外 旧城\n旅人望向远方，故事未完。'
function fixture(content = sourceText) {
  const id = newId(), timestamp = now()
  db.prepare('INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, '按原稿制作', timestamp, timestamp)
  db.prepare('INSERT INTO script_source_documents(project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, '原稿.md', content, timestamp)
  return id
}
const input = (id: string, number = 1, selected?: number[]) => {
  const state = sourceProductionState(id), episode = state.episodes.find(ep => ep.episode_number === number)!
  return { source_version: state.source_version, episode_number: number, episode_offset: episode.offset, scene_offsets: selected || episode.scenes.map(s => s.offset), duration: 30 }
}
test('directory preserves exact UTF-16 ranges, dialogue and unresolved ending without semantic judgement', () => {
  const content = '序言😀\n' + sourceText
  const episodes = sourceProductionDirectory(content)
  assert.deepEqual(episodes.map(ep => ep.episode_number), [1, 2]); assert.equal(episodes[0].scenes.length, 2)
  for (const episode of episodes) for (const scene of episode.scenes) assert.equal(scene.text, content.slice(scene.offset, scene.offset + scene.length))
  assert.equal(episodes[0].scenes[0].dialogue, '林舟："别回头。"')
  assert.match(episodes[1].scenes[0].action, /故事未完/)
})
test('synopsis is not fabricated into scenes and duplicate headings require a local selection', () => {
  assert.equal(sourceProductionDirectory('第1集 梗概\n旅人归乡，发现谜团。')[0].scenes.length, 0)
  const entries = sourceProductionDirectory('第一集 目录\n简介\n第一集 正文\n1-1 夜 外 街口\n旅人归乡。')
  assert.equal(entries.length, 2); assert.equal(entries.every(ep => ep.ambiguous), true); assert.equal(entries[1].scenes.length, 1)
})
test('upload without a selected model preserves source and enables later explicit analysis', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('模型不应调用') })
  const id = fixture(), boundary = 'production-upload'
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="script.md"\r\nContent-Type: text/plain\r\n\r\n${sourceText}\r\n--${boundary}--\r\n` })
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().analysis, null); assert.equal(calls, 0)
  for (const table of ['script_source_analyses', 'script_scenes', 'script_artifacts']) assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).get(id) as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM script_step_checkpoints WHERE project_id=? AND namespace LIKE 'source-production:%'").get(id) as { n: number }).n, 0)
})
test('paused failed optional audit does not lock production, create a review or alter its snapshot', async t => {
  const id = fixture(), state = sourceProductionState(id), stamp = now()
  const snapshot = JSON.stringify({ id: 'old-audit', status: 'paused', source_version: state.source_version, model_id: 'old', completed_chunks: 0, total_chunks: 1, sections: [], error: 'unknown paid result', updated_at: stamp })
  db.prepare('INSERT INTO script_source_analyses VALUES (?,?,?,?,?,?)').run(id, 'old-audit', state.source_version, 'paused', snapshot, stamp)
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('不应调用模型') })
  const read = await app.inject({ method: 'GET', url: `/api/projects/${id}/script/source/production` }); assert.equal(read.statusCode, 200)
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source/production/prepare`, payload: input(id) })
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().imported_scene_ids.length, 2); assert.equal(calls, 0)
  assert.equal((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(id) as { snapshot: string }).snapshot, snapshot)
  const scene = db.prepare('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position').get(id) as { id: string; dialogue: string }
  assert.equal(scene.dialogue, '林舟："别回头。"')
  const origin = db.prepare('SELECT * FROM script_source_scene_origins WHERE scene_id=?').get(scene.id) as { source_offset: number; source_length: number; source_text: string }
  assert.equal(origin.source_text, sourceText.slice(origin.source_offset, origin.source_offset + origin.source_length))
})
test('partial local continuation imports only missing scenes, reentry is idempotent, other episode untouched', () => {
  const id = fixture(), initial = input(id), first = prepareSourceProduction(id, { ...initial, scene_offsets: [initial.scene_offsets[0]] })
  assert.equal(first.imported_scene_ids.length, 1)
  const second = prepareSourceProduction(id, initial); assert.equal(second.imported_scene_ids.length, 1); assert.deepEqual(second.reused_scene_ids, first.imported_scene_ids)
  const before = db.prepare('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position').all(id)
  assert.equal(prepareSourceProduction(id, initial).imported_scene_ids.length, 0)
  prepareSourceProduction(id, input(id, 2))
  assert.deepEqual(db.prepare('SELECT * FROM script_scenes WHERE project_id=? AND episode_number=1 ORDER BY position').all(id), before)
})
test('version mismatch and foreign or duplicate offsets reject atomically', () => {
  const id = fixture(), target = input(id)
  assert.throws(() => prepareSourceProduction(id, { ...target, source_version: 'f'.repeat(64) }), /原稿已变化/)
  assert.throws(() => prepareSourceProduction(id, { ...target, scene_offsets: [target.scene_offsets[0], 99999] }), /不属于/)
  assert.throws(() => prepareSourceProduction(id, { ...target, scene_offsets: [target.scene_offsets[0], target.scene_offsets[0]] }), /无效/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM script_scenes WHERE project_id=?').get(id) as { n: number }).n, 0)
})
test('creator edited scene is reused without overwrite and source changes block only the affected episode import', () => {
  const id = fixture(), saved = prepareSourceProduction(id, input(id)), sceneId = saved.imported_scene_ids[0]
  db.prepare('UPDATE script_scenes SET dialogue=? WHERE id=?').run('作者修改：留在这里。', sceneId)
  assert.equal(prepareSourceProduction(id, input(id)).imported_scene_ids.length, 0)
  assert.equal((db.prepare('SELECT dialogue FROM script_scenes WHERE id=?').get(sceneId) as { dialogue: string }).dialogue, '作者修改：留在这里。')
  assert.deepEqual(sourceProductionState(id).episodes[0].changed_scene_ids, [sceneId])
  db.prepare('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?').run(sourceText.replace('风停了。', '雨停了。'), now(), id)
  assert.throws(() => prepareSourceProduction(id, input(id)), /原文已变化/)
  assert.equal(prepareSourceProduction(id, input(id, 2)).imported_scene_ids.length, 1)
})
test('source episode may be created directly, while ordinary creative stage order remains', () => {
  const script = { scenes: [], artifacts: [] }
  assert.equal(stageOperationError(script, { stage: 'episode', episode_number: 2, intent: 'source_episode' }), null)
  assert.match(stageOperationError(script, { stage: 'episode', episode_number: 2 })!, /故事大纲/)
  assert.ok(stageOperationError(script, { stage: 'characters', episode_number: 0, intent: 'source_episode' }))
})
test('restarting never dispatches an old queued audit and keeps unknown request controls', async () => {
  const id = fixture(), version = sourceProductionState(id).source_version, stamp = now()
  const state = { id: 'old-queued', source_version: version, status: 'queued', model_id: 'legacy', completed_chunks: 0, total_chunks: 1, sections: [], error: null, updated_at: stamp,
    controlled_recovery: { id: 'old-control', outcome: 'stopped', closed_at: stamp } }
  db.prepare('INSERT INTO script_source_analyses VALUES (?,?,?,?,?,?)').run(id, state.id, version, state.status, JSON.stringify(state), stamp)
  let calls = 0; const analyzer = createScriptSourceAnalyzer(async () => { calls++; throw new Error('no dispatch') })
  analyzer.recover()
  assert.equal(calls, 0)
  const updated = JSON.parse((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(id) as { snapshot: string }).snapshot)
  assert.equal(updated.status, 'paused'); assert.deepEqual(updated.controlled_recovery, state.controlled_recovery)
  await analyzer.close()
})
test('saving or discarding an unrelated creative draft retains independent source-production checkpoints', () => {
  const id = fixture(), store = generationCheckpointStore(id, { task: 1 }, 'source-production:episode:1')
  store.checkpoint.steps.test = { input_hash: 'abc', value: 'saved' }; store.save(store.checkpoint)
  clearGenerationCheckpoint(id)
  const reloaded = generationCheckpointStore(id, { task: 1 }, 'source-production:episode:1')
  assert.equal(reloaded.checkpoint.steps.test.value, 'saved')
})

async function textModel() {
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '离线模型', base_url: 'https://offline.invalid/v1' } })).json()
  return (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: 'offline', remote_id: 'offline', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
}
const episodeOutput = { artifacts: [{ artifact_type: 'episode_script', title: '第1集 正文', content: '1-1 夜 外 巷口\n林舟：别回头。\n来历仍然未知，故事未完。' }],
  scenes: [{ heading: '1-1 夜 外 巷口', location: '巷口', time_of_day: '夜', characters: '林舟', action: '来历仍然未知，故事未完。', dialogue: '林舟：别回头。', narration: '', duration: 30 }] }
test('explicit single-episode adaptation uses one bounded writer, skips global audit, and waits for formal save', async t => {
  const id = fixture('第1集 梗概\n林舟经过巷口，告诫同伴别回头。钟声来历尚未解释。'), model = await textModel()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
    calls++
    const wire = JSON.stringify(JSON.parse(String(init?.body)))
    assert.ok(!wire.includes('只为创作者上传的原剧本建立检索地图'))
    assert.ok(!wire.includes('独立核对核心设定'))
    return Response.json({ choices: [{ message: { content: JSON.stringify(episodeOutput) } }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true,
    skill_selections: { script: [] }, messages: [{ role: 'user', text: '改编第1集正文及分场，供我确认，不保存。' }],
    workflow: { stage: 'episode', scope: 'episode', episode_number: 1, intent: 'source_episode', operation: 'generate', artifact_types: ['episode_script'] } } })
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(response.json().tool_draft, response.body)
  assert.equal(calls, 1)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM script_scenes WHERE project_id=?').get(id) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM script_source_analyses WHERE project_id=?').get(id) as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM script_step_checkpoints WHERE project_id=? AND namespace='source-production:episode:1'").get(id) as { n: number }).n, 1)
})

test('adding earlier scenes restores original order without touching a different episode', () => {
  const id = fixture(), target = input(id)
  const second = prepareSourceProduction(id, { ...target, scene_offsets: [target.scene_offsets[1]] })
  prepareSourceProduction(id, input(id, 2))
  const untouched = db.prepare('SELECT * FROM script_scenes WHERE project_id=? AND episode_number=2').all(id)
  const result = prepareSourceProduction(id, target)
  const rows = db.prepare('SELECT id,heading FROM script_scenes WHERE project_id=? AND episode_number=1 ORDER BY position').all(id) as Array<{ id: string; heading: string }>
  assert.match(rows[0].heading, /1-1/); assert.equal(rows[1].id, second.imported_scene_ids[0]); assert.equal(result.imported_scene_ids.length, 1)
  assert.deepEqual(db.prepare('SELECT * FROM script_scenes WHERE project_id=? AND episode_number=2').all(id), untouched)
})
test('unrelated original edits shift offsets without duplicating an already prepared episode', () => {
  const id = fixture(); prepareSourceProduction(id, input(id, 2))
  db.prepare('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?').run('前言补充\n' + sourceText, now(), id)
  assert.equal(sourceProductionState(id).episodes[1].status, 'ready')
  assert.equal(prepareSourceProduction(id, input(id, 2)).imported_scene_ids.length, 0)
})

test('production unknown delivery cannot be bypassed with a new prompt; other episodes and import remain independent', async t => {
  const id = fixture(), model = await textModel()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('connection closed after dispatch') })
  const payload = { model_id: model.id, mode: 'script', use_tools: true, skill_selections: { script: [] }, messages: [{ role: 'user', text: '改编第1集正文与分场' }],
    workflow: { stage: 'episode', scope: 'episode', episode_number: 1, intent: 'source_episode', operation: 'generate', artifact_types: ['episode_script'] } }
  const first = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/director/chat`, payload })
  assert.ok(first.statusCode >= 400, first.body); assert.equal(calls, 1)
  const old = db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-production:episode:1'").get(id)
  const second = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/director/chat`, payload: { ...payload, messages: [{ role: 'user', text: '继续第1集，再试一下' }] } })
  assert.ok(second.statusCode >= 400, second.body); assert.equal(calls, 1)
  assert.deepEqual(db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-production:episode:1'").get(id), old)
  assert.equal(prepareSourceProduction(id, input(id, 2)).imported_scene_ids.length, 1)
})
test('single episode permits at most one format correction and never invokes semantic review', async t => {
  const id = fixture('第1集 梗概\n林舟来到巷口。'), model = await textModel()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ choices: [{ message: { content: '{"unrelated":true}' } }] }) })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true,
    skill_selections: { script: [] }, messages: [{ role: 'user', text: '改编第1集正文与分场' }],
    workflow: { stage: 'episode', episode_number: 1, intent: 'source_episode', artifact_types: ['episode_script'] } } })
  assert.ok(response.statusCode >= 400, response.body); assert.equal(calls, 2)
})

test('saved legacy scenes are usable immediately without reimporting or passing an audit', () => {
  const id = fixture(), stamp = now(), sceneId = newId()
  db.prepare('INSERT INTO script_scenes(id,project_id,episode_number,position,heading,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(sceneId, id, 1, 0, '旧项目正式场次', stamp, stamp)
  const state = sourceProductionState(id)
  assert.equal(state.episodes[0].status, 'ready'); assert.deepEqual(state.episodes[0].saved_scene_ids, [sceneId])
  assert.throws(() => prepareSourceProduction(id, input(id)), /不会覆盖/)
})

test('an affected original scene does not prevent preparing a different missing scene in the same episode', () => {
  const id = fixture(), target = input(id)
  prepareSourceProduction(id, { ...target, scene_offsets: [target.scene_offsets[0]] })
  db.prepare('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?').run(sourceText.replace('风停了。', '风又起了。'), now(), id)
  const state = sourceProductionState(id), ep = state.episodes[0]
  assert.ok(ep.blocked_scene_offsets?.includes(ep.scenes[0].offset))
  assert.equal(prepareSourceProduction(id, { ...input(id), scene_offsets: [ep.scenes[1].offset] }).imported_scene_ids.length, 1)
})

test('the actual uploaded synopsis heading convention lists all 60 episodes without manufacturing screenplay scenes', () => {
  const original = '# 世界观与60集梗概\n## 第一篇章（第1–15集）\n' + Array.from({ length: 60 }, (_, i) => `- **第${i + 1}集：未解释的钟声**\n  - *情节*：旅人听见钟声。\n  - *钩子*：来历尚未说明。\n`).join('\n')
  const episodes = sourceProductionDirectory(original)
  assert.equal(episodes.length, 60); assert.equal(episodes[59].episode_number, 60)
  assert.ok(episodes.every(ep => ep.scenes.length === 0))
  for (const ep of episodes) assert.ok(original.slice(ep.offset, ep.offset + ep.length).startsWith('- **第'))
})

test('ordinary task context reads original text without legacy semantic packets, gates or supplementary analysis instructions', async () => {
  const { scriptSourceContext, scriptSourceIndex, scriptSourceFallbackContext } = await import('../src/modules/script/script-source-documents.js')
  const id = fixture()
  const context = scriptSourceContext(id, true, false, false)
  assert.match(context, /别回头/)
  assert.doesNotMatch(context, /分析尚未完成|quality_findings|quality_summary|story_map/)
  const index = scriptSourceIndex(id, false, false)!
  for (const key of ['analysis_status', 'analysis_source_version', 'quality_findings', 'quality_summary', 'story_map', 'story']) assert.equal(key in index, false)
  assert.match(scriptSourceFallbackContext(id, false), /不发起独立质量审核/)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM script_source_analyses WHERE project_id=?').get(id) as { n: number }).n, 0)
})
