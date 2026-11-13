import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-analysis-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, createScriptSourceAnalyzer, scriptSourceAnalysis, scriptSourcePassages, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceIndex, scriptSourceFallbackContext } = await import('../src/modules/script/script-source-documents.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

function project(content: string) {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '剧本地图测试', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '剧本.txt', content, stamp)
  return id
}
const mapReply = (prompt: string) => sourceAnalysisFixture(prompt)!
async function terminal(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = scriptSourceAnalysis(id)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('analysis did not finish')
}

test('long-script maps cover every source character and persist verified original positions', async () => {
  const content = `第1集\n${'林舟回家。\n'.repeat(4000)}第2集\n终场事实：林舟发现故乡已经改变。`
  const id = project(content), prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return mapReply(prompt) })
  try {
    const queued = analyzer.start(id, 'model')
    assert.equal(queued.status, 'queued')
    assert.match(scriptSourceFallbackContext(id), /分析尚未完成/); assert.doesNotMatch(scriptSourceFallbackContext(id), /终场事实/)
    assert.match(scriptSourceFallbackContext(id), /本轮已提供完整原稿时可直接依据全文讨论或整理故事大纲/)
    const state = await terminal(id)
    assert.equal(state.status, 'ready', state.error || '')
    assert.ok(prompts.length > 1)
    assert.equal(prompts.filter(prompt => prompt.includes('【原文片段】')).length, state.total_chunks)
    assert.equal(prompts.filter(prompt => prompt.includes('【全剧整合资料】')).length, 1)
    assert.equal(batchUnits(prompts[0]!).map(unit => unit.text).join(''), content)
    assert.ok(state.total_chunks > 1)
    assert.equal(state.completed_chunks, state.total_chunks)
    assert.equal(state.sections.map(section => content.slice(section.offset, section.offset + section.length)).join(''), content)
    for (const section of state.sections) for (const event of section.events) assert.equal(content.slice(event.evidence.offset, event.evidence.offset + event.evidence.quote.length), event.evidence.quote)
    assert.match(state.sections.at(-1)!.events[0]!.evidence.quote, /故乡已经改变/)
    assert.equal(scriptSourceIndex(id)!.story_map?.length, state.sections.length)
    assert.equal(scriptSourceFallbackContext(id), '')
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(id)!.content, content)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(id)!.count, 0)
    assert.equal(scriptSourcePassages(`a${'😀'.repeat(1200)}`).map(passage => passage.content).join(''), `a${'😀'.repeat(1200)}`)
  } finally { await analyzer.close() }
})

test('the exact 100,000-character limit is read whole and oversized direct analysis is rejected before a model call', async () => {
  const content = '完整剧情。'.repeat(20_000), id = project(content)
  assert.equal(content.length, 100_000)
  let mapCalls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【原文片段】')) {
      mapCalls++; assert.equal(batchUnits(prompt).map(unit => unit.text).join(''), content)
    }
    return mapReply(prompt)
  })
  try {
    analyzer.start(id, 'model'); const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(mapCalls, ready.total_chunks)
    assert.ok(mapCalls > 1)
    const completedMapCalls = mapCalls
    const oversizedId = project(`${content}超`)
    assert.throws(() => analyzer.start(oversizedId, 'model'), /不能超过 10 万字符/)
    await assert.rejects(analyzeSourceSnapshot({ project_id: oversizedId, filename: '剧本.txt', content: `${content}超`, updated_at: '' }, 'model',
      async () => { throw new Error('must reject before invoking model') }, new AbortController().signal), /不能超过 10 万字符/)
    assert.equal(mapCalls, completedMapCalls)
  } finally { await analyzer.close() }
})

