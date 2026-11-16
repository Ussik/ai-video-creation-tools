import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { sourceMapSchema, scriptSourcePassages, validateSourceCoverage, type SourceMapResult } from '../src/modules/script/script-source-map.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-directory-repair-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { scriptSourceIndex, scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const mapMarker = '【原文片段】\n', boundaryMarker = '【目录边界定点修复】\n'
const storyMarker = '【全剧整合资料】\n', reviewMarker = '【原稿分析核对资料】\n'
const limits = { reading: 3000, repairing: 3000, synthesis: 3000 }
type Unit = { id: number; text: string }
type MapInput = { passages: Array<{ units: Unit[] }>; output_window: { page: number; total: number; first_unit: number; last_unit: number } }
type BoundaryInput = { first_unit: number; units: Unit[]; targets: Array<{ section_index: number; current_start: number; section: SourceMapResult['sections'][number] }> }
const inputFor = <T>(prompt: string, marker: string): T => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const smallSource = '完整剧本书名。第1集。林舟寻找信物。沈月交还信物。终场两人回家。'
function project(content = smallSource) {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '目录定点修复集成', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '完整剧本.txt', content, stamp)
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
function missingPrefix(prompt: string) {
  const input = inputFor<MapInput>(prompt, mapMarker)
  const units = input.passages.flatMap(p => p.units).filter(unit => unit.id >= input.output_window.first_unit && unit.id <= input.output_window.last_unit)
  const value = sourceMapSchema.parse(JSON.parse(sourceAnalysisFixture(prompt)!))
  value.sections[0]!.start_unit = units.find(unit => unit.id > input.output_window.first_unit && unit.text.trim())!.id
  const fact = units.find(unit => unit.id >= value.sections[0]!.start_unit && unit.text.includes('林舟'))
  if (fact) value.sections[0]!.characters = [{ name: '林舟', description: '寻找信物后回家的主人公', evidence: { unit_id: fact.id } }]
  return value
}
function prefixPatch(input: BoundaryInput) {
  const prefix = sourceMapSchema.parse({ sections: [{ start_unit: input.first_unit, title: '保留的原文前缀', episode_number: null,
    summary: input.units.filter(unit => unit.id < input.targets[0]!.current_start).map(unit => unit.text).join('').trim() || '原文标题与引导',
    characters: [], events: [] }] }).sections
  return JSON.stringify({ prefix_sections: prefix, starts: [] })
}
function rawFromResolved(section: ScriptSourceSection, content: string) {
  const units = scriptSourcePassages(content).flatMap(p => p.units)
  return sourceMapSchema.parse({ sections: [{ start_unit: units.find(unit => unit.offset === section.offset)!.id, title: section.title,
    episode_number: section.episode_number, summary: section.summary, continues_previous: section.continues_previous,
    open_threads: section.open_threads,
    characters: section.characters.map(item => ({ ...item, evidence: { unit_id: units.find(unit => unit.offset === item.evidence.offset)!.id } })),
    events: section.events.map(item => ({ ...item, evidence: { unit_id: units.find(unit => unit.offset === item.evidence.offset)!.id } })) }] }).sections[0]!
}
function assertReady(id: string, content: string, state: ScriptSourceAnalysis) {
  assert.equal(state.status, 'ready', state.error || '')
  assert.equal(state.quality?.status, 'passed')
  assert.equal(state.completed_chunks, state.total_chunks)
  validateSourceCoverage(content, state.sections)
  assert.equal(scriptSourceIndex(id)!.story_map?.length, state.sections.length)
  assert.equal((db.prepare('SELECT content FROM script_source_documents WHERE project_id=?').get(id) as { content: string }).content, content)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM script_artifacts WHERE project_id=?').get(id) as { n: number }).n, 0)
}

