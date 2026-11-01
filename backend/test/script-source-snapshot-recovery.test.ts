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
const qualityMarker = '【原稿分析核对资料】\n'
const repairMarker = '【原稿分析定点修补资料】\n'
type RepairInput = { story: NonNullable<ScriptSourceAnalysis['story']>; finding: { explanation: string }; finding_index: number }
function repairReply(prompt: string) {
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf(repairMarker) + repairMarker.length)) as RepairInput
  return JSON.stringify({ status: 'patched', reason: '依据原文补充已核对的事实。', changes: [{ target: 'story.summary', section_id: null,
    operation: 'replace', index: null, expected: input.story.summary, value: `${input.story.summary}；${input.finding.explanation}` }] })
}
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
  const document = source('内存缓存淘汰')
  for (let index = 0; index < 11; index++) {
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

test('private proposed-source analysis retains its map/story and repairs known omissions before a new independent review', async () => {
  const document = source('私有修订稿恢复'), explanation = '目录遗漏沈月是林舟妹妹的身份'
  let maps = 0, stories = 0, reviews = 0, repairs = 0
  let original: ScriptSourceAnalysis | undefined
  const generate = async (prompt: string) => {
    if (prompt.includes(repairMarker)) {
      repairs++
      original = checkpoint(document.project_id)
      assert.equal(original.quality!.status, 'issues', 'the review finding is durable before automatic repair')
      assert.ok(prompt.includes(explanation), 'targeted repair receives durable original findings and complete source')
      assert.ok(prompt.includes(document.content.split('\n')[1]!))
      return repairReply(prompt)
    }
    if (prompt.includes(qualityMarker)) {
      reviews++
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(qualityMarker) + qualityMarker.length))
      return JSON.stringify({ checked_section_ids: input.sections.map((section: { id: number }) => section.id),
        findings: reviews === 1 ? [{ kind: 'omission', explanation, unit_ids: [input.units.find((unit: { text: string }) => unit.text.includes('沈月')).id] }] : [] })
    }
    if (prompt.includes('【原文片段】')) {
      maps++
    }
    if (prompt.includes('【全剧整合资料】')) stories++
    return sourceAnalysisFixture(prompt)!
  }
  const result = await analyzeSourceSnapshot(document, 'model', generate, signal())
  assert.equal(result.status, 'ready'); assert.equal(result.quality!.status, 'passed')
  assert.deepEqual([maps, stories, repairs, reviews], [1, 1, 1, 2], 'one call repairs the completed analysis rather than regenerating its map and story')
  assert.deepEqual(result.sections, original!.sections)
  assert.deepEqual({ ...result.story, summary: original!.story!.summary }, original!.story)
  assert.ok(result.story!.summary.includes(explanation))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_documents WHERE project_id=?').get(document.project_id)!.count, 0, 'private source analysis never publishes the proposed manuscript')
})

test('disk ready checkpoints require valid story provenance and a current passed review before reuse', async t => {
  for (const defect of ['missing_review', 'stale_hash', 'contradictory_review', 'known_issues', 'invented_story_reference'] as const) await t.test(defect, async () => {
    const document = source(defect)
    // An interrupted review leaves valid map/story checkpoints without adding
    // an in-memory ready cache, as happens across a service restart.
    await assert.rejects(analyzeSourceSnapshot(document, 'model', async prompt => {
      if (prompt.includes(qualityMarker)) throw new Error('复核连接中断')
      return sourceAnalysisFixture(prompt)!
    }, signal()), /复核连接中断/)
    const saved = checkpoint(document.project_id)
    saved.status = 'ready'; saved.phase = 'ready'; delete saved.work
    saved.quality = { status: 'passed', input_hash: sourceQualityInputHash(saved), findings: [] }
    if (defect === 'missing_review') delete saved.quality
    if (defect === 'stale_hash') saved.quality!.input_hash = 'obsolete-review-hash'
    if (defect === 'contradictory_review' || defect === 'known_issues') {
      saved.quality!.findings = [{ kind: 'omission', explanation: '遗漏尾声身份关系', unit_ids: [0] }]
      if (defect === 'known_issues') saved.quality!.status = 'issues'
    }
    if (defect === 'invented_story_reference') {
      saved.story!.ending.section_ids = [999]
      saved.quality!.input_hash = sourceQualityInputHash(saved)
    }
    run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal'", JSON.stringify(saved), document.project_id)
    const calls: string[] = []
    const ready = await analyzeSourceSnapshot(document, 'model', async prompt => {
      calls.push(prompt.includes(repairMarker) ? 'repair' : prompt.includes(qualityMarker) ? 'review' : prompt.includes('【全剧整合资料】') ? 'story' : 'map')
      if (prompt.includes(repairMarker)) return repairReply(prompt)
      return sourceAnalysisFixture(prompt)!
    }, signal())
    assert.equal(ready.status, 'ready'); assert.equal(ready.quality!.status, 'passed')
    assert.equal(ready.quality!.input_hash, sourceQualityInputHash(ready))
    assert.deepEqual(calls, defect === 'known_issues' ? ['repair', 'review'] : defect === 'invented_story_reference' ? ['map', 'story', 'review'] : ['review'])
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
    'incomplete', 'running', 'missing_review', 'stale_review', 'known_issues', 'contradictory_review', 'coverage', 'evidence', 'story', 'invalid_json'] as const
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
    if (defect === 'pipeline') prepared.pipeline_version = prepared.pipeline_version! - 1
    if (defect === 'model') prepared.model_id = 'another-model'
    if (defect === 'incomplete') prepared.completed_chunks = 0
    if (defect === 'running') prepared.status = 'running'
    if (defect === 'missing_review') delete prepared.quality
    if (defect === 'stale_review') prepared.quality!.input_hash = 'old-hash'
    if (defect === 'known_issues' || defect === 'contradictory_review') {
      prepared.quality!.status = defect === 'known_issues' ? 'issues' : 'passed'
      prepared.quality!.findings = [{ kind: 'omission', explanation: '存在尚未解决的人物关系遗漏', unit_ids: [0] }]
    }
    if (defect === 'coverage') prepared.sections[0]!.length--
    if (defect === 'evidence') prepared.sections[0]!.events[0]!.evidence.quote = '原文没有的句子'
    if (defect === 'story') prepared.story!.ending.section_ids = [999]
    if (['coverage', 'evidence', 'story'].includes(defect)) prepared.quality!.input_hash = sourceQualityInputHash(prepared)
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
      assert.equal(calls, 3, 'mismatched or invalid data triggers a full read, synthesis and independent quality check')
      assert.equal(state.quality!.status, 'passed')
      assert.equal(state.quality!.input_hash, sourceQualityInputHash(state))
      assert.equal(state.completed_characters, document.content.length)
    } finally { await analyzer.close() }
  })
})
