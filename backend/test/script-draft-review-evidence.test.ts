import { draftReviewFixtureJson } from './fixtures/script-draft-completeness.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { beginTextRequest, createScriptRequestUsage, TextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

type Finding = { source_key: string; kind: 'missing_core_setting' | 'contradiction' | 'unresolved_setting'; quote: string;
  explanation: string; suggestion: string; topic?: string }
type Fact = { source_key: string; quote: string; meaning: string }
type Review = { checked_artifacts: string[]; facts: Fact[]; findings: Finding[] }
type EvidenceIssue = { id: string; source_key: string; quote: string; explanation?: string; suggestion?: string; meaning?: string }
type EvidenceSource = { key: string; title: string; units: Array<{ id: number; text: string }> }
type EvidenceInput = { issues: EvidenceIssue[]; sources: EvidenceSource[] }
type Repair = { id: string; first_unit: number | null; last_unit: number | null }
const marker = '【待定位证据（资料）】\n'

function fixture() {
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0,
    artifacts: scriptStageArtifacts.outline.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `文档${index}开篇：夜雨覆盖石桥。\n第${index}项规则：林晚使用铜钥匙后失去一天记忆。\n第${index}项回收：第八集归还铜钥匙。\n文档${index}收束：角色选择守护家人。` })), scenes: [] }
  const context = { source_version: 'v1', uploaded_script: { content: '局部定位不得重复发送的完整原稿。林晚最终归还铜钥匙。' },
    saved_documents: [{ title: '既有背景', content: '局部定位不得重复发送的既有文档。' }] }
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = (signal?: AbortSignal) => createGenerationSteps({ checkpoint, signal, save: value => { checkpoint = structuredClone(value) } })
  const clear = (): Review => ({ checked_artifacts: [...scriptStageArtifacts.outline], findings: [], facts: [] })
  const finding = (index: number, quote?: string): Finding => ({ source_key: draft.artifacts[index]!.artifact_type,
    kind: 'missing_core_setting', quote: quote ?? `第${index}项规则：林晚使用铜钥匙后失去一天记忆。`,
    explanation: `第${index}项规则尚缺恢复边界。`, suggestion: `明确第${index}项规则失去的记忆不可恢复。` })
  return { draft, context, steps, clear, finding, checkpoint: () => checkpoint }
}
function evidence(prompt: string, evidenceMarker = marker): EvidenceInput {
  const start = prompt.lastIndexOf(evidenceMarker)
  assert.ok(start >= 0, 'the bounded locator request supplies the explicit evidence data marker')
  return JSON.parse(prompt.slice(start + evidenceMarker.length).split('\n【本轮复核资料结束】')[0]!.split('\n【审读结果分页协议】')[0]!) as EvidenceInput
}
function select(input: EvidenceInput, id: string, text?: string): Repair {
  const issue = input.issues.find(issue => issue.id === id)
  assert.ok(issue, `locator input contains ${id}`)
  const source = input.sources.find(source => source.key === issue.source_key)
  assert.ok(source, `locator input contains the source for ${id}`)
  const unit = source.units.find(unit => text ? unit.text.includes(text) : unit.text.trim().length > 0)
  assert.ok(unit, `the requested original evidence is addressable for ${id}`)
  return { id, first_unit: unit.id, last_unit: unit.id }
}
function response(input: EvidenceInput) {
  return draftReviewFixtureJson({ repairs: input.issues.map(issue => select(input, issue.id)) })
}
function reassessmentResponse(prompt: string, unresolved?: string[]) {
  const input = evidence(prompt, '【证据结论复核资料】\n')
  return draftReviewFixtureJson({ reassessments: input.issues.map(issue => unresolved?.includes(issue.id)
    ? { id: issue.id, verdict: 'unresolved', reason: '仍缺少可确认该问题的证据。', source_key: null, first_unit: null, last_unit: null }
    : { ...select(input, issue.id), verdict: 'confirmed', reason: '候选正文支持原问题。', source_key: issue.source_key }) })
}
function provisional(checkpoint: GenerationCheckpoint) {
  return Object.entries(checkpoint.steps).filter(([key]) => /^review:response:[a-f0-9]{64}$/.test(key))
}
async function findings(work: Promise<void>) {
  let result: ScriptDraftNeedsResolution | undefined
  await assert.rejects(work, issue => { assert.ok(issue instanceof ScriptDraftNeedsResolution); result = issue; return true })
  return result!.findings
}
function withoutId(value: Record<string, unknown>) {
  const { id: _id, ...rest } = value
  return rest
}

