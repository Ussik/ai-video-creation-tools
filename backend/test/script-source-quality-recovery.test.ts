import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-quality-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
assert.ok(db.name.startsWith(testData), 'quality recovery tests must never use the live database')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })


const signal = () => new AbortController().signal
function document(label: string): ScriptSourceDocument {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, label, stamp, stamp)
  return { project_id: id, filename: `${label}.txt`, content: '第1集：林舟返乡。\n第2集：林舟归还钥匙。', updated_at: stamp }
}
function install(source: ScriptSourceDocument, state: ScriptSourceAnalysis) {
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', source.project_id, source.filename, source.content, source.updated_at)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', source.project_id,
    state.id, state.source_version, state.status, JSON.stringify(state), now())
}
async function historical(status: 'failed' | 'paused' | 'running') {
  const source = document(`历史审核_${status}`)
  const result = await analyzeSourceSnapshot(source, 'old-model', async prompt => sourceAnalysisFixture(prompt)!, signal())
  const state: ScriptSourceAnalysis = { ...result, status, phase: 'synthesis', error: '历史复核断连',
    quality: { status: 'issues', input_hash: 'legacy', findings: [{ kind: 'omission', explanation: '历史诊断', unit_ids: [0] }] } }
  install(source, state)
  return { source, state }
}
test('failed and paused complete historical audits become ready without retrying model calls or altering facts', async t => {
  for (const status of ['failed', 'paused'] as const) await t.test(status, async () => {
    const { source, state } = await historical(status)
    const analyzer = createScriptSourceAnalyzer(async () => { throw new Error('no automatic review or repair allowed') })
    try {
      const ready = analyzer.start(source.project_id, 'new-model')
      assert.equal(ready.status, 'ready'); assert.equal(ready.error, null)
      assert.deepEqual(ready.story, state.story); assert.deepEqual(ready.sections, state.sections)
      assert.deepEqual(ready.quality, state.quality); assert.equal(ready.model_id, state.model_id)
      assert.equal(scriptSourceDocument(source.project_id)!.content, source.content)
    } finally { await analyzer.close() }
  })
})
test('service recovery finalizes a complete running historical audit without dispatching its old review', async () => {
  const { source, state } = await historical('running')
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; throw new Error('must not send review') })
  try {
    analyzer.recover()
    for (let i = 0; i < 200 && scriptSourceAnalysis(source.project_id)?.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    const ready = scriptSourceAnalysis(source.project_id)!
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(calls, 0)
    assert.deepEqual(ready.story, state.story); assert.deepEqual(ready.quality, state.quality)
  } finally { await analyzer.close() }
})
test('an incomplete historical audit resumes required story synthesis and never treats old findings as a new task', async () => {
  const { source, state } = await historical('failed')
  delete state.story
  delete state.configuration_hash
  run('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?', JSON.stringify(state), source.project_id)
  const prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt); assert.doesNotMatch(prompt, /【原稿分析核对资料】|【原稿分析定点修补资料】/)
    return sourceAnalysisFixture(prompt)!
  }, undefined, { configuration: () => ['isolated-resume'] })
  try {
    analyzer.start(source.project_id, 'old-model')
    const ready = await analyzer.ensure(source.project_id, 'old-model')
    assert.equal(ready.status, 'ready'); assert.equal(prompts.length, 1)
    assert.ok(prompts[0]!.includes('【全剧整合资料】'))
    assert.deepEqual(ready.sections, state.sections); assert.ok(ready.story)
  } finally { await analyzer.close() }
})
