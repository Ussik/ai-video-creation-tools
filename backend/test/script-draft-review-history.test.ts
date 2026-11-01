import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolutionContext, type FindingResolutionRecord } from '../src/modules/script/script-finding-state.js'
import { scriptDraftReviewHistory, scriptDraftReviewHistoryGuidance } from '../src/modules/script/script-draft-review-history.js'

type History = { decisions: Array<Record<string, unknown>>; summaries: Array<Record<string, unknown>> }
const project = (resolved_findings: unknown) => scriptDraftReviewHistory({ resolved_findings }) as { resolved_findings: History }

test('verified concrete decisions retain adopted rules and unknown fields while omitting retired defects and batch summaries', () => {
  const decision = { id: 'capacity', topic: '神位容量', source_key: 'world', kind: 'contradiction', strategy: 'manual',
    answer: '十七个位置已满，不增加新位置。', decision: '十七个位置已满，主角撤掉现有神位。', status: 'verified', attempts: 3,
    problem: '旧问题曾建议增加第十八个位置。', summary_id: 'old-batch', future_evidence: { version: 'v4' } }
  const history = { decisions: [decision], summaries: [{ id: 'old-batch', text: '当时的批次摘要含有已被新决定替代的旧方案。' }],
    future_history: { retain: true } }
  const result = project(history).resolved_findings
  const { problem: _problem, summary_id: _summaryId, ...adopted } = decision
  assert.deepEqual(result.decisions, [adopted])
  assert.deepEqual(result.summaries, [])
  assert.deepEqual(result.future_history, history.future_history)
  assert.equal(result.decisions[0]!.future_evidence, decision.future_evidence)
  assert.equal(history.decisions[0]!.problem, decision.problem)
  assert.equal(history.summaries.length, 1)
})

test('active and legacy records stay complete and retain every summary they still reference', () => {
  const verified = { id: 'complete', status: 'verified', decision: '保留当前结局。', problem: '旧结局问题', summary_id: 'completed-only' }
  const preserved = [
    { id: 'addressed', status: 'addressed', decision: '损失一天记忆。', problem: '正文尚未核实', summary_id: 'shared' },
    { id: 'open', status: 'still_open', decision: '沿用已定触发条件。', answer: '不要重新选择', problem: '触发条件尚未落实', summary_id: 'shared' },
    { id: 'legacy', status: 'verified', answer: '只选择原方案二', problem: '旧记录没有具体决定', summary_id: 'legacy' },
    { id: 'empty', status: 'verified', decision: '', problem: '答案为空', summary_id: 'blank' },
    { id: 'whitespace', status: 'verified', decision: ' \n\t ', problem: '答案只有空白', summary_id: 'blank' },
    { id: 'future', status: 'future_status', decision: '未知流程状态中的决定', problem: '应保留未知记录', summary_id: 'future' },
  ]
  const summaries = ['completed-only', 'shared', 'legacy', 'blank', 'future', 'orphan'].map(id => ({ id, text: `${id}完整摘要`, extra: { keep: id } }))
  const result = project({ decisions: [verified, ...preserved], summaries }).resolved_findings
  assert.deepEqual(result.decisions.slice(1), preserved)
  for (const [index, item] of preserved.entries()) assert.equal(result.decisions[index + 1], item)
  assert.deepEqual(result.summaries, summaries.filter(item => ['shared', 'legacy', 'blank', 'future'].includes(item.id)))
  assert.equal(result.summaries[0], summaries[1], 'a retained shared batch summary remains complete, including unknown fields')
})

test('a shared summary survives when a legacy record still references it after verified records are compacted', () => {
  const records: FindingResolutionRecord[] = [
    { id: 'verified', topic: '记忆代价', source_key: 'world', kind: 'contradiction', strategy: 'manual', answer: '损失一天',
      summary: '批次处理摘要：候选稿已修补，另一项仍待核对。', attempts: 1, decision: '每次使用损失一天记忆。', status: 'verified', problem: '旧规则冲突' },
    { id: 'legacy', source_key: 'foreshadowing', kind: 'missing_core_setting', strategy: 'ai', answer: '',
      summary: '批次处理摘要：候选稿已修补，另一项仍待核对。', attempts: 1, status: 'verified', problem: '旧记录尚无逐项具体决定' },
  ]
  const original = resolutionContext(records), result = project(original).resolved_findings
  assert.equal(Object.hasOwn(result.decisions[0]!, 'problem'), false)
  assert.equal(Object.hasOwn(result.decisions[0]!, 'summary_id'), false)
  assert.deepEqual(result.decisions[1], original.decisions[1])
  assert.deepEqual(result.summaries, original.summaries)
})

