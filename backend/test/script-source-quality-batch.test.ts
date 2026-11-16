import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
const source = { filename: 'batch-synthetic.txt', content: '林舟守约。\n沈月归还信物。\n二人离开。\n' }
const unit = scriptSourcePassages(source.content).flatMap(item => item.units).find(item => item.text.trim())!
const signal = () => new AbortController().signal
const marker = '【原稿分析质量小批次资料】\n', singleMarker = '【原稿分析定点修补资料】\n'
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
function fixture(count = 3): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'batch', source_version: 'synthetic', model_id: 'synthetic', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    error: null, updated_at: 'now', sections: [{ offset: 0, length: source.content.length, title: '第一集', episode_number: 1, summary: '二人离开。', characters: [], events: [], open_threads: [] }],
    story: { summary: '林舟守约。', characters: [], timeline: [], threads: [], ending: { summary: '二人离开。', section_ids: [0] },
      uncertainties: Array.from({ length: count }, (_, i) => ({ description: `第${i}处关系绝对矛盾。`, section_ids: [0] })) } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: Array.from({ length: count }, (_, i) => ({ kind: 'causality', explanation: `核对第${i}处关系。`, unit_ids: [unit.id],
    assessment: { issue_type: 'open_question', analysis_paths: [`story.uncertainties[${i}].description`], proposition: `第${i}处关系未明。`, impact: { level: 'blocking', section_ids: [0], reason: '需核对。' } } })) }
  return state
}
function items(body: ReturnType<typeof input>, mode = 'modify') {
  return body.findings.map((finding: { finding_index: number; finding_hash: string; analysis_paths: string[] }) => ({ finding_index: finding.finding_index,
    finding_hash: finding.finding_hash, decision: mode === 'retain' ? 'retain_analysis' : 'modify_analysis', reason: '保留直接事实，关系尚未明示。',
    analysis_refs: [{ path: finding.analysis_paths[0] }], source_refs: [{ unit_id: unit.id }], changes: mode === 'retain' ? [] : [{ target: 'story.uncertainties', section_id: null,
      operation: 'replace', index: finding.finding_index, expected: body.story.uncertainties[finding.finding_index], value: { description: `第${finding.finding_index}处事实保留，关系未明，待确认。`, section_ids: [0] } }] }))
}

test('three independent explicit targets use one full-source request, preserve raw and commit an audited chain', async () => {
  const state = fixture(), before = structuredClone(state), responses: string[] = []; let calls = 0
  await repairSourceQuality(source, state, async (prompt, contract) => {
    calls++; assert.equal(contract!.name, 'script_source_quality_repair_batch'); const body = input(prompt)
    assert.equal(body.units.map((u: { text: string }) => u.text).join(''), source.content); assert.equal(body.findings.length, 3)
    assert.equal(prompt.split('【原稿分析质量小批次资料】').length, 2)
    const raw = JSON.stringify({ items: items(body) }); responses.push(raw); return raw
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 3); assert.equal(state.quality_repair_batch, undefined)
  const journal = state.quality_repair_batches![0]!
  assert.equal(journal.checkpoint.original_raw, responses[0]); assert.deepEqual(journal.committed_indices, [0, 1, 2]); assert.deepEqual(journal.validated_indices, [0, 1, 2])
  assert.equal(journal.checkpoint.correction, undefined); assert.equal(state.quality_repair_outputs, undefined)
  assert.deepEqual(state.sections, before.sections); assert.deepEqual(state.story!.ending, before.story!.ending)
  assert.equal(state.quality_repair!.decisions!.length, 3)
  for (let i = 1; i < 3; i++) assert.equal(state.quality_repair!.decisions![i]!.before_hash, state.quality_repair!.decisions![i - 1]!.after_hash)
})

test('partial valid batch keeps later complete members in its original journal and never resends after restart', async () => {
  const state = fixture(); let calls = 0, raw = ''
  await assert.rejects(repairSourceQuality(source, state, async prompt => {
    calls++; const result = items(input(prompt)); result[1]!.finding_hash = 'f'.repeat(64); raw = JSON.stringify({ items: result }); return raw
  }, () => {}, signal()), /本地保留1\/3/)
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.quality_repair_batch!.validated_indices, [0, 2]); assert.deepEqual(state.quality_repair_batch!.invalid_indices, [1])
  assert.deepEqual(state.quality_repair_batch!.committed_indices, [0]); assert.equal(state.quality_repair_batch!.checkpoint.original_raw, raw)
  assert.equal(state.story!.uncertainties[2]!.description, '第2处关系绝对矛盾。')
  const saved = structuredClone(state)
  await assert.rejects(repairSourceQuality(source, saved, async () => { calls++; throw new Error('must not dispatch') }, () => {}, signal()), /本地保留1\/3/)
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(saved), 1); assert.deepEqual(saved.story, state.story)
  assert.equal(saved.quality_repair_batch!.checkpoint.original_raw, raw); assert.equal(saved.quality_repair_batch!.checkpoint.correction_started, undefined)
})

test('a closed direct member of truncated batch output is locally retained with zero whole-package correction', async () => {
  const state = fixture(); let calls = 0, raw = ''
  await assert.rejects(repairSourceQuality(source, state, async prompt => { calls++; raw = '{"items":[' + JSON.stringify(items(input(prompt))[0]) + ',{"finding_index":1'; return raw }, () => {}, signal()), /本地保留1\/3/)
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1); assert.equal(state.quality_repair_batch!.checkpoint.original_raw, raw)
  assert.deepEqual(state.quality_repair_batch!.validated_indices, [0]); assert.equal(state.quality_repair_batch!.checkpoint.correction_request, undefined)
})

