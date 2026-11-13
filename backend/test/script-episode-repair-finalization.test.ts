import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-episode-repair-finalization-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, one, run } = await import('../src/infrastructure/database/db.js')
const { creationState, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema, workflowRequest } = await import('../src/modules/script/script-workflow.js')
assert.equal(db.name, join(directory, 'studio.db'), 'episode repair tests must use a temporary database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function script(projectId: string): ScriptSnapshot {
  const saved = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', projectId)
  return { outline: saved?.outline || '', characters: saved?.characters || '', generation_options: JSON.parse(saved?.generation_options || '{}'),
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', projectId),
    scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId) }
}
const events = (body: string) => body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
const oldAction = '林晚说明事故的具体行动尚未落实。'
const newAction = '林晚展开旧车票，指向改写的日期，再将车票收进口袋，沿检票口追查改票的人。'
const summary = '保留原场次关联和完整对白，补齐查票行动，并将首场估时调整为48秒。'
const answer = '保留完整对白，补齐查票动作，将第一场按完整表演重新估为48秒。'

async function fixture(t: TestContext, useTools = true) {
  const project = await api('POST', '/api/projects', { name: '分集修订完成后呈现草稿' })
  await api('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    ...(['outline', 'characters', 'locations', 'props'] as const).flatMap(stage => scriptStageArtifacts[stage].map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}：林晚调查车站旧案，铜钥匙只用于车站北门，保留已确认人物身份与因果。`, status: 'ready',
    }))),
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集原稿', content: '林晚查验车票，向北门走去。', status: 'ready' },
    { artifact_type: 'episode_script', episode_number: 2, title: '第二集原稿', content: '林晚次日在北门归还铜钥匙。', status: 'ready' },
  ] })
  const initial = script(project.id)
  await api('PUT', `/api/projects/${project.id}/script`, { outline: initial.outline, characters: initial.characters, scenes: [
    { episode_number: 1, heading: '车站查票', location: '车站', characters: '林晚', action: '林晚查看旧车票。', dialogue: '日期不对。', duration: 18 },
    { episode_number: 1, heading: '远处北门', location: '北门', action: '北门的信号灯亮起。', duration: 4 },
    { episode_number: 2, heading: '归还钥匙', location: '北门', characters: '林晚', action: '林晚归还铜钥匙。', duration: 12 },
  ] })
  const snapshot = script(project.id), sources = snapshot.scenes.filter(scene => scene.episode_number === 1)
  const source = snapshot.artifacts!.find(artifact => artifact.artifact_type === 'episode_script' && artifact.episode_number === 1)!
  const timestamp = new Date().toISOString(), shotId = crypto.randomUUID(), assetId = crypto.randomUUID(), taskId = crypto.randomUUID(), profileId = crypto.randomUUID()
  run('INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', shotId, project.id, 0, '原查票镜头', sources[0]!.id, timestamp)
  run('INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', assetId, project.id, shotId, 'image', '旧素材.png', '/fixture/old-image.png', 'generated', timestamp)
  run('UPDATE shots SET selected_asset_id=? WHERE id=?', assetId, shotId)
  run('INSERT INTO asset_tasks (id, project_id, focus_artifact, status, source_artifact_ids, source_scene_ids, result_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', taskId, project.id, 'location', 'ready', JSON.stringify([source.id]), JSON.stringify([sources[0]!.id]), assetId, timestamp, timestamp)
  run('INSERT INTO visual_profiles (id, project_id, kind, name, definition, view_requirements, board_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', profileId, project.id, 'location', '车站', '旧视觉设定', '[]', assetId, timestamp, timestamp)
  run('INSERT INTO scene_visual_bindings (scene_id, profile_id) VALUES (?, ?)', sources[0]!.id, profileId)
  const formal = () => ({ script: script(project.id), shots: all('SELECT * FROM shots WHERE project_id=?', project.id),
    assets: all('SELECT * FROM assets WHERE project_id=?', project.id), tasks: all('SELECT * FROM asset_tasks WHERE project_id=?', project.id),
    profiles: all('SELECT * FROM visual_profiles WHERE project_id=?', project.id), bindings: all('SELECT * FROM scene_visual_bindings WHERE profile_id=?', profileId) })
  const before = formal()
  const provider = await api('POST', '/api/providers', { name: 'episode repair fixture', base_url: 'https://episode-repair-finalization.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本修订', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const workflow = workflowRequest.parse({ stage: 'episode', operation: 'regenerate', episode_number: 1, intent: 'stage_design', artifact_types: ['episode_script'] })
  const draft = workflowGenerationDraftSchema.parse({ ...workflow,
    artifacts: [{ artifact_type: 'episode_script', title: '第一集：被改写的车票', content: `林晚站在空荡的车站。\n${oldAction}\n林晚：“这张车票的日期不对。有人要我错过那班车。”\n远处北门的信号灯亮起。` }],
    scenes: sources.map((scene, index) => ({ source_scene_id: scene.id, heading: scene.heading, location: scene.location, time_of_day: scene.time_of_day,
      characters: scene.characters, action: index ? scene.action : oldAction, dialogue: index ? scene.dialogue : '林晚：“这张车票的日期不对。有人要我错过那班车。”',
      narration: scene.narration, duration: index ? scene.duration : 2 })) })
  const request = { model_id: model.id, mode: 'script', focus_artifact: 'all', use_tools: useTools, skill_selections: { script: [] }, generation_options: {}, workflow,
    messages: [{ role: 'user', text: '重新设计第一集完整正文和分场，保留全部原场次关联。' }] }
  const pending = retainScriptDraft(project.id, { draft, findings: [{ source_key: 'scene:0:duration', kind: 'contradiction', quote: '2',
    explanation: '首场估时无法完成完整对白和查票行动，且行动尚未落实到具体过程。', suggestion: answer,
    related_findings: [{ source_key: 'episode_script', quote: oldAction, explanation: '正文与场次须同步具体查票行动。', suggestion: answer }] }],
    request, source_version: createHash('sha256').update(JSON.stringify([project.name, project.brief, creationState(project.id, snapshot).version, null])).digest('hex') })
  const patch = { decisions: [answer], summary, source_edits: [], edits: [
    { source_key: 'episode_script', find: oldAction, replace: newAction, reason: '同步具体查票行动。' },
    { source_key: 'scene:0:action', find: oldAction, replace: newAction, reason: '将正文行动同步到原场次。' },
    { source_key: 'scene:0:duration', find: '2', replace: '48', reason: '按完整对白、查票动作与停顿重新估时。' },
  ] }
  let repairCalls = 0, reviews = 0, writerCalls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /episode-repair-finalization\.invalid/)
    const review = draftCompletenessFixtureResponse(init)
    if (review) { reviews++; return review }
    const body = JSON.parse(String(init?.body))
    if (body.response_format?.json_schema?.name === 'workflow_draft') writerCalls++
    const prompt = body.messages[0].content as string
    assert.match(prompt, /候选稿修补工具协议/)
    assert.match(prompt, /"source_scene_id"/)
    repairCalls++
    return Response.json({ choices: [{ message: { content: JSON.stringify(patch) }, finish_reason: 'stop' }] })
  })
  const body = { model_id: model.id, mode: 'script', use_tools: useTools, skill_selections: { script: [] },
    messages: [...request.messages, { role: 'user', text: answer }],
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers: [answer] } }
  const repaired = structuredClone(draft)
  repaired.artifacts[0]!.content = repaired.artifacts[0]!.content.replace(oldAction, newAction)
  repaired.scenes[0]!.action = newAction; repaired.scenes[0]!.duration = 48
  return { project, source, sources, model, pending, draft, repaired, before, formal, body,
    counts: () => ({ repairCalls, reviews, writerCalls }) }
}

