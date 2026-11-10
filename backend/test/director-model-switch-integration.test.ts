import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'director-model-switch-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, one, run, all } = await import('../src/infrastructure/database/db.js')
assert.ok(db.name.startsWith(directory), 'model-switch tests must never read a real business database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function api(url: string, payload?: object, method: 'GET' | 'POST' = 'POST') {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function setup(t: { mock: { method: (...args: any[]) => unknown } }) {
  const provider = await api('/api/providers', { name: '离线迁移提供商', base_url: 'https://model-switch.invalid/v1' })
  const createModel = (remote_id: string) => api('/api/models', { provider_id: provider.id, name: remote_id, remote_id, modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content', structured_output_mode: 'json_schema' } })
  const old = await createModel('old-model'), next = await createModel('new-model')
  const project = await api('/api/projects', { name: '同源合同显式迁移' })
  const taskId = crypto.randomUUID(), conversationId = crypto.randomUUID()
  const text = '只生成全剧概要设计，主角归还铜钥匙。'
  const request = { model_id: old.id, mode: 'script', use_tools: false,
    workflow: { stage: 'outline', scope: 'project', episode_number: 0, artifact_types: ['outline'] }, messages: [{ role: 'user', text }],
    task: { id: taskId, conversation: { id: conversationId, messages: [{ id: crypto.randomUUID(), role: 'user', text }] },
      execution: { title: '概要设计', request: text, started_at: Date.now(), mode: 'script' } } }
  const calls: Array<{ model: string; purpose: string }> = []
  const failures = new Set(['old-model'])
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/model-switch\.invalid\//, 'all model work stays in the offline fixture')
    const body = JSON.parse(String(init?.body || '{}'))
    const prompt = body.messages?.[0]?.content || body.input || ''
    const review = draftCompletenessFixtureResponse(init)
    const purpose = review ? 'review' : 'draft'
    calls.push({ model: body.model, purpose })
    if (review) {
      if (failures.has(body.model)) return Response.json({ error: { message: `${body.model} review unavailable` } }, { status: 400 })
      return review
    }
    assert.match(prompt, /铜钥匙/)
    assert.equal(body.model, 'old-model', 'the retained draft must not be regenerated on the new model')
    return Response.json({ choices: [{ message: { content: JSON.stringify({ artifacts: [{ artifact_type: 'outline', title: '归还钥匙', content: '林舟拾到铜钥匙，为保护伙伴寻找失物主人，最终将铜钥匙归还。' }], scenes: [] }) }, finish_reason: 'stop' }] })
  })
  const stream = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: request })
  assert.equal(stream.statusCode, 200, stream.body)
  const taskUrl = `/api/projects/${project.id}/script/director/tasks/${taskId}`
  const snapshot = await api(taskUrl, undefined, 'GET')
  assert.equal(snapshot.status, 'failed', stream.body)
  assert.equal(snapshot.can_resume, true)
  assert.ok(one('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', project.id))
  const original = one<{ request_payload: string; resume_key: string }>('SELECT request_payload,resume_key FROM script_director_tasks WHERE id=?', taskId)!
  return { old, next, project, taskId, taskUrl, failures, calls, original }
}
function taskRow(id: string) { return one<{ request_payload: string; resume_key: string }>('SELECT request_payload,resume_key FROM script_director_tasks WHERE id=?', id)! }
async function taskEvents(taskUrl: string) {
  const response = await app.inject({ method: 'GET', url: taskUrl + '/stream' })
  assert.equal(response.statusCode, 200, response.body)
  return response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
}

test('explicit switching resumes only review under the new model and never saves the preview as formal work', async t => {
  const f = await setup(t)
  const checkpoint = one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', f.project.id)!.payload
  run('UPDATE models SET enabled=0 WHERE id=?', f.old.id)
  await api(f.taskUrl + '/continue', { model_id: f.next.id })
  const events = await taskEvents(f.taskUrl), done = events.find(event => event.type === 'done')
  assert.ok(done, JSON.stringify(events))
  assert.equal((await api(f.taskUrl, undefined, 'GET')).status, 'succeeded')
  assert.equal(JSON.parse(taskRow(f.taskId).request_payload).model_id, f.next.id)
  assert.deepEqual(f.calls, [{ model: 'old-model', purpose: 'draft' }, { model: 'old-model', purpose: 'review' }, { model: 'new-model', purpose: 'review' }])
  assert.ok(JSON.stringify(done).includes('林舟拾到铜钥匙'))
  assert.equal(all('SELECT id FROM script_artifacts WHERE project_id=?', f.project.id).length, 0)
  assert.ok(checkpoint.includes('林舟拾到铜钥匙'))
})

