import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { StructuredOutputCheckpoint, OutputContract } from '../src/modules/generation/model-output.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-source-admission-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, sourceModelAdmissionFact, applyTrustedNotSentToCheckpoint } = await import('../src/modules/script/source-model-recovery.js')
const { generateStructuredOutput } = await import('../src/modules/generation/model-output.js')
const { currentStructuredDispatchIntent } = await import('../src/modules/generation/model-request-admission.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { withModelRequestContext, modelTaskPolicies } = await import('../src/modules/generation/model-task-policy.js')
const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
const { backgroundTextResponse } = await import('../src/infrastructure/providers/text-background.js')
const { withInitialSourceRepairRequest, sourceRepairReferencePolicy } = await import('../src/modules/script/source-repair-request-identity.js')
const { createScriptRequestUsage } = await import('@video-studio/shared/script/script-request-usage')
const { beginTextRequest, beginAcceptedTextResponsePoll, withTextRequestUsage } = await import('../src/infrastructure/providers/text-request-usage.js')
initDb()
db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'local admission fixture', now(), now())
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const schema = z.object({ value: z.string() }).strict()
const clone = <T>(value: T): T => structuredClone(value)
const signal = () => new AbortController().signal
const binding = { policy: sourceRepairReferencePolicy, finding_index: 0, checkpoint_hash: 'a'.repeat(64),
  finding_hash: 'b'.repeat(64), review_hash: 'c'.repeat(64), findings_hash: 'd'.repeat(64), current_hash: 'e'.repeat(64) }

function harness(runId: string, provider: Parameters<typeof sourceModelRecovery>[3],
  options: Parameters<typeof sourceModelRecovery>[4] = {}) {
  const checkpoint: StructuredOutputCheckpoint = {}, snapshots: StructuredOutputCheckpoint[] = []
  const wrapped = sourceModelRecovery('p', runId, { model: 'model', source: runId }, provider, options)
  const run = (admit?: (prompt: string, contract: OutputContract, work: () => Promise<string>) => Promise<string>) =>
    generateStructuredOutput('script_source_quality_repair', schema, (prompt, contract) => {
      assert.ok(contract)
      const work = () => wrapped('p', 'model', prompt, contract, signal())
      return admit ? admit(prompt, contract, work) : work()
    }, 'same task ' + runId, { checkpoint, guardInitialDispatch: true, freezeCorrection: true,
      preserveInputIdentity: true, persistCheckpoint: () => { snapshots.push(clone(checkpoint)) } })
  return { checkpoint, snapshots, run }
}
const intentQuery = (runId: string, checkpoint: StructuredOutputCheckpoint, phase: 'initial' | 'correction' = 'initial') => {
  const marker = phase === 'initial' ? checkpoint.initial_started : checkpoint.correction_started
  assert.ok(marker?.intent_id)
  return { run_ids: [runId], input_hash: marker.input_hash, phase, intent_id: marker.intent_id }
}

