import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
const source = { filename: 'decision-synthetic.txt', content: '林舟早年随师傅练过站桩。\n今日林舟正式拜师。\n受击后进度增加，触发关系未明。\n' }
const unit = scriptSourcePassages(source.content).flatMap(item => item.units).find(item => item.text.trim())!
const signal = () => new AbortController().signal
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const marker = '【原稿分析定点修补资料】\n'
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
function fixture(): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'decision', source_version: 'synthetic', model_id: 'synthetic', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    error: null, updated_at: 'now', sections: [{ offset: 0, length: source.content.length, title: '第一集', episode_number: 1, summary: '林舟拜师。', characters: [], events: [], open_threads: [] }],
    story: { summary: '林舟早年练过站桩，今日正式拜师。', characters: [], timeline: [], threads: [], ending: { summary: '受击后进度增加。', section_ids: [0] },
      uncertainties: [{ description: '受击也增加进度，绝对矛盾，必须补写解释。', section_ids: [0] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: 'causality', explanation: '保留观察事实，触发条件未知。', unit_ids: [unit.id],
    assessment: { issue_type: 'open_question', analysis_paths: ['story.uncertainties[0].description'], proposition: '触发条件未知。', impact: { level: 'blocking', section_ids: [0], reason: '需确认后续动作。' } } }] }
  return state
}
const decision = (body: ReturnType<typeof input>, overrides: Record<string, unknown> = {}) => ({ decision: 'retain_analysis', finding_hash: body.finding_hash,
  reason: '原文保留两处事实，触发关系仍然未知。', changes: [], analysis_refs: [{ path: 'story.uncertainties[0].description' }], source_refs: [{ unit_id: unit.id }], ...overrides })

test('retain is bound to the exact finding, current value and real source evidence while unknowns remain intact', async () => {
  const state = fixture(), before = structuredClone(state.story)
  await repairSourceQuality(source, state, async prompt => JSON.stringify(decision(input(prompt))), () => {}, signal())
  const audit = state.quality_repair!.decisions![0]!
  assert.equal(audit.decision, 'retain_analysis'); assert.equal(audit.finding_hash, digest(state.quality!.findings[0]))
  assert.equal(audit.before_hash, audit.after_hash); assert.equal(audit.analysis_refs[0]!.value_hash, digest(before!.uncertainties[0]!.description))
  assert.equal(audit.source_refs[0]!.text_hash, digest(unit.text)); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.story, before); assert.equal(state.quality!.status, 'issues'); assert.equal(state.quality_repair!.withdrawals, undefined)
  await repairSourceQuality(source, structuredClone(state), async () => { throw new Error('must not repeat') }, () => {}, signal())
})

test('modern modify neutralizes an overstatement but keeps the unresolved relation and all unrelated analysis', async () => {
  const state = fixture(), before = structuredClone(state.story), neutral = '原文记载受击后进度增加，但触发条件未明，待作者确认。'
  await repairSourceQuality(source, state, async prompt => JSON.stringify(decision(input(prompt), { decision: 'modify_analysis', changes: [
    { target: 'story.uncertainties', section_id: null, operation: 'replace', index: 0, expected: before!.uncertainties[0], value: { description: neutral, section_ids: [0] } },
  ] })), () => {}, signal())
  assert.deepEqual(state.story, { ...before, uncertainties: [{ description: neutral, section_ids: [0] }] })
  assert.equal(state.quality_repair!.decisions![0]!.decision, 'modify_analysis')
  assert.notEqual(state.quality_repair!.decisions![0]!.before_hash, state.quality_repair!.decisions![0]!.after_hash)
  assert.equal(state.quality!.status, 'issues'); assert.equal(sourceQualityRepairProgress(state), 1)
})

test('wrong finding, unrelated retain refs, invalid evidence and uncovered changed targets cannot advance', async t => {
  for (const mode of ['finding', 'unrelated', 'source', 'target', 'empty', 'duplicate', 'noop', 'unrelated_modify'] as const) await t.test(mode, async () => {
    const state = fixture(), before = structuredClone(state.story); let calls = 0
    await assert.rejects(repairSourceQuality(source, state, async prompt => {
      calls++; if (mode === 'noop' && calls > 1) return JSON.stringify({ repairs: { change_0: { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: before!.summary, value: before!.summary } } }); const body = input(prompt), result = decision(body)
      if (mode === 'finding') result.finding_hash = 'a'.repeat(64)
      if (mode === 'unrelated') result.analysis_refs = [{ path: 'story.summary' }]
      if (mode === 'source') result.source_refs = [{ unit_id: 9999 }]
      if (mode === 'empty') result.analysis_refs = []
      if (mode === 'duplicate') result.source_refs = [{ unit_id: unit.id }, { unit_id: unit.id }]
      if (mode === 'unrelated_modify') result.analysis_refs = [{ path: 'story.summary' }]
      if (mode === 'target' || mode === 'noop' || mode === 'unrelated_modify') Object.assign(result, { decision: 'modify_analysis', changes: [{ target: 'story.summary', section_id: null,
        operation: 'replace', index: null, expected: before!.summary, value: mode === 'noop' ? before!.summary : before!.summary + '保留既有经历。' }] })
      return JSON.stringify(result)
    }, () => {}, signal()), (error: unknown) => { assert.equal((error as { code: string }).code, 'source_quality_decision_mismatch'); return true })
    assert.equal(calls, 2); assert.equal(sourceQualityRepairProgress(state), 0); assert.deepEqual(state.story, before)
    assert.equal(state.quality_repair!.decisions, undefined); assert.ok(state.quality_repair_output!.checkpoint.original_raw)
    await assert.rejects(repairSourceQuality(source, state, async () => { calls++; throw new Error('must not send') }, () => {}, signal()))
    assert.equal(calls, 2)
  })
})

