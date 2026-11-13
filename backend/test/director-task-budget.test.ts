import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { directorTaskSoftTimeoutMs, directorStreamTotalTimeoutMs } from '@video-studio/shared/script/script-stream-policy'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-task-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, run, now, one } = await import('../src/infrastructure/database/db.js')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

test('long-running tasks keep executing beyond the former deadline and manual stop preserves resumable progress', async t => {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', 'p', 'budget test', now(), now())
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 })
  const tasks = createDirectorTasks()
  let receivedSignal: AbortSignal | undefined
  tasks.start('p', { id: 'task', conversation: { id: 'conversation', messages: [{ id: 'user', role: 'user', text: '生成大纲' }] }, execution: { title: '大纲', request: '生成大纲', started_at: 1000 } }, {}, async (signal, send) => {
    receivedSignal = signal
    send({ type: 'activity', activity: { id: 'completed', kind: 'context', status: 'succeeded', label: '已完成栏目', summary: '已校验', started_at: 1000, ended_at: 1001, duration_ms: 1 } })
    return new Promise(() => {})
  }, { key: 'version-1', resumable: true, budgetScale: { units: 10, inputChars: 50_000 } })
  t.mock.timers.tick(directorTaskSoftTimeoutMs)
  assert.equal(tasks.read('p', 'task').status, 'running'); assert.equal(receivedSignal!.aborted, false)
  assert.ok(tasks.read('p', 'task').events.some(event => event.stage === 'long_running'))
  t.mock.timers.tick(directorStreamTotalTimeoutMs - directorTaskSoftTimeoutMs)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const active = tasks.read('p', 'task')
  assert.equal(active.status, 'running'); assert.equal(receivedSignal!.aborted, false)
  tasks.cancel('p', 'task')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const stopped = tasks.read('p', 'task')
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.execution.outcome!.kind, 'cancelled')
  assert.equal(stopped.can_resume, true); assert.equal(receivedSignal!.aborted, true)
  assert.ok(stopped.events.some(event => event.type === 'activity'))
  tasks.continue('p', 'task', 'version-1', async () => ({ reply: '余下步骤与复核完成' }))
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(tasks.read('p', 'task').status, 'succeeded')
  assert.ok(tasks.read('p', 'task').active_duration_ms! >= directorStreamTotalTimeoutMs)
  await tasks.close()
})


test('actual long source and candidate scope sizes the durable director allowance and stays fixed on resume', async () => {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', 'long-scope', 'long scope', now(), now())
  const tasks = createDirectorTasks(), request = { prompt: '复核正文', document_id: 'source' }, budgetScale = { units: 8, inputChars: '长篇正式正文'.repeat(20_000).length }
  const input = { id: 'long-task', conversation: { id: 'long-conversation', messages: [{ id: 'long-user', role: 'user' as const, text: '复核正文' }] }, execution: { title: '复核正文', request: '复核正文', started_at: Date.now(), targets: ['正文'] } }
  tasks.start('long-scope', input, request, async () => { throw new Error('fixture interrupted') }, { key: 'long-key', resumable: true, budgetScale })
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const initial = tasks.read('long-scope', 'long-task'), checkpoint = initial.budget_steps!['model_workflow_budget:v1'] as any
  const { modelWorkflowAllowance } = await import('../src/modules/generation/model-workflow-budget.js')
  assert.deepEqual(initial.budget_scale, budgetScale)
  assert.deepEqual(checkpoint.allowance, modelWorkflowAllowance('script', budgetScale))
  assert.ok(checkpoint.allowance.max_requests > modelWorkflowAllowance('script', { units: 1, inputChars: JSON.stringify(request).length }).max_requests)
  const persisted = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', 'long-task')!.snapshot)
  assert.deepEqual(persisted.budget_scale, budgetScale)
  budgetScale.inputChars = 1 // Mutating the caller object cannot change the saved scale.
  tasks.continue('long-scope', 'long-task', 'next-key', async () => ({ reply: '继续完成' }), { previousKey: 'long-key', request: { ...request, new_source: 'changed request'.repeat(100_000) } })
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const completed = tasks.read('long-scope', 'long-task')
  assert.equal(completed.status, 'succeeded')
  assert.deepEqual((completed.budget_steps!['model_workflow_budget:v1'] as any).allowance, checkpoint.allowance)
  assert.deepEqual(completed.budget_scale, persisted.budget_scale)
  await tasks.close()
})

test('legacy director snapshots retain their fixed ledger and fall back compatibly when scale metadata is absent', async () => {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', 'legacy-scale', 'legacy scale', now(), now())
  const tasks = createDirectorTasks(), request = { prompt: '历史请求' }
  tasks.start('legacy-scale', { id: 'legacy-task', conversation: { id: 'legacy-conversation', messages: [{ id: 'legacy-user', role: 'user', text: '历史请求' }] }, execution: { title: '历史请求', request: '历史请求', started_at: Date.now(), targets: ['角色', '场景'] } }, request,
    async () => { throw new Error('fixture interrupted') }, { key: 'legacy-key', resumable: true })
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const snapshot = JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', 'legacy-task')!.snapshot)
  const allowance = structuredClone(snapshot.budget_steps['model_workflow_budget:v1'].allowance)
  delete snapshot.budget_scale
  run('UPDATE script_director_tasks SET snapshot=? WHERE id=?', JSON.stringify(snapshot), 'legacy-task')
  tasks.continue('legacy-scale', 'legacy-task', 'legacy-key', async () => ({ reply: '完成历史任务' }))
  for (let index = 0; index < 12; index++) await Promise.resolve()
  const completed = tasks.read('legacy-scale', 'legacy-task')
  assert.equal(completed.status, 'succeeded')
  assert.deepEqual(completed.budget_scale, { units: 2, inputChars: JSON.stringify(request).length })
  assert.deepEqual((completed.budget_steps!['model_workflow_budget:v1'] as any).allowance, allowance)
  await tasks.close()
})
