import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-source-incremental-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { db, initDb, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis, scriptSourceVersion, scriptSourcePassages } = await import('../src/modules/script/script-source-analysis.js')
const { commitScriptSourceUpdate, effectiveScriptSource, originalScriptSource, scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const { sourceWorkPlan, validateSourceCoverage } = await import('../src/modules/script/script-source-map.js')
const { clearGenerationCheckpoint } = await import('../src/modules/script/script-generation-checkpoints.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })

const mapMarker = '【原文片段】\n', storyMarker = '【全剧整合资料】\n', reviewMarker = '【原稿分析核对资料】\n'
const limits = { reading: 1000, repairing: 1000, synthesis: 1000 }
const configuration = () => ({ model: 'isolated-mock', version: 1 })
type Unit = { id: number; text: string }
type MapInput = { complete_source: boolean; passages: Array<{ units: Unit[] }>; output_window: {
  first_unit: number; last_unit: number; offset: number; length: number
} }
type Reuse = { status: 'pending' | 'verified' | 'discarded'; reused_pages: number[]; reused_section_ids: number[]; reused_characters: number }
const inputFor = <T>(prompt: string, marker: string): T => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))

function screenplay() {
  return Array.from({ length: 12 }, (_, id) => {
    const opening = `第${id + 1}集\n林舟在第${id + 1}集记录本集专属线索，沈月保管副本。\n`
    const ending = `\n本集调查记录${id + 1}已封存。\n`
    return opening + '旧城里的灯火亮着，调查者依照原记录检查门窗。'.repeat(120).slice(0, 2100 - opening.length - ending.length) + ending
  }).join('')
}

function project(content = screenplay()) {
  const id = newId(), stamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '修订增量隔离回归', stamp, stamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', id, '十二集剧本.md', content, stamp)
  return id
}

function revisedContent(content: string, episode = 6) {
  return content.replace(`林舟在第${episode}集记录本集专属线索，沈月保管副本。`, `林舟在第${episode}集记录新发现的专属线索，沈月保管两份完整副本。`)
}

function commit(id: string, content: string) {
  const current = effectiveScriptSource(id)!
  return commitScriptSourceUpdate(id, { id: newId(), base_version: scriptDocumentVersion(current), original_content: current.content,
    content, replacements: [{ find: current.content, replace: content, reason: '作者确认修订本集调查细节' }] })
}

async function terminal(id: string, version?: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const state = scriptSourceAnalysis(id)
    if (state && (!version || state.source_version === version) && ['ready', 'failed'].includes(state.status)) return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('isolated revision analysis did not finish')
}

function snapshot(id: string) {
  return JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_source_analyses WHERE project_id=?', id)!.snapshot) as ScriptSourceAnalysis & { revision_reuse?: Reuse }
}

function mapReply(input: MapInput) {
  const all = input.passages.flatMap(passage => passage.units)
  const selected = all.filter(unit => unit.id >= input.output_window.first_unit && unit.id <= input.output_window.last_unit)
  const starts = selected.flatMap((unit, index) => index === 0 || /^第\d+集\n/.test(unit.text) ? [index] : [])
  return { sections: starts.map((start, index) => {
    const local = selected.slice(start, starts[index + 1] ?? selected.length)
    const heading = local[0]!.text.match(/^第(\d+)集/)
    assert.ok(heading, 'standard directory output pages begin at the episode boundary in this fixture')
    const fact = local.find(unit => unit.text.includes('林舟在第'))!
    assert.ok(fact)
    return { start_unit: local[0]!.id, title: `第${heading[1]}集已核验目录`, episode_number: Number(heading[1]), summary: fact.text.trim(),
      characters: [{ name: '林舟', description: '本集调查者', evidence: { unit_id: fact.id } },
        { name: '沈月', description: '保管调查副本', evidence: { unit_id: fact.id } }],
      events: [{ summary: fact.text.trim(), evidence: { unit_id: fact.id } }], continues_previous: false, open_threads: [] }
  }) }
}

function reply(prompt: string) {
  return prompt.includes(mapMarker) ? JSON.stringify(mapReply(inputFor<MapInput>(prompt, mapMarker))) : sourceAnalysisFixture(prompt)!
}

