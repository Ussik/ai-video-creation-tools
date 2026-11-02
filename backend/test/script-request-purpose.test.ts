import assert from 'node:assert/strict'
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
const { pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
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


test('requests carry their purpose, and ordinary usage without cache fields keeps cache unknown while reasoning is counted', async t => {
  const project = await api('POST', '/api/projects', { name: '用途与普通用量' })
  const provider = await api('POST', '/api/providers', { name: '用途模拟供应商', base_url: 'https://purpose.example.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '用途模型', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    structured_output_mode: 'json_schema', request_path: 'chat/completions',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const boundary = 'purpose-upload', source = '林晚收到铜钥匙，回到旧车站核对记录。姐姐下落原稿尚未揭露。'.repeat(40)
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.txt"\r\nContent-Type: text/plain\r\n\r\n${source}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const outline = { artifact_type: 'outline', title: '大纲', content: '林晚回旧车站核对记录；姐姐去向原稿尚未揭露。' }
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const contract = JSON.parse(String(init?.body)).response_format?.json_schema?.name
    const payload = contract === 'workflow_draft' ? { artifacts: [outline], scenes: [] } : { facts: [], checked_artifacts: ['outline'], findings: [] }
    return Response.json({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 12 } } })
  })
  const result = await api('POST', `/api/projects/${project.id}/script/director/chat`, { model_id: model.id, mode: 'script', use_tools: false,
    workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '整理原稿大纲' }] })
  const purposes = result.activity.filter((entry: any) => entry.request_purpose).map((entry: any) => entry.request_purpose)
  assert.deepEqual([...new Set(purposes)].sort(), ['generation', 'review'])
  const ledger = result.activity.find((entry: any) => entry.usage?.current)!.usage.current
  assert.equal(ledger.requests, 2)
  assert.equal(ledger.input_tokens, 200); assert.equal(ledger.output_tokens, 60); assert.equal(ledger.reasoning_tokens, 24)
  assert.equal(ledger.cache_read_reported_requests, 0, 'no cache field was returned, so cache usage stays unknown instead of zero')
  assert.equal(ledger.cache_read_tokens, 0)
  assert.ok(result.activity.every((entry: any) => entry.cache_read_tokens === undefined), 'no request invents a cache figure')
})