test('a completed review with only optional summary facts passes without locating fabricated quotations', async () => {
  const f = fixture(), names: string[] = []
  const report = { ...f.clear(), facts: [
    { source_key: 'outline', quote: '道具清单：必要道具名称、用途及其人物关系一致。', meaning: '模型额外生成的概括性摘要。' },
    { source_key: 'synopsis', quote: '该栏目包含全部道具在全剧时间线中的结构化追踪记录。', meaning: '模型额外生成的非逐字结论。' },
    { source_key: 'uploaded_script', quote: '林晚最终归还铜钥匙。', meaning: '原稿证据不是本候选文档的事实引文。' },
  ] }
  await reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    names.push(contract!.name)
    assert.equal(contract!.name, 'script_draft_completeness')
    return draftReviewFixtureJson(report)
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(names, ['script_draft_completeness'])
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).facts, [])
  assert.equal(provisional(f.checkpoint()).length, 0)
})

test('an existing unresolved response containing only summary facts resumes without another model request', async () => {
  const f = fixture()
  let semanticPrompt = ''
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    assert.equal(contract!.name, 'script_draft_completeness')
    semanticPrompt = prompt.slice(prompt.lastIndexOf('【原始任务与资料】\n') + '【原始任务与资料】\n'.length)
    return draftReviewFixtureJson(f.clear())
  }, { context: f.context })
  const id = `review:response:${createHash('sha256').update(semanticPrompt).digest('hex')}`
  const checkpoint: GenerationCheckpoint = { steps: { [id]: {
    input_hash: createHash('sha256').update(JSON.stringify({ version: 1, prompt: semanticPrompt })).digest('hex'),
    value: { ...f.clear(), facts: [
      { source_key: 'outline', quote: '候选文档的规则和结局均完整。', meaning: '旧版本保留的非逐字摘要。' },
      { source_key: 'uploaded_script', quote: '林晚最终归还铜钥匙。', meaning: '旧版本额外生成的事实摘要。' },
    ] },
  } } }
  const steps = createGenerationSteps({ checkpoint })
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('the completed retained assessment is reused'),
    { context: f.context, steps })
  assert.equal(steps.checkpoint.steps[id], undefined)
  assert.deepEqual((steps.checkpoint.steps['review:whole']!.value as Review).facts, [])
})

test('one inaccurate quote among six findings uses one whole review and one local locator, preserving all semantic fields', async () => {
  const f = fixture(), names: string[] = [], original = Array.from({ length: 6 }, (_, index) => f.finding(index))
  original[5] = { ...original[5]!, topic: '铜钥匙记忆恢复边界', quote: '第5项规则：使用铜钥匙会暂时遗忘。' }
  let located = ''
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') {
      assert.ok(prompt.includes(f.context.uploaded_script.content), 'the independent whole review still receives the complete manuscript')
      return draftReviewFixtureJson({ ...f.clear(), findings: original })
    }
    assert.equal(contract!.name, 'script_draft_evidence_repair')
    const input = evidence(prompt)
    assert.deepEqual(input.issues.map(issue => issue.id), ['findings:5'])
    assert.equal(input.issues[0]!.source_key, original[5]!.source_key)
    assert.equal(input.issues[0]!.explanation, original[5]!.explanation)
    assert.equal(input.issues[0]!.suggestion, original[5]!.suggestion)
    assert.deepEqual(input.sources.map(source => source.key), ['foreshadowing'])
    assert.ok(!prompt.includes(f.context.uploaded_script.content), 'local evidence lookup does not replay the full independent review context')
    const repair = select(input, 'findings:5', '第5项规则')
    located = input.sources[0]!.units.find(unit => unit.id === repair.first_unit)!.text.trim()
    return draftReviewFixtureJson({ repairs: [repair] })
  }, { context: f.context, steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair'])
  assert.deepEqual(result.map(item => withoutId(item)), original.map((item, index) => index === 5 ? { ...item, quote: located } : item))
  assert.ok(f.draft.artifacts[5]!.content.includes(result[5]!.quote))
  assert.equal(provisional(f.checkpoint()).length, 0, 'successful strict evidence validation clears the provisional response')
  assert.ok(f.checkpoint().steps['review:whole'])
})

