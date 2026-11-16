import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { generateStructuredOutput, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { reasonedQuotedLineRepair, recoverUniqueQuotedLines } from '../src/modules/generation/model-output-syntax-repair.js'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'
import { compactSourceStoryMaterials } from '../src/modules/script/script-source-story-parts.js'
import { sourceStoryResume } from '../src/modules/script/script-source-story-progress.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const threadsSchema = z.object({ threads: z.array(z.object({ setup: z.string(), payoff: z.string().nullable(), section_ids: z.array(z.number()) }).strict()) }).strict()
const malformed = '{\n "threads": [\n {\n "setup": "主角持有"照夜剑"。",\n "payoff": "终局以"照夜剑"斩敌。",\n "section_ids": [0]\n }\n ]\n}'
const syntax = { recoverUniqueSyntax: true, recoverCompletedSyntax: true, localSyntaxOnly: true, planSyntaxRepair: reasonedQuotedLineRepair, freezeCorrection: true }

test('setup and payoff use insertion-only recovery with null, citations and original text preserved', async () => {
  const cp: StructuredOutputCheckpoint = {}; let calls = 0
  const value = await generateStructuredOutput('script_source_story_threads', threadsSchema, async () => { calls++; return malformed }, 'original', { ...syntax, checkpoint: cp })
  assert.equal(calls, 1)
  assert.equal(cp.original_raw, malformed)
  assert.deepEqual(value.threads[0]!.section_ids, [0])
  assert.equal(value.threads[0]!.setup, '主角持有"照夜剑"。')
  assert.equal(value.threads[0]!.payoff, '终局以"照夜剑"斩敌。')
  assert.equal(recoverUniqueQuotedLines(malformed.replace('"payoff": "终局以"照夜剑"斩敌。"', '"payoff": null'))?.value !== undefined, true)
  assert.equal(recoverUniqueQuotedLines(malformed.replace('照夜剑"。', '照夜剑",。')), undefined)
})

test('an exact spent full-schema correction can be normalized locally, never redispatched or rewritten', async () => {
  const cp: StructuredOutputCheckpoint = {}; let calls = 0
  await assert.rejects(generateStructuredOutput('script_source_story_threads', threadsSchema, async () => { calls++; return malformed }, 'original', { checkpoint: cp, freezeCorrection: true }))
  assert.equal(calls, 2)
  const correction = structuredClone(cp.correction), frozen = structuredClone(cp.correction_request), marker = structuredClone(cp.correction_started)
  const value = await generateStructuredOutput('script_source_story_threads', threadsSchema, async () => assert.fail('saved correction must not dispatch'), 'original', { ...syntax, checkpoint: cp, completedOnly: true })
  assert.equal(value.threads[0]!.setup, '主角持有"照夜剑"。')
  assert.deepEqual(cp.correction, correction); assert.deepEqual(cp.correction_request, frozen); assert.deepEqual(cp.correction_started, marker)
  assert.equal(cp.original_raw, malformed)
})

test('unknown correction markers cannot be bypassed by a complete malformed original', async () => {
  const cp: StructuredOutputCheckpoint = {}
  await assert.rejects(generateStructuredOutput('script_source_story_threads', threadsSchema, async (_p, contract) => {
    if (contract?.name.endsWith('_local_repair')) throw new Error('unknown correction')
    return malformed
  }, 'original', { checkpoint: cp, freezeCorrection: true, planSyntaxRepair: reasonedQuotedLineRepair }), /unknown correction/)
  const before = structuredClone(cp)
  await assert.rejects(generateStructuredOutput('script_source_story_threads', threadsSchema, async () => assert.fail('no paid recovery'), 'original', { ...syntax, checkpoint: cp, completedOnly: true }))
  assert.deepEqual(cp, before)
})

function fixture() {
  const state: ScriptSourceAnalysis = { id: 'story-syntax', source_version: 'v1', model_id: 'offline', status: 'running', phase: 'synthesis',
    sections: [], total_chunks: 1, completed_chunks: 1, updated_at: 'now', error: null, analysis_mode: 'extract' }
  let content = ''
  for (let id = 0; id < 24; id++) {
    const text = `第${id + 1}集\n主角持有"照夜剑"，终局以"照夜剑"斩敌。\n` + '原文叙事。'.repeat(300) + '\n'
    state.sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1,
      summary: '主角持剑。', characters: [], events: Array.from({ length: 4 }, () => ({ summary: '主角持剑斩敌。', evidence: { offset: content.length, quote: text.slice(0, 20) } })), open_threads: [] })
    content += text
  }
  return { state, source: { filename: 'offline.md', content } }
}

