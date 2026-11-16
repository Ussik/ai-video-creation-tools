import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'

const directory = await mkdtemp(join(tmpdir(), 'source-controlled-runtime-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { controlledSourceRecoveryScope, prepareControlledSourceRecovery } = await import('../src/modules/script/source-controlled-runtime.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceRepairRequestCheckpoint, currentInitialSourceRepairRequest, currentDerivedSourceRepairCorrectionRequest } = await import('../src/modules/script/source-repair-request-identity.js')
const { createSourceStoryDispatchGrant } = await import('../src/modules/script/script-source-ordinary-dispatch.js')
const { markSourceModelRun } = await import('../src/modules/script/source-model-recovery.js')
const { beginTextRequest, createScriptRequestUsage } = await import('../src/infrastructure/providers/text-request-usage.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
const { modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
const { sourceRequestRecoveryBinding } = await import('../src/modules/script/source-request-recovery-admission.js')
initDb()
const originalFetch = globalThis.fetch
globalThis.fetch = async () => assert.fail('controlled workflow tests must never access a network provider')
after(async () => { globalThis.fetch = originalFetch; db.close(); await rm(directory, { recursive: true, force: true }) })
const canonicalHash = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const configuration = { fixture: 'controlled' }
const configurationHash = sourceAnalysisConfigurationHash(configuration)
const limits = { reading: 10000, repairing: 10000, synthesis: 10000 }
const stored = (id: string) => {
  const row = db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(id) as { snapshot: string }
  return JSON.parse(row.snapshot) as ScriptSourceAnalysis & { budget_steps: Record<string, any> }
}
async function terminal(id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = stored(id)
    if (['ready', 'paused', 'failed'].includes(state.status)) return state
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('mocked controlled analysis did not terminate: ' + JSON.stringify(stored(id)))
}
async function fixture(sibling = true) {
  const id = newId(), stamp = now(), content = '林舟守约。沈月归还信物。'
  const document = { project_id: id, filename: 'controlled.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'controlled fixture', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, content, stamp)
  const state: ScriptSourceAnalysis & { budget_steps: Record<string, any> } = { id: newId(), source_version: scriptSourceVersion(document),
    model_id: 'model', configuration_hash: configurationHash, pipeline_version: sourceAnalysisPipelineVersion, status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length, error: 'old unknown', updated_at: stamp,
    sections: [{ offset: 0, length: content.length, title: '约定', episode_number: 1, summary: content, characters: [], events: [] }],
    story: { summary: content, characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: '信物归还。', section_ids: [0] } },
    budget_steps: { [modelWorkflowBudgetKey]: { version: 1, kind: 'source_analysis', grants: 1,
      allowance: { max_requests: 136, max_total_requests: 4186, max_tokens: 99999999, max_active_ms: 8100000 },
      usage: { ...createScriptRequestUsage(), requests: 64 }, active_ms: 1000 } } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [0, 1].map(index => ({ kind: 'omission', explanation: '待核对意见' + index, unit_ids: [0] })) }
  state.quality_repair = { review_hash: state.quality.input_hash, findings_hash: fingerprint(state.quality.findings), current_hash: sourceQualityInputHash(state), completed_findings: 0 }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant({ document, state, configuration_hash: configurationHash, local_active: false })
  state.quality_repair_output = { binding: fingerprint([sourceRepairRequestCheckpoint(document, state, 0), state.model_id, configurationHash]),
    checkpoint: { input_hash: 'f'.repeat(64), initial_started: { input_hash: 'f'.repeat(64) } } }
  const context = { document, state, configuration_hash: configurationHash, local_active: false }
  const scope = controlledSourceRecoveryScope(context)!
  assert.ok(scope)
  const old = structuredClone(state), authorization = newId()
  const next = prepareControlledSourceRecovery(context, { authorization_id: authorization, new_run_id: newId(), scope }) as typeof state
  const save = () => db.prepare(`INSERT OR REPLACE INTO script_source_analyses
    (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, next.id, next.source_version, next.status, JSON.stringify(next), next.updated_at)
  save(); markSourceModelRun(id, next.id)
  const binding = sourceRequestRecoveryBinding(context)
  const authorizationSnapshot = JSON.stringify({ policy: 'source-controlled-risk-choice-v1', acknowledged_duplicate_risk: true,
    scope_token: 'e'.repeat(64), scope, analysis_id: old.id, before_snapshot: JSON.stringify(old), source_updated_at: document.updated_at, confirmed_at: stamp })
  db.prepare(`INSERT INTO source_request_recovery_workflows
    (id,project_id,client_action_id,request_digest,analysis_binding,analysis_id,target_run_id,phase,before_snapshot,scope,authorization_id,scope_token,authorization_snapshot,created_at,updated_at)
    VALUES (?,?,?,'digest',?,?,?,'queued',?,?,?,?,?,?,?)`).run(newId(), id, newId(), binding, old.id, next.id, JSON.stringify(old), JSON.stringify(scope), authorization, 'e'.repeat(64), authorizationSnapshot, stamp, stamp)
  const oldScope = canonicalHash({ source: old.source_version, model: old.model_id, configuration: configurationHash }), oldKey = canonicalHash(['old', id])
  if (sibling) {
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,'dispatched','unknown',?)`).run(id, oldScope, oldKey, old.id, stamp)
  const action = newId()
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(action, id, newId(), old.id, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(newId(), action, id, oldScope, oldKey, old.id, stamp)
  }
  const preserved = () => ({ old: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, oldKey),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id) })
  return { id, document, state, old, next, scope, authorization, save, oldScope, oldKey, preserved }
}
function repairRaw(projectId: string) {
  const proof = currentInitialSourceRepairRequest()?.binding || currentDerivedSourceRepairCorrectionRequest()?.binding
  assert.ok(proof)
  return JSON.stringify({ decision: 'retain_analysis', finding_hash: fingerprint(stored(projectId).quality!.findings[proof.finding_index]), reason: '当前分析已保留原文明示的事实，无需改动。', changes: [],
    analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: 0 }] })
}
function provider(mode: 'valid' | 'correction' | 'disconnect' | 'new_findings' = 'valid') {
  let calls = 0
  const generate = async (_project: string, _model: string, _prompt: string, contract: any) => {
    const request = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 10, reserved_output_tokens: 10 })
    const requestId = 'mock-' + newId(); request.identify(requestId)
    notifyTextRequest('dispatch', { request_id: requestId, delivery: 'unknown' }); calls++
    if (mode === 'disconnect') throw Object.assign(new TextProviderError('synthetic disconnected', false), { delivery: 'unknown', failureReason: 'disconnected' })
    const raw = mode === 'correction' && calls === 1 ? 'not JSON' : contract.name === 'script_source_quality'
      ? JSON.stringify({ checked_section_ids: [0], findings: mode === 'new_findings' ? [{ kind: 'omission', explanation: '复核新问题', unit_ids: [0] }] : [] }) : repairRaw(_project)
    request.complete({ input_tokens: 10, output_tokens: 10, response_chars: raw.length })
    notifyTextRequest('metrics', { delivery: 'completed' })
    return raw
  }
  return { generate, calls: () => calls }
}

