import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { createSourceCharacterEvidence } from '../src/modules/script/script-source-character-evidence.js'
import { buildScriptCharacterSourceContext } from '../src/modules/script/script-character-source-context.js'
import { missingSourceStoryNames, repairSourceStoryCharacters } from '../src/modules/script/script-source-story-character-repair.js'
import { synthesizeSourceStory, validateSourceStory } from '../src/modules/script/script-source-story.js'
import { sourceStoryTasks } from '../src/modules/script/script-source-story-plan.js'
import { prepareSourceWork } from '../src/modules/script/script-source-checkpoints.js'
import { scriptSourceVersion } from '../src/modules/script/script-source-identity.js'
import { sourceAnalysisPipelineVersion } from '../src/modules/script/script-source-map.js'

type Character = ScriptSourceStory['characters'][number]
const label = '陈瘸子（陈守拙）'
const character = (section_ids = [0]): Character => ({ name: '陈瘸子', aliases: ['陈守拙'], description: '原稿中的人物', section_ids })
const signal = () => new AbortController().signal
function fixture(entries: Array<{ text: string; names: string[] }>) {
  let content = ''
  const sections: ScriptSourceSection[] = entries.map(({ text, names }, id) => {
    const offset = content.length
    content += text
    return { offset, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: text.slice(0, 120), events: [],
      characters: names.map(name => ({ name, description: '原稿中的人物', evidence: { offset, quote: text.slice(0, 120) } })) }
  })
  const source = { filename: '复合目录标签.txt', content }
  const state: ScriptSourceAnalysis = { id: 'compound-coverage', source_version: scriptSourceVersion(source), model_id: 'model',
    status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, completed_characters: content.length,
    pipeline_version: sourceAnalysisPipelineVersion, sections, error: null, updated_at: 'now' }
  return { state, source, evidence: createSourceCharacterEvidence({ sections }, source) }
}
function story(characters: Character[]): ScriptSourceStory {
  return { summary: '原稿人物保留原有身份。', characters, timeline: [], threads: [], uncertainties: [], ending: { summary: '故事待续。', section_ids: [0] } }
}
function longFixture() {
  return fixture(Array.from({ length: 30 }, (_, id) => ({
    text: `第${id + 1}集，${id === 14 ? `${label}保存信件。` : id === 20 ? '角色20请陈守拙归还信件。' : `角色${String(id).padStart(2, '0')}保存信件。`}\n${'城中住民仍在保留原有线索。'.repeat(100)}\n`,
    names: [id === 14 ? label : `角色${String(id).padStart(2, '0')}`],
  })))
}
function charactersFor(state: ScriptSourceAnalysis): Character[] {
  return state.sections.flatMap((section, id) => section.characters.map(item => item.name === label ? character([14, 20])
    : { name: item.name, aliases: [], description: '原稿中的人物', section_ids: [id] }))
}

test('one model record may represent a literal directory composite with both complete supported spellings, without altering it', () => {
  const { state, source, evidence } = fixture([{ text: `${label}登场。`, names: [label] }])
  const entry = character(), before = structuredClone(entry)
  assert.equal(evidence.coversDirectoryName(entry, label), true)
  assert.equal(evidence.coversDirectoryName({ ...entry, name: '陈守拙', aliases: ['陈瘸子'] }, label), true)
  assert.deepEqual(entry, before)
  assert.deepEqual(missingSourceStoryNames(state, story([entry]), source), [])
  assert.deepEqual(validateSourceStory(state, story([entry]), source), story([entry]))
  assert.deepEqual(missingSourceStoryNames(state, story([entry])), [label], 'without source this equivalence cannot be proven')
})

