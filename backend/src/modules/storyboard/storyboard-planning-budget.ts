import { z } from 'zod'
import { createScriptRequestUsage, isTextRequestBudgetError, withTextRequestUsage,
  type ScriptRequestUsage, type TextRequestBudgetError } from '../../infrastructure/providers/text-request-usage.js'

export const storyboardPlanningBudgetKey = 'storyboard_task_budget:v1'
const budgetLabel = '本次分镜规划'
export const storyboardPlanningBudgetPolicy = { maxGrants: 3, requestsPerShot: 6, requestsPerScene: 3,
  baseRequests: 12, tokensPerRequest: 64_000, pollIntervalMs: 2000, baseMinutes: 10, minutesPerShot: 2, minutesPerScene: 2 } as const
const maxGrants = storyboardPlanningBudgetPolicy.maxGrants
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const allowanceSchema = z.object({ max_requests: integer.min(1), max_total_requests: integer.min(1),
  max_tokens: integer.min(1), max_active_ms: integer.min(1) }).strict()
const reasonSchema = z.enum(['requests', 'tokens', 'duration'])
const checkpointSchema = z.object({ version: z.literal(1), grants: integer.min(1).max(maxGrants),
  allowance: allowanceSchema, exhausted: reasonSchema.optional(), usage: z.unknown() }).strict()
type Allowance = z.infer<typeof allowanceSchema>
type Reason = z.infer<typeof reasonSchema>
export type StoryboardPlanningBudgetCheckpoint = {
  version: 1; grants: number; allowance: Allowance; exhausted?: Reason; usage: ScriptRequestUsage
}

export class StoryboardPlanningBudgetError extends Error {
  readonly code = 'storyboard_planning_budget_exceeded'
  readonly retryable = false
  readonly statusCode = 422
  constructor(public readonly reason: Reason, public readonly canResume: boolean) {
    super(`分镜规划已达到本轮${reason === 'requests' ? '模型请求次数' : reason === 'tokens' ? ' token 用量' : '活跃执行时长'}上限，已保留检查点和已验证草稿。` +
      (canResume ? '可检查后点击继续，为未完成阶段增加一次受限额度。' : '累计总上限已用尽，请检查结果后重新规划。'))
    this.name = 'StoryboardPlanningBudgetError'
  }
}

/** Review recovery must never turn an execution budget stop into success. */
export function isStoryboardPlanningBudgetError(issue: unknown): issue is StoryboardPlanningBudgetError | TextRequestBudgetError {
  return issue instanceof StoryboardPlanningBudgetError || isTextRequestBudgetError(issue) || !!issue && typeof issue === 'object' &&
    (issue as { code?: unknown }).code === 'storyboard_planning_budget_exceeded'
}

/** Conservative operational guardrails, not price estimates. Persist once so
 * changing external content cannot silently raise a resumed task's allowance. */
export function storyboardPlanningAllowance(input: unknown): Allowance {
  const source = input && typeof input === 'object' ? input as { scene_ids?: unknown; shots_per_scene?: unknown } : {}
  const scenes = Array.isArray(source.scene_ids) ? Math.max(1, Math.min(10, source.scene_ids.length)) : 1
  const perScene = typeof source.shots_per_scene === 'number' && Number.isFinite(source.shots_per_scene)
    ? Math.max(2, Math.min(30, Math.round(source.shots_per_scene))) : 8
  const shots = scenes * perScene, policy = storyboardPlanningBudgetPolicy
  const requests = policy.baseRequests + policy.requestsPerShot * shots + policy.requestsPerScene * scenes
  const activeMs = (policy.baseMinutes + policy.minutesPerShot * shots + policy.minutesPerScene * scenes) * 60_000
  // Background inference polls every two seconds; bound that traffic without
  // spending the generation quota on a legitimately slow accepted response.
  return { max_requests: requests, max_total_requests: requests + Math.ceil(activeMs / policy.pollIntervalMs),
    max_tokens: requests * policy.tokensPerRequest, max_active_ms: activeMs }
}

