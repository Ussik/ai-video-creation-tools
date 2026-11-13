import type { TextCapabilityDiscovery, TextModelLimits } from '@video-studio/shared/models/text-capabilities'

export type CatalogCapabilityContext = {
  base_url: string
  protocol: string
  fetched_at: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function positiveLimit(...values: unknown[]): number | undefined {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  return valid.length ? Math.min(...valid) : undefined
}

/** Catalog metadata describes the selected channel. A model ID alone provides
 * no evidence of its limits, even when it resembles an official model name. */
export function discoverCatalogCapabilities(entry: unknown, remoteId: string, context: CatalogCapabilityContext): TextCapabilityDiscovery | undefined {
  const model = record(entry)
  if (!model || !context.protocol.trim()) return undefined
  const explicit = record(record(model.capabilities)?.limits) ?? record(model.limits) ?? {}
  const topProvider = record(model.top_provider) ?? {}
  const limits: TextModelLimits = { budget_mode: 'unknown' }
  const contextTokens = positiveLimit(explicit.context_tokens, model.context_tokens, model.context_length, model.context_window, topProvider.context_length)
  const inputTokens = positiveLimit(explicit.input_tokens, model.input_tokens, model.max_input_tokens, model.input_token_limit, model.inputTokenLimit)
  const outputTokens = positiveLimit(explicit.output_tokens, model.output_tokens, model.max_output_tokens, model.max_completion_tokens, model.output_token_limit, model.outputTokenLimit,
    topProvider.max_completion_tokens, context.protocol === 'anthropic_messages' ? model.max_tokens : undefined)
  if (contextTokens !== undefined) limits.context_tokens = contextTokens
  if (inputTokens !== undefined) limits.input_tokens = inputTokens
  if (outputTokens !== undefined) limits.output_tokens = outputTokens
  const explicitMode = explicit.budget_mode ?? model.budget_mode
  if (explicitMode === 'shared' || explicitMode === 'separate' || explicitMode === 'unknown') limits.budget_mode = explicitMode
  const reasoning = explicit.output_includes_reasoning ?? model.output_includes_reasoning
  if (typeof reasoning === 'boolean') limits.output_includes_reasoning = reasoning

  // OpenRouter documents a shared context window for its own channel. Similar
  // field names on a compatible gateway do not establish the same relationship.
  let base: URL
  try { base = new URL(context.base_url) } catch { return undefined }
  const officialOpenRouter = base.origin === 'https://openrouter.ai' && base.pathname.replace(/\/+$/, '') === '/api/v1'
    && ['chat_completions', 'responses'].includes(context.protocol)
  if (explicitMode === undefined && officialOpenRouter && contextTokens !== undefined) limits.budget_mode = 'shared'

  if (contextTokens === undefined && inputTokens === undefined && outputTokens === undefined
    && limits.budget_mode === 'unknown' && limits.output_includes_reasoning === undefined) return undefined
  return {
    limits,
    source: 'provider',
    fetched_at: context.fetched_at,
    scope: { base_url: context.base_url.trim().replace(/\/+$/, ''), protocol: context.protocol, remote_id: remoteId },
  }
}
