import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
const document = { filename: 'indexed-wire.txt', content: '第一集\n林舟守约。\n沈月归还信物。\n' }
const units = scriptSourcePassages(document.content).flatMap(passage => passage.units), unit = units.find(item => item.text.includes('林舟'))!
const fields = ['characters', 'timeline', 'threads', 'uncertainties'] as const
const marker = '【原稿分析定点修补资料】\n'
const signal = () => new AbortController().signal
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '修正明确指出的条目', changes })
function stateFor(): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'indexed-fixture', source_version: 'same-source', model_id: 'same-model', status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: document.content.length, error: 'quality findings', updated_at: 'fixture',
    sections: [{ offset: 0, length: document.content.length, unit_id: 0, title: '第一集', episode_number: 1, summary: '林舟守约',
      characters: [{ name: '林舟', description: '守约的人', evidence: { offset: unit.offset, quote: unit.text } }], events: [], open_threads: [] }],
    story: { summary: '林舟守约。沈月归还信物。', characters: [{ name: '林舟', aliases: [], description: '守约的人', section_ids: [0] }],
      timeline: [{ summary: '林舟守约', section_ids: [0] }, { summary: '沈月归还信物', section_ids: [0] }],
      threads: Array.from({ length: 16 }, (_, index) => ({ setup: `第${index + 1}条SECRET线索`, payoff: index % 2 ? null : `第${index + 1}条结果`, section_ids: [0] })),
      ending: { summary: '信物归还', section_ids: [0] }, uncertainties: [{ description: '待核实信物', section_ids: [0] }, { description: '待核实约定', section_ids: [0] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: 'causality', explanation: '核对信物线索', unit_ids: [unit.id] }] }
  return state
}
const threadChange = (state: ScriptSourceAnalysis, index = 15) => ({ target: 'story.threads', section_id: null, operation: 'replace', index,
  expected: state.story!.threads[15], value: { ...state.story!.threads[15]!, payoff: '信物按约归还' } })
const summarySpan = (state: ScriptSourceAnalysis) => ({ target: 'story.summary', section_id: null, operation: 'replace_span', index: null,
  baseline_hash: sourceQualityInputHash(state), expected: '守约', value: '履约' })

test('explicit zero-based story keys permit a correct first-pass span and index-15 repair without losing any input item', async () => {
  const state = stateFor(), original = structuredClone(state), hash = sourceQualityInputHash(state)
  let calls = 0
  await repairSourceQuality(document, state, async prompt => {
    calls++
    const data = input(prompt)
    assert.deepEqual(Object.keys(data.story).sort(), Object.keys(original.story!).sort())
    for (const field of fields) {
      assert.equal(Array.isArray(data.story[field]), false)
      assert.deepEqual(Object.keys(data.story[field]), original.story![field].map((_, index) => String(index)))
      assert.deepEqual(Object.values(data.story[field]), original.story![field])
      for (const [key, value] of Object.entries(data.story[field])) assert.deepEqual(value, original.story![field][Number(key)])
    }
    assert.deepEqual(data.story.ending, original.story!.ending); assert.equal(data.story.summary, original.story!.summary)
    assert.equal(data.units.map((item: { text: string }) => item.text).join(''), document.content)
    assert.equal(data.baseline_hash, hash); assert.equal(data.sections[0].id, 0)
    assert.match(prompt, /index取对应key的数字/); assert.match(prompt, /expected只复制该key的完整value/)
    const key = Object.keys(data.story.threads).find(key => data.story.threads[key].setup === original.story!.threads[15]!.setup)!
    assert.equal(key, '15')
    return body([{ ...summarySpan(state), baseline_hash: data.baseline_hash }, { ...threadChange(state), index: Number(key), expected: data.story.threads[key] }])
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.story!.threads, original.story!.threads.map((item, index) => index === 15 ? threadChange(original).value : item))
  assert.deepEqual(state.story!.characters, original.story!.characters); assert.deepEqual(state.story!.timeline, original.story!.timeline)
  assert.deepEqual(state.story!.uncertainties, original.story!.uncertainties); assert.deepEqual(state.sections, original.sections)
  assert.equal(state.story!.summary, '林舟履约。沈月归还信物。'); assert.equal(state.quality!.status, 'issues')
})

test('empty editable story arrays are empty keyed objects and never mutate the persisted array representation', async () => {
  const state = stateFor()
  for (const field of fields) state.story![field] = []
  state.sections[0]!.characters = []
  state.quality!.input_hash = sourceQualityInputHash(state)
  const original = structuredClone(state)
  await repairSourceQuality(document, state, async prompt => {
    const data = input(prompt)
    for (const field of fields) { assert.deepEqual(data.story[field], {}); assert.equal(Array.isArray(state.story![field]), true) }
    return JSON.stringify({ decision: 'retain_analysis', finding_hash: data.finding_hash, reason: '当前项没有缺失', changes: [], analysis_refs: [{ path: 'story.summary' }], source_refs: [{ unit_id: unit.id }] })
  }, () => {}, signal())
  assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
})

test('a unique matching index is diagnostic only until the model explicitly corrects it', async () => {
  const state = stateFor(), original = structuredClone(state), bad = [summarySpan(state), threadChange(state, 11)]
  let calls = 0
  await repairSourceQuality(document, state, async prompt => {
    if (++calls === 1) return body(bad)
    assert.match(prompt, /matching_indices=\[15\]/); assert.match(prompt, /changes\[1\]\.expected（target=story\.threads）/)
    assert.deepEqual(state.story, original.story, 'no remap or earlier span is adopted before explicit correction')
    const localMarker = '【局部纠正资料】\n'
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf(localMarker) + localMarker.length))
    assert.equal(data.change_index, 1); assert.equal(data.original_change.target, 'story.threads')
    return JSON.stringify({ repairs: { change_1: { ...bad[1], index: 15, expected: data.current_values[0].value['15'] } } })
  }, () => {}, signal())
  assert.equal(calls, 2); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.story!.threads[15], threadChange(original).value); assert.deepEqual(state.story!.threads[11], original.story!.threads[11])
})

