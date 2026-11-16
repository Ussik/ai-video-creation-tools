import { repairBusinessSnapshot, repairSaveRecorder } from './source-quality-private-test-assertions.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'

const document = { filename: '完整原稿🚀.txt', content: '第一集\r\n林舟守约。  \r\n沈月归还信物。\r\n' }
const units = scriptSourcePassages(document.content).flatMap(p => p.units)
const marker = '【原稿分析定点修补资料】\n'
const signal = () => new AbortController().signal
function fixture() {
  const unit = units.find(unit => unit.text.includes('林舟'))!
  const state = { id: 'layout', source_version: 'version', model_id: 'model', status: 'failed', updated_at: 'now', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, sections: [{ offset: 0, length: document.content.length, unit_id: 0, title: '第一集', episode_number: 1,
      summary: '林舟守约。沈月归还信物。', characters: [{ name: '林舟', description: '守约者', evidence: { offset: unit.offset, quote: unit.text } }],
      events: [{ summary: '林舟守约', evidence: { offset: unit.offset, quote: unit.text } }], open_threads: ['信物用途待核实'] }],
    story: { summary: '林舟守约。沈月归还信物。', characters: [{ name: '林舟', aliases: [], description: '守约者', section_ids: [0] }],
      timeline: [{ summary: '林舟守约', section_ids: [0] }], threads: [{ setup: '信物归还', payoff: null, section_ids: [0] }],
      ending: { summary: '信物归还', section_ids: [0] }, uncertainties: [{ description: '信物用途待核实', section_ids: [0] }] } } as ScriptSourceAnalysis
  const current_hash = sourceQualityInputHash(state)
  state.quality = { input_hash: current_hash, status: 'issues', findings: [
    { kind: 'omission', explanation: '已处理的前序问题', unit_ids: [unit.id] },
    { kind: 'causality', explanation: '核对本次守约表述', unit_ids: [unit.id] } ] }
  state.quality_repair = { review_hash: current_hash, current_hash, findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex'), completed_findings: 1 }
  return { state, unit }
}

test('repair prompt leads with the pending finding and exact current analysis while preserving all full-source input and saved progress', async () => {
  const { state, unit } = fixture(), original = structuredClone(state), baseline = sourceQualityInputHash(state)
  assert.equal(sourceQualityRepairProgress(state), 1)
  let calls = 0, saves = repairSaveRecorder(state)
  await repairSourceQuality(document, state, async prompt => {
    calls++
    assert.match(prompt, /先定位finding与当前原值，通读完整原文核实后修补/)
    assert.match(prompt, /不能把自己的候选或计划当作当前原值/)
    const serialized = prompt.slice(prompt.lastIndexOf(marker) + marker.length), input = JSON.parse(serialized)
    assert.deepEqual(Object.keys(input), ['filename', 'complete_source', 'baseline_hash', 'finding', 'finding_hash', 'finding_index', 'total_findings', 'repair_references', 'story', 'sections', 'units'])
    assert.equal(input.filename, document.filename); assert.equal(input.complete_source, true); assert.equal(input.baseline_hash, baseline)
    assert.equal(input.finding_index, 1); assert.equal(input.total_findings, 2); assert.deepEqual(input.finding, original.quality!.findings[1])
    assert.deepEqual({ ...input.story, ...Object.fromEntries(['characters', 'timeline', 'threads', 'uncertainties'].map(key => [key, Object.values(input.story[key])])) }, original.story)
    assert.deepEqual(input.sections, original.sections.map((section, id) => ({ ...section, id,
      characters: section.characters.map(item => ({ ...item, evidence: { unit_id: unit.id } })),
      events: section.events.map(item => ({ ...item, evidence: { unit_id: unit.id } })) })))
    assert.equal(input.units.map((unit: { text: string }) => unit.text).join(''), document.content)
    assert.equal((serialized.match(/"complete_source":true/g) || []).length, 1)
    for (const key of ['quality', 'quality_repair', 'review_feedback', 'model_id', 'error']) assert.equal(input[key], undefined)
    assert.equal(sourceQualityInputHash(state), baseline); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original))
    return JSON.stringify({ status: 'patched', reason: '依据原文修补当前表述', changes: [{ target: 'story.summary', section_id: null,
      operation: 'replace', index: null, expected: input.story.summary, value: '林舟依约行事，沈月归还信物。' }] })
  }, () => { saves.record() }, signal())
  assert.equal(calls, 1); assert.equal(saves.commits, 1); saves.assertPrivateResponse(); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.quality, original.quality)
  assert.equal(state.story!.summary, '林舟依约行事，沈月归还信物。'); assert.equal(document.content, '第一集\r\n林舟守约。  \r\n沈月归还信物。\r\n')
})

test('prompt ordering does not weaken exact-expected rejection or discard earlier finding progress', async () => {
  const { state } = fixture(), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state)
  await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
    calls++
    const change = { target: 'story.summary', section_id: null,
      operation: 'replace', index: null, expected: '改写后的候选并非当前原值', value: '林舟依约行事。' }
    return JSON.stringify(contract?.name.endsWith('_local_repair') ? { repairs: { change_0: change } }
      : { status: 'patched', reason: '故意错误原值fixture', changes: [change] })
  }, () => { saves.record() }, signal()), /expected必须精确复制/)
  assert.equal(calls, 2); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original)); assert.equal(sourceQualityRepairProgress(state), 1)
})
