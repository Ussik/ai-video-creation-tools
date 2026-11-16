import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceFeedbackContext, sourceFeedbackWireCheckSchema, sourceFeedbackCheckSchema, sourceFeedbackReviewPolicy,
  materializeSourceFeedbackChecks, diagnoseSourceFeedbackWireChecks, hasSourceFeedbackReviewProof, saveSourceFeedbackReviewProof,
  type SourceFeedbackCheck, type SourceFeedbackWireCheck } from '../src/modules/script/script-source-feedback-review.js'
import { reviewSourceQuality, sourceQualityInputHash, sourceQualityPolicyVersion, hasPassedSourceQuality } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'

const content = '第一集\r\n【玉佩】　归还！🚀\r\n'
function fixture(text = '【玉佩】　已归还！🚀\r\n') {
  const state = { id: 'wire', source_version: 'source', model_id: 'model', status: 'running', phase: 'synthesis', updated_at: 'now',
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length,
    sections: [{ offset: 0, length: content.length, title: '第一集', episode_number: 1, summary: text, characters: [], events: [], open_threads: [] }],
    story: { summary: text, characters: [], timeline: [], threads: [], ending: { summary: text, section_ids: [0] }, uncertainties: [] },
    review_feedback: { id: 'feedback', text: '核对归还状态。', source_version: 'source', source_updated_at: 'now', model_id: 'model', configuration_hash: 'config' },
  } as ScriptSourceAnalysis
  const context = sourceFeedbackContext(state)!, units = scriptSourcePassages(content).flatMap(p => p.units)
  const unit = units.find(unit => unit.text.includes('玉佩'))!
  const check: SourceFeedbackWireCheck = { item_id: context.items[0]!.id, disposition: 'resolved', reason: '依据原文和当前分析独立核对归还状态。', finding_indices: [],
    source_refs: [{ unit_id: unit.id }], analysis_refs: [{ path: 'story.summary' }] }
  return { state, context, units, unit, check }
}
const signal = () => new AbortController().signal
const report = (check: unknown, findings: unknown[] = []) => JSON.stringify({ checked_section_ids: [0], findings, feedback_checks: [check] })
const proofFor = (state: ScriptSourceAnalysis) => (state.review_feedback as unknown as { review_proof: { policy: string; checks: SourceFeedbackCheck[] } }).review_proof

test('model wire accepts coordinates only and refuses legacy quotes or extra fields at every level', () => {
  const { check } = fixture()
  assert.ok(sourceFeedbackWireCheckSchema.safeParse(check).success)
  for (const value of [{ ...check, extra: true }, { ...check, source_refs: [{ ...check.source_refs[0], quote: '旧原文' }] },
    { ...check, source_refs: [{ ...check.source_refs[0], offset: 0 }] }, { ...check, analysis_refs: [{ path: 'story.summary', quote: '旧现文' }] },
    { ...check, analysis_refs: [{ path: 'story.summary', length: 1 }] }]) assert.equal(sourceFeedbackWireCheckSchema.safeParse(value).success, false)
})

test('application extracts complete source and analysis values without normalization or quote repair', () => {
  const { state, context, units, unit, check } = fixture('  e\u0301／é，🚀\r\n完整现文。\t')
  check.analysis_refs.push({ path: 'sections[0].episode_number' })
  const before = JSON.stringify({ state, check, units })
  const values = materializeSourceFeedbackChecks([check], context, state, units, [], true)
  assert.equal(values[0]!.source_refs[0]!.quote, unit.text)
  assert.equal(values[0]!.analysis_refs[0]!.quote, state.story!.summary)
  assert.equal(values[0]!.analysis_refs[1]!.quote, '1')
  assert.ok(sourceFeedbackCheckSchema.safeParse(values[0]).success)
  assert.equal(JSON.stringify({ state, check, units }), before)
})

