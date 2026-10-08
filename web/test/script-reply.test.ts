import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAdoptReply, classificationBatch, classificationKey, activeReplyChoice, episodePreparationAction, followingMessages, latestReplyNeedsRecognition, replyChoices, replyRecognitionState, replyClassificationVersion, type ClassifiableMessage } from '../src/script-reply'

test('adoption requires positive model metadata, never words about episodes or scripts', () => {
  const base: ClassifiableMessage = { id: 'reply', role: 'assistant', text: '第一集剧本，第1集完。' }
  assert.equal(canAdoptReply(base), false)
  assert.equal(canAdoptReply({ ...base, classification: { type: 'other' } }), false)
  const body = { ...base, text: '雨夜候车室里的完整场次。', classification_version: replyClassificationVersion, classification: { type: 'episode_script' as const, episode_number: 2 } }
  assert.equal(canAdoptReply(body), true)
  assert.equal(canAdoptReply({ ...body, role: 'user' }), false)
  assert.equal(canAdoptReply({ ...body, pending: true }), false)
  assert.equal(canAdoptReply({ ...body, failed: true }), false)
})

test('episode setup offers an explicit action only for the current model classified reply, without adoption', () => {
  const setup: ClassifiableMessage = { id: 'setup', role: 'assistant', text: '这一场先试节奏，确认后展开完整正文。',
    classification_version: replyClassificationVersion, classification: { type: 'episode_preparation', episode_number: 7 } }
  assert.deepEqual(episodePreparationAction([setup]), { messageId: 'setup', episode_number: 7 })
  assert.equal(canAdoptReply(setup), false)
  for (const stale of [{ ...setup, pending: true }, { ...setup, failed: true }, { ...setup, classification_version: 2 },
    { ...setup, classification: undefined }, { ...setup, classification: { type: 'other' as const } }]) {
    assert.equal(episodePreparationAction([stale]), null)
  }
  assert.equal(episodePreparationAction([setup, { id: 'new', role: 'user', text: '先调整人物' }]), null)
  assert.equal(episodePreparationAction([setup, { id: 'new', role: 'assistant', text: '处理中', pending: true }]), null)
  assert.equal(episodePreparationAction([{ ...setup, classification: { type: 'episode_preparation', episode_number: 201 } }]), null)
})

function choiceMessage(status: 'pending' | 'answered' | 'superseded' = 'pending'): ClassifiableMessage {
  return { id: 'question', role: 'assistant', text: '如果是祖母，亲缘温暖；如果是养母，孤立感更突出。你倾向哪条？',
    classification_version: replyClassificationVersion, classification_context: '[]',
    classification: { type: 'choice_request', status, question: '你倾向哪条？', options: [
      { id: 'grandmother', title: '祖母', text: '祖母，亲缘温暖' },
      { id: 'foster', title: '养母', text: '养母，孤立感更突出' },
    ] } }
}

test('recognition status belongs to the latest unchanged reply; history work and failures stay silent', () => {
  const old: ClassifiableMessage = { id: 'old', role: 'assistant', text: '历史问题' }
  const latest: ClassifiableMessage = { id: 'latest', role: 'assistant', text: '当前问题' }
  const messages: ClassifiableMessage[] = [old, { id: 'user', role: 'user', text: '推进' }, latest]
  const key = classificationKey({ ...latest, following_messages: [] })
  const historical = { old: classificationKey({ ...old, following_messages: followingMessages(messages, 0) }) }
  assert.equal(replyRecognitionState(messages, 'latest', historical, historical), null)
  assert.equal(replyRecognitionState(messages, 'old', historical, historical), null)
  assert.equal(replyRecognitionState(messages, 'latest', { latest: key }, {}), 'processing')
  assert.equal(replyRecognitionState(messages, 'latest', {}, { latest: key }), 'error')
  assert.equal(replyRecognitionState([...messages.slice(0, -1), { ...latest, text: '改写的回复' }], 'latest', { latest: key }, { latest: key }), null)
  assert.equal(replyRecognitionState([...messages, { id: 'new-user', role: 'user', text: '继续' }], 'latest', { latest: key }, { latest: key }), null)
  for (const change of [{ pending: true }, { failed: true }, { classification_version: replyClassificationVersion, classification: { type: 'other' as const } }]) {
    assert.equal(replyRecognitionState([...messages.slice(0, -1), { ...latest, ...change }], 'latest', { latest: key }, { latest: key }), null)
  }
})