test('reference-only verified decisions and answers retain the problem and every referenced summary', () => {
  const expressions = ['采用方案二', '按上述规则执行', '同上', '沿用原方案', '选择第二项', '按你的建议',
    '按照你说的处理', '确认第 2 条', '第二项。', 'Use option B', '沿用旧规则', '按原样执行', '采用这一方案',
    '采用方案二：每次使用损失一天记忆。']
  const records = expressions.flatMap((expression, index) => ['decision', 'answer'].map(field => ({
    id: `${field}-${index}`, status: 'verified', decision: '每次使用铜钥匙损失一天记忆，无法恢复。', answer: '',
    [field]: expression, problem: '方案一不付代价；方案二每次使用铜钥匙损失一天记忆。', summary_id: `batch-${index}`,
  })))
  const summaries = expressions.map((_, index) => ({ id: `batch-${index}`, text: `第${index}批保留原始方案含义。`, extra: { keep: true } }))
  const context = { resolved_findings: { decisions: records, summaries }, creator_messages: [] }
  const before = structuredClone(context)
  const result = scriptDraftReviewHistory(context)
  assert.equal(result, context, 'unchanged reference-dependent history retains its original context identity')
  assert.equal(scriptDraftReviewHistory(result), result, 'repeated projection keeps the same identity')
  assert.deepEqual(context, before)
  for (const [index, record] of records.entries()) assert.equal(context.resolved_findings.decisions[index], record)
  assert.equal(context.resolved_findings.summaries, summaries)
})

test('reference-dependent history stays complete alongside compacted concrete long rules, with stable repeated projection', () => {
  const reference = { id: 'reference', status: 'verified', decision: '沿用原方案', answer: '',
    problem: '原方案：撤掉现有神位，不增加第十八个位置。', summary_id: 'referenced' }
  const content = '十七个位置已满，主角只能撤掉现有神位。每次使用铜钥匙会损失一天记忆；损失不可恢复，其他人物不能代付。'.repeat(30)
  const concrete = { id: 'concrete', status: 'verified', decision: content, answer: '损失一天记忆且不可恢复。',
    problem: '历史问题中曾考虑取消记忆代价。'.repeat(50), summary_id: 'retired' }
  const summaries = [{ id: 'referenced', text: '原方案的完整定义与原始问答保留。' }, { id: 'retired', text: '已落实具体规则的旧修补过程。' }]
  const context = { resolved_findings: { decisions: [reference, concrete], summaries } }
  const before = structuredClone(context), result = scriptDraftReviewHistory(context) as typeof context
  assert.notEqual(result, context)
  assert.equal(result.resolved_findings.decisions[0], reference)
  const { problem: _problem, summary_id: _summaryId, ...retainedRule } = concrete
  assert.deepEqual(result.resolved_findings.decisions[1], retainedRule)
  assert.equal(result.resolved_findings.decisions[1]!.decision, content, 'the complete long rule remains byte-for-byte intact')
  assert.deepEqual(result.resolved_findings.summaries, [summaries[0]])
  assert.equal(result.resolved_findings.summaries[0], summaries[0])
  assert.equal(scriptDraftReviewHistory(result), result, 'the first projection removes all safe prose; later calls are no-ops')
  assert.deepEqual(context, before, 'canonical history remains unchanged')
})

test('unrecognized history and summary reference shapes are preserved conservatively', () => {
  const complete = { id: 'known', status: 'verified', decision: '当前已定规则', problem: '旧问题', summary_id: 'batch' }
  for (const history of [undefined, null, 'history', [], {},
    { decisions: [complete] }, { decisions: {}, summaries: [] }, { decisions: [], summaries: {} },
    { decisions: [complete, 'unknown-entry'], summaries: [{ id: 'batch', text: '摘要' }] },
    { decisions: [complete, { summary_id: { key: 'future-reference' } }], summaries: [{ id: 'batch', text: '摘要' }] },
    { decisions: [complete], summaries: [{ id: 'batch', content: '未知摘要正文格式' }] },
    { decisions: [complete], summaries: [null] },
  ]) {
    const context = { resolved_findings: history, future_constraint: { text: '保留未识别资料' } }
    const before = structuredClone(context), result = scriptDraftReviewHistory(context) as typeof context
    assert.equal(result, context)
    assert.equal(result.resolved_findings, history)
    assert.deepEqual(result, before)
    assert.deepEqual(context, before)
  }
  for (const context of [undefined, null, 'context', []]) assert.equal(scriptDraftReviewHistory(context), context)
})