test('wrong indices, unknown values and multiple exact matches remain rejected without partial adoption or text echo', async t => {
  for (const kind of ['wrong index', 'unknown index', 'wrong expected', 'multiple matches']) await t.test(kind, async () => {
    const state = stateFor()
    if (kind === 'multiple matches') state.story!.threads[2] = structuredClone(state.story!.threads[15]!)
    state.quality!.input_hash = sourceQualityInputHash(state)
    const original = structuredClone(state), change = threadChange(state, kind === 'unknown index' ? 999 : 11)
    if (kind === 'wrong expected') change.expected = { setup: '完全未知SECRET文本', payoff: null, section_ids: [0] }
    let calls = 0
    await assert.rejects(repairSourceQuality(document, state, async () => { calls++; return body([summarySpan(state), change]) }, () => {}, signal()), error => {
      const message = (error as Error).message
      assert.match(message, /target=story\.threads/)
      assert.ok(message.includes(kind === 'multiple matches' ? 'matching_indices=[2,15]' : kind === 'wrong expected' ? 'matching_indices=[]' : 'matching_indices=[15]'))
      assert.doesNotMatch(message, /SECRET|信物按约归还/)
      return true
    })
    assert.equal(calls, 2); assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
    assert.equal(sourceQualityRepairProgress(state), 0)
  })
})

test('matching-index diagnostics inspect the sequential candidate after an earlier removal, without applying either edit', async () => {
  const state = stateFor(); state.story!.threads = state.story!.threads.slice(0, 3); state.quality!.input_hash = sourceQualityInputHash(state)
  const original = structuredClone(state)
  await assert.rejects(repairSourceQuality(document, state, async () => body([
    { target: 'story.threads', section_id: null, operation: 'remove', index: 0, expected: original.story!.threads[0], value: null },
    { target: 'story.threads', section_id: null, operation: 'replace', index: 2, expected: original.story!.threads[2], value: { ...original.story!.threads[2], payoff: '已确认归还' } },
  ]), () => {}, signal()), error => {
    assert.match((error as Error).message, /matching_indices=\[1\]/); assert.match((error as Error).message, /changes\[1\]\.index/); return true
  })
  assert.deepEqual(state.story, original.story); assert.equal(sourceQualityRepairProgress(state), 0)
})

test('concurrent analysis drift remains protected even when explicit keyed input and expected values are exact', async () => {
  const state = stateFor(), original = structuredClone(state), change = threadChange(state)
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    const data = input(prompt); assert.deepEqual(data.story.threads['15'], change.expected)
    state.story!.summary += '外部已保存事实。'
    return body([change])
  }, () => {}, signal()), /修补期间发生变化/)
  assert.deepEqual(state.story!.threads, original.story!.threads); assert.deepEqual(state.sections, original.sections)
  assert.equal(state.story!.summary, original.story!.summary + '外部已保存事实。'); assert.equal(state.quality_repair!.completed_findings, 0)
})
