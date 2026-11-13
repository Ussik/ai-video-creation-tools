import type { VisualReferenceAssetInput, VisualReferenceAssetPatch, VisualReferenceCropInput, VisualReferencePreviewInput, VisualReferencePreview, VisualReferenceGenerationInput, VisualReferenceGenerationResult, VisualProfile } from '@video-studio/shared/api/contracts'
export type * from '@video-studio/shared/api/contracts'
export type ApiError = Error & { status: number; raw_output?: string; diagnostics?: string }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json', ...options.headers }
      : options.headers,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail = body.detail ?? body.message ?? body.error
    const message = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `请求失败 (${response.status})`
    const error = new Error(message) as ApiError
    error.status = response.status
    if (typeof body.raw_output === 'string') error.raw_output = body.raw_output
    if (typeof body.diagnostics === 'string') error.diagnostics = body.diagnostics
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
