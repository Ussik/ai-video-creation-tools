import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityDraftId, activityGroup, activitySources, activityStatusLabel, canRetryExecution, conversationMessage, executionView, readActivity, settleActivity, updateActivity, type ScriptActivity, type ScriptExecution } from '../src/features/script/director-activity'
const entry: ScriptActivity = { id: 'a', kind: 'tool', name: 'read_documents', label: '阅读文档', status: 'running', summary: '正在读取', started_at: 100 }

test('legacy begin-only records are notices; task, phase and actual requests retain their hierarchy', () => {
  const legacy = { ...entry, kind: 'context' as const, status: 'succeeded' as const, label: '正在生成故事梗概', duration_ms: 1 }
  const notice = readActivity([legacy])[0]
  assert.equal(notice.scope, 'notice'); assert.equal(activityStatusLabel(notice), '开始提示')
  const task: ScriptActivity = { ...entry, id: 'task', kind: 'context', scope: 'task', label: '生成阶段草稿' }
  const phase: ScriptActivity = { ...task, id: 'phase', scope: 'step', parent_id: task.id, label: '生成故事梗概' }
  const model: ScriptActivity = { ...entry, id: 'model', kind: 'model', scope: 'step', parent_id: phase.id }
  const reused: ScriptActivity = { ...phase, id: 'previous', status: 'succeeded', reused: true, duration_ms: 0 }
  const view = executionView([notice, task, reused, phase, model], undefined, true)
  assert.equal(view.active?.id, 'model'); assert.equal(view.groups.length, 1)
  assert.equal(activityStatusLabel(reused), '已复用')
  assert.equal(readActivity([{ ...legacy, scope: 'step' }])[0].scope, 'step', 'actual fast steps are not rewritten as notices')
})

test('same invocation updates, repeated calls survive and old summaries remain readable', () => {
  let activity = updateActivity([], entry)
  activity = updateActivity(activity, { ...entry, status: 'succeeded', duration_ms: 50 })
  activity = updateActivity(activity, { ...entry, id: 'b' })
  assert.equal(activity.length, 2); assert.equal(activity[0].status, 'succeeded'); assert.equal(activity[1].status, 'running')
  const old = readActivity([{ id: 'legacy', label: '创作依据', summary: '已读背景' }])[0]
  assert.equal(old.kind, 'context'); assert.equal(old.status, 'succeeded')
})

test('task summaries count real unique sources and loaded Skills while retaining every attempt in grouped steps', () => {
  const read: ScriptActivity = { ...entry, status: 'succeeded', targets: [{ kind: 'document', id: 'doc', title: '人物设定' }], output: '{truncated', output_truncated: true }
  const skill: ScriptActivity = { ...entry, id: 'skill', kind: 'skill', skill_id: 'consistency', status: 'succeeded', label: '人物一致性' }
  const activity = [read, { ...read, id: 'reread' }, skill, { ...skill, id: 'reload' }, { ...entry, id: 'missing', status: 'failed' as const }, { ...entry, id: 'model', kind: 'model' as const, name: 'model' }]
  const view = executionView(activity, undefined, true)
  assert.deepEqual(view.stats, ['查阅 1 份文档', '1 个 Skill 已加载', '含 1 条失败记录'])
  assert.equal(view.active?.id, 'model'); assert.equal(view.stateLabel, '处理中')
  assert.equal(view.groups.find(group => group.key === 'sources')?.events.length, 3)
  assert.equal(view.groups.find(group => group.key === 'rules')?.events.length, 2)
  assert.equal(view.events.length, 6)
})

test('a recovered model failure retains its history without marking a completed draft as unfinished', () => {
  const failed: ScriptActivity = { ...entry, id: 'attempt-1', kind: 'model', status: 'failed' }
  const succeeded: ScriptActivity = { ...failed, id: 'attempt-2', status: 'succeeded' }
  const execution: ScriptExecution = { title: '生成大纲', request: '生成', started_at: 100,
    outcome: { kind: 'draft', summary: '核对通过，草稿待确认' } }
  const view = executionView([failed, succeeded], execution)
  assert.equal(view.stateLabel, '草稿待确认')
  assert.deepEqual(view.stats, ['含 1 条失败记录'])
  assert.equal(view.events[0].status, 'failed')
})

test('legacy sources require complete valid public payloads and never count directory listings or malformed IDs', () => {
  const output = JSON.stringify({ documents: [{ id: 'd', title: '大纲' }, null, { id: 3, title: '坏记录' }, { id: 'd' }] })
  assert.deepEqual(activitySources([{ ...entry, status: 'succeeded', output }]), [{ kind: 'document', id: 'd', title: '大纲' }])
  assert.deepEqual(activitySources([{ ...entry, status: 'succeeded', output, output_truncated: true }]), [])
  assert.deepEqual(activitySources([{ ...entry, status: 'succeeded', name: 'get_creation_state', output }]), [])
  assert.deepEqual(activitySources([{ ...entry, status: 'failed', output }]), [])
  assert.deepEqual(activitySources([{ ...entry, status: 'succeeded', name: 'get_storyboard_context', output: JSON.stringify({ objects: [{ type: 'shot', id: 's', title: '车站镜头' }, { type: 'unknown', id: 'x', title: '错误' }] }) }]), [{ kind: 'shot', id: 's', title: '车站镜头' }])
})

