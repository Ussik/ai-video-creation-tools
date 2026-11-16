import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { pauseBeforeStoryRequest } from './support/source-story-pause.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'
import { sourceStoryOutputEstimate, shouldPartitionSourceStory, sourceStoryTasks } from '../src/modules/script/script-source-story-plan.js'

function denseManuscript() {
  const sections: ScriptSourceAnalysis['sections'] = []
  let content = ''
  for (let id = 0; id < 23; id++) {
    const name = `人物${id % 19}`, opening = `第${id + 1}场：${name}调查线索，留下因果，最终回家。`
    const text = opening + '原文事实。'.repeat(150) + '\n'
    const evidence = { offset: content.length, quote: opening }
    sections.push({ offset: content.length, length: text.length, title: `场${id + 1}`, episode_number: id + 1,
      summary: `${name}调查线索，后续保留因果。`, characters: [{ name, description: `${name}是原文人物。`, evidence }],
      events: Array.from({ length: id < 8 ? 3 : 2 }, (_, event) => ({ summary: `${name}完成第${event + 1}项调查`, evidence })),
      open_threads: id < 10 ? [`第${id + 1}场线索有待后文回收`] : [] })
    content += text
  }
  content = content.padEnd(18358, '。')
  sections.at(-1)!.length += content.length - sections.reduce((total, section) => total + section.length, 0)
  const state: ScriptSourceAnalysis = { id: 'dense-short', source_version: 'v1', model_id: 'model', configuration_hash: 'config',
    status: 'running', phase: 'synthesis', total_chunks: 2, completed_chunks: 2, sections, error: null, updated_at: 'now' }
  return { state, source: { filename: 'dense-short.txt', content } }
}
const signal = () => new AbortController().signal
const marker = '【全剧整合资料】\n'
type PartInput = { source: { content: string }; materials: unknown[]; part: { key: string; kind: string; target_names?: string[]; section_ids?: number[] } }
function reply(state: ScriptSourceAnalysis, input: PartInput) {
  const ids = state.sections.map((_, id) => id)
  if (input.part.kind === 'overview') return { summary: '全剧调查后回家。', ending: { summary: '最终回家。', section_ids: [22] }, covered_section_ids: ids }
  if (input.part.kind === 'characters') return { characters: input.part.target_names!.map(name => ({ name, aliases: [], description: `${name}参与调查。`,
    section_ids: state.sections.flatMap((section, id) => section.characters.some(character => character.name === name) ? [id] : []) })) }
  if (input.part.kind === 'timeline') return { covered_section_ids: input.part.section_ids,
    timeline: input.part.section_ids!.map(id => ({ summary: state.sections[id]!.events.map(event => event.summary).join('；'), section_ids: [id] })) }
  if (input.part.kind === 'threads') return { threads: input.part.section_ids!.includes(0) ? [{ setup: '开篇线索。', payoff: '最终解释。', section_ids: [0, 22] }] : [] }
  if (input.part.kind === 'uncertainties') return { uncertainties: [] }
  return assert.fail(`unexpected task ${input.part.kind}`)
}
function completeStory(state: ScriptSourceAnalysis): ScriptSourceStory {
  return { summary: '全剧调查后回家。', characters: [...new Set(state.sections.flatMap(section => section.characters.map(character => character.name)))].map(name =>
    ({ name, aliases: [], description: `${name}参与调查。`, section_ids: state.sections.flatMap((section, id) => section.characters.some(character => character.name === name) ? [id] : []) })),
    timeline: state.sections.map((section, id) => ({ summary: section.events.map(event => event.summary).join('；'), section_ids: [id] })),
    threads: [], ending: { summary: '最终回家。', section_ids: [22] }, uncertainties: [] }
}

test('output density partitions a short manuscript without one model task per section', () => {
  const { state, source } = denseManuscript()
  assert.equal(source.content.length, 18358)
  assert.equal(state.sections.length, 23)
  assert.ok(sourceStoryOutputEstimate(state) > 16000)
  assert.equal(shouldPartitionSourceStory(state, source.content.length), true)
  const tasks = sourceStoryTasks(state)
  assert.ok(tasks.length >= 5 && tasks.length <= 8, 'a dense short script uses bounded dimensions instead of 23 chapter calls')
  const sparse = { ...state, sections: state.sections.map(section => ({ ...section, characters: [], events: [], open_threads: [] })) }
  assert.equal(shouldPartitionSourceStory(sparse, source.content.length), false, 'length and section count alone do not penalize a sparse source')
})

