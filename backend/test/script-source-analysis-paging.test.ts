import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { resolveSourceSections, scriptSourcePassages, sourceAnalysisPipelineVersion, sourceMapSchema, sourceWorkPlan,
  validateSourceCoverage, workPassages } from '../src/modules/script/script-source-map.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-analysis-paging-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceIndex } = await import('../src/modules/script/script-source-documents.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const mapMarker = '【原文片段】\n', storyMarker = '【全剧整合资料】\n', reviewMarker = '【原稿分析核对资料】\n'
type Unit = { id: number; text: string }
type MapInput = { complete_source: boolean; passages: Array<{ units: Unit[] }>; output_window: {
  page: number; total: number; first_unit: number; last_unit: number; offset: number; length: number
} }
const inputFor = <T>(prompt: string, marker: string): T => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const limits = { reading: 300, repairing: 300, synthesis: 3000 }
const finalFact = '终场，沈月归还信物，城市恢复流动。'

function screenplay() {
  const headings = Array.from({ length: 59 }, (_, id) => `第${id + 1}集\n`)
  const remaining = 65594 - headings.join('').length
  return headings.map((heading, id) => {
    const length = Math.floor(remaining / headings.length) + (id < remaining % headings.length ? 1 : 0)
    return heading + ['一', '二', '三'].map((scene, sceneId) => {
      const sceneLength = Math.floor(length / 3) + (sceneId < length % 3 ? 1 : 0)
      const prefix = `场次${scene}\n林舟与沈月在第${id + 1}集第${scene}场寻找信物。`
      const suffix = id === 58 && sceneId === 2 ? `${finalFact}\n` : '城门的旧约仍被保留。😀\n \t\n'
      return prefix + '旧城里的人继续寻找原来的时间。'.repeat(50).slice(0, sceneLength - prefix.length - suffix.length) + suffix
    }).join('')
  }).join('')
}
const content = screenplay()
assert.equal(content.length, 65594)
const plan = sourceWorkPlan(scriptSourcePassages(content))

function project(label: string) {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, label, stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '59集完整剧本.txt', content, stamp)
  return id
}
async function terminal(id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const state = scriptSourceAnalysis(id)
    if (state?.status === 'ready' || state?.status === 'failed') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('analysis did not finish')
}

function assertFullContext(prompt: string) {
  if (prompt.includes(mapMarker)) {
    const input = inputFor<MapInput>(prompt, mapMarker)
    assert.equal(input.complete_source, true)
    assert.equal(input.passages.flatMap(passage => passage.units).map(unit => unit.text).join(''), content)
  } else if (prompt.includes(storyMarker)) {
    const input = inputFor<{ source: { content: string }; materials: Array<{ section: { id: number } }> }>(prompt, storyMarker)
    assert.equal(input.source.content, content)
    assert.equal(input.materials.length, 177, 'every synthesis task retains the complete dense directory')
  } else if (prompt.includes(reviewMarker)) {
    const input = inputFor<{ units: Unit[]; sections: unknown[] }>(prompt, reviewMarker)
    assert.equal(input.units.map(unit => unit.text).join(''), content)
    assert.equal(input.sections.length, 177)
  }
  assert.ok(prompt.includes(finalFact), 'even the first output page can see the final-episode fact')
}

