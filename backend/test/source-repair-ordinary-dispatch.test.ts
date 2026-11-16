import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import { withInitialSourceRepairRequest, withDerivedSourceRepairCorrectionRequest, withFrozenSourceCorrectionRead, sourceRepairReferencePolicy,
  type SourceRepairUpgradeBinding, type InitialSourceRepairRequest, type DerivedSourceRepairCorrectionRequest } from '../src/modules/script/source-repair-request-identity.js'
import { withDerivedSourceCorrectionRequest, withInitialSourceQualityRequest } from '../src/modules/script/source-story-dispatch-identity.js'
import type { StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-repair-ordinary-dispatch-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, sourceModelCompletedReader } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const originalFetch = globalThis.fetch
globalThis.fetch = async () => assert.fail('isolated adapter tests must never access the network')
initDb()
assert.ok(db.name.startsWith(dataDir + '/'), 'all writes use isolated temporary SQLite')
after(async () => { globalThis.fetch = originalFetch; db.close(); await rm(dataDir, { recursive: true, force: true }) })
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
const contract = { name: 'script_source_quality_repair', schema: { type: 'object' } }
const initialPrompt = 'one complete finding initial request'
const raw = 'saved complete initial bytes requiring one format correction'
const correctionPrompt = 'one exact frozen quality repair correction'
const bindingFor = (index = 0): SourceRepairUpgradeBinding => ({ policy: sourceRepairReferencePolicy,
  checkpoint_hash: digest(['checkpoint', index]), finding_index: index, finding_hash: digest(['finding', index]),
  review_hash: digest('review'), findings_hash: digest('findings'), current_hash: digest(['current', index]) })
let sequence = 0
async function fixture(sibling = true) {
  const id = 'ordinary-repair-' + sequence++, oldRun = id + '-old', runId = id + '-ordinary', stamp = now()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  const identity = { source: id + '-source', model: 'model', configuration: 'same' }
  // Constructing the local wrapper initializes only this temporary ledger.
  sourceModelRecovery(id, runId, identity, async () => assert.fail('initialization is not generation'))
  const scope = digest(identity), oldKey = digest(['old sibling', id])
  if (sibling) {
    db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
      VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`).run(id, scope, oldKey, oldRun, stamp)
    db.prepare(`INSERT INTO source_request_recovery_actions
      (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
      VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', runId, stamp)
    db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
      VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, scope, oldKey, runId, stamp)
  }
  const preserved = () => ({
    original: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, oldKey),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id),
  })
  const binding = bindingFor()
  return { id, oldRun, runId, identity, scope, oldKey, binding, preserved }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function initial(f: Fixture, wrapped: ReturnType<typeof sourceModelRecovery>, binding = f.binding,
  prompt = initialPrompt, proofPrompt = prompt, actual = contract, proofContract = actual) {
  return withInitialSourceRepairRequest(binding, 'model', proofPrompt, proofContract,
    () => wrapped(f.id, 'model', prompt, actual, signal()), true)
}
const dispatch = (id: string) => notifyTextRequest('dispatch', { request_id: id, delivery: 'unknown' })
async function completeInitial(f: Fixture) {
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { dispatch(f.id + '-initial'); return raw },
    { completedStoryRunIds: [f.oldRun], ordinaryRepairDispatch: () => true })
  assert.equal(await initial(f, wrapped), raw)
  return { binding: f.binding, base_input_hash: digest('initial base'), initial_request_key: digest(['model', initialPrompt, contract]),
    initial_response_hash: hash(raw), correction_input_hash: hash(JSON.stringify([correctionPrompt, contract])) }
}
function corrected(f: Fixture, wrapped: ReturnType<typeof sourceModelRecovery>, proof: Omit<DerivedSourceRepairCorrectionRequest, 'request_key'>,
  prompt = correctionPrompt, proofPrompt = prompt, actual = contract, proofContract = actual) {
  return withModelRequestContext({ policy: modelTaskPolicies.generation, operationStage: 'format_correction' }, () =>
    withDerivedSourceRepairCorrectionRequest(proof, 'model', proofPrompt, proofContract,
      () => wrapped(f.id, 'model', prompt, actual, signal())))
}

