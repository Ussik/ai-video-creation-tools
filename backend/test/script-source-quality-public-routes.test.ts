import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

const directory = await mkdtemp(join(tmpdir(), 'source-quality-public-routes-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { registerScriptSourceRoutes } = await import('../src/modules/script/script-source-documents.js')
const { scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { sourceRepairRequestCheckpoint } = await import('../src/modules/script/source-repair-request-identity.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
initDb()
assert.ok(db.name.startsWith(directory), 'route fixtures cannot open business data')

const configuration = { fixture: 'private-quality-route-projection' }
let providerCalls = 0
const app = Fastify()
app.setErrorHandler((issue: Error & { statusCode?: number }, _request, reply) => reply.code(issue.statusCode || 500).send({ detail: issue.message }))
registerScriptSourceRoutes(app, { analysisConfiguration: () => configuration, generateText: async () => {
  providerCalls++
  assert.fail('public route privacy tests must not enter a model provider')
} })
await app.ready()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture(status: 'queued' | 'failed' = 'failed') {
  const id = newId(), stamp = now(), content = '旧钟无人修复，归来的旅人停在钟楼前。'
  const source = { filename: 'quality-private.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'isolated private quality fixture', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, source.filename, content, stamp)
  const state: ScriptSourceAnalysis = { id: newId(), source_version: scriptSourceVersion(source), model_id: 'fixture', status,
    configuration_hash: sourceAnalysisConfigurationHash(configuration), pipeline_version: sourceAnalysisPipelineVersion,
    phase: 'synthesis', completed_chunks: 1, total_chunks: 1, error: null, updated_at: stamp,
    sections: [{ offset: 0, length: content.length, title: '钟楼', episode_number: null, summary: content, characters: [], events: [], open_threads: [] }],
    story: { summary: content, characters: [], timeline: [{ summary: content, section_ids: [0] }], threads: [], ending: { summary: content, section_ids: [0] }, uncertainties: [] },
    quality_repair_output: { binding: 'PRIVATE_CURRENT_OUTPUT_BINDING', checkpoint: {} },
    quality_repair_outputs: [{ binding: 'PRIVATE_ARCHIVED_OUTPUT_BINDING', checkpoint: {
      input_hash: 'PRIVATE_ARCHIVED_INPUT', raw: 'PRIVATE_COMPLETE_ARCHIVED_RAW', original_raw: 'PRIVATE_ARCHIVED_ORIGINAL_RAW',
      initial_started: { input_hash: 'PRIVATE_ARCHIVED_INITIAL' }, correction_started: { input_hash: 'PRIVATE_ARCHIVED_CORRECTION_INPUT' },
      correction: { input_hash: 'PRIVATE_ARCHIVED_CORRECTION_INPUT', raw: 'PRIVATE_COMPLETE_USED_CORRECTION' },
      correction_request: { base_input_hash: 'PRIVATE_ARCHIVED_INPUT', input_hash: 'PRIVATE_ARCHIVED_CORRECTION_INPUT',
        prompt: 'PRIVATE_FULL_FROZEN_PROMPT\n' + '完整内部提示词与原文上下文。'.repeat(80),
        contract: { name: 'script_source_quality_repair', schema: { type: 'object', description: 'PRIVATE_FROZEN_SCHEMA' } } },
    } }],
  }
  state.ordinary_story_dispatch = { run_id: state.id, binding: 'PRIVATE_ORDINARY_GRANT', authorized_at: stamp,
    work_hash: 'PRIVATE_GRANT_WORK_HASH', protected_task_keys: ['PRIVATE_PROTECTED_TASK'] }
  state.quality = { status: 'issues', input_hash: sourceQualityInputHash(state), findings: [{ kind: 'omission', explanation: '待核实钟楼状态。', unit_ids: [0] }] }
  state.quality_repair = { review_hash: state.quality.input_hash, current_hash: sourceQualityInputHash(state), completed_findings: 0,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex') }
  state.quality_repair_output!.binding = createHash('sha256').update(JSON.stringify([
    sourceRepairRequestCheckpoint(source, state, 0), state.model_id, state.configuration_hash,
  ])).digest('hex')
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  return { id, stamp, state, path: `/api/projects/${id}/script/source/analysis` }
}

function assertPublic(value: Record<string, any>, body: string) {
  for (const key of ['quality_repair_output', 'quality_repair_outputs', 'quality_repair', 'quality_work', 'ordinary_story_dispatch', 'configuration_hash']) {
    assert.equal(Object.hasOwn(value, key), false, key + ' must stay private')
  }
  assert.doesNotMatch(body, /PRIVATE_|quality_repair_outputs?|ordinary_story_dispatch|correction_request|original_raw|FULL_FROZEN_PROMPT/)
  assert.deepEqual(Object.keys(value.resume.next).sort(), ['model_required', 'phase', 'response'])
  assert.deepEqual(value.resume.next, { phase: 'quality_repair', response: 'not_started', model_required: true })
  assert.equal(value.resume.action, 'continue')
}

test('GET and idempotent start omit private quality archives and ordinary grants while retaining controlled resume metadata', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('offline route injections must not use network'))
  const f = fixture('queued')
  const before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id)
  try {
    for (const [method, suffix] of [['GET', ''], ['GET', '/source'], ['POST', '']] as const) {
      // An already queued, compatible execution is returned by start without
      // scheduling work; this exercises the real response projection safely.
      const response = await app.inject({ method, url: suffix ? `/api/projects/${f.id}/script/source` : f.path,
        ...(method === 'POST' ? { payload: { model_id: 'fixture', source_updated_at: f.stamp } } : {}) })
      assert.equal(response.statusCode, 200, response.body)
      assertPublic(suffix ? response.json().analysis : response.json(), response.body)
      assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id), before, 'read-only/idempotent projection cannot consume private outputs or grants')
    }
    assert.equal(providerCalls, 0)
    const retained = scriptSourceAnalysis(f.id)!
    assert.deepEqual(retained.quality_repair_outputs, f.state.quality_repair_outputs)
    assert.deepEqual(retained.ordinary_story_dispatch, f.state.ordinary_story_dispatch)
  } finally { db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
})

test('local revalidate omits complete archived raw and prompts without exposing the retained grant or invoking models', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('local revalidation must not use network'))
  const f = fixture()
  try {
    const response = await app.inject({ method: 'POST', url: f.path + '/revalidate', payload: { analysis_id: f.state.id, source_updated_at: f.stamp } })
    assert.equal(response.statusCode, 200, response.body)
    assertPublic(response.json(), response.body)
    assert.equal(response.json().local_validation.model_required, true, response.body)
    assert.equal(providerCalls, 0)
    const retained = scriptSourceAnalysis(f.id)!
    assert.deepEqual(retained.quality_repair_outputs, f.state.quality_repair_outputs, 'complete archive remains stored privately after projection')
    assert.deepEqual(retained.ordinary_story_dispatch, f.state.ordinary_story_dispatch)
  } finally { db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
})

test('bounded quality route accepts only the exact current saved analysis and finding scope', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no network in scoped route preflight'))
  const f = fixture(), before = db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id)
  try {
    const result = await app.inject({ method: 'POST', url: f.path, payload: { model_id: 'fixture', source_updated_at: f.stamp,
      quality_scope: { analysis_id: f.state.id, review_hash: f.state.quality!.input_hash, findings_hash: '0'.repeat(64) } } })
    assert.equal(result.statusCode, 409, result.body)
    assert.match(result.json().detail, /范围与当前分析不匹配/)
    assert.deepEqual(db.prepare('SELECT * FROM script_source_analyses WHERE project_id=?').get(f.id), before)
    assert.equal(providerCalls, 0)
  } finally { db.prepare('DELETE FROM projects WHERE id=?').run(f.id) }
})