test('unknown batch delivery survives restart and a late exact completion may be read locally once', async () => {
  const state = fixture(); let calls = 0, completed = ''
  await assert.rejects(repairSourceQuality(source, state, async prompt => { calls++; completed = JSON.stringify({ items: items(input(prompt)) }); throw new Error('unknown disconnect') }, () => {}, signal()), /unknown disconnect/)
  assert.ok(state.quality_repair_batch!.checkpoint.initial_started); assert.equal(sourceQualityRepairProgress(state), 0)
  await assert.rejects(repairSourceQuality(source, state, async () => { calls++; throw new Error('must not resend') }, () => {}, signal()), /上次初始请求已开始/)
  assert.equal(calls, 1)
  let reads = 0
  const generator = Object.assign(async () => { calls++; throw new Error('must not dispatch') }, { readCompleted: async (_text: string, contract?: { name: string }) => { reads++; assert.equal(contract!.name, 'script_source_quality_repair_batch'); return completed } })
  await repairSourceQuality(source, state, generator, () => {}, signal())
  assert.equal(calls, 1); assert.equal(reads, 1); assert.equal(sourceQualityRepairProgress(state), 3)
  assert.equal(state.quality_repair_batches![0]!.checkpoint.original_raw, completed)
})

test('batch modifies only bound replace targets and cannot accept append, deletion or another finding target', async t => {
  for (const mode of ['append', 'remove', 'other'] as const) await t.test(mode, async () => {
    const state = fixture(2), before = structuredClone(state.story); let calls = 0
    await assert.rejects(repairSourceQuality(source, state, async prompt => {
      calls++; const result = items(input(prompt))
      for (const item of result) {
        if (mode === 'other') item.changes[0]!.index = 99
        else Object.assign(item.changes[0]!, mode === 'append' ? { operation: 'append', index: null, expected: null } : { operation: 'remove', value: null })
      }
      return JSON.stringify({ items: result })
    }, () => {}, signal()), /本地保留0\/2/)
    assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 0); assert.deepEqual(state.story, before)
    assert.equal(state.quality_repair_batch!.checkpoint.correction_request, undefined)
  })
})

test('overlapping targets, different issue types and pre-existing single journals use the original one-item flow', async t => {
  for (const mode of ['overlap', 'type', 'single'] as const) await t.test(mode, async () => {
    const state = fixture(2); let calls = 0
    if (mode === 'overlap') state.quality!.findings[1]!.assessment!.analysis_paths = ['story.uncertainties[0].section_ids']
    if (mode === 'type') state.quality!.findings[1]!.assessment!.issue_type = 'optional_detail'
    if (mode === 'single') state.quality_repair_output = { binding: 'historical', checkpoint: { input_hash: 'historical', initial_started: { input_hash: 'historical' } } }
    state.quality!.input_hash = sourceQualityInputHash(state)
    await assert.rejects(repairSourceQuality(source, state, async (prompt, contract) => { calls++; assert.equal(contract!.name, 'script_source_quality_repair'); assert.ok(prompt.includes(singleMarker)); throw new Error('single flow') }, () => {}, signal()), mode === 'single' ? /检查点与当前问题不匹配|契约身份不匹配|single flow/ : /single flow/)
    assert.equal(state.quality_repair_batch, undefined); assert.equal(calls, mode === 'single' ? 0 : 1)
  })
})


test('provider-time analysis, review or progress drift cannot commit an otherwise valid batch', async t => {
  for (const mode of ['analysis', 'review', 'progress'] as const) await t.test(mode, async () => {
    const state = fixture(), before = structuredClone(state); let calls = 0
    await assert.rejects(repairSourceQuality(source, state, async prompt => {
      calls++; const raw = JSON.stringify({ items: items(input(prompt)) })
      if (mode === 'analysis') state.story!.summary += '外部写入。'
      if (mode === 'review') state.quality!.findings[0]!.explanation += '外部意见。'
      if (mode === 'progress') state.quality_repair!.completed_findings++
      return raw
    }, () => {}, signal()), /请求期间当前分析或质量进度发生变化/)
    assert.equal(calls, 1); assert.deepEqual(state.story!.uncertainties, before.story!.uncertainties)
    assert.equal(state.quality_repair!.decisions, undefined); assert.deepEqual(state.quality_repair_batch!.committed_indices, [])
    assert.ok(state.quality_repair_batch!.checkpoint.original_raw)
  })
})


test('a provider-declared output limit keeps closed members from its exact partial text without another request', async () => {
  const state = fixture(); let calls = 0, raw = ''
  await assert.rejects(repairSourceQuality(source, state, async prompt => {
    calls++; raw = '{"items":[' + JSON.stringify(items(input(prompt))[0]) + ',{"finding_index":1'
    throw new TextOutputLimitError(raw, 'length')
  }, () => {}, signal()), /本地保留1\/3/)
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.quality_repair_batch!.checkpoint.original_raw, raw)
  assert.equal(state.quality_repair_batch!.checkpoint.initial_started, undefined)
  assert.equal(state.quality_repair_batch!.checkpoint.correction_started, undefined)
})
