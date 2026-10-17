import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directorFailureText, directorMessageFailure } from '../src/features/script/director-message-failure'
import type { ScriptExecution } from '../src/features/script/director-activity'

const execution: ScriptExecution = { title: '生成大纲', request: '生成全剧大纲', started_at: 0, outcome: { kind: 'failed', summary: '核心因果尚未交代。' } }

test('failed replies separate partial text from the full diagnostic without changing stored content', () => {
  const text = directorFailureText({ text: '正在调查的主角已经找到线索。', has_reply_text: true }, '核心因果尚未交代。\n\n需补充获取资源的过程。')
  const reply = { role: 'assistant' as const, failed: true, execution, text }
  assert.deepEqual(directorMessageFailure(reply), { body: '正在调查的主角已经找到线索。', detail: '核心因果尚未交代。\n\n需补充获取资源的过程。' })
  assert.equal(reply.text, text)
  assert.equal(directorFailureText({ text: '正在编写阶段草稿…' }, '核心因果尚未交代。'), '对话失败：核心因果尚未交代。')
  assert.equal(directorFailureText({ text: '核心因果尚未交代。' }, '核心因果尚未交代。'), '对话失败：核心因果尚未交代。')
})

test('server task history and legacy errors use the same card without relying on transient failure flags', () => {
  assert.deepEqual(directorMessageFailure({ role: 'assistant', text: '完整诊断：资源来源不清楚。', execution }), { body: '', detail: '完整诊断：资源来源不清楚。' })
  assert.deepEqual(directorMessageFailure({ role: 'assistant', text: '对话失败：旧版诊断。' }), { body: '', detail: '旧版诊断。' })
  assert.deepEqual(directorMessageFailure({ role: 'assistant', text: '对话失败: 旧版诊断。' }), { body: '', detail: '旧版诊断。' })
})

test('ordinary replies, user messages, pending work and cancellations do not become failure cards', () => {
  for (const message of [
    { role: 'user' as const, text: '对话失败：请解释这个提示' },
    { role: 'assistant' as const, text: '说明如下。\n\n对话失败：这是提示的示例。' },
    { role: 'assistant' as const, text: '正在处理', pending: true, failed: true },
    { role: 'assistant' as const, text: '已返回的部分。\n\n已停止生成', failed: true },
    { role: 'assistant' as const, text: '已停止生成', failed: true, execution: { ...execution, outcome: { kind: 'cancelled' as const, summary: '用户停止' } } },
  ]) assert.equal(directorMessageFailure(message), null)
})