test('ready choices immediately end the current status even while recognition housekeeping remains', () => {
  const choice = choiceMessage()
  const key = classificationKey({ ...choice, following_messages: [] })
  assert.equal(replyRecognitionState([choice], choice.id, { [choice.id]: key }, { [choice.id]: key }), null)
  const structured: ClassifiableMessage = { id: 'structured', role: 'assistant', text: JSON.stringify({ kind: 'choices', question: '哪个？', options: [{ id: 'a', title: '甲', text: '方案甲' }, { id: 'b', title: '乙', text: '方案乙' }] }) }
  const structuredKey = classificationKey({ ...structured, following_messages: [] })
  assert.equal(replyRecognitionState([structured], structured.id, { [structured.id]: structuredKey }, {}), null)
})

test('explicit retries target only the selected reply instead of unrelated unknown history', () => {
  const old: ClassifiableMessage = { id: 'old', role: 'assistant', text: '历史问题' }
  const latest: ClassifiableMessage = { id: 'latest', role: 'assistant', text: '当前问题' }
  assert.deepEqual(classificationBatch([old, latest], new Set(), old.id).map(source => source.id), [old.id])
  assert.deepEqual(classificationBatch([old, latest], new Set()).map(source => source.id), [latest.id])
})

test('plain choices need model metadata; original text and original options are retained', () => {
  const message = choiceMessage()
  assert.equal(replyChoices({ ...message, classification: undefined }), null)
  assert.equal(replyChoices({ ...message, classification: { type: 'other' } }), null)
  assert.equal(replyChoices({ ...message, pending: true }), null)
  assert.deepEqual(activeReplyChoice([message], {}, null)?.choice.options.map(option => option.label), ['grandmother', 'foster'])
  assert.equal(message.text, '如果是祖母，亲缘温暖；如果是养母，孤立感更突出。你倾向哪条？')
  assert.equal(canAdoptReply(message), false)
  assert.equal(activeReplyChoice([message], { question: true }, null), null)
  assert.equal(activeReplyChoice([choiceMessage('answered')], {}, null), null)
  assert.equal(activeReplyChoice([choiceMessage('superseded')], {}, null), null)
})

test('changed conversation invalidates pending choice state, and answered history never replaces latest dialogue', () => {
  const message = choiceMessage()
  const answer: ClassifiableMessage = { id: 'answer', role: 'user', text: '用养母这个方向。' }
  const pending: ClassifiableMessage = { id: 'writing', role: 'assistant', text: '正在创作', pending: true }
  const messages = [message, answer, pending]
  assert.equal(activeReplyChoice(messages, {}, null), null)
  assert.equal(activeReplyChoice(messages, {}, message.id)?.messageId, message.id, 'explicit answer submission keeps its composer while awaiting response')
  assert.deepEqual(classificationBatch(messages, new Set()), [{ id: message.id, text: message.text, following_messages: [{ role: 'user', text: answer.text }] }])
  const classified = { ...message, classification_context: JSON.stringify(followingMessages(messages, 0)) }
  assert.equal(classificationBatch([classified, answer], new Set()).length, 0)
  assert.equal(activeReplyChoice([classified, answer], {}, null), null)
  assert.equal(activeReplyChoice([classified, { id: 'comparison', role: 'assistant', text: '这两条各有优势。', classification_version: replyClassificationVersion, classification: { type: 'other' } }], {}, null), null)
  assert.equal(activeReplyChoice([choiceMessage('answered'), answer, pending], {}, message.id), null)
})