test('composite coverage requires both complete spellings in the same model record and its own literal source citation', () => {
  const { state, source, evidence } = fixture([{ text: `${label}登场。`, names: [label] },
    { text: '陈瘸子和陈守拙在同一句出现，身份关系未说明。', names: [] }])
  for (const entry of [
    { ...character(), aliases: [] },
    { ...character(), name: '陈瘸', aliases: ['陈守拙'] },
    { ...character(), aliases: ['守拙'] },
    character([1]), character([]), character([0, 0]), character([999]),
  ]) assert.equal(evidence.coversDirectoryName(entry, label), false)
  const separated = story([{ ...character(), aliases: [] }, { name: '陈守拙', aliases: [], description: '另一条独立人物', section_ids: [0] }])
  assert.deepEqual(missingSourceStoryNames(state, separated, source), [label])
  assert.throws(() => validateSourceStory(state, separated, source), /遗漏.*陈瘸子/)
  const noLiteral = fixture([{ text: '陈瘸子和陈守拙在同一句出现，身份关系未说明。', names: [label] }])
  assert.equal(noLiteral.evidence.coversDirectoryName(character(), label), false)
})

test('an ASCII or fullwidth slash label is covered by one unchanged character record containing both complete source-supported names', () => {
  for (const target of ['黑水龙王/九门尸魁', '黑水龙王／九门尸魁']) {
    const { state, source, evidence } = fixture([{ text: `人物设定：${target}。他守在原来的水域。`, names: [target] }])
    const entries: Character[] = [
      { name: '九门尸魁', aliases: ['黑水龙王'], description: '原稿中的同一人物', section_ids: [0] },
      { name: '黑水龙王', aliases: ['九门尸魁'], description: '原稿中的同一人物', section_ids: [0] },
    ]
    const before = structuredClone({ source, sections: state.sections, entries })
    for (const entry of entries) {
      assert.equal(evidence.coversDirectoryName(entry, target), true, target)
      assert.deepEqual(missingSourceStoryNames(state, story([entry]), source), [])
      assert.deepEqual(validateSourceStory(state, story([entry]), source), story([entry]))
    }
    assert.deepEqual({ source, sections: state.sections, entries }, before, 'coverage does not rewrite the model answer, source, or directory label')
  }
})

test('slash coverage never combines separate character records or accepts a missing or partial spelling', () => {
  const target = '黑水龙王/九门尸魁', { state, source, evidence } = fixture([{ text: `${target}在人物设定中登场。`, names: [target] }])
  for (const entry of [
    { name: '九门尸魁', aliases: [], section_ids: [0] },
    { name: '黑水龙王', aliases: [], section_ids: [0] },
    { name: '尸魁', aliases: ['黑水龙王'], section_ids: [0] },
    { name: '九门尸魁', aliases: ['黑水龙'], section_ids: [0] },
  ]) assert.equal(evidence.coversDirectoryName(entry, target), false)
  const separated = story([
    { name: '黑水龙王', aliases: [], description: '独立记录之一', section_ids: [0] },
    { name: '九门尸魁', aliases: [], description: '独立记录之二', section_ids: [0] },
  ])
  assert.deepEqual(missingSourceStoryNames(state, separated, source), [target])
  assert.throws(() => validateSourceStory(state, separated, source), /遗漏.*黑水龙王/)
})

test('slash equivalence needs the complete literal label in this same record own valid cited section', () => {
  const target = '黑水龙王/九门尸魁'
  const { evidence } = fixture([{ text: `${target}是人物设定标题。`, names: [target] },
    { text: '黑水龙王与九门尸魁两个称呼都出现，但本段没有完整复合标签。', names: [] }])
  const entry = { name: '九门尸魁', aliases: ['黑水龙王'], section_ids: [0] }
  for (const section_ids of [[1], [], [0, 0], [99], [-1], [0.5]]) {
    assert.equal(evidence.coversDirectoryName({ ...entry, section_ids }, target), false)
  }
  const noLiteral = fixture([{ text: '黑水龙王和九门尸魁均在这段被提及，身份关联未说明。', names: [target] }])
  assert.equal(noLiteral.evidence.coversDirectoryName(entry, target), false, 'a directory label does not substitute for the complete literal source label')
  const noDirectoryTarget = fixture([{ text: `${target}是源文本标题。`, names: ['九门尸魁'] }])
  assert.equal(noDirectoryTarget.evidence.coversDirectoryName(entry, target), false)
})

