import { reviewLegacyDraftEvidenceFixture as reviewScriptDraftCompleteness } from './fixtures/script-draft-legacy-evidence.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { reassessDraftReviewEvidence } from '../src/modules/script/script-draft-evidence-reassessment.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

type Finding = { source_key: string; kind: 'missing_core_setting' | 'contradiction' | 'unresolved_setting'; quote: string;
  explanation: string; suggestion: string; severity?: 'blocking' | 'suggestion' }
type Review = { checked_artifacts: string[]; facts: unknown[]; findings: Finding[] }
type EvidenceInput = { issues: Array<Finding & { id: string }>; sources: Array<{ key: string; title: string; units: Array<{ id: number; text: string }> }> }
type Reassessment = { id: string; verdict: 'confirmed' | 'withdrawn' | 'unresolved'; reason: string;
  source_key: string | null; first_unit: number | null; last_unit: number | null }
const locatorMarker = '【待定位证据（资料）】\n'
const reassessmentMarker = '【证据结论复核资料】\n'

function fixture() {
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.outline.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `文档${index}开篇：夜雨覆盖石桥。\n第${index}项规则：林晚使用铜钥匙后失去一天记忆。\n第${index}项回收：第八集归还铜钥匙。` })) }
  const context = { uploaded_script: { content: '完整原稿依据：林晚寻找家人，最后归还铜钥匙。' },
    creator_messages: [{ role: 'user', text: '请保留原稿结局，不要求新增能力或代价设定。' }] }
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = (signal?: AbortSignal) => createGenerationSteps({ checkpoint, signal, save: value => { checkpoint = structuredClone(value) } })
  const clear = (): Review => ({ checked_artifacts: [...scriptStageArtifacts.outline], facts: [], findings: [] })
  const finding = (index = 0, quote = '原文中没有这条证据。'): Finding => ({ source_key: draft.artifacts[index]!.artifact_type,
    kind: 'missing_core_setting', severity: 'blocking', quote, explanation: `第${index}项规则没有解释记忆恢复。`, suggestion: '补充恢复条件。' })
  return { draft, context, steps, clear, finding, checkpoint: () => checkpoint }
}
function data(prompt: string, marker: string): EvidenceInput {
  const start = prompt.lastIndexOf(marker)
  assert.ok(start >= 0, `expected ${marker.trim()} in the request`)
  return JSON.parse(prompt.slice(start + marker.length).split('\n【本轮复核资料结束】')[0]!.split('\n【审读结果分页协议】')[0]!) as EvidenceInput
}
function verdict(id: string, value: 'withdrawn' | 'unresolved', reason = '完整候选稿不支持原先的问题结论。'): Reassessment {
  return { id, verdict: value, reason, source_key: null, first_unit: null, last_unit: null }
}
function confirmed(input: EvidenceInput, id: string, sourceKey?: string): Reassessment {
  const issue = input.issues.find(item => item.id === id)!
  const source = input.sources.find(item => item.key === (sourceKey || issue.source_key))!
  assert.ok(source, 'the confirmed source is a real submitted candidate')
  const unit = source.units.find(item => item.text.includes('规则'))!
  assert.ok(unit, 'the confirmed evidence is a real candidate unit')
  return { id, verdict: 'confirmed', reason: '当前候选原文确有这一缺口。', source_key: source.key, first_unit: unit.id, last_unit: unit.id }
}
function provisional(checkpoint: GenerationCheckpoint): Review[] {
  return Object.entries(checkpoint.steps).filter(([key]) => /review:response:[a-f0-9]{64}$/.test(key)).map(([, value]) => value.value as Review)
}
async function findings(work: Promise<void>) {
  let result: ScriptDraftNeedsResolution | undefined
  await assert.rejects(work, issue => { assert.ok(issue instanceof ScriptDraftNeedsResolution); result = issue; return true })
  return result!.findings
}
function nullRepairs(prompt: string) {
  return { repairs: data(prompt, locatorMarker).issues.map(issue => ({ id: issue.id, first_unit: null, last_unit: null })) }
}
function submitted(prompt: string): Array<{ key: string; artifact_type: string; content: string }> {
  const marker = '待核对草稿原文（资料）：'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).split('\n【本轮候选正文结束】')[0]!)
}
function emptyForPrompt(prompt: string) {
  return { facts: [], checked_artifacts: [...new Set(submitted(prompt).map(item => item.artifact_type))], findings: [] }
}

