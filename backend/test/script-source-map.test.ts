import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSourceSections, scriptSourcePassages, sourceMapSchema,
  sourcePromptUnits, sourceWorkPlan, validateSourceCoverage, workPassages } from '../src/modules/script/script-source-map.js'

test('dense headings, long paragraphs, episodes and Unicode remain one complete source request', () => {
  for (const content of [
    Array.from({ length: 160 }, (_, index) => `## ${index} 世界规则\r\n### 人物设定\r\n${'江河有灵，😀渡舟。'.repeat(25)}\r\n`).join(''),
    `第1集\n${'😀连续对白。'.repeat(3000)}\n第2集\n终章`,
  ]) {
    const passages = scriptSourcePassages(content), work = sourceWorkPlan(passages)
    assert.equal(passages.map(passage => passage.units.map(unit => unit.text).join('')).join(''), content)
    assert.equal(passages.map(passage => sourcePromptUnits(passage.units).map(unit => unit.text).join('')).join(''), content)
    assert.equal(work.map(item => workPassages(passages, item).map(p => p.content).join('')).join(''), content)
    assert.deepEqual(work, [{ offset: 0, length: content.length, depth: 0 }])
    for (const unit of passages.flatMap(passage => passage.units)) {
      assert.equal(content.slice(unit.offset, unit.offset + unit.text.length), unit.text)
      assert.doesNotMatch(unit.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/)
    }
  }
})

test('compact prompt units preserve whitespace and stable evidence IDs without sending a blank-line ID for every newline', () => {
  const content = '\n\n开场。\n\n\n河岸。\n\n结尾。\n\n'
  const units = scriptSourcePassages(content).flatMap(passage => passage.units), compact = sourcePromptUnits(units)
  assert.equal(compact.map(unit => unit.text).join(''), content)
  assert.ok(compact.length < units.length / 2)
  for (const unit of compact) {
    assert.ok(unit.text.startsWith(units.find(original => original.id === unit.id)!.text))
    assert.equal(unit.text.trimEnd(), units.find(original => original.id === unit.id)!.text.trimEnd())
  }
})

test('local evidence ranges retain exact text without becoming additional source-understanding work', () => {
  const content = '第一句已经分析。第二句还有未完成的内容。第三句结尾。', from = content.indexOf('还有')
  const passages = scriptSourcePassages(content)
  const selected = workPassages(passages, { offset: from, length: content.length - from, depth: 0 })
  assert.equal(selected[0]!.units[0]!.offset, from)
  assert.equal(selected.map(p => p.content).join(''), content.slice(from))
})

test('whole-source semantic maps support more than forty real chapters', () => {
  const content = Array.from({ length: 120 }, (_, index) => `第${index + 1}集\n人物完成本集事件。\n`).join('')
  const passages = scriptSourcePassages(content), units = passages.flatMap(passage => passage.units)
  const sections = units.filter(unit => /^第\d+集/.test(unit.text)).map((unit, index) => ({
    start_unit: unit.id, title: `第${index + 1}集`, summary: '人物完成本集事件', episode_number: index + 1, characters: [], events: [],
  }))
  const resolved = resolveSourceSections(sourceMapSchema.parse({ sections }), passages)
  assert.equal(resolved.sections.length, 120)
  validateSourceCoverage(content, resolved.sections)
})

test('only evidence IDs inside their semantic section can become literal source quotes', () => {
  const content = '主角回到故乡。\n转场：伙伴来到河岸。结尾归还钥匙。', passages = scriptSourcePassages(content)
  const units = passages.flatMap(passage => passage.units), turn = units.find(unit => unit.text.startsWith('转场'))!
  const result = sourceMapSchema.parse({ sections: [
    { start_unit: units[0]!.id, title: '返乡', summary: '主角返乡', episode_number: null, characters: [], events: [{ summary: '返乡', evidence: { unit_id: units[0]!.id } }] },
    { start_unit: turn.id, title: '归还', summary: '伙伴归还钥匙', episode_number: null, characters: [], events: [{ summary: '归还', evidence: { unit_id: units.at(-1)!.id } }] },
  ] })
  const valid = resolveSourceSections(result, passages)
  assert.deepEqual(valid.problems, []); validateSourceCoverage(content, valid.sections)
  assert.equal(valid.sections[1]!.events[0]!.evidence.quote, '结尾归还钥匙。')
  result.sections[0]!.events[0]!.evidence.unit_id = turn.id
  assert.equal(resolveSourceSections(result, passages).problems.length, 1)
  result.sections[0]!.events[0]!.evidence.unit_id = units.find(unit => !unit.text.trim())!.id
  assert.equal(resolveSourceSections(result, passages).problems.length, 1)
  result.sections[1]!.start_unit = result.sections[0]!.start_unit
  assert.throws(() => resolveSourceSections(result, passages), /不能遗漏、重复或重叠/)
  assert.throws(() => validateSourceCoverage(content, valid.sections.slice(0, 1)), /未分析的原文/)
})
