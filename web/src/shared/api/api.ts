import type { VisualReferenceAssetInput, VisualReferenceAssetPatch, VisualReferenceCropInput, VisualReferencePreviewInput, VisualReferencePreview, VisualReferenceGenerationInput, VisualReferenceGenerationResult, VisualProfile } from '@video-studio/shared/api/contracts'
export type * from '@video-studio/shared/api/contracts'
import { aiOperationHeader, isAiOperationRoute } from '@video-studio/shared/api/ai-operations'
import { operationResponse } from './ai-operation-api'
export type ApiError = Error & { status: number; raw_output?: string; diagnostics?: string;
  code?: string; category?: string; operation_id?: string; task_id?: string; trace_id?: string;
  retryable?: boolean; retry_after_ms?: number; outcome_certainty?: string;
  recovery?: { kind: string; operation_id?: string; task_id?: string; candidate_id?: string; candidate_version?: string };
}


export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const transport = (target: string, init: RequestInit = {}) => fetch(`/api${target}`, init)
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const init: RequestInit = { ...options, headers }
  const response = isAiOperationRoute(options.method || 'GET', path) && !headers.has('Idempotency-Key') && !headers.has(aiOperationHeader)
    ? await operationResponse(path, init, transport) : await transport(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail = body.detail ?? body.message ?? body.error
    const message = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `请求失败 (${response.status})`
    const error = new Error(message) as ApiError
    error.status = response.status
    if (typeof body.raw_output === 'string') error.raw_output = body.raw_output
    if (typeof body.diagnostics === 'string') error.diagnostics = body.diagnostics
    for (const key of ['code', 'category', 'operation_id', 'task_id', 'trace_id', 'outcome_certainty'] as const) {
      if (typeof body[key] === 'string') error[key] = body[key]
    }
    if (typeof body.retryable === 'boolean') error.retryable = body.retryable
    if (typeof body.retry_after_ms === 'number' && Number.isFinite(body.retry_after_ms) && body.retry_after_ms >= 0) error.retry_after_ms = body.retry_after_ms
    if (body.recovery && typeof body.recovery === 'object' && typeof body.recovery.kind === 'string') {
      error.recovery = { kind: body.recovery.kind }
      for (const key of ['operation_id', 'task_id', 'candidate_id', 'candidate_version'] as const) {
        if (typeof body.recovery[key] === 'string') error.recovery[key] = body.recovery[key]
      }
    }
    throw error
  }
  return response.json()
}

export const json = (method: string, value: unknown): RequestInit => ({ method, body: JSON.stringify(value) })

const referenceProfilePath = (profileId: string) => `/visual-profiles/${encodeURIComponent(profileId)}`
export const visualReferenceAssetsApi = {
  register: (profileId: string, input: VisualReferenceAssetInput) => api<VisualProfile>(`${referenceProfilePath(profileId)}/reference-assets`, json('POST', input)),
  update: (profileId: string, referenceId: string, input: VisualReferenceAssetPatch) => api<VisualProfile>(`${referenceProfilePath(profileId)}/reference-assets/${encodeURIComponent(referenceId)}`, json('PATCH', input)),
  crop: (profileId: string, input: VisualReferenceCropInput) => api<VisualProfile>(`${referenceProfilePath(profileId)}/reference-crop`, json('POST', input)),
  preview: (profileId: string, input: VisualReferencePreviewInput) => api<VisualReferencePreview>(`${referenceProfilePath(profileId)}/reference-preview`, json('POST', input)),
  generate: (profileId: string, input: VisualReferenceGenerationInput) => api<VisualReferenceGenerationResult>(`${referenceProfilePath(profileId)}/reference-generate`, json('POST', input)),
}
