import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-recovery-epoch-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, sourceModelRecoveryBlocked } = await import('../src/modules/script/source-model-recovery.js')
const { sourceRequestBlockers } = await import('../src/modules/script/source-request-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { backgroundTextResponse } = await import('../src/infrastructure/providers/text-background.js')
const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const identity = { source: 'exact source', model: 'model', configuration: 'unchanged' }
const args = (project: string, prompt = 'same exact prompt') => [project, 'model', prompt, undefined, new AbortController().signal] as const
const original = (project: string) => JSON.stringify(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY scope,request_key').all(project))
const actionRows = (project: string) => JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=? ORDER BY id').all(project))
async function fixture() {
  const project = randomUUID()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(project, 'isolated recovery', now(), now())
  await assert.rejects(sourceModelRecovery(project, 'old', identity, async () => {
    notifyTextRequest('dispatch', { request_id: 'old-' + project, delivery: 'unknown' })
    notifyTextRequest('metrics', { request_id: 'old-' + project, upstream_request_id: 'upstream-' + project, delivery: 'accepted' })
    throw new Error('old accepted outcome lost')
  })(...args(project)), /old accepted/)
  const row = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(project) as { scope: string; request_key: string }
  return { project, row, frozen: original(project) }
}
function authorize(project: string, row: { scope: string; request_key: string }, run = 'resumed') {
  const id = randomUUID()
  db.prepare('INSERT INTO source_request_recovery_actions (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, project, randomUUID(), randomUUID(), randomUUID(), original(project), 'a'.repeat(64), run, 'abandon_and_resume', now())
  db.prepare("INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)")
    .run(id, id, project, row.scope, row.request_key, run, now())
  return id
}

test('native dispatch IDs are exact while a legacy request never guesses an attempt identity', async () => {
  const { project, row } = await fixture()
  const native = sourceRequestBlockers(project, ['old'])[0]!
  assert.equal(native.local_request_id, 'old-' + project)
  assert.equal(native.upstream_request_id, 'upstream-' + project)
  db.prepare('DELETE FROM source_request_dispatch_links WHERE project_id=?').run(project)
  const unbound = sourceRequestBlockers(project, ['old'])[0]!
  assert.equal(unbound.identity_binding, 'unbound'); assert.equal(unbound.local_request_id, null); assert.equal(unbound.upstream_request_id, null)
  assert.equal(unbound.scope, row.scope)
})

test('one persisted permit replaces exactly one unknown request and replays its complete result after restart', async () => {
  const { project, row, frozen } = await fixture(), id = authorize(project, row)
  const audit = actionRows(project); let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { request_id: 'new-' + project }); posts++; notifyTextRequest('metrics', { request_id: 'new-' + project, upstream_request_id: 'new-upstream', delivery: 'completed' }); return 'complete replacement' }
  assert.equal(sourceModelRecoveryBlocked(project, ['old', 'resumed']), false)
  assert.equal(await sourceModelRecovery(project, 'resumed', identity, generate)(...args(project)), 'complete replacement')
  assert.equal(await sourceModelRecovery(project, 'resumed', identity, generate)(...args(project)), 'complete replacement')
  assert.equal(posts, 1)
  const epoch = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(id) as Record<string, unknown>
  assert.equal(epoch.local_request_id, 'new-' + project); assert.equal(epoch.upstream_request_id, 'new-upstream'); assert.ok(epoch.consumed_at)
  assert.equal(original(project), frozen); assert.equal(actionRows(project), audit)
})

test('a pending exact permit cannot authorize a changed prompt, schema or scope', async () => {
  for (const variant of ['prompt', 'schema', 'scope']) {
    const { project, row, frozen } = await fixture(), id = authorize(project, row); let posts = 0
    const generate = async () => { posts++; return 'must not dispatch' }
    const wrapped = sourceModelRecovery(project, 'resumed', variant === 'scope' ? { ...identity, configuration: 'changed' } : identity, generate)
    await assert.rejects(wrapped(project, 'model', variant === 'prompt' ? 'different' : args(project)[2], variant === 'schema' ? { name: 'changed', schema: { type: 'object' } } : undefined, args(project)[4]), { code: 'source_request_recovery_conflict' })
    assert.equal(posts, 0); assert.equal(original(project), frozen)
    assert.equal((db.prepare('SELECT consumed_at FROM source_request_recovery_epochs WHERE id=?').get(id) as { consumed_at: string | null }).consumed_at, null)
  }
})

test('a replacement with another unknown outcome stays blocked across reconstruction and new run IDs', async () => {
  const { project, row, frozen } = await fixture(); authorize(project, row); let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { request_id: 'unknown-new-' + project }); posts++; throw new Error('new outcome unknown') }
  await assert.rejects(sourceModelRecovery(project, 'resumed', identity, generate)(...args(project)), /outcome unknown/)
  assert.equal(sourceModelRecoveryBlocked(project, ['old', 'resumed']), true)
  for (const runId of ['resumed', 'new-explicit']) await assert.rejects(sourceModelRecovery(project, runId, identity, generate, { completedStoryRunIds: ['old', 'resumed'] })(...args(project)))
  assert.equal(posts, 1); assert.equal(original(project), frozen)
})