test('partitioned synthesis saves recovered threads and audits through the actual pipeline with compact fresh context', async () => {
  const { state, source } = fixture(); let calls = 0, total = 0, policy: string | undefined
  const sections = structuredClone(state.sections)
  await synthesizeSourceStory(state, async (prompt, contract) => {
    calls++; assert.doesNotMatch(contract?.name || '', /local_repair/)
    const marker = '【全剧整合资料】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    if (input.evidence_input) { assert.equal(input.source.content, undefined); assert.ok(input.evidence_input.source_ranges.length) }
    else assert.equal(input.source.content, source.content)
    if (input.part.kind === 'threads') {
      const value = { threads: [{ setup: '主角持有"照夜剑"。', payoff: '终局以"照夜剑"斩敌。', section_ids: [input.part.section_ids[0]] }] }
      return JSON.stringify(value, null, 2).replaceAll('\\"', '"')
    }
    return sourceAnalysisFixture(prompt)!
  }, () => { total = Math.max(total, state.story_work?.tasks.length || 0); policy ||= state.story_work?.policy }, new AbortController().signal, undefined, undefined, source)
  assert.ok(state.story?.threads.length)
  assert.ok(state.story_syntax_repairs?.some(item => item.task_key.startsWith('threads:')))
  assert.deepEqual(state.sections, sections)
  assert.equal(calls, total)
  assert.equal(policy, 'source-story-v7')
})

test('compact context is a new projection, preserves locator facts and excludes quarantined knowledge', () => {
  const { state } = fixture()
  const materials = state.sections.map((section, id) => ({ covered_section_ids: [id], section: { ...section, id,
    knowledge_pending: [{ raw: 'NOT_CONFIRMED' }], knowledge: [{ redundant: true }] } }))
  const before = structuredClone(materials), compact = compactSourceStoryMaterials(materials)
  assert.deepEqual(materials, before)
  assert.ok(JSON.stringify(compact).length < JSON.stringify(materials).length)
  assert.doesNotMatch(JSON.stringify(compact), /NOT_CONFIRMED|"knowledge"/)
  assert.deepEqual(compact.map(x => x.section.id), materials.map(x => x.section.id))
})

test('mixed pending failures explain unknown and exhausted siblings together without granting another request', () => {
  const { state } = fixture()
  state.story_work = { input_hash: 'old', tasks: [
    { key: 'threads:3', output_candidate: { context_hash: 'unknown', checkpoint: { initial_started: { input_hash: 'unknown' } } }, failure: { message: '连接中断' } },
    { key: 'threads:4', output_candidate: { context_hash: 'spent', checkpoint: { raw: malformed, correction: { input_hash: 'spent', raw: malformed } } }, failure: { code: 'model_json_syntax', message: 'setup引号错误' } },
  ] }
  const before = structuredClone(state), resume = sourceStoryResume(state)!
  assert.equal(resume.action, 'reconcile_request'); assert.equal(resume.available, false)
  assert.match(resume.message, /threads:3：请求结果未知/)
  assert.match(resume.message, /threads:4：完整纠正回答格式或引用未通过/)
  assert.deepEqual(state, before)
})

