import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { generateLongFormDocument } from '../src/modules/generation/long-form-output.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'

const directory = await mkdtemp(join(tmpdir(), 'long-form-generation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
let disconnectPath = '', currentRequest: import('node:http').IncomingMessage | undefined
app.addHook('preHandler', async request => { if (request.url === disconnectPath) currentRequest = request.raw })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function create(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body); return response.json()
}
async function fixture(protocol: 'responses' | 'chat_completions' = 'chat_completions') {
  const project = await create('/api/projects', { name: '完整故事恢复' })
  const provider = await create('/api/providers', { name: '长内容验证', base_url: 'https://long-form.invalid/v1', api_key: 'initial-key' })
  const model = await create('/api/models', { provider_id: provider.id, name: '长内容模型', remote_id: 'long-form', modality: 'text', protocol,
    settings: { text_api: { mode: 'standard', max_output_tokens: 65536 }, context_window_tokens: 1000000, structured_output_mode: 'json_schema' } })
  return { project, provider, model, protocol, payload: { model_id: model.id, skill_selections: { script: [] } } }
}
function response(protocol: 'responses' | 'chat_completions', text: string, limited = false) {
  return Response.json(protocol === 'responses'
    ? { status: limited ? 'incomplete' : 'completed', ...(limited ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output_text: text, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
    : { choices: [{ message: { content: text }, finish_reason: limited ? 'length' : 'stop' }] })
}
const blocked = () => Response.json({ error: { code: 'invalid_request_error', message: '离线模拟中断，稍后继续' } }, { status: 422 })
const checkpointCount = (id: string) => all("SELECT * FROM model_unit_checkpoints WHERE project_id=? AND namespace NOT LIKE 'director-execution:%'", id).length
const budgetCount = (id: string) => all("SELECT * FROM model_unit_checkpoints WHERE project_id=? AND namespace LIKE 'director-execution:%'", id).length
const scene = { heading: '第1场 门边', duration: 10, action: '林晚走到门边等待', dialogue: '请进。' }

test('paragraph recovery accepts only complete bounded units, and changed input cannot inherit semantic mode', async () => {
  const steps = createGenerationSteps(), first = { id: 'p1', content: '第一段完整内容。' }
  let raw = 0, pages = 0, fail = true
  const generate = async (prompt: string, contract?: { schema: Record<string, unknown> }) => {
    if (!contract) { raw++; if (raw === 1) throw new TextOutputLimitError('未完成正文', 'length'); return '新的独立输入。' }
    pages++
    const itemSchema = (contract.schema.properties as any).items.items
    assert.equal(itemSchema.properties.content.maxLength, 4000, 'one complete unit must remain bounded after page size reaches one')
    if (pages === 1) throw new TextOutputLimitError(`{"items":[${JSON.stringify(first)},{"id":"p2","content":"未闭合`, 'length')
    assert.match(prompt, /第一段完整内容/)
    if (fail) throw new Error('模拟后续请求中断')
    return JSON.stringify({ items: [{ id: 'p2', content: '第二段完整内容。' }], complete: true })
  }
  const options = { name: 'script_stage_draft', prompt: '完整文档A', steps, generate, maxLength: 100000 }
  await assert.rejects(generateLongFormDocument(options), /后续请求中断/)
  fail = false
  assert.equal(await generateLongFormDocument(options), '第一段完整内容。\n\n第二段完整内容。')
  assert.equal(raw, 1, 'resume cannot restart the exhausted whole document')
  assert.equal(pages, 3)
  assert.equal(await generateLongFormDocument({ ...options, prompt: '完整文档B' }), '新的独立输入。')
  assert.equal(raw, 2, 'semantic mode is bound to the precise input hash')
})

test('no-progress generation stops at one paragraph without unbounded retries or accepting truncated prose', async () => {
  let calls = 0
  const issue = new TextOutputLimitError('只有未闭合正文', 'length')
  await assert.rejects(generateLongFormDocument({ name: 'script_stage_draft', prompt: '全文', steps: createGenerationSteps(), maxLength: 100000,
    generate: async () => { calls++; throw issue } }), (error: any) => error.code === 'script_generation_pagination_stalled')
  assert.equal(calls, 5, 'one original request followed by pages of 8, 4, 2 and 1')
})

test('Chat Completions legacy artifact resumes completed paragraphs and clears success before a new generation', async t => {
  const f = await fixture(), url = `/api/projects/${f.project.id}/script/artifacts/generate`
  let raw = 0, pages = 0, failed = true
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://long-form.invalid/v1/chat/completions')
    assert.ok(init?.signal instanceof AbortSignal)
    const body = JSON.parse(String(init?.body)), contract = body.response_format?.json_schema
    assert.equal(body.max_completion_tokens, 65536)
    if (!contract) { raw++; calls.push('whole'); return raw === 1 ? response(f.protocol, '截断原文', true) : response(f.protocol, `全新生成${raw}。`) }
    pages++; calls.push('page')
    if (pages === 1) return response(f.protocol, '{"items":[{"id":"p1","content":"保留的第一段。"},{"id":"p2","content":"未闭合', true)
    assert.match(body.messages[0].content, /保留的第一段/)
    if (failed) return blocked()
    return response(f.protocol, JSON.stringify({ items: [{ id: 'p2', content: '继续完成第二段。' }], complete: true }))
  })
  const payload = { ...f.payload, artifact_type: 'world', prompt_override: '编写完整世界设定。' }
  const first = await app.inject({ method: 'POST', url, payload }); assert.equal(first.statusCode, 502, first.body)
  assert.equal(checkpointCount(f.project.id), 1)
  assert.equal(budgetCount(f.project.id), 1, 'failed output retains one separate cumulative budget without a second content store')
  failed = false
  const second = await app.inject({ method: 'POST', url, payload }); assert.equal(second.statusCode, 200, second.body)
  assert.equal(second.json().content, '保留的第一段。\n\n继续完成第二段。')
  assert.deepEqual(calls, ['whole', 'page', 'page', 'page'])
  assert.equal(checkpointCount(f.project.id), 0)
  const third = await app.inject({ method: 'POST', url, payload }); assert.equal(third.statusCode, 200, third.body)
  assert.equal(third.json().content, '全新生成2。')
  assert.equal(budgetCount(f.project.id), 1, 'clearing completed content never erases the exact-request consumption ledger')
  assert.equal(checkpointCount(f.project.id), 0)
  assert.equal(all('SELECT id FROM script_artifacts WHERE project_id=?', f.project.id).length, 0, 'preview must not insert formal documents')
})

test('Responses whole-script metadata and a large artifact recover independently across a real adapter failure', async t => {
  const f = await fixture('responses'), url = `/api/projects/${f.project.id}/script/generate`
  const calls: string[] = []
  let artifactPages = 0, fail = true
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://long-form.invalid/v1/responses')
    assert.ok(init?.signal instanceof AbortSignal)
    const body = JSON.parse(String(init?.body)), contract = body.text?.format
    const prompt = typeof body.input === 'string' ? body.input : JSON.stringify(body.input)
    assert.equal(body.max_output_tokens, 65536)
    const properties = contract?.schema?.properties || {}
    if (properties.scenes) { calls.push('whole'); return response(f.protocol, '{"outline":"截断', true) }
    if (properties.outline) { calls.push('metadata'); return response(f.protocol, '{"outline":"元信息仍过长', true) }
    if (properties.artifacts) { calls.push('catalog'); return response(f.protocol, JSON.stringify({ artifacts: [{ artifact_type: 'world', title: '世界设定' }] })) }
    if (!contract && prompt.includes('只编写顶层字段 outline')) { calls.push('outline'); return response(f.protocol, '林晚在雨夜车站寻找弟弟。') }
    if (!contract && prompt.includes('只编写顶层字段 characters')) { calls.push('characters'); assert.match(prompt, /林晚在雨夜车站/); return response(f.protocol, '林晚：坚定的姐姐。') }
    if (!contract && prompt.includes('只编写 artifacts 中')) { calls.push('artifact'); return response(f.protocol, '过长世界正文', true) }
    if (properties.items?.items?.properties?.content) {
      calls.push('artifact-page'); artifactPages++
      if (artifactPages === 1) return response(f.protocol, '{"items":[{"id":"w1","content":"雨夜车站遵守真实时序。"},{"id":"w2","content":"未闭合', true)
      assert.match(prompt, /雨夜车站遵守真实时序/)
      if (fail) return blocked()
      return response(f.protocol, JSON.stringify({ items: [{ id: 'w2', content: '怀表每晚准点响起。' }], complete: true }))
    }
    if (properties.items?.items?.properties?.heading) { calls.push('scenes'); assert.match(prompt, /怀表每晚准点响起/); return response(f.protocol, JSON.stringify({ items: [scene], complete: true })) }
    throw new Error(`Unexpected contract: ${JSON.stringify(contract)}`)
  })
  const payload = { ...f.payload, prompt_override: '生成完整故事文档与场次。' }
  const first = await app.inject({ method: 'POST', url, payload }); assert.equal(first.statusCode, 502, first.body)
  const before = calls.length
  fail = false
  const second = await app.inject({ method: 'POST', url, payload }); assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(calls.slice(before), ['artifact-page', 'scenes'], 'complete metadata, catalog and paragraph must survive the adapter failure')
  const draft = second.json()
  assert.equal(draft.outline, '林晚在雨夜车站寻找弟弟。')
  assert.equal(draft.characters, '林晚：坚定的姐姐。')
  assert.equal(draft.artifacts[0].content, '雨夜车站遵守真实时序。\n\n怀表每晚准点响起。')
  assert.equal(draft.scenes.length, 1)
  assert.equal(checkpointCount(f.project.id), 0)
  assert.equal(all('SELECT id FROM script_artifacts WHERE project_id=?', f.project.id).length, 0)
  assert.equal(all('SELECT id FROM script_scenes WHERE project_id=?', f.project.id).length, 0)
})

