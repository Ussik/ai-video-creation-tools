import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftCompletenessInput, reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'

const content = '林晚最终归还铜钥匙，与家人一起走过石桥。'
const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
  artifacts: [{ artifact_type: 'outline', title: '故事大纲', content }] }
const finding = { source_key: 'outline', kind: 'contradiction' as const, quote: content,
  explanation: '结尾与创作者明确要求不一致。', suggestion: '保留创作者确认的结局。' }
const report = (findings: unknown[]) => ({ facts: [], checked_artifacts: ['outline'], findings })

test('fresh findings require an explicit severity and reject null or unrecognized labels', () => {
  for (const severity of [undefined, null, '', 'minor']) {
    assert.equal(draftCompletenessInput.safeParse(report([{ ...finding, severity }])).success, false)
  }
  for (const severity of ['blocking', 'suggestion']) {
    assert.equal(draftCompletenessInput.safeParse(report([{ ...finding, severity }])).success, true)
  }
})

test('missing severity requests format correction and a corrected artistic suggestion does not block', async () => {
  for (const severity of [undefined, null]) {
    let calls = 0
    const suggestions: unknown[] = []
    await reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
      calls++
      const items = (contract!.schema.properties as {
        findings: { items: { required: string[]; properties: { severity: { enum: string[] } } } }
      }).findings.items
      assert.ok(items.required.includes('severity'))
      assert.deepEqual(items.properties.severity.enum, ['blocking', 'suggestion'])
      if (calls === 1) return JSON.stringify(report([{ ...finding, severity }]))
      assert.match(prompt, /一次格式修正/)
      assert.match(prompt, /findings\[0\]\.severity/)
      return JSON.stringify(report([{ ...finding, severity: 'suggestion' }]))
    }, { onSuggestions: items => suggestions.push(...items) })
    assert.equal(calls, 2)
    assert.equal(suggestions.length, 1)
  }
})

test('repeatedly omitted severity cannot pass or become an inferred blocker', async () => {
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(draft, async () => {
    calls++
    return JSON.stringify(report([finding]))
  }), issue => {
    assert.ok(issue instanceof Error)
    assert.ok(!(issue instanceof ScriptDraftNeedsResolution))
    assert.match(issue.message, /severity/)
    return true
  })
  assert.equal(calls, 2)
})

test('explicit blockers and old persisted findings retain their evidence and blocking behavior', async () => {
  const steps = createGenerationSteps()
  await assert.rejects(reviewScriptDraftCompleteness(draft,
    async () => JSON.stringify(report([{ ...finding, severity: 'blocking' }])), { steps }), ScriptDraftNeedsResolution)
  const cached = steps.checkpoint.steps['review:whole']!.value as { findings: Array<Record<string, unknown>> }
  delete cached.findings[0]!.severity
  await assert.rejects(reviewScriptDraftCompleteness(draft, async () => {
    throw new Error('a valid legacy cached report should be reused')
  }, { steps }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings[0]!.quote, content)
    assert.equal(issue.findings[0]!.explanation, finding.explanation)
    return true
  })
})

test('paged review recovery also requires severity before retaining a reported item', async () => {
  let pageCalls = 0
  const suggestions: unknown[] = []
  await reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    const focused = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1]
    if (!focused || focused === 'settings' && contract!.name === 'script_draft_completeness') {
      throw new TextOutputLimitError('', 'length')
    }
    if (contract!.name === 'script_draft_completeness_page') {
      pageCalls++
      if (pageCalls === 1) return JSON.stringify({ items: [finding], complete: true })
      assert.match(prompt, /items\[0\]\.severity/)
      return JSON.stringify({ items: [{ ...finding, severity: 'suggestion' }], complete: true })
    }
    return JSON.stringify(report([]))
  }, { onSuggestions: items => suggestions.push(...items) })
  assert.equal(pageCalls, 2)
  assert.equal(suggestions.length, 1)
})
