import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { createAutomaticOutputRecovery, reserveAutomaticOutputRecovery, withAutomaticOutputRecovery, independentOutputFailure } from '../src/modules/generation/automatic-output-recovery.js'
import { sourceStructuredPolicy } from '../src/modules/generation/source-structured-policy.js'
import { createSourceCharacterEvidence } from '../src/modules/script/script-source-character-evidence.js'
import { splitSourceStoryScope, retainSourceScopeTransfers } from '../src/modules/script/script-source-story-scope-transfer.js'
import { recoverUniqueQuotedLines, reasonedQuotedLineRepair } from '../src/modules/generation/model-output-syntax-repair.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import type { StructuredOutputCheckpoint } from '../src/modules/generation/model-output-checkpoints.js'
import { settleBounded } from '../src/modules/script/script-bounded-parallel.js'
import { scriptSourcePassages, resolveSourceSections, workPassages } from '../src/modules/script/script-source-map.js'
import { recoverSourceHeadingTail, sourceTransferredPlan } from '../src/modules/script/script-source-page-transfer.js'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

test('local-only output retains fixed syntax planner; unowned syntax fails preflight', () => {
  const raw = '{\n "summary": "实行"全要素重置",保持原文"\n}'
  const plan = sourceStructuredPolicy(true).planSyntaxRepair(raw)
  assert.ok(plan)
  const corrected = ' "summary": "实行\\"全要素重置\\",保持原文"'
  const result = plan.apply({ candidate_hash: /"candidate_hash":"([a-f0-9]+)"/.exec(plan.prompt)![1], repairs: { line_0: { line: corrected, reason: '仅转义正文原引号' } } })
  assert.deepEqual(result, { summary: '实行"全要素重置",保持原文' })
  assert.equal(reasonedQuotedLineRepair(raw.replace('\n}', '\n "events": []\n}')), undefined)
})

test('fresh syntax error automatically receives bounded patch, with raw bytes retained', async () => {
  const raw = '{\n "summary": "原文"台词",继续"\n}'
  const cp: StructuredOutputCheckpoint = {}, budget = createAutomaticOutputRecovery()
  let calls = 0
  const value = await withAutomaticOutputRecovery(budget, () => {}, () => generateStructuredOutput('automatic_fixture', z.object({ summary: z.string() }), async (prompt) => {
    calls++
    if (calls === 1) return raw
    const hash = /"candidate_hash":"([a-f0-9]+)"/.exec(prompt)![1]
    return JSON.stringify({ candidate_hash: hash, repairs: { line_0: { line: ' "summary": "原文\\"台词\\",继续"', reason: '只转义原正文引号' } } })
  }, 'fixture', { ...sourceStructuredPolicy(true), localRepairOnly: true, checkpoint: cp, persistCheckpoint: () => {} }))
  assert.equal(calls, 2); assert.equal(value.summary, '原文"台词",继续')
  assert.equal(cp.original_raw, raw); assert.equal(budget.requests.length, 1)
  assert.equal(budget.requests[0]!.status, 'completed')
})

test('recovery limits survive serialization; identical requests never repeat', () => {
  const saved = createAutomaticOutputRecovery(); saved.max_task_requests = 1
  withAutomaticOutputRecovery(saved, () => {}, () => reserveAutomaticOutputRecovery('task', 'patch', {}, false)!('response'))
  const restored = JSON.parse(JSON.stringify(saved))
  withAutomaticOutputRecovery(restored, () => {}, () => {
    assert.throws(() => reserveAutomaticOutputRecovery('task', 'different patch', {}, false), /预算/)
    assert.throws(() => reserveAutomaticOutputRecovery('task', 'patch', {}, false), /相同/)
  })
  assert.equal(restored.requests.length, 1)
})

test('unknown correction never dispatches through automatic recovery', async () => {
  const cp: StructuredOutputCheckpoint = {}
  let calls = 0
  const budget = createAutomaticOutputRecovery()
  const run = () => withAutomaticOutputRecovery(budget, () => {}, () => generateStructuredOutput('automatic_unknown_fixture', z.object({ summary: z.string() }), async () => {
    calls++
    if (calls === 1) return '{\n "summary": "正文"引号",继续"\n}'
    throw Object.assign(new Error('unknown accepted delivery'), { delivery: 'unknown' })
  }, 'fixture', { ...sourceStructuredPolicy(true), checkpoint: cp, persistCheckpoint: () => {} }))
  await assert.rejects(run()); assert.ok(cp.correction_started)
  await assert.rejects(run()); assert.equal(calls, 2); assert.equal(budget.requests.length, 1)
})