test('a trusted local gate journals exact intent before releasing only that attempt; empty and legacy ledgers stay unknown', async () => {
  let providerCalls = 0
  const h = harness('gate', async () => { providerCalls++; return '{"value":"never"}' }, { ordinaryRepairDispatch: () => false })
  await assert.rejects(h.run((prompt, contract, work) => withInitialSourceRepairRequest(binding, 'model', prompt, contract, work, true)),
    issue => (issue as { code?: string; delivery?: string }).code === 'source_request_sibling_pending' &&
      (issue as { delivery?: string }).delivery === 'not_sent')
  assert.equal(providerCalls, 0); assert.equal(h.checkpoint.initial_started, undefined)
  const original = h.snapshots.find(saved => saved.initial_started)!
  const query = intentQuery('gate', original)
  const fact = sourceModelAdmissionFact('p', query)
  assert.equal(fact.verdict, 'trusted_not_sent'); assert.ok(fact.evidence?.evidence_hash)
  assert.equal(fact.initial_input_hash, original.input_hash)
  for (const changed of [{ ...query, intent_id: 'wrong' }, { ...query, phase: 'correction' as const },
    { ...query, input_hash: 'f'.repeat(64) }, { ...query, run_ids: ['wrong-run'] }, { ...query, intent_id: undefined }]) {
    assert.equal(sourceModelAdmissionFact('p', changed).verdict, 'unknown')
  }
  const restored = clone(original)
  assert.equal(applyTrustedNotSentToCheckpoint(restored, clone(fact)), false, 'a JSON lookalike is not authority')
  restored.initial_started!.intent_id = 'stale'
  assert.equal(applyTrustedNotSentToCheckpoint(restored, fact), false)
  restored.initial_started = clone(original.initial_started)
  assert.equal(applyTrustedNotSentToCheckpoint(restored, fact), true)
  assert.equal(restored.initial_started, undefined)
  const before = db.prepare('SELECT COUNT(*) n FROM source_model_admission_events').get() as { n: number }
  sourceModelAdmissionFact('p', query)
  assert.deepEqual(db.prepare('SELECT COUNT(*) n FROM source_model_admission_events').get(), before, 'facts are read-only')
  db.prepare(`INSERT INTO source_request_late_events
    (id,project_id,scope,request_key,run_id,state,delivery,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('gate-late', 'p', fact.evidence!.scope, fact.evidence!.request_key, 'gate', 'dispatched', 'unknown', now())
  assert.equal(applyTrustedNotSentToCheckpoint(clone(original), fact), false, 'a late event invalidates the original fact')
  assert.equal(sourceModelAdmissionFact('p', query).verdict, 'unknown')
})

test('journal and observer denial roll back dispatch identity before fetch and preserve the durable pre-dispatch intent evidence', async () => {
  for (const failure of ['journal', 'observer'] as const) {
    let posts = 0
    const runId = 'denial-' + failure
    const h = harness(runId, async () => {
      const intent = currentStructuredDispatchIntent()
      assert.equal(intent?.intent_id, h.checkpoint.initial_started?.intent_id)
      assert.ok(h.snapshots.at(-1)?.initial_started, 'intent is durable before dispatch')
      notifyTextRequest('dispatch', { request_id: runId + '-local', delivery: 'unknown' })
      posts++; return '{"value":"never"}'
    })
    if (failure === 'journal') db.exec(`CREATE TRIGGER reject_local_journal BEFORE UPDATE ON source_model_requests WHEN NEW.state='dispatched' AND NEW.run_id='${runId}' BEGIN SELECT RAISE(ABORT,'fixture journal denial'); END`)
    try {
      await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation,
        onDispatch: () => { if (failure === 'observer') throw new Error('fixture observer denial') } }, () => h.run()), /fixture .* denial/)
    } finally { if (failure === 'journal') db.exec('DROP TRIGGER reject_local_journal') }
    assert.equal(posts, 0); assert.equal(h.checkpoint.initial_started, undefined)
    assert.equal((db.prepare('SELECT COUNT(*) n FROM source_request_dispatch_links WHERE run_id=?').get(runId) as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT state FROM source_model_requests WHERE run_id=?').get(runId) as { state: string }).state, 'prepared')
    const original = h.snapshots.find(saved => saved.initial_started)!
    const fact = sourceModelAdmissionFact('p', intentQuery(runId, original))
    assert.equal(fact.verdict, 'trusted_not_sent'); assert.equal(fact.evidence?.reason_code, 'source_dispatch_journal')
    db.prepare("UPDATE source_model_requests SET delivery='accepted' WHERE run_id=?").run(runId)
    assert.equal(applyTrustedNotSentToCheckpoint(clone(original), fact), false, 'a changed ledger invalidates an old fact')
    assert.equal(sourceModelAdmissionFact('p', intentQuery(runId, original)).verdict, 'unknown')
  }
})

test('a failed denial audit fails closed and cannot release the structured guard', async () => {
  const h = harness('audit-fails', async () => assert.fail('provider must not enter'), { ordinaryRepairDispatch: () => false })
  db.exec("CREATE TRIGGER reject_local_audit BEFORE INSERT ON source_model_admission_events WHEN NEW.run_id='audit-fails' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
  try {
    await assert.rejects(h.run((prompt, contract, work) => withInitialSourceRepairRequest(binding, 'model', prompt, contract, work, true)), /fixture audit failure/)
  } finally { db.exec('DROP TRIGGER reject_local_audit') }
  assert.ok(h.checkpoint.initial_started)
  assert.equal(sourceModelAdmissionFact('p', intentQuery('audit-fails', h.checkpoint)).verdict, 'unknown')
})

test('lookalike not_sent, misleading provider not_sent after dispatch, and completion conflicts retain the dispatch barrier', async () => {
  for (const kind of ['lookalike', 'provider', 'completion'] as const) {
    let posts = 0
    const runId = 'sent-' + kind
    const h = harness(runId, async () => {
      notifyTextRequest('dispatch', { request_id: runId + '-local', delivery: 'unknown' }); posts++
      if (kind === 'completion') return '{"value":"complete but local persistence failed"}'
      const error = kind === 'provider' ? new TextProviderError('fixture misleading not_sent', false) : new Error('fixture misleading not_sent')
      throw Object.assign(error, { delivery: 'not_sent' })
    })
    if (kind === 'completion') db.exec(`CREATE TRIGGER reject_admission_complete BEFORE UPDATE ON source_model_requests WHEN NEW.state='completed' AND NEW.run_id='${runId}' BEGIN SELECT RAISE(ABORT,'fixture completion conflict'); END`)
    try { await assert.rejects(h.run(), /fixture/) }
    finally { if (kind === 'completion') db.exec('DROP TRIGGER reject_admission_complete') }
    assert.equal(posts, 1); assert.ok(h.checkpoint.initial_started)
    const fact = sourceModelAdmissionFact('p', intentQuery(runId, h.checkpoint))
    assert.notEqual(fact.verdict, 'trusted_not_sent')
    assert.equal((db.prepare('SELECT COUNT(*) n FROM source_model_admission_events WHERE run_id=? AND outcome=\'denied\'').get(runId) as { n: number }).n, 0)
    await assert.rejects(h.run(), /上次初始请求/); assert.equal(posts, 1)
  }
})

test('an accepted response and its token reservation survive a poll budget denial', async () => {
  const usage = createScriptRequestUsage()
  const h = harness('accepted-budget', async () => {
    const reservation = beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10 })
    notifyTextRequest('dispatch', { request_id: 'accepted-budget-local', delivery: 'unknown' })
    reservation.identify('resp_admission_accepted')
    notifyTextRequest('metrics', { request_id: 'accepted-budget-local', delivery: 'accepted' })
    beginAcceptedTextResponsePoll('resp_admission_accepted', 12)
    return assert.fail('poll denied')
  })
  await withTextRequestUsage({ usage, limits: { max_total_requests: 1 } }, async () => {
    await assert.rejects(h.run(), issue => (issue as { delivery?: string }).delivery === 'accepted')
  })
  assert.ok(h.checkpoint.initial_started); assert.equal(usage.requests, 1)
  assert.equal(usage.pending_requests[0]?.id, 'resp_admission_accepted')
  assert.notEqual(sourceModelAdmissionFact('p', intentQuery('accepted-budget', h.checkpoint)).verdict, 'trusted_not_sent')
})

test('a denied correction releases only its exact marker and retains original bytes plus the frozen correction request', async () => {
  let calls = 0, posts = 0
  const h = harness('correction-denial', async () => {
    calls++
    const intent = currentStructuredDispatchIntent()
    assert.equal(intent?.phase, calls === 1 ? 'initial' : 'correction')
    assert.ok(h.snapshots.at(-1)?.[calls === 1 ? 'initial_started' : 'correction_started'])
    notifyTextRequest('dispatch', { request_id: 'correction-local-' + calls, delivery: 'unknown' })
    posts++; return calls === 1 ? '{"value":7}' : '{"value":"repaired"}'
  })
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation,
    onDispatch: () => { if (calls > 1) throw new Error('fixture correction denial') } }, () => h.run()), /fixture correction denial/)
  assert.equal(calls, 2); assert.equal(posts, 1)
  assert.equal(h.checkpoint.correction_started, undefined); assert.equal(h.checkpoint.original_raw, '{"value":7}')
  assert.ok(h.checkpoint.correction_request); assert.equal(h.checkpoint.correction, undefined)
  const original = h.snapshots.find(saved => saved.correction_started)!
  const fact = sourceModelAdmissionFact('p', intentQuery('correction-denial', original, 'correction'))
  assert.equal(fact.verdict, 'trusted_not_sent')
  const restored = clone(original)
  assert.equal(applyTrustedNotSentToCheckpoint(restored, fact), true)
  assert.equal(restored.raw, original.raw); assert.deepEqual(restored.correction_request, original.correction_request)
})

test('a real background pre-dispatch denial removes only its newly-created creating marker with zero fetch calls', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++
    return Response.json({ id: 'resp_local_denial_retried', status: 'completed', output_text: '{"value":"complete"}' })
  })
  const h = harness('background-denial', async (_project, _model, prompt, _contract, requestSignal) => {
    const response = await backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: prompt }, {},
      requestSignal, value => value, () => {})
    return (await response.json() as { output_text: string }).output_text
  })
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation,
    onDispatch: () => { throw new Error('fixture background admission denial') } }, () => h.run()), /fixture background admission denial/)
  assert.equal(fetches, 0); assert.equal(h.checkpoint.initial_started, undefined)
  const saved = h.snapshots.find(item => item.initial_started)!
  const fact = sourceModelAdmissionFact('p', intentQuery('background-denial', saved))
  assert.equal(fact.verdict, 'trusted_not_sent')
  assert.equal((db.prepare('SELECT COUNT(*) n FROM source_model_responses WHERE project_id=? AND scope=?')
    .get('p', fact.evidence!.scope) as { n: number }).n, 0)
  assert.deepEqual(await h.run(), { value: 'complete' }); assert.equal(fetches, 1)
})

test('a pre-existing uncertain background creating marker remains protected and is never cleaned as this attempt', async t => {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('fixture after POST connection lost') })
  const provider: Parameters<typeof sourceModelRecovery>[3] = async (_project, _model, prompt, _contract, requestSignal) => {
    const response = await backgroundTextResponse('https://fixture.invalid/responses', { model: 'fixture', input: prompt }, {},
      requestSignal, value => value, () => {})
    return JSON.stringify(await response.json())
  }
  const original = harness('old-background-creating', provider)
  await assert.rejects(original.run(), /fixture after POST/)
  const rows = db.prepare('SELECT * FROM source_model_responses WHERE payload=?').all('{"state":"creating"}')
  assert.equal(rows.length, 1)
  const restarted = harness('old-background-creating', provider)
  await assert.rejects(restarted.run(), /上次后台请求是否被接受尚不确定/)
  assert.equal(fetches, 1); assert.ok(restarted.checkpoint.initial_started)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_responses WHERE payload=?').all('{"state":"creating"}'), rows)
  assert.notEqual(sourceModelAdmissionFact('p', intentQuery('old-background-creating', restarted.checkpoint)).verdict, 'trusted_not_sent')
})
