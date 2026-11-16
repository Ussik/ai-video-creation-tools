import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
const directory = await mkdtemp(join(tmpdir(), 'source-legacy-terminal-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { initSourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { initModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
const { legacyTerminatedSourceRequest, settleLegacyTerminatedSourceRequest } = await import('../src/modules/script/source-model-legacy-recovery.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const end = '2026-11-13T16:06:13.034Z'
const earlier = '2026-11-13T15:56:54.107Z'
const dispatched = '2026-11-13T15:56:54.148Z'
const scope = 'a'.repeat(64)
let counter = 0
function fixture(): { project: string; state: ScriptSourceAnalysis; task: string } {
  initSourceModelRecovery(); initModelRequestObservation()
  const project = `legacy-p-${++counter}`, id = `legacy-run-${counter}`, task = `source:${id}`
  const state: ScriptSourceAnalysis = { id, source_version: 'source-v1', model_id: 'claude', status: 'failed', completed_chunks: 2, total_chunks: 2, sections: [],
    error: '全剧整合未完成：上游模型返回错误（stream_read_error）：upstream stream disconnected: connection reset by peer。', updated_at: end }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(project, project, now(), now())
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(project, 'source.txt', '原稿', end)
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)').run(project, id, state.source_version, 'failed', JSON.stringify(state), end)
  db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(id, project)
  db.prepare('INSERT INTO model_request_tasks (id,project_id,model_id,label,owner,state,usage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(task, project, 'claude', '原稿分析', 'request', 'failed', '{}', '2026-11-13T15:47:12.841Z', '2026-11-13T16:06:13.031Z')
  const insert = db.prepare('INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  insert.run(project, scope, 'complete', id, 'completed', 'completed', '完整结果', earlier)
  insert.run(project, scope, 'terminal', id, 'dispatched', 'unknown', null, dispatched)
  const attempt = db.prepare('INSERT INTO model_request_attempts (task_id,id,state,metrics,updated_at) VALUES (?,?,?,?,?)')
  attempt.run(task, `${id}-complete`, 'settled', JSON.stringify({ task_id: task, request_id: `${id}-complete`, model_id: 'claude', request_purpose: 'generation', delivery: 'completed', response_chars: 4, http_status: 200 }), '2026-11-13T15:56:54.106Z')
  attempt.run(task, `${id}-terminal`, 'settled', JSON.stringify({ task_id: task, request_id: `${id}-terminal`, model_id: 'claude', request_purpose: 'generation', delivery: 'output_started', response_chars: 13363, raw_reason: 'stream_read_error', failure_reason: 'upstream_error', http_status: 200 }), '2026-11-13T16:06:13.026Z')
  return { project, state, task }
}
const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM source_model_requests ORDER BY project_id,request_key').all())

test('missing journal tables yield no candidate without creating any table', () => {
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  const before = tables()
  assert.equal(legacyTerminatedSourceRequest('missing', { status: 'failed', error: 'stream_read_error', updated_at: end } as ScriptSourceAnalysis), undefined)
  assert.deepEqual(tables(), before)
})

test('unique serial legacy evidence can be read without mutation and settled once on explicit continuation', () => {
  const { project, state } = fixture(), before = snapshot()
  assert.deepEqual(legacyTerminatedSourceRequest(project, state), { scope, requestKey: 'terminal' })
  assert.equal(snapshot(), before)
  assert.equal(settleLegacyTerminatedSourceRequest(project, state), true)
  assert.equal(settleLegacyTerminatedSourceRequest(project, state), false)
  assert.equal(db.prepare('SELECT state FROM source_model_requests WHERE project_id=? AND request_key=?').get(project, 'terminal')?.state, 'failed')
  assert.equal(db.prepare('SELECT state FROM source_model_requests WHERE project_id=? AND request_key=?').get(project, 'complete')?.state, 'completed')
})

const cases: Array<[string, (fixture: ReturnType<typeof fixture>) => void]> = [
  ['analysis state', ({ state }) => { state.status = 'paused' }],
  ['analysis error', ({ state }) => { state.error = 'connection_error' }],
  ['analysis timestamp', ({ state }) => { state.updated_at = '2026-11-13T16:06:14.034Z' }],
  ['task state', ({ task }) => { db.prepare("UPDATE model_request_tasks SET state='succeeded' WHERE id=?").run(task) }],
  ['task model', ({ task }) => { db.prepare("UPDATE model_request_tasks SET model_id='other' WHERE id=?").run(task) }],
  ['attempt cardinality', ({ task }) => { db.prepare('DELETE FROM model_request_attempts WHERE task_id=? AND id LIKE ?').run(task, '%complete') }],
  ['nonterminal code', ({ task }) => mutateMetric(task, 'terminal', { raw_reason: 'connection_error' })],
  ['wrong delivery', ({ task }) => mutateMetric(task, 'terminal', { delivery: 'unknown' })],
  ['wrong status', ({ task }) => mutateMetric(task, 'terminal', { http_status: 503 })],
  ['wrong failure class', ({ task }) => mutateMetric(task, 'terminal', { failure_reason: 'cancelled' })],
  ['wrong model identity', ({ task }) => mutateMetric(task, 'terminal', { model_id: 'other' })],
  ['wrong request identity', ({ task }) => mutateMetric(task, 'terminal', { request_id: 'unrelated' })],
  ['transport attempt', ({ task }) => mutateMetric(task, 'terminal', { kind: 'transport' })],
  ['tool purpose', ({ task }) => mutateMetric(task, 'terminal', { request_purpose: 'tool_decision' })],
  ['complete result length', ({ task }) => mutateMetric(task, 'complete', { response_chars: 3 })],
  ['complete timestamp', ({ task }) => { db.prepare("UPDATE model_request_attempts SET updated_at='2026-11-13T15:56:53.106Z' WHERE task_id=? AND id LIKE ?").run(task, '%complete') }],
  ['terminal timestamp', ({ task }) => { db.prepare("UPDATE model_request_attempts SET updated_at='2026-11-13T16:06:14.026Z' WHERE task_id=? AND id LIKE ?").run(task, '%terminal') }],
  ['multiple dispatched', ({ project }) => { db.prepare("UPDATE source_model_requests SET state='dispatched' WHERE project_id=? AND request_key='complete'").run(project) }],
  ['different scopes', ({ project }) => { db.prepare("UPDATE source_model_requests SET scope='other' WHERE project_id=? AND request_key='complete'").run(project) }],
  ['dispatch after terminal', ({ project }) => { db.prepare("UPDATE source_model_requests SET updated_at='2026-11-13T16:06:14.026Z' WHERE project_id=? AND request_key='terminal'").run(project) }],
  ['any background identity', ({ project }) => { db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)').run(project, scope, 'background', '{"state":"accepted","id":"resp_other"}') }],
  ['invalid metric JSON', ({ task }) => { db.prepare("UPDATE model_request_attempts SET metrics='invalid' WHERE task_id=? AND id LIKE ?").run(task, '%terminal') }],
]
function mutateMetric(task: string, suffix: string, value: Record<string, unknown>) {
  const row = db.prepare('SELECT id,metrics FROM model_request_attempts WHERE task_id=? AND id LIKE ?').get(task, `%${suffix}`) as { id: string; metrics: string }
  db.prepare('UPDATE model_request_attempts SET metrics=? WHERE task_id=? AND id=?').run(JSON.stringify({ ...JSON.parse(row.metrics), ...value }), task, row.id)
}
for (const [name, mutate] of cases) test(`legacy recovery rejects ${name} without changing requests`, () => {
  const current = fixture(); mutate(current); const before = snapshot()
  assert.equal(legacyTerminatedSourceRequest(current.project, current.state), undefined)
  assert.equal(settleLegacyTerminatedSourceRequest(current.project, current.state), false)
  assert.equal(snapshot(), before)
})


test('an explicit terminal error before visible text is eligible only with accepted delivery and the same complete serial evidence', () => {
  const current = fixture()
  mutateMetric(current.task, 'terminal', { delivery: 'accepted', response_chars: 0, failure_reason: 'disconnected' })
  assert.deepEqual(legacyTerminatedSourceRequest(current.project, current.state), { scope, requestKey: 'terminal' })
  assert.equal(settleLegacyTerminatedSourceRequest(current.project, current.state), true)
})
