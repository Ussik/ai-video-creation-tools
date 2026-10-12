import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directorChatContext, directorChatMessageLimit, directorChatTextBudget } from '../src/features/script/director-chat-context'
import { regenerationSource } from '../src/features/script/director-regeneration'
import { referenceMessages } from '../src/features/script/director-references'

const bytes = (messages: Array<{ text: string }>) => messages.reduce((total, message) => total + new TextEncoder().encode(message.text).length, 0)

test('ordinary Chinese history over the former 40 KB cap retains its complete messages', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, text: '创作设定'.repeat(400) }))
  assert.ok(bytes(messages) > 40_000)
  assert.deepEqual(directorChatContext(messages), messages)
})

test('UTF-8 budgeting keeps a contiguous recent window and the latest question/answer without cutting text or mutating history', () => {
  const messages = Array.from({ length: 32 }, (_, index) => ({ id: `${index}`, text: '中'.repeat(8000) }))
  messages.at(-1)!.text = '关于人物关系，选择跳过，请继续。'
  const before = JSON.stringify(messages)
  const context = directorChatContext(messages)
  assert.ok(bytes(context) <= directorChatTextBudget)
  assert.ok(context.length < messages.length)
  assert.deepEqual(context, messages.slice(-context.length))
  assert.equal(context.at(-2), messages.at(-2))
  assert.equal(context.at(-1), messages.at(-1))
  assert.equal(JSON.stringify(messages), before)
})

test('request count excludes welcome, pending and failed messages without deleting their records', () => {
  const messages = [{ id: 'welcome', text: '欢迎' }, ...Array.from({ length: 50 }, (_, index) => ({ id: `${index}`, text: `消息${index}` })),
    { id: 'failed', text: '失败', failed: true }, { id: 'pending', text: '生成中', pending: true }]
  const context = directorChatContext(messages)
  assert.equal(context.length, directorChatMessageLimit)
  assert.equal(context.at(-1)!.id, '49')
  assert.equal(messages.length, 53)
})

test('retry uses the same budget, retaining the original question and full current reference while excluding rejected replies', () => {
  const reference = { key: 'outline:0', artifact_type: 'outline' as const, title: '故事大纲', episode_number: 0, content: '完整参考'.repeat(2000) }
  const messages = [...Array.from({ length: 30 }, (_, index) => ({ id: `${index}`, role: 'assistant' as const, text: '中'.repeat(8000) })),
    { id: 'question', role: 'user' as const, text: '根据文档继续', reference_documents: [reference], failed: true },
    { id: 'failure', role: 'assistant' as const, text: '对话内容不能超过 40 KB', failed: true }]
  const retry = regenerationSource(messages, 'failure')!
  const context = directorChatContext(retry.context)
  assert.ok(bytes(context) <= directorChatTextBudget)
  assert.equal(context.at(-1)!.id, 'question')
  assert.equal(referenceMessages(context).at(-1)!.reference_documents![0]!.content, reference.content)
  assert.ok(context.every(message => message.id !== 'failure'))
})

test('an oversized latest message reports a local error instead of dropping the current instruction', () => {
  assert.throws(() => directorChatContext([{ id: 'latest', text: '中'.repeat(directorChatTextBudget) }]), /本次消息过长/)
})
