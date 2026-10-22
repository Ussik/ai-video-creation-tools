import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'

const content = '第一集\n林舟守约。\n第二集\n沈月归还信物。杜铮受到细线操控。\n'
const document = { filename: '完整剧本.txt', content }
const units = scriptSourcePassages(content).flatMap(passage => passage.units)
const marker = '【原稿分析定点修补资料】\n'
const unitFor = (name: string) => units.find(unit => unit.text.includes(name))!
const evidence = (name: string) => ({ offset: unitFor(name).offset, quote: unitFor(name).text })
const signal = () => new AbortController().signal
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '按原文修补当前问题', changes })
function stateFor(findings = 1): ScriptSourceAnalysis {
  const split = content.indexOf('第二集')
  const state: ScriptSourceAnalysis = { id: 'analysis', source_version: 'source-v1', model_id: 'text', status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length, error: '核对发现问题', updated_at: 'now',
    sections: [
      { offset: 0, length: split, unit_id: 0, title: '第一集', episode_number: 1, summary: '林舟守约', characters: [{ name: '林舟', description: '守约的人', evidence: evidence('林舟') }], events: [], open_threads: [] },
      { offset: split, length: content.length - split, unit_id: 1, title: '第二集', episode_number: 2, summary: '信物归还', characters: [],
        events: [{ summary: '信物归还', evidence: evidence('沈月') }] },
    ],
    story: { summary: '林舟的约定得到履行', characters: [{ name: '林舟', aliases: [], description: '守约的人', section_ids: [0] }],
      timeline: [{ summary: '信物归还', section_ids: [1] }], threads: [], ending: { summary: '约定履行', section_ids: [1] }, uncertainties: [] },
    story_work: { input_hash: 'old', tasks: [{ key: 'overview', result: { summary: '旧整合任务结果' } }] },
    synthesis: { level: 0, cursor: 1, inputs: [], outputs: [] },
  }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [
    { kind: 'omission', explanation: '遗漏沈月归还信物的人物与事件', unit_ids: [unitFor('沈月').id] },
    { kind: 'causality', explanation: '遗漏杜铮受细线操控', unit_ids: [unitFor('杜铮').id] },
  ].slice(0, findings) as NonNullable<ScriptSourceAnalysis['quality']>['findings'] }
  return state
}
const characterChanges = (name = '沈月') => [
  { target: 'section.characters', section_id: 1, operation: 'append', index: null, expected: null,
    value: { name, description: name === '沈月' ? '归还信物的人' : '受到细线操控的人', evidence: { unit_id: unitFor(name).id } } },
  { target: 'story.characters', section_id: null, operation: 'append', index: null, expected: null,
    value: { name, aliases: [], description: name === '沈月' ? '归还信物的人' : '受到细线操控的人', section_ids: [1] } },
]

test('one finding receives the complete source and analysis, atomically appends supported facts, and preserves unrelated results', async () => {
  const state = stateFor(), original = structuredClone(state), snapshots: ScriptSourceAnalysis[] = []
  let calls = 0
  await repairSourceQuality(document, state, async prompt => {
    calls++
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.equal(input.complete_source, true)
    assert.equal(input.units.map((unit: { text: string }) => unit.text).join(''), content)
    assert.equal(input.finding_index, 0); assert.equal(input.total_findings, 1)
    assert.deepEqual(input.story, original.story)
    assert.deepEqual(input.sections[0].characters[0].evidence, { unit_id: unitFor('林舟').id })
    for (const privateKey of ['quality_repair', 'story_work', 'synthesis', 'configuration_hash', 'error', 'model_id']) assert.equal(input[privateKey], undefined)
    return body(characterChanges())
  }, () => { snapshots.push(structuredClone(state)) }, signal())
  assert.equal(calls, 1); assert.equal(snapshots.length, 2)
  assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.sections[0], original.sections[0])
  assert.deepEqual(state.sections[1]!.events, original.sections[1]!.events)
  assert.deepEqual(state.story!.timeline, original.story!.timeline)
  assert.equal(state.sections[1]!.characters[0]!.name, '沈月')
  assert.deepEqual(state.sections[1]!.characters[0]!.evidence, evidence('沈月'))
  assert.deepEqual(state.quality, original.quality, 'repair remains provisional until a separate full review passes')
  assert.equal(state.story_work, undefined); assert.equal(state.synthesis, undefined)
  assert.equal(state.quality!.status, 'issues')
})

