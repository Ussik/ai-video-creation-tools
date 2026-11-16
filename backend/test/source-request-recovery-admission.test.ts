import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-explicit-source-admission-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb } = await import('../src/infrastructure/database/db.js')
const { initSourceModelRecovery, sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { initSourceRequestRecovery } = await import('../src/modules/script/source-request-recovery.js')
const { sourceRequestRecoveryDetails, admitSourceRequestRecovery, reconcileSourceRequestRecovery, sourceRequestRecoveryBinding, assertSourceRequestRecoveryBinding } = await import('../src/modules/script/source-request-recovery-admission.js')
const { initSourceModelAdmission, recordSourceModelAdmission } = await import('../src/modules/script/source-model-admission.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { sourceFeedbackContext, validateSourceFeedbackChecks, saveSourceFeedbackReviewProof, hasSourceFeedbackReviewProof } = await import('../src/modules/script/script-source-feedback-review.js')
const { createScriptRequestUsage } = await import('../src/infrastructure/providers/text-request-usage.js')
const { explicitModelWorkflowBudgetResume, modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
initDb(); initSourceModelRecovery(); initSourceRequestRecovery(); initSourceModelAdmission()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
type State = ScriptSourceAnalysis & { budget_steps: Record<string, unknown> }
let counter = 0
function fixture() {
  const id = `admission-${++counter}`, stamp = '2026-11-14T00:00:00.000Z'
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, 'script.txt', '原稿不能改写', stamp)
  const budget = { version: 1, kind: 'source_analysis', grants: 1, exhausted: 'duration', active_ms: 60_001,
    allowance: { max_requests: 3, max_total_requests: 20, max_tokens: 1000, max_active_ms: 60_000 }, usage: createScriptRequestUsage() }
  budget.usage.requests = 2; budget.usage.input_tokens = 300
  const state = { id: `run-${id}`, source_version: 'source-v1', model_id: 'model1', configuration_hash: 'cfg', status: 'failed',
    sections: [{ title: '已保存目录', summary: '不能清空' }], story: { summary: '已保存全剧' }, completed_chunks: 1, total_chunks: 1,
    updated_at: stamp, error: 'duration', review_feedback: { id: 'feedback', text: '待核实意见' },
    budget_steps: { [modelWorkflowBudgetKey]: budget } } as unknown as State
  const document = { project_id: id, filename: 'script.txt', content: '原稿不能改写', updated_at: stamp } as Omit<ScriptSourceDocument, 'analysis'>
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(state.id, id)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at,response_key)
    VALUES (?,?,'key',?,'dispatched','unknown',NULL,?,NULL)`).run(id, `scope-${id}`, state.id, stamp)
  const context = { document, state, configuration_hash: 'cfg', local_active: false }
  const load = () => ({ ...context, state: JSON.parse((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(id) as { snapshot: string }).snapshot) as State })
  const oldRow = () => db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(id)
  const details = () => sourceRequestRecoveryDetails(id, load)
  const input = () => { const d = details(); return { analysis_id: d.analysis_id, cas_token: d.cas_token, client_action_id: 'action1', decision: 'abandon_and_resume' as const, acknowledged_duplicate_risk: true as const } }
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=?`).get(id) as { n: number }).n
  return { id, context, load, oldRow, details, input, count }
}
test('GET remains readonly and never fabricates identity for the exact legacy blocker', () => {
  const f = fixture(), changes = db.prepare('SELECT total_changes() AS n').get()
  const a = f.details(), b = f.details()
  assert.deepEqual(a, b); assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes)
  assert.equal(a.blockers.length, 1); assert.equal(a.blockers[0]!.identity_binding, 'unbound')
  assert.equal(a.blockers[0]!.local_request_id, null); assert.equal(a.blockers[0]!.upstream_request_id, null)
  assert.equal(a.budget.can_resume, true); assert.equal(f.count('source_request_recovery_actions'), 0)
})
test('explicit continuation persists one successor, preserves old bytes and all cumulative usage, and survives reconstruction', () => {
  const f = fixture(), input = f.input(), old = f.oldRow(), before = f.load().state
  const a = admitSourceRequestRecovery(f.id, input, f.load), b = admitSourceRequestRecovery(f.id, input, f.load)
  assert.equal(a.action_id, b.action_id); assert.equal(a.analysis.id, b.analysis.id); assert.equal(b.reused, true)
  assert.deepEqual(f.oldRow(), old); assert.deepEqual(a.analysis.sections, before.sections); assert.deepEqual(a.analysis.story, before.story)
  assert.deepEqual(a.analysis.review_feedback, before.review_feedback)
  const budget = a.analysis.budget_steps![modelWorkflowBudgetKey] as typeof before.budget_steps[typeof modelWorkflowBudgetKey] & { grants: number; active_ms: number; usage: unknown }
  assert.equal(budget.grants, 2); assert.equal(budget.active_ms, 60_001)
  assert.deepEqual(budget.usage, (before.budget_steps[modelWorkflowBudgetKey] as { usage: unknown }).usage)
  assert.deepEqual(f.load().state, a.analysis); assert.equal(f.count('source_request_recovery_actions'), 1); assert.equal(f.count('source_request_recovery_epochs'), 1)
  const another = { ...input, client_action_id: 'double-click-new-id' }
  assert.throws(() => admitSourceRequestRecovery(f.id, another, f.load), /已变化/)
  assert.equal(f.count('source_request_recovery_actions'), 1)
})
test('source/config/analysis/feedback/budget/unknown drift rejects stale CAS without decisions', () => {
  for (const drift of ['source', 'config', 'feedback', 'budget', 'unknown', 'active']) {
    const f = fixture(), input = f.input()
    if (drift === 'source') f.context.document.content += '变化'
    if (drift === 'config') f.context.configuration_hash = 'changed'
    if (drift === 'active') f.context.local_active = true
    if (drift === 'unknown') db.prepare("UPDATE source_model_requests SET updated_at='2026-11-14T00:00:01.000Z' WHERE project_id=?").run(f.id)
    if (drift === 'feedback' || drift === 'budget') {
      const s = f.load().state
      if (drift === 'feedback') s.review_feedback!.text += '变化'
      else (s.budget_steps[modelWorkflowBudgetKey] as { active_ms: number }).active_ms++
      db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(s), f.id)
    }
    assert.throws(() => admitSourceRequestRecovery(f.id, input, f.load), undefined, drift)
    assert.equal(f.count('source_request_recovery_actions'), 0, drift)
  }
})
test('max grants or invalid ledger never creates a permit or clears usage', () => {
  for (const invalid of [false, true]) {
    const f = fixture(), s = f.load().state
    if (invalid) delete s.budget_steps[modelWorkflowBudgetKey]
    else (s.budget_steps[modelWorkflowBudgetKey] as { grants: number }).grants = 3
    db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(s), f.id)
    const before = f.load().state
    assert.equal(f.details().budget.can_resume, false)
    assert.throws(() => admitSourceRequestRecovery(f.id, f.input(), f.load))
    assert.deepEqual(f.load().state, before); assert.equal(f.count('source_request_recovery_actions'), 0)
  }
})
test('transaction failure rolls back audit, epoch, successor and budget grant together', () => {
  const f = fixture(), input = f.input(), before = f.load().state, old = f.oldRow()
  db.exec(`CREATE TRIGGER reject_recovery_queue BEFORE UPDATE ON script_source_analyses WHEN OLD.project_id='${f.id}' BEGIN SELECT RAISE(ABORT,'fixture queue failure'); END`)
  try { assert.throws(() => admitSourceRequestRecovery(f.id, input, f.load), /queue failure/) }
  finally { db.exec('DROP TRIGGER reject_recovery_queue') }
  assert.deepEqual(f.load().state, before); assert.deepEqual(f.oldRow(), old)
  assert.equal(f.count('source_request_recovery_actions'), 0); assert.equal(f.count('source_request_recovery_epochs'), 0)
  const a = admitSourceRequestRecovery(f.id, input, f.load); assert.equal(a.reused, false)
})
test('nonexhausted budget does not add a grant and pure helper cannot mutate caller ledger', () => {
  const f = fixture(), s = f.load().state, budget = s.budget_steps[modelWorkflowBudgetKey] as Record<string, unknown>
  delete budget.exhausted; budget.active_ms = 1000
  const before = structuredClone(budget), result = explicitModelWorkflowBudgetResume(budget, 'source_analysis')
  assert.equal(result.grants, 1); assert.deepEqual(budget, before)
  result.usage.input_tokens++
  assert.deepEqual(budget, before)
})