test('several invalid findings are located in one batch while only verified optional facts are retained', async () => {
  const f = fixture(), names: string[] = []
  const original = [{ ...f.finding(0), quote: '错误的第一段引用。' },
    { ...f.finding(0), quote: '错误的第二段引用。', explanation: '第八集回收集位与既有决定不一致。' }]
  const facts: Fact[] = [{ source_key: 'outline', quote: '第0项规则：林晚使用铜钥匙后失去一天记忆。', meaning: '记忆代价既有事实保持不变。' },
    { source_key: 'outline', quote: '改写的事实引文。', meaning: '未经核实的可选摘要。' }]
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: original, facts })
    const input = evidence(prompt)
    assert.deepEqual(new Set(input.issues.map(issue => issue.id)), new Set(['findings:0', 'findings:1']))
    assert.equal(input.sources.length, 1)
    assert.equal(input.sources[0]!.key, 'outline')
    const repairs = input.issues.map(issue => select(input, issue.id, issue.id === 'findings:1' ? '第0项回收' : '第0项规则'))
    return draftReviewFixtureJson({ repairs })
  }, { context: f.context, steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair'])
  assert.equal(result.length, 2)
  assert.equal(result[0]!.explanation, original[0]!.explanation)
  assert.equal(result[1]!.explanation, original[1]!.explanation)
  const saved = f.checkpoint().steps['review:whole']!.value as Review
  assert.deepEqual(saved.facts, [facts[0]])
  assert.ok(saved.findings[1]!.quote.includes('第0项回收'), 'facts and findings with index zero cannot overwrite each other')
})

test('a contiguous selected range is reconstructed from the exact original source with internal newlines and punctuation', async () => {
  const f = fixture()
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '拼接改写的证据。')] })
    const input = evidence(prompt), source = input.sources[0]!
    return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: source.units[0]!.id, last_unit: source.units.at(-1)!.id }] })
  }))
  assert.equal(result[0]!.quote, f.draft.artifacts[0]!.content.trim())
})

test('structural, coverage and unknown-source failures keep the strict whole-response contract and do not trigger quote lookup', async t => {
  for (const invalid of ['coverage', 'unknown source', 'invalid kind'] as const) await t.test(invalid, async () => {
    const f = fixture(), names: string[] = []
    const value: Record<string, unknown> = { ...f.clear(), findings: [f.finding(0, '错误引文。')] }
    if (invalid === 'coverage') value.checked_artifacts = ['outline']
    if (invalid === 'unknown source') (value.findings as Finding[])[0]!.source_key = 'uploaded_script'
    if (invalid === 'invalid kind') (value.findings as Array<Record<string, unknown>>)[0]!.kind = 'invented'
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
      names.push(contract!.name); return draftReviewFixtureJson(value)
    }, { steps: f.steps() }))
    assert.deepEqual(names, ['script_draft_completeness', 'script_draft_completeness'])
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint()).length, 0)
  })
})