test('successful findings survive a later transport failure and resume only unfinished findings', async () => {
  const state = stateFor(2), requests: number[] = []
  const first = async (prompt: string) => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    requests.push(input.finding_index)
    if (input.finding_index === 1) throw new Error('transport failed')
    return body(characterChanges())
  }
  await assert.rejects(repairSourceQuality(document, state, first, () => {}, signal()), /transport failed/)
  assert.equal(sourceQualityRepairProgress(state), 1)
  const saved = structuredClone(state.sections[1]!.characters[0])
  await repairSourceQuality(document, state, async prompt => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)); requests.push(input.finding_index)
    return body(characterChanges('杜铮'))
  }, () => {}, signal())
  assert.deepEqual(requests, [0, 1, 1]); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.deepEqual(state.sections[1]!.characters[0], saved)
  assert.deepEqual(state.story!.characters.map(character => character.name), ['林舟', '沈月', '杜铮'])
  await repairSourceQuality(document, state, async () => { throw new Error('completed finding was re-requested') }, () => {}, signal())
})

test('a rejected multi-edit finding commits neither the earlier edit nor its progress', async () => {
  const state = stateFor(), original = structuredClone(state)
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async () => {
    calls++
    return body([
      { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: state.story!.summary, value: '沈月归还信物' },
      { target: 'section.events', section_id: 1, operation: 'replace', index: 0, expected: { summary: '并非当前原值', evidence: { unit_id: unitFor('沈月').id } }, value: { summary: '补充归还原因', evidence: { unit_id: unitFor('沈月').id } } },
    ])
  }, () => {}, signal()), /原值不匹配/)
  assert.equal(calls, 2)
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
  assert.equal(sourceQualityRepairProgress(state), 0)
})

test('guards reject unsupported names, foreign evidence and invalid story references without losing the baseline', async t => {
  const cases = [
    { label: 'invented section name', changes: [{ ...characterChanges()[0], value: { name: '不存在的人', description: '无来源', evidence: { unit_id: unitFor('沈月').id } } }], pattern: /没有姓名依据/ },
    { label: 'foreign section evidence', changes: [{ ...characterChanges()[0], value: { name: '沈月', description: '归还信物', evidence: { unit_id: unitFor('林舟').id } } }], pattern: /本章节内真实/ },
    { label: 'unknown evidence', changes: [{ ...characterChanges()[0], value: { name: '沈月', description: '归还信物', evidence: { unit_id: 999999 } } }], pattern: /本章节内真实/ },
    { label: 'invented story alias', changes: [{ ...characterChanges()[1], value: { name: '沈月', aliases: ['假身份'], description: '归还信物', section_ids: [1] } }], pattern: /没有所引章节的原文或目录证据/ },
    { label: 'duplicate section ids', changes: [{ ...characterChanges()[1], value: { name: '沈月', aliases: [], description: '归还信物', section_ids: [1, 1] } }], pattern: /不能重复引用/ },
    { label: 'invented section ids', changes: [{ ...characterChanges()[1], value: { name: '沈月', aliases: [], description: '归还信物', section_ids: [999] } }], pattern: /不存在的章节/ },
    { label: 'nonexistent section container', changes: [{ ...characterChanges()[0], section_id: 99 }], pattern: /不存在的章节/ },
  ]
  for (const item of cases) await t.test(item.label, async () => {
    const state = stateFor(), original = structuredClone(state)
    await assert.rejects(repairSourceQuality(document, state, async () => body(item.changes), () => {}, signal()), item.pattern)
    assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
    assert.equal(sourceQualityRepairProgress(state), 0)
  })
})

test('unsupported stored people and events can be removed without affecting supported entries', async () => {
  const state = stateFor()
  state.sections[1]!.characters.push({ name: '错误角色', description: '上轮误读', evidence: evidence('沈月') })
  state.story!.characters.push({ name: '错误角色', aliases: [], description: '上轮误读', section_ids: [1] })
  state.sections[1]!.events.push({ summary: '误读事件', evidence: evidence('沈月') })
  state.quality!.input_hash = sourceQualityInputHash(state)
  await repairSourceQuality(document, state, async prompt => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    return body([
      { target: 'section.characters', section_id: 1, operation: 'remove', index: 0, expected: input.sections[1].characters[0], value: null },
      { target: 'story.characters', section_id: null, operation: 'remove', index: 1, expected: input.story.characters[1], value: null },
      { target: 'section.events', section_id: 1, operation: 'remove', index: 1, expected: input.sections[1].events[1], value: null },
    ])
  }, () => {}, signal())
  assert.deepEqual(state.sections[1]!.characters, [])
  assert.deepEqual(state.story!.characters.map(character => character.name), ['林舟'])
  assert.deepEqual(state.sections[1]!.events.map(event => event.summary), ['信物归还'])
})