test('an unsupported finding is independently reassessed and withdrawn after a null locator', async () => {
  const f = fixture(), calls: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding()] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify({ repairs: [{ id: 'findings:0', first_unit: null, last_unit: null }] })
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    assert.ok(prompt.includes(f.context.uploaded_script.content), 'reassessment sees the complete original review context')
    assert.ok(prompt.includes(f.context.creator_messages[0]!.text), 'reassessment sees the actual creator requirement')
    assert.match(prompt, /撤回/)
    const input = data(prompt, reassessmentMarker)
    assert.deepEqual(input.issues.map(item => item.id), ['findings:0'])
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn')] })
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(calls, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_reassessment'])
  assert.equal(provisional(f.checkpoint()).length, 0)
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
})

test('an empty reassessment is corrected into explicit decisions for every original issue', async () => {
  const f = fixture(), originals = [f.finding(), f.finding(1)]
  let attempts = 0
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: originals })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    attempts++
    const schema = contract!.schema.properties as Record<string, { minItems: number; maxItems: number }>
    assert.equal(schema.reassessments!.minItems, originals.length)
    assert.equal(schema.reassessments!.maxItems, originals.length)
    assert.match(prompt, /即使全部原问题均不成立/)
    const input = data(prompt, reassessmentMarker)
    if (attempts === 1) return JSON.stringify({ reassessments: [] })
    const correction = prompt.slice(prompt.indexOf('【一次格式修正】'), prompt.indexOf('【原始任务与资料】'))
    assert.match(correction, /findings:0/)
    assert.match(correction, /findings:1/)
    assert.match(correction, /withdrawn/)
    assert.equal(provisional(f.checkpoint())[0]!.findings.length, originals.length, 'an empty response withdraws nothing')
    return JSON.stringify({ reassessments: input.issues.map(item => verdict(item.id, 'withdrawn')) })
  }, { context: f.context, steps: f.steps() })
  assert.equal(attempts, 2)
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
  const audit = Object.values(f.checkpoint().steps).find(entry =>
    Array.isArray((entry.value as { reassessments?: unknown[] })?.reassessments))!.value as { reassessments: Reassessment[] }
  assert.deepEqual(audit.reassessments.map(item => [item.id, item.verdict]), [['findings:0', 'withdrawn'], ['findings:1', 'withdrawn']])
})

test('repeated empty reassessments preserve pending issues and replay the exhausted correction without dispatch', async () => {
  const f = fixture(), original = f.finding()
  let attempts = 0
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [original] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    attempts++
    return JSON.stringify({ reassessments: [] })
  }, { context: f.context, steps: f.steps() }), /script_draft_evidence_reassessment/)
  assert.equal(attempts, 2, 'empty output gets only the existing bounded format correction')
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
  assert.deepEqual(provisional(f.checkpoint())[0]!.findings, [original])
  assert.ok(Object.keys(f.checkpoint().steps).some(id => id.endsWith(':evidence:semantic-pending')))
  const before = structuredClone(f.checkpoint()), resumed: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    resumed.push(contract!.name)
    assert.fail('an already consumed correction cannot be purchased again')
  }, { context: f.context, steps: f.steps() }), /script_draft_evidence_reassessment/)
  assert.deepEqual(resumed, [])
  assert.deepEqual(f.checkpoint(), before)
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
})

