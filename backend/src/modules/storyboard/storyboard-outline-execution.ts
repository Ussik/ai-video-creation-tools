import { storyboardValueSignature } from './storyboard-review-scope.js'
export const storyboardOutlineExecutionKey = 'storyboard_outline_execution:v1'
export type OutlineReviewStage = 'reviewing' | 'repairing' | 'rechecking'
export function pendingOutlineDelivery(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const checkpoint = value as { initial_started?: unknown; raw?: unknown; correction_started?: unknown; correction?: unknown }
  return !!checkpoint.initial_started && checkpoint.raw === undefined
    || !!checkpoint.correction_started && checkpoint.correction === undefined
}
/** A legacy canonical outline may differ from its source checkpoint after
 * authorized dialogue normalization. A matching ledger group can conservatively
 * block unknown delivery; it never authorizes adoption or a replacement call. */
export function pendingOutlineRecheck(steps: Record<string, unknown>, outlineKey: string) {
  const keys = Object.keys(steps).filter(key => key.startsWith(`${outlineKey}:quality:v1:`)
    && /^[a-f0-9]{64}:recheck:structured_output:v1$/.test(key.slice(`${outlineKey}:quality:v1:`.length)))
  return keys.find(key => {
    const prefix = key.replace(/:recheck:structured_output:v1$/, '')
    return Object.hasOwn(steps, `${prefix}:report`) && Object.hasOwn(steps, `${prefix}:repair`) && pendingOutlineDelivery(steps[key])
  })
}
/** Infer only from matching application-owned checkpoints, never error text.
 * This is a read-only projection for legacy tasks with an outer generation stage. */
export function storyboardOutlineExecution(steps: Record<string, unknown>) {
  const marker = steps[storyboardOutlineExecutionKey] as { outline_key?: unknown; quality_prefix?: unknown; stage?: unknown } | undefined
  const keys = Object.keys(steps).filter(key => /^storyboard_batches:v1:(?:initial|repair):/.test(key) && key.endsWith(':outline'))
  const outlineKey = typeof marker?.outline_key === 'string' && keys.includes(marker.outline_key) ? marker.outline_key : keys.at(-1)
  if (!outlineKey) return undefined
  const pendingRecheck = pendingOutlineRecheck(steps, outlineKey)
  if (!pendingRecheck && marker?.outline_key === outlineKey && marker.stage === 'expanding') return undefined
  const markerPrefix = typeof marker?.quality_prefix === 'string' && marker.outline_key === outlineKey
    && marker.quality_prefix.startsWith(`${outlineKey}:quality:v1:`)
    && /^[a-f0-9]{64}$/.test(marker.quality_prefix.slice(`${outlineKey}:quality:v1:`.length)) ? marker.quality_prefix : undefined
  const prefix = pendingRecheck?.replace(/:recheck:structured_output:v1$/, '') || markerPrefix || `${outlineKey}:quality:v1:${storyboardValueSignature(steps[outlineKey])}`
  const hasRepair = Object.hasOwn(steps, `${prefix}:report`) && Object.hasOwn(steps, `${prefix}:repair`)
  let stage: OutlineReviewStage | undefined
  if (pendingRecheck || hasRepair && (Object.hasOwn(steps, `${prefix}:recheck:structured_output:v1`) || marker?.stage === 'rechecking')) stage = 'rechecking'
  else if (marker?.outline_key === outlineKey && ['reviewing', 'repairing', 'rechecking'].includes(String(marker.stage))) stage = marker.stage as OutlineReviewStage
  if (!stage) return undefined
  const outputKey = stage === 'rechecking' ? `${prefix}:recheck:structured_output:v1`
    : stage === 'repairing' ? `${prefix}:repair:structured_output:v1` : `${prefix}:report:structured_output:v1`
  return { outlineKey, stage, delivery_pending: pendingOutlineDelivery(steps[outputKey]) }
}
export function assertOutlineDeliveryResolved(checkpoint: unknown): void {
  if (!pendingOutlineDelivery(checkpoint)) return
  throw Object.assign(new Error('上次大纲请求已开始但未获得完整响应，交付状态尚未确认；检查点已保留，不会自动重发。'), {
    statusCode: 409, code: 'structured_initial_delivery_pending', failure_stage: 'recovery', delivery: 'unknown', retryable: false,
  })
}
