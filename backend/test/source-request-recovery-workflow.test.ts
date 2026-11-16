import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'

const directory = await mkdtemp(join(tmpdir(), 'source-recovery-workflow-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { initSourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { sourceRequestRecoveryDetails, reconcileSourceRequestRecovery, admitSourceRequestRecovery } = await import('../src/modules/script/source-request-recovery-admission.js')
const { recoverSourceRequestWorkflow } = await import('../src/modules/script/source-request-recovery-workflow.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceRepairRequestCheckpoint } = await import('../src/modules/script/source-repair-request-identity.js')
const { createScriptRequestUsage } = await import('../src/infrastructure/providers/text-request-usage.js')
const { modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
initDb(); initSourceModelRecovery()
assert.ok(db.name.startsWith(directory), 'workflow tests must never use business data')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Analysis = ScriptSourceAnalysis & { budget_steps: Record<string, unknown> }
function fixture() {
  const projectId = newId(), stamp = now()
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: projectId, filename: 'local-only.txt',
    content: '旧钟无人修复，归来的旅人停在钟楼前。', updated_at: stamp }
  const state: Analysis = { id: newId(), source_version: 'fixture-source', model_id: 'fixture-model', configuration_hash: 'fixture-configuration',
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, error: 'legacy orphan', updated_at: stamp,
    sections: [{ offset: 0, length: document.content.length, title: '钟楼', episode_number: 1, summary: document.content, characters: [], events: [] }],
    story: { summary: document.content, characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: document.content, section_ids: [0] } },
    budget_steps: { [modelWorkflowBudgetKey]: { version: 1, kind: 'source_analysis', grants: 1,
      allowance: { max_requests: 136, max_total_requests: 4186, max_tokens: 10_000_000, max_active_ms: 8_100_000 },
      active_ms: 3_476_170, usage: { ...createScriptRequestUsage(), requests: 64 } } } }
  const current = sourceQualityInputHash(state)
  state.quality = { status: 'issues', input_hash: current, findings: [0, 1].map(i => ({ kind: 'omission', explanation: `待核对项${i}`, unit_ids: [0] })) }
  state.quality_repair = { review_hash: current, findings_hash: hash(state.quality.findings), current_hash: current, completed_findings: 0 }
  state.quality_repair_output = { binding: hash([sourceRepairRequestCheckpoint(document, state, 0), state.model_id, state.configuration_hash]),
    checkpoint: { input_hash: 'd'.repeat(64), initial_started: { input_hash: 'd'.repeat(64) } } }
  state.ordinary_story_dispatch = { run_id: state.id, authorized_at: stamp, binding: 'legacy-grant', protected_task_keys: [],
    quality_workflow: { phase: 'review', review_hash: 'a'.repeat(64), findings_hash: 'b'.repeat(64), finding_index: 4,
      current_hash: current, checkpoint_hash: '', protected_repair_bindings: [], review_input_hash: 'c'.repeat(64) } }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(projectId, 'isolated workflow', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)')
    .run(projectId, document.filename, document.content, stamp)
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(projectId, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(state.id, projectId)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'original','old-unknown','{"old":"keep"}','old-binding',?,'abandon_and_resume',?)`)
    .run(projectId + '-old-action', projectId, 'old-action', state.id, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,'old-scope','old-key',?,'prepared','not_sent',?)`)
    .run(projectId + '-epoch', projectId + '-old-action', projectId, state.id, stamp)
  const runtime = { configuration_hash: state.configuration_hash!, local_active: false }
  const load = () => ({ document, ...runtime, state: JSON.parse((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?')
    .get(projectId) as { snapshot: string }).snapshot) as Analysis })
  const save = (next: Analysis) => db.prepare('UPDATE script_source_analyses SET id=?,status=?,snapshot=?,updated_at=? WHERE project_id=?')
    .run(next.id, next.status, JSON.stringify(next), next.updated_at, projectId)
  const details = () => sourceRequestRecoveryDetails(projectId, load)
  const input = (clientActionId = 'single-action') => { const d = details(); return { analysis_id: d.analysis_id,
    cas_token: d.cas_token, client_action_id: clientActionId, decision: 'reconcile_local' as const } }
  let localCalls = 0
  const deps = { load, revalidate: async (_input: { analysisId: string; sourceUpdatedAt: string }) => {
    localCalls++
    const next = load().state
    next.local_validation = { checked_at: now(), reused_tasks: 0, model_required: false, summary: '旧请求仍未知，未调用模型。' }
    next.updated_at = now(); save(next); return next
  } }
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE project_id=?`).get(projectId) as { n: number }).n
  const epochs = () => db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(projectId)
  const workflow = () => db.prepare('SELECT * FROM source_request_recovery_workflows WHERE project_id=? ORDER BY rowid DESC').get(projectId) as Record<string, string>
  return { projectId, state, document, runtime, load, save, details, input, deps, count, epochs, workflow, localCalls: () => localCalls }
}
const confirmInput = (f: ReturnType<typeof fixture>, first: Awaited<ReturnType<typeof recoverSourceRequestWorkflow>>) => ({
  ...f.input(), risk_confirmation: { scope_token: first.recovery.risk!.scope_token, acknowledged_duplicate_risk: true as const } })

test('one local action reaches one exact risk choice while preserving unknown, cumulative usage, old permits and content', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local recovery must not access a model or network'))
  const f = fixture(), before = f.load().state, epochs = f.epochs(), input = f.input()
  const first = await recoverSourceRequestWorkflow(f.projectId, input, f.deps)
  assert.equal(first.recovery.outcome, 'risk_required'); assert.equal(first.recovery.phase, 'awaiting_risk')
  assert.equal(first.recovery.model_requests_started, false)
  assert.deepEqual(first.recovery.risk!.scope, { kind: 'quality_repair_and_recheck', repair_count: 2, review_count: 1,
    max_format_corrections_per_step: 1, max_model_requests: 6 })
  const after = f.load().state
  assert.equal(after.id, before.id); assert.deepEqual(after.quality_repair_output, before.quality_repair_output)
  assert.deepEqual(after.budget_steps, before.budget_steps); assert.deepEqual(after.sections, before.sections); assert.deepEqual(after.story, before.story)
  assert.deepEqual(f.epochs(), epochs); assert.equal(f.count('source_model_runs'), 1)
  assert.equal(f.count('source_request_local_recoveries'), 1); assert.equal(f.count('source_request_recovery_workflows'), 1)
  assert.equal(f.workflow().phase, 'awaiting_risk'); assert.deepEqual(JSON.parse(f.workflow().before_snapshot), before)
  const repeated = await recoverSourceRequestWorkflow(f.projectId, input, f.deps)
  assert.equal(repeated.action_id, first.action_id); assert.equal(repeated.reused, true); assert.equal(f.localCalls(), 1)
  const changes = db.prepare('SELECT total_changes() n').get(), details = f.details()
  assert.equal(details.recovery_workflow!.client_action_id, input.client_action_id)
  assert.deepEqual(details.recovery_workflow!.recovery, first.recovery)
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes, 'GET summary must not persist')
})

test('only exact future risk confirmation creates one independently bounded successor and repeated confirmation cannot queue twice', async () => {
  const f = fixture(), before = f.load().state, epochs = f.epochs()
  const first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps), confirmation = confirmInput(f, first)
  const queued = await recoverSourceRequestWorkflow(f.projectId, confirmation, f.deps)
  assert.equal(queued.recovery.outcome, 'running'); assert.equal(queued.recovery.phase, 'queued')
  assert.equal(queued.recovery.model_requests_started, false); assert.notEqual(queued.analysis.id, before.id)
  assert.deepEqual(queued.analysis.budget_steps, before.budget_steps); assert.deepEqual(queued.analysis.sections, before.sections)
  assert.deepEqual(queued.analysis.story, before.story); assert.deepEqual(f.epochs(), epochs)
  assert.equal(queued.analysis.controlled_recovery!.scope.max_requests, 6)
  assert.deepEqual(queued.analysis.controlled_recovery_archive![0]!.output, before.quality_repair_output)
  assert.equal(queued.analysis.quality_repair_output, undefined)
  assert.equal(f.count('source_model_runs'), 2); assert.equal(f.count('source_request_recovery_workflows'), 1)
  assert.ok(JSON.parse(f.workflow().authorization_snapshot).acknowledged_duplicate_risk)
  const repeated = await recoverSourceRequestWorkflow(f.projectId, confirmation, f.deps)
  assert.equal(repeated.analysis.id, queued.analysis.id); assert.equal(repeated.reused, true)
  assert.equal(f.count('source_model_runs'), 2); assert.equal(f.localCalls(), 1)
  const changes = db.prepare('SELECT total_changes() n').get(), details = f.details()
  assert.equal(details.recovery_workflow!.analysis_id, details.analysis_id)
  assert.equal(details.recovery_workflow!.recovery.outcome, 'running')
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes)
})

test('same-action concurrent requests coalesce their local replay and never authorize a model', async () => {
  const f = fixture(), input = f.input()
  const [a, b] = await Promise.all([recoverSourceRequestWorkflow(f.projectId, input, f.deps), recoverSourceRequestWorkflow(f.projectId, input, f.deps)])
  assert.equal(a.action_id, b.action_id); assert.equal(f.localCalls(), 1); assert.equal(b.reused, true)
  assert.equal(f.count('source_model_runs'), 1); assert.equal(f.workflow().authorization_id, null)
})

test('an immutable older local audit nonce continues into local validation and risk choice instead of swallowing the action', async () => {
  const f = fixture(), input = f.input('legacy-audit')
  reconcileSourceRequestRecovery(f.projectId, input, f.deps.load)
  const audit = db.prepare('SELECT * FROM source_request_local_recoveries WHERE project_id=?').get(f.projectId)
  const result = await recoverSourceRequestWorkflow(f.projectId, f.input('legacy-audit'), f.deps)
  assert.equal(result.recovery.outcome, 'risk_required'); assert.equal(f.localCalls(), 1)
  assert.deepEqual(db.prepare('SELECT * FROM source_request_local_recoveries WHERE project_id=?').get(f.projectId), audit)
  assert.equal(f.count('source_request_local_recoveries'), 1)
})

test('scope, CAS, source, configuration and late-old-request drift all reject confirmation without a successor', async () => {
  for (const drift of ['scope', 'cas', 'source', 'config', 'late', 'snapshot']) {
    const f = fixture(), first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps), input = confirmInput(f, first)
    if (drift === 'scope') input.risk_confirmation.scope_token = 'e'.repeat(64)
    if (drift === 'cas') input.cas_token = 'e'.repeat(64)
    if (drift === 'source') f.document.content += '已变化'
    if (drift === 'config') f.runtime.configuration_hash = 'changed'
    if (drift === 'late') db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at)
      VALUES (?,'late','old',?,'dispatched','unknown',NULL,?)`).run(f.projectId, f.state.id, now())
    if (drift === 'snapshot') { const changed = f.load().state; changed.error = 'new analysis fact'; f.save(changed) }
    await assert.rejects(recoverSourceRequestWorkflow(f.projectId, input, f.deps), undefined, drift)
    assert.equal(f.count('source_model_runs'), 1, drift); assert.equal(f.workflow().authorization_id, null, drift)
    assert.equal(f.load().state.id, f.state.id, drift)
  }
})

