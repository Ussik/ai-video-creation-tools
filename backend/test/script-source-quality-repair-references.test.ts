import { repairBusinessSnapshot, repairSaveRecorder } from './source-quality-private-test-assertions.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { repairSourceQuality, sourceQualityRepairProgress } from '../src/modules/script/script-source-quality-repair.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const document = { filename: '完整原稿🚀.txt', content: '第一集\r\n林舟遵守约定。  \r\n沈月归还信物。\r\n' }
const units = scriptSourcePassages(document.content).flatMap(p => p.units), unit = units.find(unit => unit.text.includes('林舟'))!
const marker = '【原稿分析定点修补资料】\n'
const long = '林舟遵守约定，沈月归还信物。'.repeat(12)
const signal = () => new AbortController().signal
const input = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
type Ref = { ref_id: string; target: string; section_id: number | null; index: number | null }
const refFor = (data: ReturnType<typeof input>, target: string, index: number | null = null, section_id: number | null = null): Ref => {
  const ref = data.repair_references.find((ref: Ref) => ref.target === target && ref.index === index && ref.section_id === section_id)
  assert.ok(ref, target); return ref
}
const edit = (ref: Ref, value: unknown, operation = 'replace_ref') => ({ ...ref, operation, value })
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '依据完整原文修正当前表述。', changes })
function fixture() {
  const state = { id: 'refs', source_version: 'source', model_id: 'model', status: 'failed', phase: 'synthesis', updated_at: 'now', completed_chunks: 1, total_chunks: 1,
    sections: [{ offset: 0, length: document.content.length, title: '第一集', episode_number: 1, summary: long, characters: [
      { name: '林舟', description: '遵守约定的角色。'.repeat(16), evidence: { offset: unit.offset, quote: unit.text } }],
      events: [{ summary: '林舟遵守约定。'.repeat(20), evidence: { offset: unit.offset, quote: unit.text } }], open_threads: ['信物用途尚待核实。'.repeat(20)] }],
    story: { summary: long, characters: [{ name: '林舟', aliases: [], description: long, section_ids: [0] }],
      timeline: [{ summary: long, section_ids: [0] }, { summary: '林舟依约行事。'.repeat(25), section_ids: [0] }],
      threads: [{ setup: long, payoff: null, section_ids: [0] }], ending: { summary: long, section_ids: [0] },
      uncertainties: [{ description: long, section_ids: [0] }] } } as ScriptSourceAnalysis
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [
    { kind: 'omission', explanation: '已完成的前序问题', unit_ids: [unit.id] }, { kind: 'causality', explanation: '核实当前约定状态', unit_ids: [unit.id] }] }
  bindProgress(state)
  return state
}
function bindProgress(state: ScriptSourceAnalysis) {
  state.quality!.input_hash = sourceQualityInputHash(state)
  state.quality_repair = { review_hash: state.quality!.input_hash, current_hash: state.quality!.input_hash,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality!.findings)).digest('hex'), completed_findings: 1 }
}
async function rejected(make: (data: ReturnType<typeof input>) => unknown[], pattern: RegExp, state = fixture()) {
  const original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state), raw = ''
  await assert.rejects(repairSourceQuality(document, state, async (prompt, contract) => {
    if (++calls === 1) raw = body(make(input(prompt)))
    if (contract?.name.endsWith('_local_repair')) {
      const marker = '【局部纠正资料】\n', index = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)).change_index
      return JSON.stringify({ repairs: { [`change_${index}`]: JSON.parse(raw).changes[index] } })
    }
    return raw
  }, () => { saves.record() }, signal()), pattern)
  assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original)); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(saves.snapshots.at(-1)!.quality_repair_output!.checkpoint.raw, raw, 'entire rejected proposal remains durable, not only the failed reference')
  return calls
}

