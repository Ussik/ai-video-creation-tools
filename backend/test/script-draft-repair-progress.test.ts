import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceScriptDraftRepair, assessScriptDraftRepairProgress } from '../src/modules/script/script-draft-repair-progress.js'
import type { ScriptDraftRepairHistory } from '../src/modules/script/script-draft-repair-progress.js'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import { findingIdentity, type FindingResolutionRecord } from '../src/modules/script/script-finding-state.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const draft = (content: string): WorkflowDraft => ({ stage: 'outline', scope: 'project', episode_number: 0,
  artifacts: [{ artifact_type: 'outline', title: '故事', content }], scenes: [] })

test('identical text remains available for continued review with a no-change diagnostic', () => {
  const result = advanceScriptDraftRepair(draft('甲'), draft('甲'), '原文', '原文')
  assert.equal(result.diagnostic, 'unchanged')
  assert.equal(result.states.length, 1)
})

test('source changes count as progress and repeated states produce diagnostics without blocking continuation', () => {
  const first = advanceScriptDraftRepair(draft('甲'), draft('乙'), '原文', '原文')
  assert.equal(advanceScriptDraftRepair(draft('乙'), draft('甲'), '原文', '原文', first).diagnostic, 'repeated')
  assert.equal(advanceScriptDraftRepair(draft('乙'), draft('甲'), '原文', '原文').states.length, 2, 'a new authorization starts its own history')
  const second = advanceScriptDraftRepair(draft('乙'), draft('乙'), '原文', '修订原文', first)
  assert.equal(second.states.length, 3)
  assert.equal(second.diagnostic, undefined)
})

const finding = (issue: string, source_key = 'outline'): ScriptDraftFinding => ({ issue_id: issue, source_key,
  topic: issue, kind: 'contradiction', quote: '甲', explanation: `${issue} 尚未落实`, suggestion: `落实 ${issue}` })
const resolution = (item: ScriptDraftFinding): FindingResolutionRecord => ({ id: findingIdentity(item), source_key: item.source_key,
  kind: item.kind, problem: item.explanation, strategy: 'ai', answer: '', decision: '保留原稿中的人物身份',
  summary: '已作最小修改', attempts: 1, status: 'still_open' })
const issue = finding('人物身份')
const assess = (before: string, after: string, extra: Partial<Parameters<typeof assessScriptDraftRepairProgress>[0]> = {}) =>
  assessScriptDraftRepairProgress({ before: draft(before), after: draft(after), beforeFindings: [{ ...issue, quote: before }], findings: [{ ...issue, quote: after }],
    resolutions: [resolution(issue)], ...extra })

test('a completed semantic review accepts unchanged text and never requests a repair', () => {
  const result = assess('甲', '甲', { findings: [] })
  assert.equal(result.action, 'complete')
  assert.deepEqual(result.retry_findings, [])
  assert.deepEqual(result.decision_findings, [])
})

test('an unchanged candidate with the same exact issue changes method instead of repeating its patch', () => {
  const result = assess('甲', '甲')
  assert.equal(result.action, 'change_strategy')
  assert.equal(result.reason, 'unchanged')
  assert.equal(result.history.strategy, 'decision_reconciliation')
  assert.match(result.instruction!, /具体决定/)
  assert.match(result.instruction!, /不得重放相同补丁/)
  assert.deepEqual(result.retry_findings, [issue])
  assert.deepEqual(result.history.strategy_issue_ids, ['人物身份'])
})

test('only a repeated completed review after reconciliation requires a concrete decision', () => {
  const first = assess('甲', '甲')
  const history = JSON.parse(JSON.stringify(first.history)) as ScriptDraftRepairHistory
  const result = assess('甲', '甲', { history })
  assert.equal(result.action, 'needs_decision')
  assert.equal(result.reason, 'decision_conflict')
  assert.deepEqual(result.retry_findings, [])
  assert.deepEqual(result.decision_findings, [issue])
  assert.match(result.message, /候选稿和已有决定已保留/)
})

