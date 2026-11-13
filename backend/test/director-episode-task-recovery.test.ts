import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import type { Model, Project, Provider, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-episode-task-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, one, run } = await import('../src/infrastructure/database/db.js')
const { creationState, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { workflowRequest } = await import('../src/modules/script/script-workflow.js')
const { withSkillRules } = await import('../src/modules/skills/skills.js')
assert.equal(db.name, join(directory, 'studio.db'), 'episode recovery must use its own temporary database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function snapshot(projectId: string): ScriptSnapshot {
  const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', projectId)
  return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', projectId),
    scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId) }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Freeze the previous v2 wire format to construct an actual historical task
 * key. The fixture has no upload, pending draft or non-script skill selection.
 * This deliberately retains insertion order instead of normalizing workflow. */
function historicalRecoveryKey(projectId: string, request: any, workflow = request.workflow) {
  assert.equal(one('SELECT * FROM script_source_documents WHERE project_id=?', projectId), undefined)
  assert.equal(getToolDraft(projectId), null)
  const project = one<Project>('SELECT * FROM projects WHERE id=?', projectId)!
  const model = one<Model>('SELECT * FROM models WHERE id=?', request.model_id)!
  const provider = one<Provider>('SELECT * FROM providers WHERE id=?', model.provider_id)!
  const task = { text: request.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.text || '',
    workflow_stage: request.workflow.stage, operation: undefined, purpose: 'create' as const, task_kind: 'script_write' as const }
  return hash({ version: 2,
    source: hash([project.name, project.brief, creationState(projectId, snapshot(projectId)).version, null]),
    task: { ...task, document_action: undefined, workflow },
    model: { id: model.id, protocol: model.protocol, remote_id: model.remote_id, settings: model.settings },
    provider: { id: provider.id, base_url: provider.base_url, adapter: provider.adapter, auth_header: provider.auth_header, auth_prefix: provider.auth_prefix },
    rules: withSkillRules('script', '', undefined, { projectId, selections: request.skill_selections, task }),
  })
}

async function interruptedEpisode(t: TestContext) {
  const project = await api('POST', '/api/projects', { name: '分集任务恢复顺序回归' })
  await api('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    ...(['outline', 'characters', 'locations', 'props'] as const).flatMap(stage => scriptStageArtifacts[stage].map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: `${scriptArtifactLabels[artifact_type]}：林晚调查车站旧案，归还铜钥匙，原有身份与因果保持一致。`, status: 'ready',
    }))),
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集原稿', content: '林晚回到车站，查看旧车票。', status: 'ready' },
  ] })
  const saved = snapshot(project.id)
  await api('PUT', `/api/projects/${project.id}/script`, { outline: saved.outline, characters: saved.characters, scenes: [
    { episode_number: 1, heading: '车站查票', location: '车站', characters: '林晚', action: '林晚展开旧车票。', dialogue: '日期不对。', duration: 18 },
  ] })
  const provider = await api('POST', '/api/providers', { name: 'episode recovery fixture', base_url: 'https://episode-task-recovery.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] },
      structured_output_mode: 'json_schema', text_path: 'choices.0.message.content' } })
  const before = snapshot(project.id), original = before.scenes[0]!
  const candidate = { artifacts: [{ artifact_type: 'episode_script', title: '第一集：旧车票',
    content: '林晚回到空荡的车站。她展开旧车票，比对墙上的时刻表，发现票面日期被改过。\n林晚：“这张车票的日期不对。有人要我错过那班车。”\n她将车票收进口袋，沿检票口寻找留下改动的人。' }],
    scenes: [{ source_scene_id: original.id, heading: '车站查票', location: '车站', time_of_day: '夜', characters: '林晚',
      action: '林晚展开旧车票，比对墙上的时刻表，将车票收进口袋，沿检票口寻找改票的人。',
      dialogue: '林晚：“这张车票的日期不对。有人要我错过那班车。”', narration: '', duration: 47 }] }
  let drafts = 0, reviews = 0, failReview = true
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /episode-task-recovery\.invalid/)
    const review = draftCompletenessFixtureResponse(init)
    if (review) {
      reviews++
      if (failReview) return Response.json({ error: { message: '独立审核暂不可用' } }, { status: 400 })
      return review
    }
    const body = JSON.parse(String(init?.body))
    assert.equal(body.response_format?.json_schema?.name, 'workflow_draft')
    drafts++
    return Response.json({ choices: [{ message: { content: JSON.stringify(candidate) }, finish_reason: 'stop' }] })
  })
  const id = crypto.randomUUID(), conversationId = crypto.randomUUID(), text = '重新设计第一集完整正文和分场，保留已有场次关联，先给我预览。'
  const body = { model_id: model.id, mode: 'script', use_tools: true, skill_selections: { script: [] },
    workflow: { stage: 'episode', episode_number: 1, operation: 'regenerate' }, messages: [{ role: 'user', text }],
    task: { id, conversation: { id: conversationId, messages: [{ id: crypto.randomUUID(), role: 'user', text }] },
      execution: { title: '重新设计第一集', request: text, started_at: Date.now(), mode: 'script' } } }
  const chatUrl = `/api/projects/${project.id}/script/director/chat/stream`, taskUrl = `/api/projects/${project.id}/script/director/tasks/${id}`
  const first = await app.inject({ method: 'POST', url: chatUrl, payload: body })
  assert.equal(first.statusCode, 200, first.body)
  const firstEvents = first.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.match(firstEvents.find(event => event.type === 'error')?.message || '', /独立审核暂不可用/)
  const failed = await api('GET', taskUrl)
  assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
  assert.deepEqual(snapshot(project.id), before, 'a failed independent review must not change the formal episode')
  assert.equal(getToolDraft(project.id), null)
  assert.equal(drafts, 1); assert.equal(reviews, 1)
  const row = one<{ request_payload: string; resume_key: string; request_hash: string }>('SELECT request_payload,resume_key,request_hash FROM script_director_tasks WHERE id=?', id)!
  const retained = JSON.parse(row.request_payload)
  assert.deepEqual(retained.workflow, { stage: 'episode', operation: 'regenerate', scope: 'episode', episode_number: 1,
    intent: 'stage_design', artifact_types: ['episode_script'] }, 'refreshRecoveryRequest must retain the server-expanded workflow contract')
  assert.notEqual(JSON.stringify(retained.workflow), JSON.stringify(workflowRequest.parse(retained.workflow)),
    'the actual server-expanded and reparsed contracts exercise different property insertion orders')
  assert.equal(all('SELECT * FROM script_generation_checkpoints WHERE project_id=?', project.id).length, 1)
  return { project, model, id, body, before, candidate, row, retained, chatUrl, taskUrl,
    counts: () => ({ drafts, reviews }), recover: () => { failReview = false } }
}

