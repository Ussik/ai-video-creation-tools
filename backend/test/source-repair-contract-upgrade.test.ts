import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
const dir = await mkdtemp(join(tmpdir(), 'studio-repair-contract-upgrade-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, initSourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { sourceRequestBlockers, sourceRecoveryDigest } = await import('../src/modules/script/source-request-recovery.js')
const { sourceRequestRecoveryDetails, admitSourceRequestRecovery, sourceRequestRecoveryBinding } = await import('../src/modules/script/source-request-recovery-admission.js')
const { repairSourceQuality, sourceQualityRepairUpgradeBinding, sourceQualityRepairProgress } = await import('../src/modules/script/script-source-quality-repair.js')
const { currentInitialSourceRepairRequest } = await import('../src/modules/script/source-repair-request-identity.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { scriptSourcePassages } = await import('../src/modules/script/script-source-map.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { withModelRequestContext, modelTaskPolicies } = await import('../src/modules/generation/model-task-policy.js')
const { createScriptRequestUsage, withTextRequestUsage, beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
const { modelWorkflowBudgetKey } = await import('../src/modules/generation/model-workflow-budget.js')
initDb(); initSourceModelRecovery(); assert.ok(db.name.startsWith(dir))
after(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
type State = ScriptSourceAnalysis & { budget_steps: Record<string, unknown> }
type Generator = Parameters<typeof sourceModelRecovery>[3]
const signal = () => new AbortController().signal
function fixture(previousEpoch: 'none' | 'unknown' | 'background' = 'none') {
  const project = randomUUID(), stamp = now(), content = '第一集\n林舟遵守约定。\n沈月归还信物。\n'
  const document = { project_id: project, filename: '原稿.txt', content, updated_at: stamp }
  const unit = scriptSourcePassages(content).flatMap(p => p.units).find(u => u.text.includes('林舟'))!
  const long = '林舟遵守约定，沈月归还信物。'.repeat(12)
  const state = { id: 'old-' + project, source_version: 'same-source', model_id: 'model', configuration_hash: 'cfg', status: 'failed',
    updated_at: stamp, error: 'old repair output lost', completed_chunks: 1, total_chunks: 1,
    sections: [{ offset: 0, length: content.length, title: '第一集', episode_number: 1, summary: long,
      characters: [{ name: '林舟', description: long, evidence: { offset: unit.offset, quote: unit.text } }],
      events: [{ summary: long, evidence: { offset: unit.offset, quote: unit.text } }], open_threads: [] }],
    story: { summary: long, characters: [{ name: '林舟', aliases: [], description: long, section_ids: [0] }],
      timeline: [{ summary: long, section_ids: [0] }], threads: [], ending: { summary: long, section_ids: [0] }, uncertainties: [] },
    budget_steps: { [modelWorkflowBudgetKey]: { version: 1, kind: 'source_analysis', grants: 1, active_ms: 10,
      allowance: { max_requests: 20, max_total_requests: 40, max_tokens: 1_000_000, max_active_ms: 60_000 }, usage: createScriptRequestUsage() } } } as State
  const hash = sourceQualityInputHash(state)
  state.quality = { input_hash: hash, status: 'issues', findings: [
    { kind: 'omission', explanation: '前序已处理意见', unit_ids: [unit.id] }, { kind: 'causality', explanation: '核实当前约定状态', unit_ids: [unit.id] }] }
  state.quality_repair = { review_hash: hash, current_hash: hash,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex'), completed_findings: 1 }
  const identity = { source: state.source_version, model: state.model_id, configuration: state.configuration_hash }
  const scope = sourceRecoveryDigest(identity), oldPrompt = 'old full-expected repair contract', oldContract = { name: 'script_source_quality_repair', schema: {} }
  const oldKey = sourceRecoveryDigest([state.model_id, oldPrompt, oldContract])
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(project, 'isolated upgrade', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(project, document.filename, content, stamp)
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(project, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(state.id, project)
  db.prepare("INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,'dispatched','output_started',NULL,NULL,?)")
    .run(project, scope, oldKey, state.id, stamp)
  const previousEpochId = previousEpoch !== 'none' ? randomUUID() : undefined
  if (previousEpochId) {
    db.prepare('INSERT INTO source_request_recovery_actions (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(previousEpochId, project, randomUUID(), randomUUID(), randomUUID(), '{}', 'a'.repeat(64), state.id, 'abandon_and_resume', stamp)
    db.prepare(`INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at,consumed_at,local_request_id,response_key)
      VALUES (?,?,?,?,?,?,'dispatched','output_started',?,?,?,?)`).run(previousEpochId, previousEpochId, project, scope, oldKey, state.id,
        stamp, stamp, 'previous-request-' + project, previousEpoch === 'background' ? 'previous-background' : null)
  }
  const load = () => ({ document, state: JSON.parse((db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(project) as { snapshot: string }).snapshot) as State,
    configuration_hash: 'cfg', local_active: false })
  const details = sourceRequestRecoveryDetails(project, load)
  const admitted = admitSourceRequestRecovery(project, { analysis_id: state.id, cas_token: details.cas_token, client_action_id: randomUUID(),
    decision: 'abandon_and_resume', acknowledged_duplicate_risk: true }, load)
  const next = admitted.analysis as State
  const persist = () => db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(next), project)
  const upgrade = () => { const context = load(), binding = sourceQualityRepairUpgradeBinding(context.document, context.state)
    return binding ? { binding, analysisBinding: sourceRequestRecoveryBinding(context) } : undefined }
  const run = (generate: Generator, transform?: (prompt: string, contract: Parameters<Generator>[3]) => [string, Parameters<Generator>[3]], identityOverride = identity, workerState = next) => {
    const wrapped = sourceModelRecovery(project, workerState.id, identityOverride, generate, { completedStoryRunIds: workerState.story_response_run_ids, repairContractUpgrade: upgrade })
    return repairSourceQuality(document, workerState, (prompt, contract) => {
      const [text, output] = transform ? transform(prompt, contract) : [prompt, contract]
      return wrapped(project, workerState.model_id, text, output, signal())
    }, () => db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(workerState), project), signal())
  }
  const epoch = () => db.prepare('SELECT * FROM source_request_recovery_epochs WHERE action_id=?').get(admitted.action_id) as Record<string, unknown>
  const original = () => JSON.stringify(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(project, scope, oldKey))
  const action = () => JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_actions WHERE id=?').get(admitted.action_id))
  const resolutions = () => db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(project) as Record<string, unknown>[]
  const reply = JSON.stringify({ decision: 'retain_analysis', finding_hash: createHash('sha256').update(JSON.stringify(state.quality.findings[1])).digest('hex'),
    reason: '当前分析已保留约定，所引原文支持，不需修改。', analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: unit.id }], changes: [] })
  return { project, document, state: next, identity, oldPrompt, oldContract, oldKey, scope, unit, load, persist, upgrade, run, epoch, original, action, resolutions, reply, actionId: admitted.action_id, previousEpochId }
}
const dispatch = (requestId: string) => notifyTextRequest('dispatch', { request_id: requestId })

test('new admission binds complete finding checkpoint; real initial ref producer retires only at independent dispatch', async () => {
  const f = fixture(), old = f.original(), audit = f.action(), before = structuredClone(f.state)
  const saved = JSON.parse((JSON.parse(audit) as { original_snapshot: string }).original_snapshot)
  assert.deepEqual(saved.repair_contract_upgrade, f.upgrade()!.binding)
  let posts = 0
  await f.run(async (_p, _m, prompt, contract) => {
    const trusted = currentInitialSourceRepairRequest()!
    assert.ok(trusted); assert.equal(trusted.binding.finding_index, 1)
    assert.equal(trusted.requestKey, sourceRecoveryDigest([f.state.model_id, prompt, contract]))
    assert.deepEqual(f.load().state.sections, before.sections); assert.deepEqual(f.load().state.quality_repair, before.quality_repair)
    dispatch('new-' + f.project); posts++; return f.reply
  })
  assert.equal(posts, 1); assert.equal(f.epoch().state, 'superseded'); assert.equal(f.epoch().consumed_at, null)
  const [resolution] = f.resolutions(); assert.equal(resolution!.reason, 'repair_contract_upgrade')
  assert.equal(resolution!.old_request_key, f.oldKey); assert.notEqual(resolution!.new_request_key, f.oldKey)
  assert.equal(resolution!.checkpoint_hash, saved.repair_contract_upgrade.checkpoint_hash)
  assert.equal(resolution!.current_checkpoint_hash, saved.repair_contract_upgrade.checkpoint_hash)
  assert.equal(f.original(), old); assert.equal(f.action(), audit); assert.equal(sourceQualityRepairProgress(f.state), 2)
  assert.deepEqual(f.state.sections, before.sections); assert.deepEqual(f.state.story, before.story); assert.deepEqual(f.state.quality, before.quality)
})

test('legacy actions, unrelated or latest replaced decisions, consumed permits and background identities fail closed', async () => {
  for (const variant of ['legacy', 'policy', 'decision', 'latest', 'run', 'consumed', 'background', 'epoch-background']) {
    const f = fixture(); let posts = 0
    if (variant === 'legacy' || variant === 'policy') {
      const row = JSON.parse(f.action()), saved = JSON.parse(row.original_snapshot)
      if (variant === 'legacy') delete saved.repair_contract_upgrade
      else saved.repair_contract_upgrade.policy = 'old-policy'
      db.prepare('UPDATE source_request_recovery_actions SET original_snapshot=? WHERE id=?').run(JSON.stringify(saved), f.actionId)
    }
    if (variant === 'decision') db.prepare("UPDATE source_request_recovery_actions SET decision='unrelated' WHERE id=?").run(f.actionId)
    if (variant === 'latest') db.prepare(`INSERT INTO source_request_recovery_actions SELECT ?,project_id,?,request_digest,?,original_snapshot,analysis_binding,target_run_id,decision,created_at FROM source_request_recovery_actions WHERE id=?`)
      .run(randomUUID(), randomUUID(), randomUUID(), f.actionId)
    if (variant === 'run') db.prepare("UPDATE source_request_recovery_epochs SET run_id='replaced' WHERE action_id=?").run(f.actionId)
    if (variant === 'consumed') db.prepare("UPDATE source_request_recovery_epochs SET state='dispatched',delivery='unknown',consumed_at=?,local_request_id='already-used' WHERE action_id=?").run(now(), f.actionId)
    if (variant === 'background') db.prepare("UPDATE source_model_requests SET response_key='background-original' WHERE project_id=?").run(f.project)
    if (variant === 'epoch-background') db.prepare("UPDATE source_request_recovery_epochs SET response_key='background-epoch' WHERE action_id=?").run(f.actionId)
    const old = f.original(), audit = f.action()
    await assert.rejects(f.run(async () => { dispatch('must-not-' + variant); posts++; return f.reply }), variant)
    assert.equal(posts, 0, variant); assert.equal(f.original(), old); assert.equal(f.action(), audit); assert.equal(f.resolutions().length, 0)
  }
})

test('untrusted markers, modified prompt or schema, other contracts and other model scopes never migrate a permit', async () => {
  for (const variant of ['marker', 'prompt', 'schema', 'contract', 'source', 'model', 'config']) {
    const f = fixture(); let posts = 0
    const generate = async () => { dispatch('must-not-' + variant); posts++; return f.reply }
    if (variant === 'marker') {
      await assert.rejects(sourceModelRecovery(f.project, f.state.id, f.identity, generate, { repairContractUpgrade: f.upgrade })(f.project, f.state.model_id,
        'source-quality-repair-ref-v1 repair_references=[]', { name: 'script_source_quality_repair', schema: {} }, signal()))
    } else {
      const identity = variant === 'source' ? { ...f.identity, source: 'different' } : variant === 'config' ? { ...f.identity, configuration: 'different' }
        : variant === 'model' ? { ...f.identity, model: 'different' } : f.identity
      await assert.rejects(f.run(generate, (prompt, contract) => [variant === 'prompt' ? prompt + ' changed' : prompt,
        variant === 'schema' ? { ...contract!, schema: { type: 'object', properties: {} } } : variant === 'contract' ? { ...contract!, name: 'script_source_quality' } : contract], identity), variant)
    }
    assert.equal(posts, 0, variant); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0)
  }
})

test('format correction and structure-repair calls never inherit the initial producer authorization', async () => {
  for (const variant of ['correction', 'structure']) {
    const f = fixture(); let calls = 0, posts = 0
    const wrapped = sourceModelRecovery(f.project, f.state.id, f.identity, async () => { dispatch('forbidden-correction'); posts++; return f.reply },
      { completedStoryRunIds: f.state.story_response_run_ids, repairContractUpgrade: f.upgrade })
    await assert.rejects(repairSourceQuality(f.document, f.state, (prompt, contract) => {
      calls++
      // Missing reason still exercises structure repair; the withdrawn legacy
      // branch now stops before buying a correction and is tested separately.
      if (calls === 1) { assert.ok(currentInitialSourceRepairRequest()); return Promise.resolve(variant === 'correction' ? 'plain invalid JSON' : JSON.stringify({ status: 'patched', changes: [] })) }
      assert.equal(currentInitialSourceRepairRequest(), undefined)
      assert.equal(contract!.name, variant === 'correction' ? 'script_source_quality_repair' : 'script_source_quality_repair_structure_repair')
      return wrapped(f.project, f.state.model_id, prompt, contract, signal())
    }, f.persist, signal()))
    assert.equal(calls, 2); assert.equal(posts, 0); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0)
  }
})

function drift(f: ReturnType<typeof fixture>, variant: string) {
  const state = f.load().state
  if (variant === 'sections') state.sections[0]!.summary += '外部修改'
  if (variant === 'story') state.story!.summary += '外部修改'
  if (variant === 'quality') state.quality!.input_hash = 'c'.repeat(64)
  if (variant === 'finding') state.quality!.findings[1]!.explanation += '外部修改'
  if (variant === 'progress') state.quality_repair!.completed_findings = 0
  if (variant === 'withdrawals') state.quality_repair!.withdrawals = [{ finding_index: 0,
    finding_hash: createHash('sha256').update(JSON.stringify(state.quality!.findings[0])).digest('hex'),
    analysis_hash: state.quality_repair!.current_hash, reason: '外部记录', unit_ids: [f.unit.id] }]
  if (variant === 'feedback') state.review_feedback = { text: '外部反馈' } as ScriptSourceAnalysis['review_feedback']
  db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(state), f.project)
}
test('same source/model/config cannot upgrade after review, finding, progress, withdrawals or artifacts drift at the last dispatch barrier', async () => {
  for (const variant of ['sections', 'story', 'quality', 'finding', 'progress', 'withdrawals', 'feedback', 'source']) {
    const f = fixture(), audit = f.action(), old = f.original(); let posts = 0
    await assert.rejects(f.run(async () => {
      if (variant === 'source') f.document.content += '当前原文变化'
      else drift(f, variant)
      dispatch('drift-' + variant); posts++; return f.reply
    }), variant)
    assert.equal(posts, 0, variant); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0)
    assert.equal(f.original(), old); assert.equal(f.action(), audit)
  }
})

test('real request budget rejection occurs before retirement; transactional observer failure rolls back retirement and link', async () => {
  const f = fixture(), audit = f.action(), old = f.original(); let posts = 0
  const usage = createScriptRequestUsage(); usage.requests = 1
  await assert.rejects(withTextRequestUsage({ usage, limits: { max_requests: 1 } }, () => f.run(async () => {
    beginTextRequest({ request_bytes: 1, estimated_input_tokens: 1 }); dispatch('budget-must-not'); posts++; return f.reply
  })), { code: 'text_request_budget_exceeded' })
  assert.equal(posts, 0); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0)
  assert.equal(f.state.quality_repair_output?.checkpoint.initial_started, undefined, 'trusted admission refusal releases only its unsubmitted initial attempt')
  // This test observer runs before the synthetic provider posts and its
  // transaction rolls back. Only that proven not-sent outcome is releasable;
  // ordinary observer errors keep the production unknown-dispatch guard.
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onDispatch: () => { throw Object.assign(new Error('observer rollback'), { delivery: 'not_sent' }) } },
    () => f.run(async () => { dispatch('observer-rollback'); posts++; return f.reply })), /observer rollback/)
  assert.equal(posts, 0); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_dispatch_links WHERE project_id=?').get(f.project) as { n: number }).n, 0)
  assert.equal(f.original(), old); assert.equal(f.action(), audit)
  await f.run(async () => { dispatch('after-rollback'); posts++; return f.reply })
  assert.equal(posts, 1); assert.equal(f.resolutions().length, 1)
})