test('a null locator triggers reassessment of every finding, including exact quotations with unsupported conclusions', async () => {
  const f = fixture(), exact = f.finding(0, '第0项规则：林晚使用铜钥匙后失去一天记忆。'), calls: string[] = []
  const fabricated = f.finding(1)
  exact.explanation = '没有提供其他阶段的场景设计，所以当前故事大纲不完整。'
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [exact, fabricated] })
    if (contract!.name === 'script_draft_evidence_repair') {
      assert.deepEqual(data(prompt, locatorMarker).issues.map(item => item.id), ['findings:1'])
      return JSON.stringify(nullRepairs(prompt))
    }
    const input = data(prompt, reassessmentMarker)
    assert.deepEqual(input.issues.map(item => item.id), ['findings:0', 'findings:1'])
    assert.deepEqual(input.issues.map(({ id: _id, ...item }) => item), [exact, fabricated])
    return JSON.stringify({ reassessments: input.issues.map(item => verdict(item.id, 'withdrawn', '原问题把未要求的下一阶段资料当作本次义务。')) })
  }, { context: f.context, steps: f.steps() })
  assert.equal(calls.filter(name => name === 'script_draft_evidence_reassessment').length, 1)
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
})

test('a scoped review can withdraw a false missing sibling-document finding without expanding its submitted sources', async () => {
  const f = fixture(), calls: string[] = []
  let reassessed = false
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') {
      const source = submitted(prompt)
      if (source.some(item => item.key === 'world') && !source.some(item => item.key === 'outline')) {
        return JSON.stringify({ ...emptyForPrompt(prompt), findings: [{ ...f.finding(2),
          explanation: '没有提供故事大纲和分集大纲，无法完成背景规则检查。' }] })
      }
      return JSON.stringify(emptyForPrompt(prompt))
    }
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    reassessed = true
    assert.match(prompt, /缺少未送审文档不是问题/)
    const input = data(prompt, reassessmentMarker)
    assert.deepEqual(new Set(input.sources.map(source => source.key)), new Set(['world', 'constraints']))
    return JSON.stringify({ reassessments: input.issues.map(issue => verdict(issue.id, 'withdrawn', '其他候选文档由独立任务检查，并非缺少交付。')) })
  }, { context: f.context, steps: f.steps(), review_scope: 'tasks' })
  assert.ok(reassessed)
  assert.ok(f.checkpoint().steps['review:task:consistency:result'], 'global consistency still completes after scoped reassessment')
  assert.equal(calls.filter(name => name === 'script_draft_completeness').length, 4)
})

test('reassessment can correct the source of a real finding and reconstruct candidate evidence from selected units', async () => {
  const f = fixture(), original = f.finding(), target = f.draft.artifacts[1]!
  let located = ''
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [original] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    const input = data(prompt, reassessmentMarker), decision = confirmed(input, 'findings:0', target.artifact_type)
    located = input.sources.find(source => source.key === target.artifact_type)!.units.find(unit => unit.id === decision.first_unit)!.text.trim()
    return JSON.stringify({ reassessments: [decision] })
  }, { context: f.context, steps: f.steps() }))
  assert.equal(result.length, 1, 'a confirmed real problem still blocks the candidate')
  assert.equal(result[0]!.source_key, target.artifact_type)
  assert.equal(result[0]!.quote, located)
  assert.ok(target.content.includes(result[0]!.quote))
  assert.equal(result[0]!.explanation, original.explanation)
  assert.equal(result[0]!.suggestion, original.suggestion)
})

test('an independently confirmed exact quote retains its original bytes when another finding is withdrawn', async () => {
  const f = fixture(), exact = f.finding(0, '林晚使用铜钥匙后失去一天记忆'), invalid = f.finding(1)
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [exact, invalid] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    const input = data(prompt, reassessmentMarker)
    return JSON.stringify({ reassessments: [confirmed(input, 'findings:0'), verdict('findings:1', 'withdrawn')] })
  }, { context: f.context, steps: f.steps() }))
  assert.equal(result.length, 1)
  assert.equal(result[0]!.quote, exact.quote, 'confirmation does not expand an already exact quote to the whole selected unit')
  assert.equal(result[0]!.explanation, exact.explanation)
})