test('coordinates reject nonexistent blank duplicate unsafe or nonscalar evidence without guessing', () => {
  const { state, context, units, check } = fixture()
  for (const source_refs of [[{ unit_id: 999999 }], [{ unit_id: units[0]!.id }, { unit_id: units[0]!.id }]]) {
    assert.throws(() => materializeSourceFeedbackChecks([{ ...check, source_refs }], context, state, units, [], true), /真实|重复/)
  }
  const blankUnit = { id: 999, text: ' \r\n\t' }
  assert.throws(() => materializeSourceFeedbackChecks([{ ...check, source_refs: [{ unit_id: 999 }] }], context, state, [...units, blankUnit], [], true), /非空白/)
  for (const path of ['story.characters[99].name', '__proto__.summary', 'story.constructor.name', 'sections[00].summary',
    'story.summary[0]', 'story.ending.section_ids[0]', 'sections[9007199254740992].summary']) {
    assert.throws(() => materializeSourceFeedbackChecks([{ ...check, analysis_refs: [{ path }] }], context, state, units, [], true), /路径|白名单/)
  }
  assert.throws(() => materializeSourceFeedbackChecks([{ ...check, analysis_refs: [{ path: 'story.summary' }, { path: 'story.summary' }] }], context, state, units, [], true), /重复/)
  for (const value of [null, undefined, Number.NaN, Infinity, [], {}, ' \r\n']) {
    ;(state.story as unknown as { summary: unknown }).summary = value
    assert.throws(() => materializeSourceFeedbackChecks([check], context, state, units, [], true), /真实文字|路径不存在|非空白/)
  }
})

test('full evidence size uses the existing 6000 Unicode character limit without truncation', () => {
  const { state, context, units, check } = fixture('字'.repeat(5999) + '🚀')
  assert.equal(state.story!.summary.length, 6001); assert.equal(Array.from(state.story!.summary).length, 6000)
  const full = materializeSourceFeedbackChecks([check], context, state, units, [], true)
  assert.equal(full[0]!.analysis_refs[0]!.quote, state.story!.summary)
  assert.ok(full[0]!.analysis_refs[0]!.quote.endsWith('🚀'))
  state.story!.summary += '尾'
  assert.throws(() => materializeSourceFeedbackChecks([check], context, state, units, [], true), /超过6000.*不能截断/)
  const longUnits = [{ id: check.source_refs[0]!.unit_id, text: '🚀'.repeat(6001) }]
  assert.throws(() => materializeSourceFeedbackChecks([check], context, state, longUnits, [], true), /超过6000.*不能截断/)
})

test('wire preflight aggregates valid subshape coordinate errors without accepting malformed quote fields or finding links', () => {
  const { state, context, units, check } = fixture()
  const value = { feedback_checks: [{ ...check, analysis_refs: [{ path: 'story.summary', quote: 'old' }] },
    { ...check, disposition: 'issue', finding_indices: [999], source_refs: [{ unit_id: 99999 }], analysis_refs: [{ path: 'story.characters[99].description' }] }] }
  const before = JSON.stringify(value), diagnostics = diagnoseSourceFeedbackWireChecks(value, context, state, units)
  assert.equal(diagnostics.length, 2)
  assert.match(diagnostics[0]!, /\$\.feedback_checks\[1\]\.source_refs\[0\]\.unit_id/)
  assert.match(diagnostics[1]!, /\$\.feedback_checks\[1\]\.analysis_refs\[0\]\.path/)
  assert.ok(diagnostics.every(issue => !issue.includes('finding_indices') && !issue.includes('old')))
  assert.equal(JSON.stringify(value), before)
})

