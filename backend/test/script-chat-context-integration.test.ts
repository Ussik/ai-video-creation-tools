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

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol}: targeted chat retains creator constraints and relays versioned source search results`, async t => {
  const { project, model, source, version } = await fixture(protocol)
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse(protocol)
    turns++
    assert.ok(prompt(body).includes(question), 'the exact creator request remains present across tool turns')
    assert.ok(prompt(body).includes('日漫二维画风'))
    assert.ok(prompt(body).includes(decision))
    assert.ok(prompt(body).includes('赵师傅：第1次提醒大家在城门等候。'), 'literal evidence is preloaded despite the omitted directory name')
    assert.ok(!prompt(body).includes(unrelated), 'unrelated exact original paragraphs are not in the initial prompt')
    assert.ok(!prompt(body).includes(JSON.stringify(source.content)), 'the source is not silently appended in full')
    const names = body.tools!.map(tool => tool.name || tool.function?.name)
    assert.ok(names.includes('search_source_document'))
    assert.ok(names.includes('read_full_source_document'), 'the model can deliberately expand to all original evidence')
    assert.ok(!names.includes('record_story_decision'))
    assert.ok(!names.includes('create_document_draft'))
    if (turns === 1) return toolResponse(protocol, 'search_source_document', { query: '赵师傅', limit: 1, source_version: version })
    assert.equal(turns, 2)
    const output = history(body).find(item => item.role === 'tool' || item.type === 'function_call_output')!
    assert.equal(output.tool_call_id || output.call_id, 'source-query')
    const value = JSON.parse(output.content || output.output!)
    assert.equal(value.ok, true)
    assert.equal(value.result.source_version, version)
    assert.equal(value.result.total_matches, 4)
    assert.equal(value.result.truncated, true)
    assert.equal(typeof value.result.next_cursor, 'string')
    assert.equal(value.result.matches.length, 1)
    const match = value.result.matches[0]
    assert.equal(source.content.slice(match.match_offset, match.match_offset + match.match_length), '赵师傅')
    assert.equal(source.content.slice(match.offset, match.offset + match.excerpt.length), match.excerpt)
    return textResponse(protocol, '已读取原文，“赵师傅”在第3集出现。')
  })
  const response = await chat(project.id, model.id)
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.json().reply, /第3集/)
  assert.equal(turns, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_tool_drafts WHERE project_id=?').get(project.id)!.count, 0)
})

test('a source replacement while a targeted model request is pending rejects even a direct final answer', async t => {
  const { project, model } = await fixture('chat_completions')
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turns++
    assert.ok(prompt(body).includes('【局部原文资料包】'))
    run('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?', '新上传剧本：赵师傅已不属于旧场次。', '2026-10-19T08:01:00.000Z', project.id)
    return textResponse('chat_completions', '已经按当前剧本确认，赵师傅在第3集。')
  })
  const response = await chat(project.id, model.id)
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /有效稿已变化|版本已变化/)
  assert.doesNotMatch(response.body, /已经按当前剧本确认/)
  assert.equal(turns, 1)
})

test('targeted chat can expand to the complete pinned original through a real native read', async t => {
  const { project, model, source, version } = await fixture('chat_completions')
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turns++
    assert.ok(!prompt(body).includes(unrelated))
    if (turns === 1) return toolResponse('chat_completions', 'read_full_source_document', {
      reason: '需要补读未提供章节，核实查询之外的上下文。' })
    assert.equal(turns, 2)
    const output = history(body).find(item => item.role === 'tool')!
    const result = JSON.parse(output.content!).result
    assert.equal(result.source_version, version, 'an omitted optional version is still bound to the session source')
    assert.equal(result.complete_source, true)
    assert.equal(result.content, source.content)
    assert.equal(result.offset, 0)
    assert.equal(result.next_offset, source.content.length)
    assert.equal(result.complete, true)
    return textResponse('chat_completions', '已补读完整原文，仍只回答本次查询。')
  })
  const response = await chat(project.id, model.id)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(turns, 2)
})

test('targeted chat rejects a mutating call even if a provider returns one outside the advertised read tools', async t => {
  const { project, model } = await fixture('chat_completions')
  let turns = 0, rejected = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turns++
    if (turns === 1) return toolResponse('chat_completions', 'record_story_decision', {
      topic: '非法改写', content: '把故事改为复仇', basis: 'creator_confirmed', source_message_index: 0 })
    const output = history(body).find(item => item.role === 'tool')
    if (output) {
      const result = JSON.parse(output.content!)
      assert.equal(result.ok, false)
      assert.match(result.error, /仅查询剧本原文|不执行创作修改/)
      rejected = true
    }
    return textResponse('chat_completions', '本次仅查找原文，没有修改故事。')
  })
  const response = await chat(project.id, model.id)
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(rejected, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_story_decisions WHERE project_id=?').get(project.id)!.count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_tool_drafts WHERE project_id=?').get(project.id)!.count, 0)
})

test('global, creative, unmatched and disabled requests retain the complete original input', async t => {
  const cases = [
    { label: '全剧问题', text: '请评价全剧结局和因果。' },
    { label: '含创作修改要求', text: '查找“赵师傅”，并修改第3集的台词。' },
    { label: '没有原文匹配', text: '“完全未出现的称呼”在哪一集出现过？' },
    { label: '关闭优化', text: question, disabled: true },
  ]
  for (const entry of cases) await t.test(entry.label, async t => {
    const { project, model, source } = await fixture('chat_completions')
    const previous = process.env.VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT
    if (entry.disabled) process.env.VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT = '0'
    t.after(() => { if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT; else process.env.VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT = previous })
    let turns = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as NativeBody
      if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
      turns++
      assert.ok(prompt(body).includes(JSON.stringify(source.content)))
      assert.ok(prompt(body).includes(unrelated))
      assert.ok(!prompt(body).includes('【局部原文资料包】'))
      assert.ok(body.tools!.some(tool => (tool.name || tool.function?.name) === 'record_story_decision'), 'the existing non-targeted tool contract remains available')
      return textResponse('chat_completions', '已结合完整原文回复。')
    })
    const response = await chat(project.id, model.id, entry.text)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(turns, 1)
  })
})