test('mixed reassessment retains corrected findings and withdrawals while continuing the pending semantic reassessment', async () => {
  const f = fixture(), originals = [f.finding(0, '第0项规则：林晚使用铜钥匙后失去一天记忆。'), f.finding(1), f.finding(2), f.finding(3)]
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: originals })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    const input = data(prompt, reassessmentMarker)
    return JSON.stringify({ reassessments: [confirmed(input, 'findings:0'), verdict('findings:1', 'withdrawn'),
      confirmed(input, 'findings:2'), verdict('findings:3', 'unresolved', '无法判断剩余问题，不能确认或撤回。')] })
  }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
  const pending = provisional(f.checkpoint())
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0]!.findings.map(item => item.explanation), [originals[0]!.explanation, originals[2]!.explanation, originals[3]!.explanation])
  assert.ok(f.draft.artifacts[2]!.content.includes(pending[0]!.findings[1]!.quote), 'the corrected quote survives partial failure')
  assert.equal(pending[0]!.findings[0]!.quote, originals[0]!.quote)
  const resumed: string[] = []
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push(contract!.name)
    assert.equal(contract!.name, 'script_draft_evidence_reassessment', 'completed semantic review is reused')
    const input = data(prompt, reassessmentMarker)
    assert.deepEqual(input.issues.map(item => item.explanation), [originals[3]!.explanation], 'only the unresolved issue returns after earlier withdrawals shift its index')
    assert.deepEqual(input.issues.map(item => item.id), ['findings:2'])
    return JSON.stringify({ reassessments: input.issues.map(item => verdict(item.id, 'withdrawn')) })
  }, { context: f.context, steps: f.steps() }))
  assert.deepEqual(resumed, ['script_draft_evidence_reassessment'])
  assert.equal(result.length, 2)
  assert.deepEqual(result.map(item => item.explanation), [originals[0]!.explanation, originals[2]!.explanation])
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, pending[0]!.findings.slice(0, 2),
    'confirmed semantic fields and exact quotations never change on continuation')
})

test('confirmed decisions stay retained when continuing the remaining semantic issue is interrupted', async t => {
  for (const failure of ['provider', 'cancelled'] as const) await t.test(failure, async () => {
    const f = fixture(), originals = [f.finding(), f.finding(1)], stopped = Object.assign(new TextProviderError('pending reassessment interrupted', false), { delivery: 'not_sent' as const })
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: originals })
      if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
      const input = data(prompt, reassessmentMarker)
      return JSON.stringify({ reassessments: [confirmed(input, 'findings:0'), verdict('findings:1', 'unresolved')] })
    }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
    const retained = structuredClone(provisional(f.checkpoint())[0]!.findings[0]), controller = new AbortController()
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      assert.deepEqual(data(prompt, reassessmentMarker).issues.map(item => item.explanation), [originals[1]!.explanation])
      if (failure === 'provider') throw stopped
      controller.abort(new DOMException('cancelled pending reassessment', 'AbortError'))
      return JSON.stringify({ reassessments: [verdict('findings:1', 'withdrawn')] })
    }, { context: f.context, steps: f.steps(controller.signal), signal: controller.signal }),
    issue => failure === 'provider' ? issue === stopped : (issue as Error).name === 'AbortError')
    const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      const input = data(prompt, reassessmentMarker)
      assert.deepEqual(input.issues.map(item => item.explanation), [originals[1]!.explanation], 'interruption cannot reopen a confirmed decision')
      return JSON.stringify({ reassessments: input.issues.map(item => verdict(item.id, 'withdrawn')) })
    }, { context: f.context, steps: f.steps() }))
    assert.equal(result.length, 1)
    assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [retained])
  })
})