test('synthesis failure preserves the full-source map and retry only repeats whole-story synthesis', async () => {
  const id = project('正文与对白。\n'.repeat(2500))
  let calls = 0, fail = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (++calls === 2 && fail) throw new Error('提供商暂时不可用')
    return mapReply(prompt)
  })
  try {
    analyzer.start(id, 'model')
    const failed = await terminal(id)
    assert.equal(failed.status, 'failed'); assert.equal(failed.completed_chunks, 1)
    assert.ok(failed.started_at)
    assert.match(failed.error!, /暂时不可用/)
    assert.equal(scriptSourceIndex(id)!.story_map, undefined)
    assert.match(scriptSourceFallbackContext(id), /分析尚未完成/)
    fail = false
    const retryAt = Date.now(), retry = analyzer.start(id, 'model')
    assert.equal(retry.status, 'queued'); assert.equal(retry.started_at, undefined, 'retry must not expose the failed execution clock while queued')
    const ready = await terminal(id)
    assert.ok(Date.parse(ready.started_at!) >= retryAt)
    assert.equal(ready.status, 'ready'); assert.equal(calls, ready.total_chunks + 3, 'one failed synthesis, its resumed synthesis, and the independent content review follow the saved map')
    assert.equal(ready.sections[0]!.offset, failed.sections[0]!.offset)
    assert.equal(analyzer.start(id, 'model').id, ready.id, 'ready maps are reused without another model call')
  } finally { await analyzer.close() }
})

test('replacing or deleting a source cancels analysis and late results cannot resurrect its old map', async () => {
  const id = project('旧版剧本，不可写入新版地图。')
  let release: () => void = () => {}, began: () => void = () => {}
  const started = new Promise<void>(resolve => { began = resolve })
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('旧版剧本')) return new Promise<string>(resolve => { release = () => resolve(mapReply(prompt)); began() })
    return mapReply(prompt)
  })
  try {
    const old = analyzer.start(id, 'model'); await started
    analyzer.cancel(id)
    run('UPDATE script_source_documents SET content=? WHERE project_id=?', '新版剧本，结尾保留。', id)
    assert.equal(scriptSourceAnalysis(id), null, 'a changed source invalidates the cached map immediately')
    analyzer.start(id, 'model')
    const ready = await terminal(id)
    release(); await new Promise(resolve => setTimeout(resolve, 10))
    assert.notEqual(ready.id, old.id)
    assert.equal(scriptSourceAnalysis(id)!.id, ready.id)
    assert.doesNotMatch(JSON.stringify(ready), /旧版剧本/)
    analyzer.cancel(id); run('DELETE FROM script_source_documents WHERE project_id=?', id)
    assert.equal(scriptSourceAnalysis(id), null)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_source_analyses WHERE project_id=?').get(id)!.count, 0)
  } finally { release(); await analyzer.close() }
})

test('invented evidence IDs stop when exact local correction repeats without progress instead of becoming a ready map', async () => {
  const id = project('真实原文：林舟回家。'), repairPrompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【局部证据修复】')) {
      repairPrompts.push(prompt)
      return JSON.stringify({ fixes: [{ kind: 'events', index: 0, summary: '林舟回家', unit_id: 999 }] })
    }
    const value = JSON.parse(mapReply(prompt)); value.sections[0].events[0].evidence.unit_id = 999
    return JSON.stringify(value)
  })
  try {
    analyzer.start(id, 'model')
    const state = await terminal(id)
    assert.equal(state.status, 'failed'); assert.equal(state.completed_chunks, 0); assert.equal(state.sections.length, 0)
    assert.match(state.error!, /相同已保存结果.*同一问题.*未取得新进展/)
    assert.match(state.error!, /unit_id=999/)
    assert.equal(repairPrompts.length, 4, 'two identical failed correction cycles stop without a global request ceiling')
    assert.ok(state.work![0]!.result, 'the parsed map is retained for an explicit resume')
    assert.ok(repairPrompts.some(prompt => /unit_id=999.*正文范围/.test(prompt)), 'the precise invalid ID is available to the automatic correction')
  } finally { await analyzer.close() }
})

