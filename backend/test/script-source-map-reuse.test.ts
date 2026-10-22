import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { planScriptSourceMapReuse, validScriptSourceMapReuseState, type ScriptSourceMapReuseOptions } from '../src/modules/script/script-source-map-reuse.js'
import { scriptSourceVersion } from '../src/modules/script/script-source-identity.js'
import { scriptSourcePassages, sourceAnalysisPipelineVersion, sourceWorkPlan } from '../src/modules/script/script-source-map.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'

function fixture(count = 48) {
  let content = ''
  const sections: ScriptSourceSection[] = []
  for (let id = 0; id < count; id++) {
    const opening = `第${id + 1}集 河岸调查\n林舟${id}沿着河岸调查信物。`
    const text = `${opening}\n${`第${id + 1}处居民仍在街道等候钟声，所有人继续走向山谷。`.repeat(42)}\n`
    const evidence = { offset: content.length, quote: opening }
    sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: `林舟${id}调查本集信物。`,
      continues_previous: false, unit_id: id,
      characters: [{ name: `林舟${id}`, description: '本集调查者', evidence: { ...evidence } }], events: [{ summary: '调查信物', evidence: { ...evidence } }], open_threads: [] })
    content += text
  }
  const source = { filename: '河岸调查.md', content }
  const plan = sourceWorkPlan(scriptSourcePassages(content))
  const story: ScriptSourceStory = { summary: '众人调查信物并回家。',
    characters: sections.map((section, id) => ({ name: section.characters[0]!.name, aliases: [], description: '调查者', section_ids: [id] })),
    timeline: sections.map((_, id) => ({ summary: '调查信物', section_ids: [id] })), threads: [],
    ending: { summary: '众人回家。', section_ids: [count - 1] }, uncertainties: [] }
  const analysis: ScriptSourceAnalysis = { id: 'reviewed-old-map', source_version: scriptSourceVersion(source), model_id: 'test',
    status: 'ready', phase: 'ready', completed_chunks: plan.length, total_chunks: plan.length, completed_characters: content.length,
    sections, story, pipeline_version: sourceAnalysisPipelineVersion, error: null, updated_at: '2026-10-19T00:00:00.000Z' }
  analysis.quality = { status: 'passed', input_hash: sourceQualityInputHash(analysis), findings: [] }
  const at = (id: number) => sections[id]!.offset + content.slice(sections[id]!.offset).indexOf('所有人')
  return { source, analysis, at }
}

function revised(source: { filename: string; content: string }, at: number, removed: number, inserted: string) {
  return { ...source, content: source.content.slice(0, at) + inserted + source.content.slice(at + removed) }
}
const widePolicy: ScriptSourceMapReuseOptions = { maxChangedCharacters: 100_000, maxChangedRatio: 1 }

test('a middle insertion preserves exact prefix and shifted suffix pages while clearing old continuity IDs', () => {
  const { source, analysis, at } = fixture()
  const current = revised(source, at(23), 0, '雨停之后，')
  const before = structuredClone(analysis)
  const plan = planScriptSourceMapReuse(source, analysis, current)
  assert.equal(plan.mode, 'incremental')
  assert.equal(plan.source_version, scriptSourceVersion(current))
  assert.equal(plan.base_source_version, scriptSourceVersion(source))
  assert.deepEqual(plan.change, { old_offset: at(23), old_length: 0, new_offset: at(23), new_length: 5 })
  assert.ok(plan.pages.some(page => page.reuse_sections && page.offset < at(23)))
  assert.ok(plan.pages.some(page => page.reuse_sections && page.offset > at(23)))
  assert.ok(plan.pages.some(page => !page.reuse_sections))
  assert.equal(plan.reused_characters + plan.rebuilt_characters, current.content.length)
  let end = 0
  for (const page of plan.pages) {
    assert.equal(page.offset, end); end += page.length
    if (!page.reuse_sections) continue
    assert.equal(page.reuse_sections[0]!.offset, page.offset)
    assert.equal(page.reuse_sections.at(-1)!.offset + page.reuse_sections.at(-1)!.length, end)
    for (const [index, section] of page.reuse_sections.entries()) {
      const original = analysis.sections[page.base_section_ids![index]!]!
      assert.equal(current.content.slice(section.offset, section.offset + section.length), source.content.slice(original.offset, original.offset + original.length))
      assert.equal(section.offset - original.offset, page.offset > at(23) ? 5 : 0)
      assert.equal(section.unit_id, undefined)
      for (const item of [...section.characters, ...section.events]) assert.equal(current.content.slice(item.evidence.offset, item.evidence.offset + item.evidence.quote.length), item.evidence.quote)
    }
  }
  assert.equal(end, current.content.length)
  assert.equal('story' in plan, false); assert.equal('quality' in plan, false)
  assert.deepEqual(analysis, before, 'planning must not mutate the reviewed base')
})