test('pure preparation archives exact old bytes and grant without resetting cumulative allowance', async () => {
  const f = await fixture()
  assert.deepEqual(f.state, f.old)
  assert.notEqual(f.next.id, f.old.id)
  assert.deepEqual(f.next.controlled_recovery_archive![0]!.output, f.old.quality_repair_output)
  assert.deepEqual(f.next.controlled_recovery_archive![0]!.grant, f.old.ordinary_story_dispatch)
  assert.deepEqual(f.next.budget_steps, f.old.budget_steps)
  assert.equal(f.scope.max_requests, 6)
  assert.equal(f.next.quality_repair_output, undefined)
  assert.equal(f.next.controlled_recovery!.usage.requests, 0)
  db.prepare('DELETE FROM projects WHERE id=?').run(f.id)
})

test('two exact repairs and one review complete with independent keys and untouched old permits', async () => {
  const f = await fixture(), before = f.preserved(), mock = provider()
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try {
    analyzer.recover(); const current = await terminal(f.id)
    assert.equal(current.status, 'ready', current.error || undefined); assert.equal(mock.calls(), 3)
    assert.equal(current.controlled_recovery!.usage.requests, 3)
    assert.equal(current.budget_steps[modelWorkflowBudgetKey].usage.requests, 67)
    assert.equal(current.budget_steps[modelWorkflowBudgetKey].grants, 1)
    assert.deepEqual(current.controlled_recovery!.dispatched.map(item => item.step), ['repair:0:initial', 'repair:1:initial', 'review:initial'])
    assert.deepEqual(f.preserved(), before)
    assert.deepEqual(current.controlled_recovery_archive![0]!.output, f.old.quality_repair_output)
    const rows = db.prepare('SELECT scope,request_key FROM source_model_requests WHERE project_id=? AND run_id=?').all(f.id, current.id) as any[]
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.scope !== f.oldScope && row.request_key !== f.oldKey))
  } finally { await analyzer.close() }
})