test('legacy or damaged semantic pending state cannot silently skip retained findings', async t => {
  const variants: Record<string, (value: unknown) => unknown> = {
    legacy: () => true,
    'wrong report': value => ({ ...value as object, report_hash: '0'.repeat(64) }),
    'missing issue': value => ({ ...value as object, ids: ['findings:99'] }),
    'duplicate issue': value => ({ ...value as object, ids: ['findings:1', 'findings:1'] }),
    'empty issue set': value => ({ ...value as object, ids: [] }),
  }
  for (const [label, corrupt] of Object.entries(variants)) await t.test(label, async () => {
    const f = fixture()
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding(), f.finding(1)] })
      if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
      return JSON.stringify({ reassessments: [confirmed(data(prompt, reassessmentMarker), 'findings:0'), verdict('findings:1', 'unresolved')] })
    }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
    const saved = Object.entries(f.checkpoint().steps).find(([id]) => id.endsWith(':evidence:semantic-pending'))![1]
    saved.value = corrupt(saved.value)
    const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      const input = data(prompt, reassessmentMarker)
      assert.deepEqual(input.issues.map(item => item.id), ['findings:0', 'findings:1'], 'unknown prior completion state requires a complete reassessment')
      return JSON.stringify({ reassessments: [confirmed(input, 'findings:0'), verdict('findings:1', 'withdrawn')] })
    }, { context: f.context, steps: f.steps() }))
    assert.equal(result.length, 1)
  })
})

test('a later reassessment appends its audit without overwriting the reason for an earlier withdrawal', async () => {
  const f = fixture(), withdrawnReason = '第一项误把下一阶段资料当作当前交付，撤回该结论。'
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding(), f.finding(1)] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn', withdrawnReason),
      verdict('findings:1', 'unresolved', '第二项仍需判断。')] })
  }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
  const auditEntries = () => Object.entries(f.checkpoint().steps).filter(([key, entry]) =>
    key.includes(':evidence:reassessment') && Array.isArray((entry.value as { reassessments?: unknown[] })?.reassessments))
  const before = structuredClone(auditEntries())
  assert.equal(before.length, 1)
  assert.ok(JSON.stringify(before[0]![1].value).includes(withdrawnReason))
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    return JSON.stringify({ reassessments: data(prompt, reassessmentMarker).issues.map(item => verdict(item.id, 'withdrawn', '进一步核对第二项也无依据。')) })
  }, { context: f.context, steps: f.steps() })
  const after = auditEntries()
  assert.equal(after.length, 2, 'different reassessments retain distinct audit records')
  assert.deepEqual(after.find(([key]) => key === before[0]![0]), before[0], 'original report and withdrawal reason remain intact')
})

test('evidence reassessment preserves the answer policy selected after pure reasoning exhaustion', async () => {
  const f = fixture(), calls: Array<[string, unknown]> = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push([contract!.name, contract!.request_policy])
    if (contract!.name === 'script_draft_completeness') {
      if (contract!.request_policy === 'script_review') throw new TextOutputLimitError('', 'max_output_tokens', {
        input_tokens: 1000, output_tokens: 8000, reasoning_tokens: 8000,
      })
      assert.equal(contract!.request_policy, 'script_review_answer')
      return JSON.stringify({ ...f.clear(), findings: [f.finding()] })
    }
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    assert.equal(contract!.request_policy, 'script_review_answer', 'semantic recovery does not re-enable the exhausted reasoning strategy')
    assert.ok(prompt.includes(f.context.uploaded_script.content), 'answer reassessment retains the full original context')
    assert.ok(prompt.includes(f.context.creator_messages[0]!.text))
    const evidenceInput = data(prompt, reassessmentMarker)
    for (const artifact of f.draft.artifacts) assert.equal(evidenceInput.sources.find(source => source.key === artifact.artifact_type)!.units.map(unit => unit.text).join(''), artifact.content,
      'every complete candidate remains available once through the numbered evidence units')
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn')] })
  }, { context: f.context, steps: f.steps(), answerModeSupported: true })
  assert.deepEqual(calls, [['script_draft_completeness', 'script_review'], ['script_draft_completeness', 'script_review_answer'],
    ['script_draft_evidence_repair', 'script_evidence'], ['script_draft_evidence_reassessment', 'script_review_answer']])
})

