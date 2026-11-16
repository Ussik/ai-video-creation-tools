import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { repairSourceQuality, sourceQualityRepairProgress, type SourceQualityProposalState } from '../src/modules/script/script-source-quality-repair.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const document = { filename: 'local-repair.txt', content: '第一集\n林舟守约。\n第二集\n沈月归还信物。杜铮受到细线操控。\n' }
const units = scriptSourcePassages(document.content).flatMap(p => p.units)
const unitFor = (name: string) => units.find(unit => unit.text.includes(name))!
const signal = () => new AbortController().signal
const initialMarker = '【原稿分析定点修补资料】\n', localMarker = '【局部纠正资料】\n'
const initialInput = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(initialMarker) + initialMarker.length))
const localInput = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf(localMarker) + localMarker.length))
const body = (changes: unknown[]) => JSON.stringify({ status: 'patched', reason: '依据完整原文修补当前问题', changes })
const patch = (index: number, change: unknown) => JSON.stringify({ repairs: { [`change_${index}`]: change } })
function fixture(): SourceQualityProposalState {
  const split = document.content.indexOf('第二集'), evidence = { offset: unitFor('沈月').offset, quote: unitFor('沈月').text }
  const state = { id: 'local-quality', source_version: 'source-v1', model_id: 'model', status: 'failed', phase: 'synthesis', updated_at: 'now', completed_chunks: 1, total_chunks: 1,
    sections: [
      { offset: 0, length: split, unit_id: 0, title: '第一集', episode_number: 1, summary: '林舟守约', characters: [], events: [], open_threads: [] },
      { offset: split, length: document.content.length - split, unit_id: 1, title: '第二集', episode_number: 2, summary: '信物归还', characters: [], events: [{ summary: '信物归还', evidence }], open_threads: [] },
    ], story: { summary: '林舟守约，沈月归还信物。', characters: [], timeline: [{ summary: '信物归还', section_ids: [1] }], threads: [], ending: { summary: '信物归还', section_ids: [1] }, uncertainties: [] },
  } as ScriptSourceAnalysis
  refreshReview(state)
  return state
}
function businessState(state: SourceQualityProposalState) {
  const { quality_repair_output: _private, quality_repair_outputs: _archives, ...business } = structuredClone(state)
  if (business.quality_repair) { delete business.quality_repair.stop_reason; delete business.quality_repair.stop_message }
  return business
}
function privateProposal(state: SourceQualityProposalState) {
  const output = state.quality_repair_output || state.quality_repair_outputs?.at(-1)
  assert.ok(output)
  assert.match(output.binding, /^[a-f0-9]{64}$/)
  assert.match(output.checkpoint.input_hash!, /^[a-f0-9]{64}$/)
  assert.equal(typeof output.checkpoint.raw, 'string')
  return output.checkpoint
}
function refreshReview(state: ScriptSourceAnalysis) {
  const current_hash = sourceQualityInputHash(state)
  state.quality = { input_hash: current_hash, status: 'issues', findings: [{ kind: 'omission', explanation: '核对沈月归还信物与杜铮受控事实。', unit_ids: [unitFor('沈月').id] }] }
  state.quality_repair = { review_hash: current_hash, current_hash, completed_findings: 0,
    findings_hash: createHash('sha256').update(JSON.stringify(state.quality.findings)).digest('hex') }
}
const eventChange = (expected = '错误的原值') => ({ target: 'section.events', section_id: 1, operation: 'replace', index: 0,
  expected: { summary: expected, evidence: { unit_id: unitFor('沈月').id } }, value: { summary: '沈月归还信物', evidence: { unit_id: unitFor('沈月').id } } })
const summaryChange = (state: ScriptSourceAnalysis) => ({ target: 'story.summary', section_id: null, operation: 'replace', index: null,
  expected: state.story!.summary, value: '林舟守约，沈月归还信物，杜铮受到细线操控。' })