test('malformed locator identities and ranges fail closed after at most one local format correction', async t => {
  const invalid: Record<string, (input: EvidenceInput) => unknown> = {
    'missing issue': () => ({ repairs: [] }),
    'unknown issue': input => ({ repairs: [{ ...select(input, 'findings:0'), id: 'findings:99' }] }),
    'wrong field namespace': input => ({ repairs: [{ ...select(input, 'findings:0'), id: 'facts:0' }] }),
    'duplicate issue': input => ({ repairs: [select(input, 'findings:0'), select(input, 'findings:0')] }),
    'extra issue': input => ({ repairs: [select(input, 'findings:0'), { ...select(input, 'findings:0'), id: 'findings:1' }] }),
    'source mutation': input => ({ repairs: [{ ...select(input, 'findings:0'), source_key: 'synopsis' }] }),
    'negative unit': input => ({ repairs: [{ ...select(input, 'findings:0'), first_unit: -1 }] }),
    'unit out of bounds': input => ({ repairs: [{ ...select(input, 'findings:0'), last_unit: 1_000_000 }] }),
    'reverse range': input => ({ repairs: [{ id: 'findings:0', first_unit: input.sources[0]!.units.at(-1)!.id, last_unit: input.sources[0]!.units[0]!.id - 1 }] }),
    'fractional unit': input => ({ repairs: [{ ...select(input, 'findings:0'), first_unit: 0.5 }] }),
    'mixed null range': input => ({ repairs: [{ ...select(input, 'findings:0'), first_unit: null }] }),
    'string unit': input => ({ repairs: [{ ...select(input, 'findings:0'), first_unit: '0' }] }),
  }
  for (const [label, value] of Object.entries(invalid)) await t.test(label, async () => {
    const f = fixture(), names: string[] = []
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      names.push(contract!.name)
      return draftReviewFixtureJson(contract!.name === 'script_draft_completeness'
        ? { ...f.clear(), findings: [f.finding(0, '不存在的引文。')] } : value(evidence(prompt)))
    }, { steps: f.steps() }))
    assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair'])
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint()).length, 1, 'invalid local output cannot discard the completed semantic review')
  })
})

test('an overlong finding cannot be legitimized by selecting an otherwise valid original range', async () => {
  const f = fixture(), names: string[] = [], limit = 4000
  const sentence = '原始证据文本，保留标点与换行。'
  f.draft.artifacts[0]!.content = sentence.repeat(Math.ceil((limit + 100) / sentence.length))
  assert.ok(f.draft.artifacts[0]!.content.length > limit)
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误的引文。')] })
    const input = evidence(prompt), units = input.sources[0]!.units
    return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: units[0]!.id, last_unit: units.at(-1)!.id }] })
  }, { steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair'])
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
})

test('a locator cannot use an all-whitespace original range as valid evidence', async () => {
  const f = fixture(), names: string[] = []
  f.draft.artifacts[0]!.content = ' \n\t \n '
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '正文中没有的证据。')] })
    const units = evidence(prompt).sources[0]!.units
    return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: units[0]!.id, last_unit: units.at(-1)!.id }] })
  }, { steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair'])
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
})

test('an unlocatable quote retains the assessment and resumes independent reassessment without a futile format correction', async () => {
  const f = fixture(), names: string[] = []
  const fact: Fact = { source_key: 'outline', quote: '夜雨覆盖石桥。', meaning: '可核实的开场事实。' }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_evidence_reassessment') return reassessmentResponse(prompt, ['findings:0'])
    return draftReviewFixtureJson(contract!.name === 'script_draft_completeness'
      ? { ...f.clear(), findings: [f.finding(0, '原文中不存在的语义。')], facts: [fact,
        { ...fact, quote: '石桥上的夜雨营造开场氛围。' }] }
      : { repairs: [{ id: 'findings:0', first_unit: null, last_unit: null }] })
  }, { steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_reassessment'])
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
  assert.equal(provisional(f.checkpoint()).length, 1)
  const retained = provisional(f.checkpoint())[0]![1].value as Review
  assert.deepEqual(retained.facts, [fact], 'discarding optional summaries never discards an unresolved finding')
  assert.equal(retained.findings.length, 1)
  const resumed: string[] = []
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push(contract!.name)
    assert.equal(contract!.name, 'script_draft_evidence_reassessment', 'continuation resumes the pending semantic reassessment')
    return reassessmentResponse(prompt)
  }, { steps: f.steps() }))
  assert.deepEqual(resumed, ['script_draft_evidence_reassessment'])
  assert.equal(result.length, 1, 'unlocatable findings are never silently dropped or turned into a passed audit')
})

