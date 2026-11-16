import { repairBusinessSnapshot, repairSaveRecorder } from './source-quality-private-test-assertions.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const document = { filename: 'span-fallback.txt', content: '第一集\n林舟守约。沈月归还信物。' }
const unit = scriptSourcePassages(document.content).flatMap(p => p.units).find(unit => unit.text.includes('林舟'))!
const marker = '【原稿分析定点修补资料】\n'
const signal = () => new AbortController().signal
const longSummary = '本段守约状态。' + '完整事实，保留非问题内容和未知条件。🚀\r\n'.repeat(15) + '未修改的尾部事实。'
function fixture(summary = longSummary) {
  const state = { id: 'fallback', source_version: 'source', model_id: 'model', status: 'failed', phase: 'synthesis', updated_at: 'now', completed_chunks: 1, total_chunks: 1,
    sections: [{ offset: 0, length: document.content.length, title: '第一集', episode_number: 1, summary: '林舟守约。沈月归还信物。', characters: [], events: [], open_threads: [] }],
    story: { summary, characters: [], timeline: [], threads: [], ending: { summary: '信物归还。', section_ids: [0] }, uncertainties: [] } } as ScriptSourceAnalysis
  const current_hash = sourceQualityInputHash(state)
  state.quality = { input_hash: current_hash, status: 'issues', findings: [{ kind: 'causality', explanation: '核对守约状态。', unit_ids: [unit.id] }] }
  state.quality_repair = { review_hash: current_hash, current_hash, completed_findings: 0,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex') }
  return state
}
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '依据完整原文修正守约状态。', changes })
const span = (state: ScriptSourceAnalysis, expected: string, value = '修正片段。') => ({ target: 'story.summary', section_id: null,
  operation: 'replace_span', index: null, baseline_hash: sourceQualityInputHash(state), expected, value })
const correctionRef = (prompt: string) => {
  const match = prompt.match(/可以将该项修改显式改为本题整项摘要引用：(\{[^\n]+?\})。/)
  assert.ok(match, 'one existing format correction must offer the actual current ref')
  return JSON.parse(match[1]!)
}

test('valid exact summary spans remain one-call repairs and receive no fallback instructions in the initial prompt', async () => {
  const state = fixture(); let calls = 0
  await repairSourceQuality(document, state, async prompt => {
    calls++; assert.ok(!prompt.includes('可以将该项修改显式改为本题整项摘要引用'))
    return body([span(state, '本段守约状态。', '本段按约归还信物。')])
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.story!.summary, longSummary.replace('本段守约状态。', '本段按约归还信物。'))
})

for (const mode of ['not found', 'not unique'] as const) test('one explicit correction can choose a complete frozen summary ref after span is ' + mode, async () => {
  const summary = mode === 'not unique' ? '重复。' + longSummary + '重复。' : longSummary
  const state = fixture(summary), original = structuredClone(state), fullValue = summary.replace('本段守约状态。', '本段按约归还信物。')
  let calls = 0, saves = repairSaveRecorder(state), initialRef = ''
  await repairSourceQuality(document, state, async prompt => {
    if (++calls === 1) {
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      initialRef = data.repair_references.find((ref: { target: string }) => ref.target === 'story.summary').ref_id
      return body([span(state, mode === 'not unique' ? '重复。' : 'NOT_SOURCE_PRIVATE_SENTINEL')])
    }
    assert.match(prompt, /【一次局部纠正】/)
    const ref = correctionRef(prompt)
    assert.deepEqual(ref, { operation: 'replace_ref', target: 'story.summary', section_id: null, index: null, ref_id: initialRef })
    assert.match(prompt, /不要继续猜测、修剪或改写原片段/)
    assert.match(prompt, /value必须是完整修正后的summary，保留全部非问题内容与未修改事实/)
    assert.match(prompt, /不能把此前的片段value当作完整summary/)
    assert.match(prompt, /使用ref时不输出expected或baseline_hash/)
    assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original), 'no old span or expected is automatically repaired or adopted')
    return JSON.stringify({ repairs: { change_0: { ...ref, value: fullValue } } })
  }, () => { saves.record() }, signal())
  assert.equal(calls, 2); assert.equal(saves.commits, 1); saves.assertPrivateResponse(); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.story!.summary, fullValue); assert.deepEqual(state.sections, original.sections); assert.equal(state.quality!.status, 'issues')
})

test('a short summary without a whole reference gets no fallback offer and invalid spans remain rejected in two calls', async () => {
  const state = fixture('不足160字符的短摘要。'), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state), raw = ''
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    calls++
    if (calls === 1) raw = body([span(state, 'NOT_SOURCE_PRIVATE_SENTINEL')])
    else {
      assert.match(prompt, /【一次局部纠正】/)
      assert.ok(!prompt.includes('可以将该项修改显式改为本题整项摘要引用'))
    }
    return calls === 1 ? raw : JSON.stringify({ repairs: { change_0: JSON.parse(raw).changes[0] } })
  }, () => { saves.record() }, signal()), error => {
    const message = (error as Error).message
    assert.match(message, /不精确匹配/); assert.ok(!message.includes('NOT_SOURCE_PRIVATE_SENTINEL')); assert.ok(!message.includes(state.story!.summary)); return true
  })
  assert.equal(calls, 2); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.equal(saves.snapshots.at(-1)!.quality_repair_output!.checkpoint.raw, raw); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original))
})

for (const mode of ['wrong id', 'noop', 'span plus whole', 'repeated invalid span', 'short guessed ref'] as const) test('summary fallback preserves guards and never publishes source text: ' + mode, async () => {
  const state = fixture(mode === 'short guessed ref' ? '不足160字符的短摘要。' : longSummary), original = structuredClone(state)
  let calls = 0, saves = repairSaveRecorder(state), raw = ''
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    if (++calls === 1) { raw = body([span(state, 'NOT_SOURCE_PRIVATE_SENTINEL')]); return raw }
    const ref = mode === 'short guessed ref' ? { operation: 'replace_ref', target: 'story.summary', section_id: null, index: null, ref_id: 'x'.repeat(22) } : correctionRef(prompt)
    if (mode === 'wrong id') ref.ref_id = 'x'.repeat(22)
    if (mode === 'repeated invalid span') return JSON.stringify({ repairs: { change_0: JSON.parse(raw).changes[0] } })
    const change = { ...ref, value: mode === 'noop' ? state.story!.summary : '本段按约归还信物。' }
    return JSON.stringify({ repairs: mode === 'span plus whole' ? { change_0: span(state, '本段守约状态。'), change_1: change } : { change_0: change } })
  }, () => { saves.record() }, signal()), error => {
    const message = (error as Error).message
    assert.match(message, /ref_id|相同内容|混用|不精确匹配|Unrecognized key/)
    assert.ok(!message.includes('NOT_SOURCE_PRIVATE_SENTINEL')); assert.ok(!message.includes(state.story!.summary))
    assert.ok(!message.includes('可以将该项修改显式改为本题整项摘要引用'), 'private correction hint must not replace the public diagnostic')
    return true
  })
  assert.equal(calls, 2); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.equal(saves.snapshots.at(-1)!.quality_repair_output!.checkpoint.raw, raw); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original)); assert.equal(sourceQualityRepairProgress(state), 0)
})
