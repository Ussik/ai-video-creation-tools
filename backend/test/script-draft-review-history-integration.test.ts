import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { scriptDraftReviewContext } from '../src/modules/script/script-draft-review-context.js'
import { scriptDraftReviewHistoryGuidance } from '../src/modules/script/script-draft-review-history.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const expected = [...scriptStageArtifacts.outline]
const clear = () => ({ facts: [], checked_artifacts: expected, findings: [] })
const resultText = () => JSON.stringify(clear())
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const dimension = (prompt: string) => /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
const materialStart = '既有事实与创作要求（资料）：'
const sourceStart = '\n待核对草稿原文（资料）：'
const taskStart = '\n【原始任务与资料】\n'
function contextFrom(prompt: string): Record<string, any> {
  return JSON.parse(prompt.slice(prompt.lastIndexOf(materialStart) + materialStart.length, prompt.lastIndexOf(sourceStart)))
}
function candidatesFrom(prompt: string) {
  return JSON.parse(prompt.slice(prompt.lastIndexOf(sourceStart) + sourceStart.length)) as Array<{
    key: string; artifact_type: string; title: string; content: string
  }>
}
/** Reconstruct the pre-optimization task from observed wire material. The
 * legacy hash contains complete history and no wire-only history guidance. */
function legacyPrompt(wire: string, context: unknown) {
  const task = wire.slice(wire.indexOf(taskStart) + taskStart.length)
  const before = task.slice(0, task.lastIndexOf(materialStart)).replace(scriptDraftReviewHistoryGuidance, '')
  return before + materialStart + JSON.stringify(scriptDraftReviewContext(context)) +
    task.slice(task.lastIndexOf(sourceStart))
}

/** All checkpoint state is detached in memory; no database modules are used. */
function fixture() {
  let saved: GenerationCheckpoint = { steps: {} }
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
    artifacts: expected.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `第${index + 1}份候选文档开头。\n名单容量十七位，结局撤掉神位。\n第${index + 1}份文档结尾。` })) }
  const context = {
    uploaded_script: { filename: '完整原稿.md', content: '完整原稿开头。\n十七个位置已满，主角破禁。\n完整原稿结局。',
      updated_at: '2026-10-24T00:00:00Z', analysis: { source_version: 'source-v1', story: { summary: '完整全剧理解，结局不改。' },
        work: ['不应送入审读的运行态'] } },
    creator_messages: [{ role: 'assistant', text: '方案二保留名单容量，结局撤掉神位。' },
      { role: 'user', text: '采用方案二，保留原稿结局。', reference_documents: [{ id: 'reference', title: '引用资料', content: '完整引用，禁止新增第十八位。' }] }],
    confirmed_decisions: [{ id: 'creator-decision', topic: '名单容量', content: '十七个位置已满。' }],
    saved_documents: [{ id: 'saved', title: '既有设定', content: '已保存文档完整原文。' }],
    resolved_findings: {
      decisions: [
        { id: 'settled', topic: '已定名单容量', source_key: 'world', kind: 'contradiction', strategy: 'manual',
          answer: '保留十七位，不增加位置。', decision: '名单总数十七位，已有位置全部记满。', status: 'verified', attempts: 2,
          problem: '已废弃问题：名单是十八位还是十七位尚不确定。', summary_id: 'retired-summary' },
        { id: 'open', topic: '手部代价', source_key: 'constraints', kind: 'contradiction', strategy: 'ai', answer: '',
          decision: '第十三集是手与笔迹代价的起点。', status: 'still_open', attempts: 1,
          problem: '仍未处理：候选正文代价起点尚未一致。', summary_id: 'open-summary' },
        { id: 'legacy', topic: '旧版结局约束', source_key: 'synopsis', kind: 'missing_core_setting', strategy: 'manual',
          answer: '结局不能反转主角身份。', status: 'verified', attempts: 1,
          problem: '旧格式问题中保留真实创作限制。', summary_id: 'legacy-summary' },
      ],
      summaries: [{ id: 'retired-summary', text: '已废弃整批旧方案：名单容量十八位。' },
        { id: 'open-summary', text: '尚未完成的代价修补说明，必须保留。' },
        { id: 'legacy-summary', text: '无独立决定的旧记录，其结局身份不能改变。' },
        { id: 'unreferenced', text: '无任何记录引用的历史批次重复说明。' }],
      additional_context: '未知历史附加约束同样保留。',
    },
    current_settings: { episode_count: 60 }, requested_settings: { episode_count: 60 }, task_scope: { stage: 'outline' },
    future_constraint: { text: '尚未识别的顶层约束原样保留。' },
  }
  return { draft, context, snapshot: () => structuredClone(saved),
    seed: (checkpoint: GenerationCheckpoint) => { saved = structuredClone(checkpoint) },
    steps: () => createGenerationSteps({ checkpoint: saved, save: checkpoint => { saved = structuredClone(checkpoint) } }) }
}

