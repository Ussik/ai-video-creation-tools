import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSourceSections, scriptSourcePassages, sourceMapSchema,
  sourcePromptUnits, sourceWorkPlan, validateSourceCoverage, workPassages } from '../src/modules/script/script-source-map.js'

test('dense headings, long paragraphs, episodes and Unicode retain exact source coordinates across output pages', () => {
  for (const content of [
    Array.from({ length: 160 }, (_, index) => `## ${index} 世界规则\r\n### 人物设定\r\n${'江河有灵，😀渡舟。'.repeat(25)}\r\n`).join(''),
    `第1集\n${'😀连续对白。'.repeat(3000)}\n第2集\n终章`,
  ]) {
    const passages = scriptSourcePassages(content), work = sourceWorkPlan(passages)
    assert.equal(passages.map(passage => passage.units.map(unit => unit.text).join('')).join(''), content)
    assert.equal(passages.map(passage => sourcePromptUnits(passage.units).map(unit => unit.text).join('')).join(''), content)
    assert.equal(work.map(item => workPassages(passages, item).map(p => p.content).join('')).join(''), content)
    assert.ok(work.length > 1)
    assert.ok(work.every(item => item.length > 0 && item.length <= 12000 && item.depth === 0))
    const starts = new Set(passages.flatMap(passage => passage.units.map(unit => unit.offset)))
    let end = 0
    for (const item of work) {
      assert.equal(item.offset, end); assert.ok(starts.has(item.offset)); end += item.length
    }
    assert.equal(end, content.length)
    for (const unit of passages.flatMap(passage => passage.units)) {
      assert.equal(content.slice(unit.offset, unit.offset + unit.text.length), unit.text)
      assert.doesNotMatch(unit.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/)
    }
  }
})

test('short manuscripts keep one output page and long manuscripts have deterministic bounded output windows', () => {
  for (const length of [1, 8000, 12000, 16000]) {
    assert.deepEqual(sourceWorkPlan(scriptSourcePassages('文'.repeat(length))), [{ offset: 0, length, depth: 0 }])
  }
  assert.deepEqual(sourceWorkPlan([]), [])
  const content = '文'.repeat(16001), passages = scriptSourcePassages(content)
  const work = sourceWorkPlan(passages)
  assert.ok(work.length > 1)
  assert.ok(work.every(item => item.length <= 12000))
  assert.deepEqual(work, sourceWorkPlan(passages))
})

test('a 65,594-character 59-episode manuscript uses episode boundaries and every completed page contributes exact verified coverage', () => {
  const headings = Array.from({ length: 59 }, (_, id) => `第${id + 1}集\n`)
  const bodyCharacters = 65594 - headings.join('').length
  const ending = '终场，沈月归还信物，城市恢复流动。\n'
  const content = headings.map((heading, id) => {
    const bodyLength = Math.floor(bodyCharacters / headings.length) + (id < bodyCharacters % headings.length ? 1 : 0)
    const suffix = id === headings.length - 1 ? ending : '😀\n \t\n'
    return heading + '林舟与沈月沿旧城寻找信物。\n'.repeat(100).slice(0, bodyLength - suffix.length) + suffix
  }).join('')
  assert.equal(content.length, 65594)
  const passages = scriptSourcePassages(content), work = sourceWorkPlan(passages)
  assert.ok(work.length >= 6 && work.length <= 10)
  assert.equal(work.map(item => workPassages(passages, item).map(passage => passage.content).join('')).join(''), content)
  const sections = work.flatMap(item => {
    assert.match(content.slice(item.offset), /^第\d+集\n/, 'pages prefer a complete episode heading over a nearby arbitrary passage')
    assert.ok(item.length <= 12000)
    const selected = workPassages(passages, item), units = selected.flatMap(passage => passage.units)
    const lastEvidence = units.filter(unit => unit.text.trim()).at(-1)!
    const resolved = resolveSourceSections(sourceMapSchema.parse({ sections: [{
      start_unit: units[0]!.id, title: '本页目录', episode_number: null, summary: '保留本页事件', characters: [],
      events: [{ summary: '本页最后的原文事实', evidence: { unit_id: lastEvidence.id } }],
    }] }), selected)
    assert.deepEqual(resolved.problems, [])
    return resolved.sections
  })
  validateSourceCoverage(content, sections)
  assert.match(sections.at(-1)!.events[0]!.evidence.quote, /城市恢复流动/)
  assert.throws(() => validateSourceCoverage(content, sections.filter((_, id) => id !== 1)), /未完整连续覆盖/)
  assert.throws(() => validateSourceCoverage(content, [sections[0]!, ...sections]), /未完整连续覆盖/)
})

test('one very long episode pages on existing passage boundaries without cutting Unicode or whitespace', () => {
  const content = `\n \t第1集\n${'😀连续对白。\n\n \t'.repeat(4000)}终章，完整保留。\n\n`
  const passages = scriptSourcePassages(content), work = sourceWorkPlan(passages)
  const starts = new Set(passages.map(passage => passage.offset))
  assert.ok(work.length >= 3)
  assert.equal(work.map(item => workPassages(passages, item).map(passage => passage.content).join('')).join(''), content)
  for (const item of work) {
    assert.ok(starts.has(item.offset))
    assert.ok(item.length > 0 && item.length <= 12000)
    assert.doesNotMatch(content.slice(item.offset, item.offset + item.length), /^[\udc00-\udfff]|[\ud800-\udbff]$/)
  }
})

test('a heading at the target boundary starts the following output page with its body', () => {
  const opening = '序幕。\n'.repeat(2000)
  assert.equal(opening.length, 8000)
  const content = `${opening}第2集\n${'河岸行动。\n'.repeat(3000)}`
  const passages = scriptSourcePassages(content), work = sourceWorkPlan(passages)
  assert.equal(work[0]!.length, opening.length)
  assert.equal(work[1]!.offset, opening.length)
  assert.match(workPassages(passages, work[1]!).map(passage => passage.content).join(''), /^第2集\n河岸行动/)
  assert.equal(work.map(item => workPassages(passages, item).map(passage => passage.content).join('')).join(''), content)
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
