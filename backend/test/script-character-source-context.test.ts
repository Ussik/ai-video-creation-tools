import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceSection, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { buildScriptCharacterSourceContext, type ScriptCharacterSourceContextOptions } from '../src/modules/script/script-character-source-context.js'
import { scriptSourceVersion } from '../src/modules/script/script-source-identity.js'

function fixture(extra: Record<number, string> = {}) {
  let content = ''
  const sections: ScriptSourceSection[] = []
  for (let id = 0; id < 30; id++) {
    const text = `第${id + 1}集。${id === 5 ? '赵云进入城门，守卫称他赵将军。' : id === 25 ? '赵将军归还信物。' : `韩舟${id}正在赶路。`}${extra[id] || ''}\n${'城中的居民循着街道走向远方。'.repeat(24)}\n`
    const evidence = { offset: content.length, quote: text.slice(0, text.indexOf('\n')) }
    sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: evidence.quote,
      characters: [{ name: id === 5 ? '赵云' : id === 25 ? '赵将军' : `韩舟${id}`, description: '原稿中出现的人物', evidence }], events: [] })
    content += text
  }
  const source = { filename: '人物资料.txt', content }
  const state = { source_version: scriptSourceVersion(source), sections }
  const seedCharacters: ScriptSourceStory['characters'] = [{ name: '赵云', aliases: ['赵将军'], description: '守卫明示的称呼', section_ids: [5, 25] }]
  const options: ScriptCharacterSourceContextOptions = { targetNames: ['赵云'], seedCharacters,
    overview: { summary: '赵云调查城中的信物。', ending: { summary: '信物归还。', section_ids: [29] } } }
  return { state, source, options }
}

test('character packs include every spelling occurrence, seed evidence, adjacent chapters, and the remote alias reveal', () => {
  const { state, source, options } = fixture({ 14: '赵云在此稍作停留。' })
  const result = buildScriptCharacterSourceContext(state, source, options)
  assert.equal(result.mode, 'targeted')
  assert.equal(result.coverage.complete_source, false)
  assert.ok(result.coverage.selected_length < source.content.length)
  assert.deepEqual(result.known_names, ['赵云', '赵将军'])
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵云')!.raw_match_section_ids, [5, 14])
  assert.deepEqual(result.selected_section_ids, [4, 5, 6, 13, 14, 15, 24, 25, 26, 28, 29])
  assert.match(result.source_ranges.find(range => range.section_ids.includes(25))!.content, /赵将军归还信物/)
  for (const range of result.source_ranges) assert.equal(range.content, source.content.slice(range.offset, range.offset + range.length))
  assert.equal(result.global_background!.interpretation_only, true)
  assert.deepEqual(result.global_background!.ending.section_ids, [29])
})

test('a directory-only location supplements raw occurrences but never hides an omitted original mention', () => {
  const { state, source, options } = fixture({ 14: '赵云在此稍作停留。' })
  state.sections[9]!.characters.push({ ...state.sections[9]!.characters[0]!, name: '赵云', description: '目录线索' })
  const result = buildScriptCharacterSourceContext(state, source, options)
  assert.equal(result.mode, 'targeted')
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵云')!.section_ids, [5, 9, 14])
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵云')!.raw_match_section_ids, [5, 14])
  assert.ok(result.selected_section_ids.includes(9)); assert.ok(result.selected_section_ids.includes(14))
})

test('a later directory-known independent character can be scoped without treating its name as a seed alias', () => {
  const { state, source, options } = fixture()
  const result = buildScriptCharacterSourceContext(state, source, { ...options, targetNames: ['韩舟12'] })
  assert.equal(result.mode, 'targeted')
  assert.deepEqual(result.known_names, ['韩舟12'])
  assert.deepEqual(result.selected_section_ids, [11, 12, 13, 28, 29])
  assert.equal(result.source_ranges.some(range => range.content.includes('赵将军')), false)
})

test('selected episodes are complete and adjacent continuation chains are never cut', () => {
  const { state, source, options } = fixture()
  state.sections[4]!.episode_number = 6
  state.sections[6]!.episode_number = 6
  state.sections[3]!.continues_previous = true
  state.sections[7]!.continues_previous = true
  state.sections[8]!.continues_previous = true
  const result = buildScriptCharacterSourceContext(state, source, { ...options, targetNames: ['赵云'],
    seedCharacters: [{ ...options.seedCharacters![0]!, aliases: [], section_ids: [5] }] })
  assert.equal(result.mode, 'targeted')
  assert.deepEqual(result.selected_section_ids, [2, 3, 4, 5, 6, 7, 8, 28, 29])
})

