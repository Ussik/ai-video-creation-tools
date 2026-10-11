import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSpeechSceneEntries } from '../src/speech-import.js'

const scene = (dialogue = '', narration = '') => ({ id: 'scene-1', dialogue, narration })

test('explicit speaker labels share one role despite Markdown and different performance cues', () => {
  const entries = parseSpeechSceneEntries(scene([
    '林晚（低声）：别过去。',
    '**林晚**：（停顿）等我。',
    '**林晚（颤抖）：**（深呼吸）我能做到。',
    '- 陈默（坚定）（压低声音）: 我会守住出口。',
  ].join('\n')))
  assert.deepEqual(entries.map(({ name, text, instructions }) => ({ name, text, instructions })), [
    { name: '林晚', text: '别过去。', instructions: '低声' },
    { name: '林晚', text: '等我。', instructions: '停顿' },
    { name: '林晚', text: '我能做到。', instructions: '颤抖；深呼吸' },
    { name: '陈默', text: '我会守住出口。', instructions: '坚定；压低声音' },
  ])
})

test('unlabeled lines remain unresolved instead of inheriting a previous speaker', () => {
  const entries = parseSpeechSceneEntries(scene('林晚：别过去。\r\n我们得离开。\r\n（低声）你听见了吗？\r\n\r\n陈默: 我听见了。'))
  assert.deepEqual(entries.map(({ name, text, instructions }) => ({ name, text, instructions })), [
    { name: '林晚', text: '别过去。', instructions: '' },
    { name: '待分配角色', text: '我们得离开。', instructions: '' },
    { name: '待分配角色', text: '你听见了吗？', instructions: '低声' },
    { name: '陈默', text: '我听见了。', instructions: '' },
  ])
  assert.equal(entries.at(-1)?.key, 'scene-1:dialogue:4:part:0')
})

test('performance-only lines and blank text do not become spoken audio entries', () => {
  assert.deepEqual(parseSpeechSceneEntries(scene('林晚：\n（沉默）\n陈默（叹气）：', '（沉稳）')), [])
})

test('narration uses its own role and extracts leading delivery instructions', () => {
  assert.deepEqual(parseSpeechSceneEntries(scene('', '（平静）(轻声)灯光熄灭，站厅陷入寂静。')), [
    { name: '旁白', text: '灯光熄灭，站厅陷入寂静。', instructions: '平静；轻声', key: 'scene-1:narration:part:0' },
  ])
})

test('long narration is split within the same editable limit without dropping content', () => {
  const text = '甲'.repeat(3900) + '。”\n' + '乙'.repeat(3500) + '！' + '丙'.repeat(2600)
  const entries = parseSpeechSceneEntries(scene('', text))
  assert.ok(entries.length > 1)
  assert.ok(entries.every(entry => entry.text.length <= 5000))
  assert.equal(entries.map(entry => entry.text).join(''), text)
  assert.equal(entries[0]?.text, '甲'.repeat(3900) + '。”\n')
  assert.ok(entries.every(entry => entry.name === '旁白'))
  assert.deepEqual(entries.map(entry => entry.key), entries.map((_, index) => `scene-1:narration:part:${index}`))
  assert.deepEqual(parseSpeechSceneEntries(scene('', text)), entries, 're-import produces identical source keys')
})

test('long dialogue retains one speaker and performance on every part', () => {
  const spoken = 'a'.repeat(4900) + '! ' + 'b'.repeat(2000)
  const entries = parseSpeechSceneEntries(scene(`林晚（低声）：${spoken}`))
  assert.equal(entries.length, 2)
  assert.ok(entries.every(entry => entry.name === '林晚' && entry.instructions === '低声' && entry.text.length <= 5000))
  assert.equal(entries.map(entry => entry.text).join(''), spoken)
  assert.deepEqual(entries.map(entry => entry.key), ['scene-1:dialogue:0:part:0', 'scene-1:dialogue:0:part:1'])
})

test('a hard split never damages a Unicode surrogate pair', () => {
  const spoken = 'a'.repeat(4999) + '😀' + 'z'.repeat(5000)
  const entries = parseSpeechSceneEntries(scene('', spoken))
  assert.ok(entries.every(entry => entry.text.length <= 5000))
  assert.equal(entries[0]?.text.length, 4999)
  assert.equal(entries[1]?.text.startsWith('😀'), true)
  assert.equal(entries.map(entry => entry.text).join(''), spoken)
  for (const { text } of entries) {
    assert.equal(Buffer.from(text).toString('utf8'), text)
  }
})

test('speaker-label formatting removal does not unbalance Markdown in spoken content', () => {
  const entry = parseSpeechSceneEntries(scene('林晚：**别过去。**'))[0]!
  assert.equal(entry.name, '林晚')
  assert.equal(entry.text, '**别过去。**')
})

test('a colon inside a delivery cue does not replace the actual speaker delimiter', () => {
  const entry = parseSpeechSceneEntries(scene('林晚（情绪：焦急）：出口：就在前面。'))[0]!
  assert.equal(entry.name, '林晚')
  assert.equal(entry.instructions, '情绪：焦急')
  assert.equal(entry.text, '出口：就在前面。')
})