test('an already consumed request limit adds only one bounded grant even before exhausted was recorded', () => {
  const f = fixture(), s = f.load().state, budget = s.budget_steps[modelWorkflowBudgetKey] as { exhausted?: string; active_ms: number; usage: { requests: number }; grants: number }
  delete budget.exhausted; budget.active_ms = 1000; budget.usage.requests = 3
  const before = structuredClone(budget), result = explicitModelWorkflowBudgetResume(budget, 'source_analysis')
  assert.equal(result.grants, 2); assert.deepEqual(result.usage, before.usage); assert.deepEqual(budget, before)
  budget.grants = 3; budget.usage.requests = 9
  assert.throws(() => explicitModelWorkflowBudgetResume(budget, 'source_analysis'), /累计额度已用尽/)
})

async function feedbackRecoveryFixture() {
  const f = fixture(), current = f.load().state
  current.review_feedback = { id: 'human-feedback', text: '待核实意见', source_version: current.source_version,
    source_updated_at: f.context.document.updated_at, model_id: current.model_id, configuration_hash: f.context.configuration_hash }
  const save = (state: State) => db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(state), f.id)
  save(current)
  // Use a real exact request identity so the admitted permit and later
  // ordinary dispatch exercise the production recovery ledger as well.
  db.prepare('DELETE FROM source_model_requests WHERE project_id=?').run(f.id)
  const identity = { source: current.source_version, model: current.model_id, configuration: f.context.configuration_hash }
  const args = (prompt = 'same exact request') => [f.id, current.model_id, prompt, undefined, new AbortController().signal] as const
  await assert.rejects(sourceModelRecovery(f.id, current.id, identity, async () => {
    notifyTextRequest('dispatch', { request_id: 'feedback-original-' + f.id }); throw new Error('fixture unknown')
  })(...args()), /fixture unknown/)
  const old = f.oldRow() as { scope: string; request_key: string }
  const original = () => db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(f.id, old.scope, old.request_key)
  const frozen = JSON.stringify(original())
  const proof = (state: State, inputHash: string, reason = '原稿与已保存分析支持核对结论。') => {
    const context = sourceFeedbackContext(state)!
    const checks = [{ item_id: context.items[0]!.id, disposition: 'not_supported' as const, reason, finding_indices: [],
      source_refs: [{ unit_id: 0, quote: f.context.document.content }], analysis_refs: [{ path: 'story.summary', quote: state.story!.summary }] }]
    validateSourceFeedbackChecks(checks, context, state, [{ id: 0, text: f.context.document.content }], [], true)
    saveSourceFeedbackReviewProof(state, context, inputHash, checks)
    assert.equal(hasSourceFeedbackReviewProof(state, inputHash), true)
    save(state)
  }
  return { ...f, oldRow: original, save, identity, args, proof, frozen }
}

