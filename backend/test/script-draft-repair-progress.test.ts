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
  topic: issue, kind: 'contradiction', quote: '原句', explanation: `${issue} 尚未落实`, suggestion: `落实 ${issue}` })
const resolution = (item: ScriptDraftFinding): FindingResolutionRecord => ({ id: findingIdentity(item), source_key: item.source_key,
  kind: item.kind, problem: item.explanation, strategy: 'ai', answer: '', decision: '保留原稿中的人物身份',
  summary: '已作最小修改', attempts: 1, status: 'still_open' })
const issue = finding('人物身份')
const assess = (before: string, after: string, extra: Partial<Parameters<typeof assessScriptDraftRepairProgress>[0]> = {}) =>
  assessScriptDraftRepairProgress({ before: draft(before), after: draft(after), beforeFindings: [issue], findings: [issue],
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

test('actual text, manuscript and resolved-issue progress do not trigger stagnation', () => {
  assert.equal(assess('甲', '乙').action, 'continue')
  assert.equal(assess('甲', '甲', { beforeSource: '原稿', afterSource: '修订稿' }).action, 'continue')
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
  const result = assess('甲', '乙', { findings: [independent, issue] })
  assert.equal(result.action, 'needs_decision')
  assert.deepEqual(result.decision_findings, [independent])
  assert.deepEqual(result.retry_findings, [issue])
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