test('risk transaction failure rolls back the authorization, independent run and analysis as a unit', async () => {
  const f = fixture(), first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps), input = confirmInput(f, first)
  const before = f.load().state, workflow = f.workflow(), epochs = f.epochs()
  db.exec(`CREATE TRIGGER reject_controlled_recovery BEFORE UPDATE ON script_source_analyses WHEN OLD.project_id='${f.projectId}' BEGIN SELECT RAISE(ABORT,'fixture risk failure'); END`)
  try { await assert.rejects(recoverSourceRequestWorkflow(f.projectId, input, f.deps), /fixture risk failure/) }
  finally { db.exec('DROP TRIGGER reject_controlled_recovery') }
  assert.deepEqual(f.load().state, before); assert.deepEqual(f.workflow(), workflow); assert.deepEqual(f.epochs(), epochs)
  assert.equal(f.count('source_model_runs'), 1)
  assert.equal((await recoverSourceRequestWorkflow(f.projectId, input, f.deps)).recovery.phase, 'queued')
})

test('persisted local phase resumes locally, and a complete saved result finishes one action without a risk or model', async () => {
  const f = fixture(), input = f.input()
  const first = await recoverSourceRequestWorkflow(f.projectId, input, f.deps)
  db.prepare("UPDATE source_request_recovery_workflows SET phase='local_replay',scope=NULL,scope_token=NULL,result=NULL WHERE id=?").run(first.action_id)
  const resumed = await recoverSourceRequestWorkflow(f.projectId, input, f.deps)
  assert.equal(resumed.recovery.outcome, 'risk_required'); assert.equal(f.localCalls(), 2); assert.equal(f.count('source_model_runs'), 1)
  const g = fixture(), deps = { ...g.deps, revalidate: async () => {
    const next = g.load().state
    next.status = 'ready'; next.quality = { status: 'passed', input_hash: sourceQualityInputHash(next), findings: [] }
    g.save(next); return next
  } }
  const complete = await recoverSourceRequestWorkflow(g.projectId, g.input(), deps)
  assert.equal(complete.recovery.outcome, 'completed'); assert.equal(complete.recovery.risk, undefined)
  assert.equal(g.count('source_model_runs'), 1); assert.equal(g.workflow().authorization_id, null)
})

