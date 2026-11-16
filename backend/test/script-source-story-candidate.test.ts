import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'

const source = () => ({ filename: '人物.txt', content: '林舟出发，沈月相送。' })
const state = (): ScriptSourceAnalysis => ({ id: 'candidate', source_version: 'v1', model_id: 'model', configuration_hash: 'config',
  status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now',
  sections: [{ offset: 0, length: source().content.length, title: '出发', episode_number: null, summary: '林舟出发，沈月相送。',
    characters: ['林舟', '沈月'].map(name => ({ name, description: '原文人物', evidence: { offset: 0, quote: source().content } })),
    events: [{ summary: '出发相送', evidence: { offset: 0, quote: source().content } }] }] })
function story(complete = false): ScriptSourceStory {
  return { summary: '出发时的相送。', characters: (complete ? ['林舟', '沈月'] : ['林舟']).map(name =>
    ({ name, aliases: [], description: name + '在出发现场。', section_ids: [0] })),
    timeline: [{ summary: '林舟出发，沈月相送。', section_ids: [0] }], threads: [],
    ending: { summary: '出发。', section_ids: [0] }, uncertainties: [] }
}
const response = (complete = false) => JSON.stringify({ covered_section_ids: [0], story: story(complete) })
const signal = () => new AbortController().signal

test('complete upstream output survives a storage interruption before the parsed candidate is saved', async () => {
  const current = state(); let durable = structuredClone(current), calls = 0
  await assert.rejects(synthesizeSourceStory(current, async () => { calls++; return response(true) }, () => {
    if (current.story_candidate?.result) throw new Error('candidate storage interrupted')
    durable = structuredClone(current)
  }, signal(), undefined, undefined, source()), /storage interrupted/)
  assert.ok(durable.story_candidate?.output_checkpoint?.raw)
  assert.equal(durable.story_candidate?.result, undefined)
  assert.equal(durable.story, undefined)
  const result = await synthesizeSourceStory(durable, async () => { assert.fail('complete raw output must replay without dispatch') },
    () => {}, signal(), undefined, undefined, source())
  assert.equal(calls, 1)
  assert.deepEqual(result, story(true))
  assert.equal(durable.story_candidate, undefined)
})

test('malformed complete replies are durable and automatic replay never repeats generation or correction', async () => {
  const current = state(); let calls = 0
  const generate = async () => { calls++; return '{unclosed' }
  await assert.rejects(synthesizeSourceStory(current, generate, () => {}, signal(), undefined, undefined, source()), /JSON语法/)
  assert.equal(calls, 1)
  assert.ok(current.story_candidate?.output_checkpoint?.raw)
  assert.equal(current.story_candidate?.output_checkpoint?.correction, undefined)
  await assert.rejects(synthesizeSourceStory(current, generate, () => {}, signal(), undefined, undefined, source()), /JSON语法/)
  assert.equal(calls, 1)
  assert.equal(current.story, undefined)
})

test('source, model, provider configuration and directory changes invalidate a failed private candidate', async t => {
  const failed = state()
  await assert.rejects(synthesizeSourceStory(failed, async (_prompt, contract) => {
    if (contract?.name === 'script_source_story') return response()
    throw new TextProviderError('repair unavailable', false)
  }, () => {}, signal(), undefined, undefined, source()), /repair unavailable/)
  assert.ok(failed.story_candidate?.result)
  assert.equal(failed.story_candidate?.character_repair?.status, 'failed')
  for (const kind of ['source', 'model', 'configuration', 'directory'] as const) await t.test(kind, async () => {
    const current = structuredClone(failed), document = source(); let calls = 0
    if (kind === 'source') document.content += '旅程开始。'
    if (kind === 'model') current.model_id = 'different-model'
    if (kind === 'configuration') current.configuration_hash = 'different-config'
    if (kind === 'directory') current.sections[0]!.summary += '补充目录事实。'
    const result = await synthesizeSourceStory(current, async (_prompt, contract) => {
      calls++; assert.equal(contract?.name, 'script_source_story')
      return response(true)
    }, () => {}, signal(), undefined, undefined, document)
    assert.equal(calls, 1)
    assert.deepEqual(result, story(true))
    assert.equal(current.story_candidate, undefined)
  })
})