test('first and later finding ordinary requests never inspect or transfer an unrelated prepared permit', async () => {
  const f = await fixture(), before = f.preserved(); let posts = 0, checks = 0, expected = f.binding
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { dispatch(f.id + '-' + posts++); return raw }, {
    completedStoryRunIds: [f.oldRun], repairContractUpgrade: () => assert.fail('ordinary authority never probes sibling upgrade'),
    ordinaryRepairDispatch: proof => { checks++; return canonicalAiValue(proof.binding) === canonicalAiValue(expected) },
  })
  assert.equal(await initial(f, wrapped), raw)
  expected = bindingFor(1)
  assert.equal(await initial(f, wrapped, expected, initialPrompt + ' next finding'), raw)
  assert.equal(posts, 2); assert.ok(checks >= 4); assert.deepEqual(f.preserved(), before)
  const rows = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key!=?').all(f.id, f.oldKey) as any[]
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.state === 'completed' && row.delivery === 'completed'))
})

test('ordinary repair rejects missing or stale proof, wire identity, contract, model and unknown exact request', async t => {
  for (const mode of ['no_grant', 'no_proof', 'binding', 'prompt', 'schema', 'contract', 'model', 'format_stage', 'unknown'] as const) await t.test(mode, async () => {
    const f = await fixture(), before = f.preserved(); let posts = 0
    const options = { completedStoryRunIds: [f.oldRun], ordinaryRepairDispatch: (proof: InitialSourceRepairRequest) =>
      mode !== 'no_grant' && canonicalAiValue(proof.binding) === canonicalAiValue(f.binding) }
    const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { posts++; return 'forbidden' }, options)
    const key = digest(['model', initialPrompt, contract])
    if (mode === 'unknown') db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,'dispatched','unknown',?)`)
      .run(f.id, f.scope, key, f.oldRun, now())
    const actual = mode === 'contract' ? { ...contract, name: contract.name + '_structure_repair' } : contract
    const work = () => wrapped(f.id, mode === 'model' ? 'other-model' : 'model', initialPrompt, actual, signal())
    const proven = () => mode === 'no_proof' ? work() : withInitialSourceRepairRequest(mode === 'binding' ? bindingFor(1) : f.binding,
      'model', mode === 'prompt' ? initialPrompt + ' drift' : initialPrompt,
      mode === 'schema' ? { ...actual, schema: { type: 'string' } } : actual, work)
    const old = f.preserved()
    await assert.rejects(() => mode === 'format_stage'
      ? withModelRequestContext({ policy: modelTaskPolicies.generation, operationStage: 'format_correction' }, proven) : proven())
    assert.equal(posts, 0); assert.deepEqual(f.preserved(), old)
    if (mode !== 'unknown') assert.deepEqual(f.preserved(), before)
  })
})

test('an ordinary repair grant is mandatory and rechecked at the final boundary even without a sibling', async t => {
  for (const sibling of [false, true]) await t.test(String(sibling), async () => {
    const f = await fixture(sibling), before = f.preserved(); let posts = 0, allowed = false
    const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
      allowed = false; dispatch(f.id + '-revoked'); posts++; return 'forbidden'
    }, { completedStoryRunIds: [f.oldRun], ordinaryRepairDispatch: () => allowed })
    await assert.rejects(() => initial(f, wrapped)); assert.equal(posts, 0)
    allowed = true
    await assert.rejects(() => initial(f, wrapped), (issue: any) => issue.code === 'source_request_sibling_pending')
    assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
  })
})

test('legacy repair without an ordinary marker or sibling retains its original no-grant dispatch path', async () => {
  const f = await fixture(false); let posts = 0
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { dispatch(f.id + '-legacy'); posts++; return raw },
    { ordinaryRepairDispatch: () => false })
  assert.equal(await withInitialSourceRepairRequest(f.binding, 'model', initialPrompt, contract,
    () => wrapped(f.id, 'model', initialPrompt, contract, signal())), raw)
  assert.equal(posts, 1)
})

test('only one frozen quality repair correction derives from its exact ordinary completed initial', async () => {
  const f = await fixture(), proof = await completeInitial(f), before = f.preserved(); let posts = 0, checks = 0
  const savedInitial = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, proof.initial_request_key)
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { dispatch(f.id + '-correction'); posts++; return 'fixed once' }, {
    completedStoryRunIds: [f.oldRun], repairContractUpgrade: () => assert.fail('derived correction cannot transfer a sibling permit'),
    ordinaryRepairCorrectionDispatch: (request, initialRunId) => {
      checks++; assert.equal(initialRunId, f.runId); assert.deepEqual(request, { ...proof, request_key: digest(['model', correctionPrompt, contract]) }); return true
    },
  })
  assert.equal(await corrected(f, wrapped, proof), 'fixed once')
  assert.equal(posts, 1); assert.ok(checks >= 2); assert.deepEqual(f.preserved(), before)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, proof.initial_request_key), savedInitial)
  await assert.rejects(() => corrected(f, wrapped, proof))
  assert.equal(posts, 1)
})

test('pure inherited initial replay preserves its original dispatch owner for one derived correction', async () => {
  const f = await fixture(), proof = await completeInitial(f), nextRun = f.id + '-continued'
  const read = sourceModelCompletedReader(f.id, nextRun, f.identity, [f.runId])
  const row = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, proof.initial_request_key)
  assert.equal(await read(f.id, 'model', initialPrompt, contract, signal()), raw)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, proof.initial_request_key), row)
  let posts = 0
  const wrapped = sourceModelRecovery(f.id, nextRun, f.identity, async () => { dispatch(f.id + '-inherited'); posts++; return 'continued once' }, {
    completedStoryRunIds: [f.oldRun, f.runId], ordinaryRepairCorrectionDispatch: (_request, initialRunId) => initialRunId === f.runId,
  })
  assert.equal(await corrected(f, wrapped, proof), 'continued once'); assert.equal(posts, 1)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, proof.initial_request_key), row)
})

test('repair correction authorization is freshly checked without a sibling or a model retry', async () => {
  const f = await fixture(false), proof = await completeInitial(f), before = f.preserved(); let allowed = true, posts = 0
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
    allowed = false; dispatch(f.id + '-revoked-correction'); posts++; return 'forbidden'
  }, { ordinaryRepairCorrectionDispatch: () => allowed })
  await assert.rejects(() => corrected(f, wrapped, proof), (issue: any) => issue.code === 'source_request_sibling_pending')
  assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
})

test('repair corrections reject unknown, frozen, unbound, used, altered and unauthorized identities', async t => {
  for (const mode of ['no_grant', 'no_proof', 'finding', 'base', 'initial_key', 'initial_bytes', 'frozen_hash', 'request',
    'stage', 'structure', 'initial_unknown', 'initial_frozen', 'initial_unbound', 'correction_unknown', 'correction_complete'] as const) await t.test(mode, async () => {
    const f = await fixture(), original = await completeInitial(f), proof = structuredClone(original); let posts = 0
    if (mode === 'finding') proof.binding = bindingFor(1)
    if (mode === 'base') proof.base_input_hash = 'b'.repeat(64)
    if (mode === 'initial_key') proof.initial_request_key = 'b'.repeat(64)
    if (mode === 'initial_bytes') proof.initial_response_hash = 'b'.repeat(64)
    if (mode === 'frozen_hash') proof.correction_input_hash = 'b'.repeat(64)
    if (mode === 'initial_unknown') db.prepare("UPDATE source_model_requests SET state='dispatched',delivery='unknown' WHERE project_id=? AND request_key=?").run(f.id, original.initial_request_key)
    if (mode === 'initial_unbound') db.prepare('DELETE FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').run(f.id, original.initial_request_key)
    if (mode === 'initial_frozen') db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`)
      .run(f.id + '-initial-frozen', f.id + '-action', f.id, f.scope, original.initial_request_key, f.runId, now())
    if (mode === 'correction_unknown' || mode === 'correction_complete') db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(f.id, f.scope, digest(['model', correctionPrompt, contract]), f.oldRun, mode === 'correction_unknown' ? 'dispatched' : 'completed',
        mode === 'correction_unknown' ? 'unknown' : 'completed', mode === 'correction_unknown' ? null : 'used correction', now())
    const before = f.preserved(), initialBefore = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, original.initial_request_key)
    const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { posts++; return 'forbidden' }, {
      completedStoryRunIds: [f.oldRun], ordinaryRepairCorrectionDispatch: (request, initialRunId) => mode !== 'no_grant' && initialRunId === f.runId &&
        canonicalAiValue(request.binding) === canonicalAiValue(original.binding) && request.base_input_hash === original.base_input_hash,
    })
    const actual = mode === 'structure' ? { ...contract, name: contract.name + '_structure_repair' } : contract
    const work = () => wrapped(f.id, 'model', mode === 'request' ? correctionPrompt + ' drift' : correctionPrompt, actual, signal())
    await assert.rejects(() => mode === 'no_proof' ? withModelRequestContext({ policy: modelTaskPolicies.generation, operationStage: 'format_correction' }, work)
      : mode === 'stage' ? withDerivedSourceRepairCorrectionRequest(proof, 'model', correctionPrompt, actual, work)
        : corrected(f, wrapped, proof, mode === 'request' ? correctionPrompt + ' drift' : correctionPrompt, correctionPrompt, actual))
    assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, original.initial_request_key), initialBefore)
  })
})

