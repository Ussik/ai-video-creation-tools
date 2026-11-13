import { resolveTextCapabilities, scopeTextCapabilities, type TextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { planTextRequest, TextContextCapacityError } from './text-context.js'

type Settings = Record<string, unknown>
type Options = NonNullable<Parameters<typeof planTextRequest>[3]> & {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
}

export function textTokenCounterConfigError(settings: Settings, protocol: string): string | null {
  const value = settings.text_token_counter
  if (value === undefined || value === 'disabled') return null
  if (!['responses', 'anthropic_messages'].includes(String(value)) || value !== protocol) return '输入计数接口必须与当前文本协议一致；该协议未提供可用计数接口时请关闭输入计数。'
  return null
}

function counterRequest(url: string, protocol: string, value: unknown): { url: string; body: Settings } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || target.search) return
  const suffix = protocol === 'responses' ? '/responses' : '/messages'
  if (!target.pathname.endsWith(suffix)) return
  target.pathname += protocol === 'responses' ? '/input_tokens' : '/count_tokens'
  const body = { ...value as Settings }
  // Retain the actual model, input, schemas, tools and signed message history.
  // Unknown vendor fields are left for this same channel to accept or reject.
  for (const field of ['stream', 'stream_options', 'background', 'max_output_tokens', 'max_completion_tokens', 'max_tokens',
    'temperature', 'top_p', 'top_k', 'metadata', 'store', 'service_tier', 'user', 'include', 'stop', 'stop_sequences']) delete body[field]
  return { url: target.toString(), body }
}

/** Plan the exact wire body. Optional native counting is only used near a known
 * boundary, on the same channel/model, and never claims a generation attempt. */
export async function prepareTextRequest(settings: Settings, body: unknown, protocol: string | undefined, options: Options) {
  options.signal?.throwIfAborted()
  const actualModel = body && typeof body === 'object' && !Array.isArray(body) ? (body as Settings).model : undefined
  const discovery = (settings.text_capabilities as TextCapabilities | undefined)?.discovered
  if (discovery && typeof actualModel === 'string' && actualModel) settings = scopeTextCapabilities(settings, { ...discovery.scope, remote_id: actualModel })
  const issue = textTokenCounterConfigError(settings, protocol ?? '')
  if (issue) throw new Error(issue)
  let plan: ReturnType<typeof planTextRequest> | undefined
  let failure: unknown
  try { plan = planTextRequest(settings, body, protocol, options) } catch (error) { failure = error }
  const capacity = plan?.capacity ?? (failure instanceof TextContextCapacityError ? failure.estimate : undefined)
  const limits = resolveTextCapabilities(settings).limits
  const bound = limits.budget_mode === 'shared' && limits.context_tokens !== undefined
    ? Math.min(limits.input_tokens ?? Infinity, limits.context_tokens - (capacity?.reserved_output_tokens ?? 0))
    : limits.input_tokens
  const nearLimit = capacity && bound !== undefined && capacity.estimated_input_tokens >= bound * 0.8
  const enabled = settings.text_token_counter !== undefined && settings.text_token_counter !== 'disabled'
  if (enabled && nearLimit) {
    const count = counterRequest(options.url, protocol ?? '', body)
    if (count) {
      const timeout = AbortSignal.timeout(10_000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      try {
        const response = await fetch(count.url, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(count.body), redirect: 'error', signal })
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('Input count unavailable') }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Invalid input count')
        let raw = '', bytes = 0
        const decoder = new TextDecoder()
        try {
          while (true) {
            const next = await reader.read()
            bytes += next.value?.byteLength ?? 0
            if (bytes > 64 * 1024) throw new Error('Invalid input count')
            raw += decoder.decode(next.value, { stream: !next.done })
            if (next.done) break
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        const payload: unknown = JSON.parse(raw)
        const tokens = payload && typeof payload === 'object' ? (payload as Settings).input_tokens : undefined
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid input count')
        options.signal?.throwIfAborted()
        return planTextRequest(settings, body, protocol, { ...options, inputTokens: tokens, countMethod: 'provider' })
      } catch (error) {
        options.signal?.throwIfAborted()
        // A count-based capacity rejection is authoritative for this attempt.
        if (error instanceof TextContextCapacityError) throw error
      }
    }
    if (plan) return { ...plan, capacity: { ...plan.capacity, input_count_method: 'estimated_fallback' as const } }
    if (failure instanceof TextContextCapacityError && failure.estimate) throw new TextContextCapacityError(
      `当前渠道输入计数不可用，以下按本地估算检查。${failure.message}`, { ...failure.estimate, input_count_method: 'estimated_fallback' })
  }
  if (failure) throw failure
  return plan!
}
