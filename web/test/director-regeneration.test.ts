import assert from 'node:assert/strict'
import { test } from 'node:test'
import { regenerationSource } from '../src/director-regeneration'
import { referenceMessages } from '../src/director-references'

test('regeneration reuses the original question and references, excluding the rejected answer', () => {
  const document = { key: 'outline:0', artifact_type: 'outline' as const, episode_number: 0, title: '故事大纲', content: '需要保留的故事事实' }
  const messages = [
    { id: 'welcome', role: 'assistant' as const, text: '欢迎' },
    { id: 'earlier-user', role: 'user' as const, text: '故事发生在老宅' },
    { id: 'earlier-reply', role: 'assistant' as const, text: '已确认老宅' },
    { id: 'question', role: 'user' as const, text: '让悬念更强', reference_documents: [document] },
    { id: 'bad-reply', role: 'assistant' as const, text: '这段回复不满意' },
  ]
  const source = regenerationSource(messages, 'bad-reply')!
  assert.deepEqual(referenceMessages(source.context), [
    { role: 'user', text: '故事发生在老宅' }, { role: 'assistant', text: '已确认老宅' },
    { role: 'user', text: '让悬念更强', reference_documents: [document] },
  ])
  assert.equal(source.before.filter(message => message.role === 'user').length, 2, 'do not duplicate the user bubble')
  assert.equal(messages.at(-1)!.text, '这段回复不满意', 'the original branch remains intact for archive or rollback')
})

test('failed questions can retry but pending replies, older turns, and standalone notices cannot', () => {
  const question = { id: 'q', role: 'user' as const, text: '根据引用文档改写', failed: true }
  const failed = { id: 'a', role: 'assistant' as const, text: '生成失败', failed: true }
  const source = regenerationSource([question, failed], failed.id)!
  assert.equal(source.context[0].failed, false)
  assert.equal(question.failed, true)
  assert.equal(regenerationSource([question, { ...failed, pending: true }], failed.id), null)
  assert.equal(regenerationSource([question, failed, { id: 'later', role: 'user', text: '新决定' }], failed.id), null)
  assert.equal(regenerationSource([question, failed, { id: 'saved', role: 'assistant', text: '已保存' }], 'saved'), null)
  assert.equal(regenerationSource([{ id: 'welcome', role: 'assistant', text: '欢迎' }], 'welcome'), null)
})
