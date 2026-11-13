import { z } from 'zod'
import { createScriptRequestUsage, isTextRequestBudgetError, withTextRequestUsage,
  type ScriptRequestUsage } from '../../infrastructure/providers/text-request-usage.js'

export const modelWorkflowBudgetKey = 'model_workflow_budget:v1'
export type ModelWorkflowKind = 'script' | 'source_analysis' | 'visual_organization' | 'prompt_optimization' | 'video_understanding'
const labels: Record<ModelWorkflowKind, string> = { script: '本次剧本创作', source_analysis: '本次原稿分析',
  visual_organization: '本次视觉素材整理', prompt_optimization: '本次提示词优化', video_understanding: '本次视频理解' }
const maxGrants = 3
const maxGrantActiveMs = 7 * 24 * 60 * 60_000
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const allowanceSchema = z.object({ max_requests: integer.min(1), max_total_requests: integer.min(1),
  max_tokens: integer.min(1), max_active_ms: integer.min(1).max(maxGrantActiveMs) }).strict()
const reasonSchema = z.enum(['requests', 'tokens', 'duration'])
const checkpointSchema = z.object({ version: z.literal(1), kind: z.enum(['script', 'source_analysis', 'visual_organization', 'prompt_optimization', 'video_understanding']),
  grants: integer.min(1).max(maxGrants), allowance: allowanceSchema, active_ms: integer,
  exhausted: reasonSchema.optional(), usage: z.unknown() }).strict()
type Reason = z.infer<typeof reasonSchema>
export type ModelWorkflowBudgetCheckpoint = Omit<z.infer<typeof checkpointSchema>, 'usage'> & { usage: ScriptRequestUsage }

export class ModelWorkflowBudgetError extends Error {
  readonly code = 'model_workflow_budget_exceeded'
  readonly retryable = false
  readonly statusCode = 422
  constructor(public readonly kind: ModelWorkflowKind, public readonly reason: Reason, public readonly canResume: boolean) {
    super(`${labels[kind]}已达到本轮${reason === 'requests' ? '模型请求次数' : reason === 'tokens' ? ' token 用量' : '活跃执行时长'}上限，已完成的正文、证据与检查点均已保留。` +
      (canResume ? '检查后可继续，为未完成工作增加一次受限额度。' : '累计额度已用尽，请检查保留结果后重新发起。'))
    this.name = 'ModelWorkflowBudgetError'
  }
}
export function isModelWorkflowBudgetError(issue: unknown): issue is ModelWorkflowBudgetError {
  return issue instanceof ModelWorkflowBudgetError || !!issue && typeof issue === 'object' &&
    (issue as { code?: unknown }).code === 'model_workflow_budget_exceeded'
}

/** Size the whole execution, including intent, retrieval, continuation and
 * independent review. Long manuscripts receive substantially more room than
 * a short prompt; an existing allowance is never silently recalculated. */
