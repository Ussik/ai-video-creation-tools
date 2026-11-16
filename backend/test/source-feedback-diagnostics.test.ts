import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { sourceFeedbackContext, diagnoseSourceFeedbackChecks, validateSourceFeedbackChecks, type SourceFeedbackCheck } from '../src/modules/script/script-source-feedback-review.js'
import { reviewSourceQuality } from '../src/modules/script/script-source-quality.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const content = '【淬骨：210/300】\n戏法师，身份未明。'
function fixture(count = 2) {
  const state = { id: 's', source_version: 'source', model_id: 'm', status: 'failed', error: null, updated_at: 'now', completed_chunks: 1, total_chunks: 1,
    sections: [{ offset: 0, length: content.length, title: '资料', episode_number: null, summary: '淬骨进度210/300。', characters: [], events: [], open_threads: [] }],
    story: { summary: '第八集淬骨进度为210/300。', characters: [], timeline: [], threads: [], ending: { summary: '身份未明。', section_ids: [0] }, uncertainties: [] },
    review_feedback: { id: 'feedback', text: Array.from({ length: count }, (_, i) => `${i + 1}. 核对第${i + 1}项。`).join('\n'),
      source_version: 'source', source_updated_at: 'now', model_id: 'm', configuration_hash: 'cfg' },
  } as ScriptSourceAnalysis
  const context = sourceFeedbackContext(state)!, units = scriptSourcePassages(content).flatMap(p => p.units)
  const valid = context.items.map(item => ({ item_id: item.id, disposition: 'resolved' as const, reason: '依据当前资料独立核对。', finding_indices: [],
    source_refs: [{ unit_id: units[0]!.id, quote: '淬骨：210/300' }], analysis_refs: [{ path: 'story.summary', quote: '淬骨进度为210/300' }] }))
  return { state, context, units, valid }
}

test('one feedback validation reports every independent ref error at exact indexed paths without changing evidence', () => {
  const { state, context, units, valid } = fixture()
  const checks: SourceFeedbackCheck[] = [{ ...valid[0]!, source_refs: [{ unit_id: units[0]!.id, quote: '淬骨210/300' },
    { unit_id: units[1]!.id, quote: '千面：戏法师' }], analysis_refs: [
      { path: 'sections[0].summary', quote: '第八集淬骨进度为210/300。' }, { path: 'story.summary', quote: '第八集...210/300。' }] },
    { ...valid[1]!, disposition: 'not_supported', source_refs: [], analysis_refs: [] }]
  const before = JSON.stringify({ state, checks })
  assert.throws(() => validateSourceFeedbackChecks(checks, context, state, units, [], true), error => {
    const text = (error as Error).message
    for (const path of ['$.feedback_checks[0].source_refs[0].quote', '$.feedback_checks[0].source_refs[1].quote',
      '$.feedback_checks[0].analysis_refs[0].quote', '$.feedback_checks[0].analysis_refs[1].quote',
      '$.feedback_checks[1].source_refs', '$.feedback_checks[1].analysis_refs']) assert.ok(text.includes(path), path)
    assert.match(text, /unit_id=0/); assert.match(text, /path=sections\[0\]\.summary/)
    assert.equal(text.split('\n').length, 6)
    assert.doesNotMatch(text, /千面：戏法师|第八集\.\.\./)
    return true
  })
  assert.equal(JSON.stringify({ state, checks }), before)
  validateSourceFeedbackChecks(valid, context, state, units, [], true)
})

test('partial schema diagnostics inspect only valid check shapes, preserve original array indexes and never infer invalid finding links', () => {
  const { state, context, units, valid } = fixture()
  const value = { findings: [{ kind: 'missing', unit_ids: [0] }], feedback_checks: [
    { item_id: context.items[0]!.id, source_refs: 'malformed' },
    { ...valid[1]!, disposition: 'issue', finding_indices: [0], source_refs: [{ unit_id: 0, quote: '淬骨210/300' }] }] }
  const before = JSON.stringify(value), issues = diagnoseSourceFeedbackChecks(value, context, state, units)
  assert.equal(issues.length, 1); assert.match(issues[0]!, /\$\.feedback_checks\[1\]\.source_refs\[0\]\.quote/)
  assert.ok(issues.every(issue => !issue.includes('finding_indices')))
  assert.equal(JSON.stringify(value), before)
  assert.deepEqual(diagnoseSourceFeedbackChecks({ feedback_checks: 'wrong' }, context, state, units), [])
})

