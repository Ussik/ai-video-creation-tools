import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from './model-task-policy.js'

import { safeModelResult, type ModelOperationStage, type ModelResultEvent } from '../../infrastructure/observability/model-results.js'
export * from '../../infrastructure/observability/model-results.js'

export function withModelOperationStage<T>(stage: ModelOperationStage, work: () => T, unit?: { unit_index?: number; unit_count?: number; scene_id?: string; shot_id?: string; field_path?: string; checkpoint_reused?: boolean }): T {
  const parent = currentModelRequestContext()
  return withModelRequestContext({ ...parent, policy: parent?.policy || modelTaskPolicies.text, operationStage: stage,
    operationStartedAt: Date.now(), operationUnit: unit }, work)
}
/** Result reporting is diagnostic; a missing or failed sink never changes
 * validation, quality approval, dispatch or retries. */
export function reportModelResult(value: ModelResultEvent): void {
  const context = currentModelRequestContext()
  const event = safeModelResult({ ...context?.resultDetails, scene_id: context?.operationUnit?.scene_id, shot_id: context?.operationUnit?.shot_id, field_path: context?.operationUnit?.field_path, ...value, stage: value.stage || context?.operationStage,
    duration_ms: value.duration_ms ?? (context?.operationStartedAt === undefined ? undefined : Math.max(0, Date.now() - context.operationStartedAt)),
    unit_index: value.unit_index ?? context?.operationUnit?.unit_index, unit_count: value.unit_count ?? context?.operationUnit?.unit_count })
  if (event) { try { context?.onResult?.(event) } catch { /* Diagnostics cannot authorize or invalidate creative work. */ } }
}