test('a failed new-model attempt restores the original request and key, whose validated draft still resumes', async t => {
  const f = await setup(t)
  f.failures.add('new-model')
  await api(f.taskUrl + '/continue', { model_id: f.next.id })
  const failed = await taskEvents(f.taskUrl)
  assert.ok(failed.some(event => event.type === 'error' && String(event.message).includes('new-model review unavailable')))
  assert.deepEqual(taskRow(f.taskId), f.original)
  assert.equal((await api(f.taskUrl, undefined, 'GET')).can_resume, true)
  f.failures.delete('old-model')
  await api(f.taskUrl + '/continue', {})
  const events = await taskEvents(f.taskUrl)
  assert.ok(events.some(event => event.type === 'done'), JSON.stringify(events))
  assert.equal(JSON.parse(taskRow(f.taskId).request_payload).model_id, f.old.id)
  assert.equal(f.calls.filter(call => call.purpose === 'draft').length, 1, 'failed switching and reverting must not regenerate the original draft')
  assert.equal(f.calls.at(-1)?.model, 'old-model')
})

test('changed source or original runtime rejects switching before dispatch and preserves the task', async t => {
  for (const kind of ['source', 'runtime']) await t.test(kind, async t => {
    const f = await setup(t)
    if (kind === 'source') run('UPDATE projects SET brief=? WHERE id=?', '新的创作约束', f.project.id)
    else run('UPDATE models SET remote_id=? WHERE id=?', 'modified-old-runtime', f.old.id)
    const before = f.calls.length
    const response = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: { model_id: f.next.id } })
    assert.ok([400, 409, 422].includes(response.statusCode), response.body)
    assert.match(response.body, /已变化|无法证明/)
    assert.equal(f.calls.length, before)
    assert.deepEqual(taskRow(f.taskId), f.original)
    assert.equal((await api(f.taskUrl, undefined, 'GET')).status, 'failed')
  })
})

test('a task with no complete draft refuses switching without dispatch or destroying its partial state', async t => {
  const f = await setup(t)
  const row = one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', f.project.id)!
  const checkpoint = JSON.parse(row.payload)
  for (const id of Object.keys(checkpoint.steps)) if (id !== 'progress:source') delete checkpoint.steps[id]
  checkpoint.steps['draft:stream:state'] = { input_hash: 'a'.repeat(64), duration_ms: 0, value: { partial: '尚未完整的正文', response_id: 'old-response' } }
  const payload = JSON.stringify(checkpoint)
  run('UPDATE script_generation_checkpoints SET payload=? WHERE project_id=?', payload, f.project.id)
  const count = f.calls.length
  const response = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: { model_id: f.next.id } })
  assert.ok([400, 409, 422].includes(response.statusCode), response.body)
  assert.match(response.body, /尚无可迁移|没有可迁移/)
  assert.equal(f.calls.length, count)
  assert.deepEqual(taskRow(f.taskId), f.original)
  assert.equal(one<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', f.project.id)!.payload, payload)
})


test('same-model selection and damaged checkpoint payloads reject before dispatch and preserve the original task', async t => {
  const f = await setup(t), count = f.calls.length
  const same = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: { model_id: f.old.id } })
  assert.equal(same.statusCode, 422)
  assert.match(same.body, /原任务相同/)
  for (const payload of ['{broken', JSON.stringify({ steps: null })]) {
    run('UPDATE script_generation_checkpoints SET payload=? WHERE project_id=?', payload, f.project.id)
    const response = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: { model_id: f.next.id } })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /检查点已损坏/)
    assert.equal(f.calls.length, count)
    assert.deepEqual(taskRow(f.taskId), f.original)
  }
})