test('long references extract frozen values and preserve full inputs, legacy edits and span support in one atomic finding', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state)
  await repairSourceQuality(document, state, async prompt => {
    calls++
    const data = input(prompt)
    assert.match(prompt, /长值已有ref且需整项替换或删除时，优先replace_ref\/remove_ref/)
    assert.match(prompt, /选用ref时不输出expected/)
    assert.match(prompt, /expected规则仅适用于未选ref的分支/)
    assert.match(prompt, /章节summary整项替换（replace或replace_ref）/)
    assert.match(prompt, /title\/episode_number仍只允许replace/)
    assert.match(prompt, /story.summary较长且只需修改一处时优先operation=replace_span/)
    assert.equal(data.units.map((u: { text: string }) => u.text).join(''), document.content)
    assert.equal(data.story.summary, original.story!.summary); assert.equal(data.sections[0].summary, original.sections[0]!.summary)
    assert.deepEqual(Object.values(data.story.timeline), original.story!.timeline)
    assert.equal(data.finding_index, 1); assert.equal(data.baseline_hash, sourceQualityInputHash(original))
    assert.ok(data.repair_references.every((ref: Ref) => !('expected' in ref) && !('value' in ref) && /^[A-Za-z0-9_-]{22}$/.test(ref.ref_id)))
    assert.ok(data.repair_references.every((ref: Ref) => ref.target !== 'section.title' && ref.target !== 'section.episode_number'))
    return body([
      edit(refFor(data, 'section.summary', null, 0), '林舟遵守约定，沈月归还信物。'),
      edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [0] }),
      edit(refFor(data, 'story.ending'), { summary: '信物按约归还。', section_ids: [0] }),
      { target: 'section.title', section_id: 0, operation: 'replace', index: null, expected: '第一集', value: '守约与归还' },
      { target: 'story.summary', section_id: null, operation: 'replace_span', index: null, baseline_hash: data.baseline_hash,
        expected: original.story!.summary, value: '林舟遵守约定，沈月归还信物。' },
    ])
  }, () => { saves.record() }, signal())
  assert.equal(calls, 1); assert.equal(saves.commits, 1); saves.assertPrivateResponse(); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.equal(state.sections[0]!.summary, '林舟遵守约定，沈月归还信物。')
  assert.deepEqual(state.story!.timeline[0], { summary: '林舟依约行事。', section_ids: [0] })
  assert.deepEqual(state.story!.characters, original.story!.characters); assert.deepEqual(state.quality, original.quality)
  assert.equal(document.content, '第一集\r\n林舟遵守约定。  \r\n沈月归还信物。\r\n')
})

test('reference registration uses complete values at the 160 Unicode codepoint boundary with no truncation', async () => {
  const state = fixture(); state.sections[0]!.summary = '界'.repeat(159); state.story!.summary = '界'.repeat(159) + '🚀'; bindProgress(state)
  await repairSourceQuality(document, state, async prompt => {
    const data = input(prompt)
    assert.equal(Array.from(data.story.summary).length, 160); assert.equal(data.story.summary.length, 161)
    assert.ok(!data.repair_references.some((ref: Ref) => ref.target === 'section.summary'))
    assert.equal(refFor(data, 'story.summary').index, null); assert.equal(data.story.summary, state.story!.summary)
    return body([edit(refFor(data, 'story.summary'), '林舟遵守约定。')])
  }, () => {}, signal())
  assert.equal(state.story!.summary, '林舟遵守约定。')
})

test('references reject wrong IDs, target section and index mismatches, reuse and expected/extra fields', async t => {
  for (const mode of ['unknown', 'target', 'section', 'index', 'reuse', 'expected', 'extra', 'append', 'span'] as const) await t.test(mode, async () => {
    await rejected(data => {
      const change = edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [0] })
      if (mode === 'unknown') change.ref_id = 'x'.repeat(22)
      if (mode === 'target') change.target = 'story.uncertainties'
      if (mode === 'section') { change.target = 'section.events'; change.section_id = 0 }
      if (mode === 'index') change.index = 1
      if (mode === 'reuse') return [change, change]
      if (mode === 'expected') Object.assign(change, { expected: data.story.timeline['0'] })
      if (mode === 'extra') Object.assign(change, { guessed: true })
      if (mode === 'append') { change.operation = 'append'; change.index = null }
      if (mode === 'span') { change.target = 'story.summary'; change.operation = 'replace_span'; change.index = null }
      return [change]
    }, /ref_id|不符合.*契约|不能自动重映射|只能引用修改一次/)
  })
})

