import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceFeedbackContext, validateSourceFeedbackChecks, saveSourceFeedbackReviewProof, hasSourceFeedbackReviewProof,
  sourceFeedbackIdentity, type SourceFeedbackCheck } from '../src/modules/script/script-source-feedback-review.js'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

const stateFor = (text = '1. 核对归还。\n2. 核对动作。') => ({
  source_version: 'source', sections: [{ summary: '韩秋归还玉佩。', title: '第一集', characters: [], events: [] }],
  story: { summary: '韩秋归还玉佩。', characters: [], timeline: [], threads: [], ending: { summary: '交接完成。', section_ids: [0] }, uncertainties: [] },
  review_feedback: { id: 'request', text, source_version: 'source', source_updated_at: 'now', model_id: 'stub', configuration_hash: 'config' },
} as unknown as ScriptSourceAnalysis)
const units = [{ id: 7, text: '韩秋归还玉佩。' }]
const findings = [{ kind: 'unsupported' as const, explanation: '未曾离开。', unit_ids: [7] }]
const checkFor = (id: string, disposition: SourceFeedbackCheck['disposition'] = 'resolved'): SourceFeedbackCheck => ({
  item_id: id, disposition, reason: '核对该项，原文与当前全剧概要均记载玉佩归还。', finding_indices: disposition === 'issue' ? [0] : [],
  source_refs: [{ unit_id: 7, quote: '韩秋归还玉佩。' }], analysis_refs: [{ path: 'story.summary', quote: '韩秋归还玉佩。' }],
})
test('feedback numbered blocks preserve every original character, introductory text, CRLF and closing instructions', () => {
  const text = '先独立核查🚀，不是原文事实。\r\n1. 第一项\r\n连续说明\r\n2. 第二项\r\n最后保留全部原文。\r\n', s = stateFor(text)
  const c = sourceFeedbackContext(s)!
  assert.equal(c.items.length, 2); assert.equal(c.items.map(item => item.text).join(''), text)
  assert.equal(c.items[0]!.offset, 0); assert.ok(c.items[0]!.text.startsWith('先独立'))
  for (const item of c.items) assert.equal(text.slice(item.offset, item.offset + item.length), item.text)
  assert.deepEqual(sourceFeedbackContext(s), c)
  assert.notEqual(sourceFeedbackContext(stateFor(text + '改'))!.items_hash, c.items_hash)
})
test('unstructured, noncontinuous, duplicate, leading-zero or mixed numbering remains one intact item', () => {
  for (const text of ['不要擅改。\n全文核查。', '2. 第二项\n3. 第三项', '1. 第一项\n3. 第三项', '1. 第一项\n1. 重复项', '01. 第一项\n2. 第二项', '1. 第一项\n二、第二项', '1. 第一项\n2. 第二项\n3. ', '1. 第一项\n2. \n3. 第三项']) {
    const c = sourceFeedbackContext(stateFor(text))!
    assert.equal(c.items.length, 1, text); assert.equal(c.items[0]!.text, text)
  }
})
test('feedback checks require exact-once known item IDs and explicit finding links', () => {
  const s = stateFor(), c = sourceFeedbackContext(s)!, valid = c.items.map(x => checkFor(x.id))
  validateSourceFeedbackChecks(valid, c, s, units, [], true)
  for (const checks of [[], valid.slice(0, 1), [valid[0]!, valid[0]!], [valid[0]!, { ...valid[1]!, item_id: 'unknown' }]]) assert.throws(() => validateSourceFeedbackChecks(checks, c, s, units, [], true), /反馈/)
  assert.throws(() => validateSourceFeedbackChecks([{ ...valid[0]!, disposition: 'issue', finding_indices: [] }, valid[1]!], c, s, units, findings, true), /finding/)
  assert.throws(() => validateSourceFeedbackChecks([{ ...valid[0]!, disposition: 'issue', finding_indices: [1] }, valid[1]!], c, s, units, findings, true), /finding/)
  validateSourceFeedbackChecks([{ ...valid[0]!, disposition: 'issue', finding_indices: [0] }, valid[1]!], c, s, units, findings, true)
})
test('analysis refs reject prototype access, unsupported paths, unsafe indices, nonexact and repeated quotes', () => {
  const s = stateFor('未编号完整反馈'), c = sourceFeedbackContext(s)!, check = checkFor(c.items[0]!.id)
  for (const path of ['__proto__.summary', 'story.constructor.name', 'story.__proto__.summary', 'sections[9007199254740992].summary', 'story.characters[-1].description', 'story.summary[0]', 'story.ending.section_ids[0]', 'sections[00].summary']) {
    assert.throws(() => validateSourceFeedbackChecks([{ ...check, analysis_refs: [{ path, quote: '韩秋归还玉佩。' }] }], c, s, units, [], true), /现文|路径|引用/)
  }
  assert.throws(() => validateSourceFeedbackChecks([{ ...check, analysis_refs: [{ path: 'story.summary', quote: ' 韩秋' }] }], c, s, units, [], true), /精确/)
  s.story!.summary = '归还。归还。'
  assert.throws(() => validateSourceFeedbackChecks([{ ...check, analysis_refs: [{ path: 'story.summary', quote: '归还。' }] }], c, s, units, [], true), /唯一/)
})
test('source refs and resolved evidence must be real, nonblank, exact and unique', () => {
  const s = stateFor('核对'), c = sourceFeedbackContext(s)!, check = checkFor(c.items[0]!.id)
  for (const refs of [[], [{ unit_id: 999, quote: '韩秋归还玉佩。' }], [{ unit_id: 7, quote: ' ' }], [{ unit_id: 7, quote: '不存在' }]]) assert.throws(() => validateSourceFeedbackChecks([{ ...check, source_refs: refs }], c, s, units, [], true), /原文|精确/)
  assert.throws(() => validateSourceFeedbackChecks([{ ...check, analysis_refs: [] }], c, s, units, [], true), /现文/)
})
test('unverifiable allows no fabricated evidence while a proof containing it never authorizes passed', () => {
  const s = stateFor('请更换网页颜色'), c = sourceFeedbackContext(s)!, check: SourceFeedbackCheck = { item_id: c.items[0]!.id, disposition: 'unverifiable', reason: '与原稿资料核对无关，待人工确认。', finding_indices: [], source_refs: [], analysis_refs: [] }
  validateSourceFeedbackChecks([check], c, s, units, [], true)
  saveSourceFeedbackReviewProof(s, c, 'a'.repeat(64), [check])
  assert.equal(hasSourceFeedbackReviewProof(s, 'a'.repeat(64)), false)
})
test('private proof excludes itself from feedback identity and binds request, items and current analysis hash', () => {
  const s = stateFor(), c = sourceFeedbackContext(s)!, original = structuredClone(sourceFeedbackIdentity(s))
  const checks = c.items.map(x => checkFor(x.id)); saveSourceFeedbackReviewProof(s, c, 'a'.repeat(64), checks)
  assert.deepEqual(sourceFeedbackIdentity(s), original); assert.deepEqual(sourceFeedbackContext(s), c)
  assert.equal(hasSourceFeedbackReviewProof(s, 'a'.repeat(64)), true); assert.equal(hasSourceFeedbackReviewProof(s, 'b'.repeat(64)), false)
  checks[0]!.reason = 'changed outside'; assert.equal(hasSourceFeedbackReviewProof(s, 'a'.repeat(64)), true)
  s.review_feedback!.text += '外部新增'; assert.equal(hasSourceFeedbackReviewProof(s, 'a'.repeat(64)), false)
})


test('feedback cost limit accepts 32 numbered blocks and rejects 33 without silently merging', () => {
  const text = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}. 核对第${i + 1}项。`).join('\n')
  assert.equal(sourceFeedbackContext(stateFor(text(32)))!.items.length, 32)
  const s = stateFor(text(33)), original = structuredClone(s)
  assert.throws(() => sourceFeedbackContext(s), e => (e as { statusCode?: number }).statusCode === 422 && /32.*拆分/.test((e as Error).message))
  assert.deepEqual(s, original)
})
