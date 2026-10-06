import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choiceTitle, parseMessageChoices } from '../src/director-choices'

test('legacy choices retain complete explanations and derive short button titles', () => {
  const text = '天道悬疑：小宗门验尸弟子发现了埋在禁地的飞升者遗骸。他必须在师父飞升前查明真相。'
  const parsed = parseMessageChoices(JSON.stringify({ kind: 'choices', question: '想写哪种故事？', options: [{ id: 'mystery', text }, { text: '热血逆命：从解救同伴开始，挑战仙门秩序。' }] }))!
  assert.equal(parsed.options[0].title, '天道悬疑')
  assert.equal(parsed.options[0].text, text)
  assert.equal(parsed.options[1].label, '2')
  assert.ok(choiceTitle('一'.repeat(120)).length < 70)
})
test('structured titles and supporting prose survive fenced replies', () => {
  const parsed = parseMessageChoices('```json\n' + JSON.stringify({ kind: 'choices', question: '选哪个？', intro: '完整推荐说明', trailing: '推荐理由', options: [{ id: 'a', title: '御剑考执照', text: '天才剑修被规则限制，进入凡人补考班。' }, { id: 'b', title: '师兄入魔了', text: '师弟希望带师兄回家。' }] }) + '\n```')!
  assert.equal(parsed.options[0].title, '御剑考执照')
  assert.equal(parsed.intro, '完整推荐说明')
  assert.equal(parsed.trailing, '推荐理由')
})
test('ambiguous ids and incomplete choices do not create unusable question controls', () => {
  for (const options of [[{ id: 'a', text: '甲' }, { id: 'a', text: '乙' }], [{ text: '甲' }], [{ text: ' ' }, { text: '乙' }]]) {
    assert.equal(parseMessageChoices(JSON.stringify({ kind: 'choices', question: '选择？', options })), null)
  }
  assert.equal(parseMessageChoices('普通对话'), null)
})
test('custom choice behavior comes from structured metadata instead of option wording', () => {
  const parsed = parseMessageChoices(JSON.stringify({ kind: 'choices', question: '选择？', options: [
    { id: 'a', text: '其他方向' }, { id: 'b', text: '自由输入', kind: 'custom' },
  ] }))!
  assert.equal(parsed.options[0].kind, undefined)
  assert.equal(parsed.options[1].kind, 'custom')
})

test('structured open questions retain original suggestions without fabricating options; invalid fields fail closed', () => {
  const fields = [{ id: 'family', label: '直系亲属' }, { id: 'inlaw', label: '姻亲身份', suggestions: ['儿媳', '女婿'] }]
  const parsed = parseMessageChoices(JSON.stringify({ kind: 'input_request', question: '确定人物身份', fields }))!
  assert.deepEqual(parsed.fields, fields)
  assert.deepEqual(parsed.options, [])
  for (const invalid of [[], [fields[0], fields[0]], [{ id: 'bad', label: '  ' }], [{ id: 'bad', label: '身份', suggestions: [3] }]]) {
    assert.equal(parseMessageChoices(JSON.stringify({ kind: 'input_request', question: '确定人物', fields: invalid })), null)
  }
})