test('partial locator success is retained while independent reassessment resumes the provisional report', async () => {
  const f = fixture()
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '第一项错误引文。'), f.finding(1, '第二项错误引文。')] })
    if (contract!.name === 'script_draft_evidence_reassessment') return reassessmentResponse(prompt, ['findings:1'])
    const input = evidence(prompt)
    return draftReviewFixtureJson({ repairs: [select(input, 'findings:0'), { id: 'findings:1', first_unit: null, last_unit: null }] })
  }, { steps: f.steps() }))
  const saved = provisional(f.checkpoint())
  assert.equal(saved.length, 1)
  const confirmedFinding = structuredClone((saved[0]![1].value as Review).findings[0]!)
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    assert.equal(contract!.name, 'script_draft_evidence_reassessment')
    const input = evidence(prompt, '【证据结论复核资料】\n')
    assert.deepEqual(input.issues.map(issue => issue.id), ['findings:1'], 'confirmed findings are not submitted for reassessment again')
    return reassessmentResponse(prompt)
  }, { steps: f.steps() }))
  assert.equal(result.length, 2)
  assert.deepEqual((f.checkpoint().steps['review:whole']!.value as Review).findings[0], confirmedFinding,
    'the prior confirmed finding and its exact quote are retained')
})

test('locator output exhaustion does not start three new full-work dimension reviews', async () => {
  const f = fixture(), names: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
    throw new TextOutputLimitError('', 'length', { input_tokens: 100, output_tokens: 100, reasoning_tokens: 100 })
  }, { steps: f.steps() }))
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair_page'])
  assert.equal(f.checkpoint().steps['review:recovery'], undefined)
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
  assert.equal(provisional(f.checkpoint()).length, 1)
})

test('truncated locator keeps closed repairs and resumes pages without repeating the semantic audit or completed repairs', async () => {
  const f = fixture(), names: string[] = [], interrupted = new TextProviderError('locator interrupted', false)
  let first: Repair | undefined
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文一'), f.finding(1, '错误引文二')] })
    if (contract!.name === 'script_draft_evidence_repair') {
      first = select(evidence(prompt), 'findings:0')
      throw new TextOutputLimitError('{"repairs":[' + JSON.stringify(first) + ',{"id":"findings:1', 'length')
    }
    assert.ok(prompt.includes(JSON.stringify([first]))); throw interrupted
  }, { steps: f.steps() }), issue => issue === interrupted)
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair_page'])
  const resumed: string[] = []
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push(contract!.name)
    const input = evidence(prompt); assert.deepEqual(input.issues.map(item => item.id), ['findings:1'])
    return response(input)
  }, { steps: f.steps() }))
  assert.deepEqual(resumed, ['script_draft_evidence_repair'])
  assert.equal(result.length, 2)
  assert.equal(result[0]!.explanation, f.finding(0).explanation)
  assert.equal(result[1]!.explanation, f.finding(1).explanation)
})

