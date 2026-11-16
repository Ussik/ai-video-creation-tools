import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis, ScriptSourceQualityFinding } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import type { ModelResultEvent } from '../src/modules/generation/model-result-observation.js'

const directory = await mkdtemp(join(tmpdir(), 'source-quality-semantic-workflow-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now, newId } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { registerScriptSourceRoutes, scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const { sourceQualityInputHash, sourceQualitySummary } = await import('../src/modules/script/script-source-quality.js')
const { sourceQualityContentHash } = await import('../src/modules/script/script-source-quality-assessment.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { assertSourceQualityCreationAccess } = await import('../src/modules/script/script-source-quality-gate.js')
const Fastify = (await import('fastify')).default
initDb()
assert.ok(db.name.startsWith(directory))
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const configuration = { fixture: 'source-quality-semantics' }
function fixture(level: 'blocking' | 'scoped' | 'advisory') {
  const id = newId(), stamp = now(), content = '第一集\n旅人归乡。\n第二集\n旧钟的来历尚未说明。'
  const split = content.indexOf('第二集'), document = { project_id: id, filename: 'quality.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated semantic workflow', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, content, stamp)
  const finding: ScriptSourceQualityFinding = { kind: level === 'blocking' ? 'unsupported' : 'omission', explanation: '核对旧钟资料的依据与影响。', unit_ids: [2],
    assessment: { issue_type: level === 'blocking' ? 'unsupported_fact' : 'open_question', analysis_paths: ['story.uncertainties[0].description'],
      proposition: '旧钟的来历没有说明', impact: { level, section_ids: level === 'scoped' ? [1] : [], reason: '仅在继续使用旧钟来历时需要确认。' } } }
  const state: ScriptSourceAnalysis = { id: newId(), source_version: scriptSourceVersion(document), model_id: 'fixture',
    configuration_hash: sourceAnalysisConfigurationHash(configuration), status: 'ready', phase: 'ready',
    pipeline_version: sourceAnalysisPipelineVersion, completed_chunks: 1, total_chunks: 1, completed_characters: content.length, error: null, updated_at: stamp,
    sections: [{ offset: 0, length: split, title: '第一集', episode_number: 1, summary: '旅人归乡。', characters: [], events: [] },
      { offset: split, length: content.length - split, title: '第二集', episode_number: 2, summary: '旧钟来历未明。', characters: [], events: [] }],
    story: { summary: '旅人归乡，旧钟的来历没有说明。', characters: [], timeline: [], threads: [], ending: { summary: '原文尚未给出结局。', section_ids: [1] },
      uncertainties: [{ description: '旧钟的来历没有说明。', section_ids: [1] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [finding] }
  const save = () => db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  save()
  return { id, state, document, save }
}

test('server public state keeps advisory issues visible and permits use without renewing a model run', async () => {
  const { id, state, document } = fixture('advisory')
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; assert.fail('advisory access must not invoke a provider') }, undefined, { configuration: () => configuration })
  try {
    const result = analyzer.start(id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: document.updated_at })
    assert.equal(result.id, state.id)
    const source = scriptSourceDocument(id)!
    assert.equal(source.analysis!.status, 'ready')
    assert.equal(source.analysis!.quality!.status, 'issues', 'usable is not a fabricated quality pass')
    assert.equal(source.analysis!.quality_summary!.advisory, 1)
    assert.doesNotThrow(() => assertSourceQualityCreationAccess(source, { stage: 'core' }))
    assert.equal(calls, 0)
  } finally { await analyzer.close() }
})

test('scoped unknowns permit the unrelated real episode, while related, global and unmapped steps stay blocked', () => {
  const { id } = fixture('scoped'), source = scriptSourceDocument(id)!
  assert.equal(source.analysis!.quality_summary!.access, 'scoped')
  assert.equal(source.analysis!.status, 'ready')
  assert.doesNotThrow(() => assertSourceQualityCreationAccess(source, { stage: 'episode', episode_number: 1 }))
  for (const scope of [{ stage: 'episode' as const, episode_number: 2 }, { stage: 'episode' as const, episode_number: 3 }, { stage: 'core' as const }, {}]) {
    assert.throws(() => assertSourceQualityCreationAccess(source, scope), { code: 'source_quality_creation_blocked', delivery: 'not_sent' })
  }
})

test('an unchanged failed review blocks restart before a new run, request or permit is created', async () => {
  const { id, state, document, save } = fixture('blocking')
  state.status = 'failed'; state.phase = 'synthesis'
  state.quality_loop_guard = { analysis_hash: sourceQualityContentHash(state), source_version: state.source_version,
    reason: 'unchanged_analysis', finding_indices: [0], message: '没有内容进展，需补充依据后重新核对。' }
  save()
  const before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(id)
  const analyzer = createScriptSourceAnalyzer(async () => assert.fail('unchanged restart must stop locally'), undefined, { configuration: () => configuration })
  try {
    for (let i = 0; i < 2; i++) assert.throws(() => analyzer.start(id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: document.updated_at }), { code: 'source_quality_no_progress' })
    assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(id), before)
    assert.equal(db.prepare('SELECT count(*) n FROM source_model_runs WHERE project_id=?').get(id).n, 0)
    const source = scriptSourceDocument(id)!
    assert.equal(source.analysis!.resume!.action, 'blocked')
    assert.equal(source.analysis!.quality_summary!.stop_reason, 'no_progress')
    assert.throws(() => assertSourceQualityCreationAccess(source, { stage: 'episode', episode_number: 1 }), { code: 'source_quality_creation_blocked' })
  } finally { await analyzer.close() }
})

test('public GET hides private review decisions and raw batch journals without mutating saved analysis', async () => {
  const { id, state, save } = fixture('blocking')
  state.quality_review_audit = [{ review_hash: state.quality!.input_hash, analysis_hash: sourceQualityContentHash(state), source_version: state.source_version,
    findings: [], handled: 0, modified: 0, retained: 0, uncertain: 0 }]
  // Private raw documents must never be exposed through object spread as the
  // journal evolves. Deliberately use a marker instead of manuscript content.
  Object.assign(state, { quality_repair_batches: [{ private_marker: 'PRIVATE_BATCH_RAW' }] })
  save()
  const before = scriptSourceAnalysis(id), app = Fastify()
  registerScriptSourceRoutes(app, { generateText: async () => assert.fail('GET must not invoke provider'), analysisConfiguration: () => configuration })
  try {
    const result = await app.inject({ method: 'GET', url: `/api/projects/${id}/script/source/analysis` })
    assert.equal(result.statusCode, 200)
    const json = result.json()
    assert.ok(json.quality_summary)
    assert.equal(json.quality_review_audit, undefined)
    assert.equal(json.quality_repair_batches, undefined)
    assert.ok(!result.body.includes('PRIVATE_BATCH_RAW'))
    assert.deepEqual(scriptSourceAnalysis(id), before)
    assert.deepEqual(json.quality_summary, sourceQualitySummary(state))
  } finally { await app.close() }
})

test('a small-batch ordinary grant binds every member and never authorizes overlap, saved bytes or unknown delivery', async () => {
  const { state, document } = fixture('blocking')
  const { createHash } = await import('node:crypto')
  const { sourceRepairBatchBinding, withInitialSourceRepairBatchRequest, currentInitialSourceRepairRequest } = await import('../src/modules/script/source-repair-request-identity.js')
  const { createSourceStoryDispatchGrant, sourceRepairDispatchAuthorized } = await import('../src/modules/script/script-source-ordinary-dispatch.js')
  state.story!.uncertainties.push({ description: '旅人的师承尚未交代。', section_ids: [0] })
  const second = structuredClone(state.quality!.findings[0]!)
  second.assessment!.analysis_paths = ['story.uncertainties[1].description']
  second.assessment!.proposition = '旅人的师承未交代'
  state.quality!.findings.push(second)
  state.quality!.input_hash = sourceQualityInputHash(state)
  state.quality_repair = { review_hash: state.quality!.input_hash,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality!.findings)).digest('hex'),
    current_hash: sourceQualityInputHash(state), completed_findings: 0 }
  state.status = 'queued'
  const context = { document, state, configuration_hash: state.configuration_hash!, local_active: true, current_run_unknown: false }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
  state.status = 'running'
  const binding = sourceRepairBatchBinding(document, state, state.quality!.findings.map((finding, finding_index) => ({ finding_index, analysis_paths: finding.assessment!.analysis_paths })))
  state.quality_repair_batch = { binding, checkpoint: { input_hash: 'input' }, committed_indices: [] }
  const contract = { name: 'script_source_quality_repair_batch', schema: { type: 'object' } }
  withInitialSourceRepairBatchRequest(binding, state.model_id, 'frozen batch prompt', contract, () => {
    const proof = currentInitialSourceRepairRequest()!
    assert.equal(sourceRepairDispatchAuthorized(context, proof), true)
    const single = { ...proof }; delete single.batch
    assert.equal(sourceRepairDispatchAuthorized(context, single), false, 'an active batch cannot borrow the single-item path')
    assert.equal(sourceRepairDispatchAuthorized({ ...context, current_run_unknown: true }, proof), false)
    state.ordinary_story_dispatch!.bounded_quality = true
    assert.equal(sourceRepairDispatchAuthorized(context, proof), false)
    delete state.ordinary_story_dispatch!.bounded_quality
    const corrupt = structuredClone(proof)
    corrupt.batch!.members[1]!.finding_hash = 'f'.repeat(64)
    assert.equal(sourceRepairDispatchAuthorized(context, corrupt), false)
    state.quality_repair_batch!.checkpoint.raw = '{"items":[]}'
    assert.equal(sourceRepairDispatchAuthorized(context, proof), false, 'a saved batch is local replay work, never a fresh allowance')
    delete state.quality_repair_batch!.checkpoint.raw
    state.quality_repair_batch!.committed_indices.push(0)
    assert.equal(sourceRepairDispatchAuthorized(context, proof), false, 'partial success cannot re-buy the whole batch')
  })
  for (const mode of ['overlap', 'different_type'] as const) {
    delete state.quality_repair_batch; delete state.ordinary_story_dispatch
    const next = state.quality!.findings[1]!.assessment!
    next.analysis_paths = [mode === 'overlap' ? 'story.uncertainties[0]' : 'story.uncertainties[1].description']
    next.issue_type = mode === 'different_type' ? 'optional_detail' : 'unsupported_fact'
    state.quality_repair!.findings_hash = createHash('sha256').update(JSON.stringify(state.quality!.findings)).digest('hex')
    state.status = 'queued'; state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context); state.status = 'running'
    const invalid = sourceRepairBatchBinding(document, state, state.quality!.findings.map((finding, finding_index) => ({ finding_index, analysis_paths: finding.assessment!.analysis_paths })))
    state.quality_repair_batch = { binding: invalid, checkpoint: { input_hash: 'input' }, committed_indices: [] }
    withInitialSourceRepairBatchRequest(invalid, state.model_id, 'frozen invalid batch', contract, () => {
      assert.equal(sourceRepairDispatchAuthorized(context, currentInitialSourceRepairRequest()!), false, mode)
    })
  }
})