test('valid private proof additions and replacements preserve one admitted identity and allow the next dispatch', async () => {
  for (const initiallyProved of [false, true]) {
    const f = await feedbackRecoveryFixture()
    if (initiallyProved) f.proof(f.load().state, 'a'.repeat(64))
    const admitted = admitSourceRequestRecovery(f.id, f.input(), f.load), binding = sourceRequestRecoveryBinding(f.load())
    const action = () => JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_actions WHERE id=?').get(admitted.action_id))
    const audit = action(); let posts = 0
    const dispatch = async (prompt: string) => {
      assertSourceRequestRecoveryBinding(f.id, f.load())
      return sourceModelRecovery(f.id, admitted.analysis.id, f.identity, async () => {
        notifyTextRequest('dispatch', { request_id: `feedback-proof-${f.id}-${++posts}` }); return 'complete result'
      })(...f.args(prompt))
    }
    f.proof(f.load().state, 'b'.repeat(64), '合法复核生成了新的处置证据。')
    assert.equal(sourceRequestRecoveryBinding(f.load()), binding)
    assert.equal(await dispatch('same exact request'), 'complete result')
    // A new independent review updates proof and then schedules ordinary work
    // under the same action/run. The original unknown row remains frozen.
    f.proof(f.load().state, 'c'.repeat(64), '后续复核更新了输入摘要与处置证据。')
    assert.equal(sourceRequestRecoveryBinding(f.load()), binding)
    assert.equal(await dispatch('next ordinary request'), 'complete result')
    assert.equal(posts, 2); assert.equal(f.oldRow() && JSON.stringify(f.oldRow()), f.frozen)
    assert.equal(action(), audit)
  }
})