test('changing only provider credentials invalidates interrupted paragraphs and explicit restart starts the whole request', async t => {
  const f = await fixture(), url = `/api/projects/${f.project.id}/script/artifacts/generate`
  let whole = 0, finish = false
  const authorizations: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), contract = body.response_format?.json_schema
    authorizations.push(new Headers(init?.headers).get('Authorization') || '')
    if (!contract) { whole++; return finish ? response(f.protocol, '新的完整正文。') : response(f.protocol, '截断', true) }
    if (!body.messages[0].content.includes('第一段。')) return response(f.protocol, JSON.stringify({ items: [{ id: 'p1', content: '第一段。' }], complete: false }))
    return blocked()
  })
  const payload = { ...f.payload, artifact_type: 'world', prompt_override: '明确世界设定。' }
  assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 502)
  const patched = await app.inject({ method: 'PATCH', url: `/api/providers/${f.provider.id}`, payload: { api_key: 'replacement-key' } })
  assert.equal(patched.statusCode, 200, patched.body)
  assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 502)
  assert.equal(whole, 2, 'auth-only configuration changes cannot reuse the old candidate')
  assert.ok(authorizations.includes('Bearer initial-key')); assert.ok(authorizations.includes('Bearer replacement-key'))
  finish = true
  const restarted = await app.inject({ method: 'POST', url, payload: { ...payload, restart: true } })
  assert.equal(restarted.statusCode, 200, restarted.body)
  assert.equal(whole, 3)
})

