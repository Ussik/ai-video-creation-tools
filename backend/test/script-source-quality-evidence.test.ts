import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const content = '开场：林舟守约。\n \t\n尾声：信物已归还。\n \n'
const document = { filename: '合成证据空行.txt', content }
const units = scriptSourcePassages(content).flatMap(passage => passage.units)
const blanks = units.filter(unit => !unit.text.trim()).map(unit => unit.id)
const real = units.filter(unit => unit.text.trim()).map(unit => unit.id)
assert.ok(blanks.length); assert.equal(real.length, 2)
const signal = () => new AbortController().signal
const finding = (explanation: string, unit_ids: number[]) => ({ kind: 'unsupported' as const, explanation, unit_ids })
function stateFor(): ScriptSourceAnalysis {
  return { id: 'quality-evidence-fixture', source_version: 'source-v1', model_id: 'text', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now', sections: [{ offset: 0, length: content.length,
      title: '原稿', episode_number: null, summary: '守约并归还信物。', characters: [], events: [] }],
    story: { summary: '守约并归还信物。', characters: [], timeline: [], threads: [],
      ending: { summary: '信物已归还。', section_ids: [0] }, uncertainties: [] } }
}

test('direct review removes only existing blank references without a model correction or changing substantive findings', async () => {
  const state = stateFor(), before = structuredClone(state), hash = sourceQualityInputHash(state)
  const explanation = '尾声对信物的归还表述存在具体误读，必须完整保留本条核对意见及其实际证据。'
  const raw = { checked_section_ids: [0], findings: [finding(explanation, [real[1]!, blanks[0]!, real[0]!]),
    finding('另一条独立意见仍保持原文。', [...blanks, real[1]!])] }
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, state, async () => { calls++; return JSON.stringify(raw) }, () => {}, signal()), /发现 2 项遗漏或误读/)
  assert.equal(calls, 1, 'a non-evidence blank reference must not spend an extra full-review correction')
  assert.deepEqual(state.quality!.findings, [finding(explanation, [real[1]!, real[0]!]), finding(raw.findings[1]!.explanation, [real[1]!])])
  assert.deepEqual(state.story, before.story); assert.deepEqual(state.sections, before.sections)
  assert.equal(sourceQualityInputHash(state), hash)
  assert.deepEqual(raw.findings[0]!.unit_ids, [real[1]!, blanks[0]!, real[0]!], 'the provider response fixture itself is unchanged')
})

test('the bounded format-correction reply uses the same lossless evidence check', async () => {
  const state = stateFor(), item = finding('纠正格式后仍保留这条事实核对。', [blanks[0]!, real[1]!])
  let calls = 0
  await assert.rejects(reviewSourceQuality(document, state, async prompt => {
    if (++calls === 1) return JSON.stringify({ findings: [item] })
    assert.match(prompt, /一次格式修正/)
    return JSON.stringify({ checked_section_ids: [0], findings: [item] })
  }, () => {}, signal()), /发现 1 项遗漏或误读/)
  assert.equal(calls, 2)
  assert.deepEqual(state.quality!.findings, [finding(item.explanation, [real[1]!])])
})

test('paged review normalizes direct seeds, page replies and recovered complete items before retaining them', async t => {
  for (const mode of ['direct-seed', 'recovered-page', 'corrected-page'] as const) await t.test(mode, async () => {
    const state = stateFor(), item = finding('分页完整意见及实际依据不变。', [real[1]!, blanks[0]!])
    const names: string[] = []; let pageCalls = 0
    await assert.rejects(reviewSourceQuality(document, state, async (prompt, contract) => {
      names.push(contract!.name)
      if (contract!.name === 'script_source_quality') {
        throw new TextOutputLimitError(mode === 'direct-seed' ? `{"findings":[${JSON.stringify(item)},` : '{"findings":[', 'length')
      }
      assert.equal(contract!.name, 'script_source_quality_page')
      pageCalls++
      if (mode === 'direct-seed') {
        assert.ok(prompt.includes(JSON.stringify({ kind: 'finding', finding: finding(item.explanation, [real[1]!]) })), 'retained seed is already free of non-evidence blanks')
        return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true })
      }
      if (pageCalls === 1) {
        const partial = { items: [{ kind: 'finding', finding: item }] }
        if (mode === 'recovered-page') throw new TextOutputLimitError(JSON.stringify(partial).slice(0, -1) + ',"complete":', 'length')
        return JSON.stringify(partial)
      }
      if (mode === 'corrected-page') assert.match(prompt, /一次格式修正/)
      else assert.ok(prompt.includes(JSON.stringify({ kind: 'finding', finding: finding(item.explanation, [real[1]!]) })))
      return JSON.stringify({ items: [...(mode === 'corrected-page' ? [{ kind: 'finding', finding: item }] : []),
        { kind: 'coverage', checked_section_ids: [0] }], complete: true })
    }, () => {}, signal()), /发现 1 项遗漏或误读/)
    assert.deepEqual(names, ['script_source_quality', ...Array.from({ length: mode === 'direct-seed' ? 1 : 2 }, () => 'script_source_quality_page')])
    assert.deepEqual(state.quality!.findings, [finding(item.explanation, [real[1]!])])
    assert.equal(state.quality_work, undefined)
  })
})

test('blank filtering never repairs unknown, malformed, duplicate or evidence-free references', async t => {
  const cases = [
    { label: 'unknown mixed with valid and blank', ids: [real[0]!, blanks[0]!, 99999] },
    { label: 'negative mixed with valid and blank', ids: [real[0]!, blanks[0]!, -1] },
    { label: 'noninteger mixed with valid and blank', ids: [real[0]!, blanks[0]!, 0.5] },
    { label: 'duplicate substantive ID', ids: [real[0]!, blanks[0]!, real[0]!] },
    { label: 'duplicate blank ID', ids: [real[0]!, blanks[0]!, blanks[0]!] },
    { label: 'only actual blanks', ids: blanks },
    { label: 'empty evidence', ids: [] },
  ]
  for (const entry of cases) await t.test(entry.label, async () => {
    const state = stateFor(); let calls = 0, saves = 0
    await assert.rejects(reviewSourceQuality(document, state, async () => {
      calls++; return JSON.stringify({ checked_section_ids: [0], findings: [finding('不能凭空补足证据。', entry.ids)] })
    }, () => { saves++ }, signal()), /模型结果不符合 script_source_quality 契约/)
    assert.equal(calls, 2); assert.equal(saves, 0); assert.equal(state.quality, undefined)
  })
})