function denseMap(input: MapInput) {
  const allUnits = input.passages.flatMap(passage => passage.units)
  const selected = allUnits.filter(unit => unit.id >= input.output_window.first_unit && unit.id <= input.output_window.last_unit)
  const starts = selected.flatMap((unit, index) => index === 0 || /^第\d+集\n/.test(unit.text) || /^场次[二三]\n/.test(unit.text) ? [index] : [])
  return { sections: starts.map((start, index) => {
    const local = selected.slice(start, starts[index + 1] ?? selected.length)
    const fact = local.find(unit => unit.text.includes('林舟与沈月'))!
    const ending = local.filter(unit => unit.text.trim()).at(-1)!
    assert.ok(fact)
    const episode = allUnits.slice(0, allUnits.findIndex(unit => unit.id === local[0]!.id) + 1)
      .filter(unit => /^第\d+集\n/.test(unit.text)).at(-1)!.text.match(/^第(\d+)集/)![1]!
    return { start_unit: local[0]!.id, title: `第${episode}集·${index}场`, episode_number: Number(episode), summary: fact.text.trim(),
      characters: [
        { name: '林舟', description: '寻找信物的主角', evidence: { unit_id: fact.id } },
        { name: '沈月', description: '共同寻找信物的人物', evidence: { unit_id: fact.id } },
      ], events: [{ summary: fact.text.trim(), evidence: { unit_id: fact.id } },
        { summary: ending.text.trim().slice(0, 160), evidence: { unit_id: ending.id } }], open_threads: [], continues_previous: false }
  }) }
}
function reply(prompt: string) {
  assertFullContext(prompt)
  return prompt.includes(mapMarker) ? JSON.stringify(denseMap(inputFor<MapInput>(prompt, mapMarker))) : sourceAnalysisFixture(prompt)!
}
function assertReady(id: string, state: ScriptSourceAnalysis) {
  assert.equal(state.status, 'ready', state.error || '')
  assert.equal(state.pipeline_version, sourceAnalysisPipelineVersion)
  assert.equal(state.completed_chunks, plan.length)
  assert.equal(state.total_chunks, plan.length)
  assert.equal(state.completed_characters, content.length)
  assert.equal(state.sections.length, 177)
  validateSourceCoverage(content, state.sections)
  assert.match(state.sections.at(-1)!.events.at(-1)!.evidence.quote, /沈月归还信物，城市恢复流动/)
  assert.ok(state.story!.timeline.some(event => event.summary.includes(finalFact)))
  assert.equal(state.quality?.status, 'passed')
  assert.equal(scriptSourceIndex(id)!.story_map!.length, 177)
  assert.equal(db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(id)!.content, content)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(id)!.count, 0)
}

test('65k/59-episode dense analysis keeps full context and resumes only the second page after an actual upstream failure', async () => {
  const id = project('第二页超时续跑'), pages: number[] = []
  let unavailable = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    assertFullContext(prompt)
    if (prompt.includes(mapMarker)) {
      const input = inputFor<MapInput>(prompt, mapMarker)
      pages.push(input.output_window.page)
      if (input.output_window.page === 2 && unavailable) throw new Error('上游第二页请求超时')
    }
    return reply(prompt)
  }, limits)
  try {
    analyzer.start(id, 'model')
    const failed = await terminal(id)
    assert.equal(failed.status, 'failed'); assert.equal(failed.completed_chunks, 1)
    assert.equal(failed.sections.length, 21)
    assert.equal(failed.completed_characters, plan[0]!.length)
    assert.equal(failed.story, undefined); assert.equal(failed.quality, undefined)
    assert.equal(scriptSourceIndex(id)!.story_map, undefined, 'partial pages cannot unlock a published source index')
    assert.match(failed.error!, /目录第 2\/.*上游第二页请求超时/)
    assert.deepEqual(pages, [1, 2])
    await assert.rejects(analyzer.ensure(id, 'model'), /请先重试/)
    const savedFirstPage = structuredClone(failed.sections)
    unavailable = false; analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, ready)
    assert.deepEqual(ready.sections.slice(0, savedFirstPage.length), savedFirstPage)
    assert.deepEqual(pages, [1, 2, ...plan.slice(1).map((_, index) => index + 2)])
  } finally { await analyzer.close() }
})

test('service shutdown and recovery of a persisted running task both resume after saved directory pages', async () => {
  for (const interruptedStatus of ['queued', 'running'] as const) {
    const id = project(`重启续跑-${interruptedStatus}`), firstPages: number[] = [], resumedPages: number[] = []
    let began!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      assertFullContext(prompt)
      if (prompt.includes(mapMarker)) {
        const page = inputFor<MapInput>(prompt, mapMarker).output_window.page
        firstPages.push(page)
        if (page === 3) return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
      }
      return reply(prompt)
    }, limits)
    first.start(id, 'model'); await started; await first.close()
    const interrupted = scriptSourceAnalysis(id)!
    assert.equal(interrupted.status, 'queued'); assert.equal(interrupted.completed_chunks, 2)
    assert.equal(interrupted.started_at, undefined)
    if (interruptedStatus === 'running') {
      interrupted.status = 'running'; interrupted.started_at = '2000-01-01T00:00:00.000Z'
      run('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?', 'running', JSON.stringify(interrupted), id)
    }
    release()
    const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      if (prompt.includes(mapMarker)) resumedPages.push(inputFor<MapInput>(prompt, mapMarker).output_window.page)
      return reply(prompt)
    }, limits)
    try {
      second.recover(); const ready = await terminal(id)
      assertReady(id, ready)
      assert.deepEqual(firstPages, [1, 2, 3])
      assert.deepEqual(resumedPages, plan.slice(2).map((_, index) => index + 3))
      assert.deepEqual(ready.sections.slice(0, interrupted.sections.length), interrupted.sections)
      assert.ok(Date.parse(ready.started_at!) > Date.parse('2000-01-01T00:00:00.000Z'))
    } finally { await second.close() }
  }
})

