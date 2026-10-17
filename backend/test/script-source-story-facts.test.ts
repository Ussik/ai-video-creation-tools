import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'

function knownState(): ScriptSourceAnalysis {
  return { id: 'known-facts', source_version: 'v', model_id: 'text', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    error: null, updated_at: 'now', sections: [
      { offset: 0, length: 9, title: '出发', episode_number: null, summary: '林舟出发。', characters: [{ name: '林舟', description: '主角', evidence: { offset: 0, quote: '林舟出发。' } }], events: [{ summary: '林舟出发', evidence: { offset: 0, quote: '林舟出发。' } }] },
      { offset: 9, length: 12, title: '身份', episode_number: null, summary: '林舟又名阿舟。', characters: [{ name: '阿舟', description: '林舟的别名', evidence: { offset: 9, quote: '林舟又名阿舟。' } }], events: [] },
      { offset: 21, length: 12, title: '归还', episode_number: null, summary: '沈月归还信物。', characters: [{ name: '沈月', description: '妹妹', evidence: { offset: 21, quote: '沈月归还信物。' } }], events: [{ summary: '沈月归还信物', evidence: { offset: 21, quote: '沈月归还信物。' } }] },
    ] }
}
function knownStory(): ScriptSourceStory {
  return { summary: '林舟出发，沈月归还信物。', characters: [
    { name: '林舟', aliases: ['阿舟'], description: '原文明示的同一人物', section_ids: [0, 1] },
    { name: '沈月', aliases: [], description: '归还信物的妹妹', section_ids: [2] },
  ], timeline: [{ summary: '林舟出发', section_ids: [0] }, { summary: '沈月归还信物', section_ids: [2] }],
  threads: [], ending: { summary: '信物归还。', section_ids: [2] }, uncertainties: [] }
}
const signal = () => new AbortController().signal

test('covered_section_ids cannot mask omissions of known names, aliases or event-bearing sections', async t => {
  for (const kind of ['name', 'alias', 'event'] as const) await t.test(kind, async () => {
    const state = knownState(); let calls = 0, saves = 0
    await assert.rejects(synthesizeSourceStory(state, async () => {
      calls++; const story = knownStory()
      if (kind === 'name') story.characters.pop()
      if (kind === 'alias') story.characters[0]!.aliases = []
      if (kind === 'event') story.timeline.pop()
      return JSON.stringify({ covered_section_ids: [0, 1, 2], story })
    }, () => { saves++ }, signal()), kind === 'event' ? /已有关键事件的章节：2/ : kind === 'alias' ? /已有证据的姓名或别名：阿舟/ : /已有证据的姓名或别名：沈月/)
    assert.equal(calls, 2); assert.equal(saves, 0); assert.equal(state.story, undefined)
  })
})

test('one bounded correction can restore known facts while evidence-based aliases need not create duplicate people', async () => {
  const state = knownState(); let calls = 0, saves = 0
  const result = await synthesizeSourceStory(state, async prompt => {
    calls++; const story = knownStory()
    if (calls === 1) story.characters.pop()
    else assert.match(prompt, /沈月/)
    return JSON.stringify({ covered_section_ids: [0, 1, 2], story })
  }, () => { saves++ }, signal())
  assert.equal(calls, 2); assert.equal(saves, 1)
  assert.equal(result.characters.length, 2)
  assert.deepEqual(result.characters[0]!.aliases, ['阿舟'])
  assert.deepEqual(result.timeline.flatMap(event => event.section_ids), [0, 2])
})

test('cached whole-story checkpoints still reject known-fact omissions without making a model call', async () => {
  for (const kind of ['name', 'event'] as const) {
    const state = knownState(); state.story = knownStory()
    if (kind === 'name') state.story.characters.pop()
    else state.story.timeline.pop()
    await assert.rejects(synthesizeSourceStory(state, async () => { assert.fail('invalid saved facts must be rejected before reuse') }, () => {}, signal()), /人物遗漏|时间线遗漏/)
  }
})

test('pure setting material can keep characters and events empty without inventing a plot or ending', async () => {
  const state = knownState()
  state.sections = [{ offset: 0, length: 40, title: '世界规则设定案', episode_number: null, summary: '世界只能通过潮汐传讯；未提供剧情与角色。', characters: [], events: [] }]
  const story: ScriptSourceStory = { summary: '潮汐传讯规则设定案。', characters: [], timeline: [], threads: [],
    ending: { summary: '该资料未提供结局，也未描写已发生的剧情。', section_ids: [0] }, uncertainties: [] }
  const result = await synthesizeSourceStory(state, async () => JSON.stringify({ covered_section_ids: [0], story }), () => {}, signal())
  assert.deepEqual(result.characters, []); assert.deepEqual(result.timeline, [])
  assert.match(result.ending.summary, /未提供结局/)
})

test('name comparison normalizes width and surrounding whitespace while retaining the original display spelling', async () => {
  const state = knownState()
  state.sections[0]!.characters.push({ name: ' Ａｌｉｃｅ ', description: '明确出现的人物', evidence: { offset: 0, quote: 'Alice在场。' } })
  const story = knownStory()
  story.characters.push({ name: 'Alice', aliases: [], description: '原文明示人物', section_ids: [0] })
  const result = await synthesizeSourceStory(state, async () => JSON.stringify({ covered_section_ids: [0, 1, 2], story }), () => {}, signal())
  assert.equal(result.characters.at(-1)!.name, 'Alice')
  assert.equal(state.sections[0]!.characters.at(-1)!.name, ' Ａｌｉｃｅ ')
})