test('namespaced initial supports exactly one derived format correction', async () => {
  const f = await fixture(), mock = provider('correction')
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try {
    analyzer.recover(); const current = await terminal(f.id)
    assert.equal(current.status, 'ready', current.error || undefined); assert.equal(mock.calls(), 4)
    assert.equal(current.controlled_recovery!.dispatched.filter(item => item.step === 'repair:0:correction').length, 1)
  } finally { await analyzer.close() }
})

test('a disconnected controlled attempt stops after one POST and never resumes on recover', async () => {
  const f = await fixture(), before = f.preserved(), mock = provider('disconnect')
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  analyzer.recover(); const current = await terminal(f.id); await analyzer.close()
  assert.equal(current.status, 'paused'); assert.equal(mock.calls(), 1); assert.equal(current.controlled_recovery!.outcome, 'stopped')
  assert.ok(current.quality_repair_output!.checkpoint.initial_started); assert.deepEqual(f.preserved(), before)
  const restart = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try { restart.recover(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(mock.calls(), 1); assert.deepEqual(stored(f.id).controlled_recovery!.dispatched, current.controlled_recovery!.dispatched) }
  finally { await restart.close() }
})

test('new independent review findings stop the controlled workflow without opening a new repair round', async () => {
  const f = await fixture(), mock = provider('new_findings')
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try { analyzer.recover(); const current = await terminal(f.id); assert.equal(current.status, 'paused'); assert.equal(mock.calls(), 3); assert.equal(current.quality!.findings.length, 1) }
  finally { await analyzer.close() }
})

test('an exhausted cumulative budget is not renewed by a controlled authorization', async () => {
  const f = await fixture(), mock = provider()
  f.next.budget_steps[modelWorkflowBudgetKey].exhausted = 'requests'; f.save()
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try { analyzer.recover(); const current = await terminal(f.id); assert.equal(current.status, 'paused'); assert.equal(mock.calls(), 0); assert.equal(current.budget_steps[modelWorkflowBudgetKey].grants, 1); assert.equal(current.budget_steps[modelWorkflowBudgetKey].usage.requests, 64) }
  finally { await analyzer.close() }
})

test('orphan local_replay is paused with zero provider calls and its original marker retained', async () => {
  const f = await fixture(), mock = provider()
  f.next.status = 'running'; delete f.next.controlled_recovery; f.next.quality_repair_output = structuredClone(f.old.quality_repair_output); f.save()
  db.prepare("UPDATE source_request_recovery_workflows SET analysis_id=?,phase='local_replay' WHERE project_id=?").run(f.next.id, f.id)
  const before = structuredClone(f.next.quality_repair_output)
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try { analyzer.recover(); await new Promise<void>(resolve => setImmediate(resolve)); const current = stored(f.id); assert.equal(current.status, 'paused'); assert.equal(mock.calls(), 0); assert.deepEqual(current.quality_repair_output, before) }
  finally { await analyzer.close() }
})

test('same-PID analyzer instances cannot steal a live claim or overwrite its snapshot', async () => {
  const f = await fixture(), mock = provider()
  let unblock!: () => void, entered!: () => void, waiting = true
  const gate = new Promise<void>(resolve => { unblock = resolve }), arrived = new Promise<void>(resolve => { entered = resolve })
  const first = createScriptSourceAnalyzer(async (...args) => {
    if (waiting) { waiting = false; entered(); await gate }
    return mock.generate(...args)
  }, limits, { configuration: () => configuration })
  const second = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try {
    first.recover(); await arrived
    const claimed = stored(f.id)
    assert.equal(claimed.status, 'running'); assert.equal(claimed.controlled_recovery!.runtime_pid, process.pid)
    second.recover()
    assert.deepEqual(stored(f.id), claimed, 'a second live instance cannot queue, pause or claim the same run')
    unblock(); const current = await terminal(f.id)
    assert.equal(current.status, 'ready', current.error || undefined); assert.equal(mock.calls(), 3)
    assert.equal(stored(f.id).controlled_recovery!.runtime_owner, undefined)
  } finally { unblock(); await first.close(); await second.close() }
})

test('orderly close releases an unstarted claim so a new analyzer in the same PID can continue', async () => {
  const f = await fixture(), mock = provider()
  const first = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  first.recover(); await first.close()
  const afterClose = stored(f.id)
  assert.equal(afterClose.controlled_recovery!.runtime_owner, undefined)
  assert.equal(afterClose.controlled_recovery!.runtime_pid, undefined)
  assert.equal(afterClose.status, 'queued'); assert.equal(mock.calls(), 0)
  const second = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  try {
    second.recover(); const current = await terminal(f.id)
    assert.equal(current.status, 'ready', current.error || undefined); assert.equal(mock.calls(), 3)
    assert.equal(current.budget_steps[modelWorkflowBudgetKey].grants, 1)
    assert.equal(current.controlled_recovery!.dispatched.length, 3)
  } finally { await second.close() }
})

test('local revalidation claims and persists a closed controlled run using saved complete bytes only', async () => {
  const f = await fixture(), mock = provider('disconnect')
  const first = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  first.recover(); await terminal(f.id); await first.close()
  const before = stored(f.id), spent = structuredClone(before.controlled_recovery!.dispatched)
  const raw = JSON.stringify({ decision: 'retain_analysis', finding_hash: fingerprint(before.quality!.findings[0]),
    reason: '当前分析已保留原文明示事实，无需改动。', changes: [], analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: 0 }] })
  db.prepare("UPDATE source_model_requests SET state='completed',delivery='completed',result=? WHERE project_id=? AND run_id=?").run(raw, f.id, before.id)
  const second = createScriptSourceAnalyzer(async () => assert.fail('local revalidation cannot invoke a provider'), limits, { configuration: () => configuration })
  try {
    const returned = await second.revalidate(f.id, { analysisId: before.id, sourceUpdatedAt: f.document.updated_at })
    const current = stored(f.id)
    assert.equal(returned.local_validation?.model_required, true)
    assert.deepEqual(returned, current, 'the reported local result is the actual persisted snapshot')
    assert.equal(current.quality_repair!.completed_findings, 1)
    assert.equal(current.controlled_recovery!.runtime_owner, undefined)
    assert.equal(current.controlled_recovery!.outcome, 'stopped')
    assert.deepEqual(current.controlled_recovery!.dispatched, spent); assert.equal(mock.calls(), 1)
  } finally { await second.close() }
})