test('same-identity concurrent repair or correction callers cannot duplicate an unknown or completed POST', async t => {
  for (const correction of [false, true]) for (const unknown of [false, true]) await t.test(`${correction ? 'correction' : 'initial'}:${unknown ? 'unknown' : 'complete'}`, async () => {
    const f = await fixture(), proof = correction ? await completeInitial(f) : undefined, before = f.preserved()
    let posts = 0, releaseFirst!: () => void, releaseSecond!: () => void, enteredFirst!: () => void, enteredSecond!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve }), secondEntered = new Promise<void>(resolve => { enteredSecond = resolve })
    const options = { completedStoryRunIds: [f.oldRun], ordinaryRepairDispatch: () => true, ordinaryRepairCorrectionDispatch: () => true }
    const first = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
      enteredFirst(); await firstGate; dispatch(f.id + '-owner'); posts++; if (unknown) throw new Error('owner unknown'); return 'owner complete'
    }, options)
    const second = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
      enteredSecond(); await secondGate; dispatch(f.id + '-duplicate'); posts++; return 'forbidden duplicate'
    }, options)
    const call = (wrapped: ReturnType<typeof sourceModelRecovery>) => proof ? corrected(f, wrapped, proof) : initial(f, wrapped)
    const firstResult = call(first), observedFirst = unknown ? assert.rejects(firstResult, /owner unknown/) : firstResult
    await firstEntered
    const secondResult = assert.rejects(() => call(second), (issue: any) => issue.code === 'source_request_sibling_pending')
    await secondEntered; releaseFirst(); await observedFirst
    const key = digest(['model', correction ? correctionPrompt : initialPrompt, contract])
    const owned = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, key)
    releaseSecond(); await secondResult
    assert.equal(posts, 1); assert.deepEqual(f.preserved(), before)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, key), owned)
  })
})

