import type { GenerationPrivateWrite } from '../generation/generation-private-response.js'
import { TextRequestBudgetError } from '../../infrastructure/providers/text-request-usage.js'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { draftRepairOutput } from './script-draft-resolution.js'
import type { DraftRepairOutput } from './script-draft-repair-generation.js'
import type { GenerationSteps } from './script-generation-steps.js'
import { ScriptToolProblem, toolDiagnostic, revisionProblem, type ToolDiagnostic } from './script-revision.js'

type Edit = DraftRepairOutput['edits'][number] | DraftRepairOutput['source_edits'][number]
type Range = { source_key: string; start: number; end: number }
type Kind = 'candidate' | 'source'
type Operation = { operation_id: string; kind: Kind; edit: unknown; status: 'valid' | 'rejected' | 'merged'; merged_into?: string; correction_used?: boolean; conflict_id?: string; range?: Range; diagnostic?: ToolDiagnostic }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const same = (left: unknown, right: unknown) => hash(left) === hash(right)
const operationId = z.string().regex(/^op:[a-f0-9]{24}$/)
const rangeSchema = z.object({ source_key: z.string(), start: z.number().int().min(0), end: z.number().int().min(0) }).strict()
const diagnosticSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), repair: z.string(),
  document_id: z.string().optional(), title: z.string().optional(), item_index: z.number().optional(), path: z.string().optional(), limit: z.number().optional(), actual: z.number().optional() }).strict()

/** Private proposals are independent of business text. Every operation owns a
 * stable server ID; rejected proposals never authorize partial application. */