test('legacy optional threads and incorrect chapter labels can be corrected while coordinates stay immutable', async () => {
  const state = stateFor(), original = structuredClone(state.sections[1])
  assert.equal(state.sections[1]!.open_threads, undefined)
  state.story!.timeline[0]!.section_ids = [1, 1]
  state.quality!.input_hash = sourceQualityInputHash(state)
  await repairSourceQuality(document, state, async prompt => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.deepEqual(input.sections[1].open_threads, [])
    return body([
      { target: 'section.open_threads', section_id: 1, operation: 'append', index: null, expected: null, value: '杜铮受到细线操控，操控来源尚待核实' },
      { target: 'section.title', section_id: 1, operation: 'replace', index: null, expected: '第二集', value: '信物归还与细线操控' },
      { target: 'section.episode_number', section_id: 1, operation: 'replace', index: null, expected: 2, value: null },
    ])
  }, () => {}, signal())
  assert.deepEqual(state.sections[1]!.open_threads, ['杜铮受到细线操控，操控来源尚待核实'])
  assert.equal(state.sections[1]!.episode_number, null)
  assert.equal(state.sections[1]!.offset, original!.offset); assert.equal(state.sections[1]!.length, original!.length); assert.equal(state.sections[1]!.unit_id, original!.unit_id)
  assert.deepEqual(state.story!.timeline[0]!.section_ids, [1, 1], 'an unchanged previously accepted entry is preserved')
})

test('empty, no-op, cancelling and forbidden coordinate changes cannot count as repaired', async t => {
  const cases = [
    { name: 'empty', changes: [], pattern: /至少一项有效修改/ },
    { name: 'no-op', changes: [{ target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: '林舟的约定得到履行', value: '林舟的约定得到履行' }], pattern: /相同内容/ },
    { name: 'cancelling', changes: [
      { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: '林舟的约定得到履行', value: '沈月归还信物' },
      { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: '沈月归还信物', value: '林舟的约定得到履行' },
    ], pattern: /未产生有效修改/ },
    { name: 'coordinates', changes: [{ target: 'section.offset', section_id: 1, operation: 'replace', index: null, expected: 0, value: 3 }], pattern: /不符合.*契约/ },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    const state = stateFor(), original = structuredClone(state)
    await assert.rejects(repairSourceQuality(document, state, async () => body(item.changes), () => {}, signal()), item.pattern)
    assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
    assert.equal(sourceQualityRepairProgress(state), 0)
  })
})

test('checkpoint integrity binds the original review, finding list, committed analysis and integer cursor', async t => {
  const state = stateFor()
  await repairSourceQuality(document, state, async () => body(characterChanges()), () => {}, signal())
  for (const mutate of [
    (copy: ScriptSourceAnalysis) => { copy.quality_repair!.review_hash = 'other-review' },
    (copy: ScriptSourceAnalysis) => { copy.quality_repair!.findings_hash = 'other-findings' },
    (copy: ScriptSourceAnalysis) => { copy.story!.summary += 'changed' },
    (copy: ScriptSourceAnalysis) => { copy.quality_repair!.completed_findings = 0.5 },
    (copy: ScriptSourceAnalysis) => { copy.quality_repair!.completed_findings = 2 },
    (copy: ScriptSourceAnalysis) => { copy.quality_repair!.completed_findings = -1 },
  ]) await t.test(mutate.toString(), () => {
    const copy = structuredClone(state); mutate(copy); assert.equal(sourceQualityRepairProgress(copy), null)
  })
})

test('stale unbound findings are skipped, while a corrupt existing checkpoint restarts safely at zero', async () => {
  const state = stateFor()
  state.story!.summary += ' externally changed'
  let calls = 0
  await repairSourceQuality(document, state, async () => { calls++; return body(characterChanges()) }, () => {}, signal())
  assert.equal(calls, 0); assert.equal(state.quality_repair, undefined)
  state.quality_repair = { review_hash: 'corrupt', findings_hash: 'corrupt', current_hash: 'corrupt', completed_findings: 999 }
  await repairSourceQuality(document, state, async prompt => {
    calls++; const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)); assert.equal(input.finding_index, 0)
    return body(characterChanges())
  }, () => {}, signal())
  assert.equal(calls, 1); assert.equal(sourceQualityRepairProgress(state), 1)
})

test('an explicit unsafe-repair result retains analysis and explains that no local repair completed', async () => {
  const state = stateFor(), original = structuredClone(state)
  await assert.rejects(repairSourceQuality(document, state, async () => JSON.stringify({ status: 'requires_full_rebuild', reason: '必须调整章节边界。', changes: [] }), () => {}, signal()), error => {
    assert.equal((error as Error & { statusCode: number }).statusCode, 422)
    assert.match((error as Error).message, /无法安全定点修补.*章节边界。\n需要依据原文重新整理目录/)
    assert.equal((error as Error & { sourceQualityRepairNeedsRebuild: boolean }).sourceQualityRepairNeedsRebuild, true)
    assert.doesNotMatch((error as Error).message, /。。/)
    return true
  })
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
  assert.equal(sourceQualityRepairProgress(state), 0)
})

test('cancellation after a late model response cannot commit its edits', async () => {
  const state = stateFor(), original = structuredClone(state), control = new AbortController()
  await assert.rejects(repairSourceQuality(document, state, async () => { control.abort(new Error('paused')); return body(characterChanges()) }, () => {}, control.signal), /paused/)
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
  assert.equal(sourceQualityRepairProgress(state), 0)
})
