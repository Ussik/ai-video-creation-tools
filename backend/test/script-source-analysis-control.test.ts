import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-analysis-control-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { registerScriptSourceRoutes, scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

function project(label: string) {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, label, stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, `${label}.txt`, `${label}：林舟得到钥匙，调查结束后回家。`, stamp)
  return { id, stamp }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function ready(projectId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(projectId)
    if (state?.status === 'ready' || state?.status === 'failed') {
      assert.equal(state.status, 'ready', state.error || '')
      return state
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('analysis did not complete')
}
const limits = { reading: 1000, repairing: 1000, synthesis: 1000 }

test('two analyses run together, the third reports its queue position, and queued pause prevents execution until explicit resume', async () => {
  const first = project('并发一'), second = project('并发二'), third = project('排队三')
  const entered = new Map([[first.id, deferred()], [second.id, deferred()]])
  const release = new Map([[first.id, deferred()], [second.id, deferred()]])
  const mapCalls: string[] = []
  let simultaneous = 0, peak = 0
  const analyzer = createScriptSourceAnalyzer(async (projectId, _model, prompt) => {
    if (prompt.includes('【原文片段】')) {
      mapCalls.push(projectId)
      simultaneous++; peak = Math.max(peak, simultaneous)
      entered.get(projectId)?.resolve()
      if (release.has(projectId)) await release.get(projectId)!.promise
      simultaneous--
    }
    return sourceAnalysisFixture(prompt)!
  }, limits, { concurrency: 2 })
  try {
    const requestedAt = Date.now()
    const initial = analyzer.start(first.id, 'model'); analyzer.start(second.id, 'model')
    assert.equal(initial.started_at, undefined, 'queueing does not start the execution clock')
    await Promise.all([...entered.values()].map(gate => gate.promise))
    const running = scriptSourceAnalysis(first.id)!
    assert.equal(running.status, 'running')
    assert.ok(Date.parse(running.started_at!) >= requestedAt)
    assert.ok(Date.parse(running.started_at!) <= Date.now())
    assert.equal(new Date(running.started_at!).toISOString(), running.started_at)
    assert.equal(scriptSourceDocument(first.id)!.analysis!.started_at, running.started_at, 'the public source snapshot retains the execution start')
    assert.equal(scriptSourceAnalysis(second.id)!.status, 'running')
    const queued = analyzer.start(third.id, 'model')
    assert.equal(scriptSourceAnalysis(third.id)!.status, 'queued')
    assert.equal(queued.started_at, undefined)
    assert.equal(scriptSourceAnalysis(third.id)!.started_at, undefined)
    assert.equal(scriptSourceAnalysis(third.id)!.queue_position, 1)
    analyzer.pause(third.id, queued.id)
    assert.equal(scriptSourceAnalysis(third.id)!.status, 'paused')
    assert.equal(scriptSourceAnalysis(third.id)!.queue_position, undefined)
    release.get(first.id)!.resolve(); await ready(first.id)
    release.get(second.id)!.resolve(); await ready(second.id)
    await tick()
    assert.equal(mapCalls.includes(third.id), false, 'freeing both slots must not start a paused queued task')
    await assert.rejects(analyzer.ensure(third.id, 'model'), (issue: Error & { statusCode?: number }) => issue.statusCode === 422 && /暂停/.test(issue.message))
    const resumed = analyzer.start(third.id, 'model')
    assert.notEqual(resumed.id, queued.id)
    await ready(third.id)
    assert.equal(mapCalls.filter(id => id === third.id).length, 1)
    assert.equal(peak, 2)
  } finally {
    for (const gate of release.values()) gate.resolve()
    await analyzer.close()
    for (const item of [first, second, third]) run('DELETE FROM projects WHERE id=?', item.id)
  }
})

test('pausing an active synthesis aborts its request, retains the completed map, and immediate resume ignores a late old result', async () => {
  const item = project('运行暂停'), entered = deferred(), lateResult = deferred()
  let mapCalls = 0, synthesisCalls = 0, reviewCalls = 0, interruptedSignal: AbortSignal | undefined
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, _contract, signal) => {
    if (prompt.includes('【原文片段】')) mapCalls++
    if (prompt.includes('【全剧整合资料】') && ++synthesisCalls === 1) {
      interruptedSignal = signal; entered.resolve()
      await lateResult.promise // Deliberately emulate an upstream that ignores cancellation.
    }
    if (prompt.includes('【原稿分析核对资料】')) reviewCalls++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    const original = analyzer.start(item.id, 'model'); await entered.promise
    const before = scriptSourceAnalysis(item.id)!
    assert.equal(before.completed_chunks, 1)
    assert.ok(before.started_at)
    assert.ok(before.sections.length)
    const paused = analyzer.pause(item.id, original.id)
    assert.equal(paused.status, 'paused')
    assert.equal(interruptedSignal!.aborted, true)
    assert.deepEqual(paused.sections, before.sections)
    assert.equal(paused.completed_characters, before.completed_characters)
    const resumed = analyzer.start(item.id, 'model')
    assert.equal(resumed.started_at, undefined, 'resume queues a new execution without reusing the paused clock')
    const result = await ready(item.id)
    assert.ok(Date.parse(result.started_at!) >= Date.parse(before.started_at!))
    assert.notEqual(resumed.id, original.id)
    assert.equal(result.id, resumed.id)
    assert.deepEqual(result.sections, before.sections)
    assert.equal(mapCalls, 1, 'resuming reuses the full-source map already saved before pause')
    assert.equal(synthesisCalls, 2); assert.equal(reviewCalls, 1)
    lateResult.resolve(); await tick(); await tick()
    assert.equal(scriptSourceAnalysis(item.id)!.id, resumed.id)
    assert.equal(scriptSourceAnalysis(item.id)!.status, 'ready', 'the cancelled request cannot overwrite the resumed task')
  } finally {
    lateResult.resolve(); await analyzer.close(); run('DELETE FROM projects WHERE id=?', item.id)
  }
})

test('service recovery preserves paused progress without starting a model until the user resumes', async () => {
  const item = project('暂停重启'), entered = deferred(), lateResult = deferred()
  const first = createScriptSourceAnalyzer(async (_project, _model, prompt) => {
    if (prompt.includes('【全剧整合资料】')) { entered.resolve(); await lateResult.promise }
    return sourceAnalysisFixture(prompt)!
  }, limits)
  const original = first.start(item.id, 'model'); await entered.promise
  first.pause(item.id, original.id)
  const paused = scriptSourceAnalysis(item.id)!
  await first.close(); lateResult.resolve(); await tick()
  let calls = 0, mapCalls = 0
  const second = createScriptSourceAnalyzer(async (_project, _model, prompt) => {
    calls++; if (prompt.includes('【原文片段】')) mapCalls++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    second.recover(); await tick(); await tick()
    assert.equal(calls, 0)
    assert.deepEqual(scriptSourceAnalysis(item.id), paused)
    await assert.rejects(second.ensure(item.id, 'model'), /已暂停/)
    assert.equal(calls, 0, 'a conversation readiness check also leaves the task paused')
    second.start(item.id, 'model'); const result = await ready(item.id)
    assert.deepEqual(result.sections, paused.sections)
    assert.equal(mapCalls, 0); assert.equal(calls, 2, 'only synthesis and independent review remain after restart')
  } finally { await second.close(); run('DELETE FROM projects WHERE id=?', item.id) }
})

test('pause HTTP endpoint rejects stale analysis IDs without cancelling the current task', async () => {
  const entered = deferred(), release = deferred()
  let mapCalls = 0, firstSignal: AbortSignal | undefined
  const app = Fastify()
  app.setErrorHandler((issue: Error & { statusCode?: number }, _request, reply) => { reply.code(issue.statusCode || 500).send({ detail: issue.message }) })
  registerScriptSourceRoutes(app, { generateText: async (_project, _model, prompt, _contract, signal) => {
    if (prompt.includes('【原文片段】') && ++mapCalls === 1) { firstSignal = signal; entered.resolve(); await release.promise }
    return sourceAnalysisFixture(prompt)!
  } })
  await app.ready()
  const item = project('任务版本'), path = `/api/projects/${item.id}/script/source/analysis`
  try {
    const started = await app.inject({ method: 'POST', url: path, payload: { model_id: 'model', source_updated_at: item.stamp } })
    assert.equal(started.statusCode, 200, started.body)
    await entered.promise
    const original = scriptSourceAnalysis(item.id)!
    const publicRunning = await app.inject({ method: 'GET', url: path })
    assert.equal(publicRunning.json().started_at, original.started_at)
    assert.ok(publicRunning.json().started_at)
    assert.equal(publicRunning.json().work, undefined)
    const stale = await app.inject({ method: 'POST', url: `${path}/pause`, payload: { analysis_id: 'obsolete-analysis' } })
    assert.equal(stale.statusCode, 409)
    assert.equal(scriptSourceAnalysis(item.id)!.status, 'running')
    assert.equal(firstSignal!.aborted, false)
    const paused = await app.inject({ method: 'POST', url: `${path}/pause`, payload: { analysis_id: original.id } })
    assert.equal(paused.statusCode, 200, paused.body)
    assert.equal(paused.json().status, 'paused')
    assert.equal(paused.json().work, undefined, 'public task controls do not return internal checkpoint data')
    const resumed = await app.inject({ method: 'POST', url: path, payload: { model_id: 'model', source_updated_at: item.stamp } })
    assert.equal(resumed.statusCode, 200, resumed.body)
    const result = await ready(item.id)
    assert.notEqual(result.id, original.id)
    const oldPause = await app.inject({ method: 'POST', url: `${path}/pause`, payload: { analysis_id: original.id } })
    assert.equal(oldPause.statusCode, 409)
    assert.equal(scriptSourceAnalysis(item.id)!.id, result.id)
    assert.equal(scriptSourceAnalysis(item.id)!.status, 'ready')
  } finally { release.resolve(); await app.close(); run('DELETE FROM projects WHERE id=?', item.id) }
})

test('recovery clears obsolete run clocks while preserving queued order and starts fresh clocks only when slots open', async () => {
  const items = [project('恢复队首'), project('遗留排队'), project('遗留运行')]
  const obsoleteStart = '2000-01-01T00:00:00.000Z'
  const queuedStamps = ['2001-01-01T00:00:00.000Z', '2002-01-01T00:00:00.000Z']
  for (const [index, item] of items.entries()) {
    const state = { id: newId(), source_version: scriptSourceVersion(scriptSourceDocument(item.id, false)!), model_id: 'model',
      status: index === 2 ? 'running' : 'queued', completed_chunks: 0, total_chunks: 0, sections: [], error: null,
      updated_at: queuedStamps[index] || obsoleteStart, pipeline_version: sourceAnalysisPipelineVersion,
      ...(index ? { started_at: obsoleteStart } : {}) }
    run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
      item.id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  }
  const entered = new Map(items.map(item => [item.id, deferred()]))
  const release = new Map(items.map(item => [item.id, deferred()]))
  const analyzer = createScriptSourceAnalyzer(async (projectId, _model, prompt) => {
    if (prompt.includes('【原文片段】')) {
      entered.get(projectId)!.resolve()
      await release.get(projectId)!.promise
    }
    return sourceAnalysisFixture(prompt)!
  }, limits, { concurrency: 1 })
  try {
    const recoveredAt = Date.now()
    analyzer.recover(); await entered.get(items[0]!.id)!.promise
    assert.ok(Date.parse(scriptSourceAnalysis(items[0]!.id)!.started_at!) >= recoveredAt, 'a legacy snapshot without a timestamp obtains its real start on execution')
    for (const item of items.slice(1)) {
      const queued = scriptSourceAnalysis(item.id)!
      assert.equal(queued.status, 'queued')
      assert.equal(queued.started_at, undefined)
    }
    assert.equal(scriptSourceAnalysis(items[1]!.id)!.updated_at, queuedStamps[1], 'clock cleanup must not reorder the existing queue')
    assert.equal(scriptSourceAnalysis(items[1]!.id)!.queue_position, 1)
    assert.equal(scriptSourceAnalysis(items[2]!.id)!.queue_position, 2)
    for (const item of items) {
      await entered.get(item.id)!.promise
      const running = scriptSourceAnalysis(item.id)!
      assert.equal(running.status, 'running')
      assert.ok(Date.parse(running.started_at!) >= recoveredAt)
      release.get(item.id)!.resolve(); await ready(item.id)
    }
  } finally {
    for (const gate of release.values()) gate.resolve()
    await analyzer.close()
    for (const item of items) run('DELETE FROM projects WHERE id=?', item.id)
  }
})

test('a prepared full-source cache hit publishes ready data without an execution clock or another model request', async () => {
  const item = project('准备结果复用'), document = scriptSourceDocument(item.id, false)!
  await analyzeSourceSnapshot(document, 'model', async prompt => sourceAnalysisFixture(prompt)!, new AbortController().signal)
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt) => { calls++; return sourceAnalysisFixture(prompt)! }, limits)
  try {
    const cached = analyzer.start(item.id, 'model')
    assert.equal(cached.status, 'ready')
    assert.equal(cached.started_at, undefined)
    assert.equal(scriptSourceDocument(item.id)!.analysis!.started_at, undefined)
    await tick()
    assert.equal(calls, 0)
  } finally { await analyzer.close(); run('DELETE FROM projects WHERE id=?', item.id) }
})