export function createRepairBatchLedger(issueIds: readonly string[], identity: unknown, steps?: GenerationSteps,
  inspect?: (edit: Edit, sourceOnly?: boolean) => Range, legacyIdentities: readonly unknown[] = []) {
  const decision = z.object({ issue_id: z.enum(issueIds as [string, ...string[]]), decision: draftRepairOutput.shape.decisions.element }).strict()
  const decisionsSchema = z.array(decision).max(issueIds.length)
  const candidate = draftRepairOutput.shape.edits.element, source = draftRepairOutput.shape.source_edits.element
  const shape = { decisions: decisionsSchema, summary: draftRepairOutput.shape.summary,
    edits: z.array(candidate.safeExtend({ operation_id: operationId.optional(), merge_operation_ids: z.array(operationId).min(1).max(200).optional() })).max(200),
    source_edits: z.array(source.safeExtend({ operation_id: operationId.optional(), merge_operation_ids: z.array(operationId).min(1).max(200).optional() })).max(200) }
  const batchSchema = z.object({ ...shape, complete: z.boolean() }).strict()
  // Parse the outer contract once, then diagnose operation schemas separately.
  const envelope = batchSchema.extend({ edits: z.array(z.unknown()).max(200), source_edits: z.array(z.unknown()).max(200) })
  const operationSchema = z.object({ operation_id: operationId, kind: z.enum(['candidate', 'source']), edit: z.unknown(),
    status: z.enum(['valid', 'rejected', 'merged']), merged_into: operationId.optional(), correction_used: z.boolean().optional(), conflict_id: z.string().optional(), range: rangeSchema.optional(), diagnostic: diagnosticSchema.optional() }).strict()
  const stateSchema = z.object({ decisions: decisionsSchema, summary: draftRepairOutput.shape.summary, operations: z.array(operationSchema).max(800), failed_submission: z.object({ raw: z.unknown(), correction_used: z.boolean() }).strict().optional(), last_turn: z.object({ raw: z.unknown(), processed: z.boolean(), correction_operation_ids: z.array(operationId).optional(), correction_submission: z.boolean().optional() }).strict().optional(), request_started: z.object({ request_key: z.string(), correction_operation_ids: z.array(operationId).optional(), correction_submission: z.boolean().optional() }).strict().optional(), output_page_size: z.number().int().min(1).max(8).optional(), output_limit_exhausted: z.boolean().optional(), completed_failures: z.array(z.object({ request_key: z.string().optional(), raw: z.unknown() }).strict()).max(4).optional() }).strict()
  // New operation semantics and actual wire schema have a new precise identity;
  // v1 batch values are never rebound to it merely because parsing succeeds.
  const input = { version: 2, identity, issue_ids: issueIds, schema: z.toJSONSchema(batchSchema, { io: 'input', unrepresentable: 'any' }) }
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const legacyEdit = z.object({ find: z.string().min(1).max(100000), replace: z.string().max(100000), reason: z.string().trim().min(1).max(2000) }).strict()
  const legacySchema = z.object({ decisions: decisionsSchema, summary: draftRepairOutput.shape.summary,
    edits: z.array(legacyEdit.safeExtend({ source_key: z.string().min(1).max(160) })).max(200), source_edits: z.array(legacyEdit).max(200) }).strict()
  const legacyEntry = steps?.checkpoint.steps['repair:tools:batches']
  const legacyIdentity = [identity, ...legacyIdentities].find(value => legacyEntry?.input_hash === createHash('sha256').update(JSON.stringify({ version: 1, identity: value, issue_ids: issueIds })).digest('hex'))
  const historical = legacyIdentity === undefined ? undefined : legacySchema.parse(legacyEntry!.value)
  // Preserve the exact historical completed-batch entry. New private IDs,
  // intents and raw turns live beside it, never under its old schema/hash.
  const id = historical ? 'repair:tools:operations' : 'repair:tools:batches'
  let state = stateSchema.parse({ decisions: historical?.decisions || [], summary: historical?.summary || '候选稿补丁尚未全部提交', operations: historical ? [
    ...historical.edits.map((edit, index) => ({ operation_id: `op:${hash([legacyEntry!.input_hash, 'candidate', index, edit]).slice(0, 24)}`, kind: 'candidate', edit, status: 'valid' })),
    ...historical.source_edits.map((edit, index) => ({ operation_id: `op:${hash([legacyEntry!.input_hash, 'source', index, edit]).slice(0, 24)}`, kind: 'source', edit, status: 'valid' })),
  ] : [] })
  const previous = steps?.checkpoint.steps[id]
  const privateWrite: GenerationPrivateWrite = { expected: previous && structuredClone(previous) }
  if (previous?.input_hash === inputHash) state = stateSchema.parse(previous.value)
  const verified = new Set<string>()
  const assertDecisions = (values: z.infer<typeof decisionsSchema>) => {
    if (new Set(values.map(item => item.issue_id)).size !== values.length) throw new Error('修订批次重复提交了同一问题决定')
  }
  assertDecisions(state.decisions)
  const snapshot = (value = state) => ({ decisions: structuredClone(value.decisions), summary: value.summary,
    edits: value.operations.flatMap(item => item.status === 'valid' && item.kind === 'candidate' ? [candidate.parse(item.edit)] : []),
    source_edits: value.operations.flatMap(item => item.status === 'valid' && item.kind === 'source' ? [source.parse(item.edit)] : []) })
  const aggregate = (value = state): DraftRepairOutput => ({ ...snapshot(value), decisions: issueIds.map(id => value.decisions.find(item => item.issue_id === id)?.decision || '') })
  const pending = (value = state) => value.operations.filter(item => item.status === 'rejected' || item.diagnostic)
  const progressKey = () => hash([state.decisions, state.operations.map(item => ({ id: item.operation_id, status: item.status, range: item.range,
    diagnostic: item.diagnostic && { code: item.diagnostic.code, document_id: item.diagnostic.document_id, path: item.diagnostic.path } }))])
  const locator = (kind: Kind, value: unknown) => {
    const edit = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return hash([kind, edit.source_key, edit.paragraph_id, edit.find])
  }
  const proposals = () => state.operations.map(item => ({ operation_id: item.operation_id, kind: item.kind, status: item.status,
    source_key: item.range?.source_key || (item.kind === 'source' ? 'script-source' : (item.edit as { source_key?: unknown })?.source_key),
    ...(item.conflict_id ? { conflict_id: item.conflict_id } : {}), ...(item.diagnostic ? { diagnostic: structuredClone(item.diagnostic) } : {}) }))
  const assertFinalPatch = (patch: DraftRepairOutput) => {
    if (pending().length) revisionProblem('repair_operations_pending', '仍有失败编辑或冲突组未纠正，不能声明全部完成', '仅按返回operation_id重交失败编辑；冲突组合并用merge_operation_ids，不得省略失败项来完成。')
    for (const item of state.decisions) if (patch.decisions[issueIds.indexOf(item.issue_id)] !== item.decision) throw new Error('完整提交改写了已接受的问题决定')
    const retained = snapshot()
    for (const field of ['edits', 'source_edits'] as const) if (retained[field].some(item => !patch[field].some(next => same(item, next)))) throw new Error('完整提交遗漏或改写了已接受的精确操作')
  }
  const persist = () => { steps?.retain(id, '保留有效提案与纠正耗用', input, state, value => stateSchema.parse(value), undefined, privateWrite) }
  const assertNoPendingRequest = () => {
    if (state.request_started) throw Object.assign(new Error('已有原生修订请求已发出但结果尚不确定，未重新发送；请由原恢复入口核对并处理'), {
      statusCode: 409, code: 'script_draft_native_request_unknown', delivery: 'unknown', outcome_certainty: 'unknown', request_key: state.request_started.request_key })
  }
  const claimCorrection = () => {
    assertNoPendingRequest()
    const failed = pending()
    if (!failed.length && !state.failed_submission) return
    if (failed.some(item => item.correction_used) || state.failed_submission?.correction_used) revisionProblem('repair_correction_exhausted', '本批失败提案的一次纠正已使用；已保留提案，未重发请求', '保留现有有效提案与失败诊断；不能通过续接重新支付同一次纠正。', { retryable: false })
    for (const op of failed) op.correction_used = true
    if (state.failed_submission) state.failed_submission.correction_used = true
  }
  return {
    unprocessedTurn: () => state.last_turn && !state.last_turn.processed ? structuredClone(state.last_turn.raw) : undefined,
    hasPendingRequest: () => !!state.request_started,
    hasCompletedFailure: () => !!state.completed_failures?.length,
    outputPageSize: () => state.output_page_size || 8,
    assertNoPendingRequest,
    claimTurn(requestKey: string, correction = false) {
      assertNoPendingRequest()
      if (state.output_limit_exhausted) revisionProblem('repair_output_limit_exhausted', '原生输出已完成有界收缩仍未返回完整操作，未续接重发', '保留有效提案与失败响应，不能通过重启重置收缩次数。', { retryable: false })
      const correctionIds = correction ? pending().map(item => item.operation_id) : undefined
      const correctionSubmission = correction && !!state.failed_submission
      if (correction) claimCorrection()
      state.request_started = { request_key: requestKey, ...(correction ? { correction_operation_ids: correctionIds, correction_submission: correctionSubmission } : {}) }; persist()
    },
    releaseRejectedTurn(issue: unknown) {
      if ((issue instanceof TextProviderError || issue instanceof TextRequestBudgetError) && 'delivery' in issue && ['not_sent', 'rejected'].includes(String(issue.delivery))) {
        // These requests were proved unaccepted. Release only the correction
        // reservation made by this particular intent, never an older budget.
        const request = state.request_started
        for (const id of request?.correction_operation_ids || []) { const op = state.operations.find(op => op.operation_id === id); if (op) delete op.correction_used }
        if (request?.correction_submission && state.failed_submission) state.failed_submission.correction_used = false
        delete state.request_started; persist()
      }
    },
    recordCompletedLimit(issue: TextProviderError) {
      if (issue.delivery !== 'completed') throw issue
      const request = state.request_started, size = state.output_page_size || 8
      const correction = request?.correction_operation_ids !== undefined
      state.completed_failures = [...state.completed_failures || [], { request_key: request?.request_key, raw: {
        name: issue.name, message: issue.message, delivery: issue.delivery, code: issue.upstreamCode,
        partial_text: issue.partialText, raw_output: issue.raw_output, diagnostics: issue.providerDiagnostics,
      } }]
      delete state.request_started
      state.output_page_size = Math.max(1, Math.floor(size / 2))
      state.output_limit_exhausted = correction || size === 1
      persist()
      return { page_size: state.output_page_size, exhausted: correction || size === 1 }
    },
    recordTurn(raw: unknown) { const request = state.request_started; state.last_turn = { raw: structuredClone(raw), processed: false, ...(request?.correction_operation_ids === undefined ? {} : { correction_operation_ids: request.correction_operation_ids, correction_submission: request.correction_submission }) }; delete state.request_started; persist() },
    finishTurn(readOnly = false) {
      if (state.last_turn) {
        if (readOnly) {
          for (const id of state.last_turn.correction_operation_ids || []) { const op = state.operations.find(op => op.operation_id === id); if (op) delete op.correction_used }
          if (state.last_turn.correction_submission && state.failed_submission) state.failed_submission.correction_used = false
        }
        state.last_turn.processed = true; persist()
      }
    },
    verifyRetained() {
      for (const op of state.operations) if (op.status === 'valid' && inspect && !verified.has(op.operation_id)) {
        op.range = inspect((op.kind === 'candidate' ? candidate : source).parse(op.edit), op.kind === 'source'); verified.add(op.operation_id)
      }
    },
    finishSubmission() { delete state.failed_submission; persist() },
    noteFailure(raw: unknown) {
      state.failed_submission = state.failed_submission || { raw: structuredClone(raw), correction_used: false }; persist()
    },
    claimCorrection() { claimCorrection(); persist() },
    failedSubmission: () => state.failed_submission && structuredClone(state.failed_submission),
    batchSchema, snapshot, aggregate, proposals, progressKey, assertFinalPatch,
    pending: () => structuredClone(pending()),
    accept(value: unknown, validatePatch: (patch: DraftRepairOutput) => void, validateFinal: (patch: DraftRepairOutput) => DraftRepairOutput) {
      const batch = envelope.parse(value); assertDecisions(batch.decisions)
      for (const decision of batch.decisions) {
        const retained = state.decisions.find(item => item.issue_id === decision.issue_id)
        if (retained && retained.decision !== decision.decision) throw new Error('已验证的问题决定不可在后续批次重新选择或改写')
      }
      const next = stateSchema.parse({ ...structuredClone(state), summary: batch.summary, decisions: [...new Map([...state.decisions, ...batch.decisions].map(item => [item.issue_id, item])).values()], operations: structuredClone(state.operations), ...(state.failed_submission ? { failed_submission: structuredClone(state.failed_submission) } : {}), ...(state.last_turn ? { last_turn: structuredClone(state.last_turn) } : {}), ...(state.request_started ? { request_started: structuredClone(state.request_started) } : {}) })
      const priorDecisionCount = state.decisions.length
      const priorValid = new Set(state.operations.filter(item => item.status === 'valid').map(item => item.operation_id))
      const byId = new Map<string, Operation>(next.operations.map(item => [item.operation_id, item]))
      const conflictGroups: Array<{ conflict_id: string; source_key: string; operation_ids: string[] }> = []
      for (const [kind, values] of [['candidate', batch.edits], ['source', batch.source_edits]] as const) values.forEach((raw, index) => {
        const field = kind === 'candidate' ? 'edits' : 'source_edits', path = `$.${field}[${index}]`
        const supplied = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        const { operation_id: requestedId, merge_operation_ids: mergeIds, ...body } = supplied
        const located = [...byId.values()].filter(item => item.kind === kind && locator(kind, item.edit) === locator(kind, body))
        const existing = typeof requestedId === 'string' ? byId.get(requestedId) : located.length === 1 ? located[0] : undefined
        const opId = existing?.operation_id || `op:${hash([inputHash, kind, index, locator(kind, body)]).slice(0, 24)}`
        let op: Operation = existing || { operation_id: opId, kind, edit: body, status: 'rejected' }
        const reject = (diagnostic: ToolDiagnostic) => { op.diagnostic = { ...diagnostic, path }; if (!priorValid.has(op.operation_id)) op.status = 'rejected'; byId.set(op.operation_id, op) }
        if (requestedId !== undefined && (!operationId.safeParse(requestedId).success || !existing || existing.kind !== kind)) {
          reject({ code: 'unknown_operation_id', message: 'operation_id不是本次已登记的服务器编辑身份', retryable: true, repair: '首次提交省略operation_id；纠正时逐字使用本次返回的失败operation_id。' }); return
        }
        if (existing?.status === 'merged') {
          revisionProblem('operation_already_merged', '该operation_id已作为冲突组合并解决', '保留合并结果，不重新提交已解决的旧操作。')
        }
        if (existing?.status === 'valid' && !same(existing.edit, body)) {
          reject({ code: 'accepted_operation_immutable', message: '已接受的有效提案不能在纠错中改写', retryable: true, repair: '保留原有效操作；仅纠正返回的失败operation_id。若误发此ID，请重新提交该ID原操作以解除本次错误。' }); return
        }
        const parsed = (kind === 'candidate' ? candidate : source).safeParse(body)
        if (!parsed.success) { op.edit = body; reject(toolDiagnostic(parsed.error, body)); return }
        try {
          const range = inspect?.(parsed.data, kind === 'source')
          op = { operation_id: opId, kind, edit: parsed.data, status: 'valid', ...(existing?.correction_used ? { correction_used: true } : {}), ...(range ? { range } : {}) }
          if (mergeIds !== undefined) {
            const ids = z.array(operationId).min(1).max(200).safeParse(mergeIds)
            const requested = ids.success ? [...new Set([...(existing ? [existing.operation_id] : []), ...ids.data])] : []
            const targets = requested.map(id => byId.get(id))
            const trusted = targets.length >= 2 && targets.every(target => target?.conflict_id === targets[0]?.conflict_id) && targets.every((target): target is Operation & { range: Range } => !!target && target.status === 'rejected' && !!target.conflict_id && !!target.range && target.range.source_key === range?.source_key)
            let component: Operation[] = []
            if (trusted) {
              component = [targets[0]!]
              for (let index = 0; index < component.length; index++) for (const other of byId.values()) {
                const current = component[index]!
                if (other.status === 'rejected' && other.conflict_id === current.conflict_id && !!other.conflict_id && other.range && !component.includes(other) &&
                  other.range.source_key === current.range!.source_key && other.range.start < current.range!.end && current.range!.start < other.range.end) component.push(other)
              }
            }
            const exactGroup = trusted && component.length === targets.length && component.every(target => requested.includes(target.operation_id))
            const exactUnion = exactGroup && !!range && range.start === Math.min(...targets.map(target => target!.range!.start)) && range.end === Math.max(...targets.map(target => target!.range!.end))
            if (!ids.success || !exactUnion) {
              // Failed merge attempts must not overwrite the original trusted
              // conflict ranges that bind the only permitted future merge.
              op = existing || { operation_id: opId, kind, edit: parsed.data, status: 'rejected' }
              reject({ code: 'invalid_operation_merge', message: '只能合并当前完整冲突组，且新范围须精确等于该组原可信范围并集', retryable: true, repair: '完整列出同一当前冲突组operation_id，沿用程序固定来源和原区间；不得扩大到组外、未读内容或吞并其他失败项及有效提案。' }); return
            }
            for (const target of targets) if (target!.operation_id !== opId) { target!.status = 'merged'; target!.merged_into = opId; delete target!.diagnostic }
          }
          byId.set(opId, op); verified.add(opId)
        } catch (issue) {
          if ((issue as { statusCode?: number })?.statusCode === 409 || issue instanceof Error && issue.name === 'AbortError') throw issue
          if (!(issue instanceof ScriptToolProblem) && !(issue instanceof z.ZodError) && !(issue instanceof Error && /场次估计时长|duration|小于等于|600/.test(issue.message))) throw issue
          op.edit = parsed.data; reject(toolDiagnostic(issue, body))
        }
      })
      // Revalidate restored proposals once per native session after its exact
      // documents have been re-read. Cached offsets alone never confer trust.
      for (const op of byId.values()) if (op.status === 'valid' && inspect && !verified.has(op.operation_id)) {
        op.range = inspect((op.kind === 'candidate' ? candidate : source).parse(op.edit), op.kind === 'source'); verified.add(op.operation_id)
      }
      const sorted = [...byId.values()].filter((op): op is Operation & { range: Range } => op.status === 'valid' && !!op.range)
        .sort((a, b) => a.range.source_key.localeCompare(b.range.source_key) || a.range.start - b.range.start)
      for (let index = 0; index < sorted.length;) {
        const group = [sorted[index++]!]; let end = group[0]!.range.end
        while (index < sorted.length && sorted[index]!.range.source_key === group[0]!.range.source_key && sorted[index]!.range.start < end) { const op = sorted[index++]!; group.push(op); end = Math.max(end, op.range.end) }
        if (group.length < 2) continue
        const ids = group.map(op => op.operation_id).sort(), sourceKey = group[0]!.range.source_key
        conflictGroups.push({ conflict_id: `conflict:${hash([sourceKey, ids]).slice(0, 24)}`, source_key: sourceKey, operation_ids: ids })
        for (const op of group) if (!priorValid.has(op.operation_id)) {
          op.status = 'rejected'; op.conflict_id = `conflict:${hash([sourceKey, ids]).slice(0, 24)}`; op.diagnostic = { code: 'overlapping_passages', message: '本组编辑范围相互重叠，尚未接受这些冲突提案', retryable: true,
            repair: '按本组operation_id分别纠正为不重叠操作；已接受的旧提案保持不变。所有失败ID均须解决后才可完成。', document_id: sourceKey }
        }
      }
      next.operations = [...byId.values()]
      state = stateSchema.parse(next)
      steps?.retain(id, '保留有效提案与待纠正编辑身份', input, state, value => stateSchema.parse(value), undefined, privateWrite)
      const patch = aggregate(), failed = pending()
      let final: DraftRepairOutput | undefined
      if (!failed.length) {
        if (patch.edits.length || patch.source_edits.length) validatePatch(patch)
        if (state.failed_submission && (state.operations.some(op => op.status === 'valid' && !priorValid.has(op.operation_id)) || state.decisions.length > priorDecisionCount)) { delete state.failed_submission; persist() }
        if (batch.complete) {
          if (state.decisions.length !== issueIds.length) throw new Error('修订批次仍有问题没有具体决定，不能声明全部完成')
          final = validateFinal(patch)
          delete state.failed_submission; persist()
        }
      }
      return { final, accepted_decisions: state.decisions.length, accepted_edits: patch.edits.length + patch.source_edits.length,
        accepted_operation_ids: state.operations.filter(item => item.status === 'valid').map(item => item.operation_id),
        rejected_operations: proposals().filter(item => item.status === 'rejected' || item.diagnostic), conflict_groups: conflictGroups,
        remaining_issue_ids: issueIds.filter(id => !state.decisions.some(item => item.issue_id === id)),
        correction: failed.length ? '仅重交rejected_operations中的operation_id及完整修正操作；重叠组可用merge_operation_ids显式合并，不能吞并其他失败项。不要重复、改写有效提案，不得忽略失败ID。所有修订仍针对同一冻结原文，最后统一原子校验。' : undefined,
        ready: !!final }
    },
  }
}
