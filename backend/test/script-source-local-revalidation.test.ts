import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'source-local-revalidation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { synthesizeSourceStoryParts, sourceStorySchema } = await import('../src/modules/script/script-source-story-parts.js')
const { sourceModelAdmissionDenied } = await import('../src/modules/script/source-model-admission.js')
const { currentStructuredDispatchIntent } = await import('../src/modules/generation/model-request-admission.js')
initDb()
assert.ok(db.name.startsWith(directory), 'all test state must stay inside the isolated database')
const configuration = { fixture: 'local-revalidation' }
let currentConfiguration: unknown = configuration, providerCalls = 0, allowProvider = false
const app = Fastify()
app.setErrorHandler((issue: Error & { statusCode?: number }, _request, reply) => reply.code(issue.statusCode || 500).send({ detail: issue.message }))
registerScriptSourceRoutes(app, { analysisConfiguration: () => currentConfiguration, generateText: async (_project, _model, prompt) => {
  providerCalls++
  assert.equal(allowProvider, true, 'local revalidation must never enter the provider generator')
  return sourceAnalysisFixture(prompt)!
} })
await app.ready()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const tables = ['source_model_runs', 'source_model_requests', 'source_model_responses', 'source_request_recovery_actions',
  'source_request_recovery_epochs', 'source_request_recovery_resolutions', 'source_request_dispatch_links', 'source_request_late_events']
const ledger = (id: string) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`).all(id)]))
const stored = (id: string) => db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(id)
const path = (id: string) => `/api/projects/${id}/script/source/analysis`
const localPost = (f: Awaited<ReturnType<typeof fixture>>, payload = { analysis_id: f.state.id, source_updated_at: f.stamp }) =>
  app.inject({ method: 'POST', url: path(f.id) + '/revalidate', payload })

async function fixture(mode: 'empty' | 'saved' | 'format' = 'empty') {
  const id = newId(), stamp = now(), content = '本稿只有一条记载：旧钟无人修复。'
  const source = { project_id: id, filename: 'local.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated local revalidation', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, source.filename, content, stamp)
  const state: any = { id: newId(), source_version: scriptSourceVersion(source), model_id: 'fixture', configuration_hash: sourceAnalysisConfigurationHash(configuration),
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, pipeline_version: sourceAnalysisPipelineVersion,
    error: 'saved fixture', updated_at: stamp, sections: [{ offset: 0, length: content.length, title: '原稿', summary: content, characters: [], events: [], open_threads: [] }] }
  const scope = digest({ source: state.source_version, model: state.model_id, configuration: state.configuration_hash })
  const controller = new AbortController(), initialRequests: Array<{ prompt: string; contract: any; raw?: string }> = []
  await assert.rejects(() => synthesizeSourceStoryParts(state, async (prompt, contract) => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('【全剧整合资料】\n') + '【全剧整合资料】\n'.length))
    if (input.part.kind === 'overview' && !prompt.includes('【一次格式修正】')) {
      const raw = mode === 'saved' ? sourceAnalysisFixture(prompt)! : 'not JSON'
      initialRequests.push({ prompt, contract, ...(mode === 'empty' ? {} : { raw }) })
      if (mode === 'saved') { controller.abort(new Error('synthetic interruption after complete response')); return raw }
      if (mode === 'format') return raw
    }
    throw sourceModelAdmissionDenied(id, state.id, scope, digest(['fixture', prompt, contract]), currentStructuredDispatchIntent(),
      'source_admission_gate', Object.assign(new Error('synthetic pre-dispatch denial'), { code: 'source_request_sibling_pending' }))
  }, () => {}, controller.signal, { filename: source.filename, content: source.content },
  [{ covered_section_ids: [0], section: { ...state.sections[0], id: 0 } }], value => sourceStorySchema.parse(value)))
  state.status = 'failed'; state.error = 'saved fixture'
  const save = () => db.prepare(`INSERT OR REPLACE INTO script_source_analyses
    (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  if (mode !== 'empty') {
    const initial = initialRequests[0]!
    db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
      VALUES (?,?,?,?,'completed','completed',?,NULL,?)`).run(id, scope, digest(['fixture', initial.prompt, initial.contract]), state.id, initial.raw!, stamp)
  }
  save()
  return { id, stamp, state, source, scope, save, initialRequests }
}
function oldPermit(f: Awaited<ReturnType<typeof fixture>>) {
  const key = digest(['retained old unknown']), oldRun = f.id + '-old', action = f.id + '-action'
  f.state.story_response_run_ids = [oldRun]
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
    VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`).run(f.id, f.scope, key, oldRun, f.stamp)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','fixture',?,'abandon_and_resume',?)`).run(action, f.id, f.id + '-client', f.state.id, f.stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`)
    .run(f.id + '-epoch', action, f.id, f.scope, key, f.state.id, f.stamp)
  f.save()
}
const remove = (id: string) => db.prepare('DELETE FROM projects WHERE id=?').run(id)
async function terminal(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = scriptSourceAnalysis(id)!
    if (['ready', 'failed', 'paused'].includes(value.status)) return value
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail('mocked analysis did not reach a terminal state')
}