function assertPreview(result: any, f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(result.reply, summary, 'the exact patch summary must survive presentation')
  assert.equal(result.draft_resolution, null)
  assert.equal(result.draft, undefined)
  assert.ok(result.tool_draft?.id); assert.ok(result.tool_draft.version)
  assert.equal(result.tool_draft.status, 'pending')
  assert.equal(result.tool_draft.workflow.operation, 'regenerate')
  assert.equal(result.tool_draft.workflow.episode_number, 1)
  assert.deepEqual(result.tool_draft.workflow.scenes, f.repaired.scenes, 'precise patches preserve every original source_scene_id and unaffected scene field')
  assert.equal(result.tool_draft.documents[0].id, f.source.id)
  assert.equal(result.tool_draft.documents[0].title, f.repaired.artifacts[0]!.title)
  assert.equal(result.tool_draft.documents[0].content, f.repaired.artifacts[0]!.content)
  assert.equal(getToolDraft(f.project.id)!.version, result.tool_draft.version)
  assert.equal(pendingScriptDraft(f.project.id), null)
  assert.deepEqual(f.formal(), f.before, 'presenting a repaired candidate must not modify the formal script, other episodes or references')
  assert.deepEqual(f.counts(), { repairCalls: 1, reviews: 1, writerCalls: 0 }, 'finalization never dispatches another writer or model summary')
}

