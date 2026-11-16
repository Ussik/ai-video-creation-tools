import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-snapshot-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { generationCheckpointStore, clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
assert.ok(db.name.startsWith(testData), 'source snapshot tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
function source(label: string): ScriptSourceDocument {
  const id = newId(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, label, timestamp, timestamp)
  return { project_id: id, filename: `${label}.txt`, content: `${label}：开场林舟得到钥匙。\n尾声沈月归还信物，她是林舟的妹妹。`, updated_at: timestamp }
}
function checkpoint(projectId: string): ScriptSourceAnalysis {
  const row = db.prepare("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal'").get(projectId) as { payload: string }
  return JSON.parse(row.payload)
}
const configuration = ['gpt-6.1-sol', JSON.stringify({ temperature: 0.4 }), 'openai-responses', 'https://fixture.invalid/v1']
function installSource(document: ScriptSourceDocument) {
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', document.project_id, document.filename, document.content, document.updated_at)
}
async function evictPreparedMemory() {
  for (let index = 0; index < 11; index++) {
    const document = source(`内存缓存淘汰_${index}`)
    await analyzeSourceSnapshot(document, 'eviction-model', async prompt => sourceAnalysisFixture(prompt)!, signal(), { index })
  }
}
async function finished(projectId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(projectId)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('source analysis did not finish')
}

test('private proposed-source analysis saves full map and story without a quality-review loop', async () => {
  const document = source('私有修订稿保存'), calls: string[] = []
  const result = await analyzeSourceSnapshot(document, 'model', async prompt => {
    calls.push(prompt); assert.doesNotMatch(prompt, /【原稿分析核对资料】|【原稿分析定点修补资料】/)
    return sourceAnalysisFixture(prompt)!
  }, signal())
  assert.equal(result.status, 'ready'); assert.equal(result.quality, undefined); assert.equal(calls.length, 2)
  assert.deepEqual(checkpoint(document.project_id).story, result.story)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_documents WHERE project_id=?').get(document.project_id)!.count, 0)
})

test('disk complete snapshots reuse facts regardless of historical quality diagnostics; invalid story references require synthesis', async t => {
  for (const defect of ['missing_review', 'stale_hash', 'contradictory_review', 'known_issues', 'invented_story_reference'] as const) await t.test(defect, async () => {
    const document = source(defect)
    const saved = await analyzeSourceSnapshot(document, 'model', async prompt => sourceAnalysisFixture(prompt)!, signal())
    saved.quality = { status: 'passed', input_hash: sourceQualityInputHash(saved), findings: [] }
    if (defect === 'missing_review') delete saved.quality
    if (defect === 'stale_hash') saved.quality!.input_hash = 'obsolete-review-hash'
    if (defect === 'contradictory_review' || defect === 'known_issues') {
      saved.quality!.findings = [{ kind: 'omission', explanation: '遗漏尾声身份关系', unit_ids: [0] }]
      if (defect === 'known_issues') saved.quality!.status = 'issues'
    }
    if (defect === 'invented_story_reference') saved.story!.ending.section_ids = [999]
    run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal'", JSON.stringify(saved), document.project_id)
    await evictPreparedMemory()
    const calls: string[] = []
    const ready = await analyzeSourceSnapshot(document, 'model', async prompt => {
      calls.push(prompt); assert.doesNotMatch(prompt, /【原稿分析核对资料】|【原稿分析定点修补资料】/)
      return sourceAnalysisFixture(prompt)!
    }, signal())
    assert.equal(ready.status, 'ready')
    if (defect === 'invented_story_reference') {
      assert.ok(calls.length > 0); assert.ok(ready.story!.ending.section_ids.every(id => id < ready.sections.length))
    } else {
      assert.deepEqual(calls, []); assert.deepEqual(ready.story, saved.story); assert.deepEqual(ready.quality, saved.quality)
    }
  })
})

test('completed source proposals survive candidate cleanup and memory eviction and publish without another model request', async () => {
  const document = source('持久修订分析复用')
  const prepared = await analyzeSourceSnapshot(document, 'model', async prompt => sourceAnalysisFixture(prompt)!, signal(), configuration)
  const generation = generationCheckpointStore(document.project_id, { draft: 'candidate' })
  generation.save({ steps: {} })
  const repair = generationCheckpointStore(document.project_id, { draft: 'repair' }, 'repair')
  repair.save({ steps: {} })
  clearGenerationCheckpoint(document.project_id)
  assert.deepEqual(checkpoint(document.project_id), JSON.parse(JSON.stringify(prepared)), 'publishing a candidate retains its private source analysis until confirmation')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_generation_checkpoints WHERE project_id=?').get(document.project_id)!.count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM script_step_checkpoints WHERE project_id=? AND namespace='repair'").get(document.project_id)!.count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_analyses WHERE project_id=?').get(document.project_id)!.count, 0, 'private analysis is not published before confirmation')
  await evictPreparedMemory()
  installSource(document)
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; throw new Error('validated private analysis should be reused') }, undefined, { configuration: () => configuration })
  try {
    const reused = analyzer.start(document.project_id, 'model')
    assert.equal(reused.status, 'ready'); assert.equal(reused.started_at, undefined)
    assert.equal(calls, 0)
    assert.deepEqual(reused.sections, prepared.sections); assert.deepEqual(reused.story, prepared.story)
    assert.deepEqual(reused.quality, prepared.quality)
    assert.equal(scriptSourceAnalysis(document.project_id)!.status, 'ready')
  } finally { await analyzer.close() }
})

