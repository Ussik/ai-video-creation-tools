import { draftReviewFixtureJson } from './fixtures/script-draft-completeness.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const candidate = (): WorkflowDraft => ({ stage: 'characters', scope: 'project', episode_number: 0, artifacts: [
  { artifact_type: 'characters', title: '人物', content: '林舟是记者。\n他守护伙伴，最终归还“铜钥匙”。' },
  { artifact_type: 'relationships', title: '关系', content: '伙伴自愿归来；并非被林舟收服。' },
], scenes: [] })
function material(prompt: string): Array<{ key: string; artifact_type: string; content: string }> {
  const marker = '待核对草稿原文（资料）：'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).split('\n【本轮候选正文结束】')[0]!)
}
const complete = { checked_artifacts: ['characters', 'relationships'], facts: [], findings: [] }

test('independent review sees complete candidate and full effective source together and preserves exact finding evidence', async () => {
  const draft = candidate(), steps = createGenerationSteps()
  draft.artifacts[0].content += '人物经历与动机。'.repeat(6000) + '最终决定归还铜钥匙。'
  const original = '原稿林舟是船夫。' + '完整故事。'.repeat(16000) + '结局归还铜钥匙。'
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
    calls++
    assert.ok(prompt.includes(original))
    const submitted = material(prompt)
    assert.deepEqual(submitted.map(item => item.content), draft.artifacts.map(item => item.content))
    assert.match(prompt, /一次送审完整候选文档/)
    return draftReviewFixtureJson({ ...complete, findings: [
      { source_key: 'characters', kind: 'contradiction', quote: '林舟是记者。', explanation: '草稿身份与原稿船夫身份冲突。', suggestion: '沿用原稿身份。' },
    ] })
  }, { context: { uploaded_script: { content: original } }, steps }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings[0].source_key, 'characters')
    assert.equal(issue.findings[0].quote, '林舟是记者。')
    assert.ok(issue.diagnostic.repair.includes('林舟是记者。'))
    return true
  })
  assert.equal(calls, 1, 'large source and candidate do not trigger fragment or fact-review calls')
  assert.equal((steps.checkpoint.steps['review:whole'].value as any).findings[0].quote, '林舟是记者。')
})

test('unknown sources, copied original quotes and incomplete artifact coverage cannot pass whole-work review', async t => {
  for (const invalid of ['source', 'quote', 'coverage'] as const) await t.test(invalid, async () => {
    const steps = createGenerationSteps(), calls: string[] = []
    await assert.rejects(reviewScriptDraftCompleteness(candidate(), async (_prompt, contract) => {
      calls.push(contract!.name)
      if (contract?.name === 'script_draft_evidence_repair') return draftReviewFixtureJson({ repairs: [{
        id: 'findings:0', first_unit: null, last_unit: null }] })
      if (contract?.name === 'script_draft_evidence_reassessment') return draftReviewFixtureJson({ reassessments: [{
        id: 'findings:0', verdict: 'unresolved', reason: '原稿引文不能作为候选人物文档的证据，现有资料仍不足以确认结论。',
        source_key: null, first_unit: null, last_unit: null,
      }] })
      return draftReviewFixtureJson({ checked_artifacts: invalid === 'coverage' ? ['characters'] : complete.checked_artifacts,
        findings: [{ source_key: invalid === 'source' ? 'uploaded_script' : 'characters',
          quote: invalid === 'quote' ? '林舟是船夫。' : '林舟是记者。', kind: 'contradiction', explanation: '身份冲突', suggestion: '保留原稿身份' }],
        facts: [] })
    }, { context: { uploaded_script: { content: '林舟是船夫。' } }, steps }), /模型结果不符合 script_draft_completeness 契约|证据尚未定位到候选稿原文/)
    assert.deepEqual(calls, invalid === 'quote'
      ? ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_reassessment']
      : ['script_draft_completeness', 'script_draft_completeness'],
    'quote failures get one locator and one semantic reassessment; structural failures get one bounded contract correction')
    assert.equal(steps.checkpoint.steps['review:whole'], undefined)
    assert.equal(Object.keys(steps.checkpoint.steps).some(key => key.startsWith('review:response:')), invalid === 'quote')
  })
})

test('optional paraphrased facts are omitted while exact facts remain candidate evidence', async () => {
  let calls = 0
  const steps = createGenerationSteps()
  const fact = { source_key: 'characters', quote: '林舟是记者。', meaning: '人物身份' }
  await reviewScriptDraftCompleteness(candidate(), async (_prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_draft_completeness')
    return draftReviewFixtureJson({ ...complete, facts: [fact,
      { ...fact, quote: '林舟是一名记者。' }, { ...fact, source_key: 'uploaded_script' }] })
  }, { steps })
  assert.equal(calls, 1, 'optional summaries do not start evidence lookup or another full review')
  assert.deepEqual((steps.checkpoint.steps['review:whole'].value as any).facts, [fact])
})

test('legacy partial checkpoints cannot stand in for whole-work review and the new full audit is reusable', async () => {
  const checkpoint: GenerationCheckpoint = JSON.parse(await readFile(new URL('./fixtures/script-audit-legacy-checkpoint.json', import.meta.url), 'utf8'))
  const steps = createGenerationSteps({ checkpoint })
  const draft = candidate(), original = [[{ offset: 0, content: '开场林舟追查失物。' }], [{ offset: 9, content: '结局林舟归还钥匙。' }]]
  let calls = 0
  await reviewScriptDraftCompleteness(draft, async prompt => {
    calls++
    assert.ok(prompt.includes('开场林舟追查失物。'))
    assert.ok(prompt.includes('结局林舟归还钥匙。'))
    assert.deepEqual(material(prompt).map(item => item.content), draft.artifacts.map(item => item.content))
    return draftReviewFixtureJson(complete)
  }, { sourceBatches: original, steps })
  assert.equal(calls, 1)
  await reviewScriptDraftCompleteness(draft, async () => { throw new Error('validated whole-work review must reuse') },
    { sourceBatches: original, steps })
})


test('one whole-work review expresses more than forty independent issues and semantic grouping retains them all', async () => {
  const draft = candidate()
  const findings = Array.from({ length: 41 }, (_, index) => ({ source_key: 'characters', topic: `人物${index + 1}的独立动机`,
    kind: 'missing_core_setting' as const, quote: `人物${index + 1}动机：尚未确定。`, explanation: `人物${index + 1}的行动缺乏独立动机。`, suggestion: `补齐人物${index + 1}的独立动机。` }))
  draft.artifacts[0].content = findings.map(item => item.quote).join('\n')
  let audits = 0, groups = 0
  await assert.rejects(reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    if (contract?.name === 'script_finding_groups') {
      groups++
      return draftReviewFixtureJson({ groups: findings.map((finding, index) => ({ topic: finding.topic, members: [index] })) })
    }
    audits++
    assert.equal((contract!.schema.properties as any).findings.maxItems, 200)
    assert.deepEqual(material(prompt).map(item => item.content), draft.artifacts.map(item => item.content))
    return draftReviewFixtureJson({ ...complete, findings })
  }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 41)
    assert.equal(new Set(issue.findings.map(finding => finding.issue_id)).size, 41)
    assert.deepEqual(issue.findings.map(finding => finding.quote), findings.map(finding => finding.quote))
    return true
  })
  assert.equal(audits, 1)
  assert.equal(groups, 1)
})