async function completedBeforeValidation() {
  const f = await fixture(false), mock = provider()
  const first = createScriptSourceAnalyzer(async (...args) => {
    const raw = await mock.generate(...args)
    queueMicrotask(() => first.cancel(f.id))
    return raw
  }, limits, { configuration: () => configuration })
  first.recover(); const closed = await terminal(f.id); await first.close()
  assert.equal(closed.status, 'paused'); assert.equal(mock.calls(), 1)
  assert.equal(closed.controlled_recovery!.outcome, 'stopped')
  assert.equal(closed.controlled_recovery!.usage.uncertain_requests, 0)
  assert.equal(closed.quality_repair!.completed_findings, 0)
  const row = db.prepare('SELECT state,delivery,result FROM source_model_requests WHERE project_id=? AND run_id=?')
    .get(f.id, closed.id) as any
  assert.equal(row.state, 'completed'); assert.equal(row.delivery, 'completed'); assert.ok(row.result)
  return { ...f, closed }
}

test('one local action validates a completed answer then offers a separate remaining-work scope without reopening the old grant', async () => {
  const f = await completedBeforeValidation(), mock = provider()
  const analyzer = createScriptSourceAnalyzer(mock.generate, limits, { configuration: () => configuration })
  const original = structuredClone(stored(f.id)), runs = db.prepare('SELECT count(*) n FROM source_model_runs WHERE project_id=?').get(f.id) as any
  try {
    const details = analyzer.requestRecovery(f.id), input = { analysis_id: original.id, cas_token: details.cas_token,
      client_action_id: newId(), decision: 'reconcile_local' as const }
    const first = await analyzer.reconcileRequest(f.id, input)
    assert.equal(mock.calls(), 0)
    assert.equal(first.recovery.outcome, 'risk_required', JSON.stringify(first.recovery))
    assert.equal(first.recovery.risk!.confirmation_kind, 'remaining_model_usage')
    assert.equal(first.recovery.risk!.scope.max_model_requests, 4)
    const local = stored(f.id)
    assert.equal(local.quality_repair!.completed_findings, 1); assert.equal(local.local_validation!.reused_tasks, 1)
    assert.deepEqual(local.controlled_recovery, original.controlled_recovery)
    assert.deepEqual(local.budget_steps, original.budget_steps)
    assert.deepEqual(db.prepare('SELECT count(*) n FROM source_model_runs WHERE project_id=?').get(f.id), runs)
    const offered = analyzer.requestRecovery(f.id)
    assert.equal(offered.recovery_workflow!.recovery.risk!.confirmation_kind, 'remaining_model_usage')
    assert.equal(mock.calls(), 0, 'GET and the local action cannot dispatch a model')
    const confirmed = await analyzer.reconcileRequest(f.id, { ...input, cas_token: offered.cas_token,
      risk_confirmation: { scope_token: first.recovery.risk!.scope_token, acknowledged_duplicate_risk: true } })
    assert.notEqual(confirmed.analysis.id, original.id)
    const ready = await terminal(f.id)
    assert.equal(ready.status, 'ready', ready.error || undefined); assert.equal(mock.calls(), 2)
    assert.notEqual(ready.controlled_recovery!.authorization_id, original.controlled_recovery!.authorization_id)
    assert.deepEqual(ready.controlled_recovery!.dispatched.map(item => item.step), ['repair:1:initial', 'review:initial'])
    assert.equal(ready.controlled_recovery!.scope.max_requests, 4)
    const archived = ready.controlled_recovery_archive!.find(item => item.original_run_id === original.id)!
    assert.deepEqual(archived.previous, original.controlled_recovery)
    assert.ok(archived.outputs!.some(item => !!item.checkpoint.original_raw))
    assert.equal(ready.budget_steps[modelWorkflowBudgetKey].grants, original.budget_steps[modelWorkflowBudgetKey].grants)
    assert.equal(ready.budget_steps[modelWorkflowBudgetKey].usage.requests, original.budget_steps[modelWorkflowBudgetKey].usage.requests + 2)
    await analyzer.reconcileRequest(f.id, { ...input, cas_token: offered.cas_token,
      risk_confirmation: { scope_token: first.recovery.risk!.scope_token, acknowledged_duplicate_risk: true } })
    assert.equal(mock.calls(), 2, 'a repeated confirmation never creates another attempt')
  } finally { await analyzer.close() }
})