test('manuscript, full-story understanding, conversation, references and current constraints are not truncated or rewritten', () => {
  const content = '原稿首句\r\n' + '十七个位置已满，保留所有人物与因果。'.repeat(6000) + '\n原稿结局。'
  const context = { project: { name: '完整作品', brief: '结局不得改变' },
    uploaded_script: { content, analysis: { source_version: 'same-source', story: { summary: '完整全剧理解。'.repeat(500),
      characters: [{ name: '林舟', description: '人物完整描述。'.repeat(500) }] } } },
    creator_messages: [{ role: 'assistant', text: '方案一改变结局；方案二保留原结局与容量。'.repeat(1000) },
      { role: 'user', text: '采用方案二，仍保留最初确定的人物目标。', reference_documents: [{ key: 'original', content }] }],
    saved_documents: [{ id: 'saved', content }], confirmed_decisions: [{ content: '不得新增神位', source_text: '原始用户决定' }],
    requested_settings: { episode_count: 60 }, current_settings: { episode_count: 60 }, task_scope: { stage: 'outline' },
    future_constraint: { content: '未知创作资料仍保留。'.repeat(300) },
    resolved_findings: { decisions: [{ id: 'known', status: 'verified', decision: '原稿结局不变。', problem: '此前的旧问题', summary_id: 'batch' }],
      summaries: [{ id: 'batch', text: '历史批次摘要' }] } }
  const before = structuredClone(context), result = scriptDraftReviewHistory(context) as typeof context
  assert.notEqual(result, context)
  const { resolved_findings: _history, ...materials } = context
  for (const key of Object.keys(materials) as Array<keyof typeof materials>) {
    assert.equal(result[key], context[key], `${key} retains its original complete content`)
  }
  assert.deepEqual(context, before, 'projecting a wire context cannot mutate canonical inputs or persisted history')
  assert.deepEqual(scriptDraftReviewHistory(result), result, 'the projection is stable when applied again')
  assert.equal(scriptDraftReviewHistory(result), result, 'a no-op projection preserves canonical prompt identity')
})

test('many verified records omit historical prose without deleting any concrete adopted decision', () => {
  const records: FindingResolutionRecord[] = Array.from({ length: 83 }, (_, index) => ({ id: `issue-${index}`, topic: `事项${index}`,
    source_key: 'world', kind: 'contradiction', strategy: 'ai', answer: '', attempts: 2,
    decision: `第${index}项采用的完整具体规则：保留原定人物、数量与结局。`,
    status: index === 82 ? 'still_open' : 'verified', problem: `第${index}项的历史缺陷描述。` + '当时的因果核对记录。'.repeat(80),
    summary: `第${index}批的旧修补摘要。` + '此前尚未采用的新规则不代表当前决定。'.repeat(50) }))
  const history = resolutionContext(records), result = project(history).resolved_findings
  assert.equal(result.decisions.length, records.length)
  assert.deepEqual(result.decisions.map(item => item.decision), history.decisions.map(item => item.decision))
  assert.deepEqual(result.decisions[82], history.decisions[82])
  assert.deepEqual(result.summaries, history.summaries.filter(summary => summary.id === history.decisions[82]!.summary_id))
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(history)), 'historical process prose is omitted from this fixture')
})

test('history guidance separates historical defects from adopted decisions without inventing answers for legacy records', () => {
  assert.match(scriptDraftReviewHistoryGuidance, /历史问题.*problem/)
  assert.match(scriptDraftReviewHistoryGuidance, /批次修补摘要.*summaries/)
  assert.match(scriptDraftReviewHistoryGuidance, /status 为 verified.*decision/)
  assert.match(scriptDraftReviewHistoryGuidance, /没有具体 decision.*不能.*推定答案/)
  assert.match(scriptDraftReviewHistoryGuidance, /同一事项.*明确采用时间依据.*较晚具体决定/)
  assert.match(scriptDraftReviewHistoryGuidance, /不能仅凭数组顺序推定先后/)
  assert.match(scriptDraftReviewHistoryGuidance, /不能.*重新发明事实/)
})