test('known rejection and explicitly terminated read-only responses retain their normal safe retry path', async () => {
  for (const kind of ['rejected', 'terminated']) {
    const { project, row, frozen } = await fixture(); authorize(project, row); let posts = 0
    const first = async () => {
      notifyTextRequest('dispatch', { request_id: 'first-' + project }); posts++
      if (kind === 'rejected') { notifyTextRequest('metrics', { request_id: 'first-' + project, delivery: 'rejected' }); throw new Error('rejected') }
      const issue = new TextProviderError('terminated', true, 'stream_read_error'); issue.responseTerminated = true; throw issue
    }
    const contract = kind === 'terminated' ? { name: 'script_source_quality_repair', schema: { type: 'object' } } : undefined
    // Match the exact fixture request identity for this focused transport case.
    if (contract) {
      const { createHash } = await import('node:crypto'), { canonicalAiValue } = await import('@video-studio/shared/api/ai-operations')
      const key = createHash('sha256').update(canonicalAiValue(['model', args(project)[2], contract])).digest('hex')
      db.prepare('UPDATE source_model_requests SET request_key=? WHERE project_id=?').run(key, project)
      db.prepare('UPDATE source_request_recovery_epochs SET request_key=? WHERE project_id=?').run(key, project)
    }
    await assert.rejects(sourceModelRecovery(project, 'resumed', identity, first)(project, 'model', args(project)[2], contract, args(project)[4]))
    assert.equal(sourceModelRecoveryBlocked(project, ['old', 'resumed']), false)
    const result = await sourceModelRecovery(project, 'resumed', identity, async () => { notifyTextRequest('dispatch', { request_id: 'retry-' + project }); posts++; return 'safe retry complete' })(project, 'model', args(project)[2], contract, args(project)[4])
    assert.equal(result, 'safe retry complete'); assert.equal(posts, 2)
    if (!contract) assert.equal(original(project), frozen)
  }
})

test('accepted replacement Responses resumes by exact GET on both reconstruction and compatible new runs', async t => {
  for (const newRun of [false, true]) {
    const { project, row, frozen } = await fixture(); authorize(project, row); let posts = 0, gets = 0, first = true
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { posts++; return Response.json({ id: 'resp_recovery_exact', status: 'in_progress' }) }
      gets++; if (first) { first = false; throw new Error('poll disconnected') }
      return Response.json({ id: 'resp_recovery_exact', status: 'completed', output_text: 'exact GET result' })
    })
    const generate = async (_p: string, _m: string, prompt: string, _c: unknown, signal: AbortSignal) => JSON.stringify(await (await backgroundTextResponse('https://fixture.invalid/responses', { model: 'same', input: prompt }, {}, signal, p => p, () => {})).json())
    await assert.rejects(sourceModelRecovery(project, 'resumed', identity, generate)(...args(project)), /poll disconnected/)
    assert.equal(sourceModelRecoveryBlocked(project, ['old', 'resumed']), false)
    const result = await sourceModelRecovery(project, newRun ? 'continued' : 'resumed', identity, generate, { completedStoryRunIds: ['old', 'resumed'] })(...args(project))
    assert.match(result, /exact GET result/); assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(original(project), frozen)
    t.mock.restoreAll()
  }
})

