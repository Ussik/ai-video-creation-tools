import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { directorTaskSoftTimeoutMs, directorStreamTotalTimeoutMs } from '@video-studio/shared/script/script-stream-policy'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-task-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now } = await import('../src/infrastructure/database/db.js')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

test('soft task deadline keeps execution alive, hard deadline preserves progress and explicit continue starts a fresh active budget', async t => {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', 'p', 'budget test', now(), now())
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const tasks = createDirectorTasks()
  let receivedSignal: AbortSignal | undefined
  tasks.start('p', { id: 'task', conversation: { id: 'conversation', messages: [{ id: 'user', role: 'user', text: '生成大纲' }] }, execution: { title: '大纲', request: '生成大纲', started_at: 1000 } }, {}, async (signal, send) => {
    receivedSignal = signal
    send({ type: 'activity', activity: { id: 'completed', kind: 'context', status: 'succeeded', label: '已完成栏目', summary: '已校验', started_at: 1000, ended_at: 1001, duration_ms: 1 } })
    return new Promise(() => {})
  }, { key: 'version-1', resumable: true })
  t.mock.timers.tick(directorTaskSoftTimeoutMs)
  assert.equal(tasks.read('p', 'task').status, 'running'); assert.equal(receivedSignal!.aborted, false)
  assert.ok(tasks.read('p', 'task').events.some(event => event.stage === 'long_running'))
  t.mock.timers.tick(directorStreamTotalTimeoutMs - directorTaskSoftTimeoutMs)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const paused = tasks.read('p', 'task')
  assert.equal(paused.status, 'paused'); assert.equal(paused.execution.outcome!.kind, 'partial')
  assert.equal(paused.can_resume, true); assert.equal(receivedSignal!.aborted, true)
  assert.ok(paused.events.some(event => event.type === 'activity'))
  tasks.continue('p', 'task', 'version-1', async () => ({ reply: '余下步骤与复核完成' }))
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(tasks.read('p', 'task').status, 'succeeded')
  assert.ok(tasks.read('p', 'task').active_duration_ms! >= directorStreamTotalTimeoutMs)
  await tasks.close()
})
