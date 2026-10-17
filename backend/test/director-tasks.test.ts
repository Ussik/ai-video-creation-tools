import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'

const testData = await mkdtemp(join(tmpdir(), 'studio-director-tasks-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, one, run } = await import('../src/infrastructure/database/db.js')
let app = buildApp()
const nativeFetch = globalThis.fetch
let base = ''
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body); return result.json()
}
async function fixture() {
  if (!base) base = await app.listen({ host: '127.0.0.1', port: 0 })
  const provider = await call('POST', '/api/providers', { name: '模拟任务提供商', base_url: 'https://task-fixture.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '模拟文本', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const project = await call('POST', '/api/projects', { name: '任务恢复测试' })
  const id = crypto.randomUUID(), conversationId = crypto.randomUUID()
  const body = { model_id: model.id, mode: 'script', focus_artifact: 'character', messages: [{ role: 'user', text: '讨论主角年龄' }],
    task: { id, conversation: { id: conversationId, messages: [{ id: 'question', role: 'user', text: '讨论主角年龄' }] },
      execution: { title: '人物讨论', request: '讨论主角年龄', started_at: Date.now(), focus_artifact: 'character', mode: 'script' } } }
  return { project, model, id, conversationId, body, url: `/api/projects/${project.id}/script/director/chat/stream`, taskUrl: `/api/projects/${project.id}/script/director/tasks/${id}` }
}
function holdProvider(t: any, ignoresAbort = false) {
  let release!: () => void, entered!: () => void, calls = 0, signal!: AbortSignal
  const started = new Promise<void>(resolve => { entered = resolve })
  const result = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /task-fixture\.invalid/); calls++; signal = init!.signal!; entered()
    if (!ignoresAbort) signal.addEventListener('abort', () => {}, { once: true })
    await result
    return Response.json({ choices: [{ message: { content: '主角的新年龄设定为二十六岁。' } }] })
  })
  return { started, release, calls: () => calls, signal: () => signal }
}
async function begin(url: string, body: unknown) {
  const response = await nativeFetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal(response.status, 200)
  return response
}