test('service restart resumes saved analysis progress instead of leaving running status stuck', async () => {
  const id = project('剧本原文。\n'.repeat(2500))
  let began: () => void = () => {}, release: () => void = () => {}, calls = 0
  const started = new Promise<void>(resolve => { began = resolve })
  const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (++calls === 2) return new Promise<string>(resolve => { release = () => resolve(mapReply(prompt)); began() })
    return mapReply(prompt)
  })
  first.start(id, 'model'); await started; await first.close(); release()
  assert.equal(scriptSourceAnalysis(id)!.status, 'queued')
  assert.equal(scriptSourceAnalysis(id)!.started_at, undefined, 'service shutdown ends the current execution clock before requeueing')
  assert.equal(scriptSourceAnalysis(id)!.completed_chunks, 1)
  const saved = scriptSourceAnalysis(id)!, resumedMapPages: number[] = []
  let resumedCalls = 0
  const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    resumedCalls++
    if (prompt.includes('【原文片段】')) {
      const marker = '【原文片段】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      resumedMapPages.push(input.output_window.page)
    }
    return mapReply(prompt)
  })
  try {
    const restartedAt = Date.now()
    second.recover()
    const ready = await terminal(id)
    assert.ok(Date.parse(ready.started_at!) >= restartedAt)
    assert.equal(ready.status, 'ready')
    assert.equal(resumedCalls, ready.total_chunks - saved.completed_chunks + 2, 'only unfinished directory pages, story synthesis and independent review are requested')
    assert.deepEqual(resumedMapPages, Array.from({ length: ready.total_chunks - saved.completed_chunks }, (_, index) => saved.completed_chunks + index + 1))
    assert.deepEqual(ready.sections.slice(0, saved.sections.length), saved.sections, 'saved directory pages survive the restart unchanged')
  } finally { await second.close() }
})

test('model-selected sentence IDs split scenes without copied anchors or invented offsets', async () => {
  const content = '开场林舟得到钥匙。随后同一段叙述结束。转场：伙伴来到河岸。终场归还钥匙。'
  const id = project(content)
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return mapReply(prompt)
    const marker = '【原文片段】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    const units = input.passages.flatMap((passage: { units: Array<{ id: number; text: string }> }) => passage.units)
    return JSON.stringify({ sections: [{ start_unit: units[0].id, title: '得到钥匙', episode_number: null, summary: '林舟得到钥匙', characters: [], events: [] },
      { start_unit: units.find((unit: { text: string }) => unit.text.startsWith('转场')).id, title: '河岸归还', episode_number: null, summary: '伙伴归还钥匙', characters: [], events: [{ summary: '归还', evidence: { unit_id: units.at(-1).id } }] }] })
  })
  try {
    analyzer.start(id, 'model'); const state = await terminal(id)
    assert.equal(state.status, 'ready', state.error || '')
    assert.equal(state.sections[1].offset, content.indexOf('转场'))
    assert.equal(state.sections.map(section => content.slice(section.offset, section.offset + section.length)).join(''), content)
  } finally { await analyzer.close() }
})
test('model-selected continuous scenes retain one semantic unit while episode changes start another in one full read', async () => {
  for (const differentEpisode of [false, true]) {
    const id = project('同一场戏，持续行动。'.repeat(1600)); let maps = 0
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return mapReply(prompt)
      maps++; const units = batchUnits(prompt)
      return JSON.stringify({ sections: [
        { ...sectionAt(units[0]!.id, '行动开始'), episode_number: 1 },
        { ...sectionAt(units.at(-1)!.id, '行动继续'), episode_number: differentEpisode ? 2 : 1, continues_previous: true },
      ] })
    })
    try {
      analyzer.start(id, 'model'); const state = await terminal(id)
      assert.equal(state.status, 'ready', state.error || '')
      assert.equal(maps, 1)
      assert.equal(state.sections[1].continues_previous, !differentEpisode)
      assert.equal(state.sections[1].unit_id === state.sections[0].unit_id, !differentEpisode)
    } finally { await analyzer.close() }
  }
})

const batchUnits = (prompt: string): Array<{ id: number; text: string }> => {
  const marker = '【原文片段】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
  return input.passages.flatMap((passage: { units: Array<{ id: number; text: string }> }) => passage.units)
}
const sectionAt = (id: number, title: string, evidence = id) => ({ start_unit: id, title, episode_number: null, summary: title, characters: [],
  events: [{ summary: title, evidence: { unit_id: evidence } }] })