test('v1 feedback proof and complete page cache require a fresh independent v2 audit, preserving source artifacts', async () => {
  const { state, context, units, check } = fixture(), original = structuredClone(state)
  const checks = materializeSourceFeedbackChecks([check], context, state, units, [], true)
  const oldInputHash = createHash('sha256').update(JSON.stringify([sourceQualityPolicyVersion, state.source_version, state.sections, state.story,
    state.review_feedback, 'source-feedback-review-v1'])).digest('hex')
  saveSourceFeedbackReviewProof(state, context, oldInputHash, checks)
  proofFor(state).policy = 'source-feedback-review-v1'
  state.quality = { input_hash: oldInputHash, status: 'passed', findings: [] }
  state.quality_work = { input_hash: oldInputHash, checkpoint: { steps: { 'source-quality:pages': { input_hash: 'v1-page', value: {
    items: [{ kind: 'coverage', checked_section_ids: [0] }, { kind: 'feedback_check', check: checks[0] }], complete: true } } } } }
  assert.equal(hasSourceFeedbackReviewProof(state, oldInputHash), false)
  assert.equal(hasPassedSourceQuality(state), false)
  assert.notEqual(sourceQualityInputHash(state), oldInputHash)
  let calls = 0
  await reviewSourceQuality({ filename: 'test.txt', content }, state, async (_prompt, contract) => {
    calls++; assert.equal(contract!.name, 'script_source_quality'); return report(check)
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(hasPassedSourceQuality(state), true); assert.equal(sourceFeedbackReviewPolicy, 'source-feedback-review-v2')
  assert.equal(proofFor(state).policy, 'source-feedback-review-v2')
  assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
})

test('frozen evidence survives live analysis deletion during model call and stale proof is never saved', async () => {
  const { state, check } = fixture(); let calls = 0, saves = 0
  await assert.rejects(reviewSourceQuality({ filename: 'test.txt', content }, state, async () => {
    calls++; delete (state as { story?: unknown }).story; return report(check)
  }, () => { saves++ }, signal()), /审核期间发生变化/)
  assert.equal(calls, 1); assert.equal(saves, 0); assert.equal(state.story, undefined); assert.equal(state.quality, undefined)
  assert.equal((state.review_feedback as { review_proof?: unknown }).review_proof, undefined)
})

test('oversized full analysis evidence never silently truncates or saves quality or proof', async () => {
  const { state, check } = fixture('字'.repeat(6001)), before = structuredClone(state); let saves = 0
  await assert.rejects(reviewSourceQuality({ filename: 'test.txt', content }, state, async () => report(check), () => { saves++ }, signal()), /超过6000/)
  assert.equal(saves, 0); assert.deepEqual(state, before)
})

test('paged and recovered whole output reject legacy quote fields without saving a proof', async () => {
  for (const mode of ['page', 'seed']) {
    const { state, check } = fixture(), legacy = { ...check, analysis_refs: [{ path: 'story.summary', quote: state.story!.summary }] }; let calls = 0
    await assert.rejects(reviewSourceQuality({ filename: 'test.txt', content }, state, async () => {
      calls++
      if (calls === 1) throw new TextOutputLimitError(mode === 'seed' ? '{"feedback_checks":[' + JSON.stringify(legacy) + ',' : '', 'max_output_tokens')
      return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }, { kind: 'feedback_check', check: legacy }], complete: true })
    }, () => {}, signal()), /quote|Unrecognized/)
    assert.equal(state.quality, undefined); assert.equal((state.review_feedback as { review_proof?: unknown }).review_proof, undefined)
  }
})

test('valid coordinate selection still enforces finding overlap and full feedback coverage', () => {
  const { state, context, units, check } = fixture()
  assert.throws(() => materializeSourceFeedbackChecks([{ ...check, disposition: 'issue', finding_indices: [0] }], context, state, units,
    [{ kind: 'omission', explanation: '实质遗漏。', unit_ids: [99999] }], true), /相交的原文证据/)
  assert.throws(() => materializeSourceFeedbackChecks([], context, state, units, [], true), /逐项完整覆盖/)
  assert.throws(() => materializeSourceFeedbackChecks([{ ...check, disposition: 'issue', finding_indices: [0, 0] }], context, state, units,
    [{ kind: 'omission', explanation: '实质遗漏。', unit_ids: [check.source_refs[0]!.unit_id] }], true), /不能重复/)
})
