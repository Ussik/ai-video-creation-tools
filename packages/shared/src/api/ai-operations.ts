export const aiOperationHeader = 'x-ai-operation-id'
export type AiOperationState = 'running' | 'completed' | 'failed' | 'interrupted'
export type AiOutcomeCertainty = 'not_dispatched' | 'unknown' | 'accepted' | 'completed'
export type AiRecoveryAction = { kind: 'observe' | 'edit_candidate' | 'review_candidate' | 'query_upstream' | 'download_result' | 'verify_upstream' | 'none'; operation_id?: string; task_id?: string }
export type AiFailureReason = 'configuration' | 'authentication' | 'capacity' | 'rate_limit' | 'network' | 'protocol' | 'json_syntax' | 'field_contract' | 'business' | 'quality' | 'cancelled' | 'unknown_result' | 'media_validation'
export type AiFailureStage = 'prepare' | 'create' | 'query' | 'download' | 'decode' | 'validate' | 'store'
export type AiOperationError = { code: string; category: string; message: string; retryable: boolean; outcome_certainty: AiOutcomeCertainty; recovery: AiRecoveryAction; reason?: AiFailureReason; failure_stage?: AiFailureStage; upstream_status?: number; upstream_code?: string }
export type AiOperationRecord = {
  id: string; project_id: string; route: string; state: AiOperationState; status_code: number | null;
  result?: unknown; candidate?: unknown; error?: AiOperationError; model_task_id?: string; created_at: string; updated_at: string;
}
/** Shared inventory of JSON operations. Durable SSE/task control keeps its
 * existing domain identity and is not replayed by the HTTP result store. */
export function isAiOperationRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false
  const route = path.split('?')[0]!.replace(/^\/api(?=\/)/, '')
  if (/^\/(visual-profiles|asset-tasks)\/[^/]+\/(?:generate|reference-generate)$/.test(route)) return true
  if (/^\/jobs\/[^/]+\/retry$/.test(route)) return true
  const match = /^\/projects\/[^/]+\/(.+)$/.exec(route)
  if (!match) return false
  const suffix = match[1]!
  return [
    /^skills\/refine-prompt$/, /^visual-profiles\/analyze$/,
    /^canvas\/(?:image-prompt-analysis|video-prompt-analysis|video-audio-plan|video-continuity-review)$/,
    /^canvases\/[^/]+\/node-proposals$/, /^assets\/[^/]+\/video-reviews$/,
    /^continuity\/analyze$/, /^jobs\/[^/]+\/optimize-prompt$/,
    /^script\/(?:canvas\/prepare|replies\/classify|themes\/visuals|plan-shots|generate|artifacts\/generate|director\/asset-prompt|director\/chat|source\/analysis)$/,
    /^script\/storyboard\/(?:plan|review|repair)$/, /^storyboard\/clip\/(?:plan|review)$/,
    /^speech\/lines\/[^/]+\/generate$/, /^speech\/batch\/generate$/,
    /^generate$/, /^video-comparisons\/[^/]+\/start$/,
  ].some(pattern => pattern.test(suffix))
}
/** JSON-equivalent bodies have the same fingerprint; identity is still an
 * explicit user intent, never a hash of the prompt used for deduplication. */
export function canonicalAiValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonicalAiValue(item === undefined ? null : item)).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonicalAiValue((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
