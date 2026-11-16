import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { adjacentSourcePassages, sourceStoryEvidenceInput } from '../src/modules/script/script-source-evidence-input.js'
import { scriptSourcePassages, sourceWorkPlan } from '../src/modules/script/script-source-map.js'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
import { storyPartLocalRepair } from '../src/modules/script/script-source-story-local-repair.js'
import { sourceStructuredPolicy } from '../src/modules/generation/source-structured-policy.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { streamText, type GenerationModel } from '../src/infrastructure/providers/providers.js'
import { structuredOutputStrategy } from '../src/infrastructure/providers/text-output-capability.js'
import { safeModelResult } from '../src/infrastructure/observability/model-results.js'
function fixture() {
  let content = ''
  const state: ScriptSourceAnalysis = { id: 'evidence', source_version: 'v1', model_id: 'fixture', status: 'running', phase: 'synthesis', total_chunks: 1, completed_chunks: 1, sections: [], updated_at: 'now', error: null, analysis_mode: 'extract' }
  for (let id = 0; id < 62; id++) {
    const text = `第${id + 1}集\n` + `${id}号钟只能敲一次，不得提前。`.repeat(30) + '\n', evidence = { offset: content.length, quote: text }
    state.sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: '摘要只用于定位。', characters: [], events: Array.from({ length: 5 }, () => ({ summary: '敲钟前仍须满足限制。', evidence })), open_threads: id === 0 ? ['终章归还信物'] : [] }); content += text
  }
  return { state, source: { filename: 'offline.md', content } }
}
const packet = (prompt: string) => { const marker = '【全剧整合资料】\n'; return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) }
test('chapter input keeps global sentence IDs and current/adjacent text without repeating the whole manuscript', () => {
  const { source } = fixture(), passages = scriptSourcePassages(source.content), work = sourceWorkPlan(passages, true)[2]!, units = adjacentSourcePassages(passages, work).flatMap(p => p.units)
  assert.ok(units.map(u => u.text).join('').length < source.content.length / 2)
  for (const u of units) assert.equal(source.content.slice(u.offset, u.offset + u.text.length), u.text)
  assert.ok(units.some(u => u.offset <= work.offset)); assert.ok(units.some(u => u.offset + u.text.length >= work.offset + work.length))
})
test('evidence pack preserves exact conditions, remote locators and expansion without changing facts', () => {
  const { state, source } = fixture(), before = structuredClone(state), task = { key: 'threads:0', kind: 'threads' as const, section_ids: [0] }
  const initial = sourceStoryEvidenceInput(state, source, task), expanded = sourceStoryEvidenceInput(state, source, task, [61])
  assert.deepEqual(initial.selected_section_ids, [0, 1]); assert.equal(initial.position_index.length, 62); assert.ok(initial.position_index[61]!.event_locators.length)
  assert.equal(expanded.source_ranges.at(-1)!.content, source.content.slice(state.sections[61]!.offset)); assert.match(expanded.source_ranges[0]!.content, /只能敲一次，不得提前/); assert.deepEqual(state, before)
})
test('actual v7 synthesis expands remote evidence once and preserves successful results when another request is unknown', async () => {
  const { state, source } = fixture(), calls: string[] = []; let expansion = 0
  const generate = async (prompt: string) => {
    const input = packet(prompt), key = input.part.key; calls.push(key)
    if (input.evidence_input) {
      assert.equal(input.complete_source, false); assert.equal(input.source.content, undefined); assert.deepEqual(input.materials, [])
      if (key === 'threads:0') {
        if (!input.evidence_input.selected_section_ids.includes(61)) { expansion++; return JSON.stringify({ needs_section_ids: [61], reason: '核对终章回收原文' }) }
        return JSON.stringify({ threads: [{ setup: '首章保留信物', payoff: '终章归还', section_ids: [0, 61] }] })
      }
      if (input.part.kind === 'uncertainties') throw new Error('offline stop')
    }
    return sourceAnalysisFixture(prompt)!
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, new AbortController().signal, undefined, undefined, source), /offline stop/)
  const saved = state.story_work!.tasks.filter(t => t.result !== undefined).map(t => [t.key, structuredClone(t.result)] as const)
  assert.ok(saved.length >= 9); assert.equal(expansion, 1)
  const first = state.story_work!.tasks.find(t => t.key === 'threads:0')!
  assert.deepEqual(first.evidence_expansion!.section_ids, [61]); assert.ok(first.evidence_expansion!.checkpoint.original_raw)
  const count = calls.length
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, new AbortController().signal, undefined, undefined, source))
  assert.equal(calls.length, count)
  for (const [key, result] of saved) assert.deepEqual(state.story_work!.tasks.find(t => t.key === key)!.result, result)
})
test('each list dimension uses one fixed field patch, preserves siblings, and never resends the original source', async () => {
  const item = z.object({ description: z.string(), section_ids: z.array(z.number().int().min(0)).min(1) }).strict()
  for (const field of ['characters', 'timeline', 'threads', 'uncertainties']) {
    const schema = z.object({ [field]: z.array(item) }).strict(), valid = { description: '限制和否定保持原样。', section_ids: [0] }; let calls = 0
    const value = await generateStructuredOutput(`script_source_story_${field}`, schema, async (prompt, contract) => {
      if (++calls === 1) return JSON.stringify({ [field]: [valid, { description: 7, section_ids: [0] }] })
      assert.match(contract!.name, /_local_repair$/); assert.doesNotMatch(prompt, /DO_NOT_RESEND_WHOLE_SOURCE/)
      return JSON.stringify({ repairs: { [`${field}_1`]: { description: '纠正字段类型', section_ids: [0] } } })
    }, 'DO_NOT_RESEND_WHOLE_SOURCE', { ...sourceStructuredPolicy(), localRepairOnly: true, checkpoint: {}, planLocalRepair: storyPartLocalRepair(schema, 1, { source_ranges: ['必要证据'] }) })
    assert.equal(calls, 2); assert.deepEqual(value[field]![0], valid)
  }
})
test('unlocated business errors stop with complete answer retained and zero full corrections', async () => {
  const schema = z.object({ summary: z.string(), threads: z.array(z.string()) }).strict(), checkpoint: any = {}; let calls = 0
  await assert.rejects(generateStructuredOutput('script_source_story', schema, async () => { calls++; return '{"summary":"保存原文","threads":[]}' }, 'source', {
    ...sourceStructuredPolicy(), checkpoint, localRepairOnly: true, validate: () => { throw new Error('unlocated semantic issue') }, planLocalRepair: storyPartLocalRepair(schema, 1, {}) }), /未重发全文/)
  assert.equal(calls, 1); assert.match(checkpoint.original_raw, /保存原文/)
})
for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) test(`${protocol} explicit result tool makes one request and never executes actions`, async t => {
  let calls = 0; let body: any
  const model: GenerationModel = { id: 'tool-' + protocol, remote_id: 'fixture', modality: 'text', protocol, settings: { structured_output_mode: 'tool_call', text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192 } } }
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; body = JSON.parse(String(init?.body)); const name = 'submit_structured_result'
    return Response.json(protocol === 'responses' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'call-fixture', name, arguments: '{"ok":true}' }] }
      : protocol === 'chat_completions' ? { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name, arguments: '{"ok":true}' } }] } }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'call-fixture', name, input: { ok: true } }], stop_reason: 'tool_use' })
  })
  const provider = { adapter: 'http' as const, base_url: 'https://offline-tool.invalid/v1' }
  assert.equal(structuredOutputStrategy(model, provider).enforcement, 'unverified')
  assert.deepEqual(await generateStructuredOutput('offline_tool_result', z.object({ ok: z.boolean() }).strict(), (prompt, structured_output) => streamText(model, provider, { prompt, structured_output }), 'task'), { ok: true })
  assert.equal(calls, 1); assert.notEqual(body.tool_choice, 'auto'); assert.equal(body.tools.length, 1)
})
test('safe diagnostics include input composition but exclude source content', () => {
  const safe = safeModelResult({ phase: 'structure', status: 'valid', task_key: 'threads:4', input_source_chars: 123, input_index_chars: 45, repair_type: 'syntax_insertions', evidence_expanded: true, source: 'PRIVATE' })!
  assert.equal(safe.input_source_chars, 123); assert.equal(safe.evidence_expanded, true); assert.doesNotMatch(JSON.stringify(safe), /PRIVATE/)
})