test('public analysis never publishes mismatched, incomplete or damaged private snapshots as ready', async t => {
  const defects = ['remote_model', 'settings', 'protocol', 'provider', 'content', 'project', 'pipeline', 'model',
    'incomplete', 'running', 'coverage', 'evidence', 'story', 'invalid_json'] as const
  const candidates: Array<{ defect: typeof defects[number]; document: ScriptSourceDocument; config: unknown }> = []
  for (const defect of defects) {
    let document = source(`拒绝复用_${defect}`)
    const prepared = await analyzeSourceSnapshot(document, 'model', async prompt => sourceAnalysisFixture(prompt)!, signal(), configuration)
    let config: unknown = configuration
    const configIndex = ['remote_model', 'settings', 'protocol', 'provider'].indexOf(defect)
    if (configIndex >= 0) config = configuration.map((value, index) => index === configIndex ? `${value}-changed` : value)
    if (defect === 'content') document = { ...document, content: `${document.content}\n原文新增的事实必须重新理解。` }
    if (defect === 'project') {
      const other = source('另一个项目')
      const stored = db.prepare("SELECT cache_key,payload,updated_at FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal'").get(document.project_id) as { cache_key: string; payload: string; updated_at: string }
      run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)', other.project_id, 'source-proposal', stored.cache_key, stored.payload, stored.updated_at)
      document = { ...document, project_id: other.project_id }
    }
    if (defect === 'pipeline') prepared.pipeline_version = prepared.pipeline_version! - 2
    if (defect === 'model') prepared.model_id = 'another-model'
    if (defect === 'incomplete') prepared.completed_chunks = 0
    if (defect === 'running') prepared.status = 'running'
    if (defect === 'coverage') prepared.sections[0]!.length--
    if (defect === 'evidence') prepared.sections[0]!.events[0]!.evidence.quote = '原文没有的句子'
    if (defect === 'story') prepared.story!.ending.section_ids = [999]
    if (!['remote_model', 'settings', 'protocol', 'provider', 'content', 'project'].includes(defect)) {
      run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal'", defect === 'invalid_json' ? '{broken' : JSON.stringify(prepared), document.project_id)
    }
    installSource(document)
    candidates.push({ defect, document, config })
  }
  await evictPreparedMemory()
  for (const { defect, document, config } of candidates) await t.test(defect, async () => {
    let calls = 0
    const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => { calls++; return sourceAnalysisFixture(prompt)! }, undefined, { configuration: () => config })
    try {
      assert.equal(analyzer.start(document.project_id, 'model').status, 'queued', 'unverified private data cannot become a published ready analysis')
      const state = await finished(document.project_id)
      assert.equal(state.status, 'ready', state.error || '')
      assert.ok(calls > 0, 'mismatched or invalid data cannot be published from a complete cache')
      assert.equal(state.quality, undefined)
      assert.equal(state.completed_characters, document.content.length)
    } finally { await analyzer.close() }
  })
})