test('slash lists, three-or-more spellings, repeated separators and annotations cannot become two-name identity labels', () => {
  for (const [target, name, aliases] of [
    ['黑水龙王/九门尸魁/第三称呼', '九门尸魁', ['黑水龙王', '第三称呼']],
    ['黑水龙王/九门尸魁/第三称呼/第四称呼', '九门尸魁', ['黑水龙王', '第三称呼', '第四称呼']],
    ['黑水龙王／九门尸魁／第三称呼', '九门尸魁', ['黑水龙王', '第三称呼']],
    ['黑水龙王、九门尸魁', '九门尸魁', ['黑水龙王']],
    ['黑水龙王/九门尸魁、第三称呼', '九门尸魁、第三称呼', ['黑水龙王']],
    ['黑水龙王//九门尸魁', '九门尸魁', ['黑水龙王']],
    ['九门尸魁/五十岁', '九门尸魁', ['五十岁']],
    ['九门尸魁/身份不明', '九门尸魁', ['身份不明']],
    ['黑水龙王/黑水龙王', '黑水龙王', []],
    ['甲/乙', '甲', ['乙']],
  ] as Array<[string, string, string[]]>) {
    const { evidence } = fixture([{ text: `${target}在原稿中出现。`, names: [target] }])
    assert.equal(evidence.coversDirectoryName({ name, aliases, section_ids: [0] }, target), false, target)
  }
})

test('unsupported directory composites and non-name annotations never become identity aliases mechanically', () => {
  for (const [target, outer, inner] of [
    ['陈瘸子（50岁）', '陈瘸子', '50岁'], ['陈瘸子（五十岁）', '陈瘸子', '五十岁'],
    ['陈瘸子（五十岁，跛腿老人）', '陈瘸子', '五十岁，跛腿老人'], ['陈瘸子（身份不明）', '陈瘸子', '身份不明'],
    ['陈瘸子（陈守拙、陈先生）', '陈瘸子', '陈守拙、陈先生'], ['陈瘸子（陈守拙/陈先生）', '陈瘸子', '陈守拙/陈先生'],
    ['陈瘸子（陈守拙（陈先生））', '陈瘸子', '陈守拙（陈先生）'], ['陈瘸子（）', '陈瘸子', ''], ['甲（乙）', '甲', '乙'],
  ]) {
    const { evidence } = fixture([{ text: `${target}在场。`, names: [target] }])
    assert.equal(evidence.coversDirectoryName({ name: outer, aliases: [inner], section_ids: [0] }, target), false, target)
  }
  const { evidence } = fixture([{ text: `${label}在场。`, names: ['陈瘸子'] }])
  assert.equal(evidence.coversDirectoryName(character(), label), false, 'the composite must be an actual directory target')
})

test('other missing characters remain missing and invented aliases still fail their individual evidence gate', () => {
  const { state, source, evidence } = fixture([{ text: `${label}和沈知意在场。`, names: [label, '沈知意'] }])
  assert.deepEqual(missingSourceStoryNames(state, story([character()]), source), ['沈知意'])
  assert.throws(() => validateSourceStory(state, story([character()]), source), /沈知意/)
  assert.equal(evidence.supports('凯恩大班', [0]), false)
})

