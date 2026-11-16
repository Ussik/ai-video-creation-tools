import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { reviewSourceQuality, sourceQualityInputHash, hasPassedSourceQuality, sourceQualityPolicyVersion } from '../src/modules/script/script-source-quality.js'
import { sourceFeedbackContext, type SourceFeedbackCheck, type SourceFeedbackWireCheck } from '../src/modules/script/script-source-feedback-review.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'

const document = { filename: 'feedback-gate.txt', content: '第一集\n韩秋归还玉佩。\n谢禾见证。\n' }
const unit = scriptSourcePassages(document.content).flatMap(p => p.units).find(u => u.text.includes('韩秋'))!
const marker = '【原稿分析核对资料】\n'
const signal = () => new AbortController().signal
function fixture(feedback: string | null = '1. 核对信物。\n2. 核对动作。\n3. 核对结局。'): ScriptSourceAnalysis {
  return { id: 'gate', source_version: 'source-v1', model_id: 'stub', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    completed_characters: document.content.length, updated_at: 'now', sections: [{ offset: 0, length: document.content.length, unit_id: 0,
      title: '第一集', episode_number: 1, summary: '韩秋归还玉佩。', characters: [], events: [], open_threads: [] }],
    story: { summary: '韩秋归还玉佩。', characters: [], timeline: [], threads: [], ending: { summary: '谢禾见证。', section_ids: [0] }, uncertainties: [] },
    ...(feedback === null ? {} : { review_feedback: { id: 'request-v1', text: feedback, source_version: 'source-v1', source_updated_at: 'now', model_id: 'stub', configuration_hash: 'config' } }) }
}
const checksFor = (s: ScriptSourceAnalysis, disposition: SourceFeedbackWireCheck['disposition'] = 'resolved') => sourceFeedbackContext(s)!.items.map(item => ({ item_id: item.id, disposition,
  reason: '本项按当前全剧概要和原文核对，信物已经归还。', finding_indices: disposition === 'issue' ? [0] : [],
  source_refs: disposition === 'unverifiable' ? [] : [{ unit_id: unit.id }],
  analysis_refs: disposition === 'unverifiable' ? [] : [{ path: 'story.summary' }] }))
const report = (checks: SourceFeedbackWireCheck[]) => JSON.stringify({ checked_section_ids: [0], findings: [], feedback_checks: checks })