test('one indexed business correction preserves every sibling beyond the former raw-output tail limit', async () => {
  const state = fixture(), original = structuredClone(state)
  const retained = Array.from({ length: 32 }, (_, index) => ({ target: 'story.timeline', section_id: null, operation: 'append', index: null, expected: null,
    value: { summary: `PRIVATE_VALID_SIBLING_${index}_` + '完整保留已有原文事实。'.repeat(40), section_ids: [1] } }))
  const changes = [...retained, eventChange()]
  assert.ok(body(changes).length > 12000)
  let calls = 0
  const snapshots: SourceQualityProposalState[] = []
  await repairSourceQuality(document, state, async (prompt, contract) => {
    if (++calls === 1) return body(changes)
    assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
    assert.ok(!prompt.includes('PRIVATE_VALID_SIBLING_')); assert.ok(!prompt.includes(initialMarker))
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['change_32'])
    const data = localInput(prompt)
    assert.equal(data.change_index, 32); assert.equal(data.failure_field, 'expected')
    assert.deepEqual(data.current_values[1].value['0'], eventChange('信物归还').expected)
    assert.equal(data.units.map((unit: { text: string }) => unit.text).join(''), document.content)
    assert.deepEqual(businessState(state), businessState(original), 'valid edits remain private proposals until the whole finding validates')
    assert.equal(privateProposal(state).raw, body(changes), 'the complete raw proposal is durable before the local request')
    assert.ok(privateProposal(state).correction_started)
    return patch(32, eventChange('信物归还'))
  }, () => { snapshots.push(structuredClone(state)) }, signal())
  assert.equal(calls, 2)
  assert.ok(snapshots.length > 1)
  for (const snapshot of snapshots.slice(0, -1)) assert.deepEqual(businessState(snapshot), businessState(original), 'durable proposal checkpoints never partially commit siblings')
  assert.equal(sourceQualityRepairProgress(snapshots.at(-1)!), 1)
  assert.deepEqual(JSON.parse(privateProposal(state).raw!).changes.slice(0, 32), retained)
  assert.deepEqual(state.story!.timeline, [...original.story!.timeline, ...retained.map(item => item.value)])
  assert.equal(state.sections[1]!.events[0]!.summary, '沈月归还信物')
  assert.deepEqual(state.quality, original.quality); assert.equal(sourceQualityRepairProgress(state), 1)
})

for (const mode of ['wrong key', 'extra key', 'target change', 'status change', 'whole candidate', 'nested fragment', 'same invalid expected'] as const) {
  test('local correction rejects unauthorized or still-invalid output atomically: ' + mode, async () => {
    const state = fixture(), original = structuredClone(state), changes = [summaryChange(state), eventChange()]
    let calls = 0
    const snapshots: SourceQualityProposalState[] = []
    await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
      if (++calls === 1) return body(changes)
      assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
      const valid = eventChange('信物归还')
      if (mode === 'wrong key') return patch(0, valid)
      if (mode === 'extra key') return JSON.stringify({ repairs: { change_1: valid, change_0: summaryChange(state) } })
      if (mode === 'target change') return patch(1, summaryChange(state))
      if (mode === 'status change') return JSON.stringify({ status: 'withdrawn', repairs: { change_1: valid } })
      if (mode === 'whole candidate') return body([changes[0], valid])
      if (mode === 'nested fragment') return JSON.stringify({ incomplete: { repairs: { change_1: valid } } }).slice(0, -1)
      return patch(1, changes[1])
    }, () => { snapshots.push(structuredClone(state)) }, signal()))
    assert.equal(calls, 2); assert.deepEqual(businessState(state), businessState(original)); assert.equal(sourceQualityRepairProgress(state), 0)
    assert.ok(snapshots.length > 0)
    for (const snapshot of snapshots) assert.deepEqual(businessState(snapshot), businessState(original))
    assert.equal(privateProposal(state).raw, body(changes))
    assert.equal(typeof privateProposal(state).correction?.raw, 'string', 'even an invalid completed correction retains its raw response')
    const recovered = JSON.parse(JSON.stringify(state)) as SourceQualityProposalState
    let reissued = 0
    await assert.rejects(repairSourceQuality(document, recovered, async () => { reissued++; throw new Error('must not reissue a completed correction') }, () => {}, signal()))
    assert.equal(reissued, 0)
    assert.deepEqual(businessState(recovered), businessState(original))
  })
}