function assertFullSynthesis(prompts: string[], content: string) {
  const stories = prompts.filter(prompt => prompt.includes(storyMarker)), reviews = prompts.filter(prompt => prompt.includes(reviewMarker))
  assert.equal(stories.length, 1)
  assert.equal(reviews.length, 1)
  assert.equal(inputFor<{ source: { content: string } }>(stories[0]!, storyMarker).source.content, content)
  assert.equal(inputFor<{ units: Unit[] }>(reviews[0]!, reviewMarker).units.map(unit => unit.text).join(''), content)
}

function assertEvidence(content: string, sections: ScriptSourceSection[]) {
  validateSourceCoverage(content, sections)
  for (const section of sections) for (const item of [...section.characters, ...section.events]) {
    assert.equal(content.slice(item.evidence.offset, item.evidence.offset + item.evidence.quote.length), item.evidence.quote)
    assert.ok(item.evidence.offset >= section.offset && item.evidence.offset + item.evidence.quote.length <= section.offset + section.length)
  }
}

test('confirmed revision reuses safe prefix and shifted suffix directory pages, then rebuilds the whole story and independent audit', async () => {
  const id = project(), original = effectiveScriptSource(id)!, prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    const before = await terminal(id)
    assert.equal(before.status, 'ready', before.error || '')
    const originalMapCalls = prompts.filter(prompt => prompt.includes(mapMarker)).length
    assert.equal(originalMapCalls, sourceWorkPlan(scriptSourcePassages(original.content)).length)
    assert.equal(before.sections.length, 12)
    prompts.length = 0
    const revised = commit(id, revisedContent(original.content))
    const after = await terminal(id, scriptSourceVersion(revised))
    assert.equal(after.status, 'ready', after.error || '')
    const reuse = snapshot(id).revision_reuse!
    assert.equal(reuse.status, 'verified')
    assert.ok(reuse.reused_pages.length >= 2, 'the independent first and last pages are reusable in this fixture')
    assert.ok(reuse.reused_characters > 0)
    const reads = prompts.filter(prompt => prompt.includes(mapMarker)).map(prompt => inputFor<MapInput>(prompt, mapMarker))
    assert.ok(reads.length > 0 && reads.length < originalMapCalls)
    assert.equal(reads.length + reuse.reused_pages.length, after.total_chunks)
    for (const input of reads) {
      assert.equal(input.complete_source, true, 'directory re-generation still understands the complete revised manuscript')
      assert.equal(input.passages.flatMap(passage => passage.units).map(unit => unit.text).join(''), revised.content)
      assert.ok(input.output_window.offset > 0)
      assert.ok(input.output_window.offset + input.output_window.length < revised.content.length)
    }
    assertFullSynthesis(prompts, revised.content)
    assertEvidence(revised.content, after.sections)
    assert.deepEqual(after.sections[0], before.sections[0])
    const delta = revised.content.length - original.content.length
    assert.ok(delta > 0)
    assert.equal(after.sections.at(-1)!.offset, before.sections.at(-1)!.offset + delta)
    assert.equal(after.sections.at(-1)!.events[0]!.evidence.offset, before.sections.at(-1)!.events[0]!.evidence.offset + delta)
    assert.equal(after.sections.at(-1)!.events[0]!.evidence.quote, before.sections.at(-1)!.events[0]!.evidence.quote)
    assert.match(after.sections.find(section => section.episode_number === 6)!.summary, /新发现.*两份完整/)
    assert.notEqual(after.quality!.input_hash, before.quality!.input_hash)
    assert.equal(originalScriptSource(id)!.content, original.content, 'the uploaded original remains preserved')
  } finally { await analyzer.close() }
})

test('unconfirmed private analysis and a rolled-back confirmation cannot replace or restart the effective manuscript analysis', async () => {
  const id = project(), original = effectiveScriptSource(id)!, prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    const before = await terminal(id)
    assert.equal(before.status, 'ready', before.error || '')
    run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)',
      id, 'source-proposal', 'unconfirmed-private-proposal', JSON.stringify({ content: 'PRIVATE_UNCONFIRMED', source_version: 'private-version' }), now())
    prompts.length = 0
    assert.equal(analyzer.start(id, 'model').id, before.id)
    assert.equal(effectiveScriptSource(id)!.content, original.content)
    assert.throws(() => db.transaction(() => {
      commit(id, revisedContent(original.content))
      throw new Error('撤销整个确认事务')
    })(), /撤销整个确认事务/)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(effectiveScriptSource(id)!.content, original.content)
    assert.equal(scriptSourceAnalysis(id)!.id, before.id)
    assert.equal(one<{ count: number }>('SELECT COUNT(*) AS count FROM script_source_revisions WHERE project_id=?', id)!.count, 0)
    assert.equal(one('SELECT * FROM script_step_checkpoints WHERE project_id=? AND namespace=?', id, 'source-revision-base'), undefined)
    assert.deepEqual(prompts, [])
  } finally { await analyzer.close() }
})