test('registry IDs bind review findings finding index baseline coordinates and exact frozen values', async () => {
  const original = fixture(), captures: Ref[][] = []
  for (const mode of ['base', 'review', 'finding', 'index', 'baseline', 'value'] as const) {
    const state = structuredClone(original)
    if (mode === 'review') { state.quality!.input_hash = 'b'.repeat(64); state.quality_repair!.review_hash = state.quality!.input_hash }
    if (mode === 'finding') { state.quality!.findings[1]!.explanation += '修改'; state.quality_repair!.findings_hash = createHash('sha256').update(JSON.stringify(state.quality!.findings)).digest('hex') }
    if (mode === 'index') state.quality_repair!.completed_findings = 0
    if (mode === 'baseline') { state.sections[0]!.summary += '变化'; bindProgress(state) }
    if (mode === 'value') { state.story!.timeline[0]!.summary += '变化'; bindProgress(state) }
    await assert.rejects(repairSourceQuality(document, state, async prompt => { captures.push(input(prompt).repair_references); throw new Error('captured before dispatch') }, () => {}, signal()), /captured/)
  }
  const ids = captures.map(refs => refs.find(ref => ref.target === 'story.timeline' && ref.index === 0)!.ref_id)
  assert.equal(new Set(ids).size, ids.length)
  const foreign = captures[1]!.find(ref => ref.target === 'story.timeline' && ref.index === 0)!
  await rejected(() => [edit(foreign, { summary: '林舟依约行事。', section_ids: [0] })], /不属于本次finding/)
})

test('a ref after an earlier removal cannot bypass sequential expected matching or partially commit', async () => {
  await rejected(data => [edit(refFor(data, 'story.timeline', 0), null, 'remove_ref'),
    edit(refFor(data, 'story.timeline', 1), { summary: '林舟依约行事。', section_ids: [0] })], /索引或原值不匹配/)
  const state = fixture()
  await repairSourceQuality(document, state, async prompt => {
    const data = input(prompt)
    return body([edit(refFor(data, 'story.timeline', 1), null, 'remove_ref'), edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [0] })])
  }, () => {}, signal())
  assert.deepEqual(state.story!.timeline, [{ summary: '林舟依约行事。', section_ids: [0] }])
})

test('refs preserve no-op, final value schema, evidence and story section guards', async t => {
  for (const mode of ['noop', 'section ids', 'long value', 'bad evidence', 'invented name', 'remove value'] as const) await t.test(mode, async () => {
    await rejected(data => {
      if (mode === 'noop') return [edit(refFor(data, 'story.timeline', 0), data.story.timeline['0'])]
      if (mode === 'section ids') return [edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [999] })]
      if (mode === 'long value') return [edit(refFor(data, 'story.timeline', 0), { summary: '界'.repeat(601), section_ids: [0] })]
      if (mode === 'bad evidence') return [edit(refFor(data, 'section.events', 0, 0), { summary: '林舟守约。', evidence: { unit_id: 99999 } })]
      if (mode === 'invented name') return [edit(refFor(data, 'story.characters', 0), { name: '无依据人物', aliases: [], description: '不存在', section_ids: [0] })]
      return [edit(refFor(data, 'story.timeline', 0), { summary: '林舟守约。', section_ids: [0] }, 'remove_ref')]
    }, /相同内容|不存在的章节|不符合.*契约|本章节内真实|没有所引章节|不能|repair/)
  })
})