test('old classifications are upgraded; valid structured choices need no repair call', () => {
  const old: ClassifiableMessage = { id: 'old', role: 'assistant', text: '哪个方向更合适？', classification_version: 3, classification: { type: 'other' } }
  assert.equal(classificationBatch([old], new Set()).length, 1)
  const structured: ClassifiableMessage = { id: 'structured', role: 'assistant', text: JSON.stringify({ kind: 'choices', question: '选哪个？', options: [
    { id: 'a', title: '祖母', text: '亲缘温暖' }, { id: 'b', title: '养母', text: '孤立感' },
  ] }) }
  assert.equal(classificationBatch([structured], new Set()).length, 0)
  assert.equal(activeReplyChoice([structured], {}, null)?.messageId, structured.id)
})

test('only unknown completed assistant replies enter bounded classification batches', () => {
  const messages: ClassifiableMessage[] = [
    { id: 'welcome', role: 'assistant', text: '欢迎' },
    { id: 'user', role: 'user', text: '写第一集' },
    { id: 'pending', role: 'assistant', text: '处理中', pending: true },
    { id: 'failed', role: 'assistant', text: '失败', failed: true },
    { id: 'notice', role: 'assistant', text: '已保存', classification_version: replyClassificationVersion, classification: { type: 'other' } },
    { id: 'old', role: 'assistant', text: '普通讨论也应由模型识别，而不是前端猜测' },
    { id: 'new', role: 'assistant', text: '尚未识别的正文' },
  ]
  const excluded = new Set([classificationKey(messages.at(-1)!)])
  assert.deepEqual(classificationBatch(messages, excluded).map(item => item.id), ['old'])
  assert.equal(classificationBatch([{ ...messages.at(-1)!, text: '内容更新' }], excluded).length, 1)
  const many = Array.from({ length: 20 }, (_, index): ClassifiableMessage => ({ id: String(index), role: 'assistant', text: '消息' }))
  assert.deepEqual(classificationBatch(many, new Set()).map(item => item.id), ['19'], 'the latest reply is analyzed separately from answered history')
  const history = [...many, { id: 'user-after', role: 'user' as const, text: '继续' }]
  assert.equal(classificationBatch(history, new Set()).length, 10)
  const long = many.map(message => ({ ...message, text: '中文'.repeat(3000) }))
  const batch = classificationBatch([...long, history.at(-1)!], new Set())
  assert.ok(batch.length > 0)
  assert.ok(new TextEncoder().encode(JSON.stringify(batch)).length <= 40_000)
})

test('a mixed follow-up opens only the new bounded choice and retains model-required detail metadata', () => {
  const old = choiceMessage('answered')
  const latest: ClassifiableMessage = { id: 'mixed', role: 'assistant', text: '关系已确认。亲属具体是谁？顾问全部保留还是只选一两人？',
    classification_version: replyClassificationVersion, classification_context: '[]',
    classification: { type: 'choice_request', status: 'pending', question: '顾问如何保留？', options: [
      { id: 'all', title: '全部保留', text: '律师、管家、医生全部保留' },
      { id: 'subset', title: '只保留一两人', text: '只选其中一两人', requires_details: true },
    ] } }
  const messages: ClassifiableMessage[] = [old, { id: 'answer', role: 'user', text: '已选择旧方向' }, latest]
  const active = activeReplyChoice(messages, {}, null)!
  assert.equal(active.messageId, latest.id)
  assert.equal(active.choice.options[1].requires_details, true)
  assert.equal(canAdoptReply(latest), false)
  assert.equal(activeReplyChoice(messages, { mixed: true }, null), null)
})

