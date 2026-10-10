import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityDraftId, activitySources, canRetryExecution, conversationMessage, executionView, readActivity, settleActivity, updateActivity, type ScriptActivity, type ScriptExecution } from '../src/director-activity'
const entry: ScriptActivity = { id: 'a', kind: 'tool', name: 'read_documents', label: '阅读文档', status: 'running', summary: '正在读取', started_at: 100 }

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
  assert.deepEqual(view.stats, ['查阅 1 份文档', '1 个 Skill 已加载', '1 项操作未完成'])
  assert.equal(view.active?.id, 'model'); assert.equal(view.stateLabel, '处理中')
  assert.equal(view.groups.find(group => group.key === 'sources')?.events.length, 3)
  assert.equal(view.groups.find(group => group.key === 'rules')?.events.length, 2)
  assert.equal(view.events.length, 6)
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
