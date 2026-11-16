import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { createSourceStoryDispatchGrant, sourceQualityRoundConfirmation, prepareSourceQualityNextRound,
  closeSourceQualityDispatchRound, confirmSourceQualityRound } from '../src/modules/script/script-source-ordinary-dispatch.js'
import { sourceQualityInputHash, sourceQualitySummary } from '../src/modules/script/script-source-quality.js'
import { sourceQualityContentHash } from '../src/modules/script/script-source-quality-assessment.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(unknown = false) {
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: 'round-project', filename: 'round-fixture.txt',
    content: '旧钟无人修复，归来的旅人停在钟楼前。', updated_at: 'source-stamp' }
  const state: ScriptSourceAnalysis = { id: 'finished-round', source_version: 'source-version', model_id: 'fixture',
    configuration_hash: 'configuration', status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    error: null, updated_at: 'saved-stamp', sections: [{ offset: 0, length: document.content.length, title: '钟楼',
      episode_number: 1, summary: document.content, characters: [], events: [] }],
    story: { summary: document.content, characters: [], timeline: [], threads: [], uncertainties: [],
      ending: { summary: document.content, section_ids: [0] } },
  }
  const currentHash = sourceQualityInputHash(state)
  state.quality = { input_hash: currentHash, status: 'issues', findings: [0, 1].map(index => ({ kind: 'omission',
    explanation: `新复核待核对项${index}`, unit_ids: [0] })) }
  state.quality_repair = { review_hash: currentHash, findings_hash: hash(state.quality.findings), current_hash: currentHash, completed_findings: 0 }
  state.ordinary_story_dispatch = { run_id: state.id, binding: 'old-grant-binding', authorized_at: 'old-grant-stamp', protected_task_keys: [],
    quality_workflow: { phase: 'review', review_hash: 'a'.repeat(64), findings_hash: 'b'.repeat(64), finding_index: 4,
      current_hash: currentHash, checkpoint_hash: '', protected_repair_bindings: [], review_input_hash: 'c'.repeat(64) } }
  if (unknown) state.quality_repair_output = { binding: 'retained-unresolved-binding', checkpoint: {
    input_hash: 'd'.repeat(64), initial_started: { input_hash: 'd'.repeat(64) } } }
  return { document, state }
}

test('legacy completed-review workflow derives a new-round confirmation without changing evidence or claiming not_sent', () => {
  const { state, document } = fixture(true), before = structuredClone(state)
  const pending = sourceQualityRoundConfirmation(state)!
  assert.equal(pending.review_hash, state.quality!.input_hash)
  assert.equal(pending.findings_hash, hash(state.quality!.findings))
  assert.equal(pending.completed_run_id, state.id)
  const summary = sourceQualitySummary(state)
  assert.equal(summary.confirmation_required, true)
  assert.equal(summary.review, 'issues')
  assert.equal(summary.access, 'blocked')
  assert.deepEqual(summary.confirmation_scope, { analysis_id: state.id, review_hash: pending.review_hash, findings_hash: pending.findings_hash })
  assert.equal(createSourceStoryDispatchGrant({ document, state, configuration_hash: state.configuration_hash!, local_active: false }), undefined)
  assert.deepEqual(state, before, 'read-only assessment cannot clear, normalize or rewrite old evidence')
})

test('formal local preparation closes only the old allowance and retains unknown markers idempotently', () => {
  const { state } = fixture(true), checkpoint = structuredClone(state.quality_repair_output), quality = structuredClone(state.quality)
  const oldGrant = structuredClone(state.ordinary_story_dispatch), sections = structuredClone(state.sections), story = structuredClone(state.story)
  assert.equal(prepareSourceQualityNextRound(state), true)
  const once = structuredClone(state)
  assert.equal(prepareSourceQualityNextRound(state), true)
  assert.deepEqual(state, once)
  assert.equal(state.ordinary_story_dispatch!.closed_reason, 'independent_recheck_complete')
  assert.equal(state.quality_dispatch_history!.length, 1)
  assert.deepEqual(state.quality_dispatch_history![0]!.grant, oldGrant)
  assert.deepEqual(state.quality_repair_output, checkpoint)
  assert.deepEqual(state.quality, quality); assert.deepEqual(state.sections, sections); assert.deepEqual(state.story, story)
})

test('a completed independent recheck saves its newly bound pending round and preserves the finished grant', () => {
  const { state } = fixture(), old = { input_hash: 'a'.repeat(64), status: 'issues' as const,
    findings: Array.from({ length: 4 }, (_, index) => ({ kind: 'omission' as const, explanation: `旧项${index}`, unit_ids: [0] })) }
  state.ordinary_story_dispatch!.quality_workflow!.findings_hash = hash(old.findings)
  const grant = structuredClone(state.ordinary_story_dispatch)
  closeSourceQualityDispatchRound(state, old, true)
  assert.equal(state.quality_round_confirmation!.previous_findings_hash, hash(old.findings))
  assert.equal(state.quality_dispatch_history!.length, 1)
  assert.deepEqual(state.quality_dispatch_history![0]!.grant, grant)
  assert.equal(state.ordinary_story_dispatch!.closed_reason, 'independent_recheck_complete')
  closeSourceQualityDispatchRound(state, old, true)
  assert.equal(state.quality_dispatch_history!.length, 1)
})