test('model-time state drift cannot receive a stale ref patch or discard earlier progress', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0, saves = repairSaveRecorder(state)
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    calls++; const data = input(prompt); state.story!.summary += '外部保存。'
    return body([edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [0] })])
  }, () => { saves.record() }, signal()), /修补期间发生变化/)
  assert.equal(calls, 1); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.deepEqual(state.story!.timeline, original.story!.timeline)
  assert.ok(state.story!.summary.endsWith('外部保存。')); assert.equal(state.quality_repair!.completed_findings, 1)
})

test('a long ref value retains precise structural leaf repair without changing its frozen ref or coordinates', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0, initialRef = ''
  await repairSourceQuality(document, state, async (prompt, contract) => {
    if (++calls === 1) {
      const data = input(prompt), ref = refFor(data, 'story.timeline', 0); initialRef = ref.ref_id
      return body([edit(ref, { summary: '界'.repeat(601), section_ids: [0] })])
    }
    assert.equal(contract!.name, 'script_source_quality_repair_structure_repair')
    assert.match(prompt, /"path":\["changes",0,"value","summary"\]/)
    assert.ok(prompt.includes(initialRef)); assert.deepEqual(repairBusinessSnapshot(state), repairBusinessSnapshot(original))
    assert.deepEqual((contract!.schema.properties as any).repairs.properties.repair_0, { type: 'string', minLength: 1, maxLength: 600 })
    return JSON.stringify({ repairs: { repair_0: '林舟依约行事。' } })
  }, () => {}, signal())
  assert.equal(calls, 2); assert.equal(sourceQualityRepairProgress(state), 2)
  assert.deepEqual(state.story!.timeline[0], { summary: '林舟依约行事。', section_ids: [0] })
})

test('same-analysis review finding progress and withdrawal drift cannot receive ref, legacy or explicit retain results', async t => {
  for (const mode of ['review', 'findings', 'progress', 'withdrawals'] as const) for (const response of ['ref', 'legacy', 'retain'] as const) await t.test(mode + '/' + response, async () => {
    const state = fixture(), original = structuredClone(state), baseline = sourceQualityInputHash(state); let calls = 0, saves = repairSaveRecorder(state)
    await assert.rejects(repairSourceQuality(document, state, async prompt => {
      calls++; const data = input(prompt)
      if (mode === 'review') state.quality!.input_hash = 'c'.repeat(64)
      if (mode === 'findings') state.quality!.findings[1]!.explanation += '外部新审阅'
      if (mode === 'progress') state.quality_repair!.completed_findings = 0
      if (mode === 'withdrawals') state.quality_repair!.withdrawals = [{ finding_index: 0, finding_hash: 'a'.repeat(64), analysis_hash: baseline, reason: '外部撤销记录', unit_ids: [unit.id] }]
      assert.equal(sourceQualityInputHash(state), baseline, 'analysis hash alone cannot detect review/progress drift')
      if (response === 'retain') return JSON.stringify({ decision: 'retain_analysis', finding_hash: data.finding_hash,
        reason: '保留当前约定状态并等待独立核对。', changes: [], analysis_refs: [{ path: 'story.timeline[0]' }], source_refs: [{ unit_id: unit.id }] })
      return body([response === 'ref' ? edit(refFor(data, 'story.timeline', 0), { summary: '林舟依约行事。', section_ids: [0] }) :
        { target: 'story.timeline', section_id: null, operation: 'replace', index: 0, expected: data.story.timeline['0'], value: { summary: '林舟依约行事。', section_ids: [0] } }])
    }, () => { saves.record() }, signal()), /分析结果在.*期间发生变化/)
    assert.equal(calls, 1); assert.equal(saves.commits, 0); saves.assertPrivateResponse(); assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.story, original.story)
    if (mode === 'progress') assert.equal(state.quality_repair!.completed_findings, 0)
    else assert.equal(state.quality_repair!.completed_findings, 1)
    if (mode === 'withdrawals') assert.equal(state.quality_repair!.withdrawals![0]!.reason, '外部撤销记录')
  })
})