test('remaining-work choice refuses missing, unknown, mismatched or unvalidated prior evidence', async t => {
  for (const mode of ['empty_ledger', 'unknown', 'accepted', 'missing_result', 'missing_link', 'missing_admission',
    'wrong_input_hash', 'wrong_output_binding', 'wrong_raw', 'wrong_authorization', 'creating_background', 'dangling_dispatch',
    'scope_drift', 'new_review', 'uncertain', 'stop_reason', 'loop_guard', 'next_raw', 'next_initial_marker',
    'budget_exhausted'] as const) await t.test(mode, async () => {
    const f = await completedBeforeValidation(), analyzer = createScriptSourceAnalyzer(async () => assert.fail('no model before a new exact confirmation'), limits, { configuration: () => configuration })
    try {
      await analyzer.revalidate(f.id, { analysisId: f.closed.id, sourceUpdatedAt: f.document.updated_at })
      const state = stored(f.id)
      if (mode === 'empty_ledger') db.prepare('DELETE FROM source_model_requests WHERE project_id=? AND run_id=?').run(f.id, state.id)
      if (mode === 'unknown' || mode === 'accepted') db.prepare("UPDATE source_model_requests SET state='dispatched',delivery=? WHERE project_id=? AND run_id=?").run(mode, f.id, state.id)
      if (mode === 'missing_result') db.prepare('UPDATE source_model_requests SET result=NULL WHERE project_id=? AND run_id=?').run(f.id, state.id)
      if (mode === 'missing_link') db.prepare('DELETE FROM source_request_dispatch_links WHERE project_id=? AND run_id=?').run(f.id, state.id)
      if (mode === 'missing_admission') db.prepare('DELETE FROM source_model_admission_events WHERE project_id=? AND run_id=?').run(f.id, state.id)
      if (mode === 'wrong_input_hash') db.prepare('UPDATE source_model_admission_events SET input_hash=? WHERE project_id=? AND run_id=?').run('a'.repeat(64), f.id, state.id)
      if (mode === 'wrong_output_binding') state.quality_repair_outputs!.at(-1)!.binding = 'a'.repeat(64)
      if (mode === 'wrong_raw') state.quality_repair_outputs!.at(-1)!.checkpoint.original_raw += ' drift'
      if (mode === 'wrong_authorization') db.prepare('UPDATE source_request_recovery_workflows SET authorization_snapshot=? WHERE project_id=?').run('{}', f.id)
      if (mode === 'creating_background') {
        const request = db.prepare('SELECT scope FROM source_model_requests WHERE project_id=? AND run_id=?').get(f.id, state.id) as any
        db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)')
          .run(f.id, request.scope, 'pending-background', JSON.stringify({ state: 'creating' }))
      }
      if (mode === 'dangling_dispatch') state.controlled_recovery!.dispatched.push({ step: 'repair:1:initial', request_key: 'a'.repeat(64), local_request_id: 'missing', intent_id: 'missing' })
      if (mode === 'scope_drift') state.controlled_recovery!.scope.max_requests = 8
      if (mode === 'new_review') state.quality!.input_hash = 'a'.repeat(64)
      if (mode === 'uncertain') state.quality_repair!.decisions![0]!.decision = 'uncertain'
      if (mode === 'stop_reason') state.quality_repair!.stop_reason = 'decision_mismatch'
      if (mode === 'loop_guard') state.quality_loop_guard = { analysis_hash: 'a', source_version: state.source_version, reason: 'unchanged_analysis', finding_indices: [1], message: 'stop' }
      if (mode === 'next_raw') state.quality_repair_output!.checkpoint.raw = 'unvalidated next response'
      if (mode === 'next_initial_marker') state.quality_repair_output!.checkpoint.initial_started = { input_hash: state.quality_repair_output!.checkpoint.input_hash! }
      if (mode === 'budget_exhausted') state.budget_steps[modelWorkflowBudgetKey].exhausted = 'requests'
      db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(state), f.id)
      const details = analyzer.requestRecovery(f.id)
      const result = await analyzer.reconcileRequest(f.id, { analysis_id: state.id, cas_token: details.cas_token,
        client_action_id: newId(), decision: 'reconcile_local' })
      assert.notEqual(result.recovery.outcome, 'risk_required', mode)
      assert.equal(stored(f.id).id, state.id); assert.equal(stored(f.id).controlled_recovery!.closed_at, state.controlled_recovery!.closed_at)
    } finally { await analyzer.close(); db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
  })
})