function saveLegacy(id: string, state: ScriptSourceAnalysis) {
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
    id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
}
function legacyState(id: string): ScriptSourceAnalysis {
  return { id: newId(), source_version: scriptSourceVersion({ project_id: id, filename: '59集完整剧本.txt', content, updated_at: '' }), model_id: 'model',
    pipeline_version: 5, status: 'failed', phase: 'reading', completed_chunks: 0, total_chunks: 1, sections: [], error: '旧全文步骤超时', updated_at: now(),
    work: [{ offset: 0, length: content.length, depth: 0 }] }
}
function completeLegacyMap(state: ScriptSourceAnalysis) {
  const passages = scriptSourcePassages(content), units = passages.flatMap(passage => passage.units)
  const value = denseMap({ complete_source: true, passages, output_window: { page: 1, total: 1, first_unit: 0,
    last_unit: units.at(-1)!.id, offset: 0, length: content.length } })
  state.sections = resolveSourceSections(sourceMapSchema.parse(value), passages).sections
  state.completed_chunks = 1; state.completed_characters = content.length; state.phase = 'synthesis'
}
function legacyStory(state: ScriptSourceAnalysis): ScriptSourceStory {
  return { summary: '已保存的整剧理解，继续复核时不能重写。', characters: ['林舟', '沈月'].map(name => ({ name, aliases: [], description: '原文明示人物', section_ids: [0] })),
    timeline: state.sections.map((section, id) => ({ summary: section.events.map(event => event.summary).join('；').slice(0, 600), section_ids: [id] })),
    threads: [{ setup: '寻找信物', payoff: finalFact, section_ids: [0, state.sections.length - 1] }],
    ending: { summary: finalFact, section_ids: [state.sections.length - 1] }, uncertainties: [] }
}

test('v5 failed analysis without a completed map adopts the new output plan instead of repeating the old whole-map work', async () => {
  const id = project('旧版零进度迁移'), pages: number[] = []
  saveLegacy(id, legacyState(id))
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(mapMarker)) pages.push(inputFor<MapInput>(prompt, mapMarker).output_window.page)
    return reply(prompt)
  }, limits)
  try {
    const queued = analyzer.start(id, 'model')
    assert.equal(queued.pipeline_version, sourceAnalysisPipelineVersion)
    assert.equal(queued.total_chunks, plan.length); assert.ok(plan.length > 1)
    assert.equal(queued.completed_chunks, 0)
    assertReady(id, await terminal(id))
    assert.deepEqual(pages, plan.map((_, index) => index + 1))
  } finally { await analyzer.close() }
})

test('v5 completed maps and stories retain validated progress while only unfinished synthesis or review runs', async () => {
  for (const withStory of [false, true]) {
    const id = project(`旧版完整目录-${withStory}`), state = legacyState(id), calls: string[] = []
    completeLegacyMap(state)
    if (withStory) state.story = legacyStory(state)
    saveLegacy(id, state)
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      calls.push(prompt.includes(mapMarker) ? 'map' : prompt.includes(storyMarker) ? 'story' : 'quality')
      return reply(prompt)
    }, limits)
    try {
      analyzer.start(id, 'model'); const ready = await terminal(id)
      assertReady(id, ready)
      assert.deepEqual(ready.sections, state.sections)
      assert.equal(calls.includes('map'), false)
      if (withStory) {
        assert.deepEqual(ready.story, state.story)
        assert.deepEqual(calls, ['quality'])
      } else assert.ok(calls.includes('story'))
    } finally { await analyzer.close() }
  }
})

