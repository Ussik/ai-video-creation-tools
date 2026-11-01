import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-proposal-reuse-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { analyzeSourceSnapshot, scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
const { effectiveScriptSource } = await import('../src/modules/script/script-source-versions.js')
const { planScriptSourceProposalReuse } = await import('../src/modules/script/script-source-proposal-reuse.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { validateSourceCoverage } = await import('../src/modules/script/script-source-map.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const configuration = { model: 'fixture', version: 1 }
const mapMarker = '【原文片段】\n', storyMarker = '【全剧整合资料】\n', reviewMarker = '【原稿分析核对资料】\n'
type Unit = { id: number; text: string }
type MapInput = { passages: Array<{ units: Unit[] }>; output_window: { page: number; first_unit: number; last_unit: number } }
const inputFor = <T>(prompt: string, marker: string): T => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const signal = () => new AbortController().signal

function screenplay() {
  return Array.from({ length: 12 }, (_, id) => {
    const opening = `第${id + 1}集\n林舟在第${id + 1}集记录本集专属线索，沈月保管副本。\n`
    const ending = `\n本集调查记录${id + 1}已封存。\n`
    return opening + '旧城里的灯火亮着，调查者依照原记录检查门窗。'.repeat(120).slice(0, 2100 - opening.length - ending.length) + ending
  }).join('')
}
function project() {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '候选稿增量隔离回归', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '十二集剧本.md', screenplay(), stamp)
  return effectiveScriptSource(id)!
}
function revised(source: ScriptSourceDocument, episode = 6) {
  return { ...source, content: source.content.replace(`林舟在第${episode}集记录本集专属线索，沈月保管副本。`,
    `林舟在第${episode}集记录新发现的专属线索，沈月保管两份完整副本。`) }
}
function reply(prompt: string) {
  if (!prompt.includes(mapMarker)) return sourceAnalysisFixture(prompt)!
  const input = inputFor<MapInput>(prompt, mapMarker)
  const selected = input.passages.flatMap(passage => passage.units).filter(unit => unit.id >= input.output_window.first_unit && unit.id <= input.output_window.last_unit)
  const starts = selected.flatMap((unit, index) => index === 0 || /^第\d+集\n/.test(unit.text) ? [index] : [])
  return JSON.stringify({ sections: starts.map((start, index) => {
    const local = selected.slice(start, starts[index + 1] ?? selected.length), heading = local[0]!.text.match(/^第(\d+)集/)
    const fact = local.find(unit => unit.text.includes('林舟在第'))!
    assert.ok(heading); assert.ok(fact)
    return { start_unit: local[0]!.id, title: `第${heading[1]}集已核验目录`, episode_number: Number(heading[1]), summary: fact.text.trim(),
      characters: [{ name: '林舟', description: '本集调查者', evidence: { unit_id: fact.id } },
        { name: '沈月', description: '保管调查副本', evidence: { unit_id: fact.id } }],
      events: [{ summary: fact.text.trim(), evidence: { unit_id: fact.id } }], continues_previous: false, open_threads: [] }
  }) })
}
async function reviewed(source = project()) {
  const analysis = await analyzeSourceSnapshot(source, 'model', async prompt => reply(prompt), signal(), configuration)
  return { ...source, analysis }
}
function checkpoint(id: string) {
  return JSON.parse(one<{ payload: string }>("SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal'", id)!.payload) as ScriptSourceAnalysis
}
function expectedPlan(base: ScriptSourceDocument, target: ScriptSourceDocument) {
  const plan = planScriptSourceProposalReuse(target, 'model', sourceAnalysisConfigurationHash(configuration), base)
  assert.equal(plan?.mode, 'incremental')
  return plan!
}
function assertFullReview(prompts: string[], content: string, count = 1, reviewCount = count) {
  const stories = prompts.filter(prompt => prompt.includes(storyMarker)), reviews = prompts.filter(prompt => prompt.includes(reviewMarker))
  assert.equal(stories.length, count); assert.equal(reviews.length, reviewCount)
  for (const prompt of stories) assert.equal(inputFor<{ source: { content: string } }>(prompt, storyMarker).source.content, content)
  for (const prompt of reviews) assert.equal(inputFor<{ units: Unit[] }>(prompt, reviewMarker).units.map(unit => unit.text).join(''), content)
}

test('candidate edits reuse exact unaffected pages, rebuild the complete story and quality check, and report every phase', async () => {
  const base = await reviewed(), target = revised(base), prompts: string[] = [], progress: ScriptSourceAnalysis[] = []
  const plan = expectedPlan(base, target)
  const ready = await analyzeSourceSnapshot(target, 'model', async prompt => { prompts.push(prompt); return reply(prompt) }, signal(), configuration,
    { base, onProgress: state => progress.push(state) })
  assert.equal(ready.status, 'ready'); assert.equal(ready.revision_reuse?.status, 'verified')
  assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, plan.pages.filter(page => !page.reuse_sections).length)
  assert.ok(ready.revision_reuse!.reused_pages.length >= 2)
  assertFullReview(prompts, target.content)
  assert.notEqual(ready.quality!.input_hash, base.analysis.quality!.input_hash)
  validateSourceCoverage(target.content, ready.sections)
  assert.ok(progress.some(state => state.progress?.message.includes('已沿用')))
  assert.ok(progress.some(state => state.progress?.stage === 'synthesis'))
  assert.ok(progress.some(state => state.progress?.message.includes('独立核对')))
  assert.equal(progress.at(-1)!.status, 'ready')
  const cached = await analyzeSourceSnapshot(target, 'model', async () => { throw new Error('exact completed source must not spend tokens') }, signal(), configuration,
    { onProgress: state => { assert.equal(state.status, 'ready'); state.sections.length = 0 } })
  assert.ok(cached.sections.length, 'observers cannot mutate the cached or live result')
  assert.equal(effectiveScriptSource(target.project_id)!.content, base.content, 'a proposal never changes the saved manuscript')
})