test('retry reuses the parsed map and valid siblings, sending only damaged section evidence for local repair', async () => {
  const content = '返乡：主角回到旧屋。河岸：伙伴归还钥匙。终章：众人告别。', id = project(content)
  let mapCalls = 0, repairCalls = 0, unavailable = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return mapReply(prompt)
    if (prompt.includes('【局部证据修复】')) {
      repairCalls++
      const marker = '【局部证据修复】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.equal(input.units.map((unit: { text: string }) => unit.text).join(''), '河岸：伙伴归还钥匙。')
      assert.equal(input.issues.length, 1)
      if (unavailable) throw new Error('HTTP 503 provider unavailable')
      return JSON.stringify({ fixes: [{ kind: 'events', index: 0, summary: '伙伴归还钥匙', unit_id: input.units[0].id }] })
    }
    mapCalls++; const units = batchUnits(prompt)
    return JSON.stringify({ sections: [sectionAt(units[0]!.id, '返乡'), sectionAt(units[1]!.id, '河岸', 999), sectionAt(units[2]!.id, '告别')] })
  })
  try {
    analyzer.start(id, 'model'); const failed = await terminal(id)
    assert.equal(failed.status, 'failed'); assert.equal(mapCalls, 1); assert.equal(repairCalls, 1)
    assert.equal(failed.sections.length, 0)
    assert.equal(failed.work!.length, 1)
    assert.ok(failed.work![0]!.result, 'the full parsed map survives a local evidence failure')
    unavailable = false; analyzer.start(id, 'model'); const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(mapCalls, 1); assert.equal(repairCalls, 2)
    assert.equal(ready.sections[0]!.title, '返乡'); assert.equal(ready.sections.length, 3)
    assert.equal(ready.work, undefined)
  } finally { await analyzer.close() }
})

test('completed local evidence fixes survive a later repair interruption without another full-source read', async () => {
  const content = '返乡：主角回到旧屋。河岸：伙伴归还钥匙。终章：众人告别。', id = project(content)
  const repairedTitles: string[] = []; let mapCalls = 0, unavailable = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return mapReply(prompt)
    if (prompt.includes('【局部证据修复】')) {
      const marker = '【局部证据修复】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      repairedTitles.push(input.title)
      if (input.title === '告别' && unavailable) throw new Error('provider interrupted after first exact repair')
      return JSON.stringify({ fixes: [{ kind: 'events', index: 0, summary: input.title, unit_id: input.units[0].id }] })
    }
    mapCalls++; const units = batchUnits(prompt)
    return JSON.stringify({ sections: [sectionAt(units[0]!.id, '返乡'), sectionAt(units[1]!.id, '河岸', 999), sectionAt(units[2]!.id, '告别', 999)] })
  })
  try {
    analyzer.start(id, 'model'); assert.equal((await terminal(id)).status, 'failed')
    unavailable = false; analyzer.start(id, 'model'); const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(mapCalls, 1); assert.deepEqual(repairedTitles, ['河岸', '告别', '告别'])
  } finally { await analyzer.close() }
})

test('persistent evidence problems stop without splitting or re-reading any source range', async () => {
  const content = `返乡。${'河岸漫长的行动。'.repeat(260)}告别。`, id = project(content)
  let maps = 0, repairs = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return mapReply(prompt)
    if (prompt.includes('【局部证据修复】')) { repairs++; return JSON.stringify({ fixes: [{ kind: 'events', index: 0, summary: '行动', unit_id: 999999 }] }) }
    maps++; const units = batchUnits(prompt)
    return JSON.stringify({ sections: [sectionAt(units[0]!.id, '返乡'), sectionAt(units[1]!.id, '河岸', 999999), sectionAt(units.at(-1)!.id, '告别')] })
  })
  try {
    analyzer.start(id, 'model'); const failed = await terminal(id)
    assert.equal(failed.status, 'failed')
    assert.equal(maps, 1); assert.equal(repairs, 4)
    assert.match(failed.error!, /相同已保存结果.*未取得新进展/)
    assert.match(failed.error!, /unit_id=999999/)
    assert.equal(failed.work!.length, 1); assert.equal(failed.work![0]!.depth, 0)
    assert.equal(failed.story, undefined)
  } finally { await analyzer.close() }
})

