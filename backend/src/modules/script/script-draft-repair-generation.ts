import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TextOutputLimitError } from '../../infrastructure/providers/text-errors.js'
import { modelStepSignal } from '../generation/model-execution.js'
import { generateStructuredOutput, isStructuredOutputError, type StructuredGenerator, type StructuredOutputCheckpoint } from '../generation/model-output.js'
import { draftRepairOutput } from './script-draft-resolution.js'
import { scriptDraftFindingLimit } from './script-finding-state.js'
import { generatePagedReviewItems } from './script-review-pagination.js'
import { recoverArrayStream } from './script-streamed-units.js'
import type { GenerationSteps } from './script-generation-steps.js'
import { draftLocalRepairPlanner } from './script-draft-local-repair.js'
import type { StructuredOutputLocalPlanner, StructuredOutputLocalRepair } from '../generation/model-output-local-repair.js'
import { applyResolvedEdits } from './script-revision.js'
import { frozenPassageReplacementFields } from './script-frozen-locators.js'
import type { GenerationPrivateWrite } from '../generation/generation-private-response.js'
import { scriptSceneDurationRepairInstructions, parseScriptSceneDurationReplacement } from './script-workflow.js'
import { createDraftRepairReferences, type DraftRepairReferenceIdentity, type DraftRepairReferenceSource } from './script-draft-repair-references.js'

export type DraftRepairOutput = z.infer<typeof draftRepairOutput>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Historical pagination schema must remain independent of the new canonical
// paragraph branch; both its field ordering and wire shape bind old pages.
const legacySourceEdit = z.object({ find: z.string().min(1).max(100000), ...frozenPassageReplacementFields }).strict()
const legacyCandidateEdit = z.object({ source_key: z.string().min(1).max(160), find: z.string().min(1).max(100000), ...frozenPassageReplacementFields }).strict()
const legacyEditsSchema = z.object({ summary: z.string().trim().min(1).max(3000), source_edits: z.array(legacySourceEdit).max(200), edits: z.array(legacyCandidateEdit).max(200) }).strict()
  .refine(value => value.edits.length > 0 || value.source_edits.length > 0, '至少提交一处候选草稿或文稿修订')
type RepairTiming = { unit: 'seconds'; estimated_total: number; target_duration?: number }

function repairIssueIds(value: readonly string[]): string[] {
  const ids = z.array(z.string().min(1)).min(1).max(scriptDraftFindingLimit).parse(value)
  if (new Set(ids).size !== ids.length) throw new Error('补齐问题身份必须逐项唯一')
  return ids
}

/** A protocol upgrade must resume exact structured work already accepted or
 * split into decisions/edits. The existing generator still validates each child. */
export function hasScriptDraftRepairCheckpoint(prompt: string, issueIds: readonly string[], steps?: GenerationSteps, timing?: RepairTiming): boolean {
  if (!steps) return false
  const ids = repairIssueIds(issueIds), timingInput = timing ? { timing } : {}
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  if (steps.checkpoint.steps.repair?.input_hash === hash({ prompt, ...timingInput })) return true
  const recovery = steps.checkpoint.steps['repair:recovery']
  return recovery?.input_hash === hash({ version: 1, prompt, issue_ids: ids, ...timingInput }) && recovery.value === 'decisions-then-edits'
}

/** State the actual count on the wire, before the model spends its output
 * budget. A fresh array replaces the generic 1..200 decision constraint. */
export function createScriptDraftRepairOutputSchema(issueIds: readonly string[]) {
  const ids = repairIssueIds(issueIds)
  return draftRepairOutput.safeExtend({
    decisions: z.array(draftRepairOutput.shape.decisions.element).length(ids.length, '具体决定必须逐项对应本次全部问题'),
  })
}

/** Explicit creator plans are already decisions. Keep their full UI contract
 * without expanding generated/native decision schemas or placing long values
 * into tool definitions. Their exact ordering and bytes remain authoritative. */