function invalidCheckpoint(): never {
  throw Object.assign(new Error('分镜规划预算检查点无效，不能清空用量后重新派发，请重新规划。'),
    { code: 'storyboard_planning_budget_invalid', statusCode: 409, retryable: false })
}
function restoreUsage(value: unknown): ScriptRequestUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidCheckpoint()
  const usage = structuredClone(value) as ScriptRequestUsage
  // Core counters existed before this budget. Missing core fields are a
  // corrupt ledger, rather than an older optional diagnostic field.
  for (const key of ['requests', 'request_bytes', 'input_tokens', 'output_tokens', 'reasoning_tokens',
    'estimated_input_tokens', 'estimated_output_tokens', 'uncertain_requests'] as const) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) return invalidCheckpoint()
  }
  try { withTextRequestUsage({ usage }, () => {}) } catch { return invalidCheckpoint() }
  return usage
}

type BudgetOptions = {
  input: unknown
  steps: Record<string, unknown>
  /** Already settled active time only; exclude the current launch interval. */
  activeDurationMs: number
  signal: AbortSignal
  persist(): void
  explicitResume?: boolean
  /** Existing durable observation, used only to migrate pre-budget tasks. */
  legacyUsage?: unknown
}

export async function runStoryboardPlanningBudget<T>(options: BudgetOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const { steps } = options
  if (!Number.isSafeInteger(options.activeDurationMs) || options.activeDurationMs < 0) return invalidCheckpoint()
  const saved = steps[storyboardPlanningBudgetKey]
  let checkpoint: StoryboardPlanningBudgetCheckpoint
  if (saved === undefined) {
    checkpoint = { version: 1, grants: 1, allowance: storyboardPlanningAllowance(options.input),
      usage: options.legacyUsage === undefined ? createScriptRequestUsage() : restoreUsage(options.legacyUsage) }
  } else {
    const parsed = checkpointSchema.safeParse(saved)
    if (!parsed.success) return invalidCheckpoint()
    checkpoint = { ...parsed.data, usage: restoreUsage(parsed.data.usage) }
  }
  if (checkpoint.allowance.max_total_requests < checkpoint.allowance.max_requests) return invalidCheckpoint()
  // An ordinary reconnect or idempotent request replay never buys more work.
  if (options.explicitResume && checkpoint.exhausted && checkpoint.grants < maxGrants) {
    checkpoint.grants++
    delete checkpoint.exhausted
  }
  steps[storyboardPlanningBudgetKey] = checkpoint
  options.persist()
  const limits = { max_requests: checkpoint.allowance.max_requests * checkpoint.grants,
    max_total_requests: checkpoint.allowance.max_total_requests * checkpoint.grants,
    max_tokens: checkpoint.allowance.max_tokens * checkpoint.grants }
  const exhaust = (reason: Reason) => {
    checkpoint.exhausted = reason
    options.persist()
    return new StoryboardPlanningBudgetError(reason, checkpoint.grants < maxGrants)
  }
  if (checkpoint.exhausted) throw exhaust(checkpoint.exhausted)
  const remainingMs = checkpoint.allowance.max_active_ms * checkpoint.grants - options.activeDurationMs
  if (remainingMs <= 0) throw exhaust('duration')
  options.signal.throwIfAborted()
  const controller = new AbortController(), signal = controller.signal
  let active = true
  const parentAbort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', parentAbort, { once: true })
  let rejectAbort: (reason: unknown) => void = () => {}
  const abort = () => rejectAbort(signal.reason)
  const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    try { controller.abort(exhaust('duration')) }
    catch (issue) { controller.abort(issue) }
  }, remainingMs)
  timer.unref()
  try {
    return await withTextRequestUsage({ usage: checkpoint.usage, limits, budgetLabel, signal,
      // A late completion from an abandoned scope must not overwrite a newer
      // resumed checkpoint. Its conservative reservation remains recoverable.
      onUpdate(_usage, phase) {
        if (!active || steps[storyboardPlanningBudgetKey] !== checkpoint) return
        if (phase === 'reservation') options.persist()
        else { try { options.persist() } catch (issue) { console.error('分镜规划已完成请求的预算核对保存失败', issue) } }
      },
    }, () => Promise.race([work(signal), stopped]))
  } catch (issue) {
    if (signal.aborted) throw signal.reason
    if (isTextRequestBudgetError(issue) && issue.budgetLabel === budgetLabel) throw exhaust(issue.reason)
    throw issue
  } finally {
    active = false
    clearTimeout(timer)
    options.signal.removeEventListener('abort', parentAbort)
    signal.removeEventListener('abort', abort)
    // Close dispatch admission even if an ill-behaved async worker ignores its
    // deadline and outlives Promise.race. Completion metrics can still settle.
    controller.abort(new DOMException('分镜规划执行作用域已结束', 'AbortError'))
  }
}
