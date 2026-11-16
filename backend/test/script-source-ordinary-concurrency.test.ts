import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { withInitialSourceStoryRequest } from '../src/modules/script/source-story-dispatch-identity.js'
import { createSourceStoryDispatchGrant, hasFailedSourceStoryDispatch, sourceStoryDispatchAuthorized } from '../src/modules/script/script-source-ordinary-dispatch.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'source-ordinary-concurrency-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { initSourceModelRecovery, sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { sourceRequestBlockers } = await import('../src/modules/script/source-request-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
initDb()
initSourceModelRecovery()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const contract = { name: 'script_source_story_characters_merge', schema: { type: 'object' } }
const proof = { task_key: 'characters_merge:new', candidate_hash: 'a'.repeat(64) }
let sequence = 0

async function fixture(withEpoch: boolean) {
  const projectId = 'ordinary-concurrent-' + sequence++, oldRun = projectId + '-old', runId = projectId + '-current', stamp = now()
  const identity = { source: projectId + '-source', model: 'model', configuration: 'configuration' }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(projectId, projectId, stamp, stamp)
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: projectId, filename: 'source.txt', content: '原稿保持不变。', updated_at: stamp }
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)')
    .run(projectId, document.filename, document.content, stamp)
  const oldContract = { name: 'script_source_story_uncertainties', schema: { type: 'object' } }
  const oldRow = { scope: digest(identity), request_key: digest(['model', 'old exact correction', oldContract]) }
  if (withEpoch) {
    await assert.rejects(sourceModelRecovery(projectId, oldRun, identity, async () => {
    notifyTextRequest('dispatch', { request_id: projectId + '-old-request', delivery: 'unknown' })
    throw new Error('retained old unknown request')
  })(projectId, 'model', 'old exact correction', oldContract, new AbortController().signal), /retained old unknown/)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`)
    .run(projectId + '-action', projectId, projectId + '-client', runId, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`)
    .run(projectId + '-epoch', projectId + '-action', projectId, oldRow.scope, oldRow.request_key, runId, stamp)
  }

  const state: ScriptSourceAnalysis = { id: runId, source_version: identity.source, model_id: 'model', configuration_hash: identity.configuration,
    status: 'queued', completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: stamp, phase: 'synthesis',
    story_work: { input_hash: 'story-work', tasks: [
      { key: 'timeline:0', output_candidate: { context_hash: 'sibling-candidate', checkpoint: {
        input_hash: 'sibling-input', initial_started: { input_hash: 'sibling-input' },
      } } },
      { key: proof.task_key, output_candidate: { context_hash: proof.candidate_hash, checkpoint: {} } },
    ] } }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant({ document, state, configuration_hash: identity.configuration, local_active: false })
  state.status = 'running'
  // The producer persists this marker before entering its model adapter.
  state.story_work!.tasks[1]!.output_candidate!.checkpoint = { input_hash: 'target-input', initial_started: { input_hash: 'target-input' } }
  const save = () => db.prepare(`INSERT OR REPLACE INTO script_source_analyses
    (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(projectId, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  save()
  const checks: Array<{ allowed: boolean; unknown: boolean }> = []
  // Match the analyzer's production callback: reload both persisted objects at
  // each check, and distinguish terminal unknown from ordinary in-flight work.
  const authorize = (request: Parameters<typeof sourceStoryDispatchAuthorized>[1]) => {
    const currentDocument = db.prepare('SELECT project_id,filename,content,updated_at FROM script_source_documents WHERE project_id=?')
      .get(projectId) as Omit<ScriptSourceDocument, 'analysis'>
    const row = db.prepare('SELECT id,status,snapshot FROM script_source_analyses WHERE project_id=?')
      .get(projectId) as { id: string; status: string; snapshot: string }
    if (row.id !== runId || row.status !== 'running') return false
    const current = JSON.parse(row.snapshot) as ScriptSourceAnalysis
    const unknown = (!current.story_work || hasFailedSourceStoryDispatch(current)) &&
      sourceRequestBlockers(projectId, [runId]).some(item => item.run_id === runId && item.request_key !== request.request_key)
    const allowed = sourceStoryDispatchAuthorized({ document: currentDocument, state: current,
      configuration_hash: identity.configuration, local_active: true, current_run_unknown: unknown }, request)
    checks.push({ allowed, unknown })
    if (unknown) throw Object.assign(new Error('same-run sibling has a terminal unknown request'), {
      statusCode: 409, code: 'source_request_unknown', failure_stage: 'recovery', delivery: 'not_sent', retryable: false,
    })
    return allowed
  }
  const siblingKey = digest(['model', 'same-run sibling', { name: 'script_source_story_timeline', schema: { type: 'object' } }])
  const addSiblingDispatch = (failed: boolean) => {
    db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
      VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`)
      .run(projectId, oldRow.scope, siblingKey, runId, stamp)
    if (failed) state.story_work!.tasks[0]!.failure = { code: 'source_request_unknown', message: 'same-run response terminated without a result' }
    save()
  }
  const retainedEvidence = () => ({
    requests: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key IN (?,?) ORDER BY request_key')
      .all(projectId, oldRow.request_key, siblingKey),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=? ORDER BY sequence').all(projectId),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(projectId),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(projectId),
  })
  return { projectId, runId, oldRun, identity, checks, authorize, addSiblingDispatch, retainedEvidence }
}

