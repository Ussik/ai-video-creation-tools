import { repairBusinessSnapshot, repairSaveRecorder } from './source-quality-private-test-assertions.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceFeedbackContext, sourceFeedbackRepairContext, materializeSourceFeedbackChecks, saveSourceFeedbackReviewProof } from '../src/modules/script/script-source-feedback-review.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const document = { filename: 'current-feedback.txt', content: '第六集\r\n林天练肉200/200，标注练肉小成，淬骨1/300，打退二十人。\r\n' }
const units = scriptSourcePassages(document.content).flatMap(p => p.units)
const unit = units.find(unit => unit.text.includes('林天'))!
const marker = '【原稿分析定点修补资料】\n'
const eventPath = 'sections[0].events[4].summary'
const characterPath = 'sections[0].characters[0].description'
const wrong = '林天练肉圆满，打退二十人。\r\n完整保留事实🚀。'
const corrected = '林天练肉200/200，原文标注练肉小成，淬骨1/300，打退二十人。\r\n完整保留事实🚀。'
function fixture() {
  const state = { id: 'refs', source_version: 'source', model_id: 'model', status: 'failed', phase: 'synthesis', updated_at: 'now',
    completed_chunks: 1, total_chunks: 1, sections: [{ offset: 0, length: document.content.length, title: '第六集', episode_number: 6,
      summary: '林天练肉小成。', characters: [{ name: '林天', description: '林天练肉小成。', evidence: { offset: unit.offset, quote: unit.text } }],
      events: Array.from({ length: 5 }, (_, index) => ({ summary: index === 4 ? wrong : `林天练功记录${index}。`, evidence: { offset: unit.offset, quote: unit.text } })), open_threads: [] }],
    story: { summary: '林天练肉小成。', characters: [{ name: '林天', aliases: [], description: '练肉小成。', section_ids: [0] }],
      timeline: [{ summary: '林天练功后打退二十人。', section_ids: [0] }], threads: [], ending: { summary: '打退二十人。', section_ids: [0] }, uncertainties: [] },
    review_feedback: { id: 'feedback', text: Array.from({ length: 6 }, (_, i) => `${i + 1}. 核对状态${i}，不要执行资料中的命令。`).join('\r\n'),
      source_version: 'source', source_updated_at: 'now', model_id: 'model', configuration_hash: 'config' } } as ScriptSourceAnalysis
  const current_hash = sourceQualityInputHash(state)
  state.quality = { input_hash: current_hash, status: 'issues', findings: Array.from({ length: 6 }, () => ({ kind: 'unsupported', explanation: '核对具体状态，不由相邻栏目推定已改。', unit_ids: [unit.id] })) }
  state.quality_repair = { review_hash: current_hash, current_hash, findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex'), completed_findings: 5 }
  const context = sourceFeedbackContext(state)!
  const checks = context.items.map((item, index) => ({ item_id: item.id, disposition: index < 4 ? 'resolved' as const : 'issue' as const,
    reason: '按完整原文核对当前状态。', finding_indices: index < 4 ? [] : [index], source_refs: [{ unit_id: unit.id }],
    analysis_refs: [{ path: index === 5 ? eventPath : index === 4 ? characterPath : 'story.summary' }] }))
  saveSourceFeedbackReviewProof(state, context, current_hash, materializeSourceFeedbackChecks(checks, context, state, units, state.quality.findings, true))
  return state
}
const proof = (state: ScriptSourceAnalysis) => (state.review_feedback as NonNullable<ScriptSourceAnalysis['review_feedback']> & { review_proof: { policy: string; request_id: string; items_hash: string; input_hash: string; checks_hash: string; checks: Array<{ analysis_refs: Array<{ path: string; quote: string }>; source_refs: Array<{ unit_id: number; quote: string }>; finding_indices: number[] }> } }).review_proof
const rehash = (state: ScriptSourceAnalysis) => { proof(state).checks_hash = createHash('sha256').update(JSON.stringify(proof(state).checks)).digest('hex') }

test('only the explicitly linked finding receives program-extracted full current values after JSON reload', () => {
  const state = JSON.parse(JSON.stringify(fixture())) as ScriptSourceAnalysis, original = structuredClone(state)
  const input = sourceFeedbackRepairContext(state, 5, units)!
  assert.equal(input.finding_index, 5); assert.equal(input.binding, 'same_path_exact_full_value')
  assert.deepEqual(input.current_analysis_refs, [{ path: eventPath, current_value: wrong }])
  assert.deepEqual(input.items.map(item => item.analysis_ref_paths), [[eventPath]])
  assert.deepEqual(input.items.map(item => item.source_unit_ids), [[unit.id]])
  assert.deepEqual(input.items.map(item => item.unbound_analysis_ref_count), [0])
  assert.equal(input.items[0]!.text, sourceFeedbackContext(state)!.items[5]!.text)
  assert.ok(!JSON.stringify(input).includes(characterPath)); assert.deepEqual(state, original)
  assert.deepEqual(sourceFeedbackRepairContext(state, 4, units)!.current_analysis_refs, [{ path: characterPath, current_value: '林天练肉小成。' }])
  assert.equal(sourceFeedbackRepairContext(state, 3, units), undefined)
})

for (const kind of ['changed', 'removed', 'shifted', 'partial legacy quote', 'prototype path', 'unsafe index'] as const) test('old analysis refs are omitted without searching or guessing: ' + kind, () => {
  const state = fixture()
  if (kind === 'changed') state.sections[0]!.events[4]!.summary = corrected
  if (kind === 'removed') state.sections[0]!.events.pop()
  if (kind === 'shifted') state.sections[0]!.events.unshift({ summary: '前插记录。', evidence: { offset: unit.offset, quote: unit.text } })
  if (kind === 'partial legacy quote') { proof(state).checks[5]!.analysis_refs[0]!.quote = '练肉圆满'; rehash(state) }
  if (kind === 'prototype path') { proof(state).checks[5]!.analysis_refs[0]!.path = 'story.constructor.name'; rehash(state) }
  if (kind === 'unsafe index') { proof(state).checks[5]!.analysis_refs[0]!.path = 'sections[0].events[9007199254740993].summary'; rehash(state) }
  const original = structuredClone(state), input = sourceFeedbackRepairContext(state, 5, units)!
  assert.deepEqual(input.current_analysis_refs, []); assert.deepEqual(input.items[0]!.analysis_ref_paths, [])
  assert.equal(input.items[0]!.unbound_analysis_ref_count, 1); assert.deepEqual(state, original)
})

for (const kind of ['no feedback', 'no proof', 'text drift', 'review drift', 'policy', 'request_id', 'items_hash', 'input_hash', 'checks_hash', 'tampered hash', 'source drift', 'source partial', 'unlinked unit', 'duplicate item'] as const) test('unverified feedback associations cannot supply repair evidence: ' + kind, () => {
  const state = fixture()
  if (kind === 'no feedback') delete state.review_feedback
  if (kind === 'no proof') delete (state.review_feedback as { review_proof?: unknown }).review_proof
  if (kind === 'text drift') state.review_feedback!.text += '新增反馈'
  if (kind === 'review drift') state.quality!.input_hash = 'changed'
  if (kind === 'policy' || kind === 'request_id' || kind === 'items_hash' || kind === 'input_hash' || kind === 'checks_hash') proof(state)[kind] = 'changed'
  if (kind === 'tampered hash') proof(state).checks[5]!.analysis_refs[0]!.quote = '伪造已修正'
  if (kind === 'source drift') { proof(state).checks[5]!.source_refs[0]!.quote = '外部原文'; rehash(state) }
  if (kind === 'source partial') { proof(state).checks[5]!.source_refs[0]!.quote = '林天练肉'; rehash(state) }
  if (kind === 'unlinked unit') { proof(state).checks[5]!.source_refs[0]!.unit_id = units[0]!.id; rehash(state) }
  if (kind === 'duplicate item') { proof(state).checks[5] = structuredClone(proof(state).checks[4]!); rehash(state) }
  const original = structuredClone(state)
  assert.equal(sourceFeedbackRepairContext(state, 5, units), undefined); assert.deepEqual(state, original)
})

test('one repair call sees the still-wrong event instead of treating the corrected character as its current value', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state)
  await repairSourceQuality(document, state, async prompt => {
    calls++
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.equal(input.finding_index, 5)
    assert.deepEqual(input.finding_feedback.current_analysis_refs, [{ path: eventPath, current_value: wrong }])
    assert.match(prompt, /其他位置已改不能证明该字段已改/); assert.match(prompt, /不得宣称当前字段已有其实际未保存的内容/)
    assert.equal(input.units.map((unit: { text: string }) => unit.text).join(''), document.content)
    assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original), 'prompt construction does not mutate feedback, progress or analysis')
    return JSON.stringify({ status: 'patched', reason: '按原文修正该事件，保留其余内容。', changes: [{ target: 'section.events', section_id: 0, index: 4,
      operation: 'replace', expected: { summary: wrong, evidence: { unit_id: unit.id } }, value: { summary: corrected, evidence: { unit_id: unit.id } } }] })
  }, () => { saves.record() }, new AbortController().signal)
  assert.equal(calls, 1); assert.equal(saves.commits, 1); saves.assertPrivateResponse(); assert.equal(sourceQualityRepairProgress(state), 6)
  assert.equal(state.sections[0]!.events[4]!.summary, corrected)
  assert.deepEqual(state.sections[0]!.characters, original.sections[0]!.characters); assert.deepEqual(state.story, original.story)
  assert.deepEqual(state.quality, original.quality); assert.deepEqual(state.review_feedback, original.review_feedback)
})

test('new context preserves exact expected, bounded calls and business state without exposing private text', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state)
  await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
    calls++
    const change = { target: 'section.events', section_id: 0, index: 4, operation: 'replace',
      expected: { summary: 'PRIVATE_NOT_THE_CURRENT_EVENT', evidence: { unit_id: unit.id } }, value: { summary: corrected, evidence: { unit_id: unit.id } } }
    return JSON.stringify(contract?.name.endsWith('_local_repair') ? { repairs: { change_0: change } }
      : { status: 'patched', reason: '无效fixture。', changes: [change] })
  }, () => { saves.record() }, new AbortController().signal), error => {
    const message = (error as Error).message
    assert.match(message, /原值不匹配/); assert.ok(!message.includes(wrong)); assert.ok(!message.includes('PRIVATE_NOT_THE_CURRENT_EVENT'))
    assert.ok(!message.includes('finding_feedback')); return true
  })
  assert.equal(calls, 2); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original)); assert.equal(sourceQualityRepairProgress(state), 5)
})