test('a page using an ID outside its output window cannot publish or discard the previous validated page', async () => {
  const id = project('坏页范围隔离'), pages: number[] = [], corrections: string[] = []
  let invalid = true, invalidCalls = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(mapMarker)) {
      if (prompt.includes('【一次格式修正】')) corrections.push(prompt)
      const input = inputFor<MapInput>(prompt, mapMarker)
      pages.push(input.output_window.page)
      if (input.output_window.page === 2 && invalid) {
        if (++invalidCalls === 7) throw new Error('上游目录服务中断')
        const value = denseMap(input)
        value.sections[0]!.start_unit = 0
        return JSON.stringify(value)
      }
    }
    return reply(prompt)
  }, limits)
  try {
    analyzer.start(id, 'model'); const failed = await terminal(id)
    assert.equal(failed.status, 'failed'); assert.equal(failed.completed_chunks, 1)
    assert.match(failed.error!, /相同已保存结果上重复遇到同一问题/)
    assert.match(failed.error!, /script_source_analysis_stalled|手动继续分析当前步骤/)
    assert.equal(corrections.length, 2, 'each distinct recovery execution retains its single format correction')
    assert.ok(corrections.every(prompt => /start_unit=0.*不属于当前原文范围/.test(prompt)), 'format recovery receives the exact out-of-window boundary error')
    assert.deepEqual(pages, [1, 2, 2, 2, 2], 'the same failed page and diagnosis stop recovery without repeating the valid first page')
    assert.equal(scriptSourceIndex(id)!.story_map, undefined)
    const saved = structuredClone(failed.sections)
    assert.equal(failed.work![1]!.result, undefined, 'out-of-window map boundaries never become a checkpoint')
    invalid = false; analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, ready)
    assert.deepEqual(ready.sections.slice(0, saved.length), saved)
    assert.equal(pages.filter(page => page === 1).length, 1)
  } finally { await analyzer.close() }
})

test('a legacy full-rebuild correction resumes saved pages after an actual upstream interruption', async () => {
  const id = project('旧质量全重建检查点续跑'), pages: number[] = []
  const saved = legacyState(id), firstWork = plan[0]!, passages = scriptSourcePassages(content)
  const selected = workPassages(passages, firstWork), units = selected.flatMap(passage => passage.units)
  const fullInput: MapInput = { complete_source: true, passages, output_window: { page: 1, total: plan.length,
    first_unit: units[0]!.id, last_unit: units.at(-1)!.id, offset: firstWork.offset, length: firstWork.length } }
  const firstResult = denseMap(fullInput)
  saved.pipeline_version = sourceAnalysisPipelineVersion
  saved.work = structuredClone(plan); saved.total_chunks = plan.length; saved.completed_chunks = 1
  saved.sections = resolveSourceSections(sourceMapSchema.parse(firstResult), selected).sections
  saved.completed_characters = firstWork.length
  saved.quality = { input_hash: 'legacy-reviewed-analysis', status: 'issues', findings: [
    { kind: 'causality', explanation: '核对要求保留结局中信物归还的因果',
      unit_ids: [passages.flatMap(passage => passage.units).find(unit => unit.text.includes(finalFact))!.id] },
  ] }
  saved.quality_rebuild_for = saved.quality.input_hash
  saveLegacy(id, saved)
  const before = structuredClone(saved.sections)
  let unavailable = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    assertFullContext(prompt)
    if (prompt.includes(mapMarker)) {
      const page = inputFor<MapInput>(prompt, mapMarker).output_window.page
      pages.push(page)
      assert.ok(prompt.includes(saved.quality!.findings[0]!.explanation), 'legacy rebuild retains original quality evidence')
      if (page === 2 && unavailable) throw new Error('上游重建第二页连接中断')
    }
    return reply(prompt)
  }, limits)
  try {
    const queued = analyzer.start(id, 'model')
    assert.equal(queued.completed_chunks, 1); assert.deepEqual(queued.sections, before)
    const interrupted = await terminal(id)
    assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.completed_chunks, 1)
    assert.equal(interrupted.quality_rebuild_for, saved.quality.input_hash)
    assert.deepEqual(interrupted.sections, before)
    unavailable = false
    const continuing = analyzer.start(id, 'model')
    assert.deepEqual(continuing.sections, before)
    const ready = await terminal(id)
    assertReady(id, ready)
    assert.deepEqual(ready.sections.slice(0, before.length), before)
    assert.deepEqual(pages, [2, ...plan.slice(1).map((_, index) => index + 2)])
    assert.equal(ready.quality_rebuild_for, undefined)
  } finally { await analyzer.close() }
})
