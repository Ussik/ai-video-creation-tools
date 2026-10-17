import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readActivity, type ScriptActivity } from '../src/features/script/director-activity'
import { activityCalls, activityDuration, activityPresentation, activitySequence } from '../src/features/script/director-activity-view'

const base: ScriptActivity = { id: 'task', kind: 'context', scope: 'task', status: 'running', label: '生成阶段草稿', summary: '生成', started_at: 1000 }
const phase: ScriptActivity = { ...base, id: 'phase', scope: 'step', parent_id: base.id, label: '生成故事梗概' }
const directory: ScriptActivity = { ...phase, id: 'directory', parent_id: phase.id, label: '筛选剧情目录' }
const request: ScriptActivity = { ...directory, id: 'request', parent_id: directory.id, kind: 'model', label: '模型筛选目录' }

test('ordered creative steps own their evidence and distinct repeated requests exactly once', () => {
  const previous = { ...request, id: 'previous', status: 'failed' as const }
  const plan = { ...phase, id: 'plan', label: '建立骨架', status: 'succeeded' as const, reused: true }
  const events = [base, plan, phase, directory, previous, request]
  const sequence = activitySequence(events)
  assert.deepEqual(sequence.steps.map(node => node.event.id), ['plan', 'phase'])
  assert.deepEqual(sequence.tasks.map(node => node.event.id), ['task'])
  assert.deepEqual(activityCalls(sequence.steps[1]).map(({ node, depth }) => [node.event.id, depth]), [['directory', 0], ['previous', 1], ['request', 1]])
  assert.equal(sequence.current?.event.id, phase.id); assert.equal(sequence.active?.event.id, request.id)
  for (const node of [sequence.tasks[0], sequence.steps[1], sequence.steps[1].children[0]]) {
    assert.equal(node.waiting, true, 'running descendants only affect active-leaf selection')
    assert.deepEqual(activityPresentation(node, true), { status: 'running', label: '进行中' })
  }
  assert.deepEqual(activityPresentation(sequence.active!, true), { status: 'running', label: '进行中' })
  assert.deepEqual(events.map(event => event.status), ['running', 'succeeded', 'running', 'running', 'failed', 'running'], 'presentation must not mutate saved records')
})

test('old histories, missing parents, self links and cycles retain all records without inventing hierarchy', () => {
  const events = readActivity([
    { ...phase, id: 'legacy', parent_id: undefined, scope: undefined },
    { ...phase, id: 'orphan', parent_id: 'missing' },
    { ...phase, id: 'self', parent_id: 'self' },
    { ...phase, id: 'cycle-a', parent_id: 'cycle-b' },
    { ...phase, id: 'cycle-b', parent_id: 'cycle-a' },
    { ...phase, id: 'child-of-cycle', parent_id: 'cycle-a' },
    { ...base, id: 'empty-task' },
  ])
  const view = activitySequence(events)
  const visible = view.steps.flatMap(node => [node.event.id, ...activityCalls(node).map(call => call.node.event.id)])
  assert.deepEqual(visible, events.map(event => event.id))
  assert.equal(new Set(visible).size, events.length)
  assert.equal(view.tasks.length, 0)
})

test('completed, reused, notice and missing terminal states retain truthful labels and durations', () => {
  const finished = { ...phase, status: 'succeeded' as const, duration_ms: 2400 }
  const reused = { ...finished, id: 'reuse', reused: true, duration_ms: 0 }
  const notice = { ...finished, id: 'notice', scope: 'notice' as const, duration_ms: 1 }
  const sequence = activitySequence([finished, reused, notice, request])
  const nodes = sequence.steps
  assert.equal(activityDuration(finished, 9000, true), 2400)
  assert.equal(activityDuration(reused, 9000, true), undefined)
  assert.equal(activityDuration(notice, 9000, true), undefined)
  assert.equal(activityDuration(request, 9000, true), 8000)
  assert.equal(activityDuration(request, 9000, false), undefined)
  assert.equal(activityPresentation(nodes[0], true).label, '已完成')
  assert.equal(activityPresentation(nodes[1], true).label, '已复用')
  assert.equal(activityPresentation(sequence.notices[0], true).label, '开始提示')
  assert.deepEqual(activityPresentation(nodes[2], false), { status: 'unconfirmed', label: '未记录完成' })
  for (const status of ['failed', 'cancelled'] as const) {
    assert.equal(activityPresentation({ ...nodes[0], event: { ...finished, status } }, true).status, status)
  }
})