test('replacing the upload does not reuse a previous revision base or an unconfirmed proposed analysis', async () => {
  const id = project(), prompts: string[] = []
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    await analyzer.close()
    const original = effectiveScriptSource(id)!, revised = commit(id, revisedContent(original.content))
    assert.notEqual(revised.content, original.content)
    const uploaded = revisedContent(original.content, 10)
    run('UPDATE script_source_documents SET content=?,updated_at=? WHERE project_id=?', uploaded, new Date(Date.now() + 10).toISOString(), id)
    prompts.length = 0
    const next = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
    try {
      next.start(id, 'model')
      const ready = await terminal(id, scriptSourceVersion(effectiveScriptSource(id)!))
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, sourceWorkPlan(scriptSourcePassages(uploaded)).length)
      assert.equal(snapshot(id).revision_reuse, undefined)
      assertFullSynthesis(prompts, uploaded)
      assertEvidence(uploaded, ready.sections)
    } finally { await next.close() }
  } finally { await analyzer.close() }
})

test('a newer confirmed revision wins over a late response from an older incremental analysis', async () => {
  const id = project(), original = effectiveScriptSource(id)!
  const firstContent = revisedContent(original.content), latestContent = revisedContent(firstContent, 7)
  let began: () => void = () => {}, release: () => void = () => {}
  const started = new Promise<void>(resolve => { began = resolve })
  let held = false
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(mapMarker)) {
      const input = inputFor<MapInput>(prompt, mapMarker)
      const content = input.passages.flatMap(passage => passage.units).map(unit => unit.text).join('')
      if (content === firstContent && !held) {
        held = true
        return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
      }
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    const originalReady = await terminal(id)
    assert.equal(originalReady.status, 'ready', originalReady.error || '')
    commit(id, firstContent)
    await started
    const firstId = scriptSourceAnalysis(id)!.id
    const latest = commit(id, latestContent)
    const ready = await terminal(id, scriptSourceVersion(latest))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.notEqual(ready.id, firstId)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scriptSourceAnalysis(id)!.id, ready.id)
    assert.equal(effectiveScriptSource(id)!.content, latestContent)
    assert.equal(originalScriptSource(id)!.content, original.content)
    assertEvidence(latestContent, ready.sections)
    assert.match(ready.sections.find(section => section.episode_number === 6)!.summary, /新发现/)
    assert.match(ready.sections.find(section => section.episode_number === 7)!.summary, /新发现/)
  } finally { release(); await analyzer.close() }
})

test('paused revised-source synthesis resumes its validated map without repeating directory work', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
  let began: () => void = () => {}, release: () => void = () => {}, hold = true
  const started = new Promise<void>(resolve => { began = resolve })
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt)
    if (hold && prompt.includes(storyMarker) && inputFor<{ source: { content: string } }>(prompt, storyMarker).source.content === revised) {
      return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    commit(id, revised)
    await started
    const active = scriptSourceAnalysis(id)!
    assert.equal(active.completed_chunks, active.total_chunks)
    analyzer.pause(id, active.id)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scriptSourceAnalysis(id)!.status, 'paused')
    hold = false; prompts.length = 0
    analyzer.start(id, 'model')
    const ready = await terminal(id, scriptSourceVersion(effectiveScriptSource(id)!))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, 0)
    assertFullSynthesis(prompts, revised)
    assert.equal(snapshot(id).revision_reuse!.status, 'verified')
    assertEvidence(revised, ready.sections)
  } finally { release(); await analyzer.close() }
})

