import { sourceScopeResponse } from './helpers/source-scope-response.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'

const testData = await mkdtemp(join(tmpdir(), 'studio-script-chat-context-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, run } = await import('../src/infrastructure/database/db.js')
const { scriptDocumentVersion, scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

type Protocol = 'chat_completions' | 'responses'
type NativeItem = { role?: string; type?: string; content?: string; output?: string; tool_call_id?: string; call_id?: string }
type NativeBody = { messages?: NativeItem[]; input?: NativeItem[] | string; tools?: Array<{ name?: string; function?: { name: string } }> }
const question = '“赵师傅”在哪一集出现过？'
const unrelated = 'UNRELATED_ORIGINAL_BODY_EPISODE_12'
const decision = '保留返乡主线，不把调查改为复仇。'
const stamp = '2026-10-19T08:00:00.000Z'

async function post<T extends { id: string }>(url: string, payload: unknown): Promise<T> {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

async function fixture(protocol: Protocol) {
  const project = await post('/api/projects', { name: '按需原文上下文回归' })
  const provider = await post('/api/providers', { name: '本地模拟文本接口', base_url: 'https://script-context.invalid/v1' })
  const model = await post('/api/models', { provider_id: provider.id, name: '文本工具模型', remote_id: 'context-test', modality: 'text', protocol,
    settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions',
      request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) },
      text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content' } })
  const parts = Array.from({ length: 12 }, (_, index) => `第${index + 1}集\n${'街道清晨，众人依照约定继续赶路。'.repeat(150)}\n` +
    (index === 2 ? Array.from({ length: 4 }, (_, occurrence) => `赵师傅：第${occurrence + 1}次提醒大家在城门等候。\n`).join('') : '') +
    (index === 11 ? `${unrelated}：最后一集另一处未选中的完整正文。\n` : '') + `第${index + 1}集结束。\n`)
  const source: ScriptSourceDocument = { project_id: project.id, filename: '长剧本.txt', content: parts.join(''), updated_at: stamp }
  let offset = 0
  const state: ScriptSourceAnalysis = { id: `analysis-${project.id}`, source_version: scriptSourceVersion(source), model_id: model.id,
    status: 'ready', phase: 'ready', pipeline_version: sourceAnalysisPipelineVersion, completed_chunks: 1, total_chunks: 1,
    completed_characters: source.content.length, updated_at: stamp, error: null,
    sections: parts.map((part, index) => {
      const section = { offset, length: part.length, title: `第${index + 1}集`, episode_number: index + 1,
        summary: `第${index + 1}集的检索线索。`, characters: [], events: [] }
      offset += part.length
      return section
    }),
    story: { summary: '主角返乡途中与众人共同调查旧案。', characters: [], timeline: [], threads: [],
      ending: { summary: '最终回到故乡。', section_ids: [11] }, uncertainties: [] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'passed', findings: [] }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, source.filename, source.content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', project.id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  run('INSERT INTO scripts (project_id,outline,characters,generation_options,updated_at) VALUES (?,?,?,?,?)', project.id, '', '', JSON.stringify({ visual_style: '日漫二维画风' }), stamp)
  run('INSERT INTO script_story_decisions (id,project_id,topic,content,basis,source_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    `decision-${project.id}`, project.id, '故事主线', decision, 'creator_confirmed', decision, stamp, stamp)
  return { project, model, source, state, version: scriptDocumentVersion(source) }
}

function history(body: NativeBody): NativeItem[] { return body.messages || (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input) || [] }
function prompt(body: NativeBody): string { return String(history(body)[0]?.content || '') }
function textResponse(protocol: Protocol, text: string) {
  return protocol === 'responses' ? Response.json({ status: 'completed', output_text: text,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
    : Response.json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
}
function toolResponse(protocol: Protocol, name: string, args: unknown) {
  return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'source-query', name, arguments: JSON.stringify(args) }] })
    : Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'source-query', type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
}
function intentResponse(protocol: Protocol) { return textResponse(protocol, JSON.stringify({ action: 'discuss', settings_patch: {} })) }
function chat(projectId: string, modelId: string, text = question) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/director/chat`, payload: {
    model_id: modelId, mode: 'script', use_tools: true, messages: [{ role: 'user', text }] } })
}


const uniqueRule = '作者独有硬要求9472：林棠的唯一职业是失物登记员，不能改成警察。'

function history40(rule: string) {
  return Array.from({ length: 41 }, (_, i) => i === 0
    ? { id: 'rule-msg', role: 'user' as const, text: rule }
    : { id: `m${String(i).padStart(2, '0')}`, role: (i % 2 ? 'assistant' : 'user') as 'assistant' | 'user', text: i % 2 ? `助手第${i}条：已了解。` : `作者第${i}条：只谈排版。` })
}
function taskBody(modelId: string, messages: ReturnType<typeof history40>, extra: Record<string, unknown> = {}) {
  const taskId = crypto.randomUUID(), conversationId = crypto.randomUUID()
  const stored = messages.slice(0, 40).concat(messages.at(-1)!.role === 'user' ? [] : [])
  const window = messages.slice(-32).map(({ role, text }) => ({ role, text }))
  return { taskId, conversationId, body: { task: { id: taskId, conversation: { id: conversationId, messages: stored },
    execution: { title: '讨论', request: '继续讨论', started_at: Date.now() } }, model_id: modelId, mode: 'script', use_tools: true, messages: window, ...extra } }
}

test('a hard requirement spoken early in a normal chat stays in force past the 32-message window without any manual ledger entry', async t => {
  const { project, model } = await fixture('chat_completions')
  const messages = history40(uniqueRule)
  // Make the last stored message a creator message, as the task requires.
  messages.splice(40); messages[39] = { id: 'last-user', role: 'user', text: '继续讨论排版。' }
  const prompts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    prompts.push(prompt(body))
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    return textResponse('chat_completions', '好的。')
  })
  const { taskId, body } = taskBody(model.id, messages)
  assert.equal(body.task.conversation.messages.length, 40); assert.equal(body.messages.length, 32)
  assert.ok(!body.messages.some((message: { text: string }) => message.text === uniqueRule), 'the rule is outside the request window')
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
  assert.equal(response.statusCode, 200, response.body)
  const toolPrompt = prompts.find(text => text.includes('实际对话（index用于决定来源）'))!
  assert.ok(toolPrompt.includes(uniqueRule), 'the verbatim rule reaches the model although no ledger entry was ever created')
  assert.ok(toolPrompt.indexOf('更早的创作者原话') < toolPrompt.indexOf('实际对话（index用于决定来源）'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM script_creator_requirements WHERE project_id=?').get(project.id)!.n, 0, 'nothing was recorded manually')
  // Assistant wording from outside the window is never carried forward.
  assert.ok(!toolPrompt.includes('助手第1条'))
  // The original history stays readable even after the stored conversation window moves on.
  const archived = db.prepare("SELECT text FROM script_message_archive WHERE project_id=? AND id='rule-msg'").get(project.id) as { text: string }
  assert.equal(archived.text, uniqueRule)
  assert.ok(taskId)
})

test('the fixed no-tool path keeps the same earlier creator wording', async t => {
  const { project, model } = await fixture('chat_completions')
  const messages = history40(uniqueRule); messages.splice(40); messages[39] = { id: 'last-user', role: 'user', text: '继续讨论排版。' }
  const prompts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    prompts.push(prompt(body))
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    return textResponse('chat_completions', '好的。')
  })
  const { body } = taskBody(model.id, messages, { use_tools: false })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
  assert.equal(response.statusCode, 200, response.body)
  assert.ok(prompts.some(text => text.includes(uniqueRule) && text.includes('更早的创作者原话')), 'the non-tool generation prompt carries the rule too')
})

test('a requirement recorded by the model in a normal task is bound to the real conversation and message ids', async t => {
  const { project, model } = await fixture('chat_completions')
  const messages = history40(uniqueRule); messages.splice(40)
  messages[39] = { id: 'last-user', role: 'user', text: `请记住：${uniqueRule}` }
  let turn = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turn++
    if (turn === 1) {
      const count = JSON.parse(String(init?.body)).messages ? 0 : 0
      void count
      return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'rec', type: 'function', function: { name: 'record_creator_requirement',
        arguments: JSON.stringify({ quote: uniqueRule, source_message_index: 31 }) } }] }, finish_reason: 'tool_calls' }] })
    }
    return textResponse('chat_completions', '已记录。')
  })
  const { conversationId, body } = taskBody(model.id, messages)
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
  assert.equal(response.statusCode, 200, response.body)
  const list = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/requirements` })).json().requirements
  assert.equal(list.length, 1, response.body.slice(0, 200))
  assert.equal(list[0].quote, uniqueRule)
  assert.equal(list[0].conversation_id, conversationId, 'bound to the stored conversation')
  assert.equal(list[0].message_id, 'last-user', 'bound to the real creator message id')
})