test('a middle deletion remaps suffix evidence and leaves changed or neighboring episodes to regenerate', () => {
  const { source, analysis, at } = fixture()
  const current = revised(source, at(23), 3, '')
  const plan = planScriptSourceMapReuse(source, analysis, current)
  assert.equal(plan.mode, 'incremental')
  assert.deepEqual(plan.invalidated_old_section_ids, [22, 23, 24])
  const tail = plan.pages.findLast(page => page.reuse_sections)!
  const original = analysis.sections[tail.base_section_ids![0]!]!
  assert.equal(tail.reuse_sections![0]!.offset, original.offset - 3)
  assert.equal(tail.reuse_sections![0]!.characters[0]!.evidence.offset, original.characters[0]!.evidence.offset - 3)
  for (const page of plan.pages) assert.equal(page.base_section_ids?.some(id => plan.invalidated_old_section_ids.includes(id)) || false, false)
})

test('shared in-memory person and event evidence is shifted independently exactly once', () => {
  const { source, analysis, at } = fixture()
  analysis.sections[40]!.events[0]!.evidence = analysis.sections[40]!.characters[0]!.evidence
  analysis.quality!.input_hash = sourceQualityInputHash(analysis)
  const plan = planScriptSourceMapReuse(source, analysis, revised(source, at(23), 0, '雨停，'))
  assert.equal(plan.mode, 'incremental')
  const section = plan.pages.flatMap(page => page.reuse_sections || []).find(item => item.title === '第41集')!
  assert.equal(section.characters[0]!.evidence.offset, analysis.sections[40]!.characters[0]!.evidence.offset + 3)
  assert.equal(section.events[0]!.evidence.offset, section.characters[0]!.evidence.offset)
})

test('insertion at the beginning or end invalidates the touching edge and preserves only exact unaffected pages', () => {
  const { source, analysis } = fixture()
  for (const [position, expectedDirty] of [[0, [0, 1]], [source.content.length, [46, 47]]] as Array<[number, number[]]>) {
    const plan = planScriptSourceMapReuse(source, analysis, revised(source, position, 0, '新增说明。\n'))
    assert.equal(plan.mode, 'incremental')
    assert.deepEqual(plan.invalidated_old_section_ids, expectedDirty)
    assert.ok(plan.pages.some(page => page.reuse_sections))
    assert.ok(plan.pages.some(page => !page.reuse_sections))
  }
})

test('a change exactly at a section boundary invalidates both neighboring sides', () => {
  const { source, analysis } = fixture()
  const boundary = analysis.sections[23]!.offset
  const plan = planScriptSourceMapReuse(source, analysis, revised(source, boundary, 0, '新增说明。\n'))
  assert.equal(plan.mode, 'incremental')
  assert.deepEqual(plan.invalidated_old_section_ids, [21, 22, 23, 24])
})

test('dirty scope includes full episodes, adjacent episodes and complete continuation chains without recursive arbitrary neighbors', () => {
  const { source, analysis, at } = fixture()
  analysis.sections[22]!.episode_number = 24
  analysis.sections[24]!.episode_number = 24
  analysis.sections[21]!.continues_previous = true
  analysis.sections[25]!.continues_previous = true
  analysis.sections[26]!.continues_previous = true
  analysis.quality!.input_hash = sourceQualityInputHash(analysis)
  const plan = planScriptSourceMapReuse(source, analysis, revised(source, at(23), 2, '各位'))
  assert.equal(plan.mode, 'incremental')
  assert.deepEqual(plan.invalidated_old_section_ids, [20, 21, 22, 23, 24, 25, 26, 27])
  assert.ok(plan.pages.some(page => page.reuse_sections))
})

