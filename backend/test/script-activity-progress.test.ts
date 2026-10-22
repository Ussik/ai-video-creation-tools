import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityRecorder } from '../src/modules/script/script-activity.js'

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