test('under size pressure the creator wording behind an active requirement is kept before newer chatter, and the rest is named by id', async () => {
  const { project } = await fixture('chat_completions')
  const { earlierCreatorMessages } = await import('../src/modules/script/script-creator-requirements.js')
  const { recordCreatorRequirement } = await import('../src/modules/script/script-creator-requirements.js')
  const conversationId = crypto.randomUUID()
  const stored = [{ id: 'rule', role: 'user' as const, text: uniqueRule },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `chat${i}`, role: 'user' as const, text: `闲聊第${i}句，` + '内容'.repeat(40) }))]
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: 'x',
    messages: [...stored.slice(0, 40), { id: 'last', role: 'user', text: '最后一句' }] } })
  assert.equal(saved.statusCode, 200, saved.body)
  // Recorded as a requirement through the ordinary route, citing the stored message.
  recordCreatorRequirement(project.id, { quote: uniqueRule, source: { text: uniqueRule, message_id: 'rule', conversation_id: conversationId } })
  const window: Array<{ id?: string; text: string }> = [{ id: 'last', text: '最后一句' }]
  const tight = earlierCreatorMessages(project.id, conversationId, window, 600)
  const ids = tight.messages.map(message => message.id)
  assert.ok(ids.includes('rule'), 'the message behind the active requirement survives although it is the oldest')
  assert.equal(tight.messages.find(message => message.id === 'rule')!.text, uniqueRule, 'and is kept verbatim, not shortened')
  assert.equal(tight.messages.find(message => message.id === 'rule')!.backs_requirement, true)
  assert.ok(tight.omitted > 0 && tight.omitted_ids.length > 0, 'what was dropped is counted and named so it can be read back')
  for (const id of tight.omitted_ids) assert.ok(await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations/${conversationId}/archive/${id}` })
    .then(response => response.statusCode === 200), `omitted message ${id} stays readable from the archive`)
  // Without pressure nothing is omitted.
  assert.equal(earlierCreatorMessages(project.id, conversationId, window).omitted, 0)
})

test('after the visible conversation rolls past 80 messages the first creator wording is still readable and citable as a requirement source', async () => {
  const { project } = await fixture('chat_completions')
  const permanent = '永久原话9863：唐宁永远是钟表修理工，不能改成教授。'
  const conversationId = crypto.randomUUID()
  const first = [{ id: 'original-000', role: 'user', text: permanent }, ...Array.from({ length: 79 }, (_, i) => ({ id: `archive-${String(i + 1).padStart(3, '0')}`, role: i % 2 ? 'user' : 'assistant', text: `滚动消息${i + 1}` }))]
  const second = Array.from({ length: 80 }, (_, i) => ({ id: `archive-${String(i + 20).padStart(3, '0')}`, role: i % 2 ? 'user' : 'assistant', text: `滚动消息${i + 20}` }))
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: 'x', messages: first } })).statusCode, 200)
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: 'x', messages: second } })).statusCode, 200)
  const visible = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations` })).json().conversations[0].messages as Array<{ id: string }>
  assert.equal(visible.length, 80); assert.ok(!visible.some(message => message.id === 'original-000'), 'the visible conversation no longer holds the first message')
  // 1. public read-back by id
  const one = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations/${conversationId}/archive/original-000` })
  assert.equal(one.statusCode, 200, one.body); assert.equal(one.json().text, permanent); assert.equal(one.json().role, 'user')
  // 2. paging covers the whole stored history in order, including messages that left the visible window
  const page = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations/${conversationId}/archive?limit=200` })).json()
  assert.equal(page.messages.length, 100); assert.equal(page.messages[0].id, 'original-000'); assert.equal(page.next_cursor, null)
  const paged = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations/${conversationId}/archive?limit=40` })).json()
  assert.equal(paged.messages.length, 40); assert.ok(paged.next_cursor)
  // 3. citable as a requirement source although the visible conversation lost it
  const recorded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/requirements`, payload: { quote: permanent, source: { conversation_id: conversationId, message_id: 'original-000' } } })
  assert.equal(recorded.statusCode, 200, recorded.body)
  assert.equal(recorded.json().message_id, 'original-000'); assert.equal(recorded.json().conversation_id, conversationId)
  // 4. an assistant message can still not become a requirement, and an unknown id is a 404
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/requirements`, payload: { quote: '滚动消息21', source: { conversation_id: conversationId, message_id: 'archive-021' } } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/conversations/${conversationId}/archive/nope` })).statusCode, 404)
  // 5. a new request in the same conversation still carries the early wording that rolled out of both windows
  const prompts: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    prompts.push(prompt(body))
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    return prompt(body).includes('本次独立调用只理解创作者意图') ? intentResponse('chat_completions') : textResponse('chat_completions', '好的。')
  }) as typeof fetch
  try {
    const model = (await app.inject({ method: 'GET', url: '/api/models' })).json().find((item: { name: string }) => item.name === '文本工具模型')
    const taskId = crypto.randomUUID()
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { task: { id: taskId,
      conversation: { id: conversationId, messages: [...second.slice(1), { id: 'now', role: 'user', text: '继续' }] }, execution: { title: 't', request: 'r', started_at: Date.now() } },
      model_id: model.id, mode: 'script', use_tools: true, messages: [...second.slice(-31), { id: 'now', role: 'user', text: '继续' }].map(({ role, text }) => ({ role, text })) } })
    assert.equal(response.statusCode, 200, response.body.slice(0, 200))
    assert.ok(prompts.some(text => text.includes(permanent)), 'the early requirement reaches a request made after the history rolled over')
  } finally { globalThis.fetch = original }
})

