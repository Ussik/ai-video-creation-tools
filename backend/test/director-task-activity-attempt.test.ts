import { readFileSync } from 'node:fs'
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
    assert.match(response.json().diagnostics, /attempt/)
  }
  assert.equal(calls, 0)
})


const protocolFields = ['request_has_tools', 'request_tool_count', 'request_structured_mode', 'response_text_blocks', 'response_thinking_blocks',
  'response_tool_use_blocks', 'response_other_blocks', 'response_complete', 'response_blocks_closed', 'response_protocol_terminal'] as const

test('actual native protocol metrics survive task persistence, history reload and the next director HTTP submission', async t => {
  const { createTextToolTransport } = await import('../src/infrastructure/providers/providers.js')
  const { project, model, input } = await requestFixture()
  let nextCalls = 0
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('shape-native-fixture.invalid')) return Response.json({ type: 'message', content: [
      { type: 'thinking', thinking: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' },
      { type: 'tool_use', id: 'submit-1', name: 'submit_source_repair', input: { summary: '仅核对', source_edits: [] } },
    ], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } })
    assert.match(String(url), /activity-attempt-fixture\.invalid/)
    nextCalls++
    return Response.json({ choices: [{ message: { content: '已沿用历史活动继续讨论。' }, finish_reason: 'stop' }] })
  })
  let actual: Record<string, unknown> | undefined
  await createTextToolTransport({ id: 'native-shape', remote_id: 'fixture', modality: 'text', protocol: 'anthropic_messages',
    settings: { text_api: { mode: 'standard', max_output_tokens: 65536 } } },
    { adapter: 'http', base_url: 'https://shape-native-fixture.invalid/v1' }, 'PRIVATE_PROMPT',
    [{ name: 'submit_source_repair', description: 'fixture', parameters: { type: 'object' } }], undefined, [], () => '', undefined, undefined, undefined,
    value => { actual = value as unknown as Record<string, unknown> })
  assert.ok(actual)
  const shape = Object.fromEntries(protocolFields.map(key => [key, actual![key]]))
  assert.deepEqual(shape, { request_has_tools: true, request_tool_count: 1, request_structured_mode: 'none', response_text_blocks: 0,
    response_thinking_blocks: 1, response_tool_use_blocks: 1, response_other_blocks: 0, response_complete: true, response_blocks_closed: true, response_protocol_terminal: true })
  const activity: ScriptActivity = { id: 'native-shape-activity', kind: 'model', status: 'succeeded', label: '原稿同步请求', summary: '完整提交待验证结果',
    started_at: 1, ended_at: 3, request_bytes: actual!.request_bytes as number, raw_reason: 'tool_use', delivery: 'completed', ...shape }
  const tasks = createDirectorTasks()
  try {
    tasks.start(project.id, input, {}, async (_signal, emit) => { emit({ type: 'activity', activity }); return { reply: '此前修订已保留', activity: [activity] } })
    await new Promise<void>(resolve => setImmediate(resolve))
    const disk = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', input.id)!.snapshot)
    assert.equal(disk.status, 'succeeded')
    assert.deepEqual(Object.fromEntries(protocolFields.map(key => [key, disk.events.find((event: any) => event.type === 'activity').activity[0][key]])), shape)
    const history = await api('GET', `/api/projects/${project.id}/script/conversations`)
    const messages = history.conversations[0].messages
    const restored = messages.find((message: any) => message.id === input.id)
    assert.deepEqual(Object.fromEntries(protocolFields.map(key => [key, restored.activity[0][key]])), shape)
    assert.deepEqual(scriptActivitiesSchema.parse(restored.activity), restored.activity)
    const continued = { ...input, id: crypto.randomUUID(), conversation: { id: input.conversation.id,
      messages: [...messages.map((message: any) => ({ id: message.id, role: message.role, text: message.text,
        ...(message.role === 'assistant' && Array.isArray(message.activity) ? { activity: message.activity } : {}) })), { id: crypto.randomUUID(), role: 'user', text: '继续讨论主角年龄' }] } }
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
      model_id: model.id, mode: 'script', focus_artifact: 'character', use_tools: false, messages: [{ role: 'user', text: '继续讨论主角年龄' }], task: continued,
    } })
    assert.equal(response.statusCode, 200, response.body); assert.match(response.body, /已沿用历史活动继续讨论/); assert.equal(nextCalls, 1)
    const next = await api('GET', `/api/projects/${project.id}/script/director/tasks/${continued.id}`)
    assert.equal(next.status, 'succeeded')
    const reread = await api('GET', `/api/projects/${project.id}/script/conversations`)
    const retained = reread.conversations[0].messages.find((message: any) => message.id === input.id)
    assert.deepEqual(retained.activity, restored.activity)
    assert.doesNotMatch(JSON.stringify(retained.activity), /PRIVATE_REASONING|PRIVATE_SIGNATURE|PRIVATE_PROMPT|submit_source_repair/)
  } finally { await tasks.close() }
})