function assertWire(prompt: string, f: ReturnType<typeof fixture>) {
  const sent = contextFrom(prompt), original = scriptDraftReviewContext(f.context) as typeof f.context
  for (const key of ['uploaded_script', 'creator_messages', 'confirmed_decisions', 'saved_documents', 'current_settings',
    'requested_settings', 'task_scope', 'future_constraint'] as const) assert.deepEqual(sent[key], original[key], `${key} stays complete`)
  assert.deepEqual(candidatesFrom(prompt), f.draft.artifacts.map(artifact => ({ key: artifact.artifact_type,
    artifact_type: artifact.artifact_type, title: artifact.title, content: artifact.content })))
  const { problem: _problem, summary_id: _summary, ...settled } = f.context.resolved_findings.decisions[0]!
  assert.deepEqual(sent.resolved_findings.decisions[0], settled)
  assert.deepEqual(sent.resolved_findings.decisions.slice(1), f.context.resolved_findings.decisions.slice(1),
    'unresolved and decision-less legacy records retain their complete problem, answer and summary reference')
  assert.deepEqual(sent.resolved_findings.summaries, f.context.resolved_findings.summaries.slice(1, 3))
  assert.equal(sent.resolved_findings.additional_context, f.context.resolved_findings.additional_context)
  assert.equal(prompt.includes(f.context.resolved_findings.decisions[0]!.problem), false)
  assert.equal(prompt.includes(f.context.resolved_findings.summaries[0]!.text), false)
  assert.equal(prompt.includes(f.context.resolved_findings.summaries[3]!.text), false)
  assert.ok(prompt.includes(scriptDraftReviewHistoryGuidance))
}

test('actual completeness wire omits retired defects and unreferenced summaries while all current facts stay exact', async () => {
  const f = fixture(), before = structuredClone(f.context)
  let wire = ''
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    wire = prompt; assert.equal(contract?.name, 'script_draft_completeness'); assertWire(prompt, f)
    return resultText()
  }, { context: f.context, steps: f.steps() })
  const canonical = legacyPrompt(wire, f.context)
  assert.ok(canonical.includes(f.context.resolved_findings.decisions[0]!.problem))
  assert.ok(canonical.includes(f.context.resolved_findings.summaries[0]!.text))
  assert.equal(canonical.includes(scriptDraftReviewHistoryGuidance), false)
  assert.equal(f.snapshot().steps['review:whole']!.input_hash, hash({ version: 3, prompt: canonical }),
    'the successful checkpoint uses the complete legacy task identity rather than the smaller wire prompt')
  assert.deepEqual(f.context, before, 'stored history and its old evidence remain unchanged')
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('identical successful canonical input is cached'),
    { context: f.context, steps: f.steps() })
})

async function interruptAfterSettings(f: ReturnType<typeof fixture>) {
  const interrupted = new TextProviderError('provider temporarily unavailable', false, 'provider_error')
  let settingsWire = ''
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const scope = dimension(prompt); assertWire(prompt, f)
    if (scope === 'whole') throw new TextOutputLimitError('partial JSON', 'length')
    if (scope === 'settings') { settingsWire = prompt; return resultText() }
    throw interrupted
  }, { context: f.context, steps: f.steps() }), issue => issue === interrupted)
  assert.ok(settingsWire)
  const canonical = legacyPrompt(settingsWire, f.context)
  assert.equal(f.snapshot().steps['review:dimension:settings']!.input_hash, hash({ version: 1, prompt: canonical }),
    'existing dimension checkpoint identity includes complete original history')
  return f.snapshot().steps['review:dimension:settings']!
}

test('legacy settings checkpoint survives wire projection and only unfinished dimensions are dispatched', async () => {
  const f = fixture(), settings = await interruptAfterSettings(f), calls: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls.push(dimension(prompt)); assertWire(prompt, f); return resultText()
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(calls, ['consistency', 'requirements'])
  assert.deepEqual(f.snapshot().steps['review:dimension:settings'], settings)
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('all validated dimensions remain reusable'),
    { context: f.context, steps: f.steps() })
})

