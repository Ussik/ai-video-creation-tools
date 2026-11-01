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
const { activityRecorder, scriptActivitiesSchema } = await import('../src/modules/script/script-activity.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

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