test('strict HTTP activity history rejects invalid protocol flags, counts, modes and undeclared private fields before dispatch', async t => {
  const { project, model, input } = await requestFixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('invalid metadata must never dispatch') })
  const invalids = [
    { request_has_tools: 'true' }, { request_tool_count: -1 }, { request_tool_count: .5 }, { request_structured_mode: 'tool-call' },
    { response_text_blocks: Number.MAX_SAFE_INTEGER + 1 }, { response_thinking_blocks: -1 }, { response_tool_use_blocks: .25 }, { response_other_blocks: '1' },
    { response_complete: 1 }, { response_blocks_closed: 'true' }, { response_protocol_terminal: {} }, { private_tool_arguments: 'PRIVATE_VALUE' },
  ]
  for (const shape of invalids) {
    const invalid = structuredClone(input)
    Object.assign(invalid.conversation.messages[0].activity![0], shape)
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
      model_id: model.id, mode: 'script', focus_artifact: 'character', messages: [{ role: 'user', text: '继续讨论' }], task: invalid,
    } })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.equal(calls, 0)
})


const structuredEvidence = {
  structured_strategy_source: 'default' as const, structured_enforcement: 'unverified' as const,
  request_prompt_hash: 'a'.repeat(64), request_body_hash: 'b'.repeat(64),
  response_body_hash: 'c'.repeat(64), response_text_hash: 'd'.repeat(64), response_json_valid: true,
}
test('completed character history crosses the next location-stage HTTP boundary without losing public observation or business content', async t => {
  const { project, model, input } = await requestFixture()
  for (const type of ['outline', 'synopsis', 'world', 'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints', 'episode_outline', 'characters', 'relationships']) {
    run('INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      crypto.randomUUID(), project.id, type, type, '已确认正文。', 'ready', 'now', 'now')
  }
  const fixturePath = process.env.VIDEO_STUDIO_TEST_HISTORY_FIXTURE
  const messages = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')).messages : [
    { id: crypto.randomUUID(), role: 'assistant', text: '人物小传和关系已完成，正文保留。', activity: [
      { ...historical, attempt: 1, status: 'succeeded', label: '编写人物小传', ...structuredEvidence },
      { ...historical, id: 'relationships-completed', attempt: 1, status: 'succeeded', label: '编写人物关系', ...structuredEvidence },
    ] },
  ]
  const original = JSON.stringify(messages)
  for (const message of messages) if (message.activity) assert.deepEqual(scriptActivitiesSchema.parse(message.activity), message.activity)
  const nextUser = { id: crypto.randomUUID(), role: 'user', text: '生成全剧场景设计' }
  const task = { ...input, conversation: { ...input.conversation, messages: [...messages, nextUser] },
    execution: { title: '生成全剧场景设计', request: nextUser.text, started_at: Date.now(), mode: 'script' as const } }
  let dispatches = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.match(String(url), /activity-attempt-fixture\.invalid/)
    dispatches++
    // Prove boundary admission only; no real or fabricated successful authoring.
    return Response.json({ error: { message: 'offline boundary reached', type: 'invalid_request_error' } }, { status: 400 })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
    model_id: model.id, mode: 'script', focus_artifact: 'all', use_tools: false, skill_selections: { script: [] },
    workflow: { stage: 'locations', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['locations'] },
    messages: [{ role: 'user', text: nextUser.text }], task,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(dispatches, 1, response.body)
  assert.doesNotMatch(response.body, /Unrecognized keys|task\.conversation\.messages/)
  assert.equal(JSON.stringify(messages), original, 'real history is not projected away or mutated')
  const history = await api('GET', `/api/projects/${project.id}/script/conversations`)
  for (const message of messages) {
    const saved = history.conversations[0].messages.find((item: any) => item.id === message.id)
    assert.equal(saved.text, message.text)
    assert.deepEqual(saved.activity, message.activity || [])
  }
})

test('invalid structured evidence is rejected without displaying raw Zod paths or dispatching', async t => {
  const { project, model, input } = await requestFixture()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('must not dispatch') })
  for (const invalid of [{ request_prompt_hash: 'not-a-hash' }, { structured_strategy_source: 'invented' },
    { structured_enforcement: 'guaranteed' }, { response_json_valid: 'yes' }, { provider_private_body: 'not allowed' }]) {
    const task = structuredClone(input)
    Object.assign(task.conversation.messages[0].activity![0], structuredEvidence, invalid)
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: {
      model_id: model.id, mode: 'script', focus_artifact: 'all', messages: [{ role: 'user', text: '生成场景' }], task,
    } })
    assert.equal(response.statusCode, 422)
    const body = response.json()
    assert.match(body.detail, /历史任务记录格式不兼容/)
    assert.doesNotMatch(body.detail, /task\.conversation|Unrecognized keys|\[0\]/)
    assert.match(body.diagnostics, /activity/)
  }
  assert.equal(calls, 0)
})
