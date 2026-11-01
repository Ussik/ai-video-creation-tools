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
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
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
    return JSON.stringify({ ...complete, findings: [
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
  for (const invalid of ['source', 'quote', 'coverage', 'facts'] as const) await t.test(invalid, async () => {
    const steps = createGenerationSteps(); let calls = 0
    await assert.rejects(reviewScriptDraftCompleteness(candidate(), async (_prompt, contract) => {
      calls++
      if (contract?.name === 'script_draft_evidence_repair') return JSON.stringify({ repairs: [{
        id: invalid === 'facts' ? 'facts:0' : 'findings:0', first_unit: null, last_unit: null }] })
      return JSON.stringify({ checked_artifacts: invalid === 'coverage' ? ['characters'] : complete.checked_artifacts,
        findings: invalid === 'facts' ? [] : [{ source_key: invalid === 'source' ? 'uploaded_script' : 'characters',
          quote: invalid === 'quote' ? '林舟是船夫。' : '林舟是记者。', kind: 'contradiction', explanation: '身份冲突', suggestion: '保留原稿身份' }],
        facts: invalid === 'facts' ? [{ source_key: 'characters', quote: '伪造证据', meaning: '错误引用' }] : [] })
    }, { context: { uploaded_script: { content: '林舟是船夫。' } }, steps }), /模型结果不符合 script_draft_completeness 契约|证据尚未定位到候选稿原文/)
    assert.equal(calls, 2, 'one bounded contract correction, then stop')
    assert.equal(steps.checkpoint.steps['review:whole'], undefined)
    assert.equal(Object.keys(steps.checkpoint.steps).some(key => key.startsWith('review:response:')), invalid === 'quote' || invalid === 'facts')
  })
})

test('a rewritten quote is located against the exact original without another semantic review', async () => {
  let calls = 0
  await reviewScriptDraftCompleteness(candidate(), async (prompt, contract) => {
    calls++
    if (calls === 2) {
      assert.equal(contract?.name, 'script_draft_evidence_repair')
      const marker = '【待定位证据（资料）】\n'
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
      assert.equal(input.issues[0].id, 'facts:0')
      const unit = input.sources[0].units.find((unit: { text: string }) => unit.text === '林舟是记者。')
      assert.ok(unit)
      return JSON.stringify({ repairs: [{ id: 'facts:0', first_unit: unit.id, last_unit: unit.id }] })
    }
    return JSON.stringify({ ...complete, facts: [{ source_key: 'characters', quote: calls === 1 ? '林舟是一名记者。' : '林舟是记者。', meaning: '人物身份' }] })
  })
  assert.equal(calls, 2)
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
    return JSON.stringify(complete)
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
      return JSON.stringify({ groups: findings.map((finding, index) => ({ topic: finding.topic, members: [index] })) })
    }
    audits++
    assert.equal((contract!.schema.properties as any).findings.maxItems, 200)
    assert.deepEqual(material(prompt).map(item => item.content), draft.artifacts.map(item => item.content))
    return JSON.stringify({ ...complete, findings })
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