test('diagnostic paths cannot echo arbitrary supplied targets and aggregate output has a fixed bound', () => {
  const { state, context, units, valid } = fixture(32)
  const sentinel = 'UNTRUSTED_TARGET_SENTINEL'
  const checks = valid.map(check => ({ ...check, source_refs: Array.from({ length: 12 }, (_, i) => ({ unit_id: i, quote: `bad-${i}` })),
    analysis_refs: [{ path: sentinel, quote: 'secret' }] }))
  const issues = diagnoseSourceFeedbackChecks({ feedback_checks: checks }, context, state, units)
  assert.equal(issues.length, 33); assert.match(issues.at(-1)!, /另有\d+项反馈引用问题/)
  assert.ok(issues.every(issue => !issue.includes(sentinel) && !issue.includes('secret') && !issue.includes('bad-')))
})

test('schema correction receives enum and all independent feedback business errors in the same bounded request', async () => {
  const { state, context, units, valid } = fixture()
  const payload = { checked_section_ids: [0], findings: [{ kind: 'missing', explanation: '需要核对进度。', unit_ids: [units[0]!.id] }],
    feedback_checks: [{ ...valid[0]!, source_refs: [{ unit_id: 99999 }],
      analysis_refs: [{ path: 'story.characters[99].description' }] }, { ...valid[1]!, source_refs: [], analysis_refs: [{ path: 'story.summary' }] }] }
  const original = JSON.stringify(state); let calls = 0, saves = 0, correction = ''
  await assert.rejects(reviewSourceQuality({ filename: 'synthetic.txt', content }, state, async prompt => {
    calls++
    if (calls === 2) { correction = prompt; return JSON.stringify({ ...payload, findings: payload.findings.map(f => ({ ...f, kind: 'omission' })) }) }
    return '```json\n' + JSON.stringify(payload) + '\n```'
  }, () => { saves++ }, new AbortController().signal), error => {
    const issue = error as Error & { code?: string; diagnostics?: string }
    assert.equal(issue.code, 'model_business_validation')
    assert.match(issue.diagnostics!, /\$\.feedback_checks\[0\]\.source_refs\[0\]\.unit_id/)
    assert.match(issue.diagnostics!, /\$\.feedback_checks\[0\]\.analysis_refs\[0\]\.path/)
    assert.match(issue.diagnostics!, /\$\.feedback_checks\[1\]\.source_refs/)
    return true
  })
  assert.equal(calls, 2); assert.equal(saves, 0); assert.equal(JSON.stringify(state), original)
  const diagnostics = correction.slice(correction.indexOf('【一次格式修正】'), correction.indexOf('上次输出是待修正资料'))
  assert.match(diagnostics, /\$\.findings\[0\]\.kind/)
  assert.match(diagnostics, /\$\.feedback_checks\[0\]\.source_refs\[0\]\.unit_id/)
  assert.match(diagnostics, /\$\.feedback_checks\[0\]\.analysis_refs\[0\]\.path/)
  assert.match(diagnostics, /\$\.feedback_checks\[1\]\.source_refs/)
  assert.ok(context.items.length === 2)
})

test('invalid-candidate diagnostics cannot mutate accepted candidates or bypass schema validation', async () => {
  let inspections = 0, validations = 0, calls = 0
  const schema = z.object({ kind: z.literal('valid'), text: z.string() }).strict()
  await assert.rejects(generateStructuredOutput('diagnostic_only_fixture', schema, async () => { calls++; return '{"kind":"invalid","text":"unchanged"}' }, '资料', {
    diagnoseInvalid(value) { inspections++; (value as { kind: string }).kind = 'valid'; return ['$.text: 补充定位'] },
    validate() { validations++ },
  }), error => {
    const issue = error as Error & { code?: string; raw_output?: string; diagnostics?: string }
    assert.equal(issue.code, 'model_field_contract'); assert.match(issue.raw_output!, /"kind":"invalid"/)
    assert.match(issue.diagnostics!, /补充定位/)
    return true
  })
  assert.equal(calls, 2); assert.equal(inspections, 2); assert.equal(validations, 0)
  inspections = 0
  const result = await generateStructuredOutput('valid_diagnostic_fixture', schema, async () => '{"kind":"valid","text":"accepted"}', '资料', {
    diagnoseInvalid() { inspections++; return [] }, validate() { validations++ },
  })
  assert.equal(result.text, 'accepted'); assert.equal(inspections, 0); assert.equal(validations, 1)
})

test('advisory inspection skips incomplete, recovered, unrelated and nested partial candidates', async () => {
  const schema = z.object({ kind: z.literal('valid'), text: z.string() }).strict()
  for (const raw of ['{"kind":"invalid","text":"truncated"', '{"other":{"kind":"invalid","text":"nested"}}',
    '[{"kind":"invalid","text":"array member"}]', 'not JSON']) {
    let inspections = 0
    await assert.rejects(generateStructuredOutput('complete_root_diagnostics_fixture', schema, async () => raw, '资料', {
      diagnoseInvalid() { inspections++; return ['$.text: must not inspect'] },
    }))
    assert.equal(inspections, 0, raw)
  }
})
