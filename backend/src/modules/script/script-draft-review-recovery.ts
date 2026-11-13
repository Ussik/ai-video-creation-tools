import { createHash } from 'node:crypto'
import { TextOutputLimitError } from '../../infrastructure/providers/text-errors.js'
import { modelStepSignal } from '../generation/model-execution.js'
import type { GenerationSteps } from './script-generation-steps.js'

/** Every focused pass still reads the whole work. These scopes partition the
 * review task, never the manuscript or its cross-document evidence. */
const reviewDimensions = [
  { id: 'settings', label: '核对核心设定与作者答案', instruction:
    '只核对本任务固定合同已明确要求的核心内容是否可理解且完整，不扩大成果范围。人物动机、规则条件、谜底或伏笔仅在本任务实际要求且缺少会使当前成果不成立时检查；整理原稿的任务允许如实保留原稿未知内容，不补造答案。' },
  { id: 'consistency', label: '核对全文因果与跨文档一致性', instruction:
    '只核对完整作品的前后因果和一致性：人物动机/知情范围、事件时序与集位、状态/资源/道具流转、能力规则、结局与伏笔回收，各候选文档及分场之间，以及它们与完整有效稿、已保存文档之间的冲突。不得忽略跨文档证据。' },
  { id: 'requirements', label: '核对原稿忠实度与既有决定落实', instruction:
    '只核对本任务固定合同内的创作要求、原稿已明确事实和已有决定是否落实：对照完整有效稿、创作者原文与全部引用资料、已确认事实及既有回答/委托决定；检查本次交付的关键遗漏、擅改和明确要求同步却未同步的内容。不能重新要求作出同一决定，不将其他文档或下阶段细节变成本任务义务。' },
] as const
export const scriptDraftReviewPassLimit = reviewDimensions.length

const reasoningExhausted = (issue: unknown): issue is TextOutputLimitError => issue instanceof TextOutputLimitError &&
  issue.partialText === '' && Number.isSafeInteger(issue.usage?.output_tokens) && (issue.usage?.output_tokens || 0) > 0 &&
  issue.usage?.reasoning_tokens === issue.usage?.output_tokens

/** An incomplete review is never a pass, including syntactically valid partial
 * text. A single, durable strategy change avoids repeating an exhausted whole
 * review on every continuation. Focused failures can switch once to paged
 * reports; completed checks and pages remain reusable on continuation. */