test('pure completed reader replays only exact inherited initial quality repair without ledger writes', async t => {
  for (const mode of ['valid', 'no_lineage', 'prompt', 'schema', 'model', 'scope', 'format', 'stage', 'structure', 'local', 'unknown', 'not_completed'] as const) await t.test(mode, async () => {
    const f = await fixture(), proof = await completeInitial(f)
    const actual = mode === 'structure' || mode === 'local' ? { ...contract, name: contract.name + (mode === 'local' ? '_local_repair' : '_structure_repair') }
      : mode === 'schema' ? { ...contract, schema: { type: 'string' } } : contract
    const prompt = mode === 'format' ? initialPrompt + '\n【一次格式修正】\n' : mode === 'prompt' ? initialPrompt + ' drift' : initialPrompt
    // These exact alternate rows prove that exclusion is by lineage/stage,
    // rather than merely by absence of a matching row.
    if (['format', 'structure', 'local'].includes(mode)) db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,'completed','completed',?,?)`)
      .run(f.id, f.scope, digest(['model', prompt, actual]), f.runId, raw, now())
    if (mode === 'unknown') db.prepare("UPDATE source_model_requests SET state='dispatched',delivery='unknown' WHERE project_id=? AND request_key=?")
      .run(f.id, proof.initial_request_key)
    if (mode === 'not_completed') db.prepare("UPDATE source_model_requests SET delivery='output_started' WHERE project_id=? AND request_key=?")
      .run(f.id, proof.initial_request_key)
    const tables = ['source_model_runs', 'source_model_requests', 'source_model_responses', 'source_request_recovery_actions',
      'source_request_recovery_epochs', 'source_request_recovery_resolutions', 'source_request_dispatch_links', 'source_request_late_events']
    const capture = () => tables.map(table => db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(f.id))
    const before = capture()
    const read = sourceModelCompletedReader(f.id, f.id + '-local-only', mode === 'scope' ? { ...f.identity, configuration: 'drift' } : f.identity,
      mode === 'no_lineage' ? [f.oldRun] : [f.runId])
    const work = () => read(f.id, mode === 'model' ? 'other' : 'model', prompt, actual, signal())
    if (mode === 'unknown') await assert.rejects(work, (issue: any) => issue.code === 'source_request_unknown')
    else assert.equal(await (mode === 'stage' ? withModelRequestContext({ policy: modelTaskPolicies.generation, operationStage: 'format_correction' }, work) : work()), mode === 'valid' ? raw : undefined)
    assert.deepEqual(capture(), before)
  })
})

test('pure completed reader supports exact first and post-repair quality audits across runs without replaying a correction', async t => {
  for (const kind of ['first', 'post-repair']) for (const mode of ['valid', 'no_lineage', 'prompt', 'schema', 'model', 'scope',
    'format', 'stage', 'derived', 'page', 'unknown', 'not_completed'] as const) await t.test(`${kind}:${mode}`, async () => {
    const f = await fixture(), reviewContract = { ...contract, name: 'script_source_quality' }
    const reviewPrompt = `complete ${kind} quality audit`, reviewRaw = `saved ${kind} independent audit`
    const actual = mode === 'page' ? { ...reviewContract, name: 'script_source_quality_page' }
      : mode === 'schema' ? { ...reviewContract, schema: { type: 'string' } } : reviewContract
    const prompt = mode === 'format' ? reviewPrompt + '\n【一次格式修正】\n' : mode === 'prompt' ? reviewPrompt + ' drift' : reviewPrompt
    const key = digest(['model', reviewPrompt, reviewContract])
    db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(f.id, f.scope, key, f.runId, mode === 'unknown' ? 'dispatched' : 'completed',
        mode === 'unknown' ? 'unknown' : mode === 'not_completed' ? 'output_started' : 'completed', reviewRaw, now())
    if (['format', 'page'].includes(mode)) db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,'completed','completed',?,?)`)
      .run(f.id, f.scope, digest(['model', prompt, actual]), f.runId, reviewRaw, now())
    const tables = ['source_model_runs', 'source_model_requests', 'source_model_responses', 'source_request_recovery_actions',
      'source_request_recovery_epochs', 'source_request_recovery_resolutions', 'source_request_dispatch_links', 'source_request_late_events']
    const capture = () => tables.map(table => db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(f.id))
    const before = capture(), read = sourceModelCompletedReader(f.id, f.id + '-next', mode === 'scope' ? { ...f.identity, configuration: 'drift' } : f.identity,
      mode === 'no_lineage' ? [] : [f.runId])
    const work = () => read(f.id, mode === 'model' ? 'other' : 'model', prompt, actual, signal())
    if (mode === 'unknown') await assert.rejects(work, (issue: any) => issue.code === 'source_request_unknown')
    else {
      const derived = { task_key: 'quality:initial', candidate_hash: digest('candidate'), base_input_hash: digest('base'),
        initial_request_key: digest('original'), initial_response_hash: hash(raw), correction_input_hash: hash(JSON.stringify([prompt, actual])) }
      const result = mode === 'stage' ? await withModelRequestContext({ policy: modelTaskPolicies.review, operationStage: 'format_correction' }, work)
        : mode === 'derived' ? await withDerivedSourceCorrectionRequest(derived, 'model', prompt, actual, work) : await work()
      assert.equal(result, mode === 'valid' ? reviewRaw : undefined)
    }
    assert.deepEqual(capture(), before)
  })
})

