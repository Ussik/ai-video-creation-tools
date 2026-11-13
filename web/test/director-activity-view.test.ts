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
  const visible = [...view.steps.flatMap(node => [node.event.id, ...activityCalls(node).map(call => call.node.event.id)]), ...view.tasks.map(node => node.event.id)]
  assert.deepEqual(visible, events.map(event => event.id))
  assert.equal(new Set(visible).size, events.length)
  assert.deepEqual(view.tasks.map(node => node.event.id), ['empty-task'])
  assert.equal(view.current?.event.id, 'empty-task')
})

test('independent deliverables are tasks even before their first call and keep the same order after calls arrive', () => {
  const synopsis: ScriptActivity = { ...base, id: 'synopsis', parent_id: base.id, label: '故事简述', status: 'succeeded' }
  const world: ScriptActivity = { ...synopsis, id: 'world', label: '背景设定', status: 'running' }
  const original = [base, synopsis, world]
  const initial = activitySequence(original)
  assert.deepEqual(initial.tasks.map(node => node.event.id), ['task', 'synopsis', 'world'])
  assert.equal(initial.current?.event.id, 'world')
  const call = { ...request, parent_id: world.id }
  const working = activitySequence([...original, call])
  assert.deepEqual(working.tasks.map(node => node.event.id), ['task', 'synopsis', 'world'])
  assert.equal(working.active?.event.id, call.id)
  assert.equal(working.current?.event.id, call.id, 'a concrete work step remains visible within its task')
  assert.equal(working.tasks[2]!.waiting, true)
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

test('restored results show the original elapsed time and never infer it from replay timestamps', () => {
  const restored: ScriptActivity = { ...phase, status: 'succeeded', reused: true, duration_ms: 82_400, ended_at: 1002 }
  assert.equal(activityDuration(restored, 99_000), 82_400)
  for (const duration_ms of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(activityDuration({ ...restored, duration_ms }, 99_000), undefined)
  }
  assert.equal(activityDuration({ ...restored, status: 'running' }, 99_000, true), undefined)
})

test('elapsed time falls back to recorded boundaries only when they are valid and not a replay', () => {
  const finished: ScriptActivity = { ...phase, status: 'succeeded', ended_at: 6250 }
  assert.equal(activityDuration(finished, 99_000), 5250)
  assert.equal(activityDuration({ ...finished, duration_ms: 0 }, 99_000), 0, 'a recorded instant operation remains valid')
  assert.equal(activityDuration({ ...finished, ended_at: 900 }, 99_000), undefined)
  assert.equal(activityDuration({ ...finished, started_at: 0 }, 99_000), undefined)
  assert.equal(activityDuration({ ...phase, started_at: 0 }, 99_000, true), undefined)
  for (const duration_ms of [-1, NaN, Infinity]) {
    assert.equal(activityDuration({ ...finished, duration_ms }, 99_000), undefined)
  }
})

test('legacy cached task wrappers use exact sibling checkpoint evidence without changing saved traces or inventing time', () => {
  for (const stepId of ['work:document:outline:outline/draft', 'work:outline:outline/draft']) {
    const task: ScriptActivity = { ...base, parent_id: 'stage', status: 'succeeded', step_id: 'work:outline:outline', duration_ms: 2, ended_at: 1002 }
    const checkpoint: ScriptActivity = { ...phase, parent_id: 'stage', step_id: stepId, status: 'succeeded', reused: true, duration_ms: 1 }
    const events = [task, checkpoint], original = structuredClone(events)
    const shown = activitySequence(events).tasks[0]
    assert.equal(activityPresentation(shown).label, '已复用')
    assert.equal(activityDuration(shown.event, 99_000), undefined, 'the replay clock is not the original authoring time')
    assert.notEqual(shown.event, task, 'compatibility applies only to a display copy')
    assert.deepEqual(events, original)

    for (const evidence of [
      { ...checkpoint, parent_id: 'other-stage' },
      { ...checkpoint, step_id: `${stepId}:partial` },
      { ...checkpoint, reused: undefined },
      { ...checkpoint, status: 'failed' as const },
      { ...checkpoint, scope: 'notice' as const },
    ]) {
      assert.equal(activitySequence([task, evidence]).tasks[0].event, task, 'unrelated evidence leaves the original task intact')
    }
    const ambiguous = activitySequence([task, checkpoint, { ...checkpoint, id: 'another-checkpoint' }]).tasks[0]
    assert.equal(ambiguous.event, task, 'ambiguous checkpoint identities cannot establish reuse')
    const measured = { ...task, reused: true, duration_ms: 82_400 }
    assert.equal(activityDuration(activitySequence([measured, checkpoint]).tasks[0].event, 99_000), 82_400, 'explicit current metadata takes precedence')
    const fresh = { ...task, reused: false, duration_ms: 2400 }
    assert.equal(activitySequence([fresh, checkpoint]).tasks[0].event, fresh)
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
