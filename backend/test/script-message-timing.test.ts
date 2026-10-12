import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

const testData = await mkdtemp(join(tmpdir(), 'studio-message-timing-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const legacy = new Database(join(testData, 'studio.db'))
legacy.exec(`CREATE TABLE script_messages (
  id TEXT NOT NULL, conversation_id TEXT NOT NULL, position INTEGER NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id)
)`)
legacy.prepare('INSERT INTO script_messages VALUES (?, ?, ?, ?, ?, ?)')
  .run('legacy-message', 'legacy-conversation', 0, 'assistant', '原有对话正文', '2026-10-01T00:00:00.000Z')
legacy.close()
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('adding processing duration migrates legacy messages without inventing elapsed time or changing text', () => {
  const row = db.prepare('SELECT text, processing_duration_ms, reference_documents FROM script_messages WHERE id=?').get('legacy-message')
  assert.deepEqual(row, { text: '原有对话正文', processing_duration_ms: null, reference_documents: '[]' })
})

test('per-message durations survive reload, conversation replacement and independent regeneration branches', async () => {
  const project = await call('POST', '/api/projects', { name: '回复计时测试' })
  const url = `/api/projects/${project.id}/script/conversations`
  const messages = [
    { id: 'user', role: 'user', text: '讨论主角' },
    { id: 'old', role: 'assistant', text: '旧回复没有用时记录' },
    { id: 'zero', role: 'assistant', text: '即时回复', processing_duration_ms: 0 },
    { id: 'reply', role: 'assistant', text: '完整回复', processing_duration_ms: 12_345 },
    { id: 'stopped', role: 'assistant', text: '已停止生成', processing_duration_ms: 4567 },
  ]
  const saved = await call('PUT', url, { id: 'timed-original', messages })
  assert.deepEqual(saved.messages.map((message: { processing_duration_ms: number | null }) => message.processing_duration_ms), [null, null, 0, 12_345, 4567])
  const reloaded = (await call('GET', url)).conversations[0]
  assert.deepEqual(reloaded.messages, saved.messages)
  const branch = await call('PUT', url, { id: 'timed-branch', messages: [...messages.slice(0, 3), { ...messages[3], processing_duration_ms: 23_456 }] })
  assert.equal(branch.messages[3].processing_duration_ms, 23_456)
  const conversations = (await call('GET', url)).conversations
  assert.equal(conversations.find((item: { id: string }) => item.id === 'timed-original').messages[3].processing_duration_ms, 12_345)
  await call('PUT', url, { id: 'timed-branch', messages: [{ id: 'reply', role: 'assistant', text: '更新后的回复', processing_duration_ms: 789 }] })
  assert.equal((await call('GET', url)).conversations[0].messages[0].processing_duration_ms, 789)
})

test('invalid durations and timings on user messages are rejected before replacing saved history', async () => {
  const project = await call('POST', '/api/projects', { name: '计时校验测试' })
  const url = `/api/projects/${project.id}/script/conversations`
  const payload = { id: 'validation', messages: [{ id: 'reply', role: 'assistant', text: '已保存回复', processing_duration_ms: 1000 }] }
  await call('PUT', url, payload)
  const before = await call('GET', url)
  for (const duration of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    const response = await app.inject({ method: 'PUT', url, payload: { ...payload, messages: [{ ...payload.messages[0], processing_duration_ms: duration }] } })
    assert.equal(response.statusCode, 422)
  }
  const response = await app.inject({ method: 'PUT', url, payload: { ...payload, messages: [{ ...payload.messages[0], role: 'user' }] } })
  assert.equal(response.statusCode, 422)
  assert.deepEqual(await call('GET', url), before)
})

test('execution traces migrate old history, persist detailed repeated invocations and validate before replacement', async () => {
  assert.equal((db.prepare('SELECT activity FROM script_messages WHERE id=?').get('legacy-message') as any).activity, '[]')
  const project = await call('POST', '/api/projects', { name: '执行记录持久化' }), url = `/api/projects/${project.id}/script/conversations`
  const entry = { id: 'call-1', kind: 'tool', name: 'read_documents', label: '阅读项目文档', summary: '已读人物资料', status: 'succeeded', started_at: 1000, ended_at: 1456, duration_ms: 456, round: 2,
    input: '{"document_ids":["doc"]}', output: '{"documents":[]}', output_truncated: false }
  const activity = [entry, { ...entry, id: 'call-2', status: 'failed', summary: '读取失败' }, { ...entry, id: 'call-3', status: 'cancelled', summary: '已停止等待' }]
  const payload = { id: 'traced-conversation', messages: [{ id: 'trace-reply', role: 'assistant', text: '已完成阅读', activity }] }
  const saved = await call('PUT', url, payload)
  assert.deepEqual(saved.messages[0].activity, activity)
  assert.deepEqual((await call('GET', url)).conversations[0].messages[0].activity, activity)
  for (const bad of [ [{ ...entry, status: 'invented' }], [entry, entry], [{ ...entry, output: 'x'.repeat(4001) }], [{ ...entry, reasoning_content: 'private' }] ]) {
    const response = await app.inject({ method: 'PUT', url, payload: { ...payload, messages: [{ ...payload.messages[0], activity: bad }] } })
    assert.equal(response.statusCode, 422)
  }
  const user = await app.inject({ method: 'PUT', url, payload: { ...payload, messages: [{ ...payload.messages[0], role: 'user' }] } })
  assert.equal(user.statusCode, 422)
  assert.deepEqual((await call('GET', url)).conversations[0].messages[0].activity, activity)
})