test('an unsupported optional suggestion may be withdrawn without becoming a trusted suggestion or blocking a usable draft', async () => {
  const f = fixture(), suggestions: unknown[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [{ ...f.finding(), severity: 'suggestion' }] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn', '该可选深化建议引用了不存在的情节，没有候选正文依据。')] })
  }, { context: f.context, steps: f.steps(), onSuggestions: value => suggestions.push(...value) })
  assert.deepEqual(suggestions, [])
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
})

test('repeated unresolved reassessment remains bounded and never turns unfinished evidence into a passed audit', async () => {
  const f = fixture(), calls: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding()] })
      if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      return JSON.stringify({ reassessments: [verdict('findings:0', 'unresolved', '仍无法判断该问题是否成立。')] })
    }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint())[0]!.findings.length, 1)
  }
  assert.deepEqual(calls, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_reassessment'])
})

test('a semantically unresolved exact suggestion cannot pass on continuation just because its quotation already matches', async () => {
  const f = fixture(), fabricated = f.finding(), exact = { ...f.finding(1, '第1项规则：林晚使用铜钥匙后失去一天记忆。'), severity: 'suggestion' as const }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [fabricated, exact] })
    if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn'),
      verdict('findings:1', 'unresolved', '引文虽然准确，但该建议是否符合作者要求尚不能判断。')] })
  }, { context: f.context, steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
  assert.equal(provisional(f.checkpoint())[0]!.findings.length, 1)
  assert.equal(provisional(f.checkpoint())[0]!.findings[0]!.quote, exact.quote)
  const resumed: string[] = [], suggestions: unknown[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push(contract!.name)
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    const input = data(prompt, reassessmentMarker)
    assert.deepEqual(input.issues.map(item => item.explanation), [exact.explanation])
    return JSON.stringify({ reassessments: input.issues.map(item => verdict(item.id, 'unresolved', '仍未确定建议是否成立。')) })
  }, { context: f.context, steps: f.steps(), onSuggestions: value => suggestions.push(...value) }),
  issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
  assert.deepEqual(resumed, ['script_draft_evidence_reassessment'])
  assert.deepEqual(suggestions, [])
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
})

test('failed or cancelled reassessment stays semantically pending and resumes directly without another locator', async t => {
  for (const failure of ['provider', 'cancelled'] as const) await t.test(failure, async () => {
    const f = fixture(), controller = new AbortController(), stopped = Object.assign(new TextProviderError('reassessment interrupted', false), { delivery: 'not_sent' as const })
    const exact = f.finding(1, '第1项规则：林晚使用铜钥匙后失去一天记忆。')
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding(), exact] })
      if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      if (failure === 'provider') throw stopped
      controller.abort(new DOMException('cancelled while reassessing evidence', 'AbortError'))
      return JSON.stringify({ reassessments: data(prompt, reassessmentMarker).issues.map(item => verdict(item.id, 'withdrawn')) })
    }, { context: f.context, steps: f.steps(controller.signal), signal: controller.signal }),
    issue => failure === 'provider' ? issue === stopped : (issue as Error).name === 'AbortError')
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint())[0]!.findings.length, 2, 'interruption does not apply an unfinished reassessment')
    const resumed: string[] = []
    const resume = reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      resumed.push(contract!.name)
      assert.equal(failure, 'provider', 'completed cancelled response replays locally')
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      const input = data(prompt, reassessmentMarker)
      return JSON.stringify({ reassessments: input.issues.map(item => item.explanation === exact.explanation
        ? confirmed(input, item.id) : verdict(item.id, 'withdrawn')) })
    }, { context: f.context, steps: f.steps() })
    if (failure === 'provider') {
      const result = await findings(resume)
      assert.deepEqual(resumed, ['script_draft_evidence_reassessment'])
      assert.equal(result.length, 1)
      assert.equal(result[0]!.quote, exact.quote)
    } else {
      await resume
      assert.deepEqual(resumed, [])
      assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
    }
  })
})