test('an analyzer restart recovers a revised-source map and completes its global synthesis and review', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content)
  let began: () => void = () => {}, release: () => void = () => {}
  const started = new Promise<void>(resolve => { began = resolve })
  const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(storyMarker) && inputFor<{ source: { content: string } }>(prompt, storyMarker).source.content === revised) {
      return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    first.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    commit(id, revised)
    await started
    await first.close()
    release()
    assert.equal(scriptSourceAnalysis(id)!.status, 'queued')
    const prompts: string[] = []
    const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
    try {
      second.recover()
      const ready = await terminal(id, scriptSourceVersion(effectiveScriptSource(id)!))
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, 0)
      assertFullSynthesis(prompts, revised)
      assert.equal(snapshot(id).revision_reuse!.status, 'verified')
      assertEvidence(revised, ready.sections)
    } finally { await second.close() }
  } finally { release(); await first.close() }
})

test('an independent finding on reused directory candidates triggers one complete rebuild before publishing the revision', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
  let reported = false
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt)
    if (!reported && prompt.includes(reviewMarker)) {
      const input = inputFor<{ units: Unit[]; sections: Array<{ id: number }> }>(prompt, reviewMarker)
      if (input.units.map(unit => unit.text).join('') === revised) {
        reported = true
        return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: [{ kind: 'omission',
          explanation: '复用目录仍可能沿用旧事实，需要依据完整修订稿重新建立目录。', unit_ids: [input.units.find(unit => unit.text.includes('新发现'))!.id] }] })
      }
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    prompts.length = 0
    const committed = commit(id, revised)
    const ready = await terminal(id, scriptSourceVersion(committed))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(reported, true)
    const plan = sourceWorkPlan(scriptSourcePassages(revised))
    const maps = prompts.filter(prompt => prompt.includes(mapMarker)).map(prompt => inputFor<MapInput>(prompt, mapMarker))
    assert.ok(maps.length > plan.length, 'one incremental map pass is followed by the complete standard output plan')
    assert.deepEqual(maps.slice(-plan.length).map(input => ({ offset: input.output_window.offset, length: input.output_window.length })),
      plan.map(item => ({ offset: item.offset, length: item.length })))
    assert.equal(prompts.filter(prompt => prompt.includes(storyMarker)).length, 2)
    assert.equal(prompts.filter(prompt => prompt.includes(reviewMarker)).length, 2)
    assert.equal(ready.quality!.status, 'passed')
    assert.notEqual(snapshot(id).revision_reuse?.status, 'pending')
    assertEvidence(revised, ready.sections)
  } finally { await analyzer.close() }
})

test('a second independent finding is repaired automatically without rebuilding the completed revision a third time', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
  const repairMarker = '【原稿分析定点修补资料】\n'
  let revisedReviews = 0, repairs = 0
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt)
    if (prompt.includes(repairMarker)) {
      repairs++
      const input = inputFor<{ story: NonNullable<ScriptSourceAnalysis['story']>; finding: { explanation: string } }>(prompt, repairMarker)
      return JSON.stringify({ status: 'patched', reason: '依据完整原文修正重建后发现的理解问题。', changes: [{ target: 'story.summary',
        section_id: null, operation: 'replace', index: null, expected: input.story.summary, value: `${input.story.summary}；${input.finding.explanation}` }] })
    }
    if (prompt.includes(reviewMarker)) {
      const input = inputFor<{ units: Unit[]; sections: Array<{ id: number }> }>(prompt, reviewMarker)
      if (input.units.map(unit => unit.text).join('') === revised) return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: ++revisedReviews <= 2 ? [{ kind: 'omission',
        explanation: '完整重建之后仍需保留沈月保管两份完整副本的事实。', unit_ids: [input.units.find(unit => unit.text.includes('新发现'))!.id] }] : [] })
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    prompts.length = 0
    const committed = commit(id, revised)
    const ready = await terminal(id, scriptSourceVersion(committed))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(prompts.filter(prompt => prompt.includes(reviewMarker)).length, 3)
    assert.equal(prompts.filter(prompt => prompt.includes(storyMarker)).length, 2)
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, sourceWorkPlan(scriptSourcePassages(revised)).length + 1)
    assert.equal(repairs, 1)
    assert.equal(snapshot(id).revision_reuse!.status, 'discarded')
    assert.equal(ready.quality!.status, 'passed')
    assert.match(ready.story!.summary, /保管两份完整副本/)
    assertEvidence(revised, ready.sections)
    assert.equal(effectiveScriptSource(id)!.content, revised)
    assert.equal(originalScriptSource(id)!.content, original.content)
  } finally { await analyzer.close() }
})