test('two prepared wrappers cannot reset a consumed dispatch or spend the permit twice', async () => {
  const { project, row, frozen } = await fixture(); const epochId = authorize(project, row)
  let release: () => void = () => {}, posts = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  const first = sourceModelRecovery(project, 'resumed', identity, async () => { await waiting; notifyTextRequest('dispatch', { request_id: 'race-first-' + project }); posts++; return 'first' })
  const second = sourceModelRecovery(project, 'resumed', identity, async () => { notifyTextRequest('dispatch', { request_id: 'race-second-' + project }); posts++; throw new Error('second unknown') })
  const pending = first(...args(project))
  await assert.rejects(second(...args(project)), /second unknown/)
  release(); await assert.rejects(pending)
  const epoch = db.prepare('SELECT state,consumed_at,local_request_id FROM source_request_recovery_epochs WHERE id=?').get(epochId) as Record<string, unknown>
  assert.equal(epoch.state, 'dispatched'); assert.ok(epoch.consumed_at); assert.equal(epoch.local_request_id, 'race-second-' + project)
  assert.equal(posts, 1); assert.equal(sourceModelRecoveryBlocked(project, ['resumed']), true); assert.equal(original(project), frozen)
})

test('late original and earlier epoch completions preserve the frozen rows and immutable audit', async () => {
  const project = randomUUID(); db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(project, 'late', now(), now())
  let releaseOld: () => void = () => {}, releaseEpoch: () => void = () => {}
  const oldWait = new Promise<void>(resolve => { releaseOld = resolve }), epochWait = new Promise<void>(resolve => { releaseEpoch = resolve })
  const old = sourceModelRecovery(project, 'old', identity, async () => { notifyTextRequest('dispatch', { request_id: 'late-old-' + project }); await oldWait; return 'late original complete' })(...args(project))
  const row = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(project) as { scope: string; request_key: string }
  const frozen = original(project); const first = authorize(project, row, 'epoch-run')
  const pending = sourceModelRecovery(project, 'epoch-run', identity, async () => { notifyTextRequest('dispatch', { request_id: 'late-epoch-' + project }); await epochWait; return 'late epoch complete' })(...args(project))
  const epochBefore = JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(first))
  authorize(project, row, 'next-run'); const audit = actionRows(project)
  releaseOld(); releaseEpoch(); await assert.rejects(old); await assert.rejects(pending)
  assert.equal(original(project), frozen); assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(first)), epochBefore)
  assert.equal(actionRows(project), audit); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM source_request_late_events WHERE project_id=?').get(project) as { n: number }).n, 2)
})

const staleCheckpoint = { analysisBinding: 'a'.repeat(64), reason: 'stale_quality_checkpoint' as const,
  checkpointHash: 'b'.repeat(64), currentCheckpointHash: 'c'.repeat(64) }
const auditContract = { name: 'script_source_quality', schema: { type: 'object' } }
const newAudit = (project: string, prompt = 'fresh independent review') => [project, 'model', prompt, auditContract, new AbortController().signal] as const