test('invalid map coordinates or evidence prevent any reuse even when the saved review hash was recomputed', () => {
  const { source, analysis, at } = fixture()
  for (const mutate of [
    (state: ScriptSourceAnalysis) => { state.sections[3]!.offset++ },
    (state: ScriptSourceAnalysis) => { state.sections[3]!.length = 0 },
    (state: ScriptSourceAnalysis) => { state.sections[3]!.offset += 0.5 },
    (state: ScriptSourceAnalysis) => { state.sections[3]!.characters[0]!.evidence.quote = '不存在的证据' },
    (state: ScriptSourceAnalysis) => { state.sections[3]!.events[0]!.evidence.offset += 0.5 },
    (state: ScriptSourceAnalysis) => { state.story = undefined },
  ]) {
    const broken = structuredClone(analysis); mutate(broken); broken.quality!.input_hash = sourceQualityInputHash(broken)
    const plan = planScriptSourceMapReuse(source, broken, revised(source, at(23), 0, '雨停，'))
    assert.equal(plan.mode, 'full'); assert.equal(plan.reason, 'invalid_base_map')
    assert.ok(plan.pages.every(page => !page.reuse_sections))
  }
})

test('ready state, supported pipeline, exact base identity and a current passed review are mandatory', () => {
  const { source, analysis, at } = fixture()
  const current = revised(source, at(23), 0, '雨停，')
  for (const [overrides, reason] of [
    [{ source_version: 'older' }, 'base_version_mismatch'],
    [{ status: 'failed' }, 'base_analysis_incomplete'],
    [{ phase: 'synthesis' }, 'base_analysis_incomplete'],
    [{ completed_characters: source.content.length - 1 }, 'base_analysis_incomplete'],
    [{ completed_chunks: analysis.total_chunks - 1 }, 'base_analysis_incomplete'],
    [{ pipeline_version: 4 }, 'unsupported_pipeline'],
    [{ quality: undefined }, 'base_quality_unverified'],
    [{ quality: { status: 'passed', input_hash: 'stale', findings: [] } }, 'base_quality_unverified'],
    [{ quality: { ...analysis.quality!, status: 'issues' } }, 'base_quality_unverified'],
  ] as Array<[Partial<ScriptSourceAnalysis>, string]>) {
    const plan = planScriptSourceMapReuse(source, { ...analysis, ...overrides }, current)
    assert.equal(plan.mode, 'full'); assert.equal(plan.reason, reason)
  }
  assert.equal(planScriptSourceMapReuse(source, { ...analysis, pipeline_version: 5 }, current).mode, 'incremental')
})

test('unchanged sources, renamed files, broad changes and an explicit rollback use the full plan', () => {
  const { source, analysis, at } = fixture()
  assert.equal(planScriptSourceMapReuse(source, analysis, source).reason, 'unchanged_source')
  assert.equal(planScriptSourceMapReuse(source, analysis, { ...source, filename: '新版.md' }).reason, 'filename_changed')
  assert.equal(planScriptSourceMapReuse(source, analysis, revised(source, at(23), 0, '雨停，'), { enabled: false }).reason, 'disabled')
  const broad = revised(source, at(3), 20_000, '故事已经改写。')
  assert.equal(planScriptSourceMapReuse(source, analysis, broad).reason, 'change_scope_too_large')
  for (const policy of [{ maxChangedCharacters: -1 }, { maxChangedRatio: 1.1 }, { maxChangedRatio: Number.NaN }]) {
    assert.equal(planScriptSourceMapReuse(source, analysis, revised(source, at(23), 0, '雨停，'), policy).reason, 'invalid_reuse_policy')
  }
})

test('new page endpoints must coincide with old semantic boundaries; unchanged text alone is insufficient', () => {
  const { source, analysis, at } = fixture()
  // A legal, independently reviewed old map may have one semantic section
  // spanning all current page boundaries. It cannot be split mechanically.
  analysis.sections = [{ ...analysis.sections[0]!, length: source.content.length, episode_number: null }]
  analysis.story = { summary: '完整目录的一个语义节点。', characters: [{ name: '林舟0', aliases: [], description: '调查者', section_ids: [0] }],
    timeline: [{ summary: '调查信物', section_ids: [0] }], threads: [], ending: { summary: '众人归来。', section_ids: [0] }, uncertainties: [] }
  analysis.quality!.input_hash = sourceQualityInputHash(analysis)
  const plan = planScriptSourceMapReuse(source, analysis, revised(source, at(23), 0, '雨停，'))
  assert.equal(plan.mode, 'full'); assert.equal(plan.reason, 'no_reusable_pages')
  assert.ok(plan.pages.length > 1)
  assert.ok(plan.pages.every(page => !page.reuse_sections))
})

