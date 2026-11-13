import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolutionContext, type FindingResolutionRecord } from '../src/modules/script/script-finding-state.js'
import { scriptDraftReviewHistory, scriptDraftReviewHistoryGuidance } from '../src/modules/script/script-draft-review-history.js'

test('verified decisions retain complete dependency evidence for arbitrary wording', () => {
  for (const decision of ['照刚才讲的办', '是的就这么定', '采用方案二', '名单容量十七位，只有主角可以撤掉神位。']) {
    const context = { resolved_findings: { decisions: [{ id: 'capacity', source_key: 'world', status: 'verified', decision,
      problem: '方案一增加容量；方案二撤掉现有神位。', summary_id: 'batch', future_evidence: { version: 'v4' } }],
      summaries: [{ id: 'batch', text: '创作者采用的具体方案与完整问答。' }, { id: 'other', text: '另一个文档里的依赖资料。' }] } }
    const before = structuredClone(context)
    assert.equal(scriptDraftReviewHistory(context), context)
    assert.deepEqual(context, before)
    assert.equal(scriptDraftReviewHistory(scriptDraftReviewHistory(context)), context)
  }
})

test('many verified records keep their original problems, summaries, adopted rules and unknown fields', () => {
  const records: FindingResolutionRecord[] = Array.from({ length: 83 }, (_, index) => ({ id: `issue-${index}`, topic: `事项${index}`,
    source_key: 'world', kind: 'contradiction', strategy: 'ai', answer: '', attempts: 2,
    decision: `第${index}项采用的完整具体规则：保留原定人物、数量与结局。`,
    status: index === 82 ? 'still_open' : 'verified', problem: `第${index}项的历史缺陷描述。` + '当时的因果核对记录。'.repeat(80),
    summary: `第${index}批的旧修补摘要。` + '此前尚未采用的新规则不代表当前决定。'.repeat(50) }))
  const history = resolutionContext(records), context = { resolved_findings: history, extra: { preserve: true } }
  const before = structuredClone(context)
  assert.equal(scriptDraftReviewHistory(context), context)
  assert.deepEqual(context, before)
})

test('complete manuscript, conversations, constraints and unfamiliar history shapes remain unchanged', () => {
  for (const history of [undefined, null, 'history', [], {}, { decisions: [], summaries: [] },
    { decisions: [{ status: 'verified', decision: '规则', summary_id: { future: true } }], summaries: [null] }]) {
    const context = { uploaded_script: { content: '完整原稿。'.repeat(20_000) },
      creator_messages: [{ role: 'user', text: '照刚才讲的办', reference_documents: [{ content: '原方案全文' }] }],
      confirmed_decisions: [{ content: '不得新增神位' }], resolved_findings: history }
    assert.equal(scriptDraftReviewHistory(context), context)
  }
  for (const context of [undefined, null, 'context', []]) assert.equal(scriptDraftReviewHistory(context), context)
})

test('history guidance asks semantic review to distinguish defects, adopted decisions and dependency evidence', () => {
  assert.match(scriptDraftReviewHistoryGuidance, /历史问题.*problem/)
  assert.match(scriptDraftReviewHistoryGuidance, /批次修补摘要.*summaries/)
  assert.match(scriptDraftReviewHistoryGuidance, /status 为 verified.*decision/)
  assert.match(scriptDraftReviewHistoryGuidance, /没有具体 decision.*不能.*推定答案/)
  assert.match(scriptDraftReviewHistoryGuidance, /结合保留的完整历史理解/)
  assert.match(scriptDraftReviewHistoryGuidance, /不能仅凭数组顺序推定先后/)
})
