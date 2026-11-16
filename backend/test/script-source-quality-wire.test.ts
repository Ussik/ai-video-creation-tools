import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages, validateSourceCoverage } from '../src/modules/script/script-source-map.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'

const marker = '【原稿分析核对资料】\n'
const content = '第1集 约定\n林舟守约。\n \t\n林舟再次许诺。\n第2集 归还\n沈月归还唯一信物😀。\n'
const units = scriptSourcePassages(content).flatMap(passage => passage.units)
const signal = () => new AbortController().signal
const evidence = (quote: string, offset = content.indexOf(quote)) => ({ offset, quote })
function stateFor(): ScriptSourceAnalysis {
  const split = content.indexOf('第2集')
  return { id: 'quality-wire-fixture', source_version: 'v1', model_id: 'fake', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now', sections: [
      { offset: 0, length: split, unit_id: 77, title: '约定', episode_number: 1, summary: '林舟先后许诺。',
        characters: [{ name: '林舟', description: '再次许诺的人', evidence: evidence('林舟', content.indexOf('林舟再次')) }],
        events: [{ summary: '林舟再次许诺。', evidence: evidence('林舟再次许诺。') }], continues_previous: false, open_threads: ['信物待归还'] },
      { offset: split, length: content.length - split, unit_id: 78, title: '归还', episode_number: 2, summary: '沈月归还信物。',
        characters: [{ name: '沈月', description: '归还信物的人', evidence: evidence('沈月') }],
        events: [{ summary: '沈月归还唯一信物😀。', evidence: evidence('归还唯一信物😀') }], continues_previous: true, open_threads: [] }],
    story: { summary: '许诺并归还信物。', characters: [], timeline: [], threads: [],
      ending: { summary: '唯一信物已归还。', section_ids: [1] }, uncertainties: [] } }
}
function input(prompt: string) {
  const rest = prompt.slice(prompt.lastIndexOf(marker) + marker.length)
  // Correction/page instructions can follow the original data. The direct
  // requests exercised here have only whitespace after the JSON envelope.
  return JSON.parse(rest) as any
}
const response = (state: ScriptSourceAnalysis, findings: unknown[] = []) => JSON.stringify({ checked_section_ids: state.sections.map((_, id) => id), findings })
const assertNoOffsets = (value: unknown) => {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['offset', 'length'].includes(key), `coordinate leaked: ${key}`)
    assertNoOffsets(child)
  }
}

test('review wire preserves complete source, all semantic fields, exact evidence quotes and continuation identities without character coordinates', async () => {
  const state = stateFor(), before = structuredClone(state), hash = sourceQualityInputHash(state)
  let calls = 0
  await reviewSourceQuality({ filename: '原文.txt', content }, state, async prompt => {
    calls++; const body = input(prompt)
    assertNoOffsets(body.sections); assertNoOffsets(body.units)
    assert.equal(body.units.map((unit: any) => unit.text).join(''), content)
    assert.deepEqual(body.story, before.story)
    for (let id = 0; id < before.sections.length; id++) {
      const original = before.sections[id]!, wire = body.sections[id]
      assert.equal(wire.id, id); assert.equal(wire.continuation_group_id, original.unit_id)
      assert.ok(!Object.hasOwn(wire, 'unit_id'))
      for (const key of ['title', 'episode_number', 'summary', 'continues_previous', 'open_threads'] as const) assert.deepEqual(wire[key], original[key])
      const inside = units.filter(unit => unit.offset >= original.offset && unit.offset + unit.text.length <= original.offset + original.length && unit.text.trim())
      assert.deepEqual(wire.source_unit_range, { first: inside[0]!.id, last: inside.at(-1)!.id })
      assert.equal(wire.source_boundary_quotes, undefined)
      for (const group of ['characters', 'events'] as const) for (let at = 0; at < original[group].length; at++) {
        const old = original[group][at]!, actual = wire[group][at], start = old.evidence.offset
        const unit = units.find(unit => start >= unit.offset && start + old.evidence.quote.length <= unit.offset + unit.text.length)!
        assert.deepEqual(actual, { ...old, id: at, evidence: { unit_id: unit.id, quote: old.evidence.quote } })
      }
    }
    assert.match(prompt, /continuation_group_id不是原文句段ID/)
    return response(state)
  }, () => {}, signal())
  assert.equal(calls, 1); assert.deepEqual(state.sections, before.sections); assert.deepEqual(state.story, before.story)
  assert.equal(sourceQualityInputHash(state), hash)
})

