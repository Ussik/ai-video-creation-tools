import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const directory = await mkdtemp(join(tmpdir(), 'source-no-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { registerScriptSourceRoutes, scriptSourceDocument, scriptSourceIndex, readScriptSource } = await import('../src/modules/script/script-source-documents.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
function project() {
  const id = newId(), updated_at = now(), content = '背景设定：夜巡只能在午夜行动。\n第1集：林舟持灯返乡。\n第2集：林舟找到伙伴，归还钥匙。'
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '保留原稿分析', updated_at, updated_at)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '原稿.md', content, updated_at)
  return scriptSourceDocument(id, false)!
}
async function terminal(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(id)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('analysis did not finish')
}
const forbidden = /【原稿分析核对资料】|【原稿分析定点修补资料】/

test('unchanged source reuses its complete analysis across model switches and private consumers without quality approval', async () => {
  const source = project(), prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => {
    prompts.push(prompt); assert.doesNotMatch(prompt, forbidden)
    return sourceAnalysisFixture(prompt)!
  }, undefined, { configuration: model => ({ model }) })
  try {
    analyzer.start(source.project_id, 'model-a')
    const ready = await terminal(source.project_id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.quality, undefined, 'ready never fabricates a passed review')
    assert.equal(prompts.length, ready.total_chunks + 1)
    const calls = prompts.length
    assert.equal(analyzer.start(source.project_id, 'model-b').id, ready.id)
    const reused = await analyzeSourceSnapshot(source, 'model-b', async () => { throw new Error('must reuse the published analysis') },
      new AbortController().signal, { model: 'model-b' })
    assert.deepEqual(reused.story, ready.story); assert.deepEqual(reused.sections, ready.sections)
    assert.equal(prompts.length, calls)
    const index = scriptSourceIndex(source.project_id)!
    assert.equal(index.analysis_status, 'ready'); assert.deepEqual(index.story, ready.story)
    assert.deepEqual(index.story_map?.map(section => [section.offset, section.length]), ready.sections.map(section => [section.offset, section.length]))
    assert.equal(readScriptSource(source.project_id, 0, source.content.length, { source_version: index.source_version }).content, source.content)
  } finally { await analyzer.close() }
})

test('historical quality failure resumes locally with the exact saved story, evidence and diagnostic retained', async () => {
  const source = project()
  const state = await analyzeSourceSnapshot(source, 'model-a', async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal)
  const quality = { input_hash: 'historical', status: 'issues' as const, findings: [{ kind: 'omission' as const, explanation: '历史提示', unit_ids: [0] }] }
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', source.project_id,
    state.id, state.source_version, 'failed', JSON.stringify({ ...state, status: 'failed', phase: 'synthesis', error: '旧质量审核未通过', quality }), now())
  const analyzer = createScriptSourceAnalyzer(async () => { throw new Error('complete historical analysis must not dispatch again') })
  try {
    analyzer.start(source.project_id, 'model-b')
    const ready = await terminal(source.project_id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.deepEqual(ready.story, state.story); assert.deepEqual(ready.sections, state.sections)
    assert.deepEqual(ready.quality, quality, 'optional historical findings remain diagnostic data')
    assert.equal(scriptSourceDocument(source.project_id)!.analysis!.status, 'ready')
  } finally { await analyzer.close() }
})

test('a changed manuscript or damaged source evidence never reuses a complete cached result', async () => {
  const source = project()
  const ready = await analyzeSourceSnapshot(source, 'model', async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal)
  const damaged = structuredClone(ready)
  damaged.sections[0]!.events[0]!.evidence.quote = '并非原文'
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', source.project_id,
    ready.id, ready.source_version, 'ready', JSON.stringify(damaged), now())
  assert.equal(scriptSourceAnalysis(source.project_id), null, 'a published result must still pass local evidence validation')
  const changed = { ...source, content: source.content + '\n结局：伙伴离开。' }
  let calls = 0
  const result = await analyzeSourceSnapshot(changed, 'model', async prompt => { calls++; return sourceAnalysisFixture(prompt)! }, new AbortController().signal)
  assert.ok(calls > 0); assert.notEqual(result.source_version, ready.source_version)
  assert.equal(result.sections.reduce((sum, section) => sum + section.length, 0), changed.content.length)
})

test('uploading the identical effective manuscript preserves the analysis, original index and generated documents', async () => {
  const source = project(), app = Fastify()
  await app.register(multipart)
  registerScriptSourceRoutes(app, { generateText: async () => { throw new Error('same upload must not invoke a model') } })
  const ready = await analyzeSourceSnapshot(source, 'model', async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', source.project_id,
    ready.id, ready.source_version, 'ready', JSON.stringify(ready), now())
  try {
    const boundary = 'identical-source'
    const result = await app.inject({ method: 'POST', url: `/api/projects/${source.project_id}/script/source?model_id=model-b`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="原稿.md"\r\nContent-Type: text/plain\r\n\r\n${source.content}\r\n--${boundary}--\r\n`) })
    assert.equal(result.statusCode, 200, result.body)
    assert.notEqual(result.json().updated_at, source.updated_at, 'a replacement still invalidates stale creative draft saves')
    assert.equal(result.json().analysis.id, ready.id)
    assert.equal(result.json().analysis.status, 'ready')
    assert.equal(scriptSourceDocument(source.project_id, false)!.content, source.content)
  } finally { await app.close() }
})

test('identical upload during synthesis keeps the active request and checkpoint instead of cancelling or rereading', async () => {
  const source = project(), app = Fastify()
  await app.register(multipart)
  let entered!: () => void, release!: () => void, calls = 0, synthesisSignal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const analyzer = registerScriptSourceRoutes(app, { generateText: async (_project, _model, prompt, _contract, signal) => {
    calls++
    if (prompt.includes('【全剧整合资料】')) { synthesisSignal = signal; entered(); await waiting }
    return sourceAnalysisFixture(prompt)!
  } })
  await app.ready()
  try {
    const execution = analyzer.start(source.project_id, 'model')
    await started
    const before = scriptSourceAnalysis(source.project_id)!
    const boundary = 'identical-active'
    const response = await app.inject({ method: 'POST', url: `/api/projects/${source.project_id}/script/source?model_id=model`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="原稿.md"\r\nContent-Type: text/plain\r\n\r\n${source.content}\r\n--${boundary}--\r\n`) })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(synthesisSignal!.aborted, false, 'unchanged manuscript must not abort an already accepted request')
    assert.equal(response.json().analysis.id, execution.id)
    assert.deepEqual(response.json().analysis.sections, before.sections)
    release()
    const ready = await terminal(source.project_id)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(ready.id, execution.id)
    assert.equal(calls, 2)
  } finally { release(); await app.close() }
})