test('A to B to A with the same exact issue is a cycle even when every patch changes text', () => {
  const first = assess('甲', '乙')
  assert.equal(first.action, 'continue')
  const second = assess('乙', '甲', { history: first.history })
  assert.equal(second.action, 'change_strategy')
  assert.equal(second.reason, 'cycle')
  assert.equal(second.history.reviews!.length, 2)
})

test('actual cited text and resolved issues progress while unrelated manuscript changes do not', () => {
  assert.equal(assess('甲', '乙').action, 'continue')
  const manuscriptOnly = assess('甲', '甲', { beforeSource: '原稿', afterSource: '修订稿' })
  assert.equal(manuscriptOnly.action, 'change_strategy')
  assert.deepEqual(manuscriptOnly.evidence_changed_issue_ids, [])
  const other = finding('结局')
  const result = assess('甲', '甲', { beforeFindings: [issue, other], findings: [issue], resolutions: [resolution(issue), resolution(other)] })
  assert.equal(result.action, 'continue', 'fewer unresolved issues is actual progress even without text changes')
})

test('wording changes cannot disguise the same exact issue, but do not broaden its authorization', () => {
  const reworded = { ...issue, explanation: '请再次核对这个人物的身份', suggestion: '同步相关段落' }
  assert.equal(assess('甲', '甲', { findings: [reworded] }).action, 'change_strategy')
  const independent = { ...reworded, issue_id: '新增独立身份问题' }
  const result = assess('甲', '甲', { findings: [independent] })
  assert.equal(result.action, 'needs_decision')
  assert.equal(result.reason, 'new_decision')
  assert.deepEqual(result.retry_findings, [])
  assert.deepEqual(result.decision_findings, [independent])
})

test('a similar topic in a different source cannot borrow another source authorization', () => {
  const original = { ...issue, issue_id: undefined }
  const independent = { ...original, source_key: 'background' }
  const result = assess('甲', '乙', { beforeFindings: [original], findings: [independent], resolutions: [resolution(original)] })
  assert.equal(result.action, 'needs_decision')
  assert.deepEqual(result.retry_findings, [])
})

test('new independent decisions leave unrelated authorized work schedulable', () => {
  const independent = finding('新增伏笔答案', 'foreshadowing')
  const current = { ...issue, quote: '乙' }
  const result = assess('甲', '乙', { findings: [independent, current] })
  assert.equal(result.action, 'needs_decision')
  assert.deepEqual(result.decision_findings, [independent])
  assert.deepEqual(result.retry_findings, [current])
  assert.deepEqual(result.stalled_findings, [])
})

test('a reconciliation conflict does not stop another exact issue from changing strategy', () => {
  const other = finding('结局')
  const result = assess('甲', '甲', { beforeFindings: [issue, other], findings: [issue, other],
    resolutions: [resolution(issue), resolution(other)], history: { states: [], strategy: 'decision_reconciliation', strategy_issue_ids: [findingIdentity(issue)] } })
  assert.equal(result.action, 'needs_decision')
  assert.deepEqual(result.decision_findings, [issue])
  assert.deepEqual(result.retry_findings, [other])
  assert.match(result.instruction!, /逐项对照/)
})

test('a fresh authorization starts from its own strategy and preserves explicit creator decisions', () => {
  const stalled = assess('甲', '甲')
  const fresh = assess('甲', '甲')
  assert.equal(fresh.action, 'change_strategy')
  assert.equal(stalled.history.strategy, 'decision_reconciliation')
  assert.equal(fresh.history.strategy, 'decision_reconciliation')
  const records = [resolution(issue)]
  const snapshot = JSON.stringify(records)
  assess('甲', '乙', { resolutions: records })
  assert.equal(JSON.stringify(records), snapshot, 'the scheduler must not mutate an authorization or create a decision')
})

