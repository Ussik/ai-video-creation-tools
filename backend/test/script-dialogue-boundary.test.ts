import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertDialogueBoundary, dialogueDifferenceWindow, reviewDialogueRevision } from '../src/modules/script/script-dialogue-boundary.js'

const report = (before: string, after: string, occurrence = 0) => ({ verdict: 'allowed', explanation: '仅改变现有台词表达，原意与语气保留。',
  changes: [{ before: { quote: before, occurrence }, after: { quote: after, occurrence: 0 } }] })

test('dialogue scope uses exact indexed speech without changing speaker, parentheticals or surrounding action', () => {
  const target = { key: 'doc', title: '末班车', before: '林晚（攥住衣袖）：等我。\n列车进站。\n陈默：等我。',
    after: '林晚（攥住衣袖）：等我。\n列车进站。\n陈默：再等我一下。' }
  assert.doesNotThrow(() => assertDialogueBoundary(target, report('等我。', '再等我一下。', 1)))
  assert.throws(() => assertDialogueBoundary(target, report('等我。', '再等我一下。', 0)), /对白范围以外/)
  assert.throws(() => assertDialogueBoundary(target, report('等我。', '再等我一下。', 2)), /无法精确定位/)
  for (const after of [target.after.replace('进站', '驶离'), target.after.replace('攥住衣袖', '跳下站台'), target.after.replace('陈默：', '林晚：')]) {
    assert.throws(() => assertDialogueBoundary({ ...target, after }, report('等我。', '再等我一下。', 1)), /对白范围以外/)
  }
})

test('scope checks preserve arbitrary language style and accept long speech and catchphrases', () => {
  const before = '哎呀，' + '你先听我把这件事从头说完，'.repeat(100) + '好不好？'
  const after = '哎呀，' + '你先听我把这件事从头说完，'.repeat(100) + '成不成？'
  assert.doesNotThrow(() => assertDialogueBoundary({ key: 'doc', title: '长对白', before: `**小满**：${before}\n（他背过身。）`, after: `**小满**：${after}\n（他背过身。）` }, report(before, after)))
})

test('scope extraction only receives the change window and necessary context', async () => {
  const target = { key: 'doc', title: '长文', before: '前文。'.repeat(10_000) + '小满：我等你。' + '后文。'.repeat(10_000),
    after: '前文。'.repeat(10_000) + '小满：我在这儿等你。' + '后文。'.repeat(10_000) }
  const window = dialogueDifferenceWindow(target)
  assert.ok(window.offset > 0)
  assert.ok(window.before.length < 2500)
  let calls = 0
  await reviewDialogueRevision({ targets: [target], context: { genre: '温情生活流' } }, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_dialogue_boundary')
    assert.ok(prompt.length < 10_000)
    assert.match(prompt, /不是错误/)
    assert.match(prompt, /温情生活流/)
    return JSON.stringify(report('我等你。', '我在这儿等你。'))
  })
  assert.equal(calls, 1)
})

test('uncertain range and new plot facts are recoverable failures without a creative rewrite retry', async () => {
  const target = { key: 'doc', title: '无标记原文', before: '我等你。', after: '我是你的父亲。' }
  for (const verdict of ['uncertain', 'out_of_scope'] as const) {
    let calls = 0
    await assert.rejects(reviewDialogueRevision({ targets: [target], context: {} }, async () => {
      calls++
      return JSON.stringify({ verdict, explanation: verdict === 'uncertain' ? '无法确定原句是否为说出口的台词。' : '新增了父子关系，改变剧情事实。', changes: [] })
    }), /未通过对白专项范围核对/)
    assert.equal(calls, 1)
  }
})

test('an allowed verdict cannot bypass exact protected text comparison or overlapping ranges', () => {
  const target = { key: 'doc', title: '候选正文', before: '他关门。\n小满：等我。', after: '他拔剑。\n小满：等等我。' }
  assert.throws(() => assertDialogueBoundary(target, report('等我。', '等等我。')), /对白范围以外/)
  assert.throws(() => assertDialogueBoundary(target, { ...report('等我。', '等等我。'), changes: [
    ...report('等我。', '等等我。').changes, ...report('等我。', '等等我。').changes,
  ] }), /重叠范围/)
})
