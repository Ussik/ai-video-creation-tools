import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginTextRequest } from '../src/infrastructure/providers/text-request-usage.js'
import { modelWorkflowBudgetKey, type ModelWorkflowBudgetCheckpoint } from '../src/modules/generation/model-workflow-budget.js'

const testData = await mkdtemp(join(tmpdir(), 'director-execution-budget-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, now, run } = await import('../src/infrastructure/database/db.js')
const { runDirectorExecutionBudget } = await import('../src/modules/script/director-execution-budget.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const projectId = 'budget-project'
run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '任务预算', now(), now())
const options = (identity: unknown) => ({ projectId, identity, units: 1, inputChars: 100, signal: new AbortController().signal })
const request = () => beginTextRequest({ request_bytes: 10, estimated_input_tokens: 2, reserved_output_tokens: 4 })
function savedBudget() {
  const row = db.prepare('SELECT payload FROM model_unit_checkpoints WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId) as { payload: string }
  const checkpoint = JSON.parse(row.payload)
  return checkpoint.steps[modelWorkflowBudgetKey].value[modelWorkflowBudgetKey] as ModelWorkflowBudgetCheckpoint
}
test('identical simultaneous legacy requests share one execution and a durable ledger', async () => {
  let calls = 0, entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const input = options({ message: 'first', source: 'v1', model: 'fixed' })
  const first = runDirectorExecutionBudget(input, async () => { calls++; request(); entered(); await held; return '保留候选' })
  await began
  const second = runDirectorExecutionBudget(input, async () => { calls++; request(); return '重复调用' })
  release()
  assert.deepEqual(await Promise.all([first, second]), ['保留候选', '保留候选'])
  assert.equal(calls, 1); assert.equal(savedBudget().usage.requests, 1)
  assert.equal(savedBudget().usage.uncertain_requests, 1)
})
test('an exact retry restores cumulative usage without silently increasing its allowance', async () => {
  const identity = { message: 'retry', source: 'v1', model: 'fixed' }
  await assert.rejects(runDirectorExecutionBudget(options(identity), async () => { request(); throw new Error('请求中断') }), /请求中断/)
  const before = savedBudget()
  await runDirectorExecutionBudget({ ...options(identity), inputChars: 100_000, units: 99 }, async () => { request() })
  assert.equal(savedBudget().usage.requests, 2)
  assert.deepEqual(savedBudget().allowance, before.allowance)
  assert.equal(savedBudget().grants, 1)
})