test('legitimate improving work has no fixed round quota and long cycles remain detectable', () => {
  let history: ScriptDraftRepairHistory | undefined
  for (let index = 0; index < 40; index++) {
    const result = assess(`正文 ${index}`, `正文 ${index + 1}`, { history })
    assert.equal(result.action, 'continue')
    history = result.history
  }
  const cycle = assess('正文 40', '正文 0', { history })
  assert.equal(cycle.action, 'change_strategy')
  assert.equal(cycle.reason, 'cycle')
  assert.equal(cycle.history.states.length, 41)
})

test('patch advancement keeps durable strategy and semantic checkpoints intact', () => {
  const first = assess('甲', '甲')
  const advanced = advanceScriptDraftRepair(draft('甲'), draft('乙'), undefined, undefined, first.history)
  assert.equal(advanced.strategy, 'decision_reconciliation')
  assert.deepEqual(advanced.reviews, first.history.reviews)
  assert.equal(advanced.diagnostic, undefined)
})

test('reordering document navigation cannot disguise unchanged candidate text', () => {
  const before = draft('甲')
  before.artifacts.push({ artifact_type: 'synopsis', title: '简述', content: '乙' })
  const after = { ...before, artifacts: [...before.artifacts].reverse() }
  const result = assessScriptDraftRepairProgress({ before, after, beforeFindings: [issue], findings: [issue], resolutions: [resolution(issue)] })
  assert.equal(result.action, 'change_strategy')
  assert.equal(result.reason, 'unchanged')
})

const evidenceFinding = (quote = '身份尚未明确', extra: Partial<ScriptDraftFinding> = {}): ScriptDraftFinding => ({ ...issue, quote, ...extra })
const assessEvidence = (before: string, after: string, extra: Partial<Parameters<typeof assessScriptDraftRepairProgress>[0]> = {}) =>
  assessScriptDraftRepairProgress({ before: draft(before), after: draft(after), beforeFindings: [evidenceFinding()], findings: [evidenceFinding()],
    resolutions: [resolution(evidenceFinding())], ...extra })

test('six unique unrelated notes cannot keep the same unresolved evidence in continue', () => {
  let history: ScriptDraftRepairHistory | undefined
  for (let index = 0; index < 6; index++) {
    const result = assessEvidence(`身份尚未明确\n无关附注${index}`, `身份尚未明确\n无关附注${index + 1}`, { history })
    assert.equal(result.action, index === 0 ? 'change_strategy' : 'needs_decision')
    assert.deepEqual(result.evidence_changed_issue_ids, []); assert.deepEqual(result.resolved_issue_ids, [])
    assert.equal(result.history.reviews!.length, 1, 'unrelated bytes do not create novel issue review states')
    history = JSON.parse(JSON.stringify(result.history))
  }
})

test('edits on both sides of unchanged evidence cannot create a broad diff-envelope false positive', () => {
  const result = assessEvidence('旧前注\n身份尚未明确\n旧尾注', '新前注\n身份尚未明确\n新尾注')
  assert.equal(result.action, 'change_strategy'); assert.deepEqual(result.evidence_changed_issue_ids, [])
})

test('a title or another document changing does not advance the cited issue', () => {
  const before = draft('身份尚未明确'), after = draft('身份尚未明确')
  before.artifacts.push({ artifact_type: 'synopsis', title: '摘要', content: '旧附注' })
  after.artifacts.push({ artifact_type: 'synopsis', title: '新摘要', content: '新附注' })
  after.artifacts[0]!.title = '新标题'
  const result = assessEvidence('', '', { before, after })
  assert.equal(result.action, 'change_strategy'); assert.deepEqual(result.evidence_changed_issue_ids, [])
})

test('a reviewer choosing a new or wider preexisting quote cannot reset convergence', () => {
  const before = '身份尚未明确；另一处身份也未明确。\n旧附注', after = before.replace('旧附注', '新附注')
  for (const quote of ['另一处身份也未明确', '身份尚未明确；另一处身份也未明确。']) {
    const result = assessEvidence(before, after, { findings: [evidenceFinding(quote)] })
    assert.equal(result.action, 'change_strategy'); assert.deepEqual(result.evidence_changed_issue_ids, [])
  }
})