test('summary, event and open-thread clues include their original sections even without character-list or raw-name matches', () => {
  const { state, source, options } = fixture()
  state.sections[10]!.summary = '赵云之前的行动造成此处后果。'
  state.sections[16]!.events.push({ summary: '赵云的信物在此被转交。', evidence: state.sections[16]!.characters[0]!.evidence })
  state.sections[20]!.open_threads = ['赵将军留下的问题在此回收。']
  const result = buildScriptCharacterSourceContext(state, source, options)
  assert.equal(result.mode, 'targeted')
  for (const id of [10, 16, 20]) {
    assert.equal(state.sections[id]!.characters.some(character => ['赵云', '赵将军'].includes(character.name)), false)
    const original = source.content.slice(state.sections[id]!.offset, state.sections[id]!.offset + state.sections[id]!.length)
    assert.equal(/赵云|赵将军/.test(original), false)
    assert.ok(result.selected_section_ids.includes(id))
    assert.ok(result.source_ranges.some(range => range.content.includes(original)))
  }
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵云')!.raw_match_section_ids, [5])
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵云')!.section_ids, [5, 10, 16])
  assert.deepEqual(result.literal_matches.find(match => match.name === '赵将军')!.section_ids, [5, 20, 25])
})

test('the exact unnamed ending, its complete episode and neighboring continuation chain remain available', () => {
  const { state, source, options } = fixture()
  state.sections[27]!.episode_number = 30
  state.sections[28]!.episode_number = 30
  state.sections[26]!.continues_previous = true
  const result = buildScriptCharacterSourceContext(state, source, { ...options,
    seedCharacters: [{ ...options.seedCharacters![0]!, aliases: [], section_ids: [5] }] })
  assert.equal(result.mode, 'targeted')
  for (const id of [25, 26, 27, 28, 29]) assert.ok(result.selected_section_ids.includes(id))
  const ending = state.sections[29]!
  const exactEnding = source.content.slice(ending.offset, ending.offset + ending.length)
  assert.equal(/赵云|赵将军/.test(exactEnding), false)
  assert.ok(result.source_ranges.some(range => range.content.includes(exactEnding)))
  assert.equal(result.literal_matches.find(match => match.name === '赵云')!.section_ids.includes(29), false)
})

test('first discovery, disabled packs, absent seed or missing global understanding retain full source', () => {
  const { state, source, options } = fixture()
  for (const [override, reason] of [
    [{ includeAdditionalCharacters: true }, 'full_discovery_required'],
    [{ enabled: false }, 'disabled'],
    [{ seedCharacters: undefined }, 'full_discovery_missing'],
    [{ seedCharacters: [] }, 'full_discovery_missing'],
    [{ overview: undefined }, 'global_overview_missing'],
  ] as Array<[Partial<ScriptCharacterSourceContextOptions>, string]>) {
    const result = buildScriptCharacterSourceContext(state, source, { ...options, ...override })
    assert.equal(result.mode, 'full'); assert.equal(result.reason, reason)
    assert.equal(result.coverage.selected_length, source.content.length)
    assert.equal(result.coverage.complete_source, true)
    assert.deepEqual(result.source_ranges, [])
  }
})

test('source version mismatch and incomplete or stale source coordinates keep full context', () => {
  const { state, source, options } = fixture()
  assert.equal(buildScriptCharacterSourceContext({ ...state, source_version: 'older' }, source, options).reason, 'analysis_version_mismatch')
  const incomplete = structuredClone(state)
  incomplete.sections[5]!.offset++
  assert.equal(buildScriptCharacterSourceContext(incomplete, source, options).reason, 'invalid_source_map')
  const stale = structuredClone(state)
  stale.sections[5]!.characters[0]!.evidence.quote = '不存在的引用'
  assert.equal(buildScriptCharacterSourceContext(stale, source, options).reason, 'invalid_source_map')
})

test('generic, unknown, evidence-free aliases and overlapping different identities retain the full manuscript', () => {
  const { state, source, options } = fixture({ 12: '士兵站岗。张三穿过树林。' })
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, targetNames: ['士兵'] }).reason, 'ambiguous_character_name')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, targetNames: ['张三'] }).reason, 'unknown_character_name')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters: [{ ...options.seedCharacters![0]!, aliases: ['赵元帅'] }] }).reason, 'alias_without_source_evidence')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options,
    seedCharacters: [...options.seedCharacters!, { name: '赵云', aliases: [], description: '另一个同名人物', section_ids: [5] }] }).reason, 'ambiguous_seed_identity')
})

test('names normalized from fullwidth spellings retain exact unmodified source text', () => {
  const { state, source, options } = fixture({ 12: 'ＪＯＨＮ在此驻足。', 24: 'JOHN向山谷出发。' })
  state.sections[12]!.characters[0]!.name = 'JOHN'
  const result = buildScriptCharacterSourceContext(state, source, { ...options, targetNames: ['ＪＯＨＮ'] })
  assert.equal(result.mode, 'targeted')
  assert.deepEqual(result.literal_matches[0]!.raw_match_section_ids, [12, 24])
  assert.match(result.source_ranges[0]!.content, /ＪＯＨＮ/)
  assert.equal(source.content.includes(result.source_ranges[0]!.content), true)
})