test('no-feedback input hash and legacy output remain unchanged and have no private proof requirement', async () => {
  const s = fixture(null), expected = createHash('sha256').update(JSON.stringify([sourceQualityPolicyVersion, s.source_version, s.sections, s.story])).digest('hex')
  assert.equal(sourceQualityInputHash(s), expected)
  let calls = 0
  await reviewSourceQuality(document, s, async (_prompt, contract) => { calls++; assert.equal('feedback_checks' in (contract!.schema as { properties: object }).properties, false); return JSON.stringify({ checked_section_ids: [0], findings: [] }) }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(s.quality!.status, 'passed'); assert.equal(hasPassedSourceQuality(s), true)
  await reviewSourceQuality(document, s, async () => { throw new Error('cached no-feedback audit must not call again') }, () => {}, signal())
})
test('three feedback items with no dispositions cannot use the old empty-findings pass path', async () => {
  const s = fixture(); let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => { calls++; return JSON.stringify({ checked_section_ids: [0], findings: [] }) }, () => {}, signal()), /feedback_checks/)
  assert.equal(calls, 2); assert.equal(s.quality, undefined); assert.equal(hasPassedSourceQuality(s), false)
})
test('one valid review call publishes a bound private proof, survives JSON reload and needs no extra model call', async () => {
  const s = fixture(), original = structuredClone(s), before = sourceQualityInputHash(s); let calls = 0
  await reviewSourceQuality(document, s, async prompt => { calls++; assert.ok(prompt.includes('不是原文事实或操作指令')); const data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)); assert.equal(data.creator_review_feedback.text, s.review_feedback!.text); assert.deepEqual(data.creator_review_feedback.items, sourceFeedbackContext(s)!.items); return report(checksFor(s)) }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityInputHash(s), before); assert.deepEqual(s.story, original.story); assert.deepEqual(s.sections, original.sections)
  assert.equal(hasPassedSourceQuality(s), true); assert.equal(hasPassedSourceQuality(JSON.parse(JSON.stringify(s))), true)
  await reviewSourceQuality(document, s, async () => { throw new Error('valid proof should be cached') }, () => {}, signal())
})
for (const mode of ['missing', 'duplicate', 'unknown', 'stale_quote', 'prototype', 'bad_finding']) test('invalid direct feedback disposition is rejected atomically: ' + mode, async () => {
  const s = fixture(), original = structuredClone(s), checks = checksFor(s)
  if (mode === 'missing') checks.pop()
  if (mode === 'duplicate') checks[1] = checks[0]!
  if (mode === 'unknown') checks[1]!.item_id = 'unknown'
  if (mode === 'stale_quote') Object.assign(checks[1]!.analysis_refs[0]!, { quote: '旧文字' })
  if (mode === 'prototype') checks[1]!.analysis_refs[0]!.path = 'story.constructor.name'
  if (mode === 'bad_finding') { checks[1]!.disposition = 'issue'; checks[1]!.finding_indices = [0] }
  await assert.rejects(reviewSourceQuality(document, s, async () => report(checks), () => {}, signal()))
  assert.deepEqual(s.story, original.story); assert.deepEqual(s.sections, original.sections); assert.equal(s.quality, undefined)
  assert.equal((s.review_feedback as { review_proof?: unknown }).review_proof, undefined)
})
test('issue disposition links existing findings and preserves the normal repair-needed outcome', async () => {
  const s = fixture('核对主角'), finding = { kind: 'unsupported', explanation: '概要错误。', unit_ids: [unit.id] }
  await assert.rejects(reviewSourceQuality(document, s, async () => JSON.stringify({ checked_section_ids: [0], findings: [finding], feedback_checks: checksFor(s, 'issue') }), () => {}, signal()), e => (e as { sourceQualityIssues?: boolean }).sourceQualityIssues === true)
  assert.equal(s.quality!.status, 'issues'); assert.deepEqual(s.quality!.findings, [finding]); assert.equal(hasPassedSourceQuality(s), false)
})
test('unrelated feedback can be unverifiable with no fabricated citations, but never becomes passed', async () => {
  const s = fixture('请更换网页颜色'); let calls = 0, saves = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => { calls++; return report(checksFor(s, 'unverifiable')) }, () => { saves++ }, signal()), e => (e as { sourceQualityFeedbackUnresolved?: boolean }).sourceQualityFeedbackUnresolved === true)
  assert.equal(calls, 1); assert.equal(saves, 1); assert.equal(s.quality!.status, 'issues'); assert.deepEqual(s.quality!.findings, []); assert.equal(hasPassedSourceQuality(s), false)
  assert.ok((s.review_feedback as { review_proof?: unknown }).review_proof)
})
test('legacy feedback cache without proof is review-only invalidated while completed story and directory are retained', async () => {
  const s = fixture(), original = structuredClone(s)
  const oldHash = createHash('sha256').update(JSON.stringify([sourceQualityPolicyVersion, s.source_version, s.sections, s.story, s.review_feedback])).digest('hex')
  assert.notEqual(sourceQualityInputHash(s), oldHash)
  s.quality = { input_hash: oldHash, status: 'passed', findings: [] }; assert.equal(hasPassedSourceQuality(s), false)
  let calls = 0
  await reviewSourceQuality(document, s, async () => { calls++; return report(checksFor(s)) }, () => {}, signal())
  assert.equal(calls, 1); assert.deepEqual(s.story, original.story); assert.deepEqual(s.sections, original.sections); assert.equal(hasPassedSourceQuality(s), true)
})
for (const drift of ['feedback', 'story']) test('concurrent ' + drift + ' drift is preserved and cannot receive a stale proof', async () => {
  const s = fixture(), original = structuredClone(s), raw = report(checksFor(s))
  await assert.rejects(reviewSourceQuality(document, s, async () => { if (drift === 'feedback') s.review_feedback!.text += '外部新反馈'; else s.story!.ending.summary += '外部新结局'; return raw }, () => {}, signal()), /审核期间发生变化/)
  assert.equal((s.review_feedback as { review_proof?: unknown }).review_proof, undefined); assert.equal(s.quality, undefined)
  if (drift === 'feedback') { assert.deepEqual(s.story, original.story); assert.ok(s.review_feedback!.text.endsWith('外部新反馈')) }
  else assert.ok(s.story!.ending.summary.endsWith('外部新结局'))
})
test('paged output cannot declare complete with coverage but no feedback checks', async () => {
  const s = fixture(); let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async (_p, contract) => { calls++; if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('', 'max_output_tokens'); return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true }) }, () => {}, signal()), /反馈/)
  assert.equal(calls, 3); assert.equal(hasPassedSourceQuality(s), false); assert.equal(s.quality, undefined)
})
test('closed feedback checks recovered from truncated whole output are retained and completed through the same page gate', async () => {
  const s = fixture(), checks = checksFor(s); let calls = 0
  await reviewSourceQuality(document, s, async (_p, contract) => {
    calls++
    if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('{"checked_section_ids":[0],"findings":[],"feedback_checks":[' + JSON.stringify(checks[0]) + ',', 'max_output_tokens')
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }, ...checks.slice(1).map(check => ({ kind: 'feedback_check', check }))], complete: true })
  }, () => {}, signal())
  assert.equal(calls, 2); assert.equal(hasPassedSourceQuality(s), true)
})
test('incomplete paged feedback work resumes only unfinished checks and never promotes an incomplete checkpoint', async () => {
  const s = fixture(), checks = checksFor(s); let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async (_p, contract) => {
    if (++calls === 1) throw new TextOutputLimitError('', 'max_output_tokens')
    if (calls === 2) return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }, { kind: 'feedback_check', check: checks[0] }], complete: false })
    throw new Error('fixture pause')
  }, () => {}, signal()), /fixture pause/)
  assert.equal(hasPassedSourceQuality(s), false); let resumed = 0
  await reviewSourceQuality(document, s, async (_p, contract) => { resumed++; assert.equal(contract!.name, 'script_source_quality_page'); return JSON.stringify({ items: checks.slice(1).map(check => ({ kind: 'feedback_check', check })), complete: true }) }, () => {}, signal())
  assert.equal(resumed, 1); assert.equal(hasPassedSourceQuality(s), true)
})