test('short sources without an unaffected complete page have no reusable map output', () => {
  const { source, analysis, at } = fixture(3)
  assert.equal(planScriptSourceMapReuse(source, analysis, revised(source, at(1), 0, '雨停，')).reason, 'no_reusable_pages')
})

test('multiple distant modifications form one exact envelope and never reuse intervening pages', () => {
  const { source, analysis, at } = fixture()
  const first = at(18), second = at(28)
  const current = { ...source, content: source.content.slice(0, first) + '雨' + source.content.slice(first + 1, second) + '雪' + source.content.slice(second + 1) }
  const plan = planScriptSourceMapReuse(source, analysis, current, widePolicy)
  assert.equal(plan.mode, 'incremental')
  assert.deepEqual(plan.change, { old_offset: first, old_length: second - first + 1, new_offset: first, new_length: second - first + 1 })
  for (let id = 18; id <= 28; id++) assert.ok(plan.invalidated_old_section_ids.includes(id))
  for (const page of plan.pages.filter(page => page.reuse_sections)) {
    assert.ok(page.offset + page.length <= first || page.offset >= second + 1)
  }
})

test('Unicode change bounds retain entire surrogate pairs and never normalize distinct original text', () => {
  const { source: initial, analysis, at } = fixture()
  const source = revised(initial, at(23), 0, '😀')
  const shift = source.content.length - initial.content.length
  for (const section of analysis.sections) {
    if (section.offset > at(23)) {
      section.offset += shift
      for (const item of [...section.characters, ...section.events]) item.evidence.offset += shift
    } else if (section.offset + section.length > at(23)) section.length += shift
  }
  analysis.source_version = scriptSourceVersion(source); analysis.completed_characters = source.content.length
  analysis.quality!.input_hash = sourceQualityInputHash(analysis)
  for (const replacement of ['😁', String.fromCodePoint(0x1fa00)]) {
    const current = { ...source, content: source.content.replace('😀', replacement) }
    const plan = planScriptSourceMapReuse(source, analysis, current)
    assert.equal(plan.mode, 'incremental')
    assert.equal(plan.change!.old_offset, at(23)); assert.equal(plan.change!.old_length, 2); assert.equal(plan.change!.new_length, 2)
    assert.equal(source.content.slice(plan.change!.old_offset, plan.change!.old_offset + plan.change!.old_length), '😀')
    assert.equal(current.content.slice(plan.change!.new_offset, plan.change!.new_offset + plan.change!.new_length), replacement)
  }
})

test('planning identities bind source, reviewed map and reuse policy deterministically', () => {
  const { source, analysis, at } = fixture()
  const current = revised(source, at(23), 0, '雨停，')
  const first = planScriptSourceMapReuse(source, analysis, current)
  assert.equal(planScriptSourceMapReuse(source, analysis, current).input_hash, first.input_hash)
  assert.notEqual(planScriptSourceMapReuse(source, analysis, current, { maxChangedCharacters: 1000 }).input_hash, first.input_hash)
  const changedMap = structuredClone(analysis); changedMap.sections[0]!.summary = '不同的已审读目录内容'
  changedMap.quality!.input_hash = sourceQualityInputHash(changedMap)
  assert.notEqual(planScriptSourceMapReuse(source, changedMap, current).input_hash, first.input_hash)
})

