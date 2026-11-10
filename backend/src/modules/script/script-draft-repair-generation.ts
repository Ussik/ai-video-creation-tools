import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TextOutputLimitError } from '../../infrastructure/providers/text-errors.js'
import { modelStepSignal } from '../generation/model-execution.js'
import { generateStructuredOutput, isStructuredOutputError, type StructuredGenerator } from '../generation/model-output.js'
import { draftRepairOutput } from './script-draft-resolution.js'
import { scriptDraftFindingLimit } from './script-finding-state.js'
import { generatePagedReviewItems } from './script-review-pagination.js'
import { recoverArrayStream } from './script-streamed-units.js'
import type { GenerationSteps } from './script-generation-steps.js'

export type DraftRepairOutput = z.infer<typeof draftRepairOutput>

function repairIssueIds(value: readonly string[]): string[] {
  const ids = z.array(z.string().min(1)).min(1).max(scriptDraftFindingLimit).parse(value)
  if (new Set(ids).size !== ids.length) throw new Error('补齐问题身份必须逐项唯一')
  return ids
}

/** State the actual count on the wire, before the model spends its output
 * budget. A fresh array replaces the generic 1..200 decision constraint. */
export function createScriptDraftRepairOutputSchema(issueIds: readonly string[]) {
  const ids = repairIssueIds(issueIds)
  return draftRepairOutput.safeExtend({
    decisions: z.array(draftRepairOutput.shape.decisions.element).length(ids.length, '具体决定必须逐项对应本次全部问题'),
  })
}

export function createScriptDraftRepairDecisionsSchema(issueIds: readonly string[]) {
  const ids = repairIssueIds(issueIds)
  return z.object({ decisions: z.array(z.object({
    issue_id: z.enum(ids as [string, ...string[]]),
    decision: draftRepairOutput.shape.decisions.element,
  }).strict()).length(ids.length, '具体决定必须逐项对应本次全部问题') }).strict().superRefine((value, context) => {
    const seen = new Set<string>()
    value.decisions.forEach((item, index) => {
      if (seen.has(item.issue_id)) context.addIssue({ code: 'custom', path: ['decisions', index, 'issue_id'],
        message: '每项问题必须有且仅有一个具体决定，不得重复问题身份或遗漏其他问题' })
      seen.add(item.issue_id)
    })
  })
}

export const scriptDraftRepairEditsSchema = z.object({
  summary: draftRepairOutput.shape.summary,
  source_edits: draftRepairOutput.shape.source_edits,
  edits: draftRepairOutput.shape.edits,
}).strict().refine(value => value.edits.length > 0 || value.source_edits.length > 0, '至少提交一处候选草稿或文稿修订')

/** A whole repair owns its own bounded model step. Only an exhausted output
 * or this exact contract's failure switches once to decisions, then edits.
 * Both stages still receive the complete work and share the caller's request
 * budget and cancellation scope. Failed/partial whole patches are never used. */