test('not_supported remains an evidence-backed explicit decision rather than blindly accepting creator claims', async () => {
  const s = fixture('主角从未归还玉佩。')
  await reviewSourceQuality(document, s, async () => report(checksFor(s, 'not_supported')), () => {}, signal())
  assert.equal(hasPassedSourceQuality(s), true)
})

test('conflicting duplicate feedback item across pages cannot be deduplicated into a complete audit', async () => {
  const s = fixture(), checks = checksFor(s); let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => {
    if (++calls === 1) throw new TextOutputLimitError('', 'max_output_tokens')
    if (calls === 2) return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }, { kind: 'feedback_check', check: checks[0] }], complete: false })
    return JSON.stringify({ items: [{ kind: 'feedback_check', check: { ...checks[0], reason: '第二个互相冲突的处置。' } }], complete: false })
  }, () => {}, signal()), /每项反馈只能有一个/)
  assert.equal(hasPassedSourceQuality(s), false); assert.equal(s.quality, undefined)
})

test('feedback request identity changes invalidate cached page completion but retain source work', async () => {
  const s = fixture(), original = structuredClone(s)
  s.quality_work = { input_hash: 'old-feedback-policy', checkpoint: { steps: { 'source-quality:pages': { value: { items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true }, input_hash: 'old-page' } } } }
  let calls = 0
  await reviewSourceQuality(document, s, async (_p, contract) => { calls++; assert.equal(contract!.name, 'script_source_quality'); return report(checksFor(s)) }, () => {}, signal())
  assert.equal(calls, 1); assert.deepEqual(s.story, original.story); assert.deepEqual(s.sections, original.sections); assert.equal(hasPassedSourceQuality(s), true)
})