test('quote resolution uses the exact offset when identical text occurs in distinct units', async () => {
  const state = stateFor(), old = state.sections[0]!.characters[0]!.evidence
  await reviewSourceQuality({ filename: '重复词.txt', content }, state, async prompt => {
    const actual = input(prompt).sections[0].characters[0].evidence
    const chosen = units.find(unit => old.offset >= unit.offset && old.offset < unit.offset + unit.text.length)!
    const earlier = units.find(unit => unit.text.includes('林舟'))!
    assert.notEqual(chosen.id, earlier.id); assert.equal(actual.unit_id, chosen.id); assert.equal(actual.quote, '林舟')
    return response(state)
  }, () => {}, signal())
})

test('legal legacy partial-unit section boundaries keep exact fragments without new rejection or persisted changes', async () => {
  const state = stateFor(), split = content.indexOf('再次')
  state.sections[0]!.length = split; state.sections[0]!.characters = []; state.sections[0]!.events = []
  state.sections[1]!.offset = split; state.sections[1]!.length = content.length - split
  validateSourceCoverage(content, state.sections)
  const before = structuredClone(state.sections), boundaryUnit = units.find(unit => split > unit.offset && split < unit.offset + unit.text.length)!
  await reviewSourceQuality({ filename: '旧边界.txt', content }, state, async prompt => {
    const body = input(prompt); assertNoOffsets(body.sections)
    assert.deepEqual(body.sections[0].source_boundary_quotes, [{ unit_id: boundaryUnit.id, quote: boundaryUnit.text.slice(0, split - boundaryUnit.offset) }])
    assert.deepEqual(body.sections[1].source_boundary_quotes, [{ unit_id: boundaryUnit.id, quote: boundaryUnit.text.slice(split - boundaryUnit.offset) }])
    assert.equal(body.sections[0].source_unit_range.last, boundaryUnit.id)
    assert.equal(body.sections[1].source_unit_range.first, boundaryUnit.id)
    return response(state)
  }, () => {}, signal())
  assert.deepEqual(state.sections, before)
})

test('legal cross-unit evidence keeps the exact quote and all substantive stable IDs including skipped blank IDs', async () => {
  const state = stateFor(), start = content.indexOf('林舟守约'), end = content.indexOf('林舟再次') + '林舟再次许诺。'.length
  const quote = content.slice(start, end)
  state.sections[0]!.events[0]!.evidence = { offset: start, quote }
  validateSourceCoverage(content, state.sections)
  const before = structuredClone(state.sections)
  await reviewSourceQuality({ filename: '跨句短引.txt', content }, state, async prompt => {
    const actual = input(prompt).sections[0].events[0].evidence
    const ids = units.filter(unit => unit.offset < end && unit.offset + unit.text.length > start && unit.text.trim()).map(unit => unit.id)
    assert.ok(ids.length > 1); assert.deepEqual(actual, { unit_ids: ids, quote }); assert.ok(ids[1]! > ids[0]! + 1, 'blank source IDs stay skipped rather than renumbered')
    return response(state)
  }, () => {}, signal())
  assert.deepEqual(state.sections, before)
})