test('correcting one operation still rechecks the remaining proposal and cannot spend a third attempt', async () => {
  const state = fixture(), original = structuredClone(state)
  const changes = [eventChange(), { ...eventChange('信物归还'), value: { summary: '受控事实', evidence: { unit_id: unitFor('林舟').id } } }]
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
    if (++calls === 1) return body(changes)
    assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
    return patch(0, eventChange('信物归还'))
  }, () => {}, signal()), /本章节内真实/)
  assert.equal(calls, 2); assert.deepEqual(businessState(state), businessState(original))
})

test('locally corrected new values retain source evidence and character-name gates', async t => {
  for (const mode of ['foreign evidence', 'invented character'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone(state)
    const character = { target: 'section.characters', section_id: 1, operation: 'append', index: null, expected: null,
      value: { name: '沈月', description: '归还信物', evidence: { unit_id: 999999 } } }
    let calls = 0
    await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
      if (++calls === 1) return body([character])
      assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
      return patch(0, { ...character, value: { ...character.value, name: mode === 'invented character' ? '不存在的人' : '沈月',
        evidence: { unit_id: unitFor(mode === 'foreign evidence' ? '林舟' : '沈月').id } } })
    }, () => {}, signal()), mode === 'foreign evidence' ? /本章节内真实/ : /没有姓名依据/)
    assert.equal(calls, 2); assert.deepEqual(businessState(state), businessState(original))
  })
})

test('local correction revalidates global character evidence and section reference gates', async t => {
  for (const mode of ['unsupported alias', 'duplicate section ids', 'unknown section ids'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone(state)
    const first = { target: 'story.characters', section_id: null, operation: 'replace', index: 99,
      expected: { name: '沈月', aliases: [], description: '归还信物', section_ids: [1] }, value: { name: '沈月', aliases: [], description: '归还信物', section_ids: [1] } }
    let calls = 0
    const pattern = mode === 'unsupported alias' ? /没有所引章节/ : mode === 'duplicate section ids' ? /不能重复引用/ : /不存在的章节/
    await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
      if (++calls === 1) return body([summaryChange(state), first])
      assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
      return patch(1, { ...first, operation: 'append', index: null, expected: null,
        value: { ...first.value, aliases: mode === 'unsupported alias' ? ['虚构身份'] : [], section_ids: mode === 'duplicate section ids' ? [1, 1] : mode === 'unknown section ids' ? [999] : [1] } })
    }, () => {}, signal()), pattern)
    assert.equal(calls, 2); assert.deepEqual(businessState(state), businessState(original))
  })
})

test('frozen references remain bound while one incorrect reference is explicitly corrected', async () => {
  const state = fixture(); state.story!.summary = '守约事实。'.repeat(45); refreshReview(state)
  const original = structuredClone(state); let calls = 0, correctRef: any
  await repairSourceQuality(document, state, async (prompt, contract) => {
    if (++calls === 1) {
      correctRef = initialInput(prompt).repair_references.find((ref: any) => ref.target === 'story.summary')
      return body([eventChange('信物归还'), { ...correctRef, operation: 'replace_ref', ref_id: 'x'.repeat(22), value: '林舟守约，沈月归还信物。' }])
    }
    assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
    assert.equal(localInput(prompt).failure_field, 'ref_id'); assert.deepEqual(businessState(state), businessState(original))
    return patch(1, { ...correctRef, operation: 'replace_ref', value: '林舟守约，沈月归还信物。' })
  }, () => {}, signal())
  assert.equal(calls, 2); assert.equal(state.story!.summary, '林舟守约，沈月归还信物。')
  assert.equal(state.sections[1]!.events[0]!.summary, '沈月归还信物')
})

test('a reference never remaps after deletion; an explicit exact legacy correction can address the shifted item', async () => {
  const state = fixture(); state.story!.timeline = [0, 1].map(index => ({ summary: `${index}：` + '有原文依据的事实。'.repeat(25), section_ids: [1] })); refreshReview(state)
  const original = structuredClone(state); let calls = 0
  await repairSourceQuality(document, state, async (prompt, contract) => {
    if (++calls === 1) {
      const refs = initialInput(prompt).repair_references.filter((ref: any) => ref.target === 'story.timeline')
      return body([{ ...refs[0], operation: 'remove_ref', value: null }, { ...refs[1], operation: 'replace_ref', value: { summary: '沈月归还信物。', section_ids: [1] } }])
    }
    assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
    const data = localInput(prompt); assert.equal(data.change_index, 1); assert.equal(data.preceding_same_target_changes.length, 1)
    assert.deepEqual(businessState(state), businessState(original))
    return patch(1, { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
      expected: original.story!.timeline[1], value: { summary: '沈月归还信物。', section_ids: [1] } })
  }, () => {}, signal())
  assert.equal(calls, 2); assert.deepEqual(state.story!.timeline, [{ summary: '沈月归还信物。', section_ids: [1] }])
})

