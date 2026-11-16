import { createHash } from 'node:crypto'
import { z } from 'zod'
import { draftCompletenessInput, draftCompletenessSources, draftReviewPromptInputs, ScriptDraftNeedsResolution,
  type ScriptDraftReviewOptions } from '../../src/modules/script/script-draft-completeness.js'
import type { StructuredGenerator } from '../../src/modules/generation/model-output.js'
import { generateDraftReviewWithEvidence, retainedDraftReviewFindings } from '../../src/modules/script/script-draft-review-evidence.js'
import { recoverScriptDraftReview, scriptDraftReviewPassLimit } from '../../src/modules/script/script-draft-review-recovery.js'
import { consolidateFindings, scriptDraftFindingLimit } from '../../src/modules/script/script-finding-state.js'
import { groupDraftFindings } from '../../src/modules/script/script-finding-groups.js'
import { draftReviewTaskContext, draftReviewTaskSteps, planDraftReviewTasks, type DraftReviewTask } from '../../src/modules/script/script-draft-review-plan.js'
import { reviewConcurrency, settleBounded } from '../../src/modules/script/script-bounded-parallel.js'
import type { GenerationCheckpoint } from '../../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../../src/modules/script/script-workflow.js'

type Source = ReturnType<typeof draftCompletenessSources>[number]
const cached = draftCompletenessInput.extend({ findings: z.array(draftCompletenessInput.shape.findings.element.extend({
  severity: z.enum(['blocking', 'suggestion']).default('blocking'),
})).max(scriptDraftFindingLimit) })
const combined = cached.extend({ findings: cached.shape.findings.max(scriptDraftFindingLimit * (scriptDraftReviewPassLimit + 1)) })

/** Explicit LEGACY contract harness. These suites exercise the production
 * quoted-report locator/reassessment functions directly, including deliberate
 * fabricated quotes. They never relax the new production first-round schema.
 * Separate coordinate integration tests verify current completeness routing. */
export async function reviewLegacyDraftEvidenceFixture(draft: WorkflowDraft, generate: StructuredGenerator,
  options: ScriptDraftReviewOptions = {}): Promise<void> {
  options = { ...options, intent: options.intent ?? draft.intent }
  const sources = draftCompletenessSources(draft, options.preserved)
  if (!sources.length) return
  const review = async (sources: Source[], options: ScriptDraftReviewOptions, task?: DraftReviewTask) => {
    const { prompt, wirePrompt, expected } = draftReviewPromptInputs(draft, sources, options, task)
    const validate = (value: unknown, merged = false, quotes = true) => {
      const result = (merged ? combined : cached).parse(value)
      result.facts = result.facts.filter(fact => sources.some(source => source.key === fact.source_key && source.content.includes(fact.quote)))
      if (result.checked_artifacts.length !== expected.length || new Set(result.checked_artifacts).size !== expected.length ||
        expected.some(type => !result.checked_artifacts.includes(type))) throw new Error('设定核对必须覆盖本次送审的全部文档类型，不能漏项、重复或超出范围')
      for (const field of ['findings', 'facts'] as const) for (const item of result[field]) {
        const source = sources.find(source => source.key === item.source_key)
        if (!source || quotes && !source.content.includes(item.quote)) throw new Error('设定核对证据必须逐字来自当前草稿的真实来源')
      }
      return result
    }
    let retained: unknown[] | undefined
    const work = () => recoverScriptDraftReview(prompt, (text, mode) => generateDraftReviewWithEvidence(text, draftCompletenessInput,
      (request, contract) => generate(wirePrompt !== prompt && request.endsWith(text) && text.endsWith(prompt)
        ? request.slice(0, -text.length) + text.slice(0, -prompt.length) + wirePrompt : request, contract), sources,
      value => validate(value, false, false), value => validate(value), { ...options,
        answerMode: mode === 'answer' || mode === 'paged_answer', paged: mode === 'paged' || mode === 'paged_answer',
        findingSchema: draftCompletenessInput.shape.findings.element, checkedArtifacts: expected,
        onRetainedFindings: findings => { if (text === prompt) retained = findings },
      }), value => validate(value), results => ({ facts: [], checked_artifacts: expected,
        findings: [...new Map(results.flatMap(result => result.findings).map(finding => [JSON.stringify(finding), finding])).values()] }),
      { ...options, pagedReviewSupported: true, validateCombined: value => validate(value, true), retainedReview: async () => {
        const findings = retained || retainedDraftReviewFindings(prompt, options.steps)
        if (!findings?.length) return undefined
        return generateDraftReviewWithEvidence(prompt, draftCompletenessInput, generate, sources,
          value => validate(value, false, false), value => validate(value), { ...options, retainedFindings: findings, checkedArtifacts: expected })
      } })
    return task && options.steps ? options.steps.run('result', task.label, { version: 1, prompt }, work,
      value => validate(value, true), options.parentId) : work()
  }
  const tasks = planDraftReviewTasks(draft.stage, sources, options.review_scope)
  const reports = !tasks.length ? [await review(sources, options)] : await (async () => {
    const locals = tasks.filter(task => task.kind !== 'consistency'), globals = tasks.filter(task => task.kind === 'consistency')
    const one = (task: DraftReviewTask) => review(task.sources, { ...options, steps: draftReviewTaskSteps(options.steps, task.id),
      context: task.kind === 'consistency' ? options.context : draftReviewTaskContext(options.context, task.sources) }, task)
    const settled = await settleBounded(locals, reviewConcurrency(), options.signal, one)
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failure) throw failure.reason
    const results = settled.map(item => (item as PromiseFulfilledResult<z.infer<typeof cached>>).value)
    for (const task of globals) results.push(await one(task))
    return results
  })()
  const findings = reports.flatMap(result => result.findings)
  const plain = ({ severity: _severity, ...finding }: typeof findings[number]) => finding
  const suggestions = consolidateFindings(findings.filter(finding => finding.severity === 'suggestion').map(plain))
  if (suggestions.length) options.onSuggestions?.(suggestions)
  const blocking = consolidateFindings(findings.filter(finding => finding.severity === 'blocking').map(plain))
  const grouped = blocking.some(finding => finding.topic?.trim())
    ? await groupDraftFindings(blocking, options.resolutions || [], generate, options) : blocking
  if (grouped.length > scriptDraftFindingLimit) throw new Error(`阶段设定核对发现超过 ${scriptDraftFindingLimit} 项独立问题，已保留全部核查结果；请缩小创作范围后处理，未截断或忽略问题。`)
  if (grouped.length) throw new ScriptDraftNeedsResolution(draft, grouped)
}

/** Seed only a byte-identical old report. The current entry point must decide
 * whether it can migrate or resume it; this helper never invokes old review. */
export function legacyDraftEvidenceCheckpoint(draft: WorkflowDraft, report: unknown,
  options: ScriptDraftReviewOptions = {}, kind: 'provisional' | 'whole' = 'provisional'): GenerationCheckpoint {
  const sources = draftCompletenessSources(draft, options.preserved)
  const { prompt } = draftReviewPromptInputs(draft, sources, { ...options, intent: options.intent ?? draft.intent })
  const id = kind === 'whole' ? 'review:whole' : `review:response:${createHash('sha256').update(prompt).digest('hex')}`
  return { steps: { [id]: { input_hash: createHash('sha256').update(JSON.stringify({ version: kind === 'whole' ? 3 : 1, prompt })).digest('hex'), value: report } } }
}
