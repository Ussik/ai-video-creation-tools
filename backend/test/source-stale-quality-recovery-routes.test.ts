import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
const dir = await mkdtemp(join(tmpdir(), 'studio-stale-quality-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceQualityRepairProgress } = await import('../src/modules/script/script-source-quality-repair.js')
const { sourceRequestRecoveryBinding } = await import('../src/modules/script/source-request-recovery-admission.js')
const { sourceRecoveryDigest } = await import('../src/modules/script/source-request-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
initDb()
assert.ok(db.name.startsWith(dir))
after(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

async function terminal(id: string) {
  for (let n = 0; n < 200; n++) {
    const state = scriptSourceAnalysis(id)
    if (state && ['ready', 'failed'].includes(state.status)) return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('synthetic analysis did not settle')
}
function project() {
  const id = newId(), stamp = now(), content = '林舟得到钥匙，调查结束后回家。'
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, '旧策略检查点恢复', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, '原稿.txt', content, stamp)
  return { id, stamp, content }
}

/** Construct an authentic previous-policy hash from unchanged artifacts. The
 * checkpoint deliberately keeps this old hash; it is never overwritten with
 * today's hash to make a stale repair look current. */
function legacyCheckpoint(state: ScriptSourceAnalysis) {
  const oldHash = createHash('sha256').update(JSON.stringify(['source-quality-policy-v1', state.source_version, state.sections, state.story])).digest('hex')
  const findings = [{ kind: 'omission' as const, explanation: '旧策略要求再次核对钥匙信息。', unit_ids: [0] }]
  state.quality = { input_hash: oldHash, status: 'issues', findings }
  state.quality_repair = { review_hash: oldHash, findings_hash: createHash('sha256').update(JSON.stringify(findings)).digest('hex'),
    current_hash: oldHash, completed_findings: 0 }
  assert.notEqual(oldHash, sourceQualityInputHash(state)); assert.equal(sourceQualityRepairProgress(state), null)
  return oldHash
}

for (const loseFreshReview of [false, true]) test(`stale legacy repair permit retires only on independent review; fresh review ${loseFreshReview ? 'unknown blocks again' : 'passes to ready'}`, async () => {
  const p = project()
  const initial = createScriptSourceAnalyzer(async (_p, _m, prompt) => sourceAnalysisFixture(prompt)!)
  initial.start(p.id, 'm')
  const baseline = await terminal(p.id); assert.equal(baseline.status, 'ready', baseline.error || '')
  await initial.close()
  const stale = structuredClone(baseline), oldHash = legacyCheckpoint(stale)
  stale.status = 'failed'; stale.error = '旧版定点修补已受理，响应未确认'; stale.updated_at = now()
  const scope = sourceRecoveryDigest({ source: stale.source_version, model: stale.model_id, configuration: stale.configuration_hash })
  const oldPrompt = JSON.stringify({ kind: 'legacy_quality_repair', baseline_hash: oldHash, finding: stale.quality!.findings[0] })
  const oldKey = sourceRecoveryDigest([stale.model_id, oldPrompt, { name: 'script_source_quality_repair' }])
  db.prepare('UPDATE script_source_analyses SET status=?,snapshot=?,updated_at=? WHERE project_id=?').run(stale.status, JSON.stringify(stale), stale.updated_at, p.id)
  db.prepare("INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)")
    .run(p.id, scope, oldKey, stale.id, stale.updated_at)
  const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(p.id, scope, oldKey)
  const retained = { sections: structuredClone(stale.sections), story: structuredClone(stale.story), quality: structuredClone(stale.quality), repair: structuredClone(stale.quality_repair) }
  const calls: string[] = [], app = Fastify()
  registerScriptSourceRoutes(app, { generateText: async (_p, _m, prompt, contract) => {
    calls.push(contract?.name || '')
    assert.equal(contract?.name, 'script_source_quality', 'stale repair must never be reissued')
    const request_id = newId(); notifyTextRequest('dispatch', { request_id, delivery: 'unknown' })
    if (loseFreshReview) { notifyTextRequest('metrics', { request_id, delivery: 'accepted', upstream_request_id: 'fresh-review-unknown' }); throw new Error('fresh review accepted then disconnected') }
    notifyTextRequest('metrics', { request_id, delivery: 'completed' })
    return sourceAnalysisFixture(prompt)!
  } })
  await app.ready()
  try {
    const path = `/api/projects/${p.id}/script/source/analysis/request-recovery`
    const d = (await app.inject({ method: 'GET', url: path })).json()
    assert.equal(d.blockers.length, 1); assert.equal(d.budget.can_resume, true)
    const payload = { analysis_id: d.analysis_id, cas_token: d.cas_token, client_action_id: 'stale-policy-choice', decision: 'abandon_and_resume', acknowledged_duplicate_risk: true }
    const admitted = await app.inject({ method: 'POST', url: path, payload }); assert.equal(admitted.statusCode, 200, admitted.body)
    const result = await terminal(p.id)
    assert.equal(result.status, loseFreshReview ? 'failed' : 'ready', result.error || '')
    assert.deepEqual(calls, ['script_source_quality'])
    assert.deepEqual(result.sections, retained.sections); assert.deepEqual(result.story, retained.story)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(p.id, scope, oldKey), original)
    const epoch = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').get(p.id) as { id: string; state: string; consumed_at: string | null }
    assert.equal(epoch.state, 'superseded'); assert.equal(epoch.consumed_at, null)
    const resolution = db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').get(p.id) as Record<string, unknown>
    assert.equal(resolution.reason, 'stale_quality_checkpoint'); assert.equal(resolution.checkpoint_hash, oldHash)
    assert.equal(resolution.current_checkpoint_hash, sourceQualityInputHash(stale)); assert.equal(resolution.old_request_key, oldKey)
    const action = db.prepare('SELECT analysis_binding FROM source_request_recovery_actions WHERE project_id=?').get(p.id) as { analysis_binding: string }
    assert.equal(action.analysis_binding, sourceRequestRecoveryBinding({ document: { project_id: p.id, filename: '原稿.txt', content: p.content, updated_at: p.stamp },
      state: stale, configuration_hash: stale.configuration_hash!, local_active: false }))
    const oldBudget = (stale as any).budget_steps[modelWorkflowBudgetKey], newBudget = (result as any).budget_steps[modelWorkflowBudgetKey]
    assert.equal(newBudget.grants, oldBudget.grants); assert.ok(newBudget.active_ms >= oldBudget.active_ms)
    assert.ok(newBudget.usage.requests >= oldBudget.usage.requests)
    if (loseFreshReview) {
      assert.deepEqual(result.quality, retained.quality); assert.deepEqual(result.quality_repair, retained.repair)
      const blocked = (await app.inject({ method: 'GET', url: path })).json()
      assert.equal(blocked.blockers.length, 1); assert.equal(blocked.blockers[0].upstream_request_id, 'fresh-review-unknown')
      const ordinary = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/script/source/analysis`, payload: { model_id: 'm', source_updated_at: p.stamp } })
      assert.equal(ordinary.statusCode, 409); assert.equal(calls.length, 1)
      assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_recovery_actions WHERE project_id=?').get(p.id) as { n: number }).n, 1)
    } else assert.equal(result.quality?.status, 'passed')
  } finally { await app.close() }
})

// A captured business checkpoint is optional local acceptance evidence only;
// never required by the repository regression or read from the business DB.
test('captured checkpoint gate keeps stale hashes unchanged when local evidence is supplied', async t => {
  const path = process.env.STUDIO_SOURCE_STALE_CAPTURE
  if (!path) { t.skip('optional captured-checkpoint evidence'); return }
  const state = JSON.parse(await readFile(path, 'utf8')) as ScriptSourceAnalysis
  const before = JSON.stringify(state), repair = state.quality_repair
  assert.ok(repair); assert.equal(repair.review_hash, state.quality?.input_hash)
  assert.notEqual(repair.current_hash, sourceQualityInputHash(state)); assert.equal(sourceQualityRepairProgress(state), null)
  assert.equal(JSON.stringify(state), before)
})
