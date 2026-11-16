import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const directory = await mkdtemp(join(tmpdir(), 'source-quality-workflow-integration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { synthesizeSourceStoryParts, sourceStorySchema } = await import('../src/modules/script/script-source-story-parts.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { initSourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { currentModelRequestContext } = await import('../src/modules/generation/model-task-policy.js')
initDb()
initSourceModelRecovery()
assert.ok(db.name.startsWith(directory))
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const configuration = { fixture: 'full-quality-workflow' }
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const repairMarker = '【原稿分析定点修补资料】\n', reviewMarker = '【原稿分析核对资料】\n'
async function fixture() {
  const id = newId(), stamp = now(), content = '林舟守约。沈月归还信物。', oldRun = newId()
  const document = { project_id: id, filename: 'workflow.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated workflow', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, content, stamp)
  const state: ScriptSourceAnalysis = { id: newId(), source_version: scriptSourceVersion(document), model_id: 'fixture',
    configuration_hash: sourceAnalysisConfigurationHash(configuration), status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length, pipeline_version: sourceAnalysisPipelineVersion,
    error: 'synthetic not sent', updated_at: stamp,
    sections: [{ offset: 0, length: content.length, title: '原稿', episode_number: null, summary: content, characters: [], events: [], open_threads: [] }],
    story_response_run_ids: [oldRun] }
  await assert.rejects(synthesizeSourceStoryParts(state, async () => {
    throw Object.assign(new Error('known unstarted sibling fixture'), { code: 'source_request_sibling_pending', delivery: 'not_sent' })
  }, () => {}, new AbortController().signal, { filename: document.filename, content },
  [{ covered_section_ids: [0], section: { ...state.sections[0]!, id: 0 } }], value => sourceStorySchema.parse(value)), /known unstarted/)
  const scope = digest({ source: state.source_version, model: state.model_id, configuration: state.configuration_hash })
  const key = digest(['fixture', 'protected unrelated old uncertainty correction'])
  db.prepare(`INSERT INTO source_model_runs (id,project_id) VALUES (?,?)`).run(oldRun, id)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
    VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`).run(id, scope, key, oldRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', oldRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, scope, key, oldRun, stamp)
  const save = () => db.prepare(`INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  save()
  const old = () => ({ request: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, key),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    links: db.prepare('SELECT * FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').all(id, key),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id) })
  return { id, document, state, old, save, scope }
}
async function until(id: string, predicate: (state: ScriptSourceAnalysis) => boolean) {
  for (let index = 0; index < 400; index++) {
    const state = scriptSourceAnalysis(id)!
    if (predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('workflow did not reach expected checkpoint: ' + JSON.stringify(scriptSourceAnalysis(id)))
}
function provider(events: string[], onRepair?: (index: number) => Promise<void>) {
  let reviews = 0
  return async (_project: string, _model: string, prompt: string) => {
    if (prompt.includes(repairMarker)) {
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(repairMarker) + repairMarker.length))
      const index = input.finding_index
      events.push('repair:' + index)
      await onRepair?.(index)
      notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
      const target = index === 0 ? 'summary' : 'ending', expected = input.story[target]
      const value = index === 0 ? '林舟守约。沈月归还信物。' : { summary: '沈月归还信物。', section_ids: [0] }
      return JSON.stringify({ status: 'patched', reason: '保留原文明示事实，不补写原稿。', changes: [
        { target: 'story.' + target, section_id: null, operation: 'replace', index: null, expected, value },
      ] })
    }
    if (prompt.includes(reviewMarker)) {
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
      events.push('review:' + reviews)
      notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
      const findings = reviews++ === 0 ? [
        { kind: 'unsupported', explanation: '概要未按本稿事实保留约定及信物归还。', unit_ids: [input.units[0].id] },
        { kind: 'unsupported', explanation: '结局未按本稿事实保留信物归还。', unit_ids: [input.units[0].id] },
      ] : []
      if (!findings.length) {
        assert.equal(input.story.summary, '林舟守约。沈月归还信物。')
        assert.deepEqual(input.story.ending, { summary: '沈月归还信物。', section_ids: [0] })
      }
      return JSON.stringify({ checked_section_ids: input.sections.map((s: { id: number }) => s.id), findings })
    }
    events.push('synthesis')
    notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    return sourceAnalysisFixture(prompt)!
  }
}

test('integration -> independent findings -> each patch -> independent recheck completes alongside an unrelated old permit', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await fixture(), old = f.old(), events: string[] = []
  const analyzer = createScriptSourceAnalyzer(provider(events), undefined, { configuration: () => configuration })
  try {
    analyzer.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
    const state = await until(f.id, s => s.status === 'ready' || s.status === 'failed')
    assert.equal(state.status, 'ready', state.error!)
    assert.ok(events.includes('synthesis'))
    assert.deepEqual(events.filter(e => e !== 'synthesis'), ['review:0', 'repair:0', 'repair:1', 'review:1'])
    assert.equal(state.quality?.input_hash, sourceQualityInputHash(state))
    assert.equal(state.quality_repair_outputs?.length, 2)
    assert.deepEqual(f.old(), old)
    assert.deepEqual(state.sections, f.state.sections)
    assert.equal((db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(f.id) as { content: string }).content, f.document.content)
  } finally { await analyzer.close() }
})

