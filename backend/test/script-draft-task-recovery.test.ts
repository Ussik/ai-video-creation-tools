import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-draft-task-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, one } = await import('../src/infrastructure/database/db.js')
const { creationState } = await import('../src/modules/script/script-document-tools.js')
const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const { sourceProposalBudget, scriptProposalBudgetScope } = await import('../src/modules/script/script-proposal-budget.js')
assert.equal(db.name, join(testData, 'studio.db'), 'task recovery must use an isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const result = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
const original = '全剧60集，林晚使用铜钥匙打开车站，最终放弃能力回家。'
const quote = '能力代价：待定。'
const adopted = '能力代价：每次使用失去一天记忆，无法恢复。'
const answer = '只失去一天记忆，保留60集和回家结局。'
const finding = (evidence = quote) => ({ source_key: 'outline', kind: 'unresolved_setting' as const, quote: evidence,
  topic: '铜钥匙每次使用的记忆代价', explanation: '能力代价的触发后果尚未落实。', suggestion: '说明失去一天记忆的直接后果。' })
const response = (content: unknown) => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
const events = (body: string) => body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))

async function fixture(t: TestContext, strategy: 'manual' | 'ai', requiredRounds = 2, failRecoveryAdvance = false) {
  const project = await api('POST', '/api/projects', { name: '已授权修订恢复' })
  const provider = await api('POST', '/api/providers', { name: 'task fixture', base_url: 'https://draft-task-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const boundary = 'draft-task-source'
  const uploadedResult = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n${original}\r\n--${boundary}--\r\n`) })
  assert.equal(uploadedResult.statusCode, 200, uploadedResult.body)
  const uploaded = uploadedResult.json(), before = await api('GET', `/api/projects/${project.id}`)
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', episode_number: 0,
    artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: original + quote })), scenes: [] })
  const request = { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '生成全剧大纲，保留原稿。' }], workflow: { stage: 'outline' } }
  const pending = retainScriptDraft(project.id, { draft, findings: [finding()], request,
    source_version: createHash('sha256').update(JSON.stringify([project.name, project.brief, creationState(project.id, before.script).version, scriptDocumentVersion(uploaded)])).digest('hex') })
  const id = crypto.randomUUID(), conversation = crypto.randomUUID(), message = strategy === 'manual' ? answer : '这一项交给 AI 决定。'
  const body = { ...request, workflow: undefined, messages: [...request.messages, { role: 'user', text: message }],
    draft_resolution: { id: pending.id, version: pending.version, strategy, ...(strategy === 'manual' ? { answers: [answer] } : {}) },
    task: { id, conversation: { id: conversation, messages: [{ id: 'creator-question', role: 'user', text: message }] },
      execution: { title: '补齐大纲', request: message, started_at: Date.now(), focus_artifact: 'all', mode: 'script' } } }
  const url = `/api/projects/${project.id}/script/director/tasks/${id}`
  let patchCalls = 0, successfulPatches = 0, audits = 0, failSecond = true
  let recoveryInTransaction = false, originalRecoveryKey: string | undefined
  if (failRecoveryAdvance) {
    db.function('test_recovery_transaction', () => { recoveryInTransaction = db.inTransaction; return 1 })
    db.exec(`CREATE TEMP TRIGGER test_fail_recovery_advance BEFORE UPDATE OF request_payload ON script_director_tasks
      BEGIN SELECT test_recovery_transaction(); SELECT RAISE(ABORT, '模拟恢复资料写入失败'); END`)
  }
  const observed: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analysis = sourceAnalysisFixture(prompt)
    if (analysis) return response(analysis)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      const marker = '待核对草稿原文（资料）：'
      const sources = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits < requiredRounds ? [finding(sources[0].content)] : [] })
    }
    assert.match(prompt, /继续已授权阶段的候选草稿/)
    patchCalls++
    originalRecoveryKey ??= one<{ resume_key: string }>('SELECT resume_key FROM script_director_tasks WHERE id=?', id)!.resume_key
    observed.push(prompt)
    if (patchCalls > 1 && failSecond) return Response.json({ error: { message: '第二轮提供商配置暂不可用' } }, { status: 400 })
    successfulPatches++
    const find = successfulPatches === 1 ? quote : adopted + '钥匙暂时失效。'.repeat(successfulPatches - 2)
    return response({ decisions: [answer], summary: '落实原有记忆代价方案。', source_edits: [],
      edits: [{ source_key: 'outline', find, replace: adopted + '钥匙暂时失效。'.repeat(successfulPatches - 1), reason: '沿用已授权方案补齐因果。' }] })
  })
  let first: Awaited<ReturnType<typeof app.inject>>
  try {
    first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
  } finally {
    if (failRecoveryAdvance) db.exec('DROP TRIGGER test_fail_recovery_advance')
  }
  assert.equal(first.statusCode, 200, first.body)
  assert.match(first.body, failRecoveryAdvance ? /模拟恢复资料写入失败/ : /第二轮提供商配置暂不可用/)
  assert.equal((await api('GET', url)).status, 'failed')
  assert.equal(successfulPatches, 1)
  const current = pendingScriptDraft(project.id)!
  assert.equal(current.id, pending.id)
  if (failRecoveryAdvance) {
    assert.equal(recoveryInTransaction, true, 'the durable recovery update must execute inside the candidate transaction')
    assert.equal(current.version, pending.version, 'failed recovery persistence rolls back the candidate version')
    assert.deepEqual(current.draft, pending.draft, 'a rolled-back candidate cannot expose only half the version advance')
  } else assert.notEqual(current.version, pending.version)
  assert.equal(current.completed_rounds, 1)
  assert.equal(current.run?.strategy, strategy)
  if (strategy === 'manual') assert.deepEqual(current.run?.answers, [answer])
  const row = one<{ request_payload: string; resume_key: string; request_hash: string }>('SELECT request_payload,resume_key,request_hash FROM script_director_tasks WHERE id=?', id)!
  const retainedRequest = JSON.parse(row.request_payload)
  assert.deepEqual(retainedRequest.draft_resolution, failRecoveryAdvance ? body.draft_resolution : { id: current.id, version: current.version, strategy: 'continue' })
  if (failRecoveryAdvance) assert.equal(row.resume_key, originalRecoveryKey, 'a rolled-back candidate retains its matching recovery key')
  // The server binds each message to its stored id (provenance); wording and order are what must stay exact.
  assert.deepEqual(retainedRequest.messages.map(({ id: _id, ...rest }: { id?: string }) => rest), body.messages, 'persist the actual authorized creator context')
  const scope = scriptProposalBudgetScope(draft)
  return { project, model, url, body, current, row, observed,
    usage: () => sourceProposalBudget(project.id, scope).usage,
    recover: () => { failSecond = false },
    counts: () => ({ patchCalls, successfulPatches, audits }) }
}

test('durable known-issue retries resume the new version with the same authorization and retain usage without obsolete caps', async t => {
  for (const strategy of ['manual', 'ai'] as const) await t.test(strategy, async t => {
    const f = await fixture(t, strategy)
    const usage = f.usage()
    assert.ok(usage.requests > 0)
    const beforeDuplicate = f.counts()
    const duplicate = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: f.body })
    assert.equal(duplicate.statusCode, 200, duplicate.body)
    assert.match(duplicate.body, /第二轮提供商配置暂不可用/)
    assert.deepEqual(f.counts(), beforeDuplicate, 'the original request remains an idempotent task lookup after recovery advances')
    const oldLimit = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
    try {
      process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = String(usage.requests)
      const before = f.counts()
      await api('POST', f.url + '/continue', {})
      const retried = await app.inject({ method: 'GET', url: f.url + '/stream' })
      assert.match(retried.body, /第二轮提供商配置暂不可用/)
      assert.doesNotMatch(retried.body, /已达到模型请求预算/)
      assert.ok(f.counts().patchCalls > before.patchCalls, 'the old cumulative request cap does not prevent a provider dispatch')
      assert.equal(f.counts().successfulPatches, before.successfulPatches)
      assert.equal(f.counts().audits, before.audits, 'a genuine provider failure still stops before independent review')
      assert.equal(pendingScriptDraft(f.project.id)!.completed_rounds, 1)
    } finally {
      if (oldLimit === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
      else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = oldLimit
    }
    f.recover()
    await api('POST', f.url + '/continue', {})
    const completed = await app.inject({ method: 'GET', url: f.url + '/stream' })
    const done = events(completed.body).find(event => event.type === 'done')
    assert.ok(done, completed.body)
    assert.equal(done.draft_resolution, null)
    assert.equal(f.counts().successfulPatches, 2, 'the first validated repair is retained rather than replayed')
    assert.equal(f.counts().audits, 2)
    assert.ok(f.usage().requests > usage.requests)
    assert.equal(one<{ request_hash: string }>('SELECT request_hash FROM script_director_tasks WHERE id=?', f.body.task.id)!.request_hash, f.row.request_hash)
    assert.equal((await api('GET', f.url)).status, 'succeeded')
    assert.equal((await api('GET', `/api/projects/${f.project.id}/script/source`)).content, original)
    assert.equal((await api('GET', `/api/projects/${f.project.id}`)).script.outline, '')
    const lastPrompt = f.observed.at(-1)!
    assert.match(lastPrompt, strategy === 'manual' ? /只失去一天记忆，保留60集和回家结局/ : /沿用|只失去一天记忆/)
  })
})

test('an authorized version advance does not refresh away later source or model configuration changes', async t => {
  for (const mutation of ['source', 'model'] as const) await t.test(mutation, async t => {
    const f = await fixture(t, 'manual'), before = f.counts()
    if (mutation === 'source') db.prepare('UPDATE script_source_documents SET content=? WHERE project_id=?').run(original + '新增故事要求。', f.project.id)
    else db.prepare('UPDATE models SET remote_id=? WHERE id=?').run('externally-changed-model', f.model.id)
    const result = await app.inject({ method: 'POST', url: f.url + '/continue', payload: {} })
    assert.equal(result.statusCode, 409, result.body)
    assert.match(result.body, /已变化/)
    assert.deepEqual(f.counts(), before)
    assert.equal(pendingScriptDraft(f.project.id)!.version, f.current.version)
  })
})

test('continuing an interrupted automatic round can finish after six rounds under the original authorization', async t => {
  const f = await fixture(t, 'ai', 6)
  f.recover()
  await api('POST', f.url + '/continue', {})
  const continued = await app.inject({ method: 'GET', url: f.url + '/stream' })
  const done = events(continued.body).find(event => event.type === 'done')
  assert.ok(done, continued.body)
  assert.equal(done.draft_resolution, null)
  assert.equal(f.counts().successfulPatches, 6)
  assert.equal(f.counts().audits, 6)
  assert.ok(done.draft.artifacts.find((document: { artifact_type: string }) => document.artifact_type === 'outline').content.includes(adopted + '钥匙暂时失效。'.repeat(5)))
  assert.ok(f.observed.every(prompt => /只失去一天记忆|已处理事项/.test(prompt)))
  assert.equal((await api('GET', f.url)).status, 'succeeded')
  assert.equal((await api('GET', `/api/projects/${f.project.id}`)).script.outline, '')
})

test('failure while persisting a known repair continuation rolls back the candidate and retains a compatible recoverable task', async t => {
  const f = await fixture(t, 'manual', 2, true)
  f.recover()
  await api('POST', f.url + '/continue', {})
  const continued = await app.inject({ method: 'GET', url: f.url + '/stream' })
  const done = events(continued.body).find(event => event.type === 'done')
  assert.ok(done, continued.body)
  assert.equal(done.draft_resolution, null)
  assert.equal(f.counts().successfulPatches, 2, 'recovery reuses the validated pre-transaction patch instead of generating it again')
  assert.equal(f.counts().audits, 2)
  assert.equal(one<{ request_hash: string }>('SELECT request_hash FROM script_director_tasks WHERE id=?', f.body.task.id)!.request_hash, f.row.request_hash)
})