test('leaving detaches the viewer; reentry and identical submissions share one task and preserve the server reply against stale saves', async t => {
  const f = await fixture(), provider = holdProvider(t)
  const first = await begin(f.url, f.body)
  await provider.started
  await first.body!.cancel()
  assert.equal(provider.signal().aborted, false)
  const savedWhileRunning = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.equal(savedWhileRunning.task_persistence, true); assert.equal(savedWhileRunning.tasks[0].id, f.id)
  assert.equal(savedWhileRunning.conversations[0].messages.at(-1).pending, true)
  const duplicate = await begin(f.url, f.body); await duplicate.body!.cancel()
  assert.equal(provider.calls(), 1, 'the same task cannot invoke the provider twice')
  const conflicting = await app.inject({ method: 'POST', url: f.url, payload: { ...f.body, task: { ...f.body.task, id: 'another-task' } } })
  assert.equal(conflicting.statusCode, 409)
  const changed = await app.inject({ method: 'POST', url: f.url, payload: { ...f.body, messages: [{ role: 'user', text: '另一条请求' }] } })
  assert.equal(changed.statusCode, 409)
  const other = await call('POST', '/api/projects', { name: '另一项目' })
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${other.id}/script/director/tasks/${f.id}/stream` })).statusCode, 404)
  const joined = await nativeFetch(base + f.taskUrl + '/stream')
  provider.release()
  const events = await joined.text(); assert.match(events, /"type":"done"/); assert.match(events, /二十六岁/)
  const finished = await call('GET', f.taskUrl); assert.equal(finished.status, 'succeeded')
  await call('PUT', `/api/projects/${f.project.id}/script/conversations`, { id: f.conversationId, messages: [] })
  const restored = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.equal(restored.tasks.length, 0)
  assert.deepEqual(restored.conversations[0].messages.map((message: any) => message.id), ['question', f.id])
  assert.match(restored.conversations[0].messages.at(-1).text, /二十六岁/)
  assert.equal(restored.conversations[0].messages.at(-1).execution.outcome.kind, 'reply')
  assert.equal(provider.calls(), 1)
})

test('explicit stop cancels the server task, persists a terminal record, and reentry never restarts generation', async t => {
  const f = await fixture(), provider = holdProvider(t, true)
  const first = await begin(f.url, f.body); await provider.started
  await call('POST', f.taskUrl + '/cancel', {})
  const events = await first.text(); assert.match(events, /"task_status":"cancelled"/)
  const task = await call('GET', f.taskUrl); assert.equal(task.status, 'cancelled'); assert.equal(provider.signal().aborted, true)
  const restored = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.equal(restored.conversations[0].messages.at(-1).pending, false)
  assert.equal(restored.conversations[0].messages.at(-1).failed, true)
  assert.equal(restored.conversations[0].messages.at(-1).execution.outcome.kind, 'cancelled')
  const replay = await begin(f.url, f.body); assert.match(await replay.text(), /cancelled/); assert.equal(provider.calls(), 1)
})

test('independent projects may run director tasks concurrently', async t => {
  const firstTask = await fixture(), provider = holdProvider(t)
  const other = await call('POST', '/api/projects', { name: '并行项目' })
  const secondId = crypto.randomUUID(), secondConversation = crypto.randomUUID()
  const secondBody = { ...firstTask.body, task: { ...firstTask.body.task, id: secondId,
    conversation: { ...firstTask.body.task.conversation, id: secondConversation } } }
  const first = await begin(firstTask.url, firstTask.body)
  await provider.started
  const second = await begin(`/api/projects/${other.id}/script/director/chat/stream`, secondBody)
  assert.equal(provider.calls(), 2)
  const states = await Promise.all([call('GET', `/api/projects/${firstTask.project.id}/script/conversations`), call('GET', `/api/projects/${other.id}/script/conversations`)])
  assert.equal(states[0].tasks.length, 1); assert.equal(states[1].tasks.length, 1)
  provider.release()
  assert.match(await first.text(), /"type":"done"/)
  assert.match(await second.text(), /"type":"done"/)
})

test('JSON-only stage drafts survive leaving and are resolved atomically with confirmation', async t => {
  const f = await fixture()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const reviewed = draftCompletenessFixtureResponse(init); if (reviewed) return reviewed
    const prompt = JSON.parse(String(init?.body)).messages[0].content
    const content = prompt.includes('本次独立调用只理解创作者意图') ? { action: 'discuss', settings_patch: {} }
      : { artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '主角调查雨夜失踪事件，最终揭露骗局。' })), scenes: [] }
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })
  })
  const body = { ...f.body, focus_artifact: 'all', workflow: { stage: 'outline' }, task: { ...f.body.task, execution: { ...f.body.task.execution, focus_artifact: 'all' } } }
  const response = await begin(f.url, body); await response.text()
  const conversations = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  const completion = conversations.draft_results[0].events.find((event: any) => event.type === 'done')
  assert.equal(completion.draft.stage, 'outline')
  assert.equal((await call('GET', `/api/projects/${f.project.id}`)).script.outline, '', 'draft recovery cannot save documents')
  await call('PUT', `/api/projects/${f.project.id}/script/director/draft`, { ...completion.draft, task_id: f.id })
  const after = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.equal(after.draft_results.length, 0); assert.equal(after.conversations[0].messages.at(-1).execution.outcome.kind, 'saved')
})

test('server shutdown and crash recovery mark unfinished work interrupted without repeating provider calls', async t => {
  const f = await fixture(), provider = holdProvider(t, true)
  const response = await begin(f.url, f.body); await provider.started
  await app.close(); base = ''
  assert.match(await response.text(), /"task_status":"interrupted"/)
  const snapshot = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', f.id)!.snapshot)
  snapshot.status = 'running'; snapshot.events = [{ type: 'activity', activity: [{ id: 'operation', kind: 'model', status: 'running', label: '处理', summary: '', started_at: Date.now() }] }]
  run("UPDATE script_director_tasks SET status='running', snapshot=? WHERE id=?", JSON.stringify(snapshot), f.id)
  app = buildApp()
  const task = await call('GET', f.taskUrl); assert.equal(task.status, 'interrupted')
  const restored = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.equal(restored.tasks.length, 0); assert.equal(restored.conversations[0].messages.at(-1).failed, true)
  assert.match(restored.conversations[0].messages.at(-1).text, /重启/)
  assert.equal(task.events[0].activity[0].status, 'failed'); assert.equal(provider.calls(), 1)
})

test('explicit continuation reuses task and conversation IDs; duplicate continue clicks share one request', async t => {
  const f = await fixture()
  let calls = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (calls === 1) return Response.json({ error: { message: 'fixture failure' } }, { status: 400 })
    await held
    return Response.json({ choices: [{ message: { content: '已完成剩余讨论。' } }] })
  })
  await (await begin(f.url, f.body)).text()
  const failed = await call('GET', f.taskUrl)
  assert.equal(failed.status, 'failed'); assert.equal(failed.can_resume, true)
  const first = await call('POST', f.taskUrl + '/continue', {})
  const duplicate = await call('POST', f.taskUrl + '/continue', {})
  assert.equal(first.id, f.id); assert.equal(duplicate.id, f.id); assert.equal(calls, 2)
  const joined = await nativeFetch(base + f.taskUrl + '/stream')
  release()
  assert.match(await joined.text(), /已完成剩余讨论/)
  const restored = await call('GET', `/api/projects/${f.project.id}/script/conversations`)
  assert.deepEqual(restored.conversations[0].messages.map((item: any) => item.id), ['question', f.id])
  const final = await call('GET', f.taskUrl)
  assert.equal(final.status, 'succeeded'); assert.equal(final.can_resume, false); assert.ok(final.sequence > failed.sequence)
})

test('continuation rejects changed source/configuration instead of reusing an incompatible task', async t => {
  const f = await fixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'fixture failure' } }, { status: 400 }) })
  await (await begin(f.url, f.body)).text()
  run('UPDATE projects SET name=? WHERE id=?', '创作者已修改项目', f.project.id)
  const result = await app.inject({ method: 'POST', url: f.taskUrl + '/continue', payload: {} })
  assert.equal(result.statusCode, 409); assert.match(result.body, /已变化/); assert.equal(calls, 1)
})