test('legacy short documents retry one safe 503 and receive the actual request cancellation signal', async t => {
  const f = await fixture(), url = `/api/projects/${f.project.id}/script/artifacts/generate`
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; assert.ok(init?.signal instanceof AbortSignal)
    return calls === 1 ? Response.json({ error: { message: 'temporary unavailable' } }, { status: 503 }) : response(f.protocol, '完整短正文。')
  })
  const payload = { ...f.payload, artifact_type: 'world', prompt_override: '短正文。' }
  const success = await app.inject({ method: 'POST', url, payload })
  assert.equal(success.statusCode, 200, success.body); assert.equal(calls, 2)
  disconnectPath = url
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; currentRequest!.emit('aborted')
    assert.equal(init?.signal?.aborted, true, 'disconnect must reach the adapter fetch, not just discard its response')
    throw new DOMException('取消测试', 'AbortError')
  })
  const cancelled = await app.inject({ method: 'POST', url, payload })
  assert.equal(cancelled.statusCode, 499, cancelled.body)
  assert.equal(calls, 3, 'cancelled raw requests cannot retry or start paragraph generation')
  disconnectPath = ''
})

test('source changes during a complete response return a conflict and clear stale progress without formal writes', async t => {
  const f = await fixture(), url = `/api/projects/${f.project.id}/script/artifacts/generate`
  t.mock.method(globalThis, 'fetch', async () => {
    run('UPDATE projects SET brief=? WHERE id=?', '请求期间创作者修改了故事', f.project.id)
    return response(f.protocol, '基于旧资料的完整正文。')
  })
  const result = await app.inject({ method: 'POST', url, payload: { ...f.payload, artifact_type: 'world', prompt_override: '短正文。' } })
  assert.equal(result.statusCode, 409, result.body)
  assert.equal(checkpointCount(f.project.id), 0)
  assert.equal(all('SELECT id FROM script_artifacts WHERE project_id=?', f.project.id).length, 0)
})