test('graceful restart after the first committed finding keeps its allowance and does not repeat the saved patch', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await fixture(), old = f.old(), events: string[] = []
  let first: ReturnType<typeof createScriptSourceAnalyzer>
  let stopScheduled = false
  db.function('stop_quality_at_committed_finding', (snapshot: string) => {
    const state = JSON.parse(snapshot) as ScriptSourceAnalysis
    if (!stopScheduled && state.status === 'running' && state.quality_repair?.completed_findings === 1 &&
      state.quality_repair_outputs?.length === 1 && !state.quality_repair_output) {
      stopScheduled = true
      // Shutdown at the next read-only await, before the next dispatch marker.
      queueMicrotask(() => { void first.close() })
    }
    return 0
  })
  db.exec(`CREATE TRIGGER stop_quality_after_commit AFTER UPDATE ON script_source_analyses
    WHEN NEW.project_id='${f.id}' BEGIN SELECT stop_quality_at_committed_finding(NEW.snapshot); END`)
  first = createScriptSourceAnalyzer(provider(events), undefined, { configuration: () => configuration })
  first.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
  const stopped = await until(f.id, s => s.status === 'queued' && s.quality_repair?.completed_findings === 1)
  await first.close()
  db.exec('DROP TRIGGER stop_quality_after_commit')
  assert.equal(events.filter(event => event.startsWith('repair')).length, 1)
  const grant = structuredClone(stopped.ordinary_story_dispatch)
  assert.ok(grant?.quality_workflow)
  assert.equal(stopped.quality_repair_outputs?.length, 1)
  const resumedEvents: string[] = []
  // The resumed provider starts directly at a repair; its next review is the
  // independent final audit, not a fresh initial finding generator.
  const remaining = async (_p: string, _m: string, prompt: string) => {
    if (prompt.includes(repairMarker)) {
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(repairMarker) + repairMarker.length))
      resumedEvents.push('repair:' + input.finding_index)
      assert.equal(input.finding_index, 1)
      notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
      return JSON.stringify({ status: 'patched', reason: '原文明示信物归还。', changes: [{ target: 'story.ending', section_id: null,
        operation: 'replace', index: null, expected: input.story.ending, value: { summary: '沈月归还信物。', section_ids: [0] } }] })
    }
    assert.ok(prompt.includes(reviewMarker)); resumedEvents.push('review')
    notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }
  const second = createScriptSourceAnalyzer(remaining, undefined, { configuration: () => configuration })
  try {
    second.recover()
    const done = await until(f.id, s => ['ready', 'failed'].includes(s.status))
    assert.equal(done.id, stopped.id)
    assert.equal(done.status, 'ready', done.error!)
    assert.deepEqual(resumedEvents, ['repair:1', 'review'])
    assert.deepEqual(done.ordinary_story_dispatch?.authorized_at, grant.authorized_at)
    assert.deepEqual(done.quality_repair_outputs?.[0], stopped.quality_repair_outputs?.[0])
    assert.deepEqual(f.old(), old)
  } finally { await second.close() }
})