test('local endpoint reuses complete saved bytes without providers, new ledger rows or old permit mutations', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local endpoint must not use network'))
  const f = await fixture('saved'); oldPermit(f)
  const before = ledger(f.id), calls = providerCalls
  try {
    const response = await localPost(f)
    assert.equal(response.statusCode, 200, response.body)
    const value = response.json(), current = scriptSourceAnalysis(f.id)!
    assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before, 'including a missing source_model_runs marker')
    assert.equal(current.local_validation?.model_required, true)
    assert.ok((current.local_validation?.reused_tasks || 0) >= 1)
    assert.ok(current.story_work?.tasks.find(task => task.key === 'overview')?.result)
    assert.equal(value.status, 'paused'); assert.equal(value.local_validation.model_required, true)
    assert.doesNotMatch(response.body, /original_raw|correction_request|ordinary_story_dispatch|output_candidate|source_request_recovery_epochs/)
  } finally { remove(f.id) }
})

test('local empty-candidate checks pause without consuming an initial and ordinary explicit start can continue around an old prepared permit', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('mocked providers require no network'))
  const f = await fixture(); oldPermit(f)
  const before = ledger(f.id), calls = providerCalls
  try {
    const response = await localPost(f)
    assert.equal(response.statusCode, 200, response.body)
    const local = scriptSourceAnalysis(f.id)!
    assert.equal(local.status, 'paused'); assert.equal(local.local_validation?.model_required, true)
    assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before)
    for (const task of local.story_work!.tasks) {
      assert.equal(task.output_candidate?.checkpoint.initial_started, undefined)
      assert.equal(task.output_candidate?.checkpoint.correction_started, undefined)
    }
    allowProvider = true
    const resumed = await app.inject({ method: 'POST', url: path(f.id), payload: { model_id: 'fixture', source_updated_at: f.stamp } })
    assert.equal(resumed.statusCode, 200, resumed.body)
    const completed = await terminal(f.id)
    assert.equal(completed.status, 'ready', completed.error || '')
    assert.ok(providerCalls > calls)
    const after = ledger(f.id)
    for (const table of ['source_request_recovery_actions', 'source_request_recovery_epochs', 'source_request_recovery_resolutions']) assert.deepEqual(after[table], before[table])
  } finally { allowProvider = false; remove(f.id) }
})