export function createAuthoritativeManualRepairSchema(issueIds: readonly string[], manualPlans: readonly string[]) {
  const ids = repairIssueIds(issueIds)
  const plans = z.array(z.string().trim().min(1).max(4000)).length(ids.length).parse([...manualPlans])
  const decisions = z.array(z.string().min(1).max(4000)).length(ids.length)
    .refine(value => value.every((decision, index) => decision === plans[index]), '具体决定必须逐项完整沿用本次用户方案，不得改写、缩短或换序')
  return { plans, schema: draftRepairOutput.safeExtend({ decisions }) }
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
    onRecovery?: () => void; timing?: RepairTiming; currentSource?: string; sources?: readonly DraftRepairReferenceSource[]; referenceIdentity?: DraftRepairReferenceIdentity } = {}): Promise<DraftRepairOutput> {
  const ids = repairIssueIds(issueIds), schema = createScriptDraftRepairOutputSchema(ids)
  const { steps, parentId } = options
  // Keep non-timing checkpoint identities compatible; scene timing context
  // must bind new repairs so a changed target cannot reuse an old decision.
  const timingInput = options.timing ? { timing: options.timing } : {}
  const legacyWholeInput = { prompt, ...timingInput }
  const currentReferences = options.sources?.length ? createDraftRepairReferences(options.sources, options.referenceIdentity) : undefined
  const sourceReferences = options.currentSource === undefined ? undefined : createDraftRepairReferences([{ key: 'script-source', content: options.currentSource }], options.referenceIdentity)
  const sourceWire = sourceReferences ? z.union([
    draftRepairOutput.shape.source_edits.element,
    z.object({ operation: z.literal('replace_ref'), ref_id: z.string().regex(/^r:[a-f0-9]{24}$/), ...frozenPassageReplacementFields }).strict(),
  ]).transform((edit, context) => {
    const parsed = sourceReferences.editSchema.safeParse({ ...edit, source_key: 'script-source' })
    if (!parsed.success) { parsed.error.issues.forEach(issue => context.addIssue({ code: 'custom', path: issue.path, message: issue.message })); return z.NEVER }
    const { source_key: _sourceKey, ...result } = parsed.data
    return result
  }) : draftRepairOutput.shape.source_edits.element
  const wholeWireSchema = currentReferences || sourceReferences ? schema.safeExtend({
    edits: z.array(currentReferences?.editSchema || draftRepairOutput.shape.edits.element).max(200), source_edits: z.array(sourceWire).max(200),
  }) : schema
  const input = currentReferences || sourceReferences ? { ...legacyWholeInput, locator_protocol: { version: 2,
    reference_identity: options.referenceIdentity, sources: options.sources, current_source: options.currentSource,
    schema: z.toJSONSchema(wholeWireSchema, { io: 'input', unrepresentable: 'any' }) } } : legacyWholeInput
  const checkpointCache = new Map<string, { checkpoint: StructuredOutputCheckpoint & { proposal_state?: unknown }; persistCheckpoint: () => void; guardInitialDispatch: boolean }>()
  const outputCheckpoint = (name: string, task: string, contract: z.ZodType) => {
    const identity = { version: 1, name, prompt: task, reference_identity: options.referenceIdentity,
      sources: options.sources, current_source: options.currentSource, schema: z.toJSONSchema(contract, { io: 'input', unrepresentable: 'any' }) }
    const cacheKey = hash(identity), cached = checkpointCache.get(cacheKey)
    if (cached) return cached
    const checkpointId = `repair:structured:${hash([name, task]).slice(0, 24)}`, previous = steps?.checkpoint.steps[checkpointId]
    const checkpointSchema = z.object({ input_hash: z.string().optional(), raw: z.string().optional(), original_raw: z.string().optional(),
      correction: z.object({ input_hash: z.string(), raw: z.string() }).strict().optional(),
      initial_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(),
      correction_started: z.object({ input_hash: z.string(), intent_id: z.string().optional() }).strict().optional(), proposal_state: z.unknown().optional() }).strict()
    const checkpoint: StructuredOutputCheckpoint & { proposal_state?: unknown } = previous?.input_hash === hash(identity) ? checkpointSchema.parse(structuredClone(previous.value)) : {}
    const privateWrite: GenerationPrivateWrite = { expected: previous && structuredClone(previous) }
    const journal = { checkpoint, guardInitialDispatch: true, persistCheckpoint: () => {
      const retained = steps?.retain(checkpointId, '保留完整提案及已使用纠正请求', identity, checkpoint, checkpointSchema.parse, parentId, privateWrite)
      if (retained) { for (const key of Object.keys(checkpoint)) delete checkpoint[key as keyof typeof checkpoint]; Object.assign(checkpoint, retained) }
    } }
    checkpointCache.set(cacheKey, journal); return journal
  }
  const localPlanner = (references: ReturnType<typeof createDraftRepairReferences> | undefined, editSchema: z.ZodType,
    sourceSchema: z.ZodType, decisions: unknown, journal: ReturnType<typeof outputCheckpoint>): StructuredOutputLocalPlanner => (candidate, failure) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const proposal = candidate as Record<string, unknown>, allowed = new Set(['summary', 'edits', 'source_edits', 'decisions'])
    if (Object.keys(proposal).some(key => !allowed.has(key)) || !draftRepairOutput.shape.summary.safeParse(proposal.summary).success ||
      !Array.isArray(proposal.edits) || !Array.isArray(proposal.source_edits) || 'decisions' in proposal && !schema.shape.decisions.safeParse(proposal.decisions).success) return
    const plans: Array<{ field: 'edits' | 'source_edits'; plan: StructuredOutputLocalRepair }> = [], states: unknown[] = []
    const onPlan = (state: unknown) => { states.push(state); journal.checkpoint.proposal_state = { proposals: states, correction_limit: 1 }; journal.persistCheckpoint() }
    for (const field of ['edits', 'source_edits'] as const) {
      const refs = field === 'edits' ? references : sourceReferences
      if (!refs || !(proposal[field] as unknown[]).length) continue
      const sourceList = field === 'edits' ? options.sources! : [{ key: 'script-source', content: options.currentSource! }]
      const plan = draftLocalRepairPlanner({ sources: sourceList, references: refs, editSchema: (field === 'edits' ? editSchema : sourceSchema) as Parameters<typeof draftLocalRepairPlanner>[0]['editSchema'],
        field, ...(field === 'source_edits' ? { sourceKey: 'script-source' } : {}), decisions: decisions ?? proposal.decisions,
        assertCurrent: () => modelStepSignal(options.signal)?.throwIfAborted(), onPlan })({ summary: proposal.summary, [field]: proposal[field] }, failure)
      if (plan) plans.push({ field, plan })
    }
    if (!plans.length) return
    return {
      schema: z.object(Object.fromEntries(plans.map(({ field, plan }) => [field, plan.schema]))).strict(),
      prompt: '仅返回本次列出的字段纠正外壳；每个字段内部严格返回其repairs。保留整包全部决定及其他有效提案，合并后完整校验。\n' + plans.map(({ field, plan }) => `【${field}】${plan.prompt}`).join('\n'),
      apply(patch) {
        const merged = structuredClone(proposal)
        for (const { field, plan } of plans) merged[field] = (plan.apply((patch as Record<string, unknown>)[field]) as Record<string, unknown>)[field]
        return merged
      },
    }
  }
  const recoveryInput = { version: 1, prompt, issue_ids: ids, ...timingInput }
  const previous = steps?.checkpoint.steps['repair:recovery']
  const recoveryHash = createHash('sha256').update(JSON.stringify(recoveryInput)).digest('hex')
  const recovery = previous?.input_hash === recoveryHash && previous.value === 'decisions-then-edits'
  const validate = (value: unknown): DraftRepairOutput => {
    const result = schema.parse(value)
    if (currentReferences) for (const key of new Set(result.edits.map(edit => edit.source_key))) {
      const source = options.sources!.find(source => source.key === key)
      if (!source) throw new Error('修订来源不属于当前冻结候选目录')
      const changes = currentReferences.resolveEdits(key, result.edits.filter(edit => edit.source_key === key))
      if (/^scene:\d+:duration$/.test(key)) parseScriptSceneDurationReplacement(applyResolvedEdits(source.content, changes))
    }
    if (sourceReferences && result.source_edits.length) sourceReferences.resolveEdits('script-source', result.source_edits)
    options.validate?.(result)
    return result
  }
  const label = '补齐候选设定'
  const issueInstructions = `本次共有 ${ids.length} 项问题，必须逐项覆盖，不合并、遗漏或新增问题。\n本次问题身份：${JSON.stringify(ids)}\n` +
    scriptSceneDurationRepairInstructions + (options.timing
      ? `\n本集时长上下文（只读）：${JSON.stringify(options.timing)}\n` +
        'estimated_total 是候选逐场估时的只读合计，target_duration 是本集明确时长目标；仅供核对，不是可替换来源，不能作为 source_key、quote 或补丁目标。' +
        '按下方每场完整对白、旁白、动作、人物反应和必要停顿核对估时。估时修补应保留完整对白与动作；时长修订在对应 scene:N:duration 来源写入合理整数，由程序重新计算合计。不能删减对白或遗漏动作凑目标；内容与明确目标确实冲突时说明具体冲突。\n'
      : '')
  if (!recovery) {
    try {
      // Reuse an old whole result only after exact input identity and current
      // canonical/range validation. A damaged old entry never dispatches under
      // its obsolete quote-only protocol.
      const retained = steps?.checkpoint.steps.repair
      let legacyWhole = false
      if (retained?.input_hash === hash(legacyWholeInput)) {
        try {
          const historical = schema.safeExtend({ source_edits: z.array(legacySourceEdit).max(200), edits: z.array(legacyCandidateEdit).max(200) }).parse(retained.value)
          validate(historical); legacyWhole = true
        } catch { steps!.forget('repair') }
      }
      let task = currentReferences ? currentReferences.introduction + currentReferences.prompt(prompt, 'front') : prompt
      if (sourceReferences) task = sourceReferences.introduction + sourceReferences.prompt(task, 'front')
      const wholePrompt = '【本次补齐的精确对应要求】\n' + issueInstructions +
        `decisions 必须恰好 ${ids.length} 项，顺序与问题身份及原任务问题顺序一致；每项写实际采用的具体决定，不能用活动摘要代替。\n` + task
      const whole = () => {
        if (legacyWhole) throw new Error('已验证旧整包缓存发生变化，未发起旧协议请求')
        const journal = outputCheckpoint('script_draft_repair', wholePrompt, wholeWireSchema)
        return generateStructuredOutput('script_draft_repair', wholeWireSchema, generate, wholePrompt, { signal: options.signal, validate, ...journal,
          planLocalRepair: localPlanner(currentReferences, currentReferences?.editSchema || draftRepairOutput.shape.edits.element, sourceWire, undefined, journal) })
      }
      return steps ? await steps.run('repair', label, legacyWhole ? legacyWholeInput : input, whole, validate, parentId) : validate(await whole())
    } catch (issue) {
      modelStepSignal(options.signal)?.throwIfAborted()
      if (issue && typeof issue === 'object' && 'code' in issue && ['structured_initial_delivery_pending', 'structured_correction_exhausted'].includes(String(issue.code))) throw issue
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
      itemSchema, prompt: decisionsPrompt, generate, steps, outputCheckpoint, signal: options.signal, parentId, initialItems: seed, maxItems: ids.length,
      validateItems: (items, complete) => {
        if (new Set(items.map(item => item.issue_id)).size !== items.length || complete && items.length !== ids.length) throw new Error('决定分页必须逐项覆盖全部问题且不能重复或重选')
      } }).then(decisions => validateDecisions({ decisions }))
    const pagingHash = createHash('sha256').update(JSON.stringify(pagingInput)).digest('hex')
    if (steps?.checkpoint.steps[pagingId]?.input_hash === pagingHash) return pages()
    try { return await generateStructuredOutput('script_draft_repair_decisions', decisionsSchema, generate, decisionsPrompt, { signal: options.signal, ...outputCheckpoint('script_draft_repair_decisions', decisionsPrompt, decisionsSchema) }) }
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
  const legacyEditsPrompt = '【自动恢复：落实已经确定的全部决定】\n' + issueInstructions +
    `本次已确定具体决定：${JSON.stringify(ledger.decisions)}\n` +
    '上述决定已经确定，必须全部落实并同步所有受影响的候选文档、分场与当前有效稿，不得改写、遗漏或重新决定。' +
    '本步骤只返回 edits、source_edits 和简短 summary，不返回 decisions。' +
    '仍按下方完整原任务的精确唯一引文、禁止重叠、保留无关正文与不保存等规则生成修订，不能使用上次未通过验证的补丁。' +
    '此阶段返回契约优先于原任务中的返回字段说明。\n' + prompt
  const editsPrefix = legacyEditsPrompt.slice(0, legacyEditsPrompt.length - prompt.length)
  const fallbackBoundary = '【当前精确编辑阶段】本阶段没有可调用工具，不发起读取、搜索或工作区操作；原任务中的工具说明只作历史资料。' +
    '所需候选文档均在紧随其后的冻结parts中完整提供，按目录逐份核对，末份结束后才是完整原任务与资料。' +
    '唯一返回任务是按本次Schema提交完整合法的编辑JSON，不输出工具调用、解释或索取资料。ref_id必须逐字使用本次给定值，不得使用中文占位、示意值或省略号。' +
    '本次已确定决定与完整原始反馈的范围均须落实；一条决定包含多个修订类别时，每类及直接关联文档都须同步，不能仅处理集数标注或部分问题。' +
    '原始反馈、用户要求和全文都保留在下方；既定决定是落实依据，不能用压缩决定摘要缩减原始反馈范围。\n'
  type References = ReturnType<typeof createDraftRepairReferences>
  const historicalReferences = options.sources?.length ? createDraftRepairReferences(options.sources, options.referenceIdentity, { legacy: true }) : undefined
  const front = (references: References) => editsPrefix + fallbackBoundary + references.introduction + references.prompt(prompt, 'front')
  const tail = (references: References) => editsPrefix + references.introduction + references.prompt(prompt)
  const legacyPageInstructions = '\n【完整操作分页】items每项kind=candidate或source，edit是完整精确操作。find始终定位上方不可变原文，不对照前批修改后的正文。全部决定均须落实后才可complete=true。'
  const positionPageInstructions = '\n【完整操作分页】items每项kind=candidate或source，edit是完整精确操作。整段优先使用本次冻结ref_id，后台保留paragraph_id；短find须当前唯一。所有定位同时针对不可变原文，禁止重叠；全部决定均须落实后才可complete=true。'
  const itemSchemaFor = (references: References | undefined, legacy: boolean) => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('candidate'), edit: references?.editSchema || (legacy ? legacyCandidateEdit : draftRepairOutput.shape.edits.element) }).strict(),
    z.object({ kind: z.literal('source'), edit: legacy ? legacySourceEdit : sourceWire }).strict(),
  ])
  const modes: Array<{ prompt: string; references?: References; legacy: boolean }> = [
    { prompt: legacyEditsPrompt, legacy: true },
    ...(historicalReferences ? [{ prompt: tail(historicalReferences), references: historicalReferences, legacy: true }, { prompt: front(historicalReferences), references: historicalReferences, legacy: true }] : []),
  ]
  let mode: { prompt: string; references?: References; legacy: boolean } = { prompt: currentReferences ? front(currentReferences) : legacyEditsPrompt, references: currentReferences, legacy: !currentReferences && !sourceReferences }
  if (sourceReferences) mode.prompt = sourceReferences.introduction + sourceReferences.prompt(mode.prompt, 'front')
  // Complete old edits take priority over stale pagination metadata, but only
  // a fully validated exact old value/page may select the historical schema.
  const retainedEdits = steps?.checkpoint.steps['repair:edits']
  const retainedPaging = steps?.checkpoint.steps['repair:edits:paging']
  for (const candidate of modes) {
    const candidateHash = hash({ prompt: candidate.prompt })
    if (retainedEdits?.input_hash === candidateHash) {
      try { validateEdits(legacyEditsSchema.parse(retainedEdits.value)); mode = candidate; break }
      catch { steps?.forget('repair:edits') }
    }
    if (retainedEdits && steps?.checkpoint.steps['repair:edits']) continue
    if (retainedPaging?.input_hash !== candidateHash || retainedPaging.value !== true) continue
    const item = itemSchemaFor(candidate.references, true)
    const pageInput = { version: 1, prompt: candidate.prompt + legacyPageInstructions,
      schema: z.toJSONSchema(item, { io: 'input', unrepresentable: 'any' }), max_items: 400 }
    const page = steps?.checkpoint.steps['repair:edits:pages']
    if (page?.input_hash !== hash(pageInput)) continue
    try {
      const state = z.object({ items: z.array(item).max(400), complete: z.boolean(), page_size: z.number().int().min(1).max(8) }).strict().parse(page.value)
      if (state.items.length) validateEdits({ summary: '复验旧分页完整操作', edits: state.items.flatMap(item => item.kind === 'candidate' ? [item.edit] : []), source_edits: state.items.flatMap(item => item.kind === 'source' ? [item.edit] : []) })
      else if (state.complete) continue
      mode = candidate; break
    } catch { /* Invalid or differently scoped pages never authorize an old protocol. */ }
  }
  const { prompt: editsPrompt, references, legacy } = mode
  const wireEditsSchema = legacy ? references ? z.object({ ...legacyEditsSchema.shape, edits: z.array(references.editSchema).max(200) }).strict()
    .refine(value => value.edits.length > 0 || value.source_edits.length > 0, '至少提交一处候选草稿或文稿修订') : legacyEditsSchema
    : z.object({ ...scriptDraftRepairEditsSchema.shape, edits: z.array(references?.editSchema || draftRepairOutput.shape.edits.element).max(200), source_edits: z.array(sourceWire).max(200) }).strict()
      .refine(value => value.edits.length > 0 || value.source_edits.length > 0, '至少提交一处候选草稿或文稿修订')
  const edit = async () => {
    const itemSchema = itemSchemaFor(references, legacy)
    const pagingInput = { prompt: editsPrompt }, pagingId = 'repair:edits:paging'
    let seed: z.infer<typeof itemSchema>[] = []
    const envelope = (items: z.infer<typeof itemSchema>[]) => ({ summary: `已按已确认决定完成 ${items.length} 处精确修订。`,
      edits: items.flatMap(item => item.kind === 'candidate' ? [item.edit] : []),
      source_edits: items.flatMap(item => item.kind === 'source' ? [item.edit] : []) })
    const pages = () => generatePagedReviewItems({ id: 'repair:edits:pages', name: 'script_draft_repair_edits', itemSchema,
      prompt: editsPrompt + (legacy ? legacyPageInstructions : positionPageInstructions),
      generate, steps, outputCheckpoint,
      localRepairPlanner: (name, task, contract) => (candidate, failure) => {
        const parsed = z.object({ items: z.array(z.unknown()).max(400), complete: z.boolean() }).strict().safeParse(candidate)
        if (!parsed.success || parsed.data.items.some(item => !item || typeof item !== 'object' || !('kind' in item) || !['candidate', 'source'].includes(String(item.kind)))) return
        const items = parsed.data.items as Array<{ kind: 'candidate' | 'source'; edit: unknown }>
        const projected = { summary: '仅纠正本页失败的完整编辑', edits: items.filter(item => item.kind === 'candidate').map(item => item.edit), source_edits: items.filter(item => item.kind === 'source').map(item => item.edit) }
        const plan = localPlanner(references, references?.editSchema || draftRepairOutput.shape.edits.element, legacy ? legacySourceEdit : sourceWire, decisions,
          outputCheckpoint(name, task, contract))(projected, failure)
        if (!plan) return
        return { ...plan, apply(patch) {
          const repaired = plan.apply(patch) as typeof projected, counters = { candidate: 0, source: 0 }
          return { ...parsed.data, items: items.map(item => ({ ...item, edit: repaired[item.kind === 'candidate' ? 'edits' : 'source_edits'][counters[item.kind]++] })) }
        } }
      }, signal: options.signal, parentId, initialItems: seed, maxItems: 400,
      validateItems: (items, complete) => {
        if (items.length) validateEdits(envelope(items))
        else if (complete) throw new Error('精确修订分页未返回任何有效操作')
      } }).then(items => validateEdits(envelope(items)))
    const pagingHash = createHash('sha256').update(JSON.stringify(pagingInput)).digest('hex')
    if (steps?.checkpoint.steps[pagingId]?.input_hash === pagingHash) return pages()
    try {
      const journal = outputCheckpoint('script_draft_repair_edits', editsPrompt, wireEditsSchema)
      return await generateStructuredOutput('script_draft_repair_edits', wireEditsSchema, generate, editsPrompt, { signal: options.signal, validate: validateEdits, ...journal,
        planLocalRepair: localPlanner(references, references?.editSchema || draftRepairOutput.shape.edits.element, legacy ? legacySourceEdit : sourceWire, decisions, journal) })
    }
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
