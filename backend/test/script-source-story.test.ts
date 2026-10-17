import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'
function snapshot(): ScriptSourceAnalysis {
  return { id: 'map', source_version: 'v', model_id: 'text', status: 'running', phase: 'synthesis', completed_chunks: 3, total_chunks: 3, error: null, updated_at: 'now',
    sections: Array.from({ length: 40 }, (_, id) => ({ offset: id * 1200, length: 1200, title: `场${id}`, episode_number: null, summary: `事件${id}：${'剧情事实'.repeat(120)}`, characters: [], events: [] })) }
}
function story(prompt: string) {
  const marker = '【全剧整合资料】\n'
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
  const ids: number[] = input.materials.flatMap((item: { covered_section_ids: number[] }) => item.covered_section_ids)
  return { covered_section_ids: ids, story: { summary: '主角找到同伴并回家。', characters: [{ name: '林舟', aliases: ['阿舟'], description: '主角的原文明示别名', section_ids: [ids[0]] }],
    timeline: [{ summary: '找到同伴', section_ids: [ids[0]] }], threads: [{ setup: '失落的信物', payoff: ids.includes(39) ? '终场归还' : null, section_ids: [ids.at(-1)] }],
    ending: { summary: ids.includes(39) ? '全剧结局：林舟回家。' : '本批结束时尚未到结局。', section_ids: [ids.at(-1)] }, uncertainties: [] } }
}
test('whole-story synthesis sees all chapters and source together without grouped reductions', async () => {
  const state = snapshot(); let calls = 0, saves = 0
  const source = { filename: '全文.txt', content: `${'完整故事。'.repeat(4000)}全剧结尾事实。` }
  const result = await synthesizeSourceStory(state, async prompt => {
    calls++; assert.ok(prompt.length > 26000)
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('【全剧整合资料】\n') + '【全剧整合资料】\n'.length))
    assert.equal(input.materials.length, state.sections.length)
    assert.equal(input.source.content, source.content)
    return JSON.stringify(story(prompt))
  }, () => { saves++ }, new AbortController().signal, undefined, undefined, source)
  assert.equal(calls, 1)
  assert.equal(state.synthesis, undefined); assert.match(result.ending.summary, /全剧结局/)
  assert.deepEqual(result.characters[0].aliases, ['阿舟']); assert.equal(saves, 1)
  await synthesizeSourceStory(state, async () => { throw new Error('completed full story must reuse') }, () => {}, new AbortController().signal)
})
test('interrupted synthesis retries the entire story and discards legacy grouped summary checkpoints', async () => {
  const state = snapshot()
  state.synthesis = { level: 2, cursor: 1, inputs: [{ covered_section_ids: [0] }], outputs: [] }
  await assert.rejects(synthesizeSourceStory(state, async () => { throw new Error('暂时中断') }, () => {}, new AbortController().signal), /中断/)
  assert.equal(state.synthesis, undefined)
  let resumed = 0
  await synthesizeSourceStory(state, async prompt => {
    resumed++; assert.equal(story(prompt).covered_section_ids.length, state.sections.length)
    return JSON.stringify(story(prompt))
  }, () => {}, new AbortController().signal)
  assert.equal(resumed, 1)
})
test('omitted coverage and invented provenance stop synthesis after one bounded correction', async () => {
  for (const kind of ['coverage', 'reference']) {
    const state = snapshot(); let calls = 0
    await assert.rejects(synthesizeSourceStory(state, async prompt => {
      calls++; const value = story(prompt)
      if (kind === 'coverage') value.covered_section_ids.pop()
      else value.story.ending.section_ids = [999]
      return JSON.stringify(value)
    }, () => {}, new AbortController().signal), /覆盖全剧全部章节|不存在/)
    assert.equal(calls, 2); assert.equal(state.story, undefined)
  }
})