test('model-identified open requests create forms and follow-up context invalidates stale pending state', () => {
  const message: ClassifiableMessage = { id: 'form', role: 'assistant', text: '亲属是谁？', classification_version: replyClassificationVersion, classification_context: '[]',
    classification: { type: 'input_request', status: 'pending', question: '亲属是谁？', fields: [{ id: 'family', label: '直系亲属' }] } }
  assert.equal(activeReplyChoice([message], {}, null)?.choice.fields?.[0].id, 'family')
  assert.equal(canAdoptReply(message), false)
  assert.equal(activeReplyChoice([{ ...message, classification: { ...message.classification, status: 'answered' } } as ClassifiableMessage], {}, null), null)
  const answered: ClassifiableMessage[] = [message, { id: 'answer', role: 'user', text: '父亲和女儿' }]
  assert.equal(activeReplyChoice(answered, {}, null), null)
  assert.equal(classificationBatch(answered, new Set())[0].id, 'form')
  assert.equal(activeReplyChoice([message], { form: true }, null), null)
  const structured = { id: 'direct-form', role: 'assistant' as const, text: JSON.stringify({ kind: 'input_request', question: '亲属是谁？', fields: [{ id: 'family', label: '直系亲属' }] }) }
  assert.equal(classificationBatch([structured], new Set()).length, 0)
  assert.equal(activeReplyChoice([structured], {}, null)?.messageId, structured.id)
})


test('plain confirmations and grouped questions use semantic metadata, refresh with context and invalidate old recognition', () => {
  const message: ClassifiableMessage = { id: 'confirm', role: 'assistant', text: '是否按这个三幕框架推进？', classification_version: replyClassificationVersion, classification_context: '[]',
    classification: { type: 'confirmation_request', status: 'pending', question: '是否按这个三幕框架推进？' } }
  assert.deepEqual(activeReplyChoice([message], {}, null)!.choice.options.map(option => option.title), ['同意', '需要调整'])
  assert.equal(classificationBatch([{ ...message, classification_version: 6 }], new Set()).length, 1)
  const answered = { ...message, classification: { ...message.classification!, status: 'answered' } } as ClassifiableMessage
  assert.equal(activeReplyChoice([answered], {}, null), null)
  const grouped: ClassifiableMessage = { ...message, id: 'mixed', classification: { type: 'question_set', status: 'pending', question: '框架与人物', questions: [
    { id: 'framework', kind: 'confirmation', question: '接受框架？' },
    { id: 'role', kind: 'input_request', question: '职业？', fields: [{ id: 'role', label: '职业' }] },
  ] } }
  assert.equal(activeReplyChoice([grouped], {}, null)!.choice.questions!.length, 2)
})

test('long replies are recognized intact and multi-item answers keep the final answer in follow-up context', () => {
  const reply: ClassifiableMessage = { id: 'long', role: 'assistant', text: '方案说明。'.repeat(2000) + '接受这个框架吗？' }
  const batch = classificationBatch([reply], new Set())
  assert.equal(batch.length, 1)
  assert.equal(batch[0].text, reply.text)
  const answer: ClassifiableMessage = { id: 'answer', role: 'user', text: '首项回答。'.repeat(6800) + '最后一项：医生' }
  assert.equal(followingMessages([reply, answer], 0)[0].text, answer.text)
})


test('stage suggestions wait for the current reply recognition while historical work leaves a resolved current reply available', () => {
  const unknown: ClassifiableMessage = { id: 'unknown', role: 'assistant', text: '是否接受当前方案？' }
  assert.equal(latestReplyNeedsRecognition([unknown]), true)
  assert.equal(latestReplyNeedsRecognition([{ ...unknown, classification_version: 6, classification: { type: 'other' } }]), true)
  const resolved = { ...unknown, classification_version: replyClassificationVersion, classification: { type: 'other' as const } }
  assert.equal(latestReplyNeedsRecognition([unknown, resolved]), false)
  assert.equal(latestReplyNeedsRecognition([{ ...unknown, failed: true }]), false)
  assert.equal(latestReplyNeedsRecognition([{ ...unknown, text: JSON.stringify({ kind: 'confirmation', question: '接受方案？' }) }]), false)
})