test('concurrent wrappers retire once; a new unknown stays blocked and cannot inherit the old permit', async () => {
  const f = fixture(); let posts = 0, release: () => void = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  // Separate workers may load the same unstarted snapshot. Sharing one object
  // would instead exercise its earlier in-memory initial_started guard.
  const slowState = structuredClone(f.state), fastState = structuredClone(f.state)
  const slow = f.run(async () => { await wait; dispatch('slow-upgrade'); posts++; return f.reply }, undefined, f.identity, slowState)
  try {
    await assert.rejects(f.run(async () => { dispatch('fast-upgrade'); posts++; throw new Error('new ref outcome unknown') }, undefined, f.identity, fastState), /new ref outcome unknown/)
  } finally { release() }
  await assert.rejects(slow)
  assert.equal(posts, 1); assert.equal(f.resolutions().length, 1); assert.equal(f.epoch().state, 'superseded')
  const blockers = sourceRequestBlockers(f.project, [f.state.id, ...f.state.story_response_run_ids!])
  assert.equal(blockers.length, 1); assert.notEqual(blockers[0]!.request_key, f.oldKey); assert.equal(blockers[0]!.local_request_id, 'fast-upgrade')
  await assert.rejects(f.run(async () => { dispatch('must-not-retry'); posts++; return f.reply }))
  assert.equal(posts, 1)
})