for (const withEpoch of [false, true]) for (const failed of [false, true]) test((failed
  ? 'a sibling that fails unknown while an independently granted request waits blocks its final dispatch without settling unknown evidence'
  : 'a healthy same-run in-flight sibling preserves the independently granted parallel dispatch and its exact recovery permit') +
  (withEpoch ? ' with a retained sibling permit' : ' without a sibling permit'), async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('isolated concurrency tests must not use network'))
  const f = await fixture(withEpoch)
  let entered!: () => void, release!: () => void, posts = 0
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const wrapped = sourceModelRecovery(f.projectId, f.runId, f.identity, async () => {
    entered()
    await gate
    notifyTextRequest('dispatch', { request_id: f.projectId + '-target', delivery: 'unknown' })
    posts++
    return 'complete independent result'
  }, { completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: f.authorize })
  const result = withInitialSourceStoryRequest(proof, 'model', 'new merge task', contract,
    () => wrapped(f.projectId, 'model', 'new merge task', contract, new AbortController().signal))
  const outcome = result.then(value => ({ value }), error => ({ error }))
  await waiting
  assert.deepEqual(f.checks, [{ allowed: true, unknown: false }], 'first adapter check succeeds before the sibling changes')
  f.addSiblingDispatch(failed)
  const before = f.retainedEvidence()
  release()
  const settled = await outcome
  if (failed) {
    assert.ok('error' in settled)
    assert.equal(settled.error.code, 'source_request_unknown')
    assert.equal(settled.error.delivery, 'not_sent')
    assert.equal(posts, 0)
    assert.deepEqual(f.checks.at(-1), { allowed: false, unknown: true })
  } else {
    assert.deepEqual(settled, { value: 'complete independent result' })
    assert.equal(posts, 1)
    assert.deepEqual(f.checks.at(-1), { allowed: true, unknown: false })
  }
  assert.deepEqual(f.retainedEvidence(), before, 'a new task must not change an unknown sibling or its recovery action/epoch')
  const targetKey = digest(['model', 'new merge task', contract])
  const target = db.prepare('SELECT state,delivery FROM source_model_requests WHERE project_id=? AND request_key=?')
    .get(f.projectId, targetKey) as { state: string; delivery: string }
  assert.deepEqual(target, failed ? { state: 'prepared', delivery: 'not_sent' } : { state: 'completed', delivery: 'completed' })
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean, description: string) {
  for (let i = 0; i < 200 && !check(); i++) await setImmediate()
  assert.ok(check(), description)
}

