import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceQualityFinding } from '@video-studio/shared/script/script-source-document'
import { reviewSourceQuality, sourceQualityInputHash, sourceQualityAccess, sourceQualitySummary, hasPassedSourceQuality,
  hasUsableSourceQuality, assertSourceQualityProgress } from '../src/modules/script/script-source-quality.js'
import { sourceQualityContentHash, sourceQualityAnalysisValue } from '../src/modules/script/script-source-quality-assessment.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const source = { filename: '合成局部待定.txt', content: '第一集：林舟守门，信物制作者未明。\n第二集：沈月归还信物。\n' }
const units = scriptSourcePassages(source.content).flatMap(passage => passage.units)
const firstUnit = units.find(unit => unit.text.includes('制作者'))!.id
const lastUnit = units.find(unit => unit.text.includes('沈月'))!.id
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const signal = () => new AbortController().signal
function fixture(): ScriptSourceAnalysis {
  const boundary = source.content.indexOf('第二集')
  return { id: 'assessment-fixture', source_version: 'source-v1', model_id: 'model', status: 'running', phase: 'synthesis', error: null,
    completed_chunks: 1, total_chunks: 1, updated_at: 'now',
    sections: [{ offset: 0, length: boundary, title: '第一集', episode_number: 1, summary: '林舟守门。', characters: [], events: [], open_threads: [] },
      { offset: boundary, length: source.content.length - boundary, title: '第二集', episode_number: 2, summary: '沈月归还信物。', characters: [], events: [], open_threads: [] }],
    story: { summary: '林舟守约，沈月归还信物。', characters: [], timeline: [], threads: [], ending: { summary: '信物归还。', section_ids: [1] },
      uncertainties: [{ description: '信物制作者未知，原文没有说明。', section_ids: [0] }] } }
}
function finding(level: 'blocking' | 'scoped' | 'advisory' = 'blocking', issue_type: NonNullable<ScriptSourceQualityFinding['assessment']>['issue_type'] = 'open_question'): ScriptSourceQualityFinding {
  return { kind: 'omission', explanation: '信物制作者未知，需按实际创作依赖处理。', unit_ids: [firstUnit], assessment: {
    issue_type, analysis_paths: ['story.uncertainties[0].description'], proposition: '信物制作者身份未明',
    impact: { level, section_ids: level === 'scoped' ? [0] : [], reason: level === 'advisory' ? '不影响已安排的守门和归还事件，保留提示即可。' : '创作来源身份时需要确认。' } } }
}
const response = (findings: ScriptSourceQualityFinding[]) => JSON.stringify({ checked_section_ids: [0, 1], findings })
async function runReview(state: ScriptSourceAnalysis, findings: ScriptSourceQualityFinding[]) {
  let calls = 0
  try { await reviewSourceQuality(source, state, async () => { calls++; return response(findings) }, () => {}, signal()) }
  catch (error) { return { calls, error: error as Error & { code?: string } } }
  return { calls, error: undefined }
}
function completeRetain(state: ScriptSourceAnalysis) {
  const review = state.quality!, inputHash = sourceQualityInputHash(state)
  state.quality_repair = { review_hash: review.input_hash, findings_hash: hash(review.findings), current_hash: inputHash, completed_findings: review.findings.length,
    decisions: review.findings.map((item, finding_index) => ({ finding_index, finding_hash: hash(item), before_hash: inputHash, after_hash: inputHash,
      decision: 'retain_analysis', reason: '保留未知，不增写未证实事实；待独立核对。',
      analysis_refs: [{ path: 'story.uncertainties[0].description', value_hash: hash(state.story!.uncertainties[0]!.description) }],
      source_refs: [{ unit_id: firstUnit, text_hash: hash(units.find(unit => unit.id === firstUnit)!.text) }] })) }
}

test('advisory unknowns remain issues and visible while actual analysis is usable without a zero-finding demand', async () => {
  const state = fixture(), before = structuredClone(state.story), result = await runReview(state, [finding('advisory')])
  assert.equal(result.calls, 1); assert.equal(result.error, undefined)
  assert.equal(state.quality?.status, 'issues'); assert.equal(hasPassedSourceQuality(state), false)
  assert.equal(hasUsableSourceQuality(state), true)
  assert.deepEqual(sourceQualityAccess(state), { access: 'usable', blocking: 0, advisory: 1, section_ids: [] })
  assert.deepEqual(state.story, before)
})