test('an exact explicitly confirmed new round creates a fresh current workflow without reviving the closed grant', () => {
  const { state, document } = fixture()
  prepareSourceQualityNextRound(state)
  const pending = structuredClone(sourceQualityRoundConfirmation(state)!)
  state.id = 'explicit-new-round'
  confirmSourceQualityRound(state, pending)
  const grant = createSourceStoryDispatchGrant({ document, state, configuration_hash: state.configuration_hash!, local_active: false })!
  assert.equal(grant.run_id, state.id)
  assert.equal(grant.quality_workflow!.phase, 'repair')
  assert.equal(grant.quality_workflow!.finding_index, 0)
  assert.equal(grant.quality_workflow!.findings_hash, hash(state.quality!.findings))
  assert.equal(grant.closed_at, undefined)
  assert.equal(state.quality_dispatch_history!.length, 1)
  assert.equal(state.quality_dispatch_history![0]!.confirmation!.authorized_run_id, state.id)
  assert.equal(state.quality_round_confirmation, undefined)
})

test('changing the pending exact scope cannot be accepted as a confirmation', () => {
  const { state } = fixture(), pending = structuredClone(sourceQualityRoundConfirmation(state)!), before = structuredClone(state)
  pending.findings_hash = '0'.repeat(64)
  assert.throws(() => confirmSourceQualityRound(state, pending), (error: any) => error.code === 'source_quality_round_confirmation_required')
  assert.deepEqual(state, before)
})

const directory = await mkdtemp(join(tmpdir(), 'source-quality-round-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
initDb()
assert.ok(db.name.startsWith(directory), 'round admission tests must not use real business data')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const configuration = { fixture: 'quality-round' }
function persistedFixture(unknown = false) {
  const { state, document } = fixture(unknown), id = newId(), stamp = now()
  document.project_id = id; document.updated_at = stamp
  state.source_version = scriptSourceVersion(document)
  state.configuration_hash = sourceAnalysisConfigurationHash(configuration)
  state.pipeline_version = sourceAnalysisPipelineVersion
  state.quality!.input_hash = sourceQualityInputHash(state)
  state.quality_repair!.review_hash = state.quality!.input_hash
  state.quality_repair!.current_hash = state.quality!.input_hash
  state.ordinary_story_dispatch!.quality_workflow!.current_hash = state.quality!.input_hash
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated round fixture', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, document.content, stamp)
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  return { id, state, document, scope: { analysis_id: state.id, review_hash: state.quality!.input_hash, findings_hash: hash(state.quality!.findings) } }
}

test('start requires exact new-round confirmation and cannot override a legacy unresolved attempt even with confirmation', async t => {
  for (const unknown of [false, true]) await t.test(unknown ? 'unknown' : 'unconfirmed', async () => {
    const f = persistedFixture(unknown), before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id)
    let calls = 0
    const analyzer = createScriptSourceAnalyzer(async () => { calls++; assert.fail('admission cannot call a provider') }, undefined,
      { configuration: () => configuration })
    try {
      assert.throws(() => analyzer.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at,
        qualityScope: f.scope, ...(unknown ? { confirmNewQualityRound: true } : {}) }),
      (error: any) => error.code === (unknown ? 'source_request_unknown' : 'source_quality_round_confirmation_required'))
      assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id), before)
      assert.equal(calls, 0)
    } finally { await analyzer.close(); db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
  })
})

test('new-round admission with no unknown queues exactly the current scope and preserves private round history', async () => {
  const f = persistedFixture(), before = structuredClone(f.state)
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; assert.fail('paused test entry cannot call a provider') }, undefined,
    { configuration: () => configuration })
  try {
    const state = analyzer.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at,
      qualityScope: f.scope, confirmNewQualityRound: true })
    analyzer.pause(f.id, state.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    const saved = scriptSourceAnalysis(f.id)!
    assert.notEqual(saved.id, before.id)
    assert.equal(saved.ordinary_story_dispatch!.quality_workflow!.finding_index, 0)
    assert.equal(saved.ordinary_story_dispatch!.bounded_quality, true)
    assert.equal(saved.quality_dispatch_history!.length, 1)
    assert.equal(saved.quality_dispatch_history![0]!.grant.run_id, before.id)
    assert.deepEqual(saved.quality, before.quality); assert.deepEqual(saved.story, before.story); assert.deepEqual(saved.sections, before.sections)
    assert.equal(calls, 0)
  } finally { await analyzer.close(); db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
})

test('new-round confirmation does not override an unchanged-content guard or an uncertain disposition', async t => {
  for (const stop of ['no_progress', 'uncertain'] as const) await t.test(stop, async () => {
    const f = persistedFixture()
    if (stop === 'no_progress') f.state.quality_loop_guard = { analysis_hash: sourceQualityContentHash(f.state),
      source_version: f.state.source_version, reason: 'unchanged_analysis', finding_indices: [0], message: 'fixture requires new evidence' }
    else { f.state.quality_repair!.stop_reason = 'uncertain'; f.state.quality_repair!.stop_message = 'fixture requires human resolution' }
    db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(f.state), f.id)
    const before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id)
    let calls = 0
    const analyzer = createScriptSourceAnalyzer(async () => { calls++; assert.fail('semantic stop cannot enter a provider') }, undefined,
      { configuration: () => configuration })
    try {
      assert.throws(() => analyzer.start(f.id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: f.document.updated_at,
        qualityScope: f.scope, confirmNewQualityRound: true }), (error: any) => error.code === `source_quality_${stop}`)
      assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id), before)
      assert.equal(calls, 0)
    } finally { await analyzer.close(); db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
  })
})