test('explicit continuation reuses complete initial repair and recheck ledger replies after business-checkpoint loss', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await fixture(), old = f.old(), events: string[] = []
  let lostCheckpoint: ScriptSourceAnalysis | undefined
  const first = createScriptSourceAnalyzer(provider(events, async index => {
    if (index === 0) lostCheckpoint = structuredClone(scriptSourceAnalysis(f.id)!)
  }), undefined, { configuration: () => configuration })
  first.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
  const complete = await until(f.id, s => ['failed', 'ready'].includes(s.status))
  await first.close()
  assert.equal(complete.status, 'ready', complete.error!)
  assert.ok(lostCheckpoint?.quality_repair_output?.checkpoint.initial_started)
  assert.equal(lostCheckpoint.quality_repair_output.checkpoint.raw, undefined)
  const before = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id)
  lostCheckpoint.status = 'failed'
  db.prepare('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?')
    .run(lostCheckpoint.status, JSON.stringify(lostCheckpoint), f.id)
  let dispatches = 0
  const second = createScriptSourceAnalyzer(async () => { dispatches++; assert.fail('complete responses must be reused locally') }, undefined,
    { configuration: () => configuration })
  try {
    const continued = second.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
    assert.notEqual(continued.id, lostCheckpoint.id)
    const done = await until(f.id, s => ['failed', 'ready'].includes(s.status))
    assert.equal(done.status, 'ready', done.error!)
    assert.equal(dispatches, 0)
    assert.deepEqual(done.story, complete.story)
    assert.deepEqual(done.quality, complete.quality)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id), before,
      'pure reuse never promotes original ledger rows')
    assert.deepEqual(f.old(), old)
  } finally { await second.close() }
})

test('an accepted repair disconnect blocks restart and explicit continuation without another dispatch', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await fixture(), events: string[] = []
  const first = createScriptSourceAnalyzer(provider(events, async index => {
    assert.equal(index, 0)
    notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    throw new Error('synthetic accepted repair response lost')
  }), undefined, { configuration: () => configuration })
  first.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
  const failed = await until(f.id, s => s.status === 'failed')
  await first.close()
  assert.ok(failed.quality_repair_output?.checkpoint.initial_started)
  assert.equal(failed.quality_repair?.completed_findings, 0)
  const before = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id)
  let dispatches = 0
  const second = createScriptSourceAnalyzer(async () => { dispatches++; assert.fail('unknown repair must not be re-sent') }, undefined,
    { configuration: () => configuration })
  try {
    second.recover()
    assert.equal(scriptSourceAnalysis(f.id)!.status, 'failed')
    try {
      second.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
      const done = await until(f.id, s => s.status === 'failed')
      assert.equal(done.failure?.stage, 'recovery')
    } catch (error) { assert.equal((error as { statusCode: number }).statusCode, 409) }
    assert.equal(dispatches, 0)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id), before)
    assert.deepEqual(scriptSourceAnalysis(f.id)!.story, failed.story)
  } finally { await second.close() }
})

