import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
const dir = await mkdtemp(join(tmpdir(), 'studio-repair-upgrade-routes-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceQualityRepairProgress } = await import('../src/modules/script/script-source-quality-repair.js')
const { sourceRecoveryDigest } = await import('../src/modules/script/source-request-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
initDb(); assert.ok(db.name.startsWith(dir))
after(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
async function terminal(id: string) {
  for (let n = 0; n < 200; n++) {
    const state = scriptSourceAnalysis(id)
    if (state && ['ready', 'failed'].includes(state.status)) return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('synthetic analysis did not settle')
}
for (const outcome of ['ready', 'unknown', 'row-paused', 'snapshot-paused'] as const) test(`HTTP admission and worker preserve progress and guard initial ref repair: ${outcome}`, async () => {
  const unknown = outcome === 'unknown', denied = outcome.endsWith('paused')
  const id = newId(), stamp = now(), content = '林舟得到钥匙，调查结束后回家。'
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'upgrade route', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, '原稿.txt', content, stamp)
  const initial = createScriptSourceAnalyzer(async (_p, _m, prompt) => sourceAnalysisFixture(prompt)!)
  initial.start(id, 'm')
  const baseline = await terminal(id); assert.equal(baseline.status, 'ready', baseline.error || ''); await initial.close()
  const state = structuredClone(baseline) as ScriptSourceAnalysis
  state.story!.summary = '林舟得到钥匙，调查结束后回家。'.repeat(20)
  state.sections[0]!.summary = state.story!.summary
  const hash = sourceQualityInputHash(state)
  state.quality = { input_hash: hash, status: 'issues', findings: [{ kind: 'omission', explanation: '前序已核实', unit_ids: [0] },
    { kind: 'causality', explanation: '核实钥匙状态', unit_ids: [0] }] }
  state.quality_repair = { review_hash: hash, current_hash: hash,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex'), completed_findings: 1 }
  state.status = 'failed'; state.error = 'old repair output lost'
  const scope = sourceRecoveryDigest({ source: state.source_version, model: state.model_id, configuration: state.configuration_hash })
  const oldKey = sourceRecoveryDigest(['m', 'legacy repair initial bytes', { name: 'script_source_quality_repair', schema: {} }])
  db.prepare('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?').run(state.status, JSON.stringify(state), id)
  db.prepare("INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,'dispatched','output_started',NULL,NULL,?)")
    .run(id, scope, oldKey, state.id, now())
  const old = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(id, scope, oldKey)
  const calls: string[] = [], app = Fastify()
  registerScriptSourceRoutes(app, { generateText: async (_p, _m, prompt, contract) => {
    calls.push(contract!.name)
    assert.ok(['script_source_quality_repair', 'script_source_quality'].includes(contract!.name))
    if (contract!.name === 'script_source_quality_repair') {
      const marker = '【原稿分析定点修补资料】\n', data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.equal(data.finding_index, 1); assert.ok(data.repair_references.length)
      const persisted = JSON.parse((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(id) as { snapshot: string }).snapshot)
      assert.deepEqual(persisted.sections, state.sections); assert.deepEqual(persisted.story, state.story); assert.deepEqual(persisted.quality_repair, state.quality_repair)
      if (outcome === 'row-paused') db.prepare("UPDATE script_source_analyses SET status='paused' WHERE project_id=?").run(id)
      if (outcome === 'snapshot-paused') { persisted.status = 'paused'; db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(persisted), id) }
      notifyTextRequest('dispatch', { request_id: 'route-upgrade-' + id })
      if (unknown) { notifyTextRequest('metrics', { request_id: 'route-upgrade-' + id, delivery: 'output_started', upstream_request_id: 'upstream-new-ref' }); throw new Error('new ref lost') }
      notifyTextRequest('metrics', { request_id: 'route-upgrade-' + id, delivery: 'completed' })
      return JSON.stringify({ decision: 'retain_analysis', finding_hash: data.finding_hash,
        reason: '现有分析已保留钥匙与回家事实，当前核对意见无需改动。', analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: 0 }], changes: [] })
    }
    notifyTextRequest('dispatch', { request_id: 'route-review-' + id })
    notifyTextRequest('metrics', { request_id: 'route-review-' + id, delivery: 'completed' })
    return sourceAnalysisFixture(prompt)!
  } })
  await app.ready()
  try {
    const path = `/api/projects/${id}/script/source/analysis/request-recovery`
    const details = (await app.inject({ method: 'GET', url: path })).json(); assert.equal(details.blockers.length, 1)
    const response = await app.inject({ method: 'POST', url: path, payload: { analysis_id: details.analysis_id, cas_token: details.cas_token,
      client_action_id: 'explicit-upgrade', decision: 'abandon_and_resume', acknowledged_duplicate_risk: true } })
    assert.equal(response.statusCode, 200, response.body)
    const result = await terminal(id); assert.equal(result.status, unknown || denied ? 'failed' : 'ready', result.error || '')
    assert.deepEqual(calls, unknown || denied ? ['script_source_quality_repair'] : ['script_source_quality_repair', 'script_source_quality'])
    assert.deepEqual(result.sections, state.sections); assert.deepEqual(result.story, state.story)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(id, scope, oldKey), old)
    const epoch = db.prepare('SELECT state,consumed_at FROM source_request_recovery_epochs WHERE project_id=?').get(id)
    assert.deepEqual(epoch, { state: denied ? 'prepared' : 'superseded', consumed_at: null })
    if (denied) {
      assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_recovery_resolutions WHERE project_id=?').get(id) as { n: number }).n, 0)
      assert.deepEqual(result.quality_repair, state.quality_repair); return
    }
    const resolution = db.prepare('SELECT reason,old_request_key,new_request_key,checkpoint_hash FROM source_request_recovery_resolutions WHERE project_id=?').get(id) as Record<string, unknown>
    assert.equal(resolution.reason, 'repair_contract_upgrade'); assert.equal(resolution.old_request_key, oldKey); assert.notEqual(resolution.new_request_key, oldKey)
    if (unknown) {
      assert.deepEqual(result.quality_repair, state.quality_repair); assert.equal(sourceQualityRepairProgress(result), 1)
      const next = (await app.inject({ method: 'GET', url: path })).json(); assert.equal(next.blockers.length, 1)
      assert.equal(next.blockers[0].upstream_request_id, 'upstream-new-ref'); assert.notEqual(next.blockers[0].request_key, oldKey)
      const ordinary = await app.inject({ method: 'POST', url: `/api/projects/${id}/script/source/analysis`, payload: { model_id: 'm', source_updated_at: stamp } })
      assert.equal(ordinary.statusCode, 409); assert.equal(calls.length, 1)
    } else assert.equal(result.quality?.status, 'passed')
  } finally { await app.close() }
})