test('a bound explicit abandonment retires an obsolete unused repair permit and dispatches a separate fresh audit', async () => {
  const { project, row, frozen } = await fixture(); const id = authorize(project, row)
  const audit = actionRows(project); let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { request_id: 'fresh-audit-' + project }); posts++; return 'fresh complete audit' }
  assert.equal(await sourceModelRecovery(project, 'resumed', identity, generate, { supersededCheckpoint: staleCheckpoint })(...newAudit(project)), 'fresh complete audit')
  const epoch = db.prepare('SELECT state,consumed_at,local_request_id FROM source_request_recovery_epochs WHERE id=?').get(id) as Record<string, unknown>
  assert.deepEqual(epoch, { state: 'superseded', consumed_at: null, local_request_id: null })
  const resolution = db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE epoch_id=?').get(id) as Record<string, unknown>
  assert.equal(resolution.old_request_key, row.request_key); assert.notEqual(resolution.new_request_key, row.request_key)
  assert.equal(resolution.reason, 'stale_quality_checkpoint'); assert.equal(resolution.new_local_request_id, 'fresh-audit-' + project)
  assert.equal(resolution.checkpoint_hash, staleCheckpoint.checkpointHash); assert.equal(resolution.current_checkpoint_hash, staleCheckpoint.currentCheckpointHash)
  assert.equal(original(project).includes(frozen.slice(1, -1)), true, 'the frozen original row remains verbatim among the new ordinary audit row')
  assert.equal(actionRows(project), audit); assert.equal(posts, 1)
  assert.equal(await sourceModelRecovery(project, 'resumed', identity, generate)(...newAudit(project)), 'fresh complete audit')
  assert.equal(posts, 1, 'reconstruction replays the fresh exact completed result')
  await assert.rejects(sourceModelRecovery(project, 'resumed', identity, generate)(...args(project)), /许可.*作废/)
  assert.equal(posts, 1, 'the retired old permit never reauthorizes its original request')
})

test('supersession requires the explicit stale-checkpoint context and preserves scope, model, feedback binding and original request identity', async () => {
  for (const variant of ['absent', 'binding', 'source', 'config', 'model', 'equal-hashes', 'wrong-contract', 'non-abandonment', 'background']) {
    const { project, row, frozen } = await fixture(); const id = authorize(project, row); let posts = 0
    const context = variant === 'absent' ? undefined : { ...staleCheckpoint,
      ...(variant === 'binding' ? { analysisBinding: 'd'.repeat(64) } : {}),
      ...(variant === 'equal-hashes' ? { currentCheckpointHash: staleCheckpoint.checkpointHash } : {}) }
    const scope = variant === 'source' ? { ...identity, source: 'changed' } : variant === 'config' ? { ...identity, configuration: 'changed' } : identity
    if (variant === 'non-abandonment') db.prepare("UPDATE source_request_recovery_actions SET decision='unrelated' WHERE id=?").run(id)
    if (variant === 'background') db.prepare("UPDATE source_model_requests SET response_key='background' WHERE project_id=?").run(project)
    const before = original(project)
    await assert.rejects(sourceModelRecovery(project, 'resumed', scope, async () => { posts++; return 'must not call' }, { supersededCheckpoint: context })(project,
      variant === 'model' ? 'other-model' : 'model', newAudit(project)[2], variant === 'wrong-contract' ? { ...auditContract, name: 'script_source_quality_repair' } : auditContract, newAudit(project)[4]))
    assert.equal(posts, 0); assert.equal(original(project), before)
    assert.equal((db.prepare('SELECT state FROM source_request_recovery_epochs WHERE id=?').get(id) as { state: string }).state, 'prepared')
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM source_request_recovery_resolutions WHERE project_id=?').get(project) as { n: number }).n, 0)
  }
})

test('new unknown audit needs its own confirmation and never inherits the abandoned repair permit', async () => {
  const { project, row } = await fixture(); authorize(project, row); let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { request_id: 'unknown-audit-' + project }); posts++; throw new Error('new audit outcome unknown') }
  await assert.rejects(sourceModelRecovery(project, 'resumed', identity, generate, { supersededCheckpoint: staleCheckpoint })(...newAudit(project)), /audit outcome unknown/)
  const blockers = sourceRequestBlockers(project, ['old', 'resumed'])
  assert.equal(blockers.length, 1); assert.notEqual(blockers[0]!.request_key, row.request_key)
  await assert.rejects(sourceModelRecovery(project, 'resumed', identity, generate, { supersededCheckpoint: staleCheckpoint })(...newAudit(project)))
  assert.equal(posts, 1)
})

