import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'source-outline-task-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { creationState } = await import('../src/modules/script/script-document-tools.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-identity.js')
assert.equal(db.name, join(directory, 'studio.db'), 'upload regression must use an isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json() as any
}
const response = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })
function finalEvent(body: string) {
  return body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done')
}

test('a 3000-plus-character uploaded manuscript produces one outline without automatic review without prerequisite analysis or added design work', async t => {
  for (const useTools of [false, true]) await t.test(useTools ? 'native preview over SSE' : 'JSON preview over chat', async t => {
    const project = await api('POST', '/api/projects', { name: '三千字原稿整理大纲' })
    const provider = await api('POST', '/api/providers', { name: '隔离模拟供应商', base_url: 'https://source-outline.example.invalid/v1' })
    const model = await api('POST', '/api/models', { provider_id: provider.id, name: '大纲模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
      structured_output_mode: 'json_schema', request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
    } })
    const source = '开场：修表师林晚收到失踪姐姐留下的铜钥匙，决定返回旧车站寻找线索。\n' +
      Array.from({ length: 42 }, (_, index) => `第${index + 1}段：林晚沿着站台核对旧物登记，与值夜人逐一确认当天的交接记录。雨水打湿了旧报纸，她把可辨认的日期与站内钟表比对，记录每次发现，不轻信传闻，也没有发现任何超自然能力。`).join('\n') +
      '\n中段关键事实：值夜人出示姐姐三年前离站的登记，林晚确认她是主动离开，放下寻找绑架者的猜想。\n' +
      '结尾：林晚将铜钥匙交还姐姐的旧友，决定明日去海港核实最后一个地址。姐姐当前下落原稿尚未揭露，故事停在这里。'
    assert.ok(source.length > 3000 && source.length < 5000)
    const boundary = 'source-outline-upload'
    const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="three-thousand.txt"\r\nContent-Type: text/plain\r\n\r\n${source}\r\n--${boundary}--\r\n`) })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    const before = await api('GET', `/api/projects/${project.id}`)
    const analysisCount = () => (db.prepare('SELECT COUNT(*) AS count FROM script_source_analyses WHERE project_id=?').get(project.id) as { count: number }).count
    assert.equal(analysisCount(), 0, 'the fixture deliberately has no prebuilt source analysis')
    const outline = { artifact_type: 'outline', title: '旧站铜钥匙故事大纲', content:
      '林晚收到失踪姐姐留下的铜钥匙，回旧车站查找线索。她逐一比对登记、日期与钟表。值夜人提供姐姐三年前主动离站的证据，改变了她对失踪原因的判断。林晚归还钥匙，准备赴海港核实地址。原稿到此结束，姐姐目前下落尚未揭露。' }
    const calls: string[] = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(String(url), 'https://source-outline.example.invalid/v1/chat/completions', 'all provider traffic is intercepted by this self-contained fixture')
      const body = JSON.parse(String(init?.body)), contract = body.response_format?.json_schema
      assert.ok(contract, 'each request declares its structured task')
      const prompt = body.messages[0].content as string
      calls.push(contract.name)
      assert.ok(prompt.includes(JSON.stringify(source).slice(1, -1)), 'generation and review both have the complete original manuscript')
      if (contract.name === 'workflow_draft') {
        assert.deepEqual(contract.schema.properties.artifacts.items.properties.artifact_type.enum || [contract.schema.properties.artifacts.items.properties.artifact_type.const], ['outline'])
        assert.match(prompt, /原稿未说明.*如实保留未知/)
        return response({ artifacts: [outline], scenes: [] })
      }
      assert.equal(contract.name, 'script_draft_completeness', 'no source-analysis, planner, evidence or design-package requests are needed')
      assert.match(prompt, /允许如实保留原稿未知事项，不创造答案/)
      const marker = '待核对草稿原文（资料）：'
      const submitted = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).split('\n【本轮候选正文结束】')[0]!)
      assert.deepEqual(submitted.map((item: any) => item.key), ['outline'])
      assert.equal(submitted[0].content, outline.content)
      return response({ facts: [], checked_artifacts: ['outline'], findings: [] })
    })
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${useTools ? '/stream' : ''}`, payload: {
      model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage: 'outline' },
      messages: [{ role: 'user', text: '请根据上传的完整原稿整理故事大纲，原稿没有揭露的内容如实保留。' }],
    } })
    assert.equal(result.statusCode, 200, result.body)
    const done = useTools ? finalEvent(result.body) : result.json()
    assert.ok(done, result.body)
    assert.deepEqual(calls, ['workflow_draft'])
    assert.equal(analysisCount(), 0, 'a usable outline is not blocked by building a separate source-analysis package')
    const contract = done.workflow || done.draft
    assert.equal(contract.intent, 'source_outline')
    assert.deepEqual(contract.artifact_types, ['outline'])
    assert.equal(done.draft_resolution, undefined)
    const artifacts = useTools ? done.tool_draft.documents : done.draft.artifacts
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].content, outline.content)
    assert.ok(done.activity.some((entry: any) => entry.artifact_preview?.artifacts?.[0]?.content === outline.content), 'the completed work item is available as a candidate preview')
    assert.deepEqual((await api('GET', `/api/projects/${project.id}`)).script, before.script, 'generation only prepares a candidate')
    assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, source)
    if (useTools) await api('POST', `/api/projects/${project.id}/script/director/tool-drafts/${done.tool_draft.id}/commit`, { version: done.tool_draft.version, approved: true })
    else await api('PUT', `/api/projects/${project.id}/script/director/draft`, done.draft)
    assert.equal((await api('GET', `/api/projects/${project.id}`)).script.outline, outline.content)
    assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, source, 'confirming the outline preserves the uploaded manuscript')
  })
})