test('ready saved source maps are discovered without a candidate base or private configuration in the public source', async () => {
  const base = await reviewed(), target = revised(base), prompts: string[] = []
  run('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)',
    base.project_id, base.analysis.id, base.analysis.source_version, 'ready', JSON.stringify(base.analysis), now())
  run("DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-base'", base.project_id)
  const publicAnalysis = { ...base.analysis, configuration_hash: undefined }
  const ready = await analyzeSourceSnapshot(target, 'model', async prompt => { prompts.push(prompt); return reply(prompt) }, signal(), configuration,
    { base: { ...base, analysis: publicAnalysis } })
  assert.equal(ready.revision_reuse?.status, 'verified')
  assert.ok(prompts.filter(prompt => prompt.includes(mapMarker)).length < ready.total_chunks)
  assertFullReview(prompts, target.content)
})

test('a cancelled candidate resumes its saved page prefix and private verified base after cleanup, without requiring the caller to retain that base', async () => {
  const base = await reviewed(), target = revised(base), controller = new AbortController(), pages: number[] = []
  const plan = expectedPlan(base, target)
  await assert.rejects(analyzeSourceSnapshot(target, 'model', async prompt => { pages.push(inputFor<MapInput>(prompt, mapMarker).output_window.page); return reply(prompt) },
    controller.signal, configuration, { onProgress: state => { if (state.revision_reuse?.reused_pages.length) controller.abort(new Error('用户暂停隔离测试')) } }), /用户暂停隔离测试/)
  const partial = checkpoint(base.project_id)
  assert.equal(partial.completed_chunks, 1)
  assert.equal(partial.story, undefined); assert.equal(partial.quality, undefined)
  run("INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)", base.project_id, 'source-proposal-usage', 'upload', '{}', now())
  clearGenerationCheckpoint(base.project_id)
  assert.ok(one("SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-base'", base.project_id))
  assert.ok(one("SELECT 1 FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-usage'", base.project_id))
  const prompts: string[] = []
  const ready = await analyzeSourceSnapshot(target, 'model', async prompt => { prompts.push(prompt); return reply(prompt) }, signal(), configuration)
  assert.equal(ready.revision_reuse?.status, 'verified')
  assert.deepEqual(ready.sections.slice(0, partial.sections.length), partial.sections)
  assert.deepEqual(prompts.filter(prompt => prompt.includes(mapMarker)).map(prompt => inputFor<MapInput>(prompt, mapMarker).output_window.page),
    plan.pages.flatMap((page, index) => page.reuse_sections ? [] : [index + 1]))
  assertFullReview(prompts, target.content)
})

test('existing same-version full-analysis checkpoints retain their completed pages instead of switching to the new reuse path', async () => {
  const base = await reviewed(), target = revised(base), controller = new AbortController()
  process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS = '0'
  try {
    await assert.rejects(analyzeSourceSnapshot(target, 'model', async prompt => reply(prompt), controller.signal, configuration,
      { onProgress: state => { if (state.completed_chunks === 1) controller.abort(new Error('旧任务暂停')) } }), /旧任务暂停/)
  } finally { delete process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS }
  const partial = checkpoint(base.project_id), pages: number[] = []
  assert.equal(partial.revision_reuse, undefined); assert.equal(partial.completed_chunks, 1)
  const ready = await analyzeSourceSnapshot(target, 'model', async prompt => {
    if (prompt.includes(mapMarker)) pages.push(inputFor<MapInput>(prompt, mapMarker).output_window.page)
    return reply(prompt)
  }, signal(), configuration)
  assert.equal(ready.revision_reuse, undefined)
  assert.deepEqual(ready.sections.slice(0, partial.sections.length), partial.sections)
  assert.deepEqual(pages, Array.from({ length: ready.total_chunks - 1 }, (_, index) => index + 2))
})