test('a completed frozen repair correction is recovered after either initial or correction business-checkpoint loss', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await fixture(), events: string[] = []
  let lostInitial: ScriptSourceAnalysis | undefined, lostCorrection: ScriptSourceAnalysis | undefined
  const ordinary = provider(events)
  const first = createScriptSourceAnalyzer(async (...args) => {
    const prompt = args[2], name = args[3]?.name
    if (name === 'script_source_quality_repair') {
      if (!lostInitial) {
        lostInitial = structuredClone(scriptSourceAnalysis(f.id)!)
        notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
        return 'synthetic invalid initial JSON'
      }
      if (currentModelRequestContext()?.operationStage === 'format_correction') {
        lostCorrection = structuredClone(scriptSourceAnalysis(f.id)!)
        notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
        return JSON.stringify({ status: 'patched', reason: '原文明示守约与归还信物。', changes: [{ target: 'story.summary', section_id: null,
          operation: 'replace', index: null, expected: lostCorrection.story!.summary, value: '林舟守约。沈月归还信物。' }] })
      }
    }
    return ordinary(...args)
  }, undefined, { configuration: () => configuration })
  first.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
  const complete = await until(f.id, state => ['failed', 'ready'].includes(state.status))
  await first.close()
  assert.equal(complete.status, 'ready', complete.error!)
  assert.ok(lostInitial?.quality_repair_output?.checkpoint.initial_started)
  assert.ok(lostCorrection?.quality_repair_output?.checkpoint.correction_started)
  assert.ok(lostCorrection.quality_repair_output.checkpoint.correction_request)
  assert.equal(lostCorrection.quality_repair_output.checkpoint.correction, undefined)
  const before = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id)
  for (const lost of [lostInitial, lostCorrection]) {
    lost.status = 'failed'
    db.prepare('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?').run(lost.status, JSON.stringify(lost), f.id)
    let calls = 0
    const second = createScriptSourceAnalyzer(async () => { calls++; assert.fail('frozen complete correction must be local only') }, undefined,
      { configuration: () => configuration })
    try {
      second.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at })
      const done = await until(f.id, state => ['failed', 'ready'].includes(state.status))
      assert.equal(done.status, 'ready', done.error!)
      assert.equal(calls, 0)
      assert.deepEqual(done.story, complete.story)
      assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? ORDER BY rowid').all(f.id), before)
    } finally { await second.close() }
  }
})

async function boundedFixture() {
  const f = await fixture()
  delete f.state.story_work; delete f.state.story_candidate
  f.state.story = { summary: '林舟离开。', characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: '林舟离开。', section_ids: [0] } }
  f.state.quality = { status: 'issues', input_hash: sourceQualityInputHash(f.state), findings: [
    { kind: 'unsupported', explanation: '概要离开无原文依据，须保留约定及信物归还。', unit_ids: [0] },
  ] }
  f.save()
  return { ...f, request: { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at,
    qualityScope: { analysis_id: f.state.id, review_hash: f.state.quality.input_hash,
      findings_hash: createHash('sha256').update(JSON.stringify(f.state.quality.findings)).digest('hex') } } }
}
const boundedPatch = (prompt: string) => {
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf(repairMarker) + repairMarker.length))
  return JSON.stringify({ status: 'patched', reason: '仅按原文纠正概要。', changes: [{ target: 'story.summary', section_id: null,
    operation: 'replace', index: null, expected: input.story.summary, value: '林舟守约。沈月归还信物。' }] })
}

test('bounded quality continuation rejects stale scope before any business or provider mutation', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await boundedFixture(), before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id)
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; assert.fail('must not generate') }, undefined, { configuration: () => configuration })
  try {
    for (const field of ['analysis_id', 'review_hash', 'findings_hash'] as const) {
      assert.throws(() => analyzer.start(f.id, 'fixture', { ...f.request, qualityScope: { ...f.request.qualityScope, [field]: '0'.repeat(64) } }), /范围与当前分析不匹配/)
      assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id), before)
    }
    assert.throws(() => analyzer.start(f.id, 'fixture', { ...f.request, explicitDispatch: false }), /范围与当前分析不匹配/)
    assert.equal(calls, 0)
  } finally { await analyzer.close() }
})

test('bounded quality continuation preserves all analysis when a finding requests a full rebuild', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await boundedFixture(), old = f.old(), calls: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_p, _m, _prompt, contract) => {
    calls.push(contract!.name); notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    assert.equal(contract?.name, 'script_source_quality_repair')
    return JSON.stringify({ status: 'requires_full_rebuild', reason: '本问题不能安全局部处理。', changes: [] })
  }, undefined, { configuration: () => configuration })
  try {
    analyzer.start(f.id, 'fixture', f.request)
    const done = await until(f.id, s => ['failed', 'ready'].includes(s.status))
    assert.equal(done.status, 'failed'); assert.equal(done.failure?.stage, 'recovery')
    assert.match(done.error!, /无法安全定点修补/)
    assert.deepEqual(done.sections, f.state.sections); assert.deepEqual(done.story, f.state.story)
    assert.equal(done.quality_rebuild_for, undefined); assert.equal(done.ordinary_story_dispatch?.bounded_quality, true)
    assert.match(done.quality_repair_output!.checkpoint.raw!, /requires_full_rebuild/)
    assert.deepEqual(calls, ['script_source_quality_repair']); assert.deepEqual(f.old(), old)
  } finally { await analyzer.close() }
})