test('background analysis progress neither blocks source-outline creation nor adds a review request', async t => {
  for (const useTools of [false, true]) await t.test(useTools ? 'native preview' : 'JSON preview', async t => {
    const project = await api('POST', '/api/projects', { name: '后台分析独立' })
    const provider = await api('POST', '/api/providers', { name: 'fixture', base_url: 'https://outline-resume.example.invalid/v1' })
    const model = await api('POST', '/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
      structured_output_mode: 'json_schema', request_path: 'chat/completions',
      request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
    } })
    const content = '林晚回到旧车站核对姐姐离开的记录。' + '她逐页检查登记，只相信原文明示事实。'.repeat(150) + '姐姐去向尚未揭露。'
    const boundary = 'independent-analysis'
    const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    const source = uploaded.json(), version = scriptSourceVersion(source)
    const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: crypto.randomUUID(), source_version: version, model_id: model.id,
      status: 'running', phase: 'reading', completed_chunks: 0, total_chunks: 1, sections: [], error: null, updated_at: source.updated_at }
    db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
      .run(project.id, analysis.id, version, 'running', JSON.stringify(analysis), source.updated_at)
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.response_format?.json_schema?.name, 'workflow_draft')
      assert.ok(body.messages[0].content.includes(JSON.stringify(content)))
      return response({ artifacts: [{ artifact_type: 'outline', title: '旧车站大纲', content: '林晚回到旧车站核对记录，姐姐去向仍未知。' }], scenes: [] })
    })
    const result = await api('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: useTools,
      workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '按原稿整理大纲，未知保留。' }] })
    assert.equal(calls, 1); assert.ok(useTools ? result.tool_draft : result.draft)
    const retained = await api('GET', `/api/projects/${project.id}/script/source`)
    assert.equal(retained.analysis.status, 'running'); assert.equal(retained.analysis.id, analysis.id)
    assert.equal(retained.content, content)
    assert.equal((await api('GET', `/api/projects/${project.id}`)).script.outline, '')
  })
})