function consumedState(completed?: number) {
  const { source, analysis, at } = fixture(), current = revised(source, at(23), 0, '雨停，')
  const plan = planScriptSourceMapReuse(source, analysis, current)
  assert.equal(plan.mode, 'incremental')
  const state: ScriptSourceAnalysis = { id: 'new-revision', source_version: plan.source_version, model_id: 'test', status: 'failed',
    phase: 'reading', completed_chunks: completed ?? plan.pages.length, total_chunks: plan.pages.length, sections: [],
    completed_characters: 0, pipeline_version: sourceAnalysisPipelineVersion, error: '隔离恢复检查', updated_at: 'now',
    revision_reuse: { input_hash: plan.input_hash, base_source_version: plan.base_source_version, source_version: plan.source_version,
      status: 'pending', planned_pages: plan.pages.flatMap((page, index) => page.reuse_sections?.length ? [index] : []),
      reused_pages: [], reused_section_ids: [], reused_characters: 0 } }
  for (let index = 0; index < state.completed_chunks; index++) {
    const page = plan.pages[index]!, first = state.sections.length
    const sections: ScriptSourceSection[] = page.reuse_sections ? structuredClone(page.reuse_sections) : [{ offset: page.offset, length: page.length,
      title: '新稿重建页', episode_number: null, summary: '依据当前新稿重新分析的事实。', continues_previous: false,
      characters: [], events: [{ summary: '新稿中的调查继续。', evidence: { offset: page.offset, quote: current.content.slice(page.offset, page.offset + 20) } }], open_threads: [] }]
    for (const section of sections) {
      const previous = state.sections.at(-1)
      section.continues_previous = !!previous && !!section.continues_previous && previous.offset + previous.length === section.offset &&
        !(previous.episode_number && section.episode_number && previous.episode_number !== section.episode_number)
      section.unit_id = section.continues_previous ? previous!.unit_id ?? state.sections.length - 1 : state.sections.length
      state.sections.push(section)
    }
    if (page.reuse_sections) {
      state.revision_reuse!.reused_pages.push(index)
      state.revision_reuse!.reused_section_ids.push(...sections.map((_, local) => first + local))
      state.revision_reuse!.reused_characters += page.length
    }
    state.completed_characters = page.offset + page.length
  }
  return { state, plan }
}

test('candidate provenance accepts exactly the completed contiguous prefix with uninitialized work at every recovery point', () => {
  const { plan: fullPlan } = consumedState()
  for (let completed = 0; completed <= fullPlan.pages.length; completed++) {
    const { state, plan } = consumedState(completed)
    assert.equal(state.work, undefined)
    assert.equal(validScriptSourceMapReuseState(state, plan), true, `valid completed-page prefix ${completed}`)
    state.work = []
    assert.equal(validScriptSourceMapReuseState(state, plan), true, 'the independently reconstructed plan owns work-page validation')
  }
})

test('candidate provenance rejects corrupt, absent, empty, duplicate or reordered ledger arrays and changed counts', () => {
  const { state, plan } = consumedState()
  const changes: Array<(value: ScriptSourceAnalysis) => void> = [
    value => { delete (value.revision_reuse as Partial<NonNullable<ScriptSourceAnalysis['revision_reuse']>>).planned_pages },
    value => { value.revision_reuse!.planned_pages = null as unknown as number[] },
    value => { value.revision_reuse!.planned_pages = [] },
    value => { value.revision_reuse!.planned_pages.reverse() },
    value => { value.revision_reuse!.planned_pages.push(value.revision_reuse!.planned_pages.at(-1)!) },
    value => { value.revision_reuse!.planned_pages.push(plan.pages.length) },
    value => { delete value.revision_reuse!.planned_pages[value.revision_reuse!.planned_pages.length - 1] },
    value => { delete (value.revision_reuse as Partial<NonNullable<ScriptSourceAnalysis['revision_reuse']>>).reused_pages },
    value => { value.revision_reuse!.reused_pages = null as unknown as number[] },
    value => { value.revision_reuse!.reused_pages = [] },
    value => { value.revision_reuse!.reused_pages.reverse() },
    value => { value.revision_reuse!.reused_pages.push(value.revision_reuse!.reused_pages.at(-1)!) },
    value => { delete (value.revision_reuse as Partial<NonNullable<ScriptSourceAnalysis['revision_reuse']>>).reused_section_ids },
    value => { value.revision_reuse!.reused_section_ids = null as unknown as number[] },
    value => { value.revision_reuse!.reused_section_ids = [] },
    value => { value.revision_reuse!.reused_section_ids.reverse() },
    value => { value.revision_reuse!.reused_section_ids[0] = 0.5 },
    value => { value.revision_reuse!.reused_section_ids.push(value.revision_reuse!.reused_section_ids.at(-1)!) },
    value => { value.revision_reuse!.reused_characters-- },
    value => { value.revision_reuse!.reused_characters = Number.NaN },
    value => { value.revision_reuse!.reused_characters = -1 },
    value => { value.completed_chunks-- },
    value => { value.completed_chunks = 0.5 },
    value => { value.total_chunks++ },
    value => { value.completed_characters!-- },
  ]
  for (const [index, mutate] of changes.entries()) {
    const damaged = structuredClone(state); mutate(damaged)
    assert.equal(validScriptSourceMapReuseState(damaged, plan), false, `corrupt provenance case ${index}`)
  }
  const { state: partial, plan: partialPlan } = consumedState(1)
  partial.revision_reuse!.reused_pages.push(partial.revision_reuse!.planned_pages.at(-1)!)
  assert.equal(validScriptSourceMapReuseState(partial, partialPlan), false, 'future reusable pages must not be claimed as consumed')
})

