import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'

const directory = await mkdtemp(join(tmpdir(), 'director-activity-attempt-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, one, run } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'attempt regression must never open the workspace database')
const { buildApp } = await import('../src/app.js')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
const { scriptActivitiesSchema } = await import('../src/modules/script/script-activity.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const historical: ScriptActivity = { id: 'old-request', kind: 'model', scope: 'step', parent_id: 'old-step',
  status: 'failed', label: '旧正文请求', summary: '保留这条活动及其结果', attempt: 0,
  started_at: 1, ended_at: 6, duration_ms: 5, request_bytes: 24, output_tokens: 9, output: '已收到的完整内容摘要' }
function taskInput() {
  const id = crypto.randomUUID(), conversationId = crypto.randomUUID()
  return { id, conversation: { id: conversationId, messages: [
    { id: crypto.randomUUID(), role: 'assistant' as const, text: '此前处理结果', activity: [structuredClone(historical)] },
    { id: crypto.randomUUID(), role: 'user' as const, text: '讨论主角年龄' },
  ] }, execution: { title: '讨论', request: '讨论主角年龄', started_at: Date.now(), mode: 'script' as const } }
}

test('task snapshots and SSE replay normalize historical zero attempts without rewriting or dropping saved records', async () => {
  const project = await api('POST', '/api/projects', { name: '历史活动读取兼容' }), input = taskInput(), tasks = createDirectorTasks()
  try {
    tasks.start(project.id, input, {}, async (_signal, emit) => {
      emit({ type: 'activity', activity: { ...historical } })
      emit({ type: 'process', activity: { ...historical }, text: '原文 attempt=0 保留' })
      return { reply: '已完成历史任务', activity: [{ ...historical }], source_output: { attempt: 0 } }
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    const written = tasks.read(project.id, input.id)
    assert.equal(written.status, 'succeeded')
    const fresh = written.events.find(event => event.type === 'activity')!.activity as ScriptActivity[]
    assert.equal(Object.hasOwn(fresh[0], 'attempt'), false, 'raw task activity emitters cannot persist zero attempts')
    assert.equal(Object.hasOwn((written.events.find(event => event.type === 'done')!.activity as ScriptActivity[])[0], 'attempt'), false)
    assert.equal(Object.hasOwn(written.events.find(event => event.type === 'process')!.activity as ScriptActivity, 'attempt'), false)
    const raw = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', input.id)!.snapshot)
    const retained = { ...historical, task_id: input.id, sequence: 1 }
    raw.events.find((event: { type: string }) => event.type === 'activity').activity = [retained]
    raw.events.find((event: { type: string }) => event.type === 'done').activity = [retained]
    raw.events.find((event: { type: string }) => event.type === 'process').activity = retained
    const rawSnapshot = JSON.stringify(raw), rawActivity = JSON.stringify([retained])
    run('UPDATE script_director_tasks SET snapshot=? WHERE id=?', rawSnapshot, input.id)
    run('UPDATE script_messages SET activity=? WHERE id=?', rawActivity, input.id)
    const taskUrl = `/api/projects/${project.id}/script/director/tasks/${input.id}`
    const snapshot = await api('GET', taskUrl)
    const activities = snapshot.events.find((event: { type: string }) => event.type === 'activity').activity
    const { attempt: _unknown, ...expected } = retained
    assert.deepEqual(activities, [expected])
    assert.deepEqual(scriptActivitiesSchema.parse(activities), [expected])
    assert.deepEqual(snapshot.events.find((event: { type: string }) => event.type === 'done').activity, [expected])
    assert.deepEqual(snapshot.events.find((event: { type: string }) => event.type === 'done').source_output, { attempt: 0 }, 'nested model output is not rewritten')
    assert.deepEqual(snapshot.events.find((event: { type: string }) => event.type === 'process').activity, expected)
    const replay = await app.inject({ method: 'GET', url: taskUrl + '/stream' })
    assert.equal(replay.statusCode, 200, replay.body)
    const events = replay.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    assert.deepEqual(events.find(event => event.type === 'activity').activity, [expected])
    assert.deepEqual(events.find(event => event.type === 'done').activity, [expected])
    assert.deepEqual(events.find(event => event.type === 'done').source_output, { attempt: 0 })
    assert.deepEqual(events.find(event => event.type === 'process').activity, expected)
    assert.equal(events.find(event => event.type === 'process').text, '原文 attempt=0 保留')
    const conversations = await api('GET', `/api/projects/${project.id}/script/conversations`)
    const message = conversations.conversations[0].messages.find((item: { id: string }) => item.id === input.id)
    assert.deepEqual(message.activity, [expected], 'history reads keep the original activity rather than discard the whole list')
    assert.equal(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', input.id)!.snapshot, rawSnapshot)
    assert.equal(one<{ activity: string }>('SELECT activity FROM script_messages WHERE id=?', input.id)!.activity, rawActivity)
  } finally { await tasks.close() }
})

async function requestFixture() {
  const project = await api('POST', '/api/projects', { name: '历史活动回传兼容' })
  const provider = await api('POST', '/api/providers', { name: 'attempt fixture', base_url: 'https://activity-attempt-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '模拟文本', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { text_api: { mode: 'standard' } } })
  return { project, model, input: taskInput() }
}

test('new director tasks accept a historical zero attempt in conversation and reach the mocked provider', async t => {
  const { project, model, input } = await requestFixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /activity-attempt-fixture\.invalid/)
    calls++
    return Response.json({ choices: [{ message: { content: '主角设定为二十六岁。' }, finish_reason: 'stop' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
    model_id: model.id, mode: 'script', focus_artifact: 'character', use_tools: false,
    messages: [{ role: 'user', text: '讨论主角年龄' }], task: input,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.body, /主角设定为二十六岁/)
  assert.equal(calls, 1)
  const snapshot = await api('GET', `/api/projects/${project.id}/script/director/tasks/${input.id}`)
  assert.equal(snapshot.status, 'succeeded')
  const conversations = await api('GET', `/api/projects/${project.id}/script/conversations`)
  const restored = conversations.conversations[0].messages.find((message: { id: string }) => message.id === input.conversation.messages[0].id)
  const { attempt: _unknown, ...expected } = historical
  assert.deepEqual(restored.activity, [expected])
})

test('invalid negative and fractional history attempts still fail at the HTTP boundary before a provider call', async t => {
  const { project, model, input } = await requestFixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Invalid history must not invoke a provider') })
  for (const attempt of [-1, .5]) {
    const invalid = structuredClone(input)
    invalid.conversation.messages[0].activity![0].attempt = attempt
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
      model_id: model.id, mode: 'script', focus_artifact: 'character', messages: [{ role: 'user', text: '讨论主角年龄' }], task: invalid,
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /attempt/)
  }
  assert.equal(calls, 0)
})