export async function recoverScriptDraftReview<T>(prompt: string, review: (prompt: string, mode?: 'answer' | 'paged' | 'paged_answer') => Promise<T>,
  validate: (value: unknown) => T, combine: (results: T[]) => unknown,
  options: { signal?: AbortSignal; steps?: GenerationSteps; parentId?: string; validateCombined?: (value: unknown) => T;
    answerModeSupported?: boolean; pagedReviewSupported?: boolean; retainedReview?: () => Promise<T | undefined> } = {}): Promise<T> {
  const { steps, parentId } = options
  const validateCombined = options.validateCombined || validate
  const runReview = (id: string, label: string, input: unknown, text: string, check: (value: unknown) => T) => {
    const ordinaryReview = async () => {
      const policyId = `review:reasoning:${id}`, policyInput = { version: 1, input }
      const hash = createHash('sha256').update(JSON.stringify(policyInput)).digest('hex')
      const saved = steps?.checkpoint.steps[policyId]
      const validatePolicy = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('mode' in value) || !['answer', 'blocked'].includes(String(value.mode))) {
          throw new Error('阶段复核推理恢复检查点无效')
        }
        return value as { mode: 'answer' | 'blocked' }
      }
      const previous = saved?.input_hash === hash ? validatePolicy(saved.value) : undefined
      if (previous && options.answerModeSupported) {
        // Older versions persisted a permanent failure gate. Treat it only
        // as the already selected answer strategy, so an explicit continuation
        // can finish the unanswered check without replaying completed work.
        if (previous.mode === 'blocked') steps?.retain(policyId, '继续尚未完成的直接答复核对', policyInput,
          { ...previous, mode: 'answer' }, validatePolicy, parentId)
        return review(text, 'answer')
      }
      try { return await review(text) }
      catch (issue) {
        modelStepSignal(options.signal)?.throwIfAborted()
        if (!options.answerModeSupported || !reasoningExhausted(issue)) throw issue
        // Persist before dispatch: continuing this exact step must never
        // repeat the already exhausted reasoning request or reset its policy.
        steps?.retain(policyId, '推理耗尽，改为直接返回核对结果', policyInput,
          { mode: 'answer', reason: issue.reason, usage: issue.usage }, validatePolicy, parentId)
        return review(text, 'answer')
      }
    }
    const work = async () => {
      const pagingId = `review:paging:${id}`, pagingInput = { version: 1, input }
      const pagingHash = createHash('sha256').update(JSON.stringify(pagingInput)).digest('hex')
      const saved = steps?.checkpoint.steps[pagingId]
      const policyId = `review:reasoning:${id}`, policyInput = { version: 1, input }
      const policyHash = createHash('sha256').update(JSON.stringify(policyInput)).digest('hex')
      const policy = steps?.checkpoint.steps[policyId]
      const validatePaging = (value: unknown) => {
        if (value !== 'paged' && value !== 'paged_answer') throw new Error('审读分页恢复策略无效')
        return value
      }
      if (options.pagedReviewSupported && saved?.input_hash === pagingHash) {
        const mode = validatePaging(saved.value)
        if (mode === 'paged_answer' && policy?.input_hash === policyHash && (policy.value as { mode?: string })?.mode === 'blocked') {
          steps?.retain(policyId, '继续尚未完成的直接答复核对', policyInput,
            { ...(policy.value as object), mode: 'answer' }, value => value, parentId)
        }
        return review(text, mode === 'paged_answer' && !options.answerModeSupported ? 'paged' : mode)
      }
      try { return await ordinaryReview() }
      catch (issue) {
        modelStepSignal(options.signal)?.throwIfAborted()
        if (!options.pagedReviewSupported || !id.startsWith('review:dimension:') || !(issue instanceof TextOutputLimitError)) throw issue
        const currentPolicy = steps?.checkpoint.steps[policyId]
        const answer = options.answerModeSupported && currentPolicy?.input_hash === policyHash
        const mode = answer ? 'paged_answer' : 'paged'
        steps?.retain(pagingId, '分项审读超限，继续分批返回结果', pagingInput, mode, validatePaging, parentId)
        return review(text, mode)
      }
    }
    return steps ? steps.run(id, label, input, work, check, parentId) : work()
  }
  const input = { version: 3, prompt }
  const recoveryInput = { version: 1, prompt }
  const previous = steps?.checkpoint.steps['review:recovery']
  const focused = previous?.input_hash === createHash('sha256').update(JSON.stringify(recoveryInput)).digest('hex') &&
    previous.value === 'dimensions'
  const validateStrategy = (value: unknown) => {
    if (value !== 'dimensions') throw new Error('无效的设定核对恢复策略')
    return value
  }
  const label = '整体核对完整草稿、有效稿与既有设定'
  if (!focused) {
    try {
      return await runReview('review:whole', label, input, prompt, validateCombined)
    } catch (issue) {
      modelStepSignal(options.signal)?.throwIfAborted()
      if (!(issue instanceof TextOutputLimitError)) throw issue
      steps?.retain('review:recovery', '输出超限，自动按核查维度恢复', recoveryInput, 'dimensions', validateStrategy, parentId)
    }
  }
  const results: T[] = []
  for (const dimension of reviewDimensions) {
    modelStepSignal(options.signal)?.throwIfAborted()
    // Put the narrower task before the intact original prompt. Each response
    // must still satisfy full artifact coverage and exact evidence validation.
    const focusedPrompt = '【输出超限后的自动分项核对】\n' +
      `本轮核查维度：${dimension.id}。${dimension.instruction}\n` +
      '各恢复维度只能缩小下方固定任务合同的检查职责，不能增加验收条件或要求新成果；若本任务仅核对局部成果或全局一致性，继续遵守该职责范围。非阻断建议不能变为 blocking。\n' +
      '本轮仍提供全部原稿、候选文档、既有设定与要求。只返回本维度的实质问题，不复述全文，不展开故事，不重复列同一问题。' +
      'findings 的引文只取定位问题所需的最短连续原文，说明与建议简洁具体；facts 返回空数组。' +
      'checked_artifacts 仍必须覆盖全部送审文档。本维度无问题只表示此项完成；系统会完成其余维度后统一验收。\n' + prompt
    results.push(await runReview(`review:dimension:${dimension.id}`, dimension.label,
      { version: 1, prompt: focusedPrompt }, focusedPrompt, validate))
  }
  modelStepSignal(options.signal)?.throwIfAborted()
  const retained = await options.retainedReview?.()
  if (retained) results.push(validate(retained))
  modelStepSignal(options.signal)?.throwIfAborted()
  // Do not store an overall success until every independent pass has produced
  // a complete, validated result. Never clip findings to satisfy a size bound.
  const combined = validateCombined(combine(results))
  // A repaired/corrupt focused checkpoint can produce different findings.
  // The former aggregate must never override the results just validated.
  steps?.forget('review:whole')
  return steps ? steps.run('review:whole', label, input, async () => combined, validateCombined, parentId) : combined
}