test('invalid saved evidence is never guessed from a matching quote elsewhere', async t => {
  const cases = [
    { label: 'wrong quote at valid offset', mutate: (state: ScriptSourceAnalysis) => { state.sections[0]!.events[0]!.evidence.quote = '林舟守约。' } },
    { label: 'fractional offset', mutate: (state: ScriptSourceAnalysis) => { state.sections[0]!.events[0]!.evidence.offset += 0.5 } },
    { label: 'foreign section exact quote', mutate: (state: ScriptSourceAnalysis) => { state.sections[0]!.events[0]!.evidence = evidence('沈月') } },
    { label: 'whitespace quote', mutate: (state: ScriptSourceAnalysis) => { state.sections[0]!.events[0]!.evidence = evidence(' \t') } },
  ]
  for (const entry of cases) await t.test(entry.label, async () => {
    const state = stateFor(); entry.mutate(state); const before = structuredClone(state)
    let calls = 0, saves = 0
    await assert.rejects(reviewSourceQuality({ filename: '错误证据.txt', content }, state, async () => { calls++; return response(state) }, () => { saves++ }, signal()), /证据无法精确对应本章原文/)
    assert.equal(calls, 0); assert.equal(saves, 0); assert.deepEqual(state, before)
  })
})

test('unknown output IDs remain rejected and correction receives the precise finding path and IDs', async () => {
  const state = stateFor(), before = structuredClone(state); let calls = 0, saves = 0
  const good = { kind: 'unsupported', explanation: '已有真实证据。', unit_ids: [units.find(unit => unit.text.includes('沈月'))!.id] }
  const bad = { kind: 'unsupported', explanation: '把字符偏移误作证据ID。', unit_ids: [10378, 11057] }
  await assert.rejects(reviewSourceQuality({ filename: '非法ID.txt', content }, state, async prompt => {
    calls++
    if (calls === 2) { assert.match(prompt, /findings\[1\]\.unit_ids/); assert.match(prompt, /非法ID=\[10378,11057\]/); assert.match(prompt, /仅使用units\[\]\.id，不是字符偏移/); assert.match(prompt, /不得猜测相邻ID/) }
    return response(state, [good, bad])
  }, () => { saves++ }, signal()), /findings\[1\]\.unit_ids/)
  assert.equal(calls, 2); assert.equal(saves, 0); assert.deepEqual(state, before)
})

test('duplicate output IDs stay rejected with the repeated IDs reported', async () => {
  const state = stateFor(), id = units.find(unit => unit.text.includes('沈月'))!.id; let calls = 0
  await assert.rejects(reviewSourceQuality({ filename: '重复ID.txt', content }, state, async prompt => {
    if (++calls === 2) { assert.match(prompt, /findings\[0\]\.unit_ids/); assert.ok(prompt.includes(`重复ID=[${id}]`)) }
    return response(state, [{ kind: 'omission', explanation: '重复证据不能自动去重。', unit_ids: [id, id] }])
  }, () => {}, signal()), /重复ID/)
  assert.equal(calls, 2); assert.equal(state.quality, undefined)
})

test('invalid paged IDs keep item context and never become a retained finding', async () => {
  const state = stateFor(); let corrections = 0
  await assert.rejects(reviewSourceQuality({ filename: '分页ID.txt', content }, state, async (prompt, contract) => {
    if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('{"findings":[', 'length')
    if (prompt.includes('一次格式修正')) { corrections++; assert.match(prompt, /items\[\]\.finding\.unit_ids/); assert.match(prompt, /非法ID=\[10378\]/) }
    return JSON.stringify({ items: [{ kind: 'finding', finding: { kind: 'unsupported', explanation: '非法页不得保留。', unit_ids: [10378] } }], complete: true })
  }, () => {}, signal()), /script_source_quality_page/)
  assert.ok(corrections > 0); assert.equal(state.quality, undefined)
  const saved = state.quality_work?.checkpoint.steps['source-quality:pages']?.value as { items?: unknown[] } | undefined
  assert.deepEqual(saved?.items, [])
})