export function modelWorkflowAllowance(kind: ModelWorkflowKind, scale: { units: number; inputChars: number }) {
  for (const value of [scale.units, scale.inputChars]) if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error('模型任务规模无效')
  }
  // Imported/UI counts may be inflated. Their operational scaling has a fixed
  // ceiling, and all three time grants remain below Node's timer limit.
  const units = Math.max(1, Math.min(1000, scale.units)), chars = Math.min(2_000_000, scale.inputChars), pages = Math.ceil(chars / 2000)
  const longForm = kind === 'script' || kind === 'source_analysis'
  const requests = (longForm ? 64 : 12) + units * (longForm ? 24 : 8) + pages * (longForm ? 8 : 2)
  const activeMs = Math.min(maxGrantActiveMs, ((longForm ? 60 : 10) + units * (longForm ? 15 : 3) + pages * (longForm ? 10 : 1)) * 60_000)
  return { max_requests: requests, max_total_requests: requests + Math.ceil(activeMs / 2000),
    max_tokens: requests * Math.max(96_000, Math.ceil(chars / 2) + 32_000), max_active_ms: activeMs }
}
function invalidCheckpoint(): never {
  throw Object.assign(new Error('模型任务预算检查点无效，不能清空已记录用量后自动重新请求。已保存结果仍保留，请检查后重新发起。'),
    { code: 'model_workflow_budget_invalid', statusCode: 409, retryable: false })
}
function restoreUsage(value: unknown): ScriptRequestUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidCheckpoint()
  const usage = structuredClone(value) as ScriptRequestUsage
  for (const key of ['requests', 'request_bytes', 'input_tokens', 'output_tokens', 'reasoning_tokens',
    'estimated_input_tokens', 'estimated_output_tokens', 'uncertain_requests'] as const) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) return invalidCheckpoint()
  }
  try { withTextRequestUsage({ usage }, () => {}) } catch { return invalidCheckpoint() }
  return usage
}
type Options = {
  kind: ModelWorkflowKind; scale: { units: number; inputChars: number }; steps: Record<string, unknown>;
  signal: AbortSignal; persist(): void; explicitResume?: boolean; legacyUsage?: unknown; activeDurationMs?: number
}
export async function runModelWorkflowBudget<T>(options: Options, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const saved = options.steps[modelWorkflowBudgetKey]
  let checkpoint: ModelWorkflowBudgetCheckpoint
  if (saved === undefined) checkpoint = { version: 1, kind: options.kind, grants: 1,
    allowance: modelWorkflowAllowance(options.kind, options.scale), active_ms: options.activeDurationMs ?? 0,
    usage: options.legacyUsage === undefined ? createScriptRequestUsage() : restoreUsage(options.legacyUsage) }
  else {
    const parsed = checkpointSchema.safeParse(saved)
    if (!parsed.success || parsed.data.kind !== options.kind) return invalidCheckpoint()
    checkpoint = { ...parsed.data, usage: restoreUsage(parsed.data.usage) }
  }
  if (!Number.isSafeInteger(checkpoint.active_ms) || checkpoint.active_ms < 0 ||
    checkpoint.allowance.max_total_requests < checkpoint.allowance.max_requests) return invalidCheckpoint()
  if (options.explicitResume && checkpoint.exhausted && checkpoint.grants < maxGrants) {
    checkpoint.grants++; delete checkpoint.exhausted
  }
  options.steps[modelWorkflowBudgetKey] = checkpoint
  options.persist()
  const exhaust = (reason: Reason) => {
    checkpoint.exhausted = reason; options.persist()
    return new ModelWorkflowBudgetError(options.kind, reason, checkpoint.grants < maxGrants)
  }
  if (checkpoint.exhausted) throw exhaust(checkpoint.exhausted)
  const remaining = checkpoint.allowance.max_active_ms * checkpoint.grants - checkpoint.active_ms
  if (remaining <= 0) throw exhaust('duration')
  options.signal.throwIfAborted()
  const controller = new AbortController(), signal = controller.signal
  const started = Date.now(), previous = checkpoint.active_ms
  let active = true
  const persist = () => {
    if (!active || options.steps[modelWorkflowBudgetKey] !== checkpoint) return
    checkpoint.active_ms = previous + Math.max(0, Date.now() - started)
    options.persist()
  }
  const parentAbort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', parentAbort, { once: true })
  let rejectAbort: (reason: unknown) => void = () => {}
  const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = () => rejectAbort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    try { persist(); controller.abort(exhaust('duration')) } catch (issue) { controller.abort(issue) }
  }, remaining)
  timer.unref()
  const clock = setInterval(() => { try { persist() } catch (issue) { controller.abort(issue) } }, 5000)
  clock.unref()
  try {
    return await withTextRequestUsage({ usage: checkpoint.usage, limits: {
      max_requests: checkpoint.allowance.max_requests * checkpoint.grants,
      max_total_requests: checkpoint.allowance.max_total_requests * checkpoint.grants,
      max_tokens: checkpoint.allowance.max_tokens * checkpoint.grants,
    }, budgetLabel: labels[options.kind], signal, onUpdate(_usage, phase) {
      if (!active || options.steps[modelWorkflowBudgetKey] !== checkpoint) return
      if (phase === 'reservation') persist()
      else { try { persist() } catch (issue) { console.error('模型任务已完成请求的预算核对保存失败', issue) } }
    } }, () => Promise.race([work(signal), stopped]))
  } catch (issue) {
    if (signal.aborted) throw signal.reason
    if (isTextRequestBudgetError(issue) && issue.budgetLabel === labels[options.kind]) throw exhaust(issue.reason)
    throw issue
  } finally {
    // A stale settlement may update its abandoned ledger but cannot write over
    // a resumed execution. Dispatch admission closes even for detached work.
    try { persist() } finally {
      active = false; clearTimeout(timer); clearInterval(clock)
      options.signal.removeEventListener('abort', parentAbort); signal.removeEventListener('abort', abort)
      controller.abort(new DOMException('模型任务执行作用域已结束', 'AbortError'))
    }
  }
}