test('missing opening receives one prefix patch without regenerating valid body, then passes independent review', async () => {
  const id = project(), calls = { map: 0, boundary: 0, story: 0, review: 0 }
  let original: SourceMapResult | undefined
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(boundaryMarker)) {
      calls.boundary++
      const retained = scriptSourceAnalysis(id)!
      assert.deepEqual(retained.work![0]!.result, original, 'complete schema-valid body is saved before repair dispatch')
      assert.equal(scriptSourceIndex(id)!.story_map, undefined, 'private candidate cannot publish an index')
      return prefixPatch(inputFor<BoundaryInput>(prompt, boundaryMarker))
    }
    if (prompt.includes(mapMarker)) { calls.map++; original = missingPrefix(prompt); return JSON.stringify(original) }
    if (prompt.includes(storyMarker)) calls.story++
    if (prompt.includes(reviewMarker)) calls.review++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, smallSource, ready)
    assert.equal(JSON.stringify(ready.sections.slice(1).map(section => rawFromResolved(section, smallSource))), JSON.stringify(original!.sections))
    assert.deepEqual(calls, { map: 1, boundary: 1, story: 1, review: 1 })
  } finally { await analyzer.close() }
})

test('failed boundary repair retains private candidate and explicit resume patches only that candidate', async () => {
  const id = project(), calls = { map: 0, boundary: 0, story: 0, review: 0 }
  let invalidPatch = true, original: SourceMapResult | undefined
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(boundaryMarker)) {
      calls.boundary++
      return invalidPatch ? JSON.stringify({ prefix_sections: [], starts: [] }) : prefixPatch(inputFor<BoundaryInput>(prompt, boundaryMarker))
    }
    if (prompt.includes(mapMarker)) { calls.map++; original = missingPrefix(prompt); return JSON.stringify(original) }
    if (prompt.includes(storyMarker)) calls.story++
    if (prompt.includes(reviewMarker)) calls.review++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(id, 'model')
    const failed = await terminal(id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.completed_chunks, 0)
    assert.deepEqual(failed.work![0]!.result, original)
    assert.equal(failed.work![0]!.boundary_repair?.status, 'failed')
    assert.equal(scriptSourceIndex(id)!.story_map, undefined)
    const exposed = scriptSourceDocument(id)!.analysis!
    assert.equal(Object.hasOwn(exposed, 'work'), false)
    assert.equal(Object.hasOwn(exposed, 'story_work'), false)
    assert.match(exposed.resume!.message, /当前页待校验或修复的完整候选/)
    assert.equal(exposed.resume!.available, true)
    assert.deepEqual(calls, { map: 1, boundary: 1, story: 0, review: 0 })
    invalidPatch = false
    analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, smallSource, ready)
    assert.deepEqual(calls, { map: 1, boundary: 2, story: 1, review: 1 })
    assert.equal(JSON.stringify(ready.sections.slice(1).map(section => rawFromResolved(section, smallSource))), JSON.stringify(original!.sections))
  } finally { await analyzer.close() }
})

test('normal directory calls each map page once and never asks for boundary repair', async () => {
  const content = `第1集\n${'林舟寻找信物。'.repeat(2400)}\n终场回家。`, id = project(content), pages: number[] = []
  let boundaries = 0, stories = 0, reviews = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(boundaryMarker)) { boundaries++; throw new Error('valid maps need no boundary repair') }
    if (prompt.includes(mapMarker)) pages.push(inputFor<MapInput>(prompt, mapMarker).output_window.page)
    if (prompt.includes(storyMarker)) stories++
    if (prompt.includes(reviewMarker)) reviews++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, content, ready)
    assert.ok(ready.total_chunks > 1)
    assert.deepEqual(pages, Array.from({ length: ready.total_chunks }, (_, index) => index + 1))
    assert.deepEqual({ boundaries, stories, reviews }, { boundaries: 0, stories: 1, reviews: 1 })
  } finally { await analyzer.close() }
})

