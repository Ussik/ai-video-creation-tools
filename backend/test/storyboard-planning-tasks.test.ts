import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import type { StoryboardPlanningResult } from '@video-studio/shared/storyboard/storyboard-planning-types'

const directory = await mkdtemp(join(tmpdir(), 'storyboard-planning-tasks-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, run, one } = await import('../src/infrastructure/database/db.js')
const { buildApp } = await import('../src/app.js')
const { createStoryboardPlanningTasks } = await import('../src/modules/storyboard/storyboard-planning-tasks.js')
const { runStoryboardPlanningWorkflow } = await import('../src/modules/storyboard/storyboard-planning-workflow.js')
const { clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const projection = { signature: 'a'.repeat(64), scenes: [], used_skills: [], source_documents: [],
  directing_review: { status: 'pending_review', repaired: false, issues: [] } } as StoryboardPlanningResult
async function project() {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '隔离任务断点测试' } })
  assert.equal(response.statusCode, 200); return response.json().id as string
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  throw new Error('test phase not reached')
}

test('server shutdown and restart retain candidate and timings without replay until explicit resume', async () => {
  const projectId = await project(), calls: string[] = []
  let interrupted = true
  const options = { identity: (_projectId: string, input: unknown) => hash(input),
    execute: (_projectId: string, _input: unknown, control: import('../src/modules/storyboard/storyboard-planning-tasks.js').StoryboardPlanningControl) => runStoryboardPlanningWorkflow(control, {
      prepare: async () => { calls.push('prepare'); return 'rules' }, restorePreparation: String,
      generate: async () => { calls.push('generate'); return 'candidate' }, restoreCandidate: String,
      review: async () => { calls.push('review'); if (interrupted) await new Promise((_, reject) => control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true })); return 'passed' },
      restoreReport: String, hasErrors: () => false, repair: async () => 'repaired', projection: () => projection,
      finish: () => ({ ...projection, directing_review: { status: 'passed' as const, repaired: false, issues: [] } }),
    }) }
  const first = createStoryboardPlanningTasks(options), task = first.start(projectId, { source: 'same' }, randomUUID())
  await until(() => first.read(projectId, task.id).stage === 'reviewing')
  await first.close()
  const second = createStoryboardPlanningTasks(options)
  try {
    const stored = second.read(projectId, task.id)
    assert.equal(stored.status, 'interrupted'); assert.ok(stored.candidate)
    assert.equal(stored.can_resume, true); assert.deepEqual(calls, ['prepare', 'generate', 'review'])
    assert.ok(stored.timings.generating! >= 0)
    const alias = randomUUID()
    assert.equal(second.start(projectId, { source: 'same' }, alias).id, task.id)
    assert.equal(second.read(projectId, alias).id, task.id, 'a lost response can be observed by its accepted request identity')
    assert.deepEqual(calls, ['prepare', 'generate', 'review'])
    interrupted = false
    second.resume(projectId, task.id)
    const completed = await second.wait(projectId, task.id)
    assert.equal(completed.directing_review!.status, 'passed')
    assert.equal(second.read(projectId, task.id).stage_duration_ms, 0, 'completed is a state, not another running phase')
    assert.deepEqual(calls, ['prepare', 'generate', 'review', 'review'])
  } finally { await second.close() }
})

test('orphan running records become interrupted on read and foreign project tasks stay private', async () => {
  const projectId = await project(), foreignId = await project(), id = randomUUID(), input = { source: 'old' }
  const state = { version: 1, input, request_ids: [id], steps: { candidate: 'saved' }, snapshot: {
    id, project_id: projectId, input_key: hash(input), status: 'running', stage: 'reviewing', started_at: Date.now(), updated_at: Date.now(),
    active_duration_ms: 1200, stage_duration_ms: 200, timings: { generating: 1000, reviewing: 200 }, can_resume: false, candidate: projection,
  } }
  run('INSERT INTO script_step_checkpoints VALUES (?,?,?,?,?)', projectId, `storyboard-planning-task:${id}`, hash(input), JSON.stringify(state), new Date().toISOString())
  const tasks = createStoryboardPlanningTasks({ identity: (_projectId, value) => hash(value), execute: async () => { throw new Error('must not dispatch') } })
  try {
    assert.equal(tasks.read(projectId, id).status, 'interrupted')
    assert.equal(tasks.read(projectId, id).active_duration_ms, 1200, 'time spent offline is not generation time')
    assert.throws(() => tasks.read(foreignId, id), /不存在/)
  } finally { await tasks.close() }
})