test('concurrent fresh audits cannot retire the same prepared permit twice and rollback leaves it available', async () => {
  const { project, row } = await fixture(); const id = authorize(project, row); let posts = 0, release: () => void = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const slow = sourceModelRecovery(project, 'resumed', identity, async () => { await wait; notifyTextRequest('dispatch', { request_id: 'late-fresh-' + project }); posts++; return 'late' }, { supersededCheckpoint: staleCheckpoint })(...newAudit(project, 'slow audit'))
  const fast = sourceModelRecovery(project, 'resumed', identity, async () => { notifyTextRequest('dispatch', { request_id: 'first-fresh-' + project }); posts++; return 'first' }, { supersededCheckpoint: staleCheckpoint })(...newAudit(project, 'fast audit'))
  assert.equal(await fast, 'first'); release(); await assert.rejects(slow)
  assert.equal(posts, 1); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM source_request_recovery_resolutions WHERE epoch_id=?').get(id) as { n: number }).n, 1)
  const second = await fixture(); const secondId = authorize(second.project, second.row)
  db.exec("CREATE TRIGGER reject_resolution BEFORE INSERT ON source_request_recovery_resolutions WHEN NEW.project_id='" + second.project + "' BEGIN SELECT RAISE(ABORT,'resolution unavailable'); END")
  try {
    await assert.rejects(sourceModelRecovery(second.project, 'resumed', identity, async () => { notifyTextRequest('dispatch', { request_id: 'rollback-new' }); posts++; return 'must not fetch' }, { supersededCheckpoint: staleCheckpoint })(...newAudit(second.project)), /resolution unavailable/)
    assert.equal((db.prepare('SELECT state FROM source_request_recovery_epochs WHERE id=?').get(secondId) as { state: string }).state, 'prepared')
    assert.equal(posts, 1)
  } finally { db.exec('DROP TRIGGER reject_resolution') }
})

test('a superseded prepared epoch rejects late exact completions, response writes and identity supplements', async t => {
  const { project, row } = await fixture(); const id = authorize(project, row)
  let releaseExact: () => void = () => {}, releaseBackground: () => void = () => {}, posts = 0
  const exactWait = new Promise<void>(resolve => { releaseExact = resolve }), backgroundWait = new Promise<void>(resolve => { releaseBackground = resolve })
  const lateExact = sourceModelRecovery(project, 'resumed', identity, async () => { await exactWait; return 'late exact result' })(...args(project))
  const lateBackground = sourceModelRecovery(project, 'resumed', identity, async (_p, _m, prompt, _c, signal) => {
    await backgroundWait
    return JSON.stringify(await (await backgroundTextResponse('https://fixture.invalid/responses', { model: 'same', input: prompt }, {}, signal, p => p, () => {})).json())
  })(...args(project))
  t.mock.method(globalThis, 'fetch', async () => { posts++; return Response.json({ id: 'resp_forbidden_late', status: 'completed', output_text: 'must not happen' }) })
  const fresh = await sourceModelRecovery(project, 'resumed', identity, async () => { notifyTextRequest('dispatch', { request_id: 'supersede-fresh-' + project }); return 'fresh result' }, { supersededCheckpoint: staleCheckpoint })(...newAudit(project))
  assert.equal(fresh, 'fresh result')
  const epoch = JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(id))
  const responses = JSON.stringify(db.prepare('SELECT * FROM source_model_responses WHERE project_id=?').all(project))
  releaseExact(); releaseBackground()
  await assert.rejects(lateExact, /晚于新的恢复决定/); await assert.rejects(lateBackground)
  const { recordSourceUpstream } = await import('../src/modules/script/source-request-recovery.js')
  recordSourceUpstream('unbound-old', 'late-upstream', id)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(id)), epoch)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_model_responses WHERE project_id=?').all(project)), responses)
  assert.equal(posts, 0)
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM source_request_late_events WHERE project_id=? AND epoch_id=?').get(project, id) as { n: number }).n >= 1)
})
