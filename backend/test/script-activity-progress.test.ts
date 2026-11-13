import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'

const directory = await mkdtemp(join(tmpdir(), 'script-activity-progress-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'activity fixtures must never open the workspace database')
const { activityRecorder, scriptActivitiesSchema, scriptActivitySchema } = await import('../src/modules/script/script-activity.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('activity recording omits unclaimed zero counters across start, update and completion', () => {
  const events: Record<string, unknown>[] = []
  const recorder = activityRecorder(event => events.push(event))
  const entry = recorder.start({ kind: 'model', label: '准备请求', summary: '未分配实际请求编号', attempt: 0 })
  assert.equal(Object.hasOwn(entry, 'attempt'), false)
  recorder.update(entry, { attempt: 0, request_bytes: 12 })
  const finished = recorder.finish(entry, 'succeeded', { attempt: 0, response_chars: 5 })
  assert.equal(Object.hasOwn(finished, 'attempt'), false)
  assert.equal(finished.request_bytes, 12)
  assert.equal(finished.response_chars, 5)
  for (const event of events) assert.equal(scriptActivitySchema.safeParse(event.activity).success, true)
  const claimed = recorder.start({ kind: 'model', label: '实际请求', summary: '保留正整数编号', attempt: 2 })
  assert.equal(claimed.attempt, 2)
})

test('historical zero attempts are removed without discarding activity or accepting other invalid counters', () => {
  const historical = { id: 'historical-zero', kind: 'model', status: 'failed', label: '旧请求', summary: '已保留的旧请求详情',
    attempt: 0, started_at: 1, ended_at: 5, duration_ms: 4, input: '原始请求摘要', output: '原始返回摘要',
    request_bytes: 20, output_tokens: 8, parent_id: 'parent' }
  const before = structuredClone(historical)
  const [restored] = scriptActivitiesSchema.parse([historical])
  const { attempt: _unknown, ...expected } = historical
  assert.deepEqual(restored, expected)
  assert.deepEqual(historical, before, 'read compatibility must not mutate the original saved record')
  assert.equal(scriptActivitySchema.safeParse(historical).success, false, 'new activity contracts still require positive attempt numbers')
  for (const attempt of [-1, -.5, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    assert.equal(scriptActivitiesSchema.safeParse([{ ...historical, attempt }]).success, false, String(attempt))
  }
  assert.equal(scriptActivitiesSchema.safeParse([historical, historical]).success, false)
})

test('live progress updates retain one activity identity and survive completion and late callbacks', () => {
  const events: Record<string, unknown>[] = []
  const recorder = activityRecorder(event => events.push(event))
  const step = recorder.start({ kind: 'context', label: '分析修订稿', summary: '准备目录' })
  recorder.update(step, { summary: '目录页 3/5 · 已发起 4 次模型请求' })
  assert.equal(recorder.entries.length, 1)
  assert.equal(recorder.entries[0]!.id, step.id)
  const finished = recorder.finish(step, 'succeeded')
  assert.equal(finished.summary, '目录页 3/5 · 已发起 4 次模型请求')
  assert.equal(finished.status, 'succeeded')
  recorder.update(step, { summary: '过期的异步回调' })
  recorder.finish(step, 'failed', { summary: '过期的请求错误' })
  assert.deepEqual(recorder.entries, [finished])
  assert.equal(events.length, 3, 'start, update and completion emit once each')
})

test('completion preserves measured checkpoint durations and never substitutes replay time for unmeasured work', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const recorder = activityRecorder(() => {})
  const fresh = recorder.start({ kind: 'context', scope: 'task', label: '生成概要', summary: '正在生成' })
  t.mock.timers.tick(12_345)
  assert.equal(recorder.finish(fresh, 'succeeded').duration_ms, 12_345)
  const replay = recorder.start({ kind: 'context', scope: 'task', label: '生成概要', summary: '复用断点' })
  t.mock.timers.tick(2)
  const restored = recorder.finish(replay, 'succeeded', { reused: true, duration_ms: 12_345 })
  assert.equal(restored.duration_ms, 12_345)
  const imported = recorder.start({ kind: 'context', scope: 'task', label: '已有概要', summary: '复用已有文档' })
  t.mock.timers.tick(2)
  const unmeasured = recorder.finish(imported, 'succeeded', { reused: true })
  assert.equal(unmeasured.duration_ms, undefined)
  assert.equal(unmeasured.reused, true)
  assert.equal(scriptActivitiesSchema.safeParse(recorder.entries).success, true)
})

test('automatic recovery reopens one failed logical step and preserves actual provider failures', () => {
  const recorder = activityRecorder(() => {})
  const step = recorder.start({ kind: 'context', scope: 'step', step_id: 'repair', label: '补齐候选设定', summary: '整体修订' })
  const request = recorder.start({ kind: 'model', parent_id: step.id, label: '整体模型请求', summary: '正在请求模型' })
  const failedRequest = recorder.finish(request, 'failed', { summary: '整体请求输出不符合契约' })
  const failed = recorder.finish(step, 'failed', { reused: true })
  assert.ok(Object.hasOwn(failed, 'ended_at')); assert.ok(Object.hasOwn(failed, 'duration_ms'))
  const reopened = recorder.reopen(failed, { summary: '已自动分开决策与修订，继续当前逻辑步骤' })
  assert.equal(reopened.id, step.id); assert.equal(reopened.started_at, step.started_at)
  assert.equal(reopened.status, 'running')
  for (const field of ['ended_at', 'duration_ms', 'reused']) assert.equal(Object.hasOwn(reopened, field), false)
  assert.equal(recorder.finish(failed, 'failed', { summary: '先前尝试的迟到错误' }), reopened)
  assert.equal(recorder.update(step, { summary: '先前尝试的迟到进度' }), reopened)
  const finished = recorder.finish(reopened, 'succeeded', { summary: '全部决定已落实并校验' })
  assert.equal(finished.id, step.id); assert.equal(finished.started_at, step.started_at)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.duration_ms, finished.ended_at! - step.started_at)
  assert.deepEqual(recorder.entries.filter(entry => entry.step_id === 'repair'), [finished])
  assert.equal(recorder.reopen(failedRequest, { summary: '不能将失败请求改成成功' }), failedRequest)
  assert.equal(recorder.finish(failedRequest, 'succeeded'), failedRequest)
  assert.equal(recorder.entries.find(entry => entry.id === request.id)?.status, 'failed')
  assert.equal(recorder.reopen(finished), finished, 'a completed logical step is not reopened')
})

