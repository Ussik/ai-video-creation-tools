import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptArtifact, ScriptScene, Project } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'

const directory = await mkdtemp(join(tmpdir(), 'document-review-output-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, run, all, newId, now } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'))
const { buildApp } = await import('../src/app.js')
const app = buildApp()
const { runScriptTools, projectDocuments } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

const model = { id: 'gemini-review-fixture', remote_id: 'fixture-gemini', modality: 'text' as const, protocol: 'responses' as const,
  settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_paths: ['output_text', 'output'], structured_output_mode: 'json_schema' } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const textResponse = (value: unknown) => Response.json({ status: 'completed', output_text: JSON.stringify(value) })
const truncated = () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  output: [{ type: 'function_call', call_id: 'never-execute-partial', name: 'submit_document_review', arguments: '{"summary":"被截断的报告","documents":[' }] })
const toolResponse = (name: string, args: unknown) => Response.json({ status: 'completed', output: [
  { type: 'function_call', call_id: newId(), name, arguments: JSON.stringify(args) },
] })

function fixture() {
  const stamp = now(), project: Project = { id: newId(), name: '审读接续测试', brief: '', ratio: '16:9', music_asset_id: null, created_at: stamp, updated_at: stamp }
  run('INSERT INTO projects(id,name,brief,ratio,created_at,updated_at) VALUES (?,?,?,?,?,?)', project.id, project.name, '', '16:9', stamp, stamp)
  run('INSERT INTO scripts(project_id,outline,characters,generation_options,updated_at) VALUES (?,?,?,?,?)', project.id, '', '', '{}', stamp)
  const id = newId(), content = '林晚主动放弃追查。\n' + '她始终记得归还钥匙的约定。'.repeat(1800) + '\n林晚无缘无故继续追查。'
  run('INSERT INTO script_artifacts(id,project_id,artifact_type,title,episode_number,content,position,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, project.id, 'characters', '人物设定', 0, content, 0, 'ready', stamp, stamp)
  const script = (): ScriptSnapshot => ({ outline: '', characters: '', generation_options: {}, scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', project.id),
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', project.id) })
  const document = projectDocuments(project.id, script())[0]!
  const finding = (last = false) => ({ document_id: document.id, document_version: document.version, category: 'contradiction', severity: 'warning',
    quote: last ? '林晚无缘无故继续追查。' : '林晚主动放弃追查。', explanation: last ? '恢复追查缺少触发事件。' : '决定与后续行动需要衔接。', suggestion: '用当前故事中真实发生的事件解释转变。', related: [] })
  const execute = (signal?: AbortSignal) => runScriptTools({ project, script, stage: directorStageContext(script()),
    messages: [{ role: 'user', text: '审读人物行动因果，保留全部原文。' }], action: { operation: 'review', document_ids: [document.id] },
    model, provider, prompt: '完整原稿与要求：FULL_SOURCE_KEEP_ENDING。', resolveKey: () => '', checkApproval: async () => false, onEvent: () => {}, signal })
  const reports = () => all<{ payload: string }>('SELECT payload FROM script_document_reviews WHERE project_id=?', project.id)
  return { project, script, document, finding, execute, reports }
}

test('truncated manual review tools recover as validated pages and commit exactly one report without changing documents', async t => {
  const f = fixture(), before = f.script()
  let calls = 0, pages = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls++
    if (body.tools) return truncated()
    pages++
    assert.equal(body.text.format.name, 'script_document_review_page')
    assert.ok(body.input.includes(JSON.stringify(f.document.content)), 'each report page receives the complete target')
    assert.ok(body.input.includes('FULL_SOURCE_KEEP_ENDING'))
    return textResponse({ items: [f.finding(pages === 2)], complete: pages === 2 })
  })
  const result = await f.execute()
  assert.equal(calls, 3); assert.equal(pages, 2)
  assert.equal(result.review!.findings.length, 2)
  assert.equal(f.reports().length, 1)
  assert.equal(JSON.parse(f.reports()[0]!.payload).id, result.review!.id)
  assert.deepEqual(f.script(), before)
  assert.equal(result.execution_outcome, undefined)
})

test('manual review resumes saved pages after transport failure and never repeats the truncated native request or commits twice', async t => {
  const f = fixture()
  let nativeCalls = 0, pageCalls = 0, interrupted = true
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) { nativeCalls++; return truncated() }
    pageCalls++
    if (pageCalls === 1) return textResponse({ items: [f.finding()], complete: false })
    assert.ok(body.input.includes(f.finding().quote))
    if (interrupted) return Response.json({ error: { code: 'invalid_request', message: 'fixture interruption' } }, { status: 400 })
    return textResponse({ items: [f.finding(true)], complete: true })
  })
  await assert.rejects(f.execute(), /fixture interruption/)
  assert.equal(f.reports().length, 0)
  interrupted = false
  const result = await f.execute()
  assert.equal(nativeCalls, 1); assert.equal(pageCalls, 3)
  assert.equal(result.review!.findings.length, 2)
  const reportId = result.review!.id
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('a completed exact review must replay without model requests') })
  assert.equal((await f.execute()).review!.id, reportId)
  assert.equal(f.reports().length, 1)
})