test('the local action cannot renew a depleted cumulative grant just to offer a risk choice', async () => {
  const f = fixture(), next = f.load().state
  ;(next.budget_steps[modelWorkflowBudgetKey] as { active_ms: number }).active_ms = 8_100_001
  f.save(next)
  const result = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps)
  assert.equal(result.recovery.outcome, 'stopped'); assert.equal(result.recovery.risk, undefined)
  assert.equal(f.count('source_model_runs'), 1)
  assert.deepEqual(f.load().state.budget_steps, next.budget_steps)
})

test('a fresh explicit action retires only a stale unconfirmed choice and actually reruns local recovery', async () => {
  const f = fixture(), first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps)
  const changed = f.load().state; changed.error = 'late local fact'; f.save(changed)
  const view = f.details(), total = db.prepare('SELECT total_changes() n').get()
  assert.equal(view.recovery_workflow!.recovery.outcome, 'stopped')
  assert.equal(view.recovery_workflow!.recovery.risk, undefined)
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), total)
  const restarted = await recoverSourceRequestWorkflow(f.projectId, f.input('new-local-action'), f.deps)
  assert.equal(restarted.recovery.outcome, 'risk_required'); assert.notEqual(restarted.action_id, first.action_id)
  assert.equal(f.localCalls(), 2); assert.equal(f.count('source_model_runs'), 1)
  assert.equal((db.prepare('SELECT phase FROM source_request_recovery_workflows WHERE id=?').get(first.action_id) as { phase: string }).phase, 'stopped')
  assert.equal(f.count('source_request_local_recoveries'), 2)
})