test('configuration drift, disabled reuse, replaced uploads and forged candidate ledgers rebuild all directory pages', async () => {
  for (const drift of ['configuration', 'disabled', 'upload', 'ledger', 'base'] as const) {
    const base = await reviewed(), target = revised(base), controller = new AbortController()
    await assert.rejects(analyzeSourceSnapshot(target, 'model', async prompt => reply(prompt), controller.signal, configuration,
      { onProgress: state => { if (state.revision_reuse?.reused_pages.length) controller.abort(new Error('断点')) } }), /断点/)
    if (drift === 'upload') run('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?', `${base.content}替换上传`, '2030-01-01T00:00:00.000Z', base.project_id)
    if (drift === 'base') run("DELETE FROM script_step_checkpoints WHERE project_id=? AND namespace='source-proposal-base'", base.project_id)
    if (drift === 'ledger') {
      const state = checkpoint(base.project_id); state.revision_reuse!.reused_characters++
      run("UPDATE script_step_checkpoints SET payload=? WHERE project_id=? AND namespace='source-proposal'", JSON.stringify(state), base.project_id)
    }
    if (drift === 'disabled') process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS = '0'
    const prompts: string[] = []
    try {
      const ready = await analyzeSourceSnapshot(target, 'model', async prompt => { prompts.push(prompt); return reply(prompt) }, signal(),
        drift === 'configuration' ? { ...configuration, version: 2 } : configuration)
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, ready.total_chunks, drift)
      assert.equal(ready.revision_reuse?.status === 'verified', false, drift)
      assertFullReview(prompts, target.content)
    } finally { delete process.env.VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS }
  }
})

test('a substantive independent finding on candidate reused pages triggers one complete rebuild, then later findings are repaired automatically', async () => {
  const repairMarker = '【原稿分析定点修补资料】\n'
  for (const failAgain of [false, true]) {
    const base = await reviewed(), target = revised(base), prompts: string[] = []
    const plan = expectedPlan(base, target)
    let reviews = 0, repairs = 0, rebuilt: ScriptSourceAnalysis | undefined
    const ready = await analyzeSourceSnapshot(target, 'model', async prompt => {
      prompts.push(prompt)
      if (prompt.includes(repairMarker)) {
        repairs++; rebuilt = checkpoint(base.project_id)
        const input = inputFor<{ story: NonNullable<ScriptSourceAnalysis['story']>; finding: { explanation: string } }>(prompt, repairMarker)
        return JSON.stringify({ status: 'patched', reason: '依据完整新稿补入重建后发现遗漏的事实。', changes: [{ target: 'story.summary',
          section_id: null, operation: 'replace', index: null, expected: input.story.summary, value: `${input.story.summary}；${input.finding.explanation}` }] })
      }
      if (prompt.includes(reviewMarker) && (++reviews === 1 || failAgain && reviews === 2)) {
        const input = inputFor<{ sections: Array<{ id: number }>; units: Unit[] }>(prompt, reviewMarker)
        return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: [
          { kind: 'causality', explanation: '旧版人物理解受远处改动影响，需依据完整新稿重建。', unit_ids: [input.units.find(unit => unit.text.trim())!.id] },
        ] })
      }
      return reply(prompt)
    }, signal(), configuration)
    assert.equal(ready.status, 'ready'); assert.equal(ready.quality!.status, 'passed')
    const saved = checkpoint(base.project_id)
    assert.equal(saved.revision_reuse?.status, 'discarded')
    assert.equal(reviews, failAgain ? 3 : 2)
    assert.equal(repairs, failAgain ? 1 : 0)
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, saved.total_chunks + plan.pages.filter(page => !page.reuse_sections).length)
    assertFullReview(prompts, target.content, 2, failAgain ? 3 : 2)
    if (rebuilt) assert.deepEqual(ready.sections, rebuilt.sections, 'later finding repair preserves the completed replacement directory')
    validateSourceCoverage(target.content, ready.sections)
    assert.equal(effectiveScriptSource(target.project_id)!.content, base.content, 'automatic proposal repair never publishes the candidate manuscript')
  }
})
