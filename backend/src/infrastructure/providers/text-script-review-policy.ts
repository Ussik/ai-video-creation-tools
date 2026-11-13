import { resolveTextApiSettings } from '@video-studio/shared/models/text-api-settings'
import type { OutputContract } from '../../modules/generation/model-output.js'
import type { GenerationModel, GenerationProvider } from './providers.js'

type ReviewRequest = {
  url: string
  remoteId: string
  protocol?: string
  policy?: OutputContract['request_policy']
}

function officialDeepSeekEndpoint({ url, remoteId, protocol }: ReviewRequest): boolean {
  if (remoteId !== 'deepseek-flash' && remoteId !== 'deepseek-v4-pro') return false
  const path = protocol === 'responses' ? /^(?:\/v1)?\/responses\/?$/
    : protocol === 'chat_completions' ? /^(?:\/v1)?\/chat\/completions\/?$/ : undefined
  if (!path) return false
  try {
    const endpoint = new URL(url)
    return endpoint.protocol === 'https:' && endpoint.host === 'api.deepseek.com' &&
      !endpoint.username && !endpoint.password && path.test(endpoint.pathname)
  } catch { return false }
}

/** Check the effective destination, including per-model base URL overrides.
 * This is capability detection only and never makes an upstream request. */
export function supportsScriptReviewPolicy(model: GenerationModel, provider: GenerationProvider): boolean {
  try {
    const raw = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
    const settings = resolveTextApiSettings(raw, model.protocol ?? '')
    const base = typeof settings.api_base_url === 'string' && settings.api_base_url ? settings.api_base_url : provider.base_url
    const path = settings.request_path
    if (provider.adapter !== 'http' || model.modality !== 'text' || typeof path !== 'string' || !path || /^https?:\/\//i.test(path)) return false
    return officialDeepSeekEndpoint({ url: `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`,
      remoteId: model.remote_id, protocol: model.protocol })
  } catch { return false }
}

/** Normal reviews retain the model's configured reasoning and output budget.
 * Only an explicit answer/evidence recovery disables reasoning on documented
 * official endpoints; output allowance always remains exactly as configured. */
export function applyScriptReviewRequestPolicy(body: unknown, request: ReviewRequest): unknown {
  if (!request.policy || !['script_review_answer', 'script_evidence'].includes(request.policy) ||
    !officialDeepSeekEndpoint(request) || !body || typeof body !== 'object' || Array.isArray(body)) return body
  const current = body as Record<string, unknown>
  if (request.protocol === 'responses') {
    const reasoning = current.reasoning && typeof current.reasoning === 'object' && !Array.isArray(current.reasoning)
      ? current.reasoning as Record<string, unknown> : {}
    return { ...current, reasoning: { ...reasoning, effort: 'none' } }
  }
  return { ...current, reasoning_effort: 'none' }
}