test('a repaired regenerated episode becomes a versioned confirmation draft after its complete review', async t => {
  for (const useTools of [false, true]) await t.test(useTools ? 'tool entry' : 'JSON entry', async t => {
    const f = await fixture(t, useTools)
    const result = await api('POST', `/api/projects/${f.project.id}/script/director/chat`, f.body)
    assertPreview(result, f)
  })
})

test('task continuation reuses completed repair and full review when final draft presentation was interrupted', async t => {
  const f = await fixture(t), id = crypto.randomUUID(), conversation = crypto.randomUUID()
  const taskUrl = `/api/projects/${f.project.id}/script/director/tasks/${id}`
  const task = { id, conversation: { id: conversation, messages: [{ id: crypto.randomUUID(), role: 'user', text: answer }] },
    execution: { title: '修订第一集并复核', request: answer, started_at: Date.now(), mode: 'script' } }
  db.exec(`CREATE TEMP TRIGGER fail_episode_repair_presentation BEFORE INSERT ON script_tool_drafts
    BEGIN SELECT RAISE(ABORT, '模拟最终草稿呈现中断'); END`)
  let first: Awaited<ReturnType<typeof app.inject>>
  try {
    first = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: { ...f.body, task } })
  } finally { db.exec('DROP TRIGGER fail_episode_repair_presentation') }
  assert.equal(first.statusCode, 200, first.body)
  assert.match(events(first.body).find(event => event.type === 'error')?.message || '', /模拟最终草稿呈现中断/)
  const failed = await api('GET', taskUrl)
  assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
  const retained = pendingScriptDraft(f.project.id)!
  assert.equal(retained.id, f.pending.id); assert.equal(retained.version, f.pending.version)
  assert.equal(retained.run!.completed, 1); assert.equal(retained.run!.total, 1); assert.equal(retained.run!.status, 'interrupted')
  const checkpoints = all<{ namespace: string; payload: string }>('SELECT namespace,payload FROM script_step_checkpoints WHERE project_id=?', f.project.id)
  assert.ok(JSON.parse(checkpoints.find(row => row.namespace === 'repair')!.payload).steps['repair:tools'])
  assert.ok(JSON.parse(checkpoints.find(row => row.namespace === 'draft-review')!.payload).steps['review:whole'])
  assert.equal(getToolDraft(f.project.id), null)
  assert.deepEqual(f.formal(), f.before)
  assert.deepEqual(f.counts(), { repairCalls: 1, reviews: 1, writerCalls: 0 })
  const resumed = await api('POST', taskUrl + '/continue', {})
  assert.equal(resumed.id, id)
  await app.inject({ method: 'GET', url: taskUrl + '/stream' })
  const completed = await api('GET', taskUrl)
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.events.filter((event: any) => event.type === 'error')))
  assert.equal(completed.conversation_id, conversation)
  assertPreview(completed.events.find((event: any) => event.type === 'done'), f)
})