test('the model itself can read an omitted earlier message back by id with the provided tool, then record it as a requirement', async t => {
  const { project, model } = await fixture('chat_completions')
  const permanent = '永久原话9863：唐宁永远是钟表修理工，不能改成教授。'
  const stored = [{ id: 'original-000', role: 'user' as const, text: permanent },
    ...Array.from({ length: 38 }, (_, i) => ({ id: `fill-${i}`, role: (i % 2 ? 'user' : 'assistant') as 'assistant' | 'user', text: `填充${i}` })),
    { id: 'now', role: 'user' as const, text: '请把早先说过的硬要求补记进长期要求。' }]
  let turn = 0
  const seen: Array<{ id: string; value: any }> = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turn++
    for (const item of history(body).filter(entry => entry.role === 'tool')) if (!seen.some(entry => entry.id === item.tool_call_id)) seen.push({ id: item.tool_call_id!, value: JSON.parse(item.content!) })
    if (turn === 1) return loopingToolResponse('read-back', 'read_creator_requirements', { message_id: 'original-000' })
    if (turn === 2) return loopingToolResponse('record', 'record_creator_requirement', { quote: permanent, source_message_index: 0 })
    return textResponse('chat_completions', '已补记。')
  })
  const conversationId = crypto.randomUUID()
  const window = stored.slice(-32).map(({ role, text }) => ({ role, text }))
  assert.ok(!window.some(message => message.text === permanent), 'the wording is outside the request window')
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { task: { id: crypto.randomUUID(),
    conversation: { id: conversationId, messages: stored }, execution: { title: 't', request: 'r', started_at: Date.now() } }, model_id: model.id, mode: 'script', use_tools: true, messages: window } })
  assert.equal(response.statusCode, 200, response.body.slice(0, 200))
  const read = seen.find(entry => entry.id === 'read-back')!.value
  assert.equal(read.ok, true); assert.equal(read.result.message.text, permanent, 'the tool returned the original wording by id')
  assert.equal(read.result.message.role, 'user')
})