test('each human feedback identity field still rejects changes and preserves the unused permit and old unknown', async () => {
  for (const field of ['id', 'text', 'source_version', 'source_updated_at', 'model_id', 'configuration_hash'] as const) {
    const f = await feedbackRecoveryFixture(); f.proof(f.load().state, 'a'.repeat(64))
    const admitted = admitSourceRequestRecovery(f.id, f.input(), f.load), state = f.load().state
    const audit = JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_actions WHERE id=?').get(admitted.action_id))
    state.review_feedback![field] += '-changed'; f.save(state)
    assert.throws(() => assertSourceRequestRecoveryBinding(f.id, f.load()), /原稿、反馈、模型或配置已变化/, field)
    assert.equal(JSON.stringify(f.oldRow()), f.frozen)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_actions WHERE id=?').get(admitted.action_id)), audit)
    assert.deepEqual(db.prepare('SELECT state,consumed_at FROM source_request_recovery_epochs WHERE action_id=?').get(admitted.action_id),
      { state: 'prepared', consumed_at: null })
  }
})

test('proof-only state updates still invalidate a stale admission CAS before any decision is saved', async () => {
  const f = await feedbackRecoveryFixture(), input = f.input(), binding = sourceRequestRecoveryBinding(f.load())
  f.proof(f.load().state, 'a'.repeat(64))
  assert.equal(sourceRequestRecoveryBinding(f.load()), binding)
  assert.throws(() => admitSourceRequestRecovery(f.id, input, f.load), /上次展示的请求或分析状态已变化/)
  assert.equal(f.count('source_request_recovery_actions'), 0); assert.equal(f.count('source_request_recovery_epochs'), 0)
  assert.equal(JSON.stringify(f.oldRow()), f.frozen)
})

function localFixture(kind: 'unknown' | 'saved' | 'trusted') {
  const f = fixture(), state = f.load().state, inputHash = 'd'.repeat(64), intentId = 'exact-local-attempt-' + f.id
  db.prepare("UPDATE source_model_requests SET state='completed',delivery='completed',result='historical-complete' WHERE project_id=?").run(f.id)
  state.quality = { status: 'issues', input_hash: 'review', findings: [{ kind: 'omission', explanation: '核对保存事实。', unit_ids: [0] }] }
  state.quality_repair_output = { binding: 'current-output-binding', checkpoint: { input_hash: inputHash,
    ...(kind === 'saved' ? { raw: '完整原回答' } : { initial_started: { input_hash: inputHash, ...(kind === 'trusted' ? { intent_id: intentId } : {}) } }) } }
  db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(state), f.id)
  if (kind === 'trusted') recordSourceModelAdmission(f.id, state.id, 'explicit-denial-scope', 'explicit-denial-key',
    { intent_id: intentId, input_hash: inputHash, initial_input_hash: inputHash, phase: 'initial' }, 'denied', 'source_admission_gate')
  const input = () => { const d = f.details(); return { analysis_id: d.analysis_id, cas_token: d.cas_token,
    client_action_id: 'local-action', decision: 'reconcile_local' as const } }
  return { ...f, localInput: input }
}

