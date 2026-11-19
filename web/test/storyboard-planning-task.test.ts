import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import type { StoryboardPlanningTask } from '@video-studio/shared/storyboard/storyboard-planning-types'
import { cancelPlanningTask, observePlanningTask, planningTaskFailure, planningTaskFailureDetails, planningTaskProgressLabel, rememberedPlanningTask, resumePlanningTask, startPlanningTask, type PlanningTaskInput } from '../src/features/storyboard/storyboard-planning-task'

const dom = new JSDOM('', { url: 'http://localhost/' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
beforeEach(() => dom.window.sessionStorage.clear())
const input: PlanningTaskInput = { signature: 'a'.repeat(64), scene_ids: ['scene'], document_ids: [], model_id: 'model', mode: 'redesign', instructions: '' }
const running = { id: 'task', project_id: 'project', input_key: 'key', status: 'running', stage: 'reviewing',
  started_at: Date.now(), updated_at: Date.now(), active_duration_ms: 2000,
  stage_duration_ms: 100, timings: {}, can_resume: false } as StoryboardPlanningTask

test('nonadjacent review failures explain the model relation and offer outline recovery', () => {
  const task = { ...running, status: 'failed', stage: 'reviewing', can_resume: true,
    outline_checkpoint: { validated: true, scenes: [{ scene_id: 'scene', shot_count: 6, scene_duration: 30, shot_duration_sum: 30 }] },
    error: { message: '导演复核只能关联本次序列中直接相邻的镜头', code: 'storyboard_review_invalid', failure_type: 'invalid_business' as const,
      field_path: 'issues[1].related_shot_index', related_scene_id: 'scene', related_shot_index: 4 } } as StoryboardPlanningTask
  const text = planningTaskFailure(task)
  assert.match(text, /导演复核关联镜头无效/)
  assert.match(text, /第 2 条复核问题/)
  assert.doesNotMatch(text, /issues\[/)
  assert.match(planningTaskFailureDetails(task), /issues\[1\]\.related_shot_index/)
  assert.match(text, /模型关联镜头 5/)
  assert.match(text, /大纲已保留，继续时校验并恢复该大纲，不重新生成/)
})

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

test('dialogue provenance failure shows readable location and retains technical details', () => {
  const task = { status: 'failed', stage: 'generating', can_resume: false, recovery_budget: 0,
    error: { stage: 'generating', failure_type: 'dialogue_ref_wrong_scene', message: '台词引用属于其他场次',
      scene_id: 'scene-a', shot_id: 'shot-b', field_path: 'scenes.0.shots.1.audio_plan.speech.0.source_ref', ref_id: 'ds_ab12' } } as StoryboardPlanningTask
  const message = planningTaskFailure(task, () => '车站')
  assert.match(message, /台词引用跨场次/)
  assert.match(message, /车站.*第 2 镜/)
  assert.doesNotMatch(message, /scene-a|shot-b|audio_plan|ds_ab12/)
  const details = planningTaskFailureDetails(task)
  for (const value of ['scene-a', 'shot-b', 'audio_plan.speech.0.source_ref', 'ds_ab12']) assert.ok(details.includes(value))
})

test('timing mismatch failure shows scene and shot totals instead of an unknown error', () => {
  const task = { status: 'failed', stage: 'generating', can_resume: true, recovery_budget: 2,
    error: { stage: 'generating', failure_type: 'timing_mismatch', message: '本场 120 秒，镜头合计 111 秒，少 9 秒',
      scene_id: 'scene-a', field_path: 'scenes.0.shots', scene_duration: 120, shot_duration_sum: 111, delta: 9 } } as StoryboardPlanningTask
  const message = planningTaskFailure(task)
  assert.match(message, /场次时长与镜头合计不一致/)
  assert.match(message, /本场 120 秒，镜头合计 111 秒，少 9 秒/)
  assert.doesNotMatch(message, /scenes\.0\.shots/)
  assert.match(planningTaskFailureDetails(task), /scenes\.0\.shots/)
})


test('progress uses scene headings instead of internal UUIDs', () => {
  const id = 'b4bb4e5a-0103-4f3a-9171-99234493c5c4'
  const task = { ...running, progress: { phase: 'shots', completed_shots: 2, total_shots: 5,
    current_scene_id: id, current_shot_index: 2 } } as StoryboardPlanningTask
  const message = planningTaskProgressLabel(task, () => '车站')
  assert.match(message, /车站.*第 3 镜/)
  assert.ok(!message.includes(id))
})

test('outline recheck failure keeps upstream punctuation and explains pending delivery without a restart promise', () => {
  const task = { ...running, stage: 'rechecking', status: 'failed', can_resume: false,
    outline_checkpoint: { validated: true, stage: 'rechecking', delivery_pending: true, scenes: [{ scene_id: 'scene', shot_count: 4, scene_duration: 35, shot_duration_sum: 35 }] },
    error: { stage: 'rechecking', failure_type: 'transport', message: '模型接口连接中断，未获得完整响应。' } } as StoryboardPlanningTask
  const message = planningTaskFailure(task)
  assert.match(message, /修订后大纲复核未完成/)
  assert.match(message, /未获得完整响应。/)
  assert.doesNotMatch(message, /。。|重新规划|生成分镜草稿未完成/)
  assert.match(message, /响应尚未确认/)
  assert.match(message, /不会自动重发/)
  assert.equal(task.error!.message, '模型接口连接中断，未获得完整响应。')
})

test('failure boundary adds punctuation only when the upstream sentence needs it', () => {
  for (const ending of ['', '。', '！', '？', '.', '!', '?']) {
    const message = planningTaskFailure({ ...running, status: 'failed', can_resume: true,
      error: { stage: 'reviewing', message: '原诊断' + ending } })
    assert.match(message, new RegExp('原诊断' + (ending ? ending.replace(/[.?]/g, '\\$&') : '。')))
    assert.doesNotMatch(message, /。。|[！？，!?]。|\.。/)
  }
})