test('source-outline repair rejects a model source patch while retaining the original manuscript and recoverable candidate', async t => {
  const project = await api('POST', '/api/projects', { name: '原稿整理禁止改写原文' })
  const provider = await api('POST', '/api/providers', { name: '原稿边界模拟供应商', base_url: 'https://outline-source-guard.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '原稿边界模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    structured_output_mode: 'json_schema', request_path: 'chat/completions',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content',
  } })
  const source = '林晚归还铜钥匙，决定明天去海港寻找姐姐。原稿没有说明姐姐现在的去向。'
  const boundary = 'outline-source-guard'
  const upload = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="read-only.txt"\r\nContent-Type: text/plain\r\n\r\n${source}\r\n--${boundary}--\r\n`) })
  assert.equal(upload.statusCode, 200, upload.body)
  const wrong = '林晚已经在海港找到姐姐，并与她团聚。'
  const corrected = '林晚归还铜钥匙，准备明天去海港寻找姐姐；姐姐现在的去向原稿尚未说明。'
  let allowValidPatch = false, generations = 0, reviews = 0, repairs = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    const name = body.response_format?.json_schema?.name
    if (name === 'workflow_draft') {
      generations++
      return response({ artifacts: [{ artifact_type: 'outline', title: '待核对故事大纲', content: wrong }], scenes: [] })
    }
    if (name === 'script_draft_completeness') {
      reviews++
      return response({ facts: [], checked_artifacts: ['outline'], findings: false ? [{ source_key: 'outline', kind: 'contradiction', severity: 'blocking', quote: wrong,
        explanation: '大纲称已经团聚，但原稿只写明日出发，改变了关键事件的进展。', suggestion: '忠实整理原稿当前结尾。' }] : [] })
    }
    repairs++
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'submit_repair_patch'), 'exercise the production function-calling repair integration')
    assert.match(prompt, /原稿只读，source_edits必须为空数组/)
    return response({ decisions: ['保持原稿事实，姐姐尚未找到。'], summary: '纠正大纲的团聚事实。',
      edits: [{ source_key: 'outline', find: wrong, replace: corrected, reason: '忠实整理原稿当前进展' }],
      source_edits: allowValidPatch ? [] : [{ find: '决定明天去海港寻找姐姐', replace: '已经在海港找到姐姐', reason: '模型违规试图迁就候选稿改写原稿' }] })
  })
  const originalRequest = { model_id: model.id, mode: 'script', use_tools: false, workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '只按原稿整理大纲，未知保留。' }] }
  const url = `/api/projects/${project.id}/script/director/chat`
  const first = await api('POST', url, originalRequest)
  assert.ok(first.draft, 'ordinary creation delivers a preview without auditing it')
  const detail = await api('GET', `/api/projects/${project.id}`)
  const uploadedSource = upload.json()
  // Simulate a retained historical/explicit-review candidate; normal creation
  // must not be needed to manufacture a failed audit.
  const { source_version: _sourceVersion, ...candidate } = first.draft
  const pending = retainScriptDraft(project.id, { draft: candidate, request: originalRequest as any,
    source_version: createHash('sha256').update(JSON.stringify([project.name, project.brief,
      creationState(project.id, detail.script).version, scriptDocumentVersion(uploadedSource)])).digest('hex'),
    findings: [{ source_key: 'outline', kind: 'contradiction', severity: 'blocking', quote: wrong,
      explanation: '大纲改变原稿进展', suggestion: '按原稿修正' }] })
  assert.equal(pending.draft.intent, 'source_outline')
  const rejected = await app.inject({ method: 'POST', url, payload: { model_id: model.id, mode: 'script', use_tools: false,
    messages: [{ role: 'user', text: '按原稿修正候选大纲。' }], draft_resolution: { id: pending.id, version: pending.version, strategy: 'ai' } } })
  assert.equal(rejected.statusCode, 422, rejected.body)
  assert.match(rejected.body, /原稿只读.*source_edits必须为空数组/)
  const retained = pendingScriptDraft(project.id)!
  assert.equal(retained.id, pending.id)
  assert.equal(retained.version, pending.version)
  assert.equal(retained.draft.artifacts[0]!.content, wrong, 'an invalid mixed patch cannot partially change the retained candidate')
  assert.equal(retained.source_update, undefined)
  assert.equal(retained.run!.status, 'interrupted')
  assert.match(retained.run!.message!, /原稿只读.*source_edits必须为空数组/)
  assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, source)
  assert.equal((db.prepare('SELECT count(*) AS count FROM script_source_revisions WHERE project_id=?').get(project.id) as { count: number }).count, 0)
  allowValidPatch = true
  const resumed = await api('POST', url, { model_id: model.id, mode: 'script', use_tools: false,
    messages: [{ role: 'user', text: '继续完成原任务。' }], draft_resolution: { id: retained.id, version: retained.version, strategy: 'manual', answers: ['保持原稿只读，仅纠正候选大纲，不提交 source_edits。'] } })
  assert.equal(resumed.draft.artifacts[0].content, corrected)
  assert.equal(resumed.source_update, undefined)
  assert.equal(pendingScriptDraft(project.id), null)
  assert.equal(generations, 1)
  assert.equal(repairs, 2)
  assert.equal(reviews, 1, 'only the explicitly requested valid repair receives one independent review')
  assert.equal((await api('GET', `/api/projects/${project.id}/script/source`)).content, source)
  assert.equal((await api('GET', `/api/projects/${project.id}`)).script.outline, '', 'a corrected candidate still requires explicit formal saving')
})