test('explicit identity uncertainty in a full-source seed or directory prevents narrowing', () => {
  const { state, source, options } = fixture()
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options,
    seedCharacters: [{ ...options.seedCharacters![0]!, description: '身份存疑，无法确认是否同一人' }] }).reason, 'ambiguous_seed_identity')
  state.sections[5]!.characters[0]!.description = '与另一人同名，不能确定身份'
  assert.equal(buildScriptCharacterSourceContext(state, source, options).reason, 'ambiguous_seed_identity')
})

test('identical repeated seed identities keep the union of all original evidence', () => {
  const { state, source, options } = fixture({ 17: '一名守卫提及旧事。' })
  const result = buildScriptCharacterSourceContext(state, source, { ...options,
    seedCharacters: [...options.seedCharacters!, { ...options.seedCharacters![0]!, section_ids: [5, 17, 25] }] })
  assert.equal(result.mode, 'targeted')
  assert.ok(result.selected_section_ids.includes(17))
  assert.match(result.source_ranges.find(range => range.section_ids.includes(17))!.content, /守卫提及旧事/)
})

test('equal name sets with different seed descriptions remain distinct and force full-source identity review', () => {
  const { state, source, options } = fixture()
  const seedCharacters = [...options.seedCharacters!, { ...options.seedCharacters![0]!, description: '另一支军队的年轻将领', section_ids: [25] }]
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters }).reason, 'ambiguous_seed_identity')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters, targetNames: ['韩舟12'] }).mode, 'targeted',
    'unrelated seed ambiguity must not disable a distinct character scope')
})

test('identity uncertainty only present in a later same-name seed cannot be hidden by the first entry', () => {
  const { state, source, options } = fixture()
  const seedCharacters = [...options.seedCharacters!, { ...options.seedCharacters![0]!, description: '身份存疑，可能存在同名人物', section_ids: [25] }]
  const result = buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters })
  assert.equal(result.mode, 'full'); assert.equal(result.reason, 'ambiguous_seed_identity')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters, targetNames: ['韩舟12'] }).mode, 'targeted')
})

test('a name straddling a section boundary cannot silently lose an occurrence', () => {
  const { state, source, options } = fixture({ 10: '赵云经过。' })
  const at = state.sections[10]!.offset + source.content.slice(state.sections[10]!.offset).indexOf('赵云') + 1
  const section = state.sections[10]!
  // Empty evidence arrays make this a legal continuous map with the split
  // deliberately inside a later spelling occurrence.
  state.sections.splice(10, 1, { ...section, length: at - section.offset, characters: [], events: [] },
    { ...section, offset: at, length: section.offset + section.length - at, characters: [], events: [] })
  const result = buildScriptCharacterSourceContext(state, source, { ...options,
    seedCharacters: [{ name: '赵云', aliases: [], description: '原文人物', section_ids: [5] }] })
  assert.equal(result.mode, 'full'); assert.equal(result.reason, 'cross_section_literal_match')
})

test('packs fall back instead of truncating over budget or nearly complete selections', () => {
  const { state, source, options } = fixture()
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, maxSelectedCharacters: 5 }).reason, 'selected_scope_too_large')
  const characterOnlyLength = [4, 5, 6, 24, 25, 26].reduce((sum, id) => sum + state.sections[id]!.length, 0)
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, maxSelectedCharacters: characterOnlyLength }).reason, 'selected_scope_too_large',
    'ending originals participate in the same budget rather than being silently omitted')
  assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, targetNames: state.sections.map(section => section.characters[0]!.name) }).reason, 'selected_scope_too_large')
})

test('context identity binds complete source, directory, overview, seeds, and selected policy', () => {
  const { state, source, options } = fixture()
  const first = buildScriptCharacterSourceContext(state, source, options)
  assert.equal(buildScriptCharacterSourceContext(state, source, options).context_hash, first.context_hash)
  const changedOptions = { ...options, overview: { ...options.overview!, summary: '不同的全剧背景' } }
  assert.notEqual(buildScriptCharacterSourceContext(state, source, changedOptions).context_hash, first.context_hash)
  assert.notEqual(buildScriptCharacterSourceContext(state, source, { ...options, maxSelectedCharacters: 20_000 }).context_hash, first.context_hash)
  const changedSeed = { ...options, seedCharacters: [{ ...options.seedCharacters![0]!, description: '改变后的身份发现' }] }
  assert.notEqual(buildScriptCharacterSourceContext(state, source, changedSeed).context_hash, first.context_hash)
  assert.notEqual(buildScriptCharacterSourceContext({ ...state, sections: state.sections.slice(1) }, source, options).context_hash, first.context_hash)
})