test('possible write attempts prevent automatic retry; recovery retains exact draft identity even when the stream stops', () => {
  assert.equal(canRetryExecution([entry]), true)
  assert.equal(canRetryExecution([{ ...entry, name: 'ask_creator' }]), true)
  assert.equal(canRetryExecution([{ ...entry, name: 'manage_document_draft', input: '{"operation":"read"}' }]), true)
  for (const name of ['create_document_draft', 'propose_document_patch', 'record_story_decision', 'commit_document_draft', 'unknown_function']) {
    assert.equal(canRetryExecution([{ ...entry, name, status: 'cancelled' }]), false)
  }
  assert.equal(canRetryExecution([{ ...entry, name: 'manage_document_draft', input: '{"operation":"update"}' }]), false)
  assert.equal(activityDraftId([{ ...entry, name: 'commit_document_draft', input: '{"draft_id":"exact-draft","version":"v1"}' }]), 'exact-draft')
  assert.equal(activityDraftId([{ ...entry, name: 'propose_document_patch', status: 'succeeded', output: '{"draft_id":"new-draft"}' }]), 'new-draft')
  assert.equal(activityDraftId([{ ...entry, output: '{"draft_id":"unknown"}', output_truncated: true }]), undefined)
})

test('source, episode and repair reads remain retryable after a later failure without allowing any write replay', () => {
  const reads: ScriptActivity[] = ['read_source_document', 'search_source_document', 'read_episode_scenes', 'get_repair_context', 'search_repair_context'].map((name, index) => ({
    ...entry, id: `read-${index}`, name, status: 'succeeded',
  }))
  const failedModel: ScriptActivity = { ...entry, id: 'interrupted-model', kind: 'model', status: 'failed' }
  assert.equal(canRetryExecution([...reads, failedModel]), true)
  for (const read of reads) {
    assert.equal(activityGroup(read), 'sources')
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) assert.equal(canRetryExecution([{ ...read, status }]), true)
  }
  for (const name of ['create_document_draft', 'propose_document_patch', 'record_story_decision', 'commit_document_draft', 'unknown_function']) {
    assert.equal(canRetryExecution([...reads, { ...entry, id: name, name, status: 'succeeded' }, failedModel]), false)
  }
})

test('private candidate patch submission remains retryable and is displayed as a result', () => {
  for (const status of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
    const submission: ScriptActivity = { ...entry, name: 'submit_repair_patch', status }
    assert.equal(activityGroup(submission), 'results')
    assert.equal(canRetryExecution([submission, { ...entry, id: 'later-model', kind: 'model', status: 'failed' }]), true)
  }
})

test('task scope and actual outcome survive persistence; pending snapshots remain incomplete on reload', () => {
  const execution: ScriptExecution = { title: '修订人物设定', request: '补齐林晚职业', started_at: 100, targets: ['人物设定'], focus_artifact: 'all', mode: 'script', document_action: { operation: 'revise', document_ids: ['doc'] }, outcome: { kind: 'saved', summary: '已保存', draft_id: 'd' } }
  const saved = conversationMessage({ id: 'm', role: 'assistant', text: '已完成', execution })
  assert.deepEqual(saved.reply_metadata.execution, execution)
  assert.equal(executionView([], execution).stateLabel, '已保存')
  const pending = conversationMessage({ id: 'm', role: 'assistant', text: '处理中', pending: true, execution })
  assert.equal(pending.reply_metadata.execution.outcome.kind, 'cancelled')
  assert.equal(pending.reply_metadata.execution.outcome.draft_id, 'd')
  assert.equal(conversationMessage({ id: 'u', role: 'user', text: '要求', execution }).reply_metadata, undefined)
})

test('connection failure closes only running steps and all save paths use detailed trace serialization', () => {
  const activity = settleActivity([entry, { ...entry, id: 'complete', status: 'succeeded', duration_ms: 20 }], 'failed', 180)
  assert.equal(activity[0].status, 'failed'); assert.equal(activity[0].duration_ms, 80); assert.equal(activity[1].status, 'succeeded')
  const assistant = conversationMessage({ id: 'message', role: 'assistant', text: '回复', activity, processing_duration_ms: 80 })
  assert.deepEqual(assistant.activity, activity)
  assert.equal(conversationMessage({ id: 'user', role: 'user', text: '要求', activity }).activity, undefined)
})