export async function generateScriptDraftRepairOutput(prompt: string, issueIds: readonly string[], generate: StructuredGenerator,
  options: { signal?: AbortSignal; steps?: GenerationSteps; parentId?: string; validate?: (value: DraftRepairOutput) => void;
    onRecovery?: () => void } = {}): Promise<DraftRepairOutput> {
  const ids = repairIssueIds(issueIds), schema = createScriptDraftRepairOutputSchema(ids)
  const { steps, parentId } = options
  const input = { prompt } // Retain the identity of already validated whole-repair checkpoints.
  const recoveryInput = { version: 1, prompt, issue_ids: ids }
  const previous = steps?.checkpoint.steps['repair:recovery']
  const recoveryHash = createHash('sha256').update(JSON.stringify(recoveryInput)).digest('hex')
  const recovery = previous?.input_hash === recoveryHash && previous.value === 'decisions-then-edits'
  const validate = (value: unknown): DraftRepairOutput => {
    const result = schema.parse(value)
    options.validate?.(result)
    return result
  }
  const label = '补齐候选设定'
  const issueInstructions = `本次共有 ${ids.length} 项问题，必须逐项覆盖，不合并、遗漏或新增问题。\n本次问题身份：${JSON.stringify(ids)}\n`
  if (!recovery) {
    try {
      const wholePrompt = '【本次补齐的精确对应要求】\n' + issueInstructions +
        `decisions 必须恰好 ${ids.length} 项，顺序与问题身份及原任务问题顺序一致；每项写实际采用的具体决定，不能用活动摘要代替。\n` + prompt
      const whole = () => generateStructuredOutput('script_draft_repair', schema, generate, wholePrompt,
        { signal: options.signal, validate: options.validate })
      return steps ? await steps.run('repair', label, input, whole, validate, parentId) : validate(await whole())
    } catch (issue) {
      modelStepSignal(options.signal)?.throwIfAborted()
      if (!(issue instanceof TextOutputLimitError) &&
        !(isStructuredOutputError(issue) && issue.structuredOutputContract === 'script_draft_repair')) throw issue
      steps?.retain('repair:recovery', '自动分开确定具体决定与精确修订', recoveryInput, 'decisions-then-edits', value => {
        if (value !== 'decisions-then-edits') throw new Error('无效的候选补齐恢复策略')
        return value
      }, parentId)
    }
  }
  modelStepSignal(options.signal)?.throwIfAborted()
  // A recovery aggregate is valid only with its current validated children.
  // Remove it before replay so a damaged child cannot leave false N/N progress
  // behind when its replacement request fails or is cancelled.
  steps?.forget('repair')
  options.onRecovery?.()
  const decisionsSchema = createScriptDraftRepairDecisionsSchema(ids)
  const validateDecisions = (value: unknown) => {
    const result = decisionsSchema.parse(value)
    const byId = new Map(result.decisions.map(item => [item.issue_id, item]))
    return { decisions: ids.map(id => byId.get(id)!) }
  }
  const decisionsPrompt = '【自动恢复：先完整确定全部具体决定】\n' + issueInstructions +
    '本步骤只返回 decisions，每项包含 issue_id 和 decision，不生成补丁、summary 或正文。每个问题身份恰好出现一次。' +
    '沿用用户方案、原稿明确事实与已确认决定；只有尚未确定的 AI 委托事项才作出实际具体决定，不再次询问。' +
    '结合下方完整有效稿、全部候选文档、原始创作要求和所有关联问题，确保各项决定相互一致。' +
    '此阶段返回契约优先于原任务中的补丁格式要求，原任务全文仅作为决定所需的范围、规则与资料。\n' + prompt
  const decide = async () => {
    const itemSchema = createScriptDraftRepairDecisionsSchema(ids).shape.decisions.element
    const pagingInput = { prompt: decisionsPrompt }, pagingId = 'repair:decisions:paging'
    let seed: z.infer<typeof itemSchema>[] = []
    const pages = () => generatePagedReviewItems({ id: 'repair:decisions:pages', name: 'script_draft_repair_decisions',
      itemSchema, prompt: decisionsPrompt, generate, steps, signal: options.signal, parentId, initialItems: seed, maxItems: ids.length,
      validateItems: (items, complete) => {
        if (new Set(items.map(item => item.issue_id)).size !== items.length || complete && items.length !== ids.length) throw new Error('决定分页必须逐项覆盖全部问题且不能重复或重选')
      } }).then(decisions => validateDecisions({ decisions }))
    const pagingHash = createHash('sha256').update(JSON.stringify(pagingInput)).digest('hex')
    if (steps?.checkpoint.steps[pagingId]?.input_hash === pagingHash) return pages()
    try { return await generateStructuredOutput('script_draft_repair_decisions', decisionsSchema, generate, decisionsPrompt, { signal: options.signal }) }
    catch (issue) {
      modelStepSignal(options.signal)?.throwIfAborted()
      if (!(issue instanceof TextOutputLimitError)) throw issue
      seed = recoverArrayStream(issue.partialText, 'decisions').map(item => itemSchema.parse(item))
      steps?.retain(pagingId, '决定输出超限，保留完整决定后分批继续', pagingInput, true, z.literal(true).parse, parentId)
      return pages()
    }
  }
  const ledger = steps ? await steps.run('repair:decisions', '逐项确定全部具体决定', { prompt: decisionsPrompt }, decide,
    validateDecisions, parentId) : validateDecisions(await decide())
  modelStepSignal(options.signal)?.throwIfAborted()
  const decisions = ledger.decisions.map(item => item.decision)
  const validateEdits = (value: unknown) => {
    const edits = scriptDraftRepairEditsSchema.parse(value)
    validate({ ...edits, decisions })
    return edits
  }
  const editsPrompt = '【自动恢复：落实已经确定的全部决定】\n' + issueInstructions +
    `本次已确定具体决定：${JSON.stringify(ledger.decisions)}\n` +
    '上述决定已经确定，必须全部落实并同步所有受影响的候选文档、分场与当前有效稿，不得改写、遗漏或重新决定。' +
    '本步骤只返回 edits、source_edits 和简短 summary，不返回 decisions。' +
    '仍按下方完整原任务的精确唯一引文、禁止重叠、保留无关正文与不保存等规则生成修订，不能使用上次未通过验证的补丁。' +
    '此阶段返回契约优先于原任务中的返回字段说明。\n' + prompt
  const edit = async () => {
    const itemSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('candidate'), edit: draftRepairOutput.shape.edits.element }).strict(),
      z.object({ kind: z.literal('source'), edit: draftRepairOutput.shape.source_edits.element }).strict(),
    ])
    const pagingInput = { prompt: editsPrompt }, pagingId = 'repair:edits:paging'
    let seed: z.infer<typeof itemSchema>[] = []
    const envelope = (items: z.infer<typeof itemSchema>[]) => ({ summary: `已按已确认决定完成 ${items.length} 处精确修订。`,
      edits: items.flatMap(item => item.kind === 'candidate' ? [item.edit] : []),
      source_edits: items.flatMap(item => item.kind === 'source' ? [item.edit] : []) })
    const pages = () => generatePagedReviewItems({ id: 'repair:edits:pages', name: 'script_draft_repair_edits', itemSchema,
      prompt: editsPrompt + '\n【完整操作分页】items每项kind=candidate或source，edit是完整精确操作。find始终定位上方不可变原文，不对照前批修改后的正文。全部决定均须落实后才可complete=true。',
      generate, steps, signal: options.signal, parentId, initialItems: seed, maxItems: 400,
      validateItems: (items, complete) => {
        if (items.length) validateEdits(envelope(items))
        else if (complete) throw new Error('精确修订分页未返回任何有效操作')
      } }).then(items => validateEdits(envelope(items)))
    const pagingHash = createHash('sha256').update(JSON.stringify(pagingInput)).digest('hex')
    if (steps?.checkpoint.steps[pagingId]?.input_hash === pagingHash) return pages()
    try { return await generateStructuredOutput('script_draft_repair_edits', scriptDraftRepairEditsSchema, generate, editsPrompt, { signal: options.signal, validate: validateEdits }) }
    catch (issue) {
      modelStepSignal(options.signal)?.throwIfAborted()
      if (!(issue instanceof TextOutputLimitError)) throw issue
      seed = [...recoverArrayStream(issue.partialText, 'edits').map(edit => itemSchema.parse({ kind: 'candidate', edit })),
        ...recoverArrayStream(issue.partialText, 'source_edits').map(edit => itemSchema.parse({ kind: 'source', edit }))]
      steps?.retain(pagingId, '编辑输出超限，保留完整操作后分批继续', pagingInput, true, z.literal(true).parse, parentId)
      return pages()
    }
  }
  const edits = steps ? await steps.run('repair:edits', '按全部已确定决定精确修订', { prompt: editsPrompt }, edit,
    validateEdits, parentId) : validateEdits(await edit())
  modelStepSignal(options.signal)?.throwIfAborted()
  const combined = validate({ ...edits, decisions })
  // A changed child checkpoint must replace the old aggregate. Completing the
  // same step also replaces its earlier failure in the activity panel.
  steps?.forget('repair')
  return steps ? steps.run('repair', label, input, async () => combined, validate, parentId) : combined
}