test('a stalled paged null locator uses the same independent reassessment path', async () => {
  const f = fixture(), calls: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding()] })
    if (contract!.name === 'script_draft_evidence_repair') throw new TextOutputLimitError('', 'length')
    if (contract!.name === 'script_draft_evidence_repair_page') return JSON.stringify({
      items: data(prompt, locatorMarker).issues.map(issue => ({ id: issue.id, first_unit: null, last_unit: null })), complete: true,
    })
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn')] })
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(calls, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair_page',
    'script_draft_evidence_reassessment'])
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings, [])
})

test('invalid reassessment verdicts, identities and coordinates fail closed without losing the provisional assessment', async t => {
  const invalid: Record<string, (input: EvidenceInput) => unknown[]> = {
    'unknown verdict': () => [{ ...verdict('findings:0', 'withdrawn'), verdict: 'ignore' }],
    'missing finding': () => [],
    'unknown finding': () => [verdict('findings:99', 'withdrawn')],
    'duplicate finding': () => [verdict('findings:0', 'withdrawn'), verdict('findings:0', 'withdrawn')],
    'blank reason': () => [{ ...verdict('findings:0', 'withdrawn'), reason: '   ' }],
    'withdrawal with coordinates': input => [{ ...confirmed(input, 'findings:0'), verdict: 'withdrawn' }],
    'unresolved with source': () => [{ ...verdict('findings:0', 'unresolved'), source_key: 'outline' }],
    'confirmed without coordinates': () => [{ ...verdict('findings:0', 'withdrawn'), verdict: 'confirmed' }],
    'unknown candidate source': input => [{ ...confirmed(input, 'findings:0'), source_key: 'uploaded_script' }],
    'out of bounds range': input => [{ ...confirmed(input, 'findings:0'), last_unit: 100_000 }],
    'reversed range': input => [{ ...confirmed(input, 'findings:0'), first_unit: 100_000, last_unit: 0 }],
    'mixed null range': input => [{ ...confirmed(input, 'findings:0'), last_unit: null }],
  }
  for (const [label, response] of Object.entries(invalid)) await t.test(label, async () => {
    const f = fixture(), calls: string[] = []
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'script_draft_completeness') return JSON.stringify({ ...f.clear(), findings: [f.finding()] })
      if (contract!.name === 'script_draft_evidence_repair') return JSON.stringify(nullRepairs(prompt))
      assert.equal(contract!.name, 'script_draft_evidence_reassessment')
      return JSON.stringify({ reassessments: response(data(prompt, reassessmentMarker)) })
    }, { context: f.context, steps: f.steps() }), issue => !(issue instanceof ScriptDraftNeedsResolution))
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint())[0]!.findings.length, 1)
    const reassessmentCalls = calls.filter(name => name === 'script_draft_evidence_reassessment').length
    assert.ok(reassessmentCalls >= 1 && reassessmentCalls <= 2,
      'at most one structured format correction is permitted')
    assert.equal(calls.filter(name => name === 'script_draft_completeness').length, 1)
  })
})