test('candidate provenance binds both versions, the exact plan and pending lifecycle state', () => {
  const { state, plan } = consumedState()
  for (const mutate of [
    (value: ScriptSourceAnalysis) => { value.source_version = 'different-source' },
    (value: ScriptSourceAnalysis) => { value.revision_reuse!.source_version = 'different-source' },
    (value: ScriptSourceAnalysis) => { value.revision_reuse!.base_source_version = 'different-base' },
    (value: ScriptSourceAnalysis) => { value.revision_reuse!.input_hash = 'different-plan' },
    (value: ScriptSourceAnalysis) => { value.revision_reuse!.status = 'verified' },
    (value: ScriptSourceAnalysis) => { value.revision_reuse!.status = 'discarded' },
    (value: ScriptSourceAnalysis) => { delete value.revision_reuse },
  ]) {
    const damaged = structuredClone(state); mutate(damaged)
    assert.equal(validScriptSourceMapReuseState(damaged, plan), false)
  }
  assert.equal(validScriptSourceMapReuseState(state, { ...plan, mode: 'full' }), false)
})

test('candidate provenance rejects changed reused facts, quotes, offsets or chapter boundaries', () => {
  const { state, plan } = consumedState(), first = state.revision_reuse!.reused_section_ids[0]!
  for (const mutate of [
    (value: ScriptSourceAnalysis) => { value.sections[first]!.summary = '篡改候选理解' },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.title = '篡改标题' },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.characters[0]!.name = '另一人物' },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.characters[0]!.description = '另一身份' },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.characters[0]!.evidence.quote = '篡改引用' },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.events[0]!.evidence.offset++ },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.open_threads = ['新增无依据伏笔'] },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.continues_previous = true },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.continues_previous = 'false' as unknown as boolean },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.offset++ },
    (value: ScriptSourceAnalysis) => { value.sections[first]!.length-- },
    (value: ScriptSourceAnalysis) => { value.sections.splice(first, 1) },
  ]) {
    const damaged = structuredClone(state); mutate(damaged)
    assert.equal(validScriptSourceMapReuseState(damaged, plan), false)
  }
})

test('recomputed unit IDs and a safely adjusted preceding-continuation flag do not invalidate identical candidate facts', () => {
  const { state, plan } = consumedState()
  for (const section of state.sections) section.unit_id = 123_456
  assert.equal(validScriptSourceMapReuseState(state, plan), true)
  const first = state.revision_reuse!.reused_section_ids[0]!
  // appendSourceSections always clears the first section's incoming link,
  // even if an otherwise verified plan candidate retained that old marker.
  plan.pages[0]!.reuse_sections![0]!.continues_previous = true
  state.sections[first]!.continues_previous = false
  assert.equal(validScriptSourceMapReuseState(state, plan), true)
  const expected = plan.pages[0]!.reuse_sections![1]!, actual = state.sections[first + 1]!
  expected.episode_number = plan.pages[0]!.reuse_sections![0]!.episode_number
  expected.continues_previous = true
  actual.episode_number = expected.episode_number; actual.continues_previous = true
  assert.equal(validScriptSourceMapReuseState(state, plan), true, 'a real retained continuation inside a reused page remains valid')
  actual.continues_previous = false
  assert.equal(validScriptSourceMapReuseState(state, plan), false, 'a damaged continuation cannot erase a genuine retained link')
})