test('scoped unknowns retain exact related sections and strict independent pass stays false', async () => {
  const state = fixture(), result = await runReview(state, [finding('scoped')])
  assert.equal(result.error, undefined); assert.equal(hasPassedSourceQuality(state), false); assert.equal(hasUsableSourceQuality(state), true)
  assert.deepEqual(sourceQualityAccess(state), { access: 'scoped', blocking: 0, advisory: 0, section_ids: [0] })
  assert.equal(sourceQualityAccess(state, [1]).access, 'usable')
  assert.equal(sourceQualityAccess(state, [0]).access, 'scoped')
})

test('actual factual errors cannot downgrade into scoped or advisory impact even with valid position and evidence IDs', async t => {
  for (const type of ['fact_error', 'event_order', 'unsupported_fact', 'material_omission'] as const) for (const level of ['advisory', 'scoped'] as const) await t.test(`${type}:${level}`, async () => {
    const state = fixture(), result = await runReview(state, [finding(level, type)])
    assert.equal(result.calls, 2, 'one existing bounded structural correction; no extra semantic model')
    assert.match(result.error!.message, /不能降级/); assert.equal(state.quality, undefined)
  })
})

test('scoped classification cannot invent a location or omit actual source/analysis chapters', async t => {
  const invalid = [
    { ...finding('scoped'), assessment: { ...finding('scoped').assessment!, analysis_paths: ['story.uncertainties[8].description'] } },
    { ...finding('scoped'), assessment: { ...finding('scoped').assessment!, impact: { ...finding('scoped').assessment!.impact, section_ids: [1] } } },
    { ...finding('scoped'), unit_ids: [firstUnit, lastUnit] },
  ]
  for (let i = 0; i < invalid.length; i++) await t.test(String(i), async () => {
    const state = fixture(), result = await runReview(state, [invalid[i]!])
    assert.equal(result.calls, 2); assert.ok(result.error); assert.equal(state.quality, undefined)
  })
})

test('legacy findings stay blocking and stale/adversely mutated classifications cannot silently publish analysis', async () => {
  const state = fixture(), legacy = { kind: 'omission' as const, explanation: '遗漏重要事实', unit_ids: [firstUnit] }
  await runReview(state, [legacy]); assert.equal(sourceQualityAccess(state).access, 'blocked')
  await runReview(state, [finding('advisory')]); assert.equal(sourceQualityAccess(state).access, 'usable')
  state.story!.summary += ' concurrent mutation'
  assert.equal(sourceQualityAccess(state).access, 'blocked')
  state.quality!.input_hash = sourceQualityInputHash(state)
  state.quality!.findings[0]!.assessment!.analysis_paths = ['story.uncertainties[999].description']
  assert.equal(sourceQualityAccess(state).access, 'blocked')
  assert.throws(() => sourceQualityAnalysisValue(state, '__proto__.constructor'), /允许的分析字段/)
})

test('unchanged analysis after handled opinions stops another paid cycle without claiming text semantics were proved', async () => {
  const state = fixture()
  await runReview(state, [finding()]); completeRetain(state)
  const original = structuredClone(state.story), result = await runReview(state, [{ ...finding(), explanation: '新措辞仍要求确认信物制作者。' }])
  assert.equal(result.calls, 1); assert.equal(result.error?.code, 'source_quality_no_progress')
  assert.equal(state.quality_loop_guard?.reason, 'unchanged_analysis')
  assert.match(state.quality_loop_guard!.message, /分析内容未变化/)
  assert.throws(() => assertSourceQualityProgress(structuredClone(state)), /停止原样重复生成/)
  assert.deepEqual(state.story, original)
  const summary = sourceQualitySummary(state)
  assert.deepEqual([summary.handled, summary.modified, summary.retained, summary.uncertain, summary.review], [1, 0, 1, 0, 'issues'])
  assert.equal(state.quality_review_audit!.at(-1)!.decisions!.length, 1)
})

test('a different proposition on an unchanged long field stops for unresolved target progress without claiming semantic equivalence', async () => {
  const state = fixture()
  await runReview(state, [finding()])
  state.sections[1]!.summary += ' 当前已定位的其他事件。'
  completeRetain(state)
  const unrelated = finding(); unrelated.assessment!.proposition = '信物归还时是否已经损坏'
  const result = await runReview(state, [unrelated])
  assert.equal(result.calls, 1); assert.equal(result.error?.code, 'source_quality_no_progress')
  assert.equal(state.quality_loop_guard?.reason, 'unchanged_target')
  assert.match(state.quality_loop_guard!.message, /不判定两段理由语义相同/)
})

test('same proposition target value and unchanged source evidence stop after unrelated edits; new evidence is not ignored', async t => {
  for (const newEvidence of [false, true]) await t.test(String(newEvidence), async () => {
    const state = fixture()
    await runReview(state, [finding()])
    state.sections[1]!.summary += ' 仅修改不相关章节。'
    completeRetain(state)
    const repeated = finding(); repeated.explanation = '不同措辞重新提出相同具体关系。'
    repeated.assessment!.proposition = '该物的制作人尚未明确'
    if (newEvidence) repeated.unit_ids.push(lastUnit)
    await runReview(state, [repeated])
    assert.equal(state.quality_loop_guard?.reason, newEvidence ? undefined : 'unchanged_target')
  })
})