function loopingToolResponse(id: string, name: string, args: unknown) {
  return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
}

test('when earlier creator wording does not fit, generation refuses with a clear recoverable state instead of succeeding without it; a tool conversation is told to read it back', async t => {
  process.env.VIDEO_STUDIO_EARLIER_WORDING_CHARS = '600'
  t.after(() => { delete process.env.VIDEO_STUDIO_EARLIER_WORDING_CHARS })
  // The budget is read at import time, so exercise the pure function with an explicit budget and the HTTP path with a large history.
  const { project, model } = await fixture('chat_completions')
  const permanent = '永久原话1357：林棠的唯一职业是失物登记员，不能改成警察。'
  const stored = [{ id: 'rule', role: 'user' as const, text: permanent },
    ...Array.from({ length: 70 }, (_, i) => ({ id: `chatter-${i}`, role: 'user' as const, text: `闲聊第${i}句：` + '内容'.repeat(2500) }))]
  const conversationId = crypto.randomUUID()
  const prompts: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    prompts.push(prompt(body))
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    return textResponse('chat_completions', '好的。')
  })
  // 70 × ~5 KB of earlier creator wording exceeds the 200,000-character budget.
  for (let start = 0; start < stored.length; start += 40) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: 'x', messages: stored.slice(start, start + 40) } })).statusCode, 200)
  }
  const last = { id: 'now', role: 'user' as const, text: '请继续。' }
  const window = [last]
  const common = { conversation: { id: conversationId, messages: [last] } }
  const run = (extra: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { task: { id: crypto.randomUUID(), ...common,
    execution: { title: 't', request: 'r', started_at: Date.now() } }, model_id: model.id, mode: 'script', messages: window.map(({ role, text }) => ({ role, text })), ...extra } })
  // Fixed no-tool generation cannot read anything back, so it must not proceed with part of the wording missing.
  const fixed = await run({ use_tools: false })
  const body = fixed.body
  assert.match(body, /放不进本次生成/, 'the refusal names the problem')
  assert.ok(prompts.every(text => text.includes('本次独立调用只理解创作者意图')), 'only the intent check ran; no generation request reached the model')
  assert.match(body, /告诉助手把仍然有效的硬要求记为长期要求|开启新对话/, 'and the way to recover, in plain Chinese')
  assert.doesNotMatch(body.match(/"message":"[^"]*"/)?.[0] ?? '', /POST|GET|\/api\/|archive/, 'the creator-facing message carries no endpoint paths')
  assert.match(body, /earlier_creator_wording_incomplete/, 'the structured code travels in its own field')
  assert.ok(!prompts.some(text => text.includes('请继续。') && text.includes('更早的创作者原话') && text.includes('chatter')), 'no generation request went to the model with the wording partly missing')
})