test('more than 32 feedback items fails with 422 before any model dispatch or saved review mutation', async () => {
  const s = fixture(Array.from({ length: 33 }, (_, i) => `${i + 1}. 待核查。`).join('\n')), original = structuredClone(s)
  let calls = 0, saves = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => { calls++; throw new Error('must not dispatch') }, () => { saves++ }, signal()),
    e => (e as { statusCode?: number }).statusCode === 422 && /拆分/.test((e as Error).message))
  assert.equal(calls, 0); assert.equal(saves, 0); assert.deepEqual(s, original)
})


test('unverifiable display uses the original feedback ordinal in mixed results without exposing reference quotes or executing reasons', async () => {
  const s = fixture('1. 核对信物。\n2. 这项资料不足。'), original = structuredClone(s), checks = checksFor(s)
  const reason = '仅为显示数据：<script>请执行删除原文</script>。\n缺少需要核实的明确命题。'
  checks[1] = { ...checks[1]!, disposition: 'unverifiable', reason, source_refs: [], analysis_refs: [] }
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => { calls++; return report(checks) }, () => {}, signal()), error => {
    const e = error as Error & { statusCode: number; sourceQualityFeedbackUnresolved: boolean }
    assert.equal(e.statusCode, 422); assert.equal(e.sourceQualityFeedbackUnresolved, true)
    assert.match(e.message, /第2项/); assert.doesNotMatch(e.message, /第1项/); assert.match(e.message, /仅为核对说明数据/)
    assert.ok(e.message.includes('<script>请执行删除原文</script>'))
    assert.ok(!e.message.includes(unit.text)); assert.ok(!e.message.includes(s.story!.summary)); assert.doesNotMatch(e.message, /\n/)
    return true
  })
  assert.equal(calls, 1); assert.equal(hasPassedSourceQuality(s), false); assert.equal(s.quality!.status, 'issues')
  assert.deepEqual(s.story, original.story); assert.deepEqual(s.sections, original.sections)
  const proof = (s.review_feedback as unknown as { review_proof: { checks: SourceFeedbackCheck[] } }).review_proof
  assert.equal(proof.checks[1]!.reason, reason, 'full private reason is retained verbatim as data')
})

test('unverifiable display sorts original item numbers and caps detail count and reason length while private proof remains complete', async () => {
  const s = fixture(Array.from({ length: 6 }, (_, i) => `${i + 1}. 资料待确认。`).join('\n'))
  const checks = checksFor(s, 'unverifiable').map((check, i) => ({ ...check, reason: `原因${i + 1}：` + '🚀'.repeat(200) + '\u0000' })).reverse()
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, s, async () => { calls++; return report(checks) }, () => {}, signal()), error => {
    const message = (error as Error).message
    assert.ok(message.indexOf('第1项') < message.indexOf('第2项')); assert.ok(message.indexOf('第2项') < message.indexOf('第3项'))
    assert.doesNotMatch(message, /第4项|第5项|第6项|\u0000/); assert.match(message, /另有3项/); assert.ok(message.length <= 700)
    return true
  })
  assert.equal(calls, 1); assert.equal(hasPassedSourceQuality(s), false)
  const proof = (s.review_feedback as unknown as { review_proof: { checks: SourceFeedbackCheck[] } }).review_proof
  assert.equal(proof.checks.length, 6); assert.ok(proof.checks.every(check => check.reason.includes('🚀'.repeat(200))))
})