test('independent validation failures do not stop siblings; unknown delivery does', async () => {
  const seen: number[] = []
  const result = await settleBounded([0,1,2], 1, undefined, async n => {
    seen.push(n); if (n === 0) throw Object.assign(new Error('format'), { statusCode: 422 }); return n
  }, independentOutputFailure)
  assert.deepEqual(seen, [0,1,2]); assert.equal(result[2]!.status, 'fulfilled')
  seen.length = 0
  await settleBounded([0,1,2], 1, undefined, async n => {
    seen.push(n); throw Object.assign(new Error('pending'), { statusCode: 422, delivery: 'unknown' })
  }, independentOutputFailure)
  assert.deepEqual(seen, [0])
})

test('heading-only tail transfers intact, preserves strict evidence and replayable plan', () => {
  const content = '原文设定。\n## 总纲\n\n### 第一篇章\n\n第1集\n许知夜登车。\n林清晏递铁律。\n'
  const passages = scriptSourcePassages(content), units = passages.flatMap(p => p.units)
  const heading = units.find(u => u.text.startsWith('## 总纲'))!, episode = units.find(u => u.text.startsWith('第1集'))!, event = units.find(u => u.text.startsWith('许知夜'))!
  const section = { title: '设定', start_unit: 0, summary: '原文设定', episode_number: null, characters: [], events: [], open_threads: [], continues_previous: false }
  const tail = { ...section, title: '篇章开篇', start_unit: heading.id, summary: '许知夜登车', events: [{ summary: '许知夜登车', evidence: { unit_id: event.id } }] }
  const plan = [{ offset: 0, length: episode.offset, depth: 0 }, { offset: episode.offset, length: content.length - episode.offset, depth: 0 }]
  const state = { id: 'fixture', source_version: 'fixture', model_id: 'fixture', status: 'running', completed_chunks: 0, total_chunks: 2, sections: [], error: null, updated_at: '', work: [{ ...plan[0]!, result: { sections: [section, tail] } }, { ...plan[1]! }] } as ScriptSourceAnalysis
  assert.equal(recoverSourceHeadingTail(state, passages, sections => JSON.stringify(sections), () => {}), true)
  assert.equal(state.work![0]!.length, heading.offset); assert.equal(state.work![1]!.offset, heading.offset)
  assert.deepEqual(state.work![1]!.output_checkpoint!.seed!.sections, [tail])
  assert.deepEqual(sourceTransferredPlan(plan, state, passages).map(p => [p.offset,p.length]), state.work!.map(p => [p.offset,p.length]))
  const resolved = resolveSourceSections({ sections: [tail] }, workPassages(passages, state.work![1]!), passages)
  assert.equal(resolved.problems.length, 0)
  assert.deepEqual((state.map_page_transfers![0]!.candidate as { sections: unknown[] }).sections, [section,tail])
  assert.equal(recoverSourceHeadingTail(state, passages, () => '', () => {}), false)
})


test('partial patch automatically narrows remaining targets; correct sibling stays frozen', async () => {
  const cp: StructuredOutputCheckpoint = {}, budget = createAutomaticOutputRecovery()
  const schema = z.object({ a: z.number(), b: z.number() })
  let calls = 0
  const value = await withAutomaticOutputRecovery(budget, () => {}, () => generateStructuredOutput('automatic_partial_fixture', schema, async () => {
    calls++
    return calls === 1 ? '{"a":"1","b":"2"}' : calls === 2 ? '{"repairs":{"a":1}}' : '{"repairs":{"b":2}}'
  }, 'fixture', { checkpoint: cp, persistCheckpoint: () => {}, freezeCorrection: true, localRepairOnly: true,
    planLocalRepair: candidate => {
      const base = candidate as { a: unknown; b: unknown }, keys = (['a','b'] as const).filter(k => typeof base[k] !== 'number')
      if (!keys.length) return undefined
      return { schema: z.object({ repairs: z.record(z.string(), z.number()) }), prompt: JSON.stringify({ keys, base }),
        apply: patch => {
          const repairs = (patch as { repairs: Record<string,number> }).repairs, result = { ...base }
          const retained: string[] = [], remaining: string[] = []
          for (const key of keys) if (typeof repairs[key] === 'number') { result[key] = repairs[key]; retained.push(key) } else remaining.push(key)
          if (remaining.length) throw Object.assign(new Error('remaining fixed targets'), { retained_candidate: result, failed_target_keys: remaining, retained_target_keys: retained })
          return result
        } }
    } }))
  assert.deepEqual(value, {a:1,b:2}); assert.equal(calls,3); assert.equal(budget.requests.length,2)
  assert.ok(cp.automatic_next); assert.equal(cp.original_raw, '{"a":"1","b":"2"}')
  assert.equal(cp.automatic_next.original_raw, '{"a":1,"b":"2"}')
})

