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


function loopingToolResponse(id: string, name: string, args: unknown) {
  return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
}

test('an ordinary conversation that keeps repeating the identical read is stopped with a diagnosis instead of dispatching forever', async t => {
  const { project, model } = await fixture('chat_completions')
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turns++
    if (turns > 40) return textResponse('chat_completions', '（保护：不应走到这里）')
    return loopingToolResponse(`same-${turns}`, 'get_creation_state', {})
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true,
    messages: [{ role: 'user', text: '随便聊聊' }] } })
  assert.equal(response.statusCode, 200, response.body.slice(0, 200))
  assert.ok(turns >= 2 && turns <= 6, `identical results ended dispatch after ${turns} model turns, not at the fuse`)
  const activity = response.json().activity as Array<{ label: string; status: string; summary: string }>
  const stop = activity.find(item => item.label === '已停止重复处理')
  assert.ok(stop, 'the stop is recorded'); assert.match(stop!.summary, /没有新增|重复/)
  assert.match(response.json().reply, /没有新增|重复|未获得新的有效结果/, 'the creator sees why it ended')
})

test('legitimate varied reading is never treated as a stall', async t => {
  const { project, model } = await fixture('chat_completions')
  let turns = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as NativeBody
    const scope = sourceScopeResponse(prompt(body))
    if (scope) return textResponse('chat_completions', scope)
    if (prompt(body).includes('本次独立调用只理解创作者意图')) return intentResponse('chat_completions')
    turns++
    if (turns <= 8) return loopingToolResponse(`range-${turns}`, 'read_source_document', { offset: (turns - 1) * 1500, length: 1500 })
    return textResponse('chat_completions', '读完了。')
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: true,
    messages: [{ role: 'user', text: '请通读原稿，不要遗漏。' }] } })
  assert.equal(response.statusCode, 200, response.body.slice(0, 200))
  assert.equal(turns, 9, 'eight distinct ranges and the final answer all ran')
  assert.ok(!(response.json().activity as Array<{ label: string }>).some(item => item.label === '已停止重复处理'), 'no stall was declared')
})