test('late old exact completion after migration remains quarantined without modifying the old audit or row', async () => {
  const f = fixture(), old = f.original(), audit = f.action(); let release: () => void = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const late = sourceModelRecovery(f.project, f.state.id, f.identity, async () => { await wait; return 'late exact original result' })(
    f.project, f.state.model_id, f.oldPrompt, f.oldContract, signal())
  await f.run(async () => { dispatch('new-ref-before-late'); return f.reply })
  const epoch = JSON.stringify(f.epoch()); release(); await assert.rejects(late, /隔离/)
  assert.equal(f.original(), old); assert.equal(f.action(), audit); assert.equal(JSON.stringify(f.epoch()), epoch)
  const quarantined = db.prepare('SELECT result FROM source_request_late_events WHERE project_id=?').all(f.project) as { result: string }[]
  assert.equal(quarantined.length, 1); assert.equal(quarantined[0]!.result, 'late exact original result')
})

test('a previous unknown epoch is captured verbatim, and any background or late identity drift forbids upgrading it', async () => {
  for (const variant of ['valid', 'background', 'snapshot-background', 'epoch-response', 'epoch-state', 'epoch-result', 'epoch-local', 'missing-snapshot']) {
    const f = fixture(variant === 'background' ? 'background' : 'unknown'); let posts = 0
    const captured = JSON.parse(JSON.parse(f.action()).original_snapshot)
    assert.equal(captured.blocker.epoch_id, f.previousEpochId)
    assert.deepEqual(captured.original_epoch, db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(f.previousEpochId))
    if (variant === 'snapshot-background' || variant === 'missing-snapshot') {
      if (variant === 'snapshot-background') captured.blocker.response_key = 'hidden-background'
      else delete captured.original_epoch
      db.prepare('UPDATE source_request_recovery_actions SET original_snapshot=? WHERE id=?').run(JSON.stringify(captured), f.actionId)
    }
    if (variant === 'epoch-response') db.prepare("UPDATE source_request_recovery_epochs SET response_key='late-background' WHERE id=?").run(f.previousEpochId)
    if (variant === 'epoch-state') db.prepare("UPDATE source_request_recovery_epochs SET state='completed',delivery='completed' WHERE id=?").run(f.previousEpochId)
    if (variant === 'epoch-result') db.prepare("UPDATE source_request_recovery_epochs SET result='late-result' WHERE id=?").run(f.previousEpochId)
    if (variant === 'epoch-local') db.prepare("UPDATE source_request_recovery_epochs SET local_request_id='late-request' WHERE id=?").run(f.previousEpochId)
    const old = f.original(), audit = f.action(), beforePrevious = JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(f.previousEpochId))
    const work = () => f.run(async () => { dispatch('new-after-epoch-' + f.project); posts++; return f.reply })
    if (variant === 'valid') { await work(); assert.equal(posts, 1); assert.equal(f.epoch().state, 'superseded') }
    else { await assert.rejects(work(), variant); assert.equal(posts, 0); assert.equal(f.epoch().state, 'prepared'); assert.equal(f.resolutions().length, 0) }
    assert.equal(f.original(), old); assert.equal(f.action(), audit)
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(f.previousEpochId)), beforePrevious)
  }
})