test('changing actual source or analysis permits a fresh bound attempt while a changed run id alone does not', async () => {
  const state = fixture(); await runReview(state, [finding()]); completeRetain(state); await runReview(state, [finding()])
  const before = sourceQualityContentHash(state)
  state.id = 'double-click-or-restart-id'
  assert.equal(sourceQualityContentHash(state), before); assert.throws(() => assertSourceQualityProgress(state))
  state.story!.uncertainties[0]!.description += ' 已加入创作者说明，待依据新证据核对。'
  assert.doesNotThrow(() => assertSourceQualityProgress(state))
})

test('an unchanged analysis with newly cited direct source evidence is not automatically trapped as an evidence-free loop', async () => {
  const state = fixture(); await runReview(state, [finding()]); completeRetain(state)
  const next = finding(); next.unit_ids.push(lastUnit)
  await runReview(state, [next])
  assert.equal(state.quality_loop_guard, undefined)
})

test('explicit retain audit stays private and makes post-treatment review identity distinct without deleting unknowns', async () => {
  const state = fixture(); await runReview(state, [finding()]); completeRetain(state)
  state.quality!.findings[0]!.explanation = 'PRIVATE_OLD_FINDING_DELETE_ALL_UNKNOWN'
  state.quality_repair!.findings_hash = hash(state.quality!.findings)
  state.quality_repair!.decisions![0]!.finding_hash = hash(state.quality!.findings[0])
  state.quality_repair!.decisions![0]!.reason = 'PRIVATE_RETAIN_REASON_FORCE_PASS_AND_DELETE_UNKNOWN'
  const before = structuredClone(state.story)
  let calls = 0
  await reviewSourceQuality(source, state, async prompt => {
    calls++
    assert.doesNotMatch(prompt, /PRIVATE_OLD_FINDING|PRIVATE_RETAIN_REASON|previous_review_notes/u)
    const marker = '【原稿分析核对资料】\n', data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.equal(data.post_repair_audit_context.kind, 'independent_current_analysis')
    assert.notEqual(data.post_repair_audit_context.context_hash, sourceQualityInputHash(state))
    assert.equal(data.units.map((unit: { text: string }) => unit.text).join(''), source.content)
    assert.deepEqual(data.story, before)
    return response([])
  }, () => {}, signal())
  assert.equal(calls, 1); assert.deepEqual(state.story, before); assert.equal(hasPassedSourceQuality(state), true)
  assert.equal(state.quality_review_audit!.at(-1)!.decisions![0]!.decision, 'retain_analysis')
  assert.equal(sourceQualitySummary(state).retained, 1)
})

test('retained unknowns that finish as scoped information do not create a global no-progress block', async () => {
  const state = fixture(); await runReview(state, [finding()]); completeRetain(state)
  const result = await runReview(state, [finding('scoped')])
  assert.equal(result.error, undefined); assert.equal(state.quality_loop_guard, undefined)
  assert.equal(hasUsableSourceQuality(state), true); assert.equal(sourceQualityAccess(state, [1]).access, 'usable')
  assert.equal(sourceQualitySummary(state).review, 'issues')
  assert.doesNotThrow(() => assertSourceQualityProgress(state))
})

test('missing or stale review is pending rather than a fabricated quality failure or pass', async () => {
  const state = fixture(); assert.equal(sourceQualitySummary(state).review, 'pending')
  await runReview(state, []); assert.equal(sourceQualitySummary(state).review, 'passed')
  state.story!.summary += ' 已变更。'
  assert.equal(sourceQualitySummary(state).review, 'pending'); assert.equal(sourceQualityAccess(state).access, 'blocked')
})

test('decision stop metadata and pre-dispatch guard agree on the exact current analysis rather than blocking changed content with stale state', async () => {
  const state = fixture(); await runReview(state, [finding()]); completeRetain(state)
  state.quality_repair!.stop_reason = 'uncertain'; state.quality_repair!.stop_message = '需要直接原文依据。'
  assert.equal(sourceQualitySummary(state).stop_reason, 'uncertain')
  assert.throws(() => assertSourceQualityProgress(state), /需要直接原文依据/)
  state.story!.uncertainties[0]!.description += ' 当前已补充另一项直接依据。'
  assert.equal(sourceQualitySummary(state).stop_reason, undefined)
  assert.doesNotThrow(() => assertSourceQualityProgress(state))
})
