import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
const dir = await mkdtemp(join(tmpdir(), 'studio-source-recovery-route-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
initDb()
after(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
function project() {
  const id = newId(), stamp = now()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, '恢复测试', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)')
    .run(id, '原稿.txt', '林舟得到钥匙，调查结束后回家。', stamp)
  return { id, stamp }
}
async function terminal(id: string) {
  for (let n = 0; n < 200; n++) {
    const s = scriptSourceAnalysis(id)
    if (s && ['ready', 'failed'].includes(s.status)) return s
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fixture did not settle')
}
function generator() {
  let lost = true, posts = 0
  const call = async (_p: string, _m: string, prompt: string) => {
    const request_id = newId(); notifyTextRequest('dispatch', { request_id, delivery: 'unknown' }); posts++
    if (lost) { lost = false; notifyTextRequest('metrics', { request_id, upstream_request_id: 'upstream-lost', delivery: 'accepted' }); throw new Error('fixture accepted response lost') }
    notifyTextRequest('metrics', { request_id, upstream_request_id: 'upstream-complete', delivery: 'completed' })
    return sourceAnalysisFixture(prompt)!
  }
  return { call, count: () => posts }
}
test('normal route exposes exact linked blocker, requires explicit acknowledgement and resumes without rewriting old request', async () => {
  const p = project(), g = generator(), app = Fastify()
  registerScriptSourceRoutes(app, { generateText: g.call })
  await app.ready()
  try {
    const started = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script/source/analysis`, payload: { model_id: 'm', source_updated_at: p.stamp } })
    assert.equal(started.statusCode, 200)
    const stopped = await terminal(p.id); assert.equal(stopped.status, 'failed'); assert.equal(g.count(), 1)
    const old = db.prepare("SELECT * FROM source_model_requests WHERE project_id=? AND state='dispatched'").get(p.id)
    const path = `/api/projects/${p.id}/script/source/analysis/request-recovery`
    const beforeChanges = db.prepare('SELECT total_changes() AS n').get()
    const details = await app.inject({ method: 'GET', url: path }); assert.equal(details.statusCode, 200)
    const d = details.json(); assert.equal(d.blockers.length, 1); assert.equal(d.blockers[0].identity_binding, 'native')
    assert.equal(d.blockers[0].upstream_request_id, 'upstream-lost')
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), beforeChanges)
    const payload = { analysis_id: d.analysis_id, cas_token: d.cas_token, client_action_id: 'route-choice', decision: 'abandon_and_resume', acknowledged_duplicate_risk: true }
    const rejected = await app.inject({ method: 'POST', url: path, payload: { ...payload, acknowledged_duplicate_risk: false } })
    assert.equal(rejected.statusCode, 422); assert.equal(g.count(), 1)
    const accepted = await app.inject({ method: 'POST', url: path, payload }); assert.equal(accepted.statusCode, 200, accepted.body)
    const ready = await terminal(p.id); assert.equal(ready.status, 'ready', ready.error || '')
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(p.id, (old as any).scope, (old as any).request_key), old)
    const duplicate = await app.inject({ method: 'POST', url: path, payload }); assert.equal(duplicate.statusCode, 200, duplicate.body)
    assert.equal(duplicate.json().action_id, accepted.json().action_id)
    assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_recovery_actions WHERE project_id=?').get(p.id) as any).n, 1)
  } finally { await app.close() }
})
test('queued optional audit pauses on restart and explicit continuation reuses its existing grant', async () => {
  const p = project(), g = generator(), first = createScriptSourceAnalyzer(g.call)
  first.start(p.id, 'm'); const stopped = await terminal(p.id); assert.equal(stopped.status, 'failed')
  const d = first.requestRecovery(p.id), input = { analysis_id: d.analysis_id, cas_token: d.cas_token, client_action_id: 'restart-choice', decision: 'abandon_and_resume' as const, acknowledged_duplicate_risk: true as const }
  const admitted = first.resolveRequest(p.id, input)
  const grant = (admitted.analysis.budget_steps![modelWorkflowBudgetKey] as { grants: number }).grants
  await first.close()
  const second = createScriptSourceAnalyzer(g.call)
  try {
    const callsBeforeRestart = g.count()
    second.recover()
    assert.equal(scriptSourceAnalysis(p.id)?.status, 'paused')
    assert.equal(g.count(), callsBeforeRestart, 'restart never purchases an optional audit')
    second.start(p.id, 'm')
    const ready = await terminal(p.id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal((ready as any).budget_steps[modelWorkflowBudgetKey].grants, grant)
    const epoch = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').get(p.id) as any
    assert.equal(epoch.state, 'completed'); assert.ok(epoch.consumed_at)
    assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_recovery_actions WHERE project_id=?').get(p.id) as any).n, 1)
  } finally { await second.close() }
})


test('explicit preparation is local-only, idempotent under double submission and restorable by read-only GET', async () => {
  const p = project(), g = generator(), app = Fastify()
  registerScriptSourceRoutes(app, { generateText: g.call })
  await app.ready()
  try {
    await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script/source/analysis`, payload: { model_id: 'm', source_updated_at: p.stamp } })
    await terminal(p.id)
    const path = `/api/projects/${p.id}/script/source/analysis/request-recovery`
    const d = (await app.inject({ method: 'GET', url: path })).json()
    const old = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(p.id)
    const payload = { analysis_id: d.analysis_id, cas_token: d.cas_token, client_action_id: 'prepare-double', decision: 'reconcile_local' }
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: path + '/prepare', payload })))
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().recovery.model_requests_started, false)
      assert.equal(response.json().recovery.summary.saved_count, 0)
    }
    assert.equal(responses[0]!.json().action_id, responses[1]!.json().action_id)
    assert.equal(g.count(), 1, 'preparation cannot dispatch a model')
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(p.id), old)
    const changes = db.prepare('SELECT total_changes() AS n').get()
    const latest = (await app.inject({ method: 'GET', url: path })).json()
    assert.equal(latest.recovery_workflow.client_action_id, 'prepare-double')
    assert.equal(latest.recovery_workflow.recovery.summary.saved_count, 0)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes)
    const rejected = await app.inject({ method: 'POST', url: path + '/prepare', payload: { ...payload,
      risk_confirmation: { scope_token: 'a'.repeat(64), acknowledged_duplicate_risk: true } } })
    assert.equal(rejected.statusCode, 422, 'prepare endpoint never accepts a paid authorization')
    assert.equal(g.count(), 1)
  } finally { await app.close() }
})
