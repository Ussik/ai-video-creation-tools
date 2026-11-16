import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceQualityInputHash, hasPassedSourceQuality, reviewSourceQuality } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality } from '../src/modules/script/script-source-quality-repair.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'source-quality-policy-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceDocument, scriptSourceIndex } = await import('../src/modules/script/script-source-documents.js')
initDb()
assert.ok(db.name.startsWith(testData))
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const marker = '【原稿分析核对资料】\n'
const signal = () => new AbortController().signal
const legacyHash = (state: ScriptSourceAnalysis) => createHash('sha256').update(JSON.stringify([state.source_version, state.sections, state.story])).digest('hex')
function fixture() {
  const projectId = newId(), stamp = now(), content = '开场：林舟守约。\n尾声：信物已归还。\n'
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '核对策略升级', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', projectId, '资料.txt', content, stamp)
  return { projectId, content }
}
async function terminal(projectId: string) {
  for (let count = 0; count < 1000; count++) {
    const state = scriptSourceAnalysis(projectId)!
    if (state.status === 'ready' || state.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('quality policy task did not finish')
}
function write(projectId: string, state: ScriptSourceAnalysis) {
  run('UPDATE script_source_analyses SET status=?,snapshot=?,updated_at=? WHERE project_id=?', state.status, JSON.stringify(state), state.updated_at, projectId)
}

test('old ready review is projected read-only as awaiting recheck, and start requests only quality while preserving directory and story', async () => {
  const { projectId, content } = fixture(), calls: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, contract) => { calls.push(contract!.name); return sourceAnalysisFixture(prompt)! })
  try {
    analyzer.start(projectId, 'model')
    const ready = await terminal(projectId)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.ok(hasPassedSourceQuality(ready))
    const original = structuredClone(ready)
    ready.quality!.input_hash = legacyHash(ready)
    write(projectId, ready)
    assert.equal(hasPassedSourceQuality(ready), false)
    const before = db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(projectId) as { snapshot: string }
    const publicState = scriptSourceDocument(projectId)!.analysis!
    assert.equal(publicState.status, 'paused')
    assert.equal(publicState.phase, 'synthesis')
    assert.match(publicState.error!, /核对规则已更新/)
    assert.equal(publicState.resume!.available, true)
    assert.deepEqual(publicState.sections, original.sections)
    assert.deepEqual(publicState.story, original.story)
    assert.equal(scriptSourceIndex(projectId)!.story_map, undefined)
    assert.deepEqual(db.prepare('SELECT snapshot FROM script_source_analyses WHERE project_id=?').get(projectId), before, 'GET never writes or dispatches')
    calls.length = 0
    const queued = analyzer.start(projectId, 'model')
    assert.equal(queued.status, 'queued')
    assert.deepEqual(queued.sections, original.sections)
    assert.deepEqual(queued.story, original.story)
    const checked = await terminal(projectId)
    assert.equal(checked.status, 'ready', checked.error || '')
    assert.deepEqual(calls, ['script_source_quality'])
    assert.deepEqual(checked.sections, original.sections); assert.deepEqual(checked.story, original.story)
    assert.equal(checked.pipeline_version, original.pipeline_version)
    assert.equal(checked.quality!.input_hash, sourceQualityInputHash(checked))
    const reused = analyzer.start(projectId, 'model')
    assert.equal(reused.id, checked.id); assert.deepEqual(calls, ['script_source_quality'])
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(projectId)!.content, content)
  } finally { await analyzer.close() }
})

test('ensure cannot return an old passed review and performs only one fresh quality request', async () => {
  const { projectId } = fixture(), calls: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, contract) => { calls.push(contract!.name); return sourceAnalysisFixture(prompt)! })
  try {
    analyzer.start(projectId, 'model'); const ready = await terminal(projectId)
    const original = structuredClone(ready)
    ready.quality!.input_hash = legacyHash(ready); write(projectId, ready)
    calls.length = 0
    const checked = await analyzer.ensure(projectId, 'model')
    assert.ok(hasPassedSourceQuality(checked!)); assert.deepEqual(calls, ['script_source_quality'])
    assert.deepEqual(checked!.story, original.story); assert.deepEqual(checked!.sections, original.sections)
  } finally { await analyzer.close() }
})

test('old review findings and partial repair counters cannot authorize a new-policy edit and old pages cannot bypass the fresh review', async () => {
  const { projectId, content } = fixture()
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => sourceAnalysisFixture(prompt)!)
  let ready: ScriptSourceAnalysis
  try { analyzer.start(projectId, 'model'); ready = await terminal(projectId) } finally { await analyzer.close() }
  const before = structuredClone(ready.story), oldHash = legacyHash(ready)
  ready.quality = { input_hash: oldHash, status: 'issues', findings: [{ kind: 'unsupported', explanation: '旧规则误报，不应执行修补', unit_ids: [0] }] }
  ready.quality_repair = { review_hash: oldHash, findings_hash: createHash('sha256').update(JSON.stringify(ready.quality.findings)).digest('hex'), current_hash: oldHash, completed_findings: 0 }
  ready.quality_work = { input_hash: oldHash, checkpoint: { steps: { 'source-quality:pages': { input_hash: 'old-page', value: { items: [], complete: true } } } } }
  await repairSourceQuality({ filename: '资料.txt', content }, ready, async () => { throw new Error('old findings must not authorize requests') }, () => {}, signal())
  assert.deepEqual(ready.story, before)
  let requests = 0
  await reviewSourceQuality({ filename: '资料.txt', content }, ready, async (prompt, contract) => {
    requests++; assert.equal(contract!.name, 'script_source_quality')
    const body = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    return JSON.stringify({ checked_section_ids: body.sections.map((section: { id: number }) => section.id), findings: [] })
  }, () => {}, signal())
  assert.equal(requests, 1); assert.ok(hasPassedSourceQuality(ready))
  assert.equal(ready.quality_work, undefined); assert.equal(ready.quality_repair, undefined)
  assert.deepEqual(ready.story, before)
})