test('a document changed during paged review cannot commit a stale report and invalidates its recovery input', async t => {
  const f = fixture()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) return truncated()
    run('UPDATE script_artifacts SET content=? WHERE id=?', f.document.content + '\n新版本明确了动机。', f.document.id)
    return textResponse({ items: [f.finding()], complete: true })
  })
  await assert.rejects(f.execute(), /版本已变化/)
  assert.equal(f.reports().length, 0)
  let nativeCalls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) { nativeCalls++; return truncated() }
    assert.ok(body.input.includes('新版本明确了动机。'))
    return textResponse({ items: [], complete: true })
  })
  assert.equal((await f.execute()).review!.findings.length, 0)
  assert.equal(nativeCalls, 1)
})

test('cancellation preserves completed report pages and a later continuation only finishes the pending output', async t => {
  const f = fixture(), controller = new AbortController()
  let nativeCalls = 0, pageCalls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) { nativeCalls++; return truncated() }
    pageCalls++
    if (pageCalls === 1) return textResponse({ items: [f.finding()], complete: false })
    controller.abort(new DOMException('creator stopped', 'AbortError'))
    throw controller.signal.reason
  })
  await assert.rejects(f.execute(controller.signal), /creator stopped/)
  assert.equal(f.reports().length, 0)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.tools, undefined)
    assert.ok(body.input.includes(f.finding().explanation))
    return textResponse({ items: [f.finding(true)], complete: true })
  })
  assert.equal((await f.execute()).review!.findings.length, 2)
  assert.equal(nativeCalls, 1)
})

test('manual recovery keeps complete source, related documents and scenes, and source changes invalidate old report pages', async t => {
  const f = fixture(), stamp = now()
  run('INSERT INTO script_source_documents(project_id,filename,content,updated_at) VALUES (?,?,?,?)', f.project.id, '原稿.txt', 'FULL_MANUSCRIPT_ORIGINAL_ENDING', stamp)
  run('INSERT INTO script_artifacts(id,project_id,artifact_type,title,episode_number,content,position,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    newId(), f.project.id, 'relationships', '人物关系', 0, 'RELATED_DOCUMENT_KEEP_THE_PROMISE', 1, 'ready', stamp, stamp)
  run('INSERT INTO script_scenes(id,project_id,position,heading,episode_number,location,time_of_day,characters,action,dialogue,narration,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    newId(), f.project.id, 0, '第1场', 1, '院子', '日', '林晚', 'FULL_SCENE_ACTION_REVEALS_MOTIVE', '先归还钥匙。', '', 10, stamp, stamp)
  let nativeCalls = 0, pages = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) { nativeCalls++; return truncated() }
    assert.ok(body.input.includes('FULL_MANUSCRIPT_ORIGINAL_ENDING'))
    assert.ok(body.input.includes('RELATED_DOCUMENT_KEEP_THE_PROMISE'))
    assert.ok(body.input.includes('FULL_SCENE_ACTION_REVEALS_MOTIVE'))
    if (++pages === 1) return textResponse({ items: [f.finding()], complete: false })
    return Response.json({ error: { code: 'invalid_request', message: 'fixture context interruption' } }, { status: 400 })
  })
  await assert.rejects(f.execute(), /fixture context interruption/)
  run('UPDATE script_source_documents SET content=? WHERE project_id=?', 'CHANGED_MANUSCRIPT_REQUIRES_NEW_REVIEW', f.project.id)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    if (body.tools) { nativeCalls++; return truncated() }
    assert.ok(body.input.includes('CHANGED_MANUSCRIPT_REQUIRES_NEW_REVIEW'))
    assert.ok(!body.input.includes('FULL_MANUSCRIPT_ORIGINAL_ENDING'))
    assert.ok(!body.input.includes(f.finding().explanation), 'findings from an older manuscript are not reused')
    return textResponse({ items: [], complete: true })
  })
  assert.equal((await f.execute()).review!.findings.length, 0)
  assert.equal(nativeCalls, 2)
})

test('a committed native report followed by summary truncation is returned without generating or submitting a second report', async t => {
  const f = fixture()
  let round = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); round++
    assert.ok(body.tools)
    if (round === 1) return toolResponse('read_documents', { document_ids: [f.document.id] })
    if (round === 2) return toolResponse('read_documents', { document_ids: [f.document.id], offset: 20_000 })
    if (round === 3) return toolResponse('submit_document_review', { summary: '完整报告已提交', documents: [{ id: f.document.id, version: f.document.version }], findings: [f.finding()] })
    return truncated()
  })
  const result = await f.execute()
  assert.equal(round, 4)
  assert.equal(result.review!.summary, '完整报告已提交')
  assert.equal(f.reports().length, 1)
})