for (const parentId of ['task', 'draft']) {
  test(`continuation notice under ${parentId} does not duplicate the active draft step or its calls`, () => {
    const draft = { ...phase, id: 'draft', label: '编写阶段草稿', started_at: 2000 }
    const initial: ScriptActivity = { ...request, id: 'initial', parent_id: draft.id, status: 'failed', label: '模型编写完整阶段草稿', duration_ms: 562000 }
    const notice: ScriptActivity = { ...base, id: 'notice', scope: 'notice', parent_id: parentId, status: 'succeeded', label: '继续未完成内容', started_at: 564000, duration_ms: 1 }
    const continuation: ScriptActivity = { ...request, id: 'continuation', parent_id: draft.id, label: '模型继续编写未完成内容', started_at: 564000 }
    const events = [base, draft, initial, notice, continuation]
    const original = structuredClone(events)
    const sequence = activitySequence(events)

    assert.deepEqual(sequence.steps.map(node => node.event.id), ['draft'])
    assert.deepEqual(sequence.notices.map(node => node.event.id), ['notice'])
    assert.deepEqual(activityCalls(sequence.steps[0]).map(({ node, depth }) => [node.event.id, depth]), [['initial', 0], ['continuation', 0]])
    assert.equal(sequence.active?.event.id, 'continuation')
    assert.equal(sequence.current?.event.id, 'draft')
    assert.deepEqual(activityPresentation(sequence.steps[0], true), { status: 'running', label: '进行中' })
    assert.equal(activityPresentation(activityCalls(sequence.steps[0])[0].node, true).label, '未完成')
    assert.equal(sequence.notices[0].event, notice)
    assert.deepEqual(events, original, 'view must retain the exact original trace and parent IDs')
  })
}

test('running notices do not claim the active call or make their real parent wait', () => {
  const notice: ScriptActivity = { ...phase, id: 'notice', scope: 'notice', status: 'running' }
  const sequence = activitySequence([base, phase, notice])
  assert.equal(sequence.active?.event.id, phase.id)
  assert.equal(sequence.current?.event.id, phase.id)
  assert.equal(sequence.steps[0].waiting, false)
  assert.equal(sequence.tasks[0].waiting, true)
  assert.deepEqual(activityCalls(sequence.steps[0]), [])
  assert.equal(activitySequence([notice]).active, undefined)

  const withRequest = activitySequence([base, phase, directory, request, notice])
  assert.equal(withRequest.active?.event.id, request.id, 'later notice must not steal a running model call')
  assert.equal(withRequest.current?.event.id, phase.id)
})

test('notices are transparent containers without hiding or deepening actual descendant calls', () => {
  const rootNotice: ScriptActivity = { ...base, id: 'root-notice', scope: 'notice', status: 'succeeded' }
  const draft: ScriptActivity = { ...phase, parent_id: rootNotice.id }
  const callNotice: ScriptActivity = { ...rootNotice, id: 'call-notice', parent_id: phase.id }
  const nestedNotice: ScriptActivity = { ...callNotice, id: 'nested-notice', parent_id: callNotice.id }
  const call: ScriptActivity = { ...request, parent_id: nestedNotice.id }
  const child: ScriptActivity = { ...directory, id: 'model-child', parent_id: call.id, status: 'succeeded' }
  const orphanNotice: ScriptActivity = { ...rootNotice, id: 'orphan-notice', parent_id: 'missing' }
  const orphanChild: ScriptActivity = { ...phase, id: 'orphan-child', parent_id: orphanNotice.id, status: 'succeeded' }
  const events = [rootNotice, draft, callNotice, nestedNotice, call, child, orphanNotice, orphanChild]
  const original = structuredClone(events)
  const sequence = activitySequence(events)

  assert.deepEqual(sequence.steps.map(node => node.event.id), ['phase', 'orphan-child'])
  assert.deepEqual(sequence.notices.map(node => node.event.id), ['root-notice', 'call-notice', 'nested-notice', 'orphan-notice'])
  assert.deepEqual(activityCalls(sequence.steps[0]).map(({ node, depth }) => [node.event.id, depth]), [['request', 0], ['model-child', 1]])
  assert.equal(sequence.active?.event.id, call.id)
  assert.equal(sequence.current?.event.id, draft.id)
  assert.deepEqual(events, original)
})

test('cyclic and self-linked notices retain their real descendants and original notice order', () => {
  const cycleA: ScriptActivity = { ...phase, id: 'notice-a', scope: 'notice', parent_id: 'notice-b', status: 'succeeded' }
  const cycleB: ScriptActivity = { ...cycleA, id: 'notice-b', parent_id: 'notice-a' }
  const selfNotice: ScriptActivity = { ...cycleA, id: 'self-notice', parent_id: 'self-notice' }
  const events = [cycleA, { ...phase, id: 'child-a', parent_id: cycleA.id }, cycleB, selfNotice, { ...phase, id: 'child-self', parent_id: selfNotice.id }]
  const sequence = activitySequence(events)
  assert.deepEqual(sequence.notices.map(node => node.event.id), ['notice-a', 'notice-b', 'self-notice'])
  assert.deepEqual(sequence.steps.map(node => node.event.id), ['child-a', 'child-self'])
  assert.deepEqual(sequence.steps.flatMap(node => [node.event.id, ...activityCalls(node).map(call => call.node.event.id)]), ['child-a', 'child-self'])
})