test('bounded quality continuation stops both unknown and explicitly terminated disconnects after exactly one dispatch', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  for (const terminated of [false, true]) await t.test(String(terminated), async () => {
    const f = await boundedFixture(); let calls = 0
    const analyzer = createScriptSourceAnalyzer(async () => {
      calls++; notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
      const error = new TextProviderError('synthetic source disconnect', true, 'stream_disconnected', 200)
      Object.assign(error, { delivery: 'output_started', outputStarted: true, partialText: '{', raw_output: '{', responseTerminated: terminated,
        providerDiagnostics: { elapsed_ms: 1, response_chars: 1, partial_text_incomplete: true } })
      throw error
    }, undefined, { configuration: () => configuration })
    try {
      analyzer.start(f.id, 'fixture', f.request)
      const done = await until(f.id, s => ['failed', 'ready'].includes(s.status))
      assert.equal(done.status, 'failed'); assert.equal(calls, 1)
      assert.deepEqual(done.sections, f.state.sections); assert.deepEqual(done.story, f.state.story)
      assert.equal(!!done.quality_repair_output!.checkpoint.initial_started, !terminated)
      const rows = db.prepare('SELECT state,delivery FROM source_model_requests WHERE project_id=? AND run_id=?').all(f.id, done.id)
      assert.equal(rows.length, 1)
    } finally { await analyzer.close() }
  })
})

test('bounded quality continuation still allows one frozen format correction and one final independent review', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await boundedFixture(), calls: string[] = []
  let repairs = 0
  const analyzer = createScriptSourceAnalyzer(async (_p, _m, prompt, contract) => {
    calls.push(contract!.name); notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    if (contract!.name === 'script_source_quality_repair') return repairs++ === 0 ? 'not valid JSON' : boundedPatch(prompt)
    assert.equal(contract!.name, 'script_source_quality')
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }, undefined, { configuration: () => configuration })
  try {
    analyzer.start(f.id, 'fixture', f.request)
    const done = await until(f.id, s => ['failed', 'ready'].includes(s.status))
    assert.equal(done.status, 'ready', done.error!)
    assert.deepEqual(calls, ['script_source_quality_repair', 'script_source_quality_repair', 'script_source_quality'])
    assert.ok(done.quality_repair_outputs?.[0]?.checkpoint.correction)
    assert.equal(done.ordinary_story_dispatch?.bounded_quality, true)
  } finally { await analyzer.close() }
})

test('bounded final independent review also stops on a terminated disconnect without a transport retry', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const f = await boundedFixture(), calls: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_p, _m, prompt, contract) => {
    calls.push(contract!.name); notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    if (contract?.name === 'script_source_quality_repair') return boundedPatch(prompt)
    assert.equal(contract?.name, 'script_source_quality')
    const error = new TextProviderError('synthetic final review terminated disconnect', true, 'stream_disconnected', 200)
    Object.assign(error, { delivery: 'output_started', outputStarted: true, partialText: '{', responseTerminated: true })
    throw error
  }, undefined, { configuration: () => configuration })
  try {
    analyzer.start(f.id, 'fixture', f.request)
    const done = await until(f.id, s => ['failed', 'ready'].includes(s.status))
    assert.equal(done.status, 'failed'); assert.deepEqual(calls, ['script_source_quality_repair', 'script_source_quality'])
    assert.equal(done.quality_repair?.completed_findings, 1)
    assert.equal(done.quality_repair_outputs?.length, 1)
    assert.equal(done.ordinary_story_dispatch?.bounded_quality, true)
    assert.match(done.error!, /synthetic final review terminated disconnect/)
  } finally { await analyzer.close() }
})