test('later failed page preserves validated prefix and resumes only the retained current page', async () => {
  const content = `第1集\n${'林舟寻找信物。'.repeat(2300)}\n终场回家。`, id = project(content), pages: number[] = []
  let invalidPatch = true, boundaryCalls = 0, stories = 0, reviews = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(boundaryMarker)) {
      boundaryCalls++
      return invalidPatch ? JSON.stringify({ prefix_sections: [], starts: [] }) : prefixPatch(inputFor<BoundaryInput>(prompt, boundaryMarker))
    }
    if (prompt.includes(mapMarker)) {
      const page = inputFor<MapInput>(prompt, mapMarker).output_window.page
      pages.push(page)
      if (page === 2) return JSON.stringify(missingPrefix(prompt))
    }
    if (prompt.includes(storyMarker)) stories++
    if (prompt.includes(reviewMarker)) reviews++
    return sourceAnalysisFixture(prompt)!
  }, limits)
  try {
    analyzer.start(id, 'model')
    const failed = await terminal(id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.completed_chunks, 1)
    assert.equal(failed.sections.length, 1)
    const validatedPrefix = structuredClone(failed.sections), currentCandidate = structuredClone(failed.work![1]!.result)
    assert.deepEqual(pages, [1, 2])
    assert.equal(boundaryCalls, 1)
    assert.equal(stories, 0); assert.equal(reviews, 0)
    assert.equal(scriptSourceIndex(id)!.story_map, undefined)
    assert.ok(currentCandidate)
    assert.match(scriptSourceDocument(id)!.analysis!.resume!.message, /已保存 1\/.*当前页待校验或修复的完整候选/)
    invalidPatch = false
    analyzer.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, content, ready)
    assert.deepEqual(ready.sections.slice(0, validatedPrefix.length), validatedPrefix)
    assert.deepEqual(pages, Array.from({ length: ready.total_chunks }, (_, index) => index + 1))
    assert.equal(boundaryCalls, 2)
    assert.equal(stories, 1); assert.equal(reviews, 1)
  } finally { await analyzer.close() }
})


test('automatic process recovery preserves failed boundary barrier and makes no model request until explicit resume', async () => {
  const id = project(), calls = { map: 0, boundary: 0, story: 0, review: 0 }
  let invalidPatch = true
  const generate = async (_id: string, _model: string, prompt: string) => {
    if (prompt.includes(boundaryMarker)) {
      calls.boundary++
      return invalidPatch ? JSON.stringify({ prefix_sections: [], starts: [] }) : prefixPatch(inputFor<BoundaryInput>(prompt, boundaryMarker))
    }
    if (prompt.includes(mapMarker)) { calls.map++; return JSON.stringify(missingPrefix(prompt)) }
    if (prompt.includes(storyMarker)) calls.story++
    if (prompt.includes(reviewMarker)) calls.review++
    return sourceAnalysisFixture(prompt)!
  }
  const first = createScriptSourceAnalyzer(generate, limits)
  first.start(id, 'model')
  const failed = await terminal(id)
  assert.equal(failed.status, 'failed')
  const saved = structuredClone(failed.work![0]!.result)
  assert.deepEqual(calls, { map: 1, boundary: 1, story: 0, review: 0 })
  await first.close()
  // Simulate reconstruction from a snapshot persisted immediately before an
  // interrupted worker recorded its terminal status. The run identity is real.
  failed.status = 'running'
  run('UPDATE script_source_analyses SET status=?,snapshot=? WHERE project_id=?', 'running', JSON.stringify(failed), id)
  const recovered = createScriptSourceAnalyzer(generate, limits)
  try {
    recovered.recover()
    const stopped = await terminal(id)
    assert.equal(stopped.status, 'failed')
    assert.deepEqual(stopped.work![0]!.result, saved)
    assert.equal(stopped.work![0]!.boundary_repair?.status, 'failed')
    assert.deepEqual(calls, { map: 1, boundary: 1, story: 0, review: 0 }, 'automatic recovery must not clear the durable failed patch barrier')
    assert.equal(scriptSourceIndex(id)!.story_map, undefined)
    invalidPatch = false
    recovered.start(id, 'model')
    const ready = await terminal(id)
    assertReady(id, smallSource, ready)
    assert.deepEqual(calls, { map: 1, boundary: 2, story: 1, review: 1 })
  } finally { await recovered.close() }
})