test('configuration changes and an unknown historical configuration both prevent cross-version directory reuse', async t => {
  for (const issue of ['changed_configuration', 'unknown_historical_configuration'] as const) await t.test(issue, async () => {
    const id = project(), original = effectiveScriptSource(id)!, prompts: string[] = []
    let configurationVersion = 1
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits,
      { configuration: () => ({ model: 'isolated-mock', version: configurationVersion }) })
    try {
      analyzer.start(id, 'model')
      assert.equal((await terminal(id)).status, 'ready')
      if (issue === 'changed_configuration') configurationVersion = 2
      else {
        const previous = snapshot(id)
        delete previous.configuration_hash
        run('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?', JSON.stringify(previous), id)
      }
      prompts.length = 0
      const committed = commit(id, revisedContent(original.content))
      const ready = await terminal(id, scriptSourceVersion(committed))
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, sourceWorkPlan(scriptSourcePassages(committed.content)).length)
      assert.equal(snapshot(id).revision_reuse, undefined)
      assertFullSynthesis(prompts, committed.content)
    } finally { await analyzer.close() }
  })
})

test('disabling incremental analysis before confirmation or before resuming candidates forces a complete directory rebuild', async t => {
  const setting = 'VIDEO_STUDIO_SCRIPT_INCREMENTAL_ANALYSIS'
  for (const mode of ['before_confirmation', 'pending_resume'] as const) await t.test(mode, async () => {
    const previousSetting = process.env[setting]
    delete process.env[setting]
    const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
    let began: () => void = () => {}, release: () => void = () => {}, hold = mode === 'pending_resume'
    const started = new Promise<void>(resolve => { began = resolve })
    const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      prompts.push(prompt)
      if (hold && prompt.includes(storyMarker) && inputFor<{ source: { content: string } }>(prompt, storyMarker).source.content === revised) {
        return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
      }
      return reply(prompt)
    }, limits, { configuration })
    try {
      analyzer.start(id, 'model')
      assert.equal((await terminal(id)).status, 'ready')
      if (mode === 'before_confirmation') process.env[setting] = '0'
      prompts.length = 0
      const committed = commit(id, revised)
      if (mode === 'pending_resume') {
        await started
        const current = scriptSourceAnalysis(id)!
        assert.equal(snapshot(id).revision_reuse!.status, 'pending')
        assert.ok(snapshot(id).revision_reuse!.reused_pages.length > 0)
        analyzer.pause(id, current.id)
        release()
        await new Promise<void>(resolve => setImmediate(resolve))
        process.env[setting] = '0'; hold = false; prompts.length = 0
        analyzer.start(id, 'model')
      }
      const ready = await terminal(id, scriptSourceVersion(committed))
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, sourceWorkPlan(scriptSourcePassages(revised)).length)
      assertFullSynthesis(prompts, revised)
      assert.notEqual(snapshot(id).revision_reuse?.status, 'pending')
      assertEvidence(revised, ready.sections)
    } finally {
      release(); await analyzer.close()
      if (previousSetting === undefined) delete process.env[setting]
      else process.env[setting] = previousSetting
    }
  })
})

test('ordinary generation checkpoint cleanup preserves the committed revision base across analyzer restart', async () => {
  const id = project(), original = effectiveScriptSource(id)!
  const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => reply(prompt), limits, { configuration })
  try {
    first.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    await first.close()
    const revised = commit(id, revisedContent(original.content))
    const seed = one<{ cache_key: string; payload: string }>('SELECT cache_key,payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', id, 'source-revision-base')
    assert.ok(seed)
    run('INSERT INTO script_generation_checkpoints (project_id,cache_key,payload,updated_at) VALUES (?,?,?,?)', id, 'old-generation', '{"steps":{}}', now())
    run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?)', id, 'old-repair', 'old-key', '{"steps":{}}', now())
    clearGenerationCheckpoint(id)
    assert.deepEqual(one('SELECT cache_key,payload FROM script_step_checkpoints WHERE project_id=? AND namespace=?', id, 'source-revision-base'), seed)
    assert.equal(one('SELECT * FROM script_generation_checkpoints WHERE project_id=?', id), undefined)
    assert.equal(one('SELECT * FROM script_step_checkpoints WHERE project_id=? AND namespace=?', id, 'old-repair'), undefined)
    const prompts: string[] = []
    const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
    try {
      second.start(id, 'model')
      const ready = await terminal(id, scriptSourceVersion(revised))
      assert.equal(ready.status, 'ready', ready.error || '')
      assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, 1)
      assert.equal(snapshot(id).revision_reuse!.status, 'verified')
      assertFullSynthesis(prompts, revised.content)
    } finally { await second.close() }
  } finally { await first.close() }
})

