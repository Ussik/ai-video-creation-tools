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


function multiToolResponse(calls: Array<{ id: string; name: string; args: unknown }>) {
  return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls.map(call => ({ id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }] })
}
const hardRule = '所有对白必须保持第一人称，禁止出现旁白。'
const replacement = '对白可以使用第三人称，旁白改为每集不超过两句。'
async function put(path: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url: path, payload }); return { status: response.statusCode, body: response.json() as any }
}

test('creator requirements keep verbatim quotes with their source, outlive the chat window, and replace explicitly', async t => {
  const { project, model } = await fixture('chat_completions')
  const base = `/api/projects/${project.id}/script/requirements`
  const conversationId = crypto.randomUUID(), early = crypto.randomUUID(), suggestion = crypto.randomUUID()
  // 40 stored messages: the hard rule is first, so it is far outside the 32-message request window.
  const messages = [{ id: early, role: 'user', text: `开场就说清楚：${hardRule} 另外结局暂时还没想好。` },
    { id: suggestion, role: 'assistant', text: '我建议主角最后牺牲，这样更悲壮。' },
    ...Array.from({ length: 38 }, (_, i) => ({ id: crypto.randomUUID(), role: i % 2 ? 'assistant' : 'user', text: `第${i}条普通讨论。` }))]
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/conversations`, payload: { id: conversationId, label: '长对话', messages } })
  assert.equal(saved.statusCode, 200, saved.body)

  // 1. verbatim-quote validation: a paraphrase, an assistant message and a stranger's text are all refused.
  assert.equal((await put(base, { quote: '对白保持第一人称，不要旁白', source: { conversation_id: conversationId, message_id: early } })).status, 422, 'paraphrase is not a quote')
  assert.equal((await put(base, { quote: '我建议主角最后牺牲', source: { conversation_id: conversationId, message_id: suggestion } })).status, 404, 'assistant text can not become a requirement')
  const first = await put(base, { quote: hardRule, scope: '全剧对白', source: { conversation_id: conversationId, message_id: early } })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.quote, hardRule); assert.equal(first.body.status, 'active'); assert.equal(first.body.message_id, early)
  assert.ok(first.body.source_text.includes('结局暂时还没想好'), 'the complete original message is kept for read-back')

  // 2. an undecided matter is recorded as an open question, not promoted to a decision.
  const open = await put(base, { kind: 'open_question', quote: '结局暂时还没想好', source: { conversation_id: conversationId, message_id: early } })
  assert.equal(open.body.kind, 'open_question')

  // 3. the model sees the ledger on a later turn although the message left the request window.
  let seen = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    seen = prompt(body); return textResponse('chat_completions', '好的。')
  })
  const recent = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `最近第${i}句。` }))
  const turn = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true, messages: recent } })
  assert.equal(turn.statusCode, 200, turn.body)
  assert.ok(!seen.includes('开场就说清楚'), 'the early message itself is outside the request')
  assert.ok(seen.includes(hardRule), 'its verbatim requirement is still in the prompt')
  assert.ok(seen.includes('"kind":"open_question"') && seen.includes('结局暂时还没想好'), 'the undecided matter is labelled as open, not as a decision')
  assert.ok(!seen.includes('我建议主角最后牺牲'), 'an assistant suggestion is never promoted')

  // 4. explicit replacement: the old entry is superseded (kept for audit), the new one is active.
  const later = crypto.randomUUID()
  const change = await put(base, { quote: replacement, supersedes: [first.body.id], source: { text: `改一下，${replacement}`, message_id: later } })
  assert.equal(change.status, 200, JSON.stringify(change.body))
  assert.equal(change.body.supersedes_id, first.body.id)
  const active = (await app.inject({ method: 'GET', url: base })).json().requirements.map((item: any) => item.quote)
  assert.deepEqual(active.sort(), [replacement, '结局暂时还没想好'].sort(), 'only the replacement and the open question are active')
  const all = (await app.inject({ method: 'GET', url: `${base}?include_superseded=true` })).json().requirements
  const old = all.find((item: any) => item.id === first.body.id)
  assert.equal(old.status, 'superseded'); assert.equal(old.superseded_by, change.body.id); assert.equal(old.quote, hardRule, 'the replaced wording stays readable')
  assert.equal((await put(base, { quote: replacement, supersedes: [first.body.id], source: { text: replacement } })).status, 409, 'an entry can only be replaced once')

  // 5. later turns carry the replacement, not the replaced rule.
  seen = ''
  await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true, messages: recent } })
  assert.ok(seen.includes(replacement)); assert.ok(!seen.includes(hardRule), 'a superseded requirement no longer governs the next request')
  const readBack = (await app.inject({ method: 'GET', url: `${base}/${first.body.id}` })).json()
  assert.ok(readBack.source_text.includes(hardRule), 'the original message stays readable by id')

  // 6. withdrawal without a replacement needs the creator's own words.
  const stillOpen = (await app.inject({ method: 'GET', url: base })).json().requirements.find((item: any) => item.kind === 'open_question')
  assert.equal((await put(`${base}/${stillOpen.id}/withdraw`, { quote: '随便', source: { text: '不相关的话' } })).status, 422)
  assert.equal((await put(`${base}/${stillOpen.id}/withdraw`, { quote: '结局定了', source: { text: '结局定了，就是开放式。' } })).status, 200)
  assert.deepEqual((await app.inject({ method: 'GET', url: base })).json().requirements.map((item: any) => item.quote), [replacement])
})

test('the model tools record, supersede and read requirements, and refuse assistant text', async t => {
  const { project, model } = await fixture('chat_completions')
  let turn = 0
  const results: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turn++
    if (turn === 1) return multiToolResponse([
      { id: 'rec', name: 'record_creator_requirement', args: { quote: hardRule, source_message_index: 0, scope: '对白' } },
      { id: 'bad', name: 'record_creator_requirement', args: { quote: '我建议主角牺牲', source_message_index: 1 } },
    ])
    for (const item of history(body).filter(entry => entry.role === 'tool')) results.push({ id: item.tool_call_id, value: JSON.parse(item.content!) })
    return textResponse('chat_completions', '已记录。')
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true,
    messages: [{ role: 'user', text: `请记住：${hardRule}` }, { role: 'assistant', text: '我建议主角牺牲。' }, { role: 'user', text: '继续。' }] } })
  assert.equal(response.statusCode, 200, response.body)
  const recorded = results.find(item => item.id === 'rec').value, refused = results.find(item => item.id === 'bad').value
  assert.equal(recorded.ok, true); assert.equal(recorded.result.requirement.quote, hardRule)
  assert.equal(refused.ok, false, 'a quote from an assistant message is refused')
  const list = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/requirements` })).json().requirements
  assert.equal(list.length, 1); assert.equal(list[0].quote, hardRule)
})