test('reassessment sends complete candidates once, preserves the surrounding task and binds the audit to the original prompt', async () => {
  const source = { key: 'outline', artifact_type: 'outline', title: '完整大纲',
    content: 'CANDIDATE_ONCE_SENTINEL。  \r\n\r\n' + '逐字正文'.repeat(400) + '🚆结尾。\n  ' }
  const sources = [source], context = { uploaded_script: { content: '完整原稿保留结局，不改写。' },
    creator_messages: [{ role: 'user', text: '只复核旧结论，不新增能力或代价。' }], saved_documents: [{ title: '历史原文', content: '只读历史🚆。' }] }
  const head = '固定合同：只核对本轮完整大纲，不要求补齐其他栏目。\n'
  const material = '待核对草稿原文（资料）：' + JSON.stringify(sources) + '\n【本轮候选正文结束】'
  const tail = '\n既有事实与创作要求（资料）：' + JSON.stringify(context)
  const originalPrompt = head + material + tail
  const finding = { source_key: 'outline', quote: '不存在的引文。', explanation: '旧结论', suggestion: '原建议' }
  const report = { findings: [finding], facts: [] }, steps = createGenerationSteps(), decisions = { reassessments: [verdict('findings:0', 'withdrawn')] }
  let calls = 0
  const result = await reassessDraftReviewEvidence(originalPrompt, report, sources, async (prompt, contract) => {
    calls++; assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    const input = data(prompt, reassessmentMarker)
    assert.equal(input.sources[0]!.units.map(unit => unit.text).join(''), source.content)
    assert.equal(prompt.split('CANDIDATE_ONCE_SENTINEL').length - 1, 1)
    assert.ok(prompt.includes(head))
    assert.ok(prompt.includes(tail), 'original manuscript, creator requirements and history retain every byte')
    const candidateStart = prompt.lastIndexOf('待核对草稿原文（资料）：') + '待核对草稿原文（资料）：'.length
    const references = JSON.parse(prompt.slice(candidateStart).split('\n【本轮候选正文结束】')[0]!)
    assert.equal(references[0].key, source.key)
    assert.equal(references[0].artifact_type, source.artifact_type)
    assert.equal(references[0].title, source.title)
    assert.equal(references[0].content_reference.source_key, source.key)
    assert.ok(!Object.hasOwn(references[0], 'content'))
    return JSON.stringify(decisions)
  }, { id: 'dedup-audit', steps })
  assert.equal(calls, 1); assert.deepEqual(result.result.findings, [])
  const audit = Object.entries(steps.checkpoint.steps).find(([id]) => id.startsWith('dedup-audit:'))!
  assert.ok(audit)
  const normalizedDecisions = (audit[1].value as { reassessments: Reassessment[] }).reassessments
  const auditInput = { version: 1, prompt: originalPrompt, issues: [{ id: 'findings:0', ...finding }], reassessments: normalizedDecisions }
  const hash = createHash('sha256').update(JSON.stringify(auditInput)).digest('hex')
  assert.equal(audit[0], `dedup-audit:${hash}`)
  assert.equal(audit[1].input_hash, hash)
  assert.equal(report.findings[0]!.quote, '不存在的引文。', 'the original report and full audit identity remain immutable')
})

test('unrecognized, ambiguous or nonmatching original candidate envelopes are preserved without heuristic removal', async t => {
  const sources = [{ key: 'outline', title: '当前候选', content: '完整正文🚆。\r\n尾声。' }]
  const material = '待核对草稿原文（资料）：' + JSON.stringify(sources) + '\n【本轮候选正文结束】'
  for (const [name, originalPrompt] of [
    ['unrecognized', '另一种任务格式：' + JSON.stringify(sources)],
    ['ambiguous', material + '\n保留背景\n' + material],
    ['nonmatching', material.replace('完整正文', '不同正文')],
  ]) await t.test(name!, async () => {
    let calls = 0
    await reassessDraftReviewEvidence(originalPrompt!, { findings: [{ source_key: 'outline', quote: '错误引文' }], facts: [] }, sources,
      async prompt => {
        calls++; assert.ok(prompt.includes(originalPrompt!), 'uncertain envelopes keep the complete original task')
        const input = data(prompt, reassessmentMarker)
        assert.equal(input.sources[0]!.units.map(unit => unit.text).join(''), sources[0]!.content)
        return JSON.stringify({ reassessments: [verdict('findings:0', 'withdrawn')] })
      }, { id: 'dedup-fallback' })
    assert.equal(calls, 1)
  })
})