for (const keyFormat of ['canonical', 'historical'] as const) {
  test(`${keyFormat} episode task recovery reuses complete prose across repeated failures with an unchanged server-expanded workflow`, async t => {
    const f = await interruptedEpisode(t)
    const historical = historicalRecoveryKey(f.project.id, f.retained)
    const canonical = historicalRecoveryKey(f.project.id, f.retained, workflowRequest.parse(f.retained.workflow))
    assert.notEqual(historical, canonical, 'historical insertion order produces the previously persisted different hash')
    if (keyFormat === 'historical') run('UPDATE script_director_tasks SET resume_key=? WHERE id=?', historical, f.id)
    else assert.equal(f.row.resume_key, canonical, 'newly refreshed tasks must persist the normalized workflow key')
    const repeated = await app.inject({ method: 'POST', url: f.chatUrl, payload: f.body })
    assert.equal(repeated.statusCode, 200, repeated.body)
    assert.deepEqual(f.counts(), { drafts: 1, reviews: 1 }, 'the original submission remains an idempotent lookup after the server refreshes its request')
    const retry = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: {} })
    assert.equal(retry.statusCode, 200, retry.body)
    await app.inject({ method: 'GET', url: f.taskUrl + '/stream' })
    const failedAgain = await api('GET', f.taskUrl)
    assert.equal(failedAgain.status, 'failed'); assert.equal(failedAgain.can_resume, true)
    assert.deepEqual(f.counts(), { drafts: 1, reviews: 2 }, 'another review failure must preserve the original prose and its resumable identity')
    assert.equal(getToolDraft(f.project.id), null)
    assert.deepEqual(snapshot(f.project.id), f.before)
    f.recover()
    const continued = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: {} })
    assert.equal(continued.statusCode, 200, continued.body)
    await app.inject({ method: 'GET', url: f.taskUrl + '/stream' })
    const completed = await api('GET', f.taskUrl)
    assert.equal(completed.id, f.id); assert.equal(completed.status, 'succeeded', JSON.stringify(completed.events))
    const result = completed.events.find((event: any) => event.type === 'done')
    assert.ok(result?.tool_draft)
    assert.deepEqual(result.tool_draft.workflow.scenes, f.candidate.scenes, 'the full authored scene, duration and binding survive continuation unchanged')
    assert.equal(result.tool_draft.documents[0].title, f.candidate.artifacts[0].title)
    assert.equal(result.tool_draft.documents[0].content, f.candidate.artifacts[0].content)
    assert.deepEqual(f.counts(), { drafts: 1, reviews: 3 }, 'continuation must rerun only the failed independent review without rewriting the episode')
    assert.deepEqual(snapshot(f.project.id), f.before, 'successful continuation only presents a pending draft')
    assert.equal(one<{ request_hash: string }>('SELECT request_hash FROM script_director_tasks WHERE id=?', f.id)!.request_hash, f.row.request_hash)
  })

  for (const changed of ['scene', 'model'] as const) {
    test(`${keyFormat} episode recovery still rejects a real ${changed} change before another model request`, async t => {
      const f = await interruptedEpisode(t)
      if (keyFormat === 'historical') run('UPDATE script_director_tasks SET resume_key=? WHERE id=?', historicalRecoveryKey(f.project.id, f.retained), f.id)
      if (changed === 'scene') run('UPDATE script_scenes SET dialogue=? WHERE id=?', '另一位作者已更新原场次对白。', f.before.scenes[0]!.id)
      else run('UPDATE models SET remote_id=? WHERE id=?', 'another-model-version', f.model.id)
      const beforeContinue = snapshot(f.project.id)
      f.recover()
      const continued = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: {} })
      assert.equal(continued.statusCode, 409, continued.body); assert.match(continued.body, /已变化/)
      assert.deepEqual(f.counts(), { drafts: 1, reviews: 1 })
      assert.equal((await api('GET', f.taskUrl)).status, 'failed')
      assert.equal(getToolDraft(f.project.id), null)
      assert.deepEqual(snapshot(f.project.id), beforeContinue)
    })
  }
}