test('empty blockers with an old unknown marker remain an explicit conflict; local reconciliation only appends immutable audit', () => {
  const f = localFixture('unknown'), before = f.load().state, request = f.oldRow(), changes = db.prepare('SELECT total_changes() n').get()
  const details = f.details()
  assert.equal(details.blockers.length, 0); assert.equal(details.reconciliation.status, 'inconsistent')
  assert.equal(details.reconciliation.next, 'inspect_conflict')
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes, 'GET is strictly read-only')
  const input = f.localInput(), result = reconcileSourceRequestRecovery(f.id, input, f.load)
  assert.equal(result.local_revalidate, false); assert.equal(result.reconciliation.next, 'inspect_conflict')
  assert.deepEqual(f.load().state, before); assert.deepEqual(f.oldRow(), request)
  assert.equal(f.count('source_request_local_recoveries'), 1)
  assert.equal(f.count('source_request_recovery_epochs'), 0)
  const duplicate = reconcileSourceRequestRecovery(f.id, input, f.load)
  assert.equal(duplicate.action_id, result.action_id); assert.equal(duplicate.reused, true)
  assert.equal(f.count('source_request_local_recoveries'), 1)
  assert.throws(() => reconcileSourceRequestRecovery(f.id, { ...input, cas_token: 'e'.repeat(64) }, f.load), /已变化/)
})

test('complete local bytes are reusable without a budget grant, run or recovery epoch and an idempotent retry never revalidates twice', () => {
  const f = localFixture('saved'), before = f.load().state, runs = f.count('source_model_runs')
  const input = f.localInput(), result = reconcileSourceRequestRecovery(f.id, input, f.load)
  assert.equal(result.local_revalidate, true); assert.equal(result.reconciliation.next, 'local_revalidate')
  assert.deepEqual(f.load().state, before)
  assert.equal(f.count('source_model_runs'), runs); assert.equal(f.count('source_request_recovery_epochs'), 0)
  assert.equal(reconcileSourceRequestRecovery(f.id, input, f.load).local_revalidate, false)
})

test('only an exact trusted denial corrects a stale started marker and the full original remains in its audit', () => {
  const f = localFixture('trusted'), before = f.load().state, request = f.oldRow(), input = f.localInput()
  assert.equal(f.details().reconciliation.status, 'trusted_not_sent')
  const result = reconcileSourceRequestRecovery(f.id, input, f.load)
  assert.equal(result.reconciliation.status, 'no_pending_request'); assert.equal(result.reconciliation.next, 'explicit_continue')
  assert.equal(f.load().state.quality_repair_output!.checkpoint.initial_started, undefined)
  const audit = db.prepare('SELECT before_snapshot,after_snapshot,facts FROM source_request_local_recoveries WHERE project_id=?').get(f.id) as Record<string, string>
  assert.deepEqual(JSON.parse(audit.before_snapshot), before)
  assert.ok(JSON.parse(audit.facts).admission.evidence.evidence_hash)
  assert.deepEqual(f.oldRow(), request); assert.equal(f.count('source_request_recovery_epochs'), 0)
  assert.deepEqual(f.load().state.budget_steps, before.budget_steps, 'local recovery cannot renew the paid model budget')
})

test('exact dispatched or native accepted facts remain remote-pending even when the generic blocker list is empty; completed counts do not fabricate local bytes', () => {
  for (const outcome of ['dispatched', 'accepted', 'completed'] as const) {
    const f = localFixture('trusted'), state = f.load().state, marker = state.quality_repair_output!.checkpoint.initial_started!
    const scope = 'explicit-denial-scope', key = 'explicit-denial-key'
    if (outcome !== 'dispatched') db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at,response_key) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(f.id, scope, key, state.id, outcome === 'completed' ? 'completed' : 'dispatched', outcome,
        outcome === 'completed' ? 'exact ledger bytes need contract replay' : null, state.updated_at, outcome === 'accepted' ? 'native-key' : null)
    if (outcome === 'accepted') db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)')
      .run(f.id, scope, 'native-key', JSON.stringify({ state: 'accepted', id: 'resp_exact_recovery' }))
    recordSourceModelAdmission(f.id, state.id, scope, key, { intent_id: marker.intent_id!, input_hash: marker.input_hash,
      initial_input_hash: state.quality_repair_output!.checkpoint.input_hash!, phase: 'initial' }, 'dispatched')
    const before = f.load().state, details = f.details()
    assert.equal(details.blockers.length, 0, outcome)
    assert.equal(details.reconciliation.status, outcome === 'completed' ? 'inconsistent' : 'unknown_response', outcome)
    assert.equal(details.reconciliation.next, outcome === 'completed' ? 'inspect_conflict' : 'provider_reconcile', outcome)
    const result = reconcileSourceRequestRecovery(f.id, f.localInput(), f.load)
    assert.equal(result.local_revalidate, false, outcome)
    assert.deepEqual(f.load().state, before, outcome + ' must not clear an actually sent marker')
  }
})