test('a remaining-work confirmation rechecks completed-response evidence and rejects drift without a new run', async () => {
  const f = await completedBeforeValidation(), analyzer = createScriptSourceAnalyzer(async () => assert.fail('drift cannot authorize a model'), limits, { configuration: () => configuration })
  try {
    const details = analyzer.requestRecovery(f.id), input = { analysis_id: details.analysis_id, cas_token: details.cas_token,
      client_action_id: newId(), decision: 'reconcile_local' as const }
    const offered = await analyzer.reconcileRequest(f.id, input)
    assert.equal(offered.recovery.risk!.confirmation_kind, 'remaining_model_usage')
    const before = stored(f.id), runs = db.prepare('SELECT count(*) n FROM source_model_runs WHERE project_id=?').get(f.id)
    db.prepare('UPDATE source_model_admission_events SET input_hash=? WHERE project_id=? AND run_id=?').run('a'.repeat(64), f.id, before.id)
    const fresh = analyzer.requestRecovery(f.id)
    await assert.rejects(() => analyzer.reconcileRequest(f.id, { ...input, cas_token: fresh.cas_token,
      risk_confirmation: { scope_token: offered.recovery.risk!.scope_token, acknowledged_duplicate_risk: true } }), (issue: any) => issue.statusCode === 409)
    assert.deepEqual(stored(f.id), before)
    assert.deepEqual(db.prepare('SELECT count(*) n FROM source_model_runs WHERE project_id=?').get(f.id), runs)
  } finally { await analyzer.close() }
})