test('nested unknown delivery stays visible to reconciliation', async () => {
  const { sourceCheckpointResponseFact } = await import('../../packages/shared/src/script/script-source-request-recovery.js')
  const parent = { raw: '{}', correction: { input_hash:'parent', raw:'{}' }, automatic_next: { raw:'{}', correction_started: {input_hash:'child'} } }
  assert.equal(sourceCheckpointResponseFact(parent).response,'unknown_response')
  assert.equal(sourceCheckpointResponseFact(parent).correction_unknown,true)
})


test('runtime events survive snapshots, deduplicate polls and never invent reasoning', async () => {
  const { captureSourceRuntimeEvents } = await import('../src/modules/script/script-source-runtime-events.js')
  const state = {id:'fixture',analysis_mode:'extract',status:'running',progress:{stage:'reading',message:'读取原稿'}} as ScriptSourceAnalysis
  captureSourceRuntimeEvents(state,100); captureSourceRuntimeEvents(state,200)
  assert.equal(state.runtime_events!.length,1)
  state.progress={stage:'repairing',message:'自动纠正格式'};captureSourceRuntimeEvents(state,300)
  assert.equal(state.runtime_events![0]!.ended_at,300)
  const restored=JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  restored.status='failed';captureSourceRuntimeEvents(restored,400)
  assert.equal(restored.runtime_events!.at(-2)!.status,'failed')
  assert.equal(restored.runtime_events!.at(-1)!.status,'failed')
  assert.equal(restored.runtime_events!.length,3)
})


test('opening-only presentation fence preserves raw offsets and rejects incomplete JSON', () => {
  const raw = '  ```JSON\n{\n "summary": "原文"台词"继续"\n}  '
  const recovered = recoverUniqueQuotedLines(raw)
  assert.ok(recovered)
  assert.deepEqual(recovered.value, { summary: '原文"台词"继续' })
  assert.ok(recovered.audit.escape_offsets.every(at => raw[at] === '"'))
  assert.equal(recoverUniqueQuotedLines(raw.replace('\n}', '')), undefined)
})

test('occupational directory annotation covers exact cited head without weakening actual alias coverage', () => {
  const content = '金算盲掌柜（黑市沉香当铺主）\n许知夜（林清晏）'
  const evidence = createSourceCharacterEvidence({ sections: [{ offset: 0, length: content.length,
    characters: [{ name: '金算盲掌柜（黑市沉香当铺主）' }, { name: '许知夜（林清晏）' }] }] } as any, { content })
  assert.equal(evidence.coversDirectoryName({ name: '金算盲掌柜', aliases: [], section_ids: [0] }, '金算盲掌柜（黑市沉香当铺主）'), true)
  assert.equal(evidence.coversDirectoryName({ name: '金算盲掌柜', aliases: [], section_ids: [1] }, '金算盲掌柜（黑市沉香当铺主）'), false)
  assert.equal(evidence.coversDirectoryName({ name: '许知夜', aliases: [], section_ids: [0] }, '许知夜（林清晏）'), false)
  assert.equal(evidence.coversDirectoryName({ name: '许知夜', aliases: ['林清晏'], section_ids: [0] }, '许知夜（林清晏）'), true)
})

test('exact sibling transfers survive either completion order, preserve facts and reject ambiguous routing', () => {
  const tasks = [{ key: 'threads:0', kind: 'threads', section_ids: [0] }, { key: 'threads:1', kind: 'threads', section_ids: [1,2] }] as const
  const foreign = { summary: '不得删除或改写的事实', section_ids: [1,2] }, own = { summary: '本批事实', section_ids: [0,2] }
  for (const completed of [true, false]) {
    const state = { sections: [{},{},{}], story_work: { tasks: [{ key: 'threads:0' }, { key: 'threads:1', ...(completed ? { result: { threads: [] } } : {}) }] } } as any
    const result = retainSourceScopeTransfers(state, tasks[0] as any, { threads: [own,foreign] }, tasks as any)
    assert.deepEqual(result, { threads: [own] })
    if (!completed) state.story_work.tasks[1].result = retainSourceScopeTransfers(state, tasks[1] as any, { threads: [] }, tasks as any)
    assert.deepEqual(state.story_work.tasks[1].result, { threads: [foreign] })
    retainSourceScopeTransfers(state, tasks[0] as any, { threads: [own,foreign] }, tasks as any)
    assert.equal(state.story_scope_transfers.length, 1)
    assert.equal(state.story_work.tasks[1].result.threads.length, 1)
  }
  assert.throws(() => splitSourceStoryScope(tasks[0] as any, { threads: [foreign] }, [...tasks, { ...tasks[1], key: 'threads:2' }] as any, 3), /唯一兄弟批次/)
  assert.throws(() => splitSourceStoryScope(tasks[0] as any, { threads: [{ ...foreign, section_ids: [99] }] }, tasks as any, 3), /唯一兄弟批次/)
})