test('queued GET derives terminal status without a write, and a stale persisted terminal cannot hide new local bytes', async () => {
  const f = fixture(), first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps)
  const queued = await recoverSourceRequestWorkflow(f.projectId, confirmInput(f, first), f.deps)
  const stopped = f.load().state; stopped.status = 'failed'; stopped.error = 'new disconnect'; f.save(stopped)
  const changes = db.prepare('SELECT total_changes() n').get(), details = f.details()
  assert.equal(details.recovery_workflow!.analysis_id, queued.analysis.id)
  assert.equal(details.recovery_workflow!.recovery.outcome, 'stopped')
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes)
  const sameInput = { ...f.input(), analysis_id: first.analysis.id }
  assert.equal((await recoverSourceRequestWorkflow(f.projectId, sameInput, f.deps)).recovery.outcome, 'stopped')
  const nowSaved = f.load().state; nowSaved.error = 'fresh locally saved answer'; f.save(nowSaved)
  assert.equal(f.details().recovery_workflow, undefined, 'old terminal summary is no longer a summary of the current snapshot')
})

test('an existing single ledger blocker retains one explicit formal recovery choice without budget renewal or preconfirmation queueing', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('unconfirmed existing-request recovery must not access any model'))
  const f = fixture()
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at)
    VALUES (?,'current-native-scope','current-key',?,'dispatched','unknown',NULL,?)`).run(f.projectId, f.state.id, now())
  const native = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(f.projectId)
  const first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps)
  assert.equal(first.recovery.outcome, 'risk_required'); assert.equal(first.recovery.risk, undefined)
  const legacy = first.recovery.legacy_resume!
  assert.equal(legacy.max_model_requests, 72); assert.equal(legacy.workflow_id, first.action_id)
  assert.equal(f.count('source_model_runs'), 1); assert.equal(f.workflow().authorization_id, null)
  const beforeBudget = structuredClone(f.load().state.budget_steps)
  const input = { analysis_id: legacy.analysis_id, cas_token: legacy.cas_token, client_action_id: legacy.client_action_id,
    decision: 'abandon_and_resume' as const, acknowledged_duplicate_risk: true as const, workflow_id: legacy.workflow_id }
  const queued = admitSourceRequestRecovery(f.projectId, input, f.load, { preserveBudget: true })
  assert.notEqual(queued.analysis.id, f.state.id); assert.equal(queued.analysis.status, 'queued')
  assert.deepEqual(queued.analysis.budget_steps, beforeBudget)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(f.projectId), native)
  assert.equal(f.workflow().phase, 'queued'); assert.equal(f.workflow().target_run_id, queued.analysis.id)
  assert.equal(f.count('source_model_runs'), 2)
  assert.equal(admitSourceRequestRecovery(f.projectId, input, f.load, { preserveBudget: true }).reused, true)
  assert.equal(f.count('source_model_runs'), 2)
})

test('the formal nonrenewing single-ledger path rejects depleted budget before any new permit or run', () => {
  const f = fixture(), state = f.load().state
  ;(state.budget_steps[modelWorkflowBudgetKey] as { active_ms: number }).active_ms = 8_100_001; f.save(state)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at)
    VALUES (?,'native','unknown',?,'dispatched','unknown',NULL,?)`).run(f.projectId, f.state.id, now())
  const details = f.details(), before = f.load().state
  const input = { analysis_id: details.analysis_id, cas_token: details.cas_token, client_action_id: 'no-renew',
    decision: 'abandon_and_resume' as const, acknowledged_duplicate_risk: true as const }
  assert.throws(() => admitSourceRequestRecovery(f.projectId, input, f.load, { preserveBudget: true }), /不会自动增加额度/)
  assert.deepEqual(f.load().state, before); assert.equal(f.count('source_model_runs'), 1)
  assert.equal(f.count('source_request_recovery_actions'), 1, 'only the unchanged old permit remains')
})