test('130 received characters without terminal protocol never become repaired JSON or trigger another request', async t => {
  const partial = '{"threads":[' + '原'.repeat(118)
  assert.equal(partial.length, 130)
  let calls = 0; const metrics: any[] = [], checkpoint: any = {}
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response([
      { type: 'message_start', message: { content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const model: GenerationModel = { id: 'partial130', remote_id: 'fixture', modality: 'text', protocol: 'anthropic_messages', settings: {
    structured_output_mode: 'json_schema', text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 8192 } } }
  const generate = (prompt: string, structured_output: any) => streamText(model, { adapter: 'http', base_url: 'https://offline130.invalid/v1' }, { prompt, structured_output }, undefined, undefined, undefined, value => metrics.push(value))
  const schema = z.object({ threads: z.array(z.string()) }).strict()
  await assert.rejects(generateStructuredOutput('script_source_story_threads', schema, generate, 'source', { ...sourceStructuredPolicy(true), guardInitialDispatch: true, checkpoint }))
  assert.equal(calls, 1); assert.equal(checkpoint.raw, undefined); assert.ok(checkpoint.initial_started)
  assert.equal(metrics[0].response_chars, 130); assert.equal(metrics[0].response_complete, false); assert.equal(metrics[0].delivery, 'output_started')
  await assert.rejects(generateStructuredOutput('script_source_story_threads', schema, generate, 'source', { ...sourceStructuredPolicy(true), guardInitialDispatch: true, checkpoint }))
  assert.equal(calls, 1)
})

test('new task ambiguous syntax never purchases a model syntax approval or full rewrite', async () => {
  let calls = 0
  await assert.rejects(generateStructuredOutput('script_source_story_threads', z.object({ threads: z.array(z.object({ setup: z.string() })) }), async () => {
    calls++; return '{"threads":[{"setup":"模糊"引号"且未闭合"}'
  }, 'source', { ...sourceStructuredPolicy(true), localRepairOnly: true, checkpoint: {} }))
  assert.equal(calls, 1)
})

test('complete expansion directive survives a crash and can be retained locally while a sibling remains unknown', async () => {
  const { state, source } = fixture(); let crash: ScriptSourceAnalysis | undefined
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = packet(prompt)
    if (input.part.key === 'threads:0') return JSON.stringify({ needs_section_ids: [61], reason: '需要终章证据' })
    if (input.part.key === 'threads:1') throw new Error('unknown sibling')
    return sourceAnalysisFixture(prompt)!
  }, () => {
    const task = state.story_work?.tasks.find(t => t.key === 'threads:0')
    if (!crash && task?.output_candidate?.checkpoint.original_raw?.includes('needs_section_ids') && !task.evidence_expansion) crash = structuredClone(state)
  }, new AbortController().signal, undefined, undefined, source))
  assert.ok(crash)
  let calls = 0
  await assert.rejects(synthesizeSourceStory(crash!, async () => { calls++; throw new Error('no dispatch allowed') }, () => {}, new AbortController().signal, undefined, undefined, source))
  assert.equal(calls, 0)
  assert.deepEqual(crash!.story_work!.tasks.find(t => t.key === 'threads:0')!.evidence_expansion!.section_ids, [61])
})