test('an independent-review transport failure resumes only the review and does not force a complete directory rebuild', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
  let fail = true
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt)
    if (fail && prompt.includes(reviewMarker) && inputFor<{ units: Unit[] }>(prompt, reviewMarker).units.map(unit => unit.text).join('') === revised) {
      throw new Error('独立核对请求连接中断')
    }
    return reply(prompt)
  }, limits, { configuration })
  try {
    analyzer.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    prompts.length = 0
    const committed = commit(id, revised)
    const failed = await terminal(id, scriptSourceVersion(committed))
    assert.equal(failed.status, 'failed')
    assert.match(failed.error!, /连接中断/)
    assert.equal(snapshot(id).revision_reuse!.status, 'pending')
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, 1)
    assert.equal(prompts.filter(prompt => prompt.includes(storyMarker)).length, 1)
    assert.equal(prompts.filter(prompt => prompt.includes(reviewMarker)).length, 1)
    fail = false; prompts.length = 0
    analyzer.start(id, 'model')
    const ready = await terminal(id, scriptSourceVersion(committed))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, 0)
    assert.equal(prompts.filter(prompt => prompt.includes(storyMarker)).length, 0)
    assert.equal(prompts.filter(prompt => prompt.includes(reviewMarker)).length, 1)
    assert.equal(snapshot(id).revision_reuse!.status, 'verified')
    assertEvidence(revised, ready.sections)
  } finally { await analyzer.close() }
})

test('restart recovery with changed model configuration rebuilds a partially consumed revision map in full', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content)
  let began: () => void = () => {}, release: () => void = () => {}, configurationVersion = 1
  const currentConfiguration = () => ({ model: 'isolated-mock', version: configurationVersion })
  const started = new Promise<void>(resolve => { began = resolve })
  const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    if (prompt.includes(mapMarker) && inputFor<MapInput>(prompt, mapMarker).passages.flatMap(passage => passage.units).map(unit => unit.text).join('') === revised) {
      return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
    }
    return reply(prompt)
  }, limits, { configuration: currentConfiguration })
  try {
    first.start(id, 'model')
    assert.equal((await terminal(id)).status, 'ready')
    const committed = commit(id, revised)
    await started
    assert.ok(snapshot(id).revision_reuse!.reused_pages.length > 0)
    assert.ok(scriptSourceAnalysis(id)!.completed_chunks > 0)
    await first.close(); release()
    configurationVersion = 2
    const prompts: string[] = []
    const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits,
      { configuration: currentConfiguration })
    try {
      second.recover()
      const ready = await terminal(id, scriptSourceVersion(committed))
      assert.equal(ready.status, 'ready', ready.error || '')
      const reads = prompts.filter(prompt => prompt.includes(mapMarker)).map(prompt => inputFor<MapInput>(prompt, mapMarker))
      assert.deepEqual(reads.map(input => ({ offset: input.output_window.offset, length: input.output_window.length })),
        sourceWorkPlan(scriptSourcePassages(revised)).map(item => ({ offset: item.offset, length: item.length })))
      assert.equal(ready.configuration_hash, sourceAnalysisConfigurationHash(currentConfiguration()))
      assertFullSynthesis(prompts, revised)
      assertEvidence(revised, ready.sections)
    } finally { await second.close() }
  } finally { release(); await first.close() }
})