for (const failed of [false, true]) test(failed
  ? 'the actual analyzer rejects a delayed sibling POST after same-run unknown failure even with no prepared epoch'
  : 'the actual analyzer permits a delayed sibling POST during healthy same-run streaming with no prepared epoch', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('analyzer concurrency tests must not use network'))
  const projectId = 'analyzer-concurrent-' + sequence++, stamp = now()
  const content = '第一章：林舟保存信件，最后回家。\n' + '原文记载城中人物保存全部线索。'.repeat(2400)
  assert.ok(content.length > 32_000)
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(projectId, projectId, stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)')
    .run(projectId, 'parallel.txt', content, stamp)
  const oldConcurrency = process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
  process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = '2'
  const overviewEntered = gate(), targetEntered = gate(), releaseOverview = gate(), releaseTarget = gate(), targetReturned = gate()
  let targetPosts = 0, targetError: { code?: string; delivery?: string } | undefined
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, output) => {
    if (output?.name === 'script_source_story_overview') {
      notifyTextRequest('dispatch', { request_id: projectId + '-overview', delivery: 'unknown' })
      overviewEntered.resolve(); await releaseOverview.promise
      if (failed) throw Object.assign(new Error('same-run overview response was lost'), { code: 'fixture_unknown_response' })
    } else if (output?.name === 'script_source_story_characters') {
      targetEntered.resolve(); await releaseTarget.promise
      try {
        notifyTextRequest('dispatch', { request_id: projectId + '-characters', delivery: 'unknown' })
        targetPosts++
      } catch (issue) { targetError = issue as typeof targetError; throw issue }
      finally { targetReturned.resolve() }
    } else if (prompt.includes('【全剧整合资料】')) assert.fail('the test pauses before later synthesis tasks')
    const answer = sourceAnalysisFixture(prompt)
    assert.ok(answer, output?.name)
    return answer
  }, { reading: 5000, repairing: 5000, synthesis: 5000 }, { configuration: () => ({ isolated: 'concurrency' }) })
  try {
    const started = analyzer.start(projectId, 'model', { explicitDispatch: true, sourceUpdatedAt: stamp })
    let entryTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.all([overviewEntered.promise, targetEntered.promise]), new Promise((_, reject) => {
        entryTimeout = setTimeout(() => reject(new Error(scriptSourceAnalysis(projectId)?.error || 'initial concurrent tasks did not start')), 2500)
      })])
    } finally { clearTimeout(entryTimeout) }
    if (failed) {
      releaseOverview.resolve()
      await until(() => !!scriptSourceAnalysis(projectId)?.story_work?.tasks.find(task => task.key === 'overview')?.failure,
        'the real producer must durably record the failed sibling before the target dispatches')
    }
    const unknownBefore = db.prepare("SELECT * FROM source_model_requests WHERE project_id=? AND run_id=? AND state='dispatched'").all(projectId, started.id)
    assert.equal(unknownBefore.length, 1)
    assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_recovery_epochs WHERE project_id=?').get(projectId) as { n: number }).n, 0)
    releaseTarget.resolve(); await targetReturned.promise
    assert.equal(targetPosts, failed ? 0 : 1)
    if (failed) {
      assert.equal(targetError?.code, 'source_request_unknown')
      assert.equal(targetError?.delivery, 'not_sent')
      await until(() => scriptSourceAnalysis(projectId)?.status === 'failed', 'the analyzer must settle after both branches return')
    } else {
      assert.equal(targetError, undefined)
      analyzer.pause(projectId, started.id)
    }
    const unknownAfter = db.prepare("SELECT * FROM source_model_requests WHERE project_id=? AND run_id=? AND state='dispatched' AND request_key=?")
      .all(projectId, started.id, (unknownBefore[0] as { request_key: string }).request_key)
    assert.deepEqual(unknownAfter, unknownBefore, 'the real callback must preserve the sibling unknown ledger')
  } finally {
    releaseTarget.resolve(); releaseOverview.resolve(); await analyzer.close()
    if (oldConcurrency === undefined) delete process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
    else process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = oldConcurrency
  }
})