test('saved local responses and unknown sibling delivery remain independent facts instead of one hiding the other', () => {
  const f = localFixture('unknown'), state = f.load().state
  delete state.story; delete state.quality; delete state.quality_repair_output
  state.story_work = { input_hash: 'current-story', tasks: [
    { key: 'overview', output_candidate: { context_hash: 'older-context-is-not-not-sent-proof',
      checkpoint: { input_hash: 'a'.repeat(64), initial_started: { input_hash: 'a'.repeat(64) } } } },
    { key: 'characters', output_candidate: { context_hash: 'saved-candidate', checkpoint: { input_hash: 'b'.repeat(64), raw: 'complete saved response' } } },
  ] }
  const save = () => db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(state), f.id)
  save()
  const before = f.load().state, facts = f.details().reconciliation
  assert.equal(facts.saved_response, true); assert.equal(facts.checkpoint_unknown, true)
  assert.equal(facts.next, 'local_revalidate'); assert.match(facts.message, /其他任务仍有未确认请求/)
  const result = reconcileSourceRequestRecovery(f.id, f.localInput(), f.load)
  assert.equal(result.reconciliation.checkpoint_unknown, true); assert.deepEqual(f.load().state, before)
  state.story_work.tasks.splice(0, 1)
  state.story_work.tasks[0]!.output_candidate!.checkpoint.correction_started = { input_hash: 'c'.repeat(64) }
  save()
  const sameCheckpoint = f.details().reconciliation
  assert.equal(sameCheckpoint.saved_response, true); assert.equal(sameCheckpoint.checkpoint_unknown, true)
  assert.equal(sameCheckpoint.next, 'inspect_conflict', 'raw initial bytes never erase the same checkpoint unknown correction')
})

test('local recovery rejects source, analysis, config and ledger drift before auditing or changing any marker', () => {
  for (const drift of ['source', 'analysis', 'config', 'ledger', 'active'] as const) {
    const f = localFixture('trusted'), input = f.localInput()
    if (drift === 'source') f.context.document.content += '改'
    if (drift === 'config') f.context.configuration_hash += '改'
    if (drift === 'active') f.context.local_active = true
    if (drift === 'ledger') db.prepare("INSERT INTO source_request_dispatch_links (project_id,scope,request_key,run_id,source_updated_at,local_request_id) VALUES (?,'explicit-denial-scope','explicit-denial-key',?,'now',?)")
      .run(f.id, f.load().state.id, 'late-dispatch-' + f.id)
    if (drift === 'analysis') db.prepare("UPDATE script_source_analyses SET updated_at='changed' WHERE project_id=?").run(f.id)
    const before = f.load().state
    assert.throws(() => reconcileSourceRequestRecovery(f.id, input, f.load), undefined, drift)
    assert.deepEqual(f.load().state, before, drift); assert.equal(f.count('source_request_local_recoveries'), 0, drift)
  }
})

test('local recovery audit and marker correction roll back together if the checkpoint CAS write fails', () => {
  const f = localFixture('trusted'), input = f.localInput(), before = f.load().state
  db.exec(`CREATE TRIGGER reject_local_recovery BEFORE UPDATE ON script_source_analyses WHEN OLD.project_id='${f.id}' BEGIN SELECT RAISE(ABORT,'local checkpoint write failed'); END`)
  try { assert.throws(() => reconcileSourceRequestRecovery(f.id, input, f.load), /checkpoint write failed/) }
  finally { db.exec('DROP TRIGGER reject_local_recovery') }
  assert.deepEqual(f.load().state, before); assert.equal(f.count('source_request_local_recoveries'), 0)
})