test('a completed locator page containing null remains unfinished and continuation resumes semantic reassessment', async () => {
  const f = fixture(), names: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    names.push(contract!.name)
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
    if (contract!.name === 'script_draft_evidence_repair') throw new TextOutputLimitError('', 'length')
    if (contract!.name === 'script_draft_evidence_reassessment') return reassessmentResponse(prompt, ['findings:0'])
    return draftReviewFixtureJson({ items: [{ id: 'findings:0', first_unit: null, last_unit: null }], complete: true })
  }, { steps: f.steps() }), issue => (issue as { code?: string }).code === 'script_draft_evidence_unresolved')
  assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_repair_page', 'script_draft_evidence_reassessment'])
  const pages = Object.entries(f.checkpoint().steps).filter(([key]) => key.endsWith(':evidence:pages'))
  assert.equal(pages.length, 0, 'null coordinates cannot complete a repair page')
  assert.ok(Object.keys(f.checkpoint().steps).some(key => key.endsWith(':semantic-pending')))
  const resumed: string[] = []
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    resumed.push(contract!.name)
    return reassessmentResponse(prompt)
  }, { steps: f.steps() }))
  assert.deepEqual(resumed, ['script_draft_evidence_reassessment'])
  assert.equal(result.length, 1); assert.equal(result[0]!.explanation, f.finding(0).explanation)
})

test('null repairs in an interrupted partial page never block a later real location and successful quotes stay retained', async () => {
  const f = fixture(), interrupted = new TextProviderError('page interrupted', false)
  let pageCalls = 0
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误一'), f.finding(1, '错误二')] })
    if (contract!.name === 'script_draft_evidence_repair') throw new TextOutputLimitError('', 'length')
    if (++pageCalls === 1) throw new TextOutputLimitError('{"items":[' + JSON.stringify(select(evidence(prompt), 'findings:0')) +
      ',{"id":"findings:1","first_unit":null,"last_unit":null},', 'length')
    throw interrupted
  }, { steps: f.steps() }), issue => issue === interrupted)
  const pages = Object.entries(f.checkpoint().steps).find(([key]) => key.endsWith(':evidence:pages'))!
  const retained = (pages[1].value as { items: Repair[] }).items
  assert.equal(retained.length, 1); assert.equal(retained[0]!.id, 'findings:0')
  assert.notEqual(retained[0]!.first_unit, null)
  const result = await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    assert.equal(contract!.name, 'script_draft_evidence_repair')
    const input = evidence(prompt); assert.deepEqual(input.issues.map(item => item.id), ['findings:1'])
    return response(input)
  }, { steps: f.steps() }))
  assert.equal(result.length, 2)
})

test('provisional evidence is bound to the exact complete review prompt and invalidates on candidate or context changes', async t => {
  for (const changed of ['candidate', 'context'] as const) await t.test(changed, async () => {
    const f = fixture()
    let semanticPrompt = ''
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      if (contract!.name === 'script_draft_completeness') {
        semanticPrompt = prompt.slice(prompt.lastIndexOf('【原始任务与资料】\n') + '【原始任务与资料】\n'.length)
        return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
      }
      return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: null, last_unit: null }] })
    }, { context: f.context, steps: f.steps() }))
    const [[key, saved]] = provisional(f.checkpoint())
    assert.equal(key, `review:response:${createHash('sha256').update(semanticPrompt).digest('hex')}`)
    assert.equal(saved.input_hash, createHash('sha256').update(JSON.stringify({ version: 1, prompt: semanticPrompt })).digest('hex'))
    if (changed === 'candidate') f.draft.artifacts[0]!.content += '\n创作者新增：记忆不可恢复。'
    else f.context.source_version = 'v2'
    const names: string[] = []
    await reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => { names.push(contract!.name); return draftReviewFixtureJson(f.clear()) },
      { context: f.context, steps: f.steps() })
    assert.deepEqual(names, ['script_draft_completeness'])
  })
})