test('stale identity, source timestamp, configuration and queued/running state are rejected before mutation', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('rejected local checks must not use network'))
  const f = await fixture(), calls = providerCalls
  try {
    for (const mode of ['id', 'timestamp', 'source', 'configuration', 'queued', 'running'] as const) {
      const original = structuredClone(f.state)
      if (mode === 'queued' || mode === 'running') { f.state.status = mode; f.save() }
      if (mode === 'source') db.prepare('UPDATE script_source_documents SET content=content||? WHERE project_id=?').run('来源已变化。', f.id)
      if (mode === 'configuration') currentConfiguration = { fixture: 'changed' }
      const before = stored(f.id), rows = ledger(f.id)
      const response = await localPost(f, { analysis_id: mode === 'id' ? 'stale-id' : f.state.id, source_updated_at: mode === 'timestamp' ? 'stale-timestamp' : f.stamp })
      assert.equal(response.statusCode, 409, mode + ': ' + response.body)
      assert.deepEqual(stored(f.id), before, mode + ' must not write business state')
      assert.deepEqual(ledger(f.id), rows, mode + ' must not write ledger rows')
      currentConfiguration = configuration
      if (mode === 'source') db.prepare('UPDATE script_source_documents SET content=? WHERE project_id=?').run(f.source.content, f.id)
      Object.assign(f.state, original); f.save()
    }
    assert.equal(providerCalls, calls)
    const extra = await app.inject({ method: 'POST', url: path(f.id) + '/revalidate', payload: { analysis_id: f.state.id, source_updated_at: f.stamp, model_id: 'unexpected' } })
    assert.equal(extra.statusCode, 422)
  } finally { currentConfiguration = configuration; remove(f.id) }
})