test('source, creator, adopted decision and even omitted historical material remain part of cache identity', async t => {
  for (const changed of ['source', 'creator', 'decision', 'retired_problem', 'retired_summary'] as const) await t.test(changed, async () => {
    const f = fixture(), oldSettings = await interruptAfterSettings(f)
    if (changed === 'source') f.context.uploaded_script.content += '\n新的真实原稿事实。'
    else if (changed === 'creator') f.context.creator_messages[0]!.text += '补充明确创作要求。'
    else if (changed === 'decision') f.context.resolved_findings.decisions[0]!.decision = '十七个位置记满，不准增加新位。'
    else if (changed === 'retired_problem') f.context.resolved_findings.decisions[0]!.problem += '历史证据说明发生变化。'
    else f.context.resolved_findings.summaries[0]!.text += '历史批次材料发生变化。'
    const calls: string[] = []
    await reviewScriptDraftCompleteness(f.draft, async prompt => {
      calls.push(dimension(prompt)); assertWire(prompt, f); return resultText()
    }, { context: f.context, steps: f.steps() })
    assert.deepEqual(calls, ['whole'], 'a changed canonical input cannot reuse a previous partial audit')
    assert.deepEqual(f.snapshot().steps['review:dimension:settings'], oldSettings,
      'changing inputs does not destructively rewrite the historical result')
  })
})

test('pending evidence stored under the full legacy prompt resumes only its locator after history projection', async () => {
  const f = fixture(), interrupted = new TextProviderError('capture without completed request', false, 'provider_error')
  let observed = ''
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    observed = prompt; throw interrupted
  }, { context: f.context, steps: f.steps() }), issue => issue === interrupted)
  const canonical = legacyPrompt(observed, f.context), source = f.draft.artifacts[0]!
  const finding = { source_key: source.artifact_type, kind: 'contradiction' as const,
    quote: '旧审读引文尚未精确定位。', explanation: '名单容量与当前创作决定需要逐字核对。', suggestion: '按十七位的既定容量落实正文。' }
  const responseId = `review:response:${createHash('sha256').update(canonical).digest('hex')}`
  f.seed({ steps: { [responseId]: { input_hash: hash({ version: 1, prompt: canonical }),
    value: { ...clear(), findings: [finding] }, duration_ms: 0 } } })
  const calls: string[] = []
  let actualQuote = ''
  const preservesFinding = (issue: unknown) => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 1)
    assert.equal(issue.findings[0]!.source_key, finding.source_key)
    assert.equal(issue.findings[0]!.explanation, finding.explanation)
    assert.equal(issue.findings[0]!.suggestion, finding.suggestion)
    assert.equal(issue.findings[0]!.quote, actualQuote)
    return true
  }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract?.name || '')
    assert.equal(contract?.name, 'script_draft_evidence_repair', 'completed semantic audit must never be reissued')
    assert.equal(contract?.request_policy, 'script_evidence')
    const marker = '【待定位证据（资料）】\n'
    const pending = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
      issues: Array<{ id: string; source_key: string; explanation: string; suggestion: string }>
      sources: Array<{ key: string; units: Array<{ id: number; text: string }> }>
    }
    assert.equal(pending.issues[0]!.explanation, finding.explanation)
    assert.equal(pending.issues[0]!.suggestion, finding.suggestion)
    const unit = pending.sources.find(item => item.key === finding.source_key)!.units.find(item => item.text.includes('名单容量十七位'))!
    assert.ok(unit)
    actualQuote = unit.text.trim()
    return JSON.stringify({ repairs: [{ id: pending.issues[0]!.id, first_unit: unit.id, last_unit: unit.id }] })
  }, { context: f.context, steps: f.steps() }), preservesFinding)
  assert.deepEqual(calls, ['script_draft_evidence_repair'])
  assert.equal(f.snapshot().steps[responseId], undefined)
  assert.ok(f.snapshot().steps['review:whole'], 'only the completed, exact-evidence result becomes reusable')
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => assert.fail('validated evidence is durable'),
    { context: f.context, steps: f.steps() }), preservesFinding)
})

test('a changed complete input cannot reuse a pending evidence checkpoint from a previous source version', async () => {
  const f = fixture(), interrupted = new TextProviderError('capture task', false, 'provider_error')
  let observed = ''
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => { observed = prompt; throw interrupted },
    { context: f.context, steps: f.steps() }), issue => issue === interrupted)
  const canonical = legacyPrompt(observed, f.context)
  const responseId = `review:response:${createHash('sha256').update(canonical).digest('hex')}`
  f.seed({ steps: { [responseId]: { input_hash: hash({ version: 1, prompt: canonical }), value: { ...clear(), findings: [{
    source_key: f.draft.artifacts[0]!.artifact_type, kind: 'contradiction', quote: '旧版不匹配引文',
    explanation: '旧源版本的问题。', suggestion: '修补旧版。',
  }] }, duration_ms: 0 } } })
  f.context.uploaded_script.content += '\n真实原稿现已修改。'
  const calls: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract?.name || ''); assertWire(prompt, f); return resultText()
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(calls, ['script_draft_completeness'])
})