test('analysis or review drift and cancellation during local correction retain all business changes', async t => {
  for (const mode of ['analysis', 'review', 'abort'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone(state), controller = new AbortController(); let calls = 0
    const snapshots: SourceQualityProposalState[] = []
    await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
      if (++calls === 1) return body([summaryChange(state), eventChange()])
      assert.equal(contract!.name, 'script_source_quality_repair_local_repair')
      if (mode === 'analysis') state.story!.summary = '外部保存'
      if (mode === 'review') state.quality!.findings[0]!.explanation += '外部更新'
      if (mode === 'abort') controller.abort(new Error('cancel local correction'))
      return patch(1, eventChange('信物归还'))
    }, () => { snapshots.push(structuredClone(state)) }, controller.signal), mode === 'abort' ? /cancel local/ : /发生变化/)
    assert.equal(calls, 2); assert.ok(snapshots.length > 0); assert.deepEqual(state.sections, original.sections)
    assert.ok(snapshots.every(snapshot => sourceQualityRepairProgress(snapshot) !== 1), 'no private checkpoint advances completed business findings')
    if (mode === 'abort') assert.equal(typeof privateProposal(state).correction?.raw, 'string')
    else assert.deepEqual(JSON.parse(privateProposal(state).raw!).changes, [summaryChange(original), eventChange('信物归还')],
      'the fully validated frozen proposal may persist, while the later live-state gate still prevents business commit')
    if (mode !== 'analysis') assert.deepEqual(state.story, original.story)
    assert.equal(state.quality_repair!.completed_findings, 0)
  })
})

test('unknown delivery during local correction cannot dispatch another request or persist siblings', async () => {
  const state = fixture(), original = structuredClone(state); let calls = 0
  const snapshots: SourceQualityProposalState[] = []
  const unknown = Object.assign(new Error('source local response delivery unknown'), { delivery: 'unknown', failure_stage: 'body', code: 'upstream_request_interrupted' })
  await assert.rejects(repairSourceQuality(document, state, async (_prompt, contract) => {
    if (++calls === 1) return body([summaryChange(state), eventChange()])
    assert.equal(contract!.name, 'script_source_quality_repair_local_repair'); throw unknown
  }, () => { snapshots.push(structuredClone(state)) }, signal()), error => error === unknown)
  assert.equal(calls, 2); assert.deepEqual(businessState(state), businessState(original))
  assert.ok(snapshots.length > 0)
  for (const snapshot of snapshots) assert.deepEqual(businessState(snapshot), businessState(original))
  const checkpoint = privateProposal(state)
  assert.equal(checkpoint.raw, body([summaryChange(original), eventChange()]))
  assert.ok(checkpoint.correction_started); assert.equal(checkpoint.correction, undefined)
  const recovered = JSON.parse(JSON.stringify(state)) as SourceQualityProposalState
  let resumedCalls = 0
  await assert.rejects(repairSourceQuality(document, recovered, async () => { resumedCalls++; throw new Error('unknown correction reissued') }, () => {}, signal()),
    (error: any) => error.code === 'structured_correction_exhausted')
  assert.equal(resumedCalls, 0)
  assert.deepEqual(businessState(recovered), businessState(original))
  recovered.configuration_hash = 'explicit-new-configuration'
  const beforeNewAttempt = structuredClone(businessState(recovered))
  const names: string[] = []
  await assert.rejects(repairSourceQuality(document, recovered, async (_prompt, contract) => {
    names.push(contract!.name); throw new Error('a changed configuration must not repurchase a protected unknown response')
  }, () => {}, signal()), /检查点与当前问题不匹配/)
  assert.deepEqual(names, []); assert.deepEqual(businessState(recovered), beforeNewAttempt)
  assert.equal(sourceQualityRepairProgress(recovered), 0)
})
