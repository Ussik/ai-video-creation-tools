import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot, ScriptToolDraft } from '../src/modules/script/script-document-tools.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-revision-continuation-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, one, all, run } = await import('../src/infrastructure/database/db.js')
const { documentTools, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

type Protocol = 'chat_completions' | 'responses'
async function post<T>(url: string, payload: unknown): Promise<T> {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture(protocol: Protocol = 'chat_completions') {
  const project = await post<Project>('/api/projects', { name: '显式继续统一修订' })
  const provider = await post<{ id: string }>('/api/providers', { name: '模拟文本提供商', base_url: 'https://revision-continuation.invalid/v1' })
  const model = await post<{ id: string }>('/api/models', { provider_id: provider.id, name: '模拟工具模型', remote_id: 'revision-test', modality: 'text', protocol,
    settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions', stream: false,
      request_template: { model: '{{model}}', ...(protocol === 'responses' ? { input: '{{prompt}}' } : { messages: [{ role: 'user', content: '{{prompt}}' }] }) },
      text_path: protocol === 'responses' ? 'output_text' : 'choices.0.message.content' } })
  const saved = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/script/artifacts`, payload: { artifacts: [{ artifact_type: 'characters', episode_number: 0, title: '人物小传', content: '林晚：调查记者。', status: 'ready' }] } })
  assert.equal(saved.statusCode, 200, saved.body)
  const script = (): ScriptSnapshot => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)
    return { outline: row?.outline || '', characters: row?.characters || '', generation_options: JSON.parse(row?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id),
      scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) }
  }
  const tools = documentTools({ project, script, stage: directorStageContext(script()),
    messages: [{ role: 'user', text: '统一核对全项目文档，保持林晚为调查记者，只预览不保存。' }], checkApproval: async () => false, onEvent: () => {} })
  const started = await tools.execute('manage_revision_task', { operation: 'start', scope: 'all_documents', summary: '统一核对人物设定，不自动保存', source_message_index: 0 }) as { task: NonNullable<ScriptToolDraft['revision_task']> }
  return { project, model, script, task: started.task, doc: script().artifacts![0]! }
}
const request = (modelId: string, revisionTaskId?: string) => ({ model_id: modelId, mode: 'script', use_tools: true,
  ...(revisionTaskId ? { revision_task_id: revisionTaskId } : {}), messages: [{ role: 'user', text: revisionTaskId ? `继续统一修订任务 ${revisionTaskId}，处理未完成项，不自动保存。` : '我只想看看当前文档，不继续修订。' }] })
function toolReply(protocol: Protocol, name: string, args: unknown, index: number) {
  const native = { name, arguments: JSON.stringify(args) }
  return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: `call-${index}`, ...native }] })
    : Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: native }] }, finish_reason: 'tool_calls' }] })
}
function textReply(protocol: Protocol, text: string) {
  return protocol === 'responses' ? Response.json({ status: 'completed', output_text: text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
    : Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })
}

test('explicit revision continuation rejects mixed operations before any model lookup or request', async t => {
  const { project, task, doc } = await fixture()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must reject before model request') })
  const conflicts = [
    { use_tools: false }, { focus_artifact: 'character' }, { workflow: { stage: 'characters', scope: 'project', episode_number: 0 } },
    { adopt_source: { text: '原文', episode_number: 1 } }, { question_response: { status: 'answered', question: '职业？' } },
    { document_action: { operation: 'review', document_ids: [doc.id] } }, { next_step_id: 'another-step' },
    { draft_resolution: { id: 'another-draft', version: 'another-version', strategy: 'continue' } },
    { intent_context: { pending_draft: { stage: 'characters', scope: 'project', episode_number: 0 } } },
  ]
  for (const suffix of ['', '/stream']) for (const conflict of conflicts) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: { ...request('model-must-not-be-looked-up', task.id), ...conflict } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /继续统一修订必须独立使用工具对话/)
  }
  assert.equal(requests, 0)
})

test('stale, cross-project and saved task IDs are rejected before the model is accessed', async t => {
  const current = await fixture(), other = await fixture()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must reject before model request') })
  for (const suffix of ['', '/stream']) for (const id of ['stale-task', other.task.id]) {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${current.project.id}/script/director/chat${suffix}`, payload: request('missing-model', id) })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /只能继续当前待确认的统一修订任务/)
  }
  run("UPDATE script_tool_drafts SET status='saved' WHERE project_id=?", current.project.id)
  const response = await app.inject({ method: 'POST', url: `/api/projects/${current.project.id}/script/director/chat`, payload: request('missing-model', current.task.id) })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(requests, 0)
})

for (const protocol of ['chat_completions', 'responses'] as const) test(`${protocol}: explicit continuation carries authorization into runtime while ordinary chat does not resume the pending task`, async t => {
  const { project, model, task, doc, script } = await fixture(protocol)
  let turns = 0
  t.mock.method(globalThis, 'fetch', async () => {
    turns++
    return turns === 1 ? toolReply(protocol, 'read_documents', { source: 'draft', document_ids: [doc.id] }, turns) : textReply(protocol, '已读取文档，仅回答本次查看请求。')
  })
  const ordinary = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: request(model.id) })
  assert.equal(ordinary.statusCode, 200, ordinary.body)
  assert.equal(turns, 2, 'ordinary discussion does not acquire permission to execute all remaining revisions')
  assert.equal(getToolDraft(project.id)!.revision_task!.documents[0]!.assessment, undefined)
  t.mock.restoreAll()
  turns = 0
  let documentVersion = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), history = protocol === 'responses' ? body.input : body.messages
    turns++
    if (turns === 1) return toolReply(protocol, 'read_documents', { source: 'draft', document_ids: [doc.id] }, turns)
    if (turns === 2) {
      const output = history.find((item: { role?: string; type?: string }) => item.role === 'tool' || item.type === 'function_call_output')
      documentVersion = JSON.parse(output.content || output.output).result.documents[0].version
      return textReply(protocol, '已读取，后续再核对。')
    }
    if (turns === 3) {
      assert.match(history.at(-1).content, /程序执行检查/)
      return toolReply(protocol, 'review_revision_batch', { task_id: task.id, version: getToolDraft(project.id)!.version,
        documents: [{ document_id: doc.id, version: documentVersion, conclusion: 'unchanged', explanation: '人物职业已符合原有设定，无需修改。', findings: [] }] }, turns)
    }
    assert.equal(turns, 4)
    return textReply(protocol, '已统一核对，等待创作者确认。')
  })
  const continued = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: request(model.id, task.id) })
  assert.equal(continued.statusCode, 200, continued.body)
  assert.equal(turns, 4, 'the explicit button continues past a read-only partial reply to real final review')
  assert.equal(continued.json().tool_draft.revision_task.status, 'ready')
  assert.equal(getToolDraft(project.id)!.status, 'pending', 'continuation never saves the formal documents')
  assert.equal(script().artifacts![0]!.content, doc.content)
})