test('only the exact frozen spent correction may be read locally across an explicitly inherited ordinary owner', async t => {
  for (const kind of ['repair', 'quality'] as const) for (const mode of ['valid', 'current_response_owner', 'no_proof', 'no_lineage',
    'initial_owner', 'initial_bytes', 'initial_unknown', 'initial_unbound', 'initial_frozen', 'scope', 'model', 'request', 'hash',
    'checkpoint', 'spent', 'marker', 'unknown', 'incomplete', 'foreign_response_owner'] as const) await t.test(`${kind}:${mode}`, async () => {
    const f = await fixture(), actual = { ...contract, name: kind === 'repair' ? contract.name : 'script_source_quality' }
    const originalPrompt = initialPrompt + ' ' + kind, frozenPrompt = correctionPrompt + '\n【一次格式修正】\n' + kind
    const candidate = digest('quality candidate')
    const initialWrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { dispatch(f.id + '-frozen-origin'); return raw }, {
      completedStoryRunIds: [f.oldRun], ordinaryRepairDispatch: () => true, ordinaryQualityDispatch: () => true,
    })
    const invokeInitial = () => initialWrapped(f.id, 'model', originalPrompt, actual, signal())
    assert.equal(await (kind === 'repair' ? withInitialSourceRepairRequest(f.binding, 'model', originalPrompt, actual, invokeInitial, true)
      : withInitialSourceQualityRequest({ task_key: 'quality:initial', candidate_hash: candidate }, 'model', originalPrompt, actual, invokeInitial)), raw)
    const initialKey = digest(['model', originalPrompt, actual]), frozenHash = hash(JSON.stringify([frozenPrompt, actual])), base = digest('frozen base')
    const checkpoint: StructuredOutputCheckpoint = { input_hash: base, raw, original_raw: raw,
      correction_request: { base_input_hash: base, input_hash: frozenHash, prompt: frozenPrompt, contract: actual },
      correction_started: { input_hash: frozenHash } }
    const identity = { base_input_hash: base, initial_request_key: initialKey, initial_response_hash: hash(raw),
      correction_input_hash: frozenHash, initial_run_id: mode === 'initial_owner' ? f.oldRun : f.runId }
    const proof = kind === 'repair' ? { ...identity, kind, binding: f.binding } : { ...identity, kind, candidate_hash: candidate }
    const nextRun = f.id + '-continued', key = digest(['model', frozenPrompt, actual]), saved = 'one complete spent correction'
    db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(f.id, f.scope, key, mode === 'current_response_owner' ? nextRun : mode === 'foreign_response_owner' ? f.oldRun : f.runId,
        mode === 'unknown' ? 'dispatched' : 'completed', mode === 'unknown' ? 'unknown' : mode === 'incomplete' ? 'output_started' : 'completed', saved, now())
    if (mode === 'initial_bytes') proof.initial_response_hash = 'b'.repeat(64)
    if (mode === 'initial_unknown') db.prepare("UPDATE source_model_requests SET state='dispatched',delivery='unknown' WHERE project_id=? AND request_key=?").run(f.id, initialKey)
    if (mode === 'initial_unbound') db.prepare('DELETE FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').run(f.id, initialKey)
    if (mode === 'initial_frozen') db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`)
      .run(f.id + '-origin-frozen', f.id + '-action', f.id, f.scope, initialKey, f.runId, now())
    if (mode === 'hash') proof.correction_input_hash = 'b'.repeat(64)
    if (mode === 'checkpoint') checkpoint.input_hash = 'b'.repeat(64)
    if (mode === 'spent') checkpoint.correction = { input_hash: frozenHash, raw: saved }
    if (mode === 'marker') checkpoint.correction_started = { input_hash: 'b'.repeat(64) }
    const tables = ['source_model_runs', 'source_model_requests', 'source_model_responses', 'source_request_recovery_actions',
      'source_request_recovery_epochs', 'source_request_recovery_resolutions', 'source_request_dispatch_links', 'source_request_late_events']
    const capture = () => tables.map(table => db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(f.id))
    const before = capture(), cpBefore = structuredClone(checkpoint)
    const read = sourceModelCompletedReader(f.id, nextRun, mode === 'scope' ? { ...f.identity, configuration: 'changed' } : f.identity,
      mode === 'no_lineage' ? [] : [f.runId])
    const model = mode === 'model' ? 'other' : 'model', prompt = mode === 'request' ? frozenPrompt + ' changed' : frozenPrompt
    const work = () => read(f.id, model, prompt, actual, signal())
    const invoke = () => mode === 'no_proof' ? work() : withFrozenSourceCorrectionRead(proof, model, prompt, actual, work, checkpoint)
    if (['initial_bytes', 'hash', 'checkpoint', 'spent', 'marker', 'request'].includes(mode)) await assert.rejects(async () => invoke(), (issue: any) => issue.code === 'structured_checkpoint_identity_mismatch')
    else if (mode === 'unknown') await assert.rejects(invoke, (issue: any) => issue.code === 'source_request_unknown')
    else assert.equal(await invoke(), ['valid', 'current_response_owner'].includes(mode) ? saved : undefined)
    assert.deepEqual(capture(), before); assert.deepEqual(checkpoint, cpBefore)
  })
})