test('quality telemetry distinguishes an actual modification from an independently passed result', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  for (const final of ['advisory', 'passed'] as const) await t.test(final, async () => {
    const { document } = fixture('blocking'), events: ModelResultEvent[] = []
    let reviews = 0, repairs = 0
    const reviewMarker = '【原稿分析核对资料】\n', repairMarker = '【原稿分析定点修补资料】\n'
    const result = await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => { events.push(event) } }, () =>
      analyzeSourceSnapshot(document, 'fixture', async prompt => {
        if (prompt.includes(reviewMarker)) {
          const body = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
          reviews++
          const findings = reviews === 1 ? [{ kind: 'unsupported', explanation: '当前概要需要按原文保留旧钟来历未知。', unit_ids: [body.units[0].id] }]
            : final === 'advisory' ? [{ kind: 'omission', explanation: '旧钟细节仍然可以留白。', unit_ids: [body.units[0].id],
              assessment: { issue_type: 'optional_detail', analysis_paths: ['story.summary'], proposition: '旧钟来历未说明。',
                impact: { level: 'advisory', section_ids: [], reason: '不影响已描述事实及后续创作。' } } }] : []
          return JSON.stringify({ checked_section_ids: body.sections.map((section: { id: number }) => section.id), findings })
        }
        if (prompt.includes(repairMarker)) {
          repairs++
          const body = JSON.parse(prompt.slice(prompt.lastIndexOf(repairMarker) + repairMarker.length))
          return JSON.stringify({ decision: 'modify_analysis', finding_hash: body.finding_hash, reason: '明确保留未知信息。',
            analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: body.units[0].id }],
            changes: [{ target: 'story.summary', section_id: null, operation: 'replace', index: null,
              expected: body.story.summary, value: body.story.summary + '旧钟来历尚未说明。' }] })
        }
        return sourceAnalysisFixture(prompt)!
      }, new AbortController().signal, configuration))
    assert.equal(repairs, 1); assert.equal(reviews, 2)
    assert.equal(result.quality!.status, final === 'passed' ? 'passed' : 'issues')
    const last = events.filter(event => event.phase === 'quality').at(-1)!
    assert.equal(last.repaired, true)
    assert.equal(last.status, final === 'passed' ? 'passed' : 'needs_work')
    assert.equal(last.repair_effect, final === 'passed' ? 'improved' : undefined,
      'a changed analysis or changed finding wording alone cannot prove improved/regressed semantic quality')
  })
})