test('recovered logical steps measure the full recovery instead of only their final aggregation', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const recorder = activityRecorder(() => {})
  const step = recorder.start({ kind: 'context', scope: 'step', step_id: 'repair', label: '补齐候选设定', summary: '整体修订' })
  t.mock.timers.tick(20)
  const failed = recorder.finish(step, 'failed', { duration_ms: 20 })
  t.mock.timers.tick(80)
  const reopened = recorder.reopen(failed)
  const completed = recorder.finish(reopened, 'succeeded', { duration_ms: 0 })
  assert.equal(completed.duration_ms, 100)
  assert.equal(completed.duration_ms, completed.ended_at! - step.started_at)
  assert.equal(completed.id, step.id)
})

test('checkpoint replay after reopening still preserves measured or unknown original duration', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const recorder = activityRecorder(() => {})
  for (const duration_ms of [12_345, undefined]) {
    const step = recorder.start({ kind: 'context', scope: 'step', step_id: 'repair', label: '补齐候选设定', summary: '整体修订' })
    const failed = recorder.finish(step, 'failed')
    t.mock.timers.tick(80)
    const reopened = recorder.reopen(failed)
    const restored = recorder.finish(reopened, 'succeeded', { reused: true, duration_ms })
    assert.equal(restored.duration_ms, duration_ms)
    assert.equal(restored.reused, true)
  }
})

test('structured execution and cumulative usage survive strict activity persistence without mixing their counters', () => {
  const recorder = activityRecorder(() => {})
  const current = createScriptRequestUsage(), cumulative = createScriptRequestUsage()
  current.requests = 1; current.input_tokens = 12; current.output_tokens = 7; current.reasoning_tokens = 3
  cumulative.requests = 89; cumulative.input_tokens = 3_000_000
  const entry = recorder.start({ kind: 'context', scope: 'notice', label: '本轮模型用量', summary: '本轮已发起 1 次模型请求',
    usage: { current, cumulative, limits: { max_requests: 32, max_tokens: 500_000, unknown_output_tokens: 4096 } } })
  recorder.finish(entry, 'succeeded')
  const saved = scriptActivitiesSchema.parse(JSON.parse(JSON.stringify(recorder.entries)))
  assert.equal(saved[0]!.usage?.current.requests, 1)
  assert.equal(saved[0]!.usage?.current.reasoning_tokens, 3)
  assert.equal(saved[0]!.usage?.cumulative?.requests, 89)
  assert.equal(saved[0]!.usage?.limits?.max_requests, 32)
  const invalid = structuredClone(saved)
  invalid[0]!.usage!.current.input_tokens = -1
  assert.equal(scriptActivitiesSchema.safeParse(invalid).success, false)
})

test('long-running execution records persist beyond former count, size, round and attempt cutoffs', () => {
  const entries = Array.from({ length: 2001 }, (_, index) => ({ id: `long-run-${index}`, kind: 'model' as const,
    label: '继续处理', summary: '实际处理记录'.repeat(100), status: 'succeeded' as const, started_at: index,
    round: 40, attempt: 12 }))
  assert.ok(JSON.stringify(entries).length > 1_000_000)
  const parsed = scriptActivitiesSchema.parse(entries)
  assert.equal(parsed.length, 2001)
  assert.equal(parsed.at(-1)!.round, 40)
  assert.equal(parsed.at(-1)!.attempt, 12)
  assert.equal(scriptActivitiesSchema.safeParse([...entries, entries[0]]).success, false, 'identity validation still applies')
})