test('a spent controlled scope is never offered or transferred as an ordinary ledger recovery', async () => {
  const f = fixture(), first = await recoverSourceRequestWorkflow(f.projectId, f.input(), f.deps)
  const queued = await recoverSourceRequestWorkflow(f.projectId, confirmInput(f, first), f.deps)
  const state = f.load().state
  state.status = 'failed'; state.error = 'controlled disconnect'; state.controlled_recovery!.closed_at = now()
  f.save(state)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at)
    VALUES (?,'controlled','exact',?,'dispatched','unknown',NULL,?)`).run(f.projectId, queued.analysis.id, now())
  const details = f.details()
  assert.throws(() => admitSourceRequestRecovery(f.projectId, { analysis_id: details.analysis_id, cas_token: details.cas_token,
    client_action_id: 'no-control-transfer', decision: 'abandon_and_resume', acknowledged_duplicate_risk: true }, f.load, { preserveBudget: true }), /专属授权不能转移/)
  const local = await recoverSourceRequestWorkflow(f.projectId, f.input('new-controlled-local'), f.deps)
  assert.equal(local.recovery.outcome, 'stopped'); assert.equal(local.recovery.legacy_resume, undefined)
  assert.match(local.recovery.message, /本次有界恢复授权已停止/)
  assert.equal(f.count('source_model_runs'), 2); assert.deepEqual(f.load().state.controlled_recovery, state.controlled_recovery)
})


test('extraction local recovery cannot revive historical semantic repair or review authority', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no provider or tracing calls'))
  const f = fixture(), state = f.load().state
  state.analysis_mode = 'extract'; state.story = undefined
  f.save(state)
  const before = f.load().state, epochs = f.epochs()
  const value = await recoverSourceRequestWorkflow(f.projectId, f.input('extract-only'), f.deps)
  assert.equal(value.recovery.outcome, 'stopped')
  assert.equal(value.recovery.risk, undefined)
  assert.equal(value.recovery.legacy_resume, undefined)
  assert.equal(value.recovery.model_requests_started, false)
  assert.equal(f.count('source_model_runs'), 1)
  assert.deepEqual(f.epochs(), epochs)
  assert.deepEqual(f.load().state.budget_steps, before.budget_steps)
  assert.deepEqual(f.load().state.quality, before.quality)
})

test('extraction recovery completes after local reuse without requiring a quality approval', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no provider or tracing calls'))
  const f = fixture(), state = f.load().state
  state.analysis_mode = 'extract'; delete state.quality; delete state.quality_repair; delete state.quality_repair_output
  f.save(state)
  const value = await recoverSourceRequestWorkflow(f.projectId, f.input('extract-complete'), {
    load: f.load, revalidate: async () => { const next = f.load().state; next.status = 'ready'; f.save(next); return next },
  })
  assert.equal(value.recovery.outcome, 'completed')
  assert.equal(value.recovery.model_requests_started, false)
  assert.equal(value.analysis.quality, undefined)
  assert.equal(f.count('source_model_runs'), 1)
})


test('extraction preparation cannot offer an old quality scope even before the extract marker existed', async () => {
  const f = fixture()
  const value = await recoverSourceRequestWorkflow(f.projectId, f.input('legacy-prepare'), { ...f.deps, extractionOnly: true })
  assert.equal(value.recovery.outcome, 'stopped')
  assert.equal(value.recovery.risk, undefined)
  assert.equal(value.recovery.legacy_resume, undefined)
  assert.equal(value.recovery.model_requests_started, false)
  assert.equal(f.count('source_model_runs'), 1)
})