test('dense short synthesis resumes pre-dispatch pauses but protects unknown delivery with all complete subtasks intact', async t => {
  for (const interruption of ['before_dispatch', 'unknown_delivery'] as const) await t.test(interruption, async () => {
    const { state, source } = denseManuscript(), calls = new Map<string, number>()
    const pause = pauseBeforeStoryRequest(state, 'timeline:1', new Error('pre-dispatch test interruption'))
    const originalDirectory = JSON.stringify(state.sections)
    let interrupted = true, durable = structuredClone(state)
    const generate = async (prompt: string, contract?: { name: string }) => {
      assert.notEqual(contract?.name, 'script_source_story', 'do not first risk the large whole-story output')
      const input: PartInput = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.equal(input.source.content, source.content)
      assert.equal(input.materials.length, 23)
      calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
      if (interrupted && interruption === 'unknown_delivery' && input.part.key === 'timeline:1') throw new TextProviderError('terminal stream test interruption', false)
      return JSON.stringify(reply(state, input))
    }
    await assert.rejects(synthesizeSourceStory(state, generate, () => { durable = structuredClone(state); if (interruption === 'before_dispatch') pause() }, signal(), undefined, undefined, source), /test interruption/)
    const completed = durable.story_work!.tasks.filter(task => task.result !== undefined).map(task => task.key)
    assert.ok(completed.includes('overview') && completed.includes('timeline:0'))
    assert.equal(durable.story, undefined)
    assert.equal(durable.story_work!.tasks.find(task => task.key === 'timeline:1')!.result, undefined)
    assert.equal(calls.get('timeline:1'), interruption === 'before_dispatch' ? undefined : 1)
    interrupted = false
    if (interruption === 'unknown_delivery') {
      const before = JSON.stringify([...calls]), snapshot = structuredClone(durable.story_work)
      await assert.rejects(synthesizeSourceStory(durable, generate, () => {}, signal(), undefined, undefined, source), error =>
        (error as { code?: string }).code === 'structured_initial_delivery_pending')
      assert.equal(JSON.stringify([...calls]), before)
      for (const task of snapshot!.tasks.filter(task => task.result !== undefined)) {
        assert.deepEqual(durable.story_work!.tasks.find(item => item.key === task.key)!.result, task.result)
      }
      assert.ok(durable.story_work!.tasks.find(task => task.key === 'timeline:1')!.output_candidate!.checkpoint.initial_started)
      assert.equal(JSON.stringify(durable.sections), originalDirectory)
      return
    }
    const result = await synthesizeSourceStory(durable, generate, () => {}, signal(), undefined, undefined, source)
    for (const key of completed) assert.equal(calls.get(key), 1, `${key} must not generate again`)
    assert.equal(calls.get('timeline:1'), 1)
    assert.equal(result.characters.length, 19)
    assert.equal(result.timeline.length, 23)
    assert.equal(durable.story_work, undefined)
    assert.equal(JSON.stringify(durable.sections), originalDirectory)
  })
})

for (const stored of ['result', 'raw'] as const) test(`new density routing preserves a compatible complete whole-story ${stored}`, async () => {
  let { state, source } = denseManuscript()
  const story = completeStory(state)
  const result = { covered_section_ids: state.sections.map((_, id) => id), story }
  const input_hash = createHash('sha256').update(JSON.stringify(['short-source-story-v1', state.source_version, state.model_id,
    state.configuration_hash, source, state.sections])).digest('hex')
  state.story_candidate = { input_hash, ...(stored === 'result' ? { result } : { output_checkpoint: { raw: 'legacy checkpoint seed' } }) }
  if (stored === 'raw') {
    // Let the production output layer bind the exact contract/prompt hash, then
    // interrupt before parsing so the resumed fixture is a genuine raw cache.
    let saved: ScriptSourceAnalysis | undefined, initialCalls = 0
    await assert.rejects(synthesizeSourceStory(state, async () => { initialCalls++; return JSON.stringify(result) }, () => {
      if (state.story_candidate?.output_checkpoint?.raw?.startsWith('{')) { saved = structuredClone(state); throw new Error('raw checkpoint storage interruption') }
    }, signal(), undefined, undefined, source), /检查点保存失败/)
    assert.equal(initialCalls, 1)
    assert.ok(saved?.story_candidate?.output_checkpoint?.input_hash)
    state = saved!
  }
  const actual = await synthesizeSourceStory(state, async () => assert.fail('completed candidate must replay without new upstream work'), () => {}, signal(), undefined, undefined, source)
  assert.deepEqual(actual, story)
  assert.equal(state.story_work, undefined)
  assert.equal(state.story_candidate, undefined)
})