test('unknown initial delivery and spent correction bytes remain protected during local revalidation', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('protected local checks must not use network'))
  for (const mode of ['unknown', 'spent'] as const) {
    const f = await fixture(mode === 'spent' ? 'format' : 'empty'), task = f.state.story_work.tasks.find((item: any) => item.key === 'overview'), cp = task.output_candidate.checkpoint
    if (mode === 'unknown') {
      cp.initial_started = { input_hash: cp.input_hash }
      const initial = f.initialRequests[0]!
      db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
        VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`).run(f.id, f.scope, digest(['fixture', initial.prompt, initial.contract]), f.state.id, f.stamp)
    } else {
      cp.correction = { input_hash: cp.correction_request.input_hash, raw: 'still not JSON' }
      cp.correction_started = { input_hash: cp.correction_request.input_hash }
    }
    f.save(); const before = ledger(f.id), original = structuredClone(cp), calls = providerCalls
    try {
      const response = await localPost(f)
      assert.equal(response.statusCode, 200, response.body)
      const current = scriptSourceAnalysis(f.id)!, retained = current.story_work!.tasks.find(item => item.key === 'overview')!.output_candidate!.checkpoint
      assert.equal(current.status, 'failed'); assert.equal(current.local_validation?.model_required, false)
      assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before)
      for (const key of ['raw', 'original_raw', 'initial_started', 'correction', 'correction_started', 'correction_request'] as const) assert.deepEqual(retained[key], original[key])
    } finally { remove(f.id) }
  }
})

test('concurrent analyzer revalidation rejects the second local owner', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local analyzer must not use network'))
  const f = await fixture(), analyzer = createScriptSourceAnalyzer(async () => assert.fail('local analyzer must not call a provider'), undefined, { configuration: () => configuration })
  const before = ledger(f.id)
  try {
    const first = analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.stamp })
    await assert.rejects(() => analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.stamp }), (issue: any) => issue.statusCode === 409 && /正在处理/.test(issue.message))
    await first; assert.deepEqual(ledger(f.id), before)
  } finally { await analyzer.close(); remove(f.id) }
})

test('one audited recovery also completes its pure local validation and retries reuse the complete visible result', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('audited recovery must never use external network'))
  const f = await fixture('saved'); oldPermit(f)
  const before = ledger(f.id), calls = providerCalls
  try {
    const url = path(f.id) + '/request-recovery'
    const details = (await app.inject({ method: 'GET', url })).json()
    assert.equal(details.reconciliation.status, 'saved_response')
    assert.equal(details.reconciliation.next, 'local_revalidate')
    const payload = { analysis_id: details.analysis_id, cas_token: details.cas_token, client_action_id: 'audit-local-once', decision: 'reconcile_local' }
    const result = await app.inject({ method: 'POST', url: url + '/reconcile', payload })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().analysis.status, 'paused', 'the explicit recovery action includes local validation')
    assert.ok(result.json().analysis.local_validation.reused_tasks >= 1)
    assert.equal(result.json().recovery.outcome, 'stopped', 'out-of-scope model work remains stopped without another user risk decision')
    assert.equal(result.json().recovery.model_requests_started, false)
    assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before)
    const stateAfter = stored(f.id)
    const duplicate = await app.inject({ method: 'POST', url: url + '/reconcile', payload })
    assert.equal(duplicate.statusCode, 200, duplicate.body)
    assert.equal(duplicate.json().action_id, result.json().action_id)
    assert.equal(duplicate.json().reused, true)
    assert.deepEqual(duplicate.json().recovery, result.json().recovery)
    assert.deepEqual(stored(f.id), stateAfter, 'an idempotent response cannot execute local validation twice')
    assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before)
    assert.equal(db.prepare('SELECT count(*) n FROM source_request_local_recoveries WHERE project_id=?').get(f.id)!.n, 1)
    assert.doesNotMatch(result.body, /before_snapshot|after_snapshot|ordinary_story_dispatch|output_candidate/)
  } finally { remove(f.id) }
})

test('the audited local route cannot fall back to a paid format correction or review when saved invalid correction bytes are exhausted', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('format recovery must never use external network'))
  const f = await fixture('format'), task = f.state.story_work.tasks.find((item: any) => item.key === 'overview'), cp = task.output_candidate.checkpoint
  cp.correction = { input_hash: cp.correction_request.input_hash, raw: 'still not JSON' }
  cp.correction_started = { input_hash: cp.correction_request.input_hash }
  f.save()
  const before = ledger(f.id), saved = structuredClone(cp), calls = providerCalls
  try {
    const url = path(f.id) + '/request-recovery', details = (await app.inject({ method: 'GET', url })).json()
    assert.equal(details.reconciliation.status, 'saved_response')
    const result = await app.inject({ method: 'POST', url: url + '/reconcile', payload: {
      analysis_id: details.analysis_id, cas_token: details.cas_token, client_action_id: 'audit-invalid-format', decision: 'reconcile_local',
    } })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().analysis.status, 'failed')
    assert.equal(result.json().analysis.local_validation.model_required, false)
    assert.equal(result.json().recovery.outcome, 'stopped')
    assert.equal(result.json().recovery.model_requests_started, false)
    assert.equal(providerCalls, calls); assert.deepEqual(ledger(f.id), before)
    const retained = scriptSourceAnalysis(f.id)!.story_work!.tasks.find(item => item.key === 'overview')!.output_candidate!.checkpoint
    for (const key of ['raw', 'original_raw', 'initial_started', 'correction', 'correction_started', 'correction_request'] as const) assert.deepEqual(retained[key], saved[key])
  } finally { remove(f.id) }
})

test('source timestamp or configuration drift during asynchronous local work cannot publish stale results or leak ownership', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local drift checks must not use network'))
  for (const mode of ['timestamp', 'configuration'] as const) {
    const f = await fixture('saved'); let localConfiguration: unknown = configuration
    const analyzer = createScriptSourceAnalyzer(async () => assert.fail('local drift checks must not call a provider'), undefined, { configuration: () => localConfiguration })
    const before = ledger(f.id)
    try {
      const pending = analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.stamp })
      if (mode === 'configuration') localConfiguration = { fixture: 'changed-during-local-work' }
      else db.prepare('UPDATE script_source_documents SET updated_at=? WHERE project_id=?').run(f.stamp + '-changed', f.id)
      await assert.rejects(() => pending, (issue: any) => issue.statusCode === 409, mode + ' drift must stop the stale owner')
      const after = scriptSourceAnalysis(f.id)!
      assert.equal(after.local_validation, undefined)
      assert.equal(after.story_work?.tasks.find(task => task.key === 'overview')?.result, undefined)
      assert.deepEqual(ledger(f.id), before)
      localConfiguration = configuration
      db.prepare('UPDATE script_source_documents SET updated_at=? WHERE project_id=?').run(f.stamp, f.id)
      f.save()
      const retried = await analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.stamp })
      assert.equal(retried.local_validation?.model_required, true, 'a rejected stale owner must release the local active slot')
      assert.deepEqual(ledger(f.id), before)
    } finally { await analyzer.close(); remove(f.id) }
  }
})
