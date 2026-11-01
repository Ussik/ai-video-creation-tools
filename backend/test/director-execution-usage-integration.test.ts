import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-director-execution-usage-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const budgetNames = ['VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_REQUESTS', 'VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_TOKENS',
  'VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS', 'VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS'] as const
const previousLimits = budgetNames.map(name => process.env[name])
process.env.VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_REQUESTS = '1'
process.env.VIDEO_STUDIO_SCRIPT_EXECUTION_MAX_TOKENS = '500000'
process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = ''
process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS = ''
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { creationState } = await import('../src/modules/script/script-document-tools.js')
const { retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const { sourceProposalBudget, scriptProposalBudgetScope } = await import('../src/modules/script/script-proposal-budget.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
assert.equal(db.name, join(dataDir, 'studio.db'), 'execution usage integration must not open the workspace database')
const app = buildApp()
after(async () => {
  await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true })
  budgetNames.forEach((name, index) => { if (previousLimits[index] === undefined) delete process.env[name]; else process.env[name] = previousLimits[index] })
})

async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
async function fixture() {
  const project = await api('POST', '/api/projects', { name: '执行用量隔离回归' })
  const provider = await api('POST', '/api/providers', { name: 'usage fixture', base_url: 'https://execution-usage-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本用量模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  return { project, model }
}
function task(message: string) {
  const id = crypto.randomUUID()
  return { id, conversation: { id: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: 'user', text: message }] },
    execution: { title: '创作讨论', request: message, started_at: Date.now(), mode: 'script' } }
}
function latestUsage(snapshot: any) {
  const entries = snapshot.events.find((event: any) => event.type === 'activity')?.activity as ScriptActivity[]
  const entry = entries.filter(entry => entry.usage).sort((a, b) => (b.sequence || 0) - (a.sequence || 0))[0]
  assert.equal(entry?.scope, 'notice')
  assert.equal(entry?.label, '本轮模型用量')
  return entry!.usage!
}

test('ordinary task chat publishes actual provider usage in its notice and persisted conversation', async t => {
  const f = await fixture(), execution = task('讨论主角年龄')
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /execution-usage-fixture\.invalid/)
    assert.equal(init?.method, 'POST')
    posts++
    return Response.json({ choices: [{ message: { content: '主角设定为二十六岁。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 4 } } })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: {
    model_id: f.model.id, mode: 'script', focus_artifact: 'character', messages: [{ role: 'user', text: '讨论主角年龄' }], task: execution,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.body, /主角设定为二十六岁/)
  const snapshot = await api('GET', `/api/projects/${f.project.id}/script/director/tasks/${execution.id}`)
  assert.equal(snapshot.status, 'succeeded')
  const usage = latestUsage(snapshot)
  assert.equal(posts, 1)
  assert.equal(usage.current.requests, 1)
  assert.equal(usage.current.input_tokens, 20)
  assert.equal(usage.current.output_tokens, 10)
  assert.equal(usage.current.reasoning_tokens, 4)
  assert.equal(usage.current.uncertain_requests, 0)
  assert.equal(usage.current.estimated_input_tokens + usage.current.estimated_output_tokens, 0)
  assert.equal(usage.limits?.max_requests, undefined)
  assert.equal(usage.limits?.max_tokens, undefined)
  const conversations = await api('GET', `/api/projects/${f.project.id}/script/conversations`)
  const persisted = conversations.conversations[0].messages.at(-1).activity as ScriptActivity[]
  assert.equal(persisted.find(entry => entry.label === '本轮模型用量')?.usage?.current.requests, 1)
})

test('candidate repair preserves execution and historical stage usage while continuing beyond obsolete environment caps', async t => {
  const f = await fixture(), original = '全剧60集，林晚使用铜钥匙打开车站，最终放弃能力回家。', quote = '能力代价：待定。'
  const boundary = 'execution-usage-source'
  const upload = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/source`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n${original}\r\n--${boundary}--\r\n`) })
  assert.equal(upload.statusCode, 200, upload.body)
  const before = await api('GET', `/api/projects/${f.project.id}`)
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', episode_number: 0,
    artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: original + quote })), scenes: [] })
  const request = { model_id: f.model.id, mode: 'script', messages: [{ role: 'user', text: '生成全剧大纲，保留原稿。' }], workflow: { stage: 'outline' } }
  const pending = retainScriptDraft(f.project.id, { draft, findings: [{ source_key: 'outline', kind: 'unresolved_setting', quote,
    topic: '铜钥匙的使用代价', explanation: '使用后果尚未落实。', suggestion: '补齐具体后果。' }], request,
    source_version: createHash('sha256').update(JSON.stringify([f.project.name, f.project.brief, creationState(f.project.id, before.script).version, scriptDocumentVersion(upload.json())])).digest('hex') })
  const stageScope = scriptProposalBudgetScope(draft), historical = sourceProposalBudget(f.project.id, stageScope)
  historical.usage.requests = 88
  historical.usage.input_tokens = 4_000_000
  historical.run(() => beginTextRequest({ request_bytes: 2, estimated_input_tokens: 1, reserved_output_tokens: 1 }).complete({ input_tokens: 1, output_tokens: 1 }))
  const message = '每次使用失去一天记忆，请落实这个决定。', execution = task(message)
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /execution-usage-fixture\.invalid/)
    assert.equal(init?.method, 'POST')
    posts++
    return Response.json({ error: { message: '模拟提供商配置暂不可用' }, usage: { prompt_tokens: 20, completion_tokens: 10 } }, { status: 400 })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat/stream`, payload: {
    ...request, workflow: undefined, messages: [...request.messages, { role: 'user', text: message }],
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers: [message] }, task: execution,
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.match(response.body, /模拟提供商配置暂不可用/)
  const taskUrl = `/api/projects/${f.project.id}/script/director/tasks/${execution.id}`
  const failed = await api('GET', taskUrl)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.can_resume, true)
  const firstUsage = latestUsage(failed)
  assert.equal(posts, 1, 'historical cumulative usage must not prevent the first request of this execution')
  assert.equal(firstUsage.current.requests, 1)
  assert.equal(firstUsage.current.input_tokens, 20)
  assert.equal(firstUsage.cumulative?.requests, 90)
  assert.ok(firstUsage.cumulative!.input_tokens >= 4_000_000)
  assert.equal(firstUsage.limits?.max_requests, undefined)
  await api('POST', taskUrl + '/continue', {})
  const continued = await app.inject({ method: 'GET', url: taskUrl + '/stream' })
  assert.equal(continued.statusCode, 200, continued.body)
  assert.match(continued.body, /模拟提供商配置暂不可用/)
  assert.doesNotMatch(continued.body, /已达到模型请求预算/)
  assert.equal(posts, 2, 'continuation dispatches the remaining work despite the old one-request environment cap')
  const resumed = latestUsage(await api('GET', taskUrl))
  assert.equal(resumed.current.requests, 2)
  assert.equal(resumed.current.input_tokens, 40)
  assert.equal(resumed.current.output_tokens, 20)
  assert.equal(resumed.cumulative?.requests, 91)
  assert.equal(sourceProposalBudget(f.project.id, stageScope).usage.requests, 91)
})