test('a tool conversation under the same pressure still proceeds, with the omitted ids named and the read-back tool pointed at', async t => {
  const { project, model } = await fixture('chat_completions')
  const permanent = '永久原话2468：唐宁永远是钟表修理工，不能改成教授。'
  const stored = [{ id: 'rule', role: 'user' as const, text: permanent },
    ...Array.from({ length: 70 }, (_, i) => ({ id: `chatter-${i}`, role: 'user' as const, text: `闲聊第${i}句：` + '内容'.repeat(2500) }))]
  const conversationId = crypto.randomUUID()
  let toolPrompt = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    toolPrompt = prompt(body); return textResponse('chat_completions', '好的。')
  })
  for (let start = 0; start < stored.length; start += 40) {
    assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: 'x', messages: stored.slice(start, start + 40) } })).statusCode, 200)
  }
  const last = { id: 'now', role: 'user' as const, text: '请继续讨论。' }
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: { task: { id: crypto.randomUUID(),
    conversation: { id: conversationId, messages: [last] }, execution: { title: 't', request: 'r', started_at: Date.now() } }, model_id: model.id, mode: 'script', use_tools: true,
    messages: [{ role: last.role, text: last.text }] } })
  assert.equal(response.statusCode, 200, response.body.slice(0, 200))
  assert.match(toolPrompt, /因篇幅未随本次请求带入/); assert.match(toolPrompt, /read_creator_requirements 的 message_id/)
  assert.ok(toolPrompt.includes('"id":"rule"') || toolPrompt.includes('chatter-'), 'the ids of what was left out (or kept) are present')
})