test('unusable model structure stops on repeated identical diagnosis without subdivisions', async () => {
  const id = project('连续剧情。'.repeat(800)); let calls = 0
  const analyzer = createScriptSourceAnalyzer(async () => { calls++; return '{"sections":[]}' })
  try {
    analyzer.start(id, 'model'); const failed = await terminal(id)
    assert.equal(failed.status, 'failed'); assert.equal(calls, 4)
    assert.match(failed.error!, /相同已保存结果.*未取得新进展/)
    assert.equal(failed.work!.length, 1); assert.equal(failed.work![0]!.depth, 0); assert.equal(failed.sections.length, 0)
    assert.equal(failed.story, undefined)
  } finally { await analyzer.close() }
})

test('identical analysis after a full rebuild stops automatic looping and an explicit resume retains its checkpoint', async () => {
  const id = project('林舟返乡。资源已经用尽。'), repairMarker = '【原稿分析定点修补资料】\n', reviewMarker = '【原稿分析核对资料】\n'
  let maps = 0, stories = 0, repairs = 0, reviews = 0, resolved = false
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(repairMarker)) {
      repairs++
      return JSON.stringify({ status: 'requires_full_rebuild', reason: '问题涉及章节边界，需要重新核对目录。', changes: [] })
    }
    if (prompt.includes(reviewMarker)) {
      reviews++
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length))
      return JSON.stringify({ checked_section_ids: input.sections.map((section: { id: number }) => section.id),
        findings: resolved ? [] : [{ kind: 'omission', explanation: reviews === 1 ? '遗漏资源已经用尽的限制。' : '资源已经用尽的事实仍未保留。', unit_ids: [input.units.at(-1).id] }] })
    }
    if (prompt.includes('【原文片段】')) maps++
    if (prompt.includes('【全剧整合资料】')) stories++
    return mapReply(prompt)
  })
  try {
    analyzer.start(id, 'model'); const failed = await terminal(id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error!, /相同已保存结果.*未取得新进展/)
    assert.match(failed.error!, /资源已经用尽/)
    assert.deepEqual([maps, stories, repairs, reviews], [2, 2, 1, 2], 'a full reconstruction that reproduces the same diagnosis cannot repeat indefinitely')
    assert.equal(failed.completed_chunks, failed.total_chunks)
    assert.ok(failed.story); assert.ok(failed.sections.length)
    assert.equal(failed.quality!.status, 'issues')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(id)!.count, 0)
    const retained = structuredClone(failed.sections)
    resolved = true
    const continuing = analyzer.start(id, 'model')
    assert.deepEqual(continuing.sections, retained, 'manual resume adopts the exact saved interpretation before continuing its unfinished step')
    const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.quality!.status, 'passed')
    assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(id)!.content, '林舟返乡。资源已经用尽。')
  } finally { await analyzer.close() }
})

test('format corrections can exceed legacy time budgets and pending transport stops only on explicit pause', async () => {
  const id = project('主角返乡。'); let mapCalls = 0; const signals: AbortSignal[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt, _contract, signal) => {
    signals.push(signal)
    if (prompt.includes('【原文片段】')) {
      mapCalls++; await new Promise(resolve => setTimeout(resolve, 30))
      signal.throwIfAborted()
      if (mapCalls === 1) return '{}'
    }
    return mapReply(prompt)
  }, { reading: 10, repairing: 10, synthesis: 10 })
  try {
    analyzer.start(id, 'model'); const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(mapCalls, 2)
    assert.ok(signals.every(signal => !signal.aborted), 'elapsed legacy budgets cannot cancel useful source analysis')
    assert.ok(ready.story)
  } finally { await analyzer.close() }
  const pendingId = project('短文无需继续细分。')
  let pendingSignal: AbortSignal | undefined, pendingCalls = 0, entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = createScriptSourceAnalyzer(async (_id, _model, prompt, _contract, signal) => {
    pendingCalls++
    if (prompt.includes('【全剧整合资料】')) {
      pendingSignal = signal; entered()
      await new Promise<void>(resolve => { release = resolve })
    }
    return mapReply(prompt)
  }, { reading: 10, repairing: 10, synthesis: 10 })
  try {
    const execution = pending.start(pendingId, 'model'); await started
    await new Promise(resolve => setTimeout(resolve, 30))
    const retained = scriptSourceAnalysis(pendingId)!
    assert.equal(retained.status, 'running'); assert.equal(pendingCalls, 2); assert.equal(pendingSignal!.aborted, false)
    assert.ok(retained.sections.length)
    const paused = pending.pause(pendingId, execution.id)
    assert.equal(paused.status, 'paused'); assert.equal(pendingSignal!.aborted, true)
    assert.deepEqual(paused.sections, retained.sections, 'an explicit stop retains the completed map')
    release(); await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(scriptSourceAnalysis(pendingId)!.status, 'paused', 'late cancelled output cannot publish a completed result')
    assert.equal(pendingCalls, 2)
  } finally { release?.(); await pending.close() }
})

