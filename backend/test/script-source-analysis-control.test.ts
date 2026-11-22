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
const { markSourceModelRun } = await import('../src/modules/script/source-model-recovery.js')
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
async function ready(projectId: string, expected: 'ready' | 'failed' = 'ready') {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(projectId)
    if (state?.status === 'ready' || state?.status === 'failed') {
      assert.equal(state.status, expected, state.error || '')
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
    assert.equal(scriptSourceAnalysis(third.id)!.pause_reason, 'user')
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

test('pausing synthesis preserves unknown request protection and only reuses the exact late complete response', async () => {
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
    const blocked = await ready(item.id, 'failed')
    assert.equal(synthesisCalls, 1, 'immediate resume must not repurchase an in-flight unknown response')
    assert.deepEqual(blocked.sections, before.sections)
    lateResult.resolve(); await tick(); await tick()
    const continued = analyzer.start(item.id, 'model')
    const result = await ready(item.id)
    assert.ok(Date.parse(result.started_at!) >= Date.parse(before.started_at!))
    assert.notEqual(resumed.id, original.id)
    assert.equal(result.id, continued.id)
    assert.deepEqual(result.sections, before.sections)
    assert.equal(mapCalls, 1, 'resuming reuses the full-source map already saved before pause')
    assert.equal(synthesisCalls, 1); assert.equal(reviewCalls, 1)
    lateResult.resolve(); await tick(); await tick()
    assert.equal(scriptSourceAnalysis(item.id)!.id, continued.id)
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
    assert.equal(mapCalls, 0); assert.equal(calls, 1, 'a completed late upstream reply is reused, leaving only independent review after explicit resume')
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

test('restart pauses journaled tasks without model calls and explicit continuation preserves saved work', async () => {
  const items = [project('恢复队首'), project('遗留排队'), project('遗留运行')]
  for (const [index, item] of items.entries()) {
    const state = { id: newId(), source_version: scriptSourceVersion(scriptSourceDocument(item.id, false)!), model_id: 'model',
      analysis_mode: 'extract', status: index === 2 ? 'running' : 'queued', completed_chunks: 0, total_chunks: 0, sections: [], error: null,
      updated_at: now(), started_at: '2000-01-01T00:00:00.000Z', pipeline_version: sourceAnalysisPipelineVersion }
    markSourceModelRun(item.id, state.id)
    run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
      item.id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  }
  let calls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    calls++; return sourceAnalysisFixture(prompt)!
  }, limits, { concurrency: 1 })
  try {
    analyzer.recover(); await tick()
    assert.equal(calls, 0, 'restart never authorizes redispatch')
    for (const item of items) {
      const paused = scriptSourceAnalysis(item.id)!
      assert.equal(paused.status, 'paused')
      assert.equal(paused.started_at, undefined)
      assert.match(paused.error!, /不自动重发/)
    }
    const resumedAt = Date.now()
    analyzer.start(items[0]!.id, 'model', { extractionOnly: true })
    const completed = await ready(items[0]!.id)
    assert.ok(Date.parse(completed.started_at!) >= resumedAt)
    assert.equal(calls, 2, 'only map and synthesis, no quality review')
    for (const item of items.slice(1)) assert.equal(scriptSourceAnalysis(item.id)!.status, 'paused')
  } finally {
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


test('explicit continuation repairs a saved character omission without regenerating the directory or whole story', async t => {
  for (const legacyResponseOnly of [false, true]) await t.test(legacyResponseOnly ? 'legacy completed response' : 'durable private candidate', async () => {
    const item = project('人物续修'), manuscript = '林舟将钥匙交给车夫。\n车夫：我等你回家。'
    run('UPDATE script_source_documents SET content=? WHERE project_id=?', manuscript, item.id)
    let mapCalls = 0, storyCalls = 0, repairCalls = 0, reviewCalls = 0, failRepair = true
    const analyzer = createScriptSourceAnalyzer(async (_project, _model, prompt, contract) => {
      if (contract?.name === 'script_source_story_character_repair') {
        repairCalls++
        if (failRepair) throw new Error('人物补丁连接中断')
        assert.ok(prompt.includes(manuscript.replaceAll('\n', '\\n')), 'the targeted repair still receives complete source for identity checks')
        return JSON.stringify({ add_characters: [{ name: '车夫', aliases: [], description: '收下钥匙，等待林舟回家。', section_ids: [0] }], add_aliases: [] })
      }
      const value = JSON.parse(sourceAnalysisFixture(prompt)!)
      if (contract?.name === 'script_source_map') {
        mapCalls++
        value.sections[0].characters = [{ name: '车夫', description: '等待林舟回家的人。', evidence: { unit_id: value.sections[0].start_unit } }]
      }
      if (contract?.name === 'script_source_story') { storyCalls++; value.story.characters = [] }
      if (prompt.includes('【原稿分析核对资料】')) reviewCalls++
      return JSON.stringify(value)
    }, limits)
    try {
      const first = analyzer.start(item.id, 'model')
      let failed: ReturnType<typeof scriptSourceAnalysis> = null
      for (let attempt = 0; attempt < 200; attempt++) {
        failed = scriptSourceAnalysis(item.id)
        if (failed?.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.ok(failed)
      assert.equal(failed.status, 'failed', failed.error || 'analysis did not reach the interrupted repair')
      assert.match(failed.error!, /人物补丁连接中断/)
      assert.ok(failed.story_candidate?.result)
      assert.equal(failed.story_candidate.character_repair?.status, 'failed')
      assert.equal(failed.story, undefined)
      assert.equal(mapCalls, 1); assert.equal(storyCalls, 1); assert.equal(repairCalls, 1); assert.equal(reviewCalls, 0)
      const before = structuredClone(failed.sections), candidate = structuredClone(failed.story_candidate.result.story)
      const publicFailed = scriptSourceDocument(item.id)!.analysis!
      assert.equal(publicFailed.story_candidate, undefined)
      assert.equal(publicFailed.story, undefined, 'a failed private candidate cannot appear as completed story data')
      assert.match(publicFailed.resume!.message, /全剧整合候选已保存/)

      if (legacyResponseOnly) {
        delete failed.story_candidate
        run('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?', JSON.stringify(failed), item.id)
      }
      failRepair = false
      const priorRuns = [first.id]
      if (legacyResponseOnly) {
        for (let cycle = 0; cycle < 2; cycle++) {
          const queued = analyzer.start(item.id, 'model')
          assert.equal(queued.status, 'queued')
          assert.deepEqual(queued.story_response_run_ids, priorRuns, 'every compatible execution retains the original response owner before model work begins')
          const paused = analyzer.pause(item.id, queued.id)
          assert.equal(paused.status, 'paused')
          assert.deepEqual(paused.story_response_run_ids, priorRuns)
          priorRuns.push(queued.id)
          assert.equal(scriptSourceDocument(item.id)!.analysis!.story_response_run_ids, undefined)
        }
        assert.equal(storyCalls, 1, 'synchronous queue pauses cannot consume or overwrite the original completed story response')
        assert.equal(repairCalls, 1)
      }
      const resumed = analyzer.start(item.id, 'model')
      assert.notEqual(resumed.id, first.id)
      assert.deepEqual(resumed.story_response_run_ids, priorRuns)
      assert.equal(scriptSourceDocument(item.id)!.analysis!.story_response_run_ids, undefined, 'internal response lineage is hidden from public task state')
      const result = await ready(item.id)

      assert.deepEqual(result.sections, before)
      assert.equal(mapCalls, 1, 'the complete evidence directory is reused')
      assert.equal(storyCalls, 1, 'continuation adopts the retained candidate or its exact legacy response without another whole-story request')
      assert.equal(repairCalls, 2, 'only the failed character patch receives one explicit retry')
      assert.equal(reviewCalls, 1, 'a repaired story still requires independent quality review')
      assert.equal(result.quality!.status, 'passed')
      assert.equal(result.story_candidate, undefined)
      assert.equal(result.story_response_run_ids, undefined)
      assert.deepEqual(result.story, { ...candidate, characters: [{ name: '车夫', aliases: [], description: '收下钥匙，等待林舟回家。', section_ids: [0] }] },
        'targeted repair leaves the saved summary, timeline, threads, ending and uncertainties untouched')
    } finally { await analyzer.close(); run('DELETE FROM projects WHERE id=?', item.id) }
  })
})


test('public analysis marks uncertain dispatch as blocked without changing the ledger on reads', () => {
  const item = project('未知请求恢复状态'), runId = 'ui-blocked-run'
  markSourceModelRun(item.id, runId)
  const document = { project_id: item.id, filename: '未知请求恢复状态.txt', content: '未知请求恢复状态：林舟得到钥匙，调查结束后回家。', updated_at: item.stamp }
  const state = { id: runId, source_version: scriptSourceVersion(document), model_id: 'model', status: 'failed',
    phase: 'synthesis', pipeline_version: sourceAnalysisPipelineVersion, completed_chunks: 1, total_chunks: 1,
    sections: [{ offset: 0, length: document.content.length, title: '完整剧情', episode_number: null, summary: '调查后回家', characters: [], events: [] }],
    error: '未知断线', updated_at: now() }
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
    item.id, runId, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  run('INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    item.id, 'scope-ui', 'request-ui', runId, 'dispatched', 'unknown', null, now())
  const before = JSON.stringify(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(item.id))
  for (let i = 0; i < 2; i++) {
    const analysis = scriptSourceDocument(item.id)!.analysis!
    assert.equal(analysis.resume?.available, false); assert.equal(analysis.resume?.blocked, true)
    assert.match(analysis.resume!.message, /核对提供商记录/)
    assert.equal(analysis.sections.length, 1)
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(item.id)), before)
  const analyzer = createScriptSourceAnalyzer(async () => { throw new Error('blocked continuation must not run') })
  assert.throws(() => analyzer.start(item.id, 'model'), { code: 'source_request_unknown' })
  assert.equal(scriptSourceAnalysis(item.id)!.id, runId, 'a blocked POST cannot replace the retained failed analysis')
  void analyzer.close()
  run("UPDATE source_model_requests SET state='failed',delivery='output_started' WHERE project_id=?", item.id)
  assert.equal(scriptSourceDocument(item.id)!.analysis!.resume?.blocked, undefined)
  assert.equal(scriptSourceDocument(item.id)!.analysis!.resume?.available, true)
})

test('a replacement analysis exposes the unresolved request from the same directory run', async () => {
  const item = project('跨轮次目录恢复'), runId = 'replacement-directory', previousId = 'previous-directory'
  const document = { project_id: item.id, filename: '跨轮次目录恢复.txt', content: '跨轮次目录恢复：林舟得到钥匙，调查结束后回家。', updated_at: item.stamp }
  const state = { id: runId, source_version: scriptSourceVersion(document), model_id: 'model', status: 'failed',
    phase: 'reading', analysis_mode: 'extract', pipeline_version: sourceAnalysisPipelineVersion,
    completed_chunks: 0, total_chunks: 1, sections: [], updated_at: now(),
    failure: { stage: 'content', message: '文本模型生成失败：上次原稿分析请求的受理结果未知，不能自动重新生成。' } }
  markSourceModelRun(item.id, runId)
  markSourceModelRun(item.id, previousId)
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
    item.id, runId, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  for (const owner of [runId, previousId, 'unrelated-directory']) {
    run('INSERT INTO source_request_dispatch_links (project_id,scope,request_key,run_id,source_updated_at,local_request_id) VALUES (?,?,?,?,?,?)',
      item.id, owner === 'unrelated-directory' ? 'other-scope' : 'same-scope', 'first-page', owner, item.stamp, owner)
  }
  for (const [scope, owner] of [['same-scope', previousId], ['other-scope', 'unrelated-directory']]) {
    run('INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,?)',
      item.id, scope, 'second-page', owner, 'dispatched', 'unknown', item.stamp)
  }
  const analyzer = createScriptSourceAnalyzer(async () => { throw new Error('no model call expected') })
  try {
    assert.equal(scriptSourceDocument(item.id)!.analysis!.resume?.action, 'reconcile_request')
    assert.deepEqual(analyzer.requestRecovery(item.id).blockers.map(blocker => blocker.run_id), [previousId])
    assert.throws(() => analyzer.start(item.id, 'model'), { code: 'source_request_unknown' })
    run("UPDATE script_source_analyses SET status='paused',snapshot=? WHERE project_id=?",
      JSON.stringify({ ...state, status: 'paused', failure: undefined }), item.id)
    assert.equal(scriptSourceDocument(item.id)!.analysis!.resume?.action, 'reconcile_request')
    assert.deepEqual(analyzer.requestRecovery(item.id).blockers.map(blocker => blocker.run_id), [previousId])
  } finally { await analyzer.close(); run('DELETE FROM projects WHERE id=?', item.id) }
})

for (const incomplete of [false,true]) test(`explicit continue preserves ${incomplete?'uncertain intent':'completed paid correction'} and cannot buy another whole correction`, async()=>{
  const item=project(incomplete?'不确定纠正保护':'完成纠正本地重验')
  let initial=0, corrections=0
  const generator=async(_project:string,_model:string,prompt:string,contract:any)=>{
    if(contract?.name==='script_source_map_local_repair') {
      corrections++
      if(incomplete) throw Object.assign(new Error('unknown correction delivery'),{delivery:'unknown'})
      return '{"repairs":{}}'
    }
    if(contract?.name==='script_source_map') {
      initial++
      const value=JSON.parse(sourceAnalysisFixture(prompt)!)
      value.sections[0].events[0].evidence.unit_id=[value.sections[0].events[0].evidence.unit_id]
      return JSON.stringify(value)
    }
    throw new Error('unexpected downstream generation')
  }
  let analyzer=createScriptSourceAnalyzer(generator,limits)
  async function failed(){
    for(let i=0;i<200;i++){
      const state=scriptSourceAnalysis(item.id)
      if(state?.status==='failed')return state
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    assert.fail('did not fail')
  }
  try{
    analyzer.start(item.id,'model');const first=await failed()
    const before=structuredClone(first.work![0]!.output_checkpoint)
    assert.ok((before as any).correction_started)
    assert.equal(!!before!.correction,!incomplete)
    assert.equal(initial,1);assert.equal(corrections,1)
    await analyzer.close();analyzer=createScriptSourceAnalyzer(generator,limits)
    analyzer.start(item.id,'model');const resumed=await failed()
    assert.equal(initial,1);assert.equal(corrections,1,'continue cannot reset dispatch intent or completed correction')
    assert.deepEqual(resumed.work![0]!.output_checkpoint,before)
    assert.equal(resumed.status,'failed');assert.equal(resumed.story,undefined)
  }finally{await analyzer.close();run('DELETE FROM projects WHERE id=?',item.id)}
})
