import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remapRepairRange, scriptRepairEvidence } from '../src/modules/script/script-repair-evidence.js'
import { applyResolvedEdits } from '../src/modules/script/script-revision.js'

test('numbered repairs disambiguate identical text by the supplied position and retain unrelated bytes', () => {
  const content = '第一场。动机待定。\r\n第二场。动机待定。\r\n结局保持。'
  const start = content.lastIndexOf('动机待定。')
  const evidence = scriptRepairEvidence([{ kind: 'candidate', key: 'outline', start, end: start + 5, content }], 'v1')
  const unit = evidence.passages[0]!.units[0]!
  const result = evidence.resolve(evidence.schema.parse({ summary: '只补齐第二场', status: 'repaired', edits: [
    { start_id: unit.id, end_id: unit.id, replace: '动机为履行承诺。', reason: '具体化第二场动机' },
  ] }))
  assert.equal(result.candidates[0]!.changes[0]!.find, '动机待定。')
  assert.equal(applyResolvedEdits(content, result.candidates[0]!.changes), '第一场。动机待定。\r\n第二场。动机为履行承诺。\r\n结局保持。')
})

test('numbered evidence rejects cross-document, cross-kind, unread-gap, reversed and stale ranges', () => {
  const content = '第一句。第二句。' + '其他已知剧情。'.repeat(400) + '结尾句。'
  const evidence = scriptRepairEvidence([
    { kind: 'candidate', key: 'outline', start: 0, end: 8, content },
    { kind: 'candidate', key: 'outline', start: content.length - 4, end: content.length, content },
    { kind: 'candidate', key: 'world', start: 0, end: 8, content },
    { kind: 'source', key: 'script-source', start: 0, end: 8, content },
  ], 'v1')
  const first = evidence.passages[0]!.units[0]!.id, second = evidence.passages[0]!.units[1]!.id
  const gaps = evidence.passages[1]!.units[0]!.id, foreign = evidence.passages[2]!.units[0]!.id, source = evidence.passages[3]!.units[0]!.id
  for (const [start_id, end_id] of [[first, gaps], [first, foreign], [first, source], [second, first]]) {
    assert.throws(() => evidence.resolve({ summary: '非法范围', status: 'repaired', edits: [{ start_id, end_id, replace: '改写。', reason: '测试' }] }), /同一份已提供的连续原文/)
  }
  const revised = scriptRepairEvidence([{ kind: 'candidate', key: 'outline', start: 0, end: 8, content: content.replace('第一', '开场') }], 'v2')
  assert.equal(revised.schema.safeParse({ summary: '旧编号', status: 'repaired', edits: [{ start_id: first, end_id: first, replace: '错误。', reason: '旧位置' }] }).success, false)
})

test('overlapping evidence windows share one numbering and overlapping replacements remain invalid', () => {
  const content = '第一句。第二句。第三句。'
  const evidence = scriptRepairEvidence([
    { kind: 'candidate', key: 'outline', start: 0, end: 8, content },
    { kind: 'candidate', key: 'outline', start: 4, end: 12, content },
  ], 'v')
  assert.equal(evidence.passages.length, 1)
  assert.equal(evidence.passages[0]!.units.map(unit => unit.text).join(''), content)
  const [first, second, third] = evidence.passages[0]!.units
  const result = evidence.resolve({ summary: '重叠修改', status: 'repaired', edits: [
    { start_id: first!.id, end_id: second!.id, replace: '第一项。', reason: '第一项' },
    { start_id: second!.id, end_id: third!.id, replace: '第二项。', reason: '第二项' },
  ] })
  assert.throws(() => applyResolvedEdits(content, result.candidates[0]!.changes), /相互重叠/)
  assert.throws(() => evidence.resolve({ summary: '没有修改', status: 'repaired', edits: [
    { start_id: first!.id, end_id: first!.id, replace: first!.text, reason: '重复原文' },
  ] }), /完全相同/)
})

test('range remapping follows expansion, deletion and multiple preceding repairs', () => {
  const change = (start: number, end: number, replace: string) => ({ start, end, replace, find: '原文', reason: '修订' })
  const edits = [change(3, 6, 'abcdefghij'), change(10, 15, '')]
  assert.deepEqual(remapRepairRange({ start: 0, end: 3 }, edits), { start: 0, end: 3 })
  assert.deepEqual(remapRepairRange({ start: 3, end: 6 }, edits), { start: 3, end: 13 })
  assert.deepEqual(remapRepairRange({ start: 4, end: 5 }, edits), { start: 3, end: 13 })
  assert.deepEqual(remapRepairRange({ start: 10, end: 15 }, edits), { start: 17, end: 17 })
  assert.deepEqual(remapRepairRange({ start: 20, end: 25 }, edits), { start: 22, end: 27 })
})
