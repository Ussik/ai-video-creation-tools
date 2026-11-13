import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionView, type ScriptActivity, type ScriptExecution } from '../src/features/script/director-activity'
import { activityOutputRecoveries } from '../src/features/script/director-activity-recovery'
import { activityCalls, activityPresentation, activitySequence } from '../src/features/script/director-activity-view'

const task: ScriptActivity = { id: 'task', kind: 'context', scope: 'task', status: 'running', label: '生成阶段草稿', summary: '处理中', started_at: 1000 }
const owner: ScriptActivity = { ...task, id: 'owner', parent_id: task.id, scope: 'step', step_id: 'work:props:prop_visuals', label: '编写外观与辨识' }
const truncated: ScriptActivity = { id: 'truncated', kind: 'model', name: 'model_request', parent_id: owner.id, status: 'failed', label: '模型编写完整阶段草稿', summary: '模型输出达到上限', started_at: 2000, output_limit_reason: 'max_output_tokens', output_tokens: 8188 }
const continuation: ScriptActivity = { ...truncated, id: 'continuation', label: '另一段模型请求名称', status: 'running', summary: '正在接续', started_at: 3000, output_limit_reason: undefined }
const execution: ScriptExecution = { title: '生成道具设定', started_at: 1000, outcome: { kind: 'draft', summary: '已生成草稿' } }

test('a typed truncation shows ongoing or completed continuation only with the same recorded owner', () => {
  const events = [task, owner, truncated, continuation], original = structuredClone(events)
  const sequence = activitySequence(events, { pending: true })
  const call = activityCalls(sequence.steps[0])[0].node
  assert.deepEqual(activityPresentation(call, true), { status: 'continuing', label: '已截断，正在接续' })
  assert.equal(call.event.status, 'failed')
  assert.deepEqual(events, original, 'display metadata never rewrites failed history or its diagnostics')
  assert.deepEqual(executionView(events, execution, true).stats, ['1 条截断记录正在接续'])

  for (const reason of ['max_output_tokens', 'length'] as const) {
    const completed = [{ ...task, status: 'succeeded' as const }, { ...owner, status: 'succeeded' as const },
      { ...truncated, output_limit_reason: reason }, { ...continuation, status: 'succeeded' as const }]
    const shown = activityCalls(activitySequence(completed).steps[0])[0].node
    assert.deepEqual(activityPresentation(shown), { status: 'continued', label: '已截断，已继续处理' })
    assert.deepEqual(executionView(completed, execution).stats, ['1 条截断记录已继续处理'])
    assert.equal(executionView(completed, execution).events[2].status, 'failed')
  }
})

test('unproven, unrelated, stale and finally failed continuations retain the failed request presentation', () => {
  const succeeded = (event: ScriptActivity): ScriptActivity => ({ ...event, status: 'succeeded' })
  const valid = [succeeded(task), succeeded(owner), truncated, succeeded(continuation)]
  const cases: Array<{ name: string; events: ScriptActivity[]; pending?: boolean; failed?: boolean }> = [
    { name: 'no later call', events: valid.slice(0, -1) },
    { name: 'text mentions length without a typed reason', events: valid.map(event => event.id === truncated.id ? { ...event, output_limit_reason: undefined, summary: 'length max_output_tokens 输出太长' } : event) },
    { name: 'another parent succeeded', events: valid.map(event => event.id === continuation.id ? { ...event, parent_id: task.id } : event) },
    { name: 'another named request succeeded', events: valid.map(event => event.id === continuation.id ? { ...event, name: 'another_request' } : event) },
    { name: 'another stable step succeeded', events: valid.map(event => event.id === continuation.id ? { ...event, step_id: 'other-step' } : event) },
    { name: 'missing owner', events: valid.filter(event => event.id !== owner.id) },
    { name: 'missing ancestor', events: valid.filter(event => event.id !== task.id) },
    { name: 'cyclic owner', events: valid.map(event => event.id === owner.id ? { ...event, parent_id: truncated.id } : event) },
    { name: 'owner is a notice', events: valid.map(event => event.id === owner.id ? { ...event, scope: 'notice' } : event) },
    { name: 'stale running owner', events: valid.map(event => event.id === owner.id ? { ...event, status: 'running' } : event) },
    { name: 'stale running continuation', events: [...valid.slice(0, -1), continuation] },
    { name: 'whole execution failed', events: valid, failed: true },
  ]
  for (const status of ['failed', 'cancelled'] as const) {
    cases.push({ name: `owner ${status}`, events: valid.map(event => event.id === owner.id ? { ...event, status } : event) })
    cases.push({ name: `ancestor ${status}`, events: valid.map(event => event.id === task.id ? { ...event, status } : event) })
    cases.push({ name: `continuation ${status}`, events: valid.map(event => event.id === continuation.id ? { ...event, status } : event) })
    cases.push({ name: `latest continuation ${status}`, events: [...valid, { ...continuation, id: 'last', status }] })
  }
  for (const { name, events, ...options } of cases) {
    assert.equal(activityOutputRecoveries(events, options).has(truncated.id), false, name)
    const node = activitySequence(events, options).steps.flatMap(step => [step, ...activityCalls(step).map(call => call.node)]).find(node => node.event.id === truncated.id)
    assert.ok(node, name)
    assert.equal(activityPresentation(node, options.pending).status, 'failed', name)
  }
})

test('multiple truncated pages keep their diagnostics and count separately from an unrelated failure', () => {
  const events: ScriptActivity[] = [{ ...task, status: 'succeeded' }, { ...owner, status: 'succeeded' }, truncated,
    { ...truncated, id: 'second-page', started_at: 3000 }, { ...continuation, status: 'succeeded', started_at: 4000 },
    { ...truncated, id: 'unrelated-failure', parent_id: task.id, output_limit_reason: undefined }]
  const view = executionView(events, execution)
  assert.deepEqual(view.stats, ['2 条截断记录已继续处理', '含 1 条失败记录'])
  assert.deepEqual(executionView(events, execution, false, true).stats, ['含 3 条失败记录'], 'an explicit failure also prevents recovery presentation with a stale outcome')
  for (const kind of ['failed', 'cancelled'] as const) {
    const terminal = executionView(events, { ...execution, outcome: { kind, summary: '任务未完成' } })
    assert.equal(terminal.stats.some(stat => stat.includes('截断记录')), false)
    assert.equal(activityOutputRecoveries(events, { failed: true }).size, 0)
  }
})