test('a configuration change during a directory request prevents stale publication and explicit restart uses the new configuration', async () => {
  const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content), prompts: string[] = []
  let began: () => void = () => {}, release: () => void = () => {}, configurationVersion = 1, hold = true
  const currentConfiguration = () => ({ model: 'isolated-mock', version: configurationVersion })
  const started = new Promise<void>(resolve => { began = resolve })
  const analyzer = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
    prompts.push(prompt)
    if (hold && prompt.includes(mapMarker) && inputFor<MapInput>(prompt, mapMarker).passages.flatMap(passage => passage.units).map(unit => unit.text).join('') === revised) {
      return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
    }
    return reply(prompt)
  }, limits, { configuration: currentConfiguration })
  try {
    analyzer.start(id, 'model')
    const originalReady = await terminal(id)
    assert.equal(originalReady.status, 'ready')
    const committed = commit(id, revised)
    await started
    const previousHash = scriptSourceAnalysis(id)!.configuration_hash
    configurationVersion = 2; hold = false
    release()
    const failed = await terminal(id, scriptSourceVersion(committed))
    assert.equal(failed.status, 'failed', 'the in-flight request cannot publish a ready result under its stale configuration')
    assert.notEqual(previousHash, sourceAnalysisConfigurationHash(currentConfiguration()))
    prompts.length = 0
    analyzer.start(id, 'model')
    const ready = await terminal(id, scriptSourceVersion(committed))
    assert.equal(ready.status, 'ready', ready.error || '')
    assert.equal(ready.configuration_hash, sourceAnalysisConfigurationHash(currentConfiguration()))
    assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length, sourceWorkPlan(scriptSourcePassages(revised)).length)
    assertFullSynthesis(prompts, revised)
    assertEvidence(revised, ready.sections)
  } finally { release(); await analyzer.close() }
})

test('corrupt pending reuse accounting cannot justify a recovered partial directory', async t => {
  for (const issue of ['null_pages', 'missing_consumed_pages', 'wrong_character_count'] as const) await t.test(issue, async () => {
    const id = project(), original = effectiveScriptSource(id)!, revised = revisedContent(original.content)
    let began: () => void = () => {}, release: () => void = () => {}
    const started = new Promise<void>(resolve => { began = resolve })
    const first = createScriptSourceAnalyzer(async (_id, _model, prompt) => {
      if (prompt.includes(mapMarker) && inputFor<MapInput>(prompt, mapMarker).passages.flatMap(passage => passage.units).map(unit => unit.text).join('') === revised) {
        return new Promise<string>(resolve => { release = () => resolve(reply(prompt)); began() })
      }
      return reply(prompt)
    }, limits, { configuration })
    try {
      first.start(id, 'model')
      assert.equal((await terminal(id)).status, 'ready')
      const committed = commit(id, revised)
      await started
      assert.ok(snapshot(id).revision_reuse!.reused_pages.length > 0)
      await first.close(); release()
      // The original provider may finish despite local cancellation. Its exact
      // complete reply is retained before abort reaches the business consumer.
      await new Promise<void>(resolve => setImmediate(resolve))
      const interruptedRun = snapshot(id).id
      const retained = one<{ count: number }>("SELECT count(*) AS count FROM source_model_requests WHERE run_id=? AND state='completed'", interruptedRun)!.count
      assert.equal(retained, 1, 'the complete original in-flight reply survives shutdown')
      const corrupted = snapshot(id) as unknown as { revision_reuse: Record<string, unknown> }
      if (issue === 'null_pages') corrupted.revision_reuse.reused_pages = null
      if (issue === 'missing_consumed_pages') corrupted.revision_reuse.reused_pages = []
      if (issue === 'wrong_character_count') corrupted.revision_reuse.reused_characters = 0
      run('UPDATE script_source_analyses SET snapshot=? WHERE project_id=?', JSON.stringify(corrupted), id)
      const prompts: string[] = []
      const second = createScriptSourceAnalyzer(async (_id, _model, prompt) => { prompts.push(prompt); return reply(prompt) }, limits, { configuration })
      try {
        second.recover()
        const ready = await terminal(id, scriptSourceVersion(committed))
        assert.equal(ready.status, 'ready', ready.error || '')
        assert.equal(prompts.filter(prompt => prompt.includes(mapMarker)).length + retained, sourceWorkPlan(scriptSourcePassages(revised)).length,
          'rebuild every page from validated exact replies, querying only pages without a retained response')
        assert.equal(snapshot(id).revision_reuse?.status, 'discarded', 'corrupt reuse accounting is discarded rather than trusted')
        assertFullSynthesis(prompts, revised)
        assertEvidence(revised, ready.sections)
      } finally { await second.close() }
    } finally { release(); await first.close() }
  })
})