test('uncertain and rebuild persist a terminal decision and never purchase another response after restart', async t => {
  for (const kind of ['uncertain', 'requires_full_rebuild'] as const) await t.test(kind, async () => {
    const state = fixture(), before = structuredClone(state.story); let calls = 0
    await assert.rejects(repairSourceQuality(source, state, async prompt => { calls++; return JSON.stringify(decision(input(prompt), { decision: kind })) }, () => {}, signal()))
    assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 0); assert.deepEqual(state.story, before)
    assert.equal(state.quality_repair!.decisions![0]!.decision, kind); assert.equal(state.quality_repair!.completed_findings, 0)
    await assert.rejects(repairSourceQuality(source, structuredClone(state), async () => { calls++; throw new Error('must not resend') }, () => {}, signal()))
    assert.equal(calls, 1)
  })
})

test('a complete historical withdrawn answer is preserved locally and never reinterpreted as retain or an unknown deletion', async () => {
  const state = fixture(), before = structuredClone(state.story); let calls = 0
  await assert.rejects(repairSourceQuality(source, state, async () => { calls++; throw Object.assign(new Error('known not sent'), { delivery: 'not_sent' }) }, () => {}, signal()))
  const raw = JSON.stringify({ status: 'withdrawn', reason: '原问题撤销，但未知没有被解释。', changes: [], unit_ids: [unit.id] })
  Object.assign(state.quality_repair_output!.checkpoint, { raw, original_raw: raw })
  await assert.rejects(repairSourceQuality(source, state, async () => { calls++; throw new Error('must not dispatch') }, () => {}, signal()), /withdrawn旧决定/)
  assert.equal(calls, 1); assert.equal(state.quality_repair_output!.checkpoint.original_raw, raw)
  assert.equal(state.quality_repair!.completed_findings, 0); assert.equal(state.quality_repair!.decisions, undefined); assert.deepEqual(state.story, before)
})

test('an identifiable legacy withdrawn decision never purchases evidence or schema correction before being stopped', async t => {
  for (const unit_ids of [[], [99999]] as const) await t.test(JSON.stringify(unit_ids), async () => {
    const state = fixture(), before = structuredClone(state.story); let calls = 0
    const raw = JSON.stringify({ status: 'withdrawn', reason: '保留旧协议原始回答，不推定其含义。', changes: [], unit_ids })
    await assert.rejects(repairSourceQuality(source, state, async () => { calls++; return raw }, () => {}, signal()),
      { code: 'source_quality_legacy_decision' })
    assert.equal(calls, 1)
    assert.equal(state.quality_repair_output!.checkpoint.original_raw, raw)
    assert.equal(state.quality_repair_output!.checkpoint.correction_started, undefined)
    assert.equal(state.quality_repair_output!.checkpoint.correction_request, undefined)
    assert.equal(sourceQualityRepairProgress(state), 0)
    assert.deepEqual(state.story, before)
    await assert.rejects(repairSourceQuality(source, structuredClone(state), async () => { calls++; throw new Error('must not dispatch') }, () => {}, signal()),
      { code: 'source_quality_legacy_decision' })
    assert.equal(calls, 1)
  })
})

test('decision progress rejects gaps, forged targets, duplicate decisions and edits to the frozen chain', async () => {
  const state = fixture()
  await repairSourceQuality(source, state, async prompt => JSON.stringify(decision(input(prompt))), () => {}, signal())
  for (const mutate of [
    (s: ScriptSourceAnalysis) => { s.quality_repair!.decisions![0]!.finding_hash = '0'.repeat(64) },
    (s: ScriptSourceAnalysis) => { s.quality_repair!.decisions!.push(structuredClone(s.quality_repair!.decisions![0]!)) },
    (s: ScriptSourceAnalysis) => { s.quality_repair!.decisions![0]!.after_hash = '0'.repeat(64) },
    (s: ScriptSourceAnalysis) => { s.quality_repair!.decisions![0]!.analysis_refs = [] },
  ]) { const changed = structuredClone(state); mutate(changed); assert.equal(sourceQualityRepairProgress(changed), null) }
})


test('an invalid saved explicit decision chain fails closed instead of resetting progress into another request', async () => {
  const state = fixture(); let calls = 0
  await repairSourceQuality(source, state, async prompt => { calls++; return JSON.stringify(decision(input(prompt))) }, () => {}, signal())
  state.quality_repair!.decisions![0]!.finding_hash = 'a'.repeat(64)
  await assert.rejects(repairSourceQuality(source, state, async () => { calls++; throw new Error('must not reset and dispatch') }, () => {}, signal()), /不重置计数或重新派发/)
  assert.equal(calls, 1); assert.equal(state.quality_repair!.completed_findings, 1); assert.equal(state.quality_repair_outputs!.length, 1)
})