test('real edits to exact unique cited evidence are a new attempt, never a resolved issue', () => {
  const current = evidenceFinding('身份已具体但另一条件待核实')
  const result = assessEvidence('身份尚未明确\n其他事实保留', '身份已具体但另一条件待核实\n其他事实保留', { findings: [current] })
  assert.equal(result.action, 'continue')
  assert.deepEqual(result.evidence_changed_issue_ids, [findingIdentity(current)])
  assert.deepEqual(result.resolved_issue_ids, []); assert.deepEqual(result.retry_findings, [current])
  assert.match(result.message, /证据变化不代表问题已解决/)
})

test('whitespace edits inside evidence cannot manufacture a new attempt state', () => {
  const result = assessEvidence('身份尚未明确', '身 份 尚 未 明 确', { findings: [evidenceFinding('身 份 尚 未 明 确')] })
  assert.equal(result.action, 'change_strategy'); assert.equal(result.reason, 'unchanged')
})

test('an independently reviewed proper subset of unresolved sites preserves partial progress', () => {
  const beforeIssue = evidenceFinding('身份尚未明确', { related_findings: [{ source_key: 'outline', quote: '代价仍不明确', explanation: '另一处', suggestion: '同步' }] })
  const content = '身份尚未明确\n代价仍不明确'
  const result = assessEvidence(content, content, { beforeFindings: [beforeIssue] })
  assert.equal(result.action, 'continue')
  assert.deepEqual(result.reduced_evidence_issue_ids, [findingIdentity(beforeIssue)])
  assert.deepEqual(result.resolved_issue_ids, []); assert.deepEqual(result.evidence_changed_issue_ids, [])
})

test('reordering, duplicating or rewording related reports does not count as fewer unresolved sites', () => {
  const related = { source_key: 'outline', quote: '代价仍不明确', explanation: '另一处', suggestion: '同步' }
  const original = evidenceFinding('身份尚未明确', { related_findings: [related] })
  const current = evidenceFinding('代价仍不明确', { related_findings: [
    { ...related, quote: '身份尚未明确', explanation: '换了措辞' }, { ...related, quote: '身份尚未明确' },
  ] })
  const content = '身份尚未明确\n代价仍不明确'
  const result = assessEvidence(content, content, { beforeFindings: [original], findings: [current] })
  assert.equal(result.action, 'change_strategy'); assert.deepEqual(result.reduced_evidence_issue_ids, [])
})

test('unbound or ambiguous quotes cannot receive a progress allowance from arbitrary text changes', () => {
  for (const [before, after, quote] of [
    ['正文', '正文改过', '根本不在正文'], ['身份尚未明确\n身份尚未明确', '身份尚未明确\n身份尚未明确\n新注', '身份尚未明确'],
    ['aaa', 'aaa\n新注', 'aa'],
  ]) {
    const item = evidenceFinding(quote)
    const result = assessEvidence(before!, after!, { beforeFindings: [item], findings: [item] })
    assert.equal(result.action, 'change_strategy'); assert.deepEqual(result.evidence_changed_issue_ids, [])
  }
})

test('quote changes cannot consume an unrelated authorization or skip a newly discovered independent issue', () => {
  const independent = evidenceFinding('身份已明确', { issue_id: 'new-independent', topic: '新的独立命题' })
  const result = assessEvidence('身份尚未明确', '身份已明确', { findings: [independent] })
  assert.equal(result.action, 'needs_decision'); assert.equal(result.reason, 'new_decision')
  assert.deepEqual(result.retry_findings, []); assert.deepEqual(result.decision_findings, [independent])
})