test('serial and parallel resumes recover a saved sibling without dispatching unknown or queued tasks', async () => {
  const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
  const { createHash } = await import('node:crypto')
  const { state, source } = fixture()
  const contracts = new Map<string, any>(), scopedIds = new Map<string, number>()
  await assert.rejects(synthesizeSourceStory(state, async (prompt, contract) => {
    const marker = '【全剧整合资料】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    if (input.part.kind === 'threads') {
      contracts.set(input.part.key, structuredClone(contract)); scopedIds.set(input.part.key, input.part.section_ids[0])
      const issue = new TextProviderError('recorded incomplete response', false, 'connection_error')
      issue.delivery = input.part.key === 'threads:0' ? 'output_started' : 'completed'
      throw issue
    }
    return sourceAnalysisFixture(prompt)!
  }, () => {}, new AbortController().signal, undefined, undefined, source))
  const saved = state.story_work!.tasks.find(t => t.key === 'threads:1')!
  assert.ok(saved?.output_candidate, 'fixture must have two concurrent thread windows')
  const cp = saved.output_candidate.checkpoint
  const raw = malformed.replace('[0]', JSON.stringify([scopedIds.get('threads:1')]))
  const prompt = 'exact frozen recorded full-schema correction', contract = contracts.get('threads:1')
  const correctionHash = createHash('sha256').update(JSON.stringify([prompt, contract])).digest('hex')
  Object.assign(cp, { raw, original_raw: raw, correction_request: { base_input_hash: cp.input_hash!, input_hash: correctionHash, prompt, contract },
    correction_started: { input_hash: correctionHash }, correction: { input_hash: correctionHash, raw } })
  saved.failure = { code: 'model_json_syntax', message: 'recorded setup quote failure' }
  saved.output_candidate.replay_version = 1
  const before = structuredClone(state)
  for (const concurrency of ['1', '2']) {
    const previous = process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
    process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = concurrency
    try {
      const replay = structuredClone(before), unknown = structuredClone(replay.story_work!.tasks.find(t => t.key === 'threads:0'))
      let calls = 0
      await assert.rejects(synthesizeSourceStory(replay, async () => { calls++; assert.fail('no new paid request is allowed') },
        () => {}, new AbortController().signal, undefined, undefined, source), /请求结果尚未确认/)
      assert.equal(calls, 0)
      assert.ok(replay.story_work!.tasks.find(t => t.key === 'threads:1')!.result)
      assert.deepEqual(replay.story_work!.tasks.find(t => t.key === 'threads:0'), unknown)
      for (const task of before.story_work!.tasks.filter(t => t.result !== undefined))
        assert.deepEqual(replay.story_work!.tasks.find(t => t.key === task.key), task)
      assert.deepEqual(replay.story_work!.tasks.filter(t => t.key.startsWith('uncertainties:')),
        before.story_work!.tasks.filter(t => t.key.startsWith('uncertainties:')))
    } finally {
      if (previous === undefined) delete process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
      else process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = previous
    }
  }
})

test('source synthesis list continuation applies the same setup/payoff recovery without another request', async () => {
  const { generatePagedReviewItems } = await import('../src/modules/script/script-review-pagination.js')
  let calls = 0
  const items = await generatePagedReviewItems({ id: 'thread-page', name: 'script_source_story_threads',
    purpose: 'generation', itemSchema: threadsSchema.shape.threads.element, prompt: '完整原稿', maxItems: 10, syntaxRecovery: true,
    generate: async () => {
      calls++
      return '{\n "items": [\n {\n "setup": "主角持有"照夜剑"。",\n "payoff": null,\n "section_ids": [0]\n }\n ],\n "complete": true\n}'
    } })
  assert.equal(calls, 1); assert.equal(items[0]!.setup, '主角持有"照夜剑"。'); assert.equal(items[0]!.payoff, null)
})
