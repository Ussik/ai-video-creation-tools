import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import type { StoryboardPlanningTask } from '@video-studio/shared/storyboard/storyboard-planning-types'
import { cancelPlanningTask, observePlanningTask, planningTaskFailure, planningTaskProgressLabel, rememberedPlanningTask, resumePlanningTask, startPlanningTask, type PlanningTaskInput } from '../src/features/storyboard/storyboard-planning-task'

const dom = new JSDOM('', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
beforeEach(() => dom.window.sessionStorage.clear())
const input: PlanningTaskInput = { signature: 'a'.repeat(64), scene_ids: ['scene'], document_ids: [], model_id: 'model', mode: 'redesign', instructions: '' }
const running = { id: 'task', project_id: 'project', input_key: 'key', status: 'running', stage: 'reviewing',
  started_at: Date.now(), updated_at: Date.now(), active_duration_ms: 2000,
  stage_duration_ms: 100, timings: {}, can_resume: false } as StoryboardPlanningTask

test('a lost acceptance response reuses its request identity, while changed inputs start distinct work', async t => {
  const requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)))
    if (requests.length === 1) throw new TypeError('Failed to fetch')
    return Response.json(running)
  })
  const controller = new AbortController()
  await assert.rejects(startPlanningTask('project', input, false, controller.signal), /fetch/)
  await startPlanningTask('project', input, false, controller.signal)
  assert.equal(requests[0].request_id, requests[1].request_id)
  assert.equal(rememberedPlanningTask('project')?.task_id, 'task')
  await startPlanningTask('project', { ...input, instructions: '调整站位' }, false, controller.signal)
  assert.notEqual(requests[1].request_id, requests[2].request_id)
})

test('temporary polling failures retry observation without another task start', async t => {
  const methods: string[] = [], connections: string[] = [], updates: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    methods.push(options?.method || 'GET')
    if (methods.length === 1) return Response.json({ detail: 'temporary unavailable' }, { status: 503 })
    return Response.json({ ...running, status: 'succeeded', stage: 'completed' })
  })
  const final = await observePlanningTask('project', running, { signal: new AbortController().signal, intervalMs: 1,
    onUpdate: task => updates.push(task.status), onConnectionChange: message => connections.push(message) })
  assert.equal(final.status, 'succeeded')
  assert.deepEqual(methods, ['GET', 'GET'])
  assert.deepEqual(updates, ['running', 'succeeded'])
  assert.match(connections[0], /重新连接/)
  assert.equal(connections.at(-1), '')
})

test('closing a local observer never cancels or resumes server work', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(running) })
  const controller = new AbortController()
  const observation = observePlanningTask('project', running, { signal: controller.signal, intervalMs: 20,
    onUpdate() {}, onConnectionChange() {} })
  controller.abort(new DOMException('Observer closed', 'AbortError'))
  await assert.rejects(observation, /Observer closed/)
  assert.equal(calls, 0)
})

test('only explicit actions post resume or cancellation and mismatched observations fail closed', async t => {
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ path: String(url), method: options?.method || 'GET' })
    return Response.json({ ...running, project_id: 'wrong-project' })
  })
  await resumePlanningTask('project', 'task', new AbortController().signal)
  await cancelPlanningTask('project', 'task')
  await assert.rejects(observePlanningTask('project', running, { signal: new AbortController().signal, intervalMs: 1,
    onUpdate() {}, onConnectionChange() {} }), /身份不匹配/)
  assert.deepEqual(requests.map(item => item.method), ['POST', 'POST', 'GET'])
  assert.match(requests[0].path, /\/task\/resume$/)
  assert.match(requests[1].path, /\/task\/cancel$/)
})

test('malformed remembered tasks never restore or dispatch work', () => {
  dom.window.sessionStorage.setItem('storyboard-planning-task:project', JSON.stringify({ request_id: 'id', input: { scene_ids: ['scene'] } }))
  assert.equal(rememberedPlanningTask('project'), null)
})

test('a failed final check never promises continuation when a new plan is required', () => {
  const message = planningTaskFailure({ ...running, status: 'failed', stage: 'rechecking', can_resume: false })
  assert.match(message, /重新规划/)
  assert.doesNotMatch(message, /可继续/)
  assert.match(planningTaskFailure({ ...running, status: 'failed', can_resume: true }), /可继续重试当前步骤/)
})

test('batch progress explains preserved shots without implying a complete preview exists', () => {
  const task: StoryboardPlanningTask = { ...running, stage: 'generating', status: 'failed', can_resume: true,
    progress: { phase: 'shots', completed_shots: 2, total_shots: 6 } }
  assert.equal(planningTaskProgressLabel(task), '已完成 2 / 6 镜')
  assert.equal(task.candidate, undefined)
  assert.match(planningTaskFailure(task), /已完成的镜头已保存，继续时从未完成部分重试/)
  assert.equal(planningTaskProgressLabel({ ...task, progress: { phase: 'outline', completed_shots: 0, total_shots: 0 } }), '正在设计镜头大纲')
  assert.match(planningTaskFailure({ ...task, can_resume: false }), /重新规划/)
  assert.doesNotMatch(planningTaskFailure({ ...task, can_resume: false }), /继续时/)
  assert.equal(planningTaskProgressLabel(running), '')
})
