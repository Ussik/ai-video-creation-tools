import { coordinateFixtureJson, structuredFixtureJson, draftReviewFixtureSources } from './fixtures/script-draft-coordinate-response.js'
import { draftReviewFixtureJson } from './fixtures/script-draft-completeness.js'
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
function auxiliaryWorksetResponse(prompt: string, source_edits: unknown[] = []): Response | undefined {
  if (prompt.includes('【当前工作集：仅核对当前有效原稿是否确需最小同步】')) return response({ summary: '已核对原稿同步。', source_edits }, prompt)
  const marker = /【当前工作集：(\[[^\n]+\])】/.exec(prompt)
  if (marker && !(JSON.parse(marker[1]!) as string[]).includes('outline')) return response({ summary: '当前文档没有本项相关修改。', edits: [] }, prompt)
}
const response = (content: unknown, prompt?: string) => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : structuredFixtureJson(JSON.parse(draftReviewFixtureJson(content)), prompt) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
const events = (body: string) => body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))

async function fixture(t: TestContext, strategy: 'manual' | 'ai', requiredRounds = 2, failFirst = false) {
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
  let originalRecoveryKey: string | undefined
  const observed: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      const auxiliary = auxiliaryWorksetResponse(prompt, []); if (auxiliary) return auxiliary
    const analysis = sourceAnalysisFixture(prompt)
    if (analysis) return response(analysis)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      const marker = '待核对草稿原文（资料）：'
      const sources = draftReviewFixtureSources(prompt)
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits < requiredRounds ? [finding(sources[0].content)] : [] }, prompt)
    }
    assert.match(prompt, /继续已授权阶段的候选草稿/)
    patchCalls++
    originalRecoveryKey ??= one<{ resume_key: string }>('SELECT resume_key FROM script_director_tasks WHERE id=?', id)!.resume_key
    observed.push(prompt)
    if (failFirst && patchCalls === 1 && failSecond) return Response.json({ error: { message: '第二轮提供商配置暂不可用' } }, { status: 400 })
    successfulPatches++
    const find = successfulPatches === 1 ? quote : adopted + '钥匙暂时失效。'.repeat(successfulPatches - 2)
    return response({ decisions: [answer], summary: '落实原有记忆代价方案。', source_edits: [],
      edits: [{ source_key: 'outline', find, replace: adopted + '钥匙暂时失效。'.repeat(successfulPatches - 1), reason: '沿用已授权方案补齐因果。' }] }, prompt)
  })
  const first = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat/stream`, payload: body })
  assert.equal(first.statusCode, 200, first.body)
  const scope = scriptProposalBudgetScope(draft)
  return { project, model, url, body, first, observed,
    usage: () => sourceProposalBudget(project.id, scope).usage,
    recover: () => { failSecond = false },
    counts: () => ({ patchCalls, successfulPatches, audits }) }
}

test('one explicit repair stops after one review, retains findings and waits for a new explicit request', async t => {
  for (const strategy of ['manual', 'ai'] as const) await t.test(strategy, async t => {
    const f = await fixture(t, strategy)
    const done = events(f.first.body).find(event => event.type === 'done')
    assert.ok(done?.draft_resolution, f.first.body)
    assert.deepEqual(f.counts(), { patchCalls: 1, successfulPatches: 1, audits: 1 }, 'unresolved findings never schedule a second round')
    const retained = pendingScriptDraft(f.project.id)!
    assert.equal(retained.completed_rounds, 1); assert.ok(retained.draft.artifacts[0]!.content.includes(adopted))
    assert.equal((await api('GET', `/api/projects/${f.project.id}/script/source`)).content, original)
    assert.equal((await api('GET', `/api/projects/${f.project.id}`)).script.outline, '', 'no formal write without confirmation')
    const before = f.counts()
    await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: f.body })
    assert.deepEqual(f.counts(), before, 'replaying a completed task must not authorize another repair')
    f.recover()
    const explicit = { ...f.body, task: { ...f.body.task, id: crypto.randomUUID() },
      draft_resolution: { id: retained.id, version: retained.version, strategy: 'continue' } }
    const next = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: explicit })
    assert.ok(events(next.body).some(event => event.type === 'done' && !event.draft_resolution), next.body)
    assert.deepEqual(f.counts(), { patchCalls: 2, successfulPatches: 2, audits: 2 })
    assert.equal(pendingScriptDraft(f.project.id), null)
  })
})

test('transport failure retains the original candidate and explicit task recovery completes one repair', async t => {
  const f = await fixture(t, 'manual', 1, true)
  assert.ok(events(f.first.body).some(event => event.type === 'error'))
  assert.deepEqual(f.counts(), { patchCalls: 1, successfulPatches: 0, audits: 0 })
  const retained = pendingScriptDraft(f.project.id)!
  assert.equal(retained.version, f.body.draft_resolution.version)
  assert.ok(retained.draft.artifacts[0]!.content.includes(quote))
  const requests = f.usage().requests
  f.recover()
  await api('POST', f.url + '/continue', {})
  const result = await app.inject({ method: 'GET', url: f.url + '/stream' })
  assert.ok(events(result.body).some(event => event.type === 'done' && !event.draft_resolution), result.body)
  assert.equal(f.counts().successfulPatches, 1); assert.equal(f.counts().audits, 1)
  assert.ok(f.usage().requests > requests)
  assert.equal((await api('GET', `/api/projects/${f.project.id}/script/source`)).content, original)
})

test('explicit task recovery rejects source or model drift and preserves the pending candidate', async t => {
  for (const mutation of ['source', 'model'] as const) await t.test(mutation, async t => {
    const f = await fixture(t, 'manual', 1, true), before = f.counts()
    const candidate = pendingScriptDraft(f.project.id)!
    if (mutation === 'source') db.prepare('UPDATE script_source_documents SET content=? WHERE project_id=?').run(original + '新增要求。', f.project.id)
    else db.prepare('UPDATE models SET remote_id=? WHERE id=?').run('externally-changed-model', f.model.id)
    const result = await app.inject({ method: 'POST', url: f.url + '/continue', payload: {} })
    assert.equal(result.statusCode, 409, result.body)
    assert.match(result.body, /已变化/); assert.deepEqual(f.counts(), before)
    assert.equal(pendingScriptDraft(f.project.id)!.version, candidate.version)
  })
})
