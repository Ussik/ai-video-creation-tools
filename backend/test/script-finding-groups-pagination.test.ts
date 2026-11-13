import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { groupDraftFindings } from '../src/modules/script/script-finding-groups.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { FindingResolutionRecord } from '../src/modules/script/script-finding-state.js'

const findings: ScriptDraftFinding[] = [0, 1, 2].map(index => ({
  source_key: `source:${index}`, topic: `第${index}项独立事实`, kind: 'contradiction',
  quote: `第${index}处原文证据`, explanation: `第${index}处前后矛盾`, suggestion: `核对第${index}处事实`,
}))
const group = (index: number, resolution_id?: string) => ({
  topic: `第${index}项独立事实`, members: [index], ...(resolution_id ? { resolution_id } : {}),
})
const page = (indexes: number[], complete: boolean) => JSON.stringify({ items: indexes.map(index => group(index)), complete })
const limited = () => new TextOutputLimitError('{"groups":[', 'max_output_tokens')

function workspace() {
  let saved: GenerationCheckpoint = { steps: {} }
  return {
    steps: (signal?: AbortSignal) => createGenerationSteps({ checkpoint: saved, signal,
      save: state => { saved = structuredClone(state) } }),
    snapshot: () => structuredClone(saved),
  }
}

test('grouping output limits switch to complete group pages without changing original evidence', async () => {
  const f = workspace(), calls: string[] = []
  const result = await groupDraftFindings(findings, [], async (prompt, contract) => {
    calls.push(contract!.name)
    for (const finding of findings) assert.ok(prompt.includes(finding.quote), 'each page retains all original evidence')
    if (contract!.name === 'script_finding_groups') throw limited()
    return calls.length === 2 ? page([0, 1], false) : page([2], true)
  }, { steps: f.steps() })
  assert.deepEqual(calls, ['script_finding_groups', 'script_finding_groups_page', 'script_finding_groups_page'])
  assert.deepEqual(result.map(({ quote, explanation, suggestion }) => ({ quote, explanation, suggestion })),
    findings.map(({ quote, explanation, suggestion }) => ({ quote, explanation, suggestion })))
  await groupDraftFindings(findings, [], async () => assert.fail('validated complete grouping is reused'), { steps: f.steps() })
})

test('continuing interrupted grouping skips the exhausted full request and already completed pages', async () => {
  const f = workspace(), calls: string[] = []
  await assert.rejects(groupDraftFindings(findings, [], async (_prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_finding_groups') throw limited()
    if (calls.length === 2) return page([0], false)
    throw new TextProviderError('fixture disconnected', false)
  }, { steps: f.steps() }), /fixture disconnected/)
  const resumed: string[] = []
  const result = await groupDraftFindings(findings, [], async (_prompt, contract) => {
    resumed.push(contract!.name)
    return page([1, 2], true)
  }, { steps: f.steps() })
  assert.deepEqual(resumed, ['script_finding_groups_page'])
  assert.equal(result.length, findings.length)
  assert.ok(f.snapshot().steps['review:issue-groups'])
})

test('a truncated group page retains only closed valid groups and continues the unassigned indexes', async () => {
  const f = workspace()
  let calls = 0
  const result = await groupDraftFindings(findings, [], async (_prompt, contract) => {
    calls++
    if (contract!.name === 'script_finding_groups') throw limited()
    if (calls === 2) throw new TextOutputLimitError('{"items":[' + JSON.stringify(group(0)) + ',{"topic":"未闭合', 'length')
    return page([1, 2], true)
  }, { steps: f.steps() })
  assert.equal(calls, 3)
  assert.equal(result.length, findings.length)
  assert.deepEqual(result.map(finding => finding.quote), findings.map(finding => finding.quote))
})

test('group pages reject repeated members or missing final indexes without publishing overall success', async t => {
  for (const invalid of ['duplicate', 'missing'] as const) await t.test(invalid, async () => {
    const f = workspace()
    await assert.rejects(groupDraftFindings(findings, [], async (_prompt, contract) => {
      if (contract!.name === 'script_finding_groups') throw limited()
      return invalid === 'duplicate' ? JSON.stringify({ items: [group(0), { ...group(1), members: [0] }], complete: true }) : page([0], true)
    }, { steps: f.steps() }), /问题必须且只能属于一个组/)
    assert.equal(f.snapshot().steps['review:issue-groups'], undefined)
  })
})

test('history authorization cannot be reused by separate groups on different pages', async () => {
  const f = workspace()
  const previous: FindingResolutionRecord[] = [{ id: 'known-decision', source_key: findings[0]!.source_key,
    kind: 'contradiction', problem: '旧问题', strategy: 'manual', answer: '原有回答', summary: '原有决定',
    attempts: 1, status: 'addressed' }]
  let pageCalls = 0
  await assert.rejects(groupDraftFindings(findings, previous, async (_prompt, contract) => {
    if (contract!.name === 'script_finding_groups') throw limited()
    pageCalls++
    return pageCalls === 1
      ? JSON.stringify({ items: [group(0, 'known-decision')], complete: false })
      : JSON.stringify({ items: [group(1, 'known-decision'), group(2)], complete: true })
  }, { steps: f.steps() }), /同一个历史决定只能对应一个共同事项/)
  assert.equal(f.snapshot().steps['review:issue-groups'], undefined)
})

test('cancelling grouping preserves finished pages and sends no more requests until resumed', async () => {
  const f = workspace(), controller = new AbortController()
  let pages = 0
  await assert.rejects(groupDraftFindings(findings, [], async (_prompt, contract) => {
    if (contract!.name === 'script_finding_groups') throw limited()
    pages++
    if (pages === 1) return page([0], false)
    controller.abort(new DOMException('fixture stopped', 'AbortError'))
    throw controller.signal.reason
  }, { steps: f.steps(controller.signal), signal: controller.signal }), /fixture stopped/)
  assert.equal(pages, 2)
  const result = await groupDraftFindings(findings, [], async (_prompt, contract) => {
    assert.equal(contract!.name, 'script_finding_groups_page')
    return page([1, 2], true)
  }, { steps: f.steps() })
  assert.equal(result.length, 3)
})

test('changed evidence invalidates the former paging strategy and completed grouping', async () => {
  const f = workspace()
  let pages = 0
  await groupDraftFindings(findings, [], async (_prompt, contract) => {
    if (contract!.name === 'script_finding_groups') throw limited()
    pages++
    return page([0, 1, 2], true)
  }, { steps: f.steps() })
  assert.equal(pages, 1)
  const changed = findings.map((finding, index) => index ? finding : { ...finding, quote: '修订后的真实证据' })
  const calls: string[] = []
  const result = await groupDraftFindings(changed, [], async (_prompt, contract) => {
    calls.push(contract!.name)
    return JSON.stringify({ groups: findings.map((_, index) => group(index)) })
  }, { steps: f.steps() })
  assert.deepEqual(calls, ['script_finding_groups'])
  assert.equal(result[0]!.quote, '修订后的真实证据')
})