test('the real analyzer admits one small batch and one independent recheck without consuming an unrelated old recovery permit', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no external network'))
  const { createHash } = await import('node:crypto')
  const { canonicalAiValue } = await import('@video-studio/shared/api/ai-operations')
  const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
  const { initSourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
  initSourceModelRecovery()
  const { id, state, document, save } = fixture('blocking')
  state.story!.uncertainties.push({ description: '师承没有交代。', section_ids: [0] })
  const second = structuredClone(state.quality!.findings[0]!)
  second.assessment!.analysis_paths = ['story.uncertainties[1].description']
  second.assessment!.proposition = '师承未交代。'
  state.quality!.findings.push(second)
  state.quality!.input_hash = sourceQualityInputHash(state)
  state.status = 'failed'; state.phase = 'synthesis'; save()
  const oldRun = state.id, stamp = now()
  const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
  const scope = digest({ source: state.source_version, model: state.model_id, configuration: state.configuration_hash })
  const oldKey = digest(['unrelated', id])
  db.prepare('INSERT INTO source_model_runs (id,project_id) VALUES (?,?)').run(oldRun, id)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at)
    VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`).run(id, scope, oldKey, oldRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', oldRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, scope, oldKey, oldRun, stamp)
  const old = () => ({ request: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, oldKey),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    links: db.prepare('SELECT * FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').all(id, oldKey) })
  const before = old(), events: string[] = []
  const batchMarker = '【原稿分析质量小批次资料】\n', reviewMarker = '【原稿分析核对资料】\n'
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, contract) => {
    notifyTextRequest('dispatch', { delivery: 'unknown', request_id: newId() })
    if (prompt.includes(batchMarker)) {
      events.push('batch')
      assert.equal(contract!.name, 'script_source_quality_repair_batch')
      const body = JSON.parse(prompt.slice(prompt.lastIndexOf(batchMarker) + batchMarker.length))
      assert.equal(body.units.map((unit: { text: string }) => unit.text).join(''), document.content)
      return JSON.stringify({ items: body.findings.map((finding: { finding_index: number; finding_hash: string; analysis_paths: string[] }) => ({
        finding_index: finding.finding_index, finding_hash: finding.finding_hash, decision: 'modify_analysis', reason: '中性保留未说明信息。',
        analysis_refs: [{ path: finding.analysis_paths[0] }], source_refs: [{ unit_id: body.units[0].id }],
        changes: [{ target: 'story.uncertainties', section_id: null, operation: 'replace', index: finding.finding_index,
          expected: body.story.uncertainties[finding.finding_index], value: { ...body.story.uncertainties[finding.finding_index], description: `第${finding.finding_index}项仍未说明，保留待确认。` } }],
      })) })
    }
    assert.ok(prompt.includes(reviewMarker), 'no other paid stage is admitted')
    events.push('review')
    const body = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
    assert.ok(!prompt.includes('previous_review_notes'))
    assert.ok(!prompt.includes('中性保留未说明信息。'), 'private repair reasons cannot enter independent review')
    return JSON.stringify({ checked_section_ids: body.sections.map((section: { id: number }) => section.id), findings: [] })
  }, undefined, { configuration: () => configuration })
  try {
    analyzer.start(id, 'fixture', { explicitDispatch: true, sourceUpdatedAt: document.updated_at })
    let result: ScriptSourceAnalysis | null = null
    for (let attempt = 0; attempt < 400; attempt++) {
      result = scriptSourceAnalysis(id)
      if (result?.status === 'ready' || result?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(result?.status, 'ready', result?.error || 'analyzer did not complete')
    assert.deepEqual(events, ['batch', 'review'])
    assert.deepEqual(result!.sections, state.sections)
    assert.equal(result!.quality_repair_batches!.length, 1)
    assert.deepEqual(result!.quality_repair_batches![0]!.committed_indices, [0, 1])
    assert.equal(result!.quality!.status, 'passed')
    assert.deepEqual(old(), before, 'the batch owns its ordinary allowance and cannot retire or transfer an older permit')
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(id)!.content, document.content)
  } finally { await analyzer.close() }
})