test('model/provider identity changes reject resume and exact request replay before dispatch', async () => {
  const projectId = await project(), input = { source: 'unchanged' }, requestId = randomUUID()
  let settings = 'model-settings-v1', calls = 0
  const tasks = createStoryboardPlanningTasks({ identity: (_projectId, value) => hash({ settings, value }),
    execute: async (_projectId, _input, control) => { calls++; control.retain('candidate', 'saved', projection); throw new Error('connection failed') } })
  try {
    const task = tasks.start(projectId, input, requestId)
    await until(() => tasks.read(projectId, task.id).status === 'failed')
    settings = 'model-settings-v2'
    assert.throws(() => tasks.read(projectId, task.id), /配置已更新/)
    assert.throws(() => tasks.resume(projectId, task.id), /配置已更新/)
    assert.throws(() => tasks.start(projectId, input, requestId), /请求 ID/)
    assert.equal(calls, 1)
    assert.equal(tasks.lookup(projectId, input), null)
  } finally { await tasks.close() }
})

test('saving or discarding script work does not erase storyboard candidates or completed previews', async () => {
  const projectId = await project(), id = randomUUID()
  for (const namespace of [`storyboard-planning-task:${id}`, 'storyboard-planning-preview', 'unrelated-script-step']) {
    run('INSERT INTO script_step_checkpoints VALUES (?,?,?,?,?)', projectId, namespace, hash(namespace), '{}', new Date().toISOString())
  }
  clearGenerationCheckpoint(projectId)
  assert.ok(one('SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, `storyboard-planning-task:${id}`))
  assert.ok(one('SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, 'storyboard-planning-preview'))
  assert.equal(one('SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace=?', projectId, 'unrelated-script-step'), undefined)
})

test('cancelling a request before acceptance durably blocks later dispatch, including after restart', async () => {
  const projectId = await project(), requestId = randomUUID()
  let calls = 0
  const options = { identity: (_projectId: string, input: unknown) => hash(input), execute: async () => { calls++; return projection } }
  const first = createStoryboardPlanningTasks(options)
  assert.deepEqual(await first.cancelRequest(projectId, requestId), { cancelled: true, task: null })
  await first.close()
  clearGenerationCheckpoint(projectId)
  const second = createStoryboardPlanningTasks(options)
  try {
    assert.throws(() => second.start(projectId, { source: 'same' }, requestId), /已取消/)
    assert.equal(calls, 0)
  } finally { await second.close() }
})

test('a lost acceptance response is cancelled by request identity without another generation dispatch', async () => {
  const projectId = await project(), requestId = randomUUID()
  let calls = 0
  const tasks = createStoryboardPlanningTasks({ identity: (_projectId, input) => hash(input), execute: async (_projectId, _input, control) => {
    calls++; control.stage('reviewing'); control.retain('candidate', 'saved', projection)
    await new Promise((_, reject) => control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true }))
    return projection
  } })
  try {
    tasks.start(projectId, { source: 'same' }, requestId)
    const cancelled = await tasks.cancelRequest(projectId, requestId)
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.task!.status, 'cancelled')
    assert.ok(cancelled.task!.candidate)
    assert.throws(() => tasks.start(projectId, { source: 'same' }, requestId), /已取消/)
    assert.equal(calls, 1)
  } finally { await tasks.close() }
})

test('validated batch progress survives failure and restart without becoming a saveable candidate', async () => {
  const projectId = await project(), requestId = randomUUID()
  let resume = false
  const options = { identity: (_projectId: string, input: unknown) => hash(input),
    execute: async (_projectId: string, _input: unknown, control: import('../src/modules/storyboard/storyboard-planning-tasks.js').StoryboardPlanningControl) => {
      if (resume) {
        control.stage('repairing')
        assert.equal(second.read(projectId, requestId).progress, undefined, 'repair must not inherit initial generation counts')
        control.progress!({ phase: 'outline', completed_shots: 0, total_shots: 0 })
        control.progress!({ phase: 'shots', completed_shots: 6, total_shots: 6 })
        control.stage('rechecking')
        assert.equal(second.read(projectId, requestId).progress, undefined, 'review no longer reports generation progress')
        return projection
      }
      control.stage('generating')
      control.progress!({ phase: 'outline', completed_shots: 0, total_shots: 0 })
      control.retain('first_batch', { shots: [0, 1] })
      control.progress!({ phase: 'shots', completed_shots: 2, total_shots: 6 })
      throw Object.assign(new Error('upstream disconnected'), { statusCode: 502 })
    } }
  const first = createStoryboardPlanningTasks(options)
  first.start(projectId, { source: 'same' }, requestId)
  await until(() => first.read(projectId, requestId).status === 'failed')
  assert.equal(first.read(projectId, requestId).candidate, undefined)
  await first.close()
  const second = createStoryboardPlanningTasks(options)
  try {
    const saved = second.read(projectId, requestId)
    assert.deepEqual(saved.progress, { phase: 'shots', completed_shots: 2, total_shots: 6 })
    assert.equal(saved.can_resume, true)
    assert.equal(saved.candidate, undefined)
    resume = true
    second.resume(projectId, requestId)
    await second.wait(projectId, requestId)
    assert.equal(second.read(projectId, requestId).progress, undefined)
    assert.equal(second.read(projectId, requestId).status, 'succeeded')
  } finally { await second.close() }
})