test('cancelled or budget-blocked evidence lookup never passes review and retains the original completed assessment', async t => {
  await t.test('cancellation', async () => {
    const f = fixture(), controller = new AbortController(), names: string[] = []
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      names.push(contract!.name)
      if (contract!.name === 'script_draft_completeness') return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
      const value = response(evidence(prompt))
      controller.abort(new DOMException('cancelled during evidence lookup', 'AbortError'))
      return value
    }, { steps: f.steps(controller.signal), signal: controller.signal }), /cancelled|abort/i)
    assert.deepEqual(names, ['script_draft_completeness', 'script_draft_evidence_repair'])
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint()).length, 1)
  })
  await t.test('request budget', async () => {
    const f = fixture(), usage = createScriptRequestUsage(), dispatched: string[] = []
    const generate: StructuredGenerator = async (prompt, contract) => {
      const request = beginTextRequest({ request_bytes: Buffer.byteLength(prompt), estimated_input_tokens: 100, reserved_output_tokens: 100 })
      dispatched.push(contract!.name)
      request.complete({ input_tokens: 100, output_tokens: 20 })
      return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
    }
    await assert.rejects(withTextRequestUsage({ usage, limits: { max_requests: 1 } },
      () => reviewScriptDraftCompleteness(f.draft, generate, { steps: f.steps() })), TextRequestBudgetError)
    assert.deepEqual(dispatched, ['script_draft_completeness'])
    assert.equal(f.checkpoint().steps['review:whole'], undefined)
    assert.equal(provisional(f.checkpoint()).length, 1)
    await findings(withTextRequestUsage({ usage, limits: { max_requests: 2 } }, () => reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      assert.equal(contract!.name, 'script_draft_evidence_repair')
      const request = beginTextRequest({ request_bytes: Buffer.byteLength(prompt), estimated_input_tokens: 100, reserved_output_tokens: 100 })
      request.complete({ input_tokens: 100, output_tokens: 20 })
      return response(evidence(prompt))
    }, { steps: f.steps() })))
    assert.equal(usage.requests, 2)
  })
})

test('a dimension is not complete until its provisional evidence is located, and continuation skips prior full reviews', async () => {
  const f = fixture(), seen: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_evidence_reassessment') { seen.push('reassess'); return reassessmentResponse(prompt, ['findings:0']) }
    if (contract!.name === 'script_draft_evidence_repair') {
      seen.push('locate')
      return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: null, last_unit: null }] })
    }
    const dimension = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
    seen.push(dimension)
    if (dimension === 'whole') throw new TextOutputLimitError('', 'length', { input_tokens: 100, output_tokens: 100, reasoning_tokens: 100 })
    return draftReviewFixtureJson({ ...f.clear(), findings: [f.finding(0, '错误引文。')] })
  }, { steps: f.steps() }))
  assert.deepEqual(seen, ['whole', 'settings', 'locate', 'reassess'])
  assert.equal(f.checkpoint().steps['review:dimension:settings'], undefined)
  assert.equal(f.checkpoint().steps['review:whole'], undefined)
  const resumed: string[] = []
  await findings(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (contract!.name === 'script_draft_evidence_reassessment') { resumed.push('reassess'); return reassessmentResponse(prompt) }
    resumed.push(/本轮核查维度：([a-z]+)。/.exec(prompt)![1]!)
    return draftReviewFixtureJson(f.clear())
  }, { steps: f.steps() }))
  assert.deepEqual(resumed, ['reassess', 'consistency', 'requirements'])
  assert.ok(f.checkpoint().steps['review:dimension:settings'])
  assert.ok(f.checkpoint().steps['review:whole'])
})

test('already exact evidence adds no locator calls or provisional checkpoints', async () => {
  const f = fixture(), names: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (_prompt, contract) => {
    names.push(contract!.name)
    return draftReviewFixtureJson({ ...f.clear(), facts: [{ source_key: 'outline', quote: '夜雨覆盖石桥。', meaning: '开场环境。' }] })
  }, { steps: f.steps() })
  assert.deepEqual(names, ['script_draft_completeness'])
  assert.deepEqual(Object.keys(f.checkpoint().steps), ['review:whole'])
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('validated unchanged review is reused'), { steps: f.steps() })
})