test('one independently resolved issue allows remaining authorized work without marking it resolved', () => {
  const other = evidenceFinding('另一问题', { issue_id: 'other', topic: '另一问题' })
  const content = '身份尚未明确\n另一问题'
  const result = assessEvidence(content, content, { beforeFindings: [evidenceFinding(), other], resolutions: [resolution(evidenceFinding()), resolution(other)] })
  assert.equal(result.action, 'continue'); assert.deepEqual(result.resolved_issue_ids, ['other'])
  assert.deepEqual(result.retry_findings, [evidenceFinding()])
  const next = assessEvidence(content, content, { history: result.history })
  assert.equal(next.action, 'change_strategy', 'past partial progress cannot fund another unchanged pass')
})

test('partial issue progress cannot mask another stalled issue or its reconciliation conflict', () => {
  const other = evidenceFinding('另一问题', { issue_id: 'other', topic: '另一问题' })
  const before = '身份尚未明确\n另一问题', after = '身份已有决定但条件待核实\n另一问题'
  const current = evidenceFinding('身份已有决定但条件待核实')
  const result = assessEvidence(before, after, { beforeFindings: [evidenceFinding(), other], findings: [current, other],
    resolutions: [resolution(evidenceFinding()), resolution(other)], history: { states: [], strategy: 'decision_reconciliation', strategy_issue_ids: ['other'] } })
  assert.equal(result.action, 'needs_decision'); assert.equal(result.reason, 'decision_conflict')
  assert.deepEqual(result.decision_findings, [other]); assert.deepEqual(result.retry_findings, [current])
  assert.deepEqual(result.evidence_changed_issue_ids, [findingIdentity(current)])
})

test('scene field evidence uses its exact source key and ignores unrelated fields', () => {
  const before = { ...draft('本集正文'), stage: 'episode' as const, scope: 'episode' as const, episode_number: 1,
    scenes: [{ heading: '场一', location: '室内', time_of_day: '日', characters: '人物', action: '身份尚未明确', dialogue: '旧对白', narration: '', duration: 20 }] }
  const after = structuredClone(before); after.scenes[0]!.dialogue = '新对白'
  const item = evidenceFinding('身份尚未明确', { source_key: 'scene:0:action' })
  const unchanged = assessEvidence('', '', { before, after, beforeFindings: [item], findings: [item], resolutions: [resolution(item)] })
  assert.equal(unchanged.action, 'change_strategy')
  after.scenes[0]!.action = '身份已有决定但仍有疑点'
  const changed = assessEvidence('', '', { before, after, beforeFindings: [item], findings: [{ ...item, quote: after.scenes[0]!.action }], resolutions: [resolution(item)] })
  assert.equal(changed.action, 'continue'); assert.deepEqual(changed.evidence_changed_issue_ids, [findingIdentity(item)])
})

test('legacy review histories retain whole-state cycle detection during evidence-history migration', () => {
  const first = assess('甲', '乙')
  const legacy = { ...first.history, reviews: first.history.reviews!.map(({ fingerprint, finding_ids }) => ({ fingerprint, finding_ids })) }
  const result = assess('乙', '甲', { history: legacy })
  assert.equal(result.action, 'change_strategy'); assert.equal(result.reason, 'cycle')
})

test('scene duration evidence advances only when the cited numeric field really changes', () => {
  const before = { ...draft('本集正文'), stage: 'episode' as const, scope: 'episode' as const, episode_number: 1,
    scenes: [{ heading: '场一', location: '', time_of_day: '', characters: '', action: '动作保留', dialogue: '', narration: '', duration: 20 }] }
  const after = structuredClone(before); after.scenes[0]!.duration = 25
  const item = evidenceFinding('20', { source_key: 'scene:0:duration' })
  const result = assessEvidence('', '', { before, after, beforeFindings: [item], findings: [{ ...item, quote: '25' }], resolutions: [resolution(item)] })
  assert.equal(result.action, 'continue'); assert.deepEqual(result.resolved_issue_ids, [])
  assert.deepEqual(result.evidence_changed_issue_ids, [findingIdentity(item)])
})
