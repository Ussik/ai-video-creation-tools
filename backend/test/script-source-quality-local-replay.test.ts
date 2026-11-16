import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

const directory = await mkdtemp(join(tmpdir(), 'source-quality-local-replay-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceRepairRequestCheckpoint } = await import('../src/modules/script/source-repair-request-identity.js')
initDb()
assert.ok(db.name.startsWith(directory), 'local replay fixtures cannot open business data')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const configuration = { fixture: 'pure-local-quality-replay' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(mode: 'review_miss' | 'repair_then_review_miss' | 'format_correction_miss') {
  const id = newId(), stamp = now(), content = '旧钟无人修复，归来的旅人停在钟楼前。'
  const document = { project_id: id, filename: 'local-replay.txt', content, updated_at: stamp }
  const state: ScriptSourceAnalysis = { id: newId(), source_version: scriptSourceVersion(document), model_id: 'fixture',
    configuration_hash: sourceAnalysisConfigurationHash(configuration), pipeline_version: sourceAnalysisPipelineVersion,
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, error: null, updated_at: stamp,
    sections: [{ offset: 0, length: content.length, title: '钟楼', episode_number: 1, summary: content, characters: [], events: [] }],
    story: { summary: content, characters: [], timeline: [], threads: [], uncertainties: [], ending: { summary: content, section_ids: [0] } },
  }
  if (mode !== 'review_miss') {
    state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: 'omission', explanation: '核对钟楼状态。', unit_ids: [0] }] }
    state.quality_repair = { review_hash: state.quality.input_hash, findings_hash: hash(state.quality.findings),
      current_hash: state.quality.input_hash, completed_findings: 0 }
    const raw = mode === 'format_correction_miss' ? 'complete but invalid JSON' : JSON.stringify({ decision: 'retain_analysis',
      finding_hash: hash(state.quality.findings[0]), reason: '当前分析已保留原文明示状态，需独立复核。', changes: [],
      analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: 0 }] })
    state.quality_repair_output = { binding: hash([sourceRepairRequestCheckpoint(document, state, 0), state.model_id, state.configuration_hash]),
      checkpoint: { raw, original_raw: raw } }
  }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated local replay fixture', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, content, stamp)
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  return { id, state, document }
}

function unknownMarkers(state: ScriptSourceAnalysis) {
  const checkpoints = [state.quality_work?.output_checkpoint, state.quality_repair_output?.checkpoint,
    state.quality_repair_batch?.checkpoint, ...(state.quality_repair_outputs || []).map(output => output.checkpoint)]
  return checkpoints.flatMap(cp => cp ? [cp.initial_started, cp.correction_started].filter(Boolean) : [])
}

for (const mode of ['review_miss', 'repair_then_review_miss', 'format_correction_miss'] as const) test(`quality local replay ${mode} never creates dispatch intent or calls a provider`, async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local-only replay cannot use network'))
  const f = fixture(mode), raw = f.state.quality_repair_output?.checkpoint.original_raw
  let providerCalls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { providerCalls++; assert.fail('local-only replay cannot enter a provider') }, undefined,
    { configuration: () => configuration })
  try {
    if (mode !== 'review_miss') {
      // Let the real producer establish its exact private prompt/contract hash
      // through a saved-response miss, then inject only synthetic saved bytes.
      // No guessed prompt identity or upstream request participates in this test.
      delete f.state.quality_repair_output!.checkpoint.raw
      delete f.state.quality_repair_output!.checkpoint.original_raw
      db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(f.state), f.id)
      const seeded = await analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.document.updated_at })
      assert.deepEqual(unknownMarkers(seeded), [])
      assert.ok(seeded.quality_repair_output!.checkpoint.input_hash)
      seeded.quality_repair_output!.checkpoint.raw = raw
      seeded.quality_repair_output!.checkpoint.original_raw = raw
      db.prepare('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?').run(JSON.stringify(seeded), f.id)
    }
    const result = await analyzer.revalidate(f.id, { analysisId: f.state.id, sourceUpdatedAt: f.document.updated_at })
    assert.equal(result.id, f.state.id)
    assert.equal(result.status, 'paused', result.error || '')
    assert.equal(result.local_validation?.model_required, true)
    assert.deepEqual(unknownMarkers(result), [], 'a saved-response miss is not a new unknown request')
    assert.equal(providerCalls, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_model_requests WHERE project_id=?').get(f.id)?.count, 0)
    if (mode === 'repair_then_review_miss') {
      assert.equal(result.quality_repair!.completed_findings, 1)
      assert.equal(result.quality_repair_outputs![0]!.checkpoint.original_raw, raw)
      assert.equal(result.quality_work?.output_checkpoint?.initial_started, undefined)
    } else if (mode === 'format_correction_miss') {
      assert.equal(result.quality_repair_output!.checkpoint.original_raw, raw)
      assert.equal(result.quality_repair_output!.checkpoint.correction, undefined)
      assert.equal(result.quality_repair_output!.checkpoint.correction_request, undefined)
    }
    assert.deepEqual(scriptSourceAnalysis(f.id)!.story, f.state.story)
    assert.deepEqual(scriptSourceAnalysis(f.id)!.sections, f.state.sections)
  } finally { await analyzer.close(); db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
})