test('legacy partial maps rebuild from the entire source rather than resuming old split checkpoints', async () => {
  const content = '已分析的文字和未分析文字在同一个句段中。后续完整剧情。', id = project(content), end = content.indexOf('和')
  const state = { id: newId(), source_version: scriptSourceVersion({ project_id: id, filename: '剧本.txt', content, updated_at: '' }), model_id: 'model',
    status: 'failed', completed_chunks: 1, total_chunks: 2, error: 'old failure', updated_at: now(),
    sections: [{ offset: 0, length: end, title: '已完成', summary: '已完成', episode_number: null, characters: [], events: [] }] }
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  let mapCalls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes('【原文片段】')) { mapCalls++; assert.equal(batchUnits(prompt).map(unit => unit.text).join(''), content) }
    return mapReply(prompt)
  })
  try {
    analyzer.start(id, 'model'); const ready = await terminal(id)
    assert.equal(ready.status, 'ready', ready.error || ''); assert.equal(mapCalls, 1)
    assert.notEqual(ready.sections[0]!.title, state.sections[0]!.title)
    assert.equal(ready.completed_characters, content.length)
  } finally { await analyzer.close() }
})

test('legacy ready and recovered running analyses cannot reuse segmented maps as current full-source understanding', async () => {
  for (const status of ['ready', 'running', 'queued']) {
    const content = '开场明确人物关系。\n第2集\n全剧结尾完成回收。', id = project(content)
    const state = { id: newId(), source_version: scriptSourceVersion({ project_id: id, filename: '剧本.txt', content, updated_at: '' }), model_id: 'model',
      pipeline_version: 3, status, completed_chunks: 1, total_chunks: 2, error: null, updated_at: now(),
      sections: [{ offset: 0, length: content.indexOf('\n'), title: '旧分批目录', summary: '只有开头', episode_number: null, characters: [], events: [] }],
      work: [{ offset: 0, length: content.indexOf('\n'), depth: 0 }, { offset: content.indexOf('\n'), length: content.length - content.indexOf('\n'), depth: 0 }] }
    run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)', id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
    assert.equal(scriptSourceAnalysis(id), null)
    let reads = 0
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      if (prompt.includes('【原文片段】')) { reads++; assert.equal(batchUnits(prompt).map(unit => unit.text).join(''), content) }
      return mapReply(prompt)
    })
    try {
      if (status === 'ready') analyzer.start(id, 'model')
      else {
        analyzer.recover()
        const interrupted = await terminal(id)
        assert.equal(interrupted.status, 'failed')
        assert.match(interrupted.error || '', /受理状态未知/)
        assert.equal(reads, 0, 'legacy in-flight work cannot be automatically submitted again')
        assert.equal(interrupted.sections[0]!.title, '旧分批目录', 'old partial work remains available for diagnosis')
        analyzer.start(id, 'model')
      }
      const ready = await terminal(id)
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(reads, ready.total_chunks)
      assert.ok(reads >= 1)
      assert.doesNotMatch(JSON.stringify(ready), /旧分批目录/)
    } finally { await analyzer.close() }
  }
})
