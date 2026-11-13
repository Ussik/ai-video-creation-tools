import { beginProviderDispatch, isTextRequestBudgetError } from './text-request-usage.js'
import { randomUUID } from 'node:crypto'
import { currentModelRequestContext } from '../../modules/generation/model-task-policy.js'
import { resolveTextCapabilities, scopeTextCapabilities, type TextCapabilities } from '@video-studio/shared/models/text-capabilities'
import { planTextRequest, TextContextCapacityError } from './text-context.js'

type Settings = Record<string, unknown>
type Options = NonNullable<Parameters<typeof planTextRequest>[3]> & {
  url: string
  modelId?: string
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
  const context = currentModelRequestContext()
  options = { ...options, purpose: context?.policy.purpose ?? options.purpose,
    outputTokens: options.outputTokens ?? context?.policy.outputTokens,
    minimumOutputTokens: options.minimumOutputTokens ?? context?.policy.minimumOutputTokens }
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
        const response = await observeProviderFetch(count.url, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(count.body), redirect: 'error', signal }, 'input_count', fetch, { model_id: options.modelId, ...(typeof actualModel === 'string' ? { remote_id: actualModel } : {}) })
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('Input count unavailable') }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Invalid input count')
        let raw = '', bytes = 0
        const decoder = new TextDecoder()
        try {
          while (true) {
            const next = await reader!.read()
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
        if (error instanceof TextContextCapacityError || isTextRequestBudgetError(error)) throw error
      }
    }
    if (plan) return { ...plan, capacity: { ...plan.capacity, input_count_method: 'estimated_fallback' as const } }
    if (failure instanceof TextContextCapacityError && failure.estimate) throw new TextContextCapacityError(
      `当前渠道输入计数不可用，以下按本地估算检查。${failure.message}`, { ...failure.estimate, input_count_method: 'estimated_fallback' })
  }
  if (failure) throw failure
  return plan!
}

/** Safe metadata only; never persist prompts, credentials or opaque reasoning. */
export function textRequestTrace() {
  const context = currentModelRequestContext()
  return { request_id: randomUUID(), ...(context ? { request_purpose: context.policy.purpose,
    task_id: context.taskId, step_id: context.stepId, attempt_id: context.attemptId } : {}) }
}

export function notifyTextRequest<T>(phase: 'dispatch' | 'metrics', metrics: T, callback?: (value: T) => void, observe = true) {
  callback?.(metrics)
  const context = currentModelRequestContext()
  const observer = phase === 'dispatch' ? context?.onDispatch : context?.onMetrics
  if (observe && observer && observer !== callback) observer(metrics)
}

export type ProviderRequestIdentity = { model_id?: string; remote_id?: string }

const observedResponseCompletions = new WeakMap<Response, () => void>()

/** A protocol adapter may confirm a validated terminal result before transport EOF.
 * This never drains or changes the response; ordinary cancellation remains uncertain. */
export function completeObservedProviderResponse(response: Response): void {
  observedResponseCompletions.get(response)?.()
  observedResponseCompletions.delete(response)
}

/** Observe the actual auxiliary transport through headers and body lifetime.
 * Returning a streaming Response retains pull/cancel behavior and never buffers
 * successful media or prose just for diagnostics. */
export async function observeProviderFetch(url: string, init: RequestInit, transportKind: string, fetchImpl: typeof fetch = fetch,
  identity: ProviderRequestIdentity = {}, beforeDispatch?: () => void, usageReservation?: { admitted: boolean }): Promise<Response> {
  init.signal?.throwIfAborted()
  const target = new URL(url)
  const kind = transportKind.endsWith('_create') ? 'generation' as const : 'transport' as const
  // Background text already owns a token reservation at this exact dispatch.
  // Reuse its admission marker without settling its tokens at transport EOF.
  const admission = usageReservation ? { admitted: usageReservation.admitted, complete() {} }
    : beginProviderDispatch({ kind, request_bytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : 0 })
  beforeDispatch?.()
  init.signal?.throwIfAborted()
  const metrics = { ...textRequestTrace(), ...identity, kind, usage_admitted: admission.admitted, transport_kind: transportKind,
    endpoint: target.origin + target.pathname, ...(typeof init.body === 'string' ? { request_bytes: Buffer.byteLength(init.body) } : {}),
    delivery: 'unknown', http_status: undefined as number | undefined, upstream_request_id: undefined as string | undefined,
    failure_reason: undefined as string | undefined, raw_reason: undefined as string | undefined }
  // The response may be consumed after its creating ALS scope has returned.
  // Keep settlement tied to the request that dispatched this transport.
  const requestContext = currentModelRequestContext()
  let settled = false
  const finish = (kind: 'complete' | 'cancel' | 'error') => {
    if (settled) return
    settled = true
    admission.complete()
    init.signal?.removeEventListener('abort', aborted)
    if (kind === 'complete' && metrics.delivery === 'accepted') metrics.delivery = 'completed'
    if (kind !== 'complete') {
      const cancelled = init.signal?.aborted
      metrics.failure_reason = cancelled ? 'cancelled' : kind === 'error' ? 'disconnected' : undefined
      metrics.raw_reason = cancelled ? 'cancelled' : kind === 'error' ? 'stream_disconnected' : 'body_cancelled'
    }
    notifyTextRequest('metrics', metrics, requestContext?.onMetrics, false)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let responseController: ReadableStreamDefaultController<Uint8Array> | undefined
  const aborted = () => { finish('cancel'); responseController?.error(init.signal?.reason); void reader?.cancel(init.signal?.reason).catch(() => {}) }
  notifyTextRequest('dispatch', { ...metrics })
  let response: Response
  try {
    response = await fetchImpl(url, init)
    metrics.http_status = response.status; metrics.delivery = response.ok ? 'accepted' : 'rejected'
    const id = response.headers.get('x-request-id') || response.headers.get('request-id')
    if (id && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id)) metrics.upstream_request_id = id
  } catch (issue) { finish('error'); throw issue }
  if (!response.body) { finish('complete'); return response }
  reader = response.body.getReader()
  init.signal?.addEventListener('abort', aborted, { once: true })
  if (init.signal?.aborted) aborted()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { responseController = controller; if (init.signal?.aborted) controller.error(init.signal.reason) },
    async pull(controller) {
      try {
        const next = await reader!.read()
        init.signal?.throwIfAborted()
        if (next.done) { finish('complete'); reader!.releaseLock(); controller.close() }
        else controller.enqueue(next.value)
      } catch (issue) { finish('error'); try { reader!.releaseLock() } catch { /* Already closed. */ }; controller.error(issue) }
    },
    async cancel(reason) {
      finish('cancel')
      try { await reader!.cancel(reason) }
      finally { try { reader!.releaseLock() } catch { /* Already closed. */ } }
    },
  }, { highWaterMark: 0 })
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  // Preserve read-only response metadata relied on by provider diagnostics.
  for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(observed, key, { value: response[key] })
  observedResponseCompletions.set(observed, () => finish('complete'))
  return observed
}