test('long-source task coverage, later targeted context and final coverage accept the same unchanged model record', async () => {
  const { state, source } = longFixture(), targets = sourceStoryTasks(state), all = charactersFor(state), calls: string[] = []
  let targeted = 0
  const output = await synthesizeSourceStory(state, async prompt => {
    const marker = '【全剧整合资料】\n'
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
      character_context?: unknown; part: { kind: string; key: string; target_names?: string[]; include_additional_characters?: boolean; section_ids?: number[] }
    }
    const part = input.part
    calls.push(part.key)
    if (part.kind === 'overview') return JSON.stringify({ summary: '原稿人物保存信件。', ending: { summary: '故事待续。', section_ids: [29] }, covered_section_ids: state.sections.map((_, id) => id) })
    if (part.kind === 'characters') {
      const entries = part.include_additional_characters ? all : part.target_names!.map(name => name === label ? character([14, 20]) : all.find(entry => entry.name === name)!)
      if (input.character_context && part.target_names!.includes(label)) targeted++
      return JSON.stringify({ characters: entries, ...(input.character_context ? { needs_full_source: false, reason: '' } : {}) })
    }
    if (part.kind === 'timeline') return JSON.stringify({ covered_section_ids: part.section_ids, timeline: [] })
    return JSON.stringify({ [part.kind]: [] })
  }, () => {}, signal(), undefined, 1000, source)
  assert.ok(targeted > 0, 'the complete directory label resolves to the validated seed without forcing another full read')
  assert.deepEqual(sourceStoryTasks(state), targets, 'directory targets and task keys stay exactly unchanged')
  assert.equal(calls.some(key => key.includes('/coverage:')), false)
  assert.deepEqual(output.characters.find(entry => entry.name === '陈瘸子'), character([14, 20]))
  assert.deepEqual(validateSourceStory(state, output, source), output)
})

test('targeted packs use a same-record verified seed and never union two independent people to cover a compound label', () => {
  const { state, source } = longFixture(), entry = character([14, 20])
  const options = { targetNames: [label], seedCharacters: [entry], overview: { summary: '原稿人物保存信件。', ending: { summary: '故事待续。', section_ids: [29] } } }
  const context = buildScriptCharacterSourceContext(state, source, options)
  assert.equal(context.mode, 'targeted')
  for (const name of [label, '陈瘸子', '陈守拙']) assert.ok(context.known_names.includes(name))
  assert.deepEqual(context.identity_hypotheses, [entry])
  assert.ok(context.source_ranges.some(range => range.content.includes(label)))
  for (const seedCharacters of [[{ ...entry, aliases: [] }], [{ ...entry, aliases: [] }, { ...entry, name: '陈守拙', aliases: [] }]]) {
    assert.equal(buildScriptCharacterSourceContext(state, source, { ...options, seedCharacters }).mode, 'full')
  }
})

test('short-source character graph and saved-story revalidation retain a valid split representation with zero model calls', async () => {
  const { state, source } = fixture([{ text: `${label}保留原有身份。`, names: [label] }])
  const candidate = story([character()]), never = async () => { throw new Error('must not call a model') }
  assert.deepEqual(await repairSourceStoryCharacters(state, candidate, source, never, { signal: signal() }), candidate)
  state.story = structuredClone(candidate)
  assert.deepEqual(await synthesizeSourceStory(state, never, () => {}, signal(), undefined, 1000, source), candidate)
  prepareSourceWork(source.content, state)
  assert.deepEqual(state.story, candidate, 'resume preparation must not erase a source-verified story')
})

test('an unsupported extra alias is still rejected by the real long-story validator after composite coverage succeeds', async () => {
  const { state, source } = longFixture()
  let calls = 0
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const marker = '【全剧整合资料】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    if (input.part.kind === 'overview') return JSON.stringify({ summary: '原稿人物保存信件。', ending: { summary: '待续。', section_ids: [29] }, covered_section_ids: state.sections.map((_, id) => id) })
    calls++
    const entries = charactersFor(state)
    entries.find(entry => entry.name === '陈瘸子')!.aliases.push('凯恩大班')
    return JSON.stringify({ characters: entries })
  }, () => {}, signal(), undefined, 1000, source), /凯恩大班.*没有所引章节/)
  assert.equal(calls, 2)
  assert.equal(state.story, undefined)
})
