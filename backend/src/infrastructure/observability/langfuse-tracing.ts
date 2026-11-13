import { createHmac, randomBytes } from 'node:crypto'

export type LangfuseTracer = { observation(options: { taskId: string; projectId?: string; modelId?: string; owner: string; label?: string }): {
  dispatch(value: unknown): void; metrics(value: unknown): void; finish(state: 'succeeded' | 'failed' | 'cancelled'): void
} }
export type LangfuseConfig = { enabled: boolean; publicKey?: string; secretKey?: string; baseUrl: string;
  sampleRate: number; timeoutMs: number; maxPending: number; reason?: 'disabled' | 'missing_credentials' | 'invalid_endpoint' | 'invalid_configuration' }
/** Standard OTLP/HTTP JSON accepted by Langfuse v4; no global provider or second queue. */
export type LangfuseSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: 1;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: Array<{ key: string; value: { stringValue?: string; boolValue?: boolean } }>;
  status: { code: 1 | 2; message?: string } }
export type LangfuseBatch = { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
  scopeSpans: Array<{ scope: { name: string }; spans: LangfuseSpan[] }> }> }
type Dependencies = { clientFactory?: (config: LangfuseConfig, safeFetch: typeof fetch) => { send(batch: LangfuseBatch, signal?: AbortSignal): Promise<unknown> };
  fetch?: typeof fetch; now?: () => number; random?: () => number; salt?: string | Buffer }
export type LangfuseStatus = { enabled: boolean; pending: number; dropped: number; failed: number; sent: number; lastTraceId?: string; lastRootSpanId?: string; incomplete: number }
export type ConfiguredLangfuseTracer = LangfuseTracer & { status(): LangfuseStatus; flush(timeoutMs?: number): Promise<void> }
const noop = () => {}
const emptyObservation = { dispatch: noop, metrics: noop, finish: noop }
const numbers = ['request_bytes', 'response_chars', 'first_event_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'output_limit', 'cache_read_tokens',
  'cache_write_tokens', 'estimated_input_tokens', 'context_window_tokens', 'reserved_output_tokens', 'http_status', 'framing_reserve_tokens'] as const
const purposes = new Set(['generation', 'review', 'classification', 'prompt', 'tool_decision', 'text', 'media_generation', 'image_analysis'])
const stages = new Set(['generation', 'review', 'repair', 'classification', 'prompt', 'tool', 'text', 'media_generation'])
const transports = new Set(['text', 'input_count', 'model_catalog', 'background_create', 'background_poll', 'background_cancel', 'media_create', 'media_poll', 'media_download', 'speech_create'])
const failures = new Set(['output_limit', 'context_overflow', 'disconnected', 'refusal', 'invalid_tool', 'invalid_response', 'upstream_error', 'cancelled'])
const deliveries = new Set(['not_sent', 'rejected', 'accepted', 'output_started', 'completed', 'unknown'])
const owners = new Set(['request', 'job', 'director', 'diagnostic'])
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function endpoint(value: string): string | undefined {
  try {
    const url = new URL(value), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) return
    return url.href.replace(/\/$/, '')
  } catch { return }
}
export function readLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig {
  const config: LangfuseConfig = { enabled: false, baseUrl: '', sampleRate: 1, timeoutMs: 3000, maxPending: 256, reason: 'disabled' }
  if (env.LANGFUSE_TRACING !== 'true') return config
  if (!env.LANGFUSE_BASE_URL?.trim()) return { ...config, reason: 'invalid_endpoint' }
  const target = endpoint(env.LANGFUSE_BASE_URL.trim())
  if (!target) return { ...config, reason: 'invalid_endpoint' }
  config.baseUrl = target
  config.publicKey = env.LANGFUSE_PUBLIC_KEY?.trim(); config.secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!config.publicKey || !config.secretKey) return { ...config, reason: 'missing_credentials' }
  const sampleRate = env.LANGFUSE_TRACING_SAMPLING_RATE === undefined ? 1 : Number(env.LANGFUSE_TRACING_SAMPLING_RATE)
  const timeoutMs = env.VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS === undefined ? 3000 : Number(env.VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS)
  const maxPending = env.VIDEO_STUDIO_LANGFUSE_MAX_PENDING === undefined ? 256 : Number(env.VIDEO_STUDIO_LANGFUSE_MAX_PENDING)
  if (!finite(sampleRate) || sampleRate > 1 || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000 || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256 || /[:\r\n]/.test(config.publicKey) || /[\r\n]/.test(config.secretKey)) return { ...config, reason: 'invalid_configuration' }
  return { ...config, enabled: true, sampleRate, timeoutMs, maxPending, reason: undefined }
}
function bounded<T>(work: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout?.(); reject(new Error('trace_timeout')) }, timeoutMs)
    work.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); reject(new Error('trace_export_failed')) })
  })
}
async function confirmation(response: Response, signal?: AbortSignal) {
  if (response.status !== 200) { void response.body?.cancel().catch(noop); throw new Error('trace_export_failed') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('trace_confirmation_missing')
  const abort = () => { void reader.cancel().catch(noop) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let raw = '', size = 0
  const decoder = new TextDecoder()
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65536) throw new Error('trace_confirmation_invalid'); raw += decoder.decode(next.value, { stream: true }) }
    raw += decoder.decode()
  } finally { signal?.removeEventListener('abort', abort); void reader.cancel().catch(noop); reader.releaseLock() }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('trace_confirmation_invalid')
  const value = record(parsed)
  if (value.partialSuccess !== undefined && (!value.partialSuccess || typeof value.partialSuccess !== 'object' || Array.isArray(value.partialSuccess))) throw new Error('trace_confirmation_invalid')
  const partial = record(value.partialSuccess)
  if (Object.keys(partial).length) {
    const rejected = partial.rejectedSpans
    if (rejected !== undefined && rejected !== '0' && rejected !== 0 || typeof partial.errorMessage === 'string' && partial.errorMessage.length) throw new Error('trace_export_partially_rejected')
  }
}
export function createLangfuseTracer(config: LangfuseConfig, dependencies: Dependencies = {}): ConfiguredLangfuseTracer {
  const valid = readLangfuseConfig({ LANGFUSE_TRACING: String(config.enabled), LANGFUSE_PUBLIC_KEY: config.publicKey, LANGFUSE_SECRET_KEY: config.secretKey,
    LANGFUSE_BASE_URL: config.baseUrl, LANGFUSE_TRACING_SAMPLING_RATE: String(config.sampleRate), VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: String(config.timeoutMs), VIDEO_STUDIO_LANGFUSE_MAX_PENDING: String(config.maxPending) })
  const state: LangfuseStatus = { enabled: valid.enabled, pending: 0, dropped: 0, failed: 0, sent: 0, incomplete: 0 }
  const clock = dependencies.now || Date.now, random = dependencies.random || Math.random, salt = dependencies.salt || randomBytes(32)
  const opaque = (kind: string, value: unknown) => typeof value === 'string' && value ? createHmac('sha256', salt).update(kind).update('\0').update(value).digest('hex') : undefined
  const queue: LangfuseBatch[] = []
  let draining: Promise<void> | undefined, client: ReturnType<NonNullable<Dependencies['clientFactory']>> | undefined
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
    if (url.href !== valid.baseUrl + '/api/public/otel/v1/traces') throw new Error('trace_destination_invalid')
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-langfuse-ingestion-version': '4', Authorization: 'Basic ' + Buffer.from(valid.publicKey + ':' + valid.secretKey).toString('base64') }
    try { return await (dependencies.fetch || fetch)(input, { ...init, headers, redirect: 'error' }) } catch { throw new Error('trace_export_failed') }
  }
  const defaultClient = () => ({ async send(batch: LangfuseBatch, signal?: AbortSignal) { await confirmation(await safeFetch(valid.baseUrl + '/api/public/otel/v1/traces', { method: 'POST', body: JSON.stringify(batch), signal }), signal) } })
  const drain = () => {
    if (draining) return
    draining = Promise.resolve().then(async () => {
      while (queue.length) {
        const batch = queue.shift()!, controller = new AbortController()
        try { client ||= dependencies.clientFactory ? dependencies.clientFactory(valid, safeFetch) : defaultClient(); await bounded(Promise.resolve().then(() => client!.send(batch, controller.signal)), valid.timeoutMs, () => controller.abort()); state.sent++ }
        catch { state.failed++ }
        finally { state.pending-- }
      }
    }).finally(() => { draining = undefined; if (queue.length) drain() })
  }
  const enqueue = (spans: LangfuseSpan[]) => {
    if (state.pending >= valid.maxPending) { state.dropped++; return false }
    state.pending++; queue.push({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ai-video-studio' } }] }, scopeSpans: [{ scope: { name: 'video-studio-langfuse' }, spans }] }] }); drain(); return true
  }
  const nanos = (at: number) => (BigInt(Math.trunc(at)) * 1_000_000n).toString()
  const metadataAttributes = (metadata: Record<string, unknown>, prefix = 'langfuse.observation.metadata') => Object.entries(metadata)
    .filter(([, value]) => value !== undefined).map(([key, value]) => ({ key: prefix + '.' + key, value: { stringValue: JSON.stringify(value) } }))
  const span = (options: { traceId: string; id: string; parentId?: string; name: string; startedAt: number; generation: boolean;
    metadata: Record<string, unknown>; issue?: string; usage?: Record<string, number>; firstEvent?: number; root?: boolean }): LangfuseSpan => ({
    traceId: options.traceId, spanId: options.id, ...(options.parentId ? { parentSpanId: options.parentId } : {}), name: options.name, kind: 1,
    startTimeUnixNano: nanos(options.startedAt), endTimeUnixNano: nanos(clock()),
    attributes: [{ key: 'langfuse.observation.type', value: { stringValue: options.generation ? 'generation' : 'span' } },
      { key: 'langfuse.observation.level', value: { stringValue: options.issue ? 'ERROR' : 'DEFAULT' } },
      { key: 'langfuse.observation.status_message', value: { stringValue: options.issue || 'completed' } },
      ...metadataAttributes(options.metadata),
      ...(options.root ? [{ key: 'langfuse.trace.name', value: { stringValue: 'ai_operation' } }, { key: 'langfuse.trace.public', value: { boolValue: false } }, ...metadataAttributes(options.metadata, 'langfuse.trace.metadata')] : []),
      ...(options.usage ? [{ key: 'langfuse.observation.usage_details', value: { stringValue: JSON.stringify(options.usage) } }] : []),
      ...(options.firstEvent !== undefined ? [{ key: 'langfuse.observation.completion_start_time', value: { stringValue: new Date(options.firstEvent).toISOString() } }] : [])],
    status: { code: options.issue ? 2 : 1, ...(options.issue ? { message: options.issue } : {}) },
  })
  const safeMetadata = (source: Record<string, unknown>) => {
    const result: Record<string, unknown> = {}
    for (const key of numbers) if (finite(source[key])) result[key] = source[key]
    for (const [key, values] of [['trace_stage', stages], ['request_purpose', purposes], ['transport_kind', transports], ['failure_reason', failures], ['delivery', deliveries]] as const) if (typeof source[key] === 'string' && values.has(source[key])) result[key] = source[key]
    if (typeof source.output_started === 'boolean') result.output_started = source.output_started
    const model = opaque('model', source.model_id); if (model) result.model_ref = model
    return result
  }
  const usage = (source: Record<string, unknown>) => {
    const value: Record<string, number> = {}
    if (finite(source.input_tokens)) value.input = source.input_tokens
    if (finite(source.output_tokens)) value.output = source.output_tokens
    if (finite(source.input_tokens) && finite(source.output_tokens)) { const total = source.input_tokens + source.output_tokens; if (Number.isFinite(total)) value.total = total }
    return Object.keys(value).length ? value : undefined
  }
  return {
    status: () => ({ ...state }),
    async flush(timeoutMs = valid.timeoutMs) { if (!draining) return; try { await bounded(draining, Math.max(1, Math.min(timeoutMs, 10_000))) } catch { /* Shutdown cannot affect business execution. */ } },
    observation(options) {
      if (!valid.enabled) return emptyObservation
      let sampled = false
      try { sampled = random() < valid.sampleRate } catch { return emptyObservation }
      if (!sampled) return emptyObservation
      const children = new Map<string, { id: string; name: string; generation: boolean; startedAt: number; metadata: Record<string, unknown>; settled: boolean; incomplete: boolean }>()
      let root: { id: string; spanId: string; startedAt: number; metadata: Record<string, unknown> } | undefined, finished = false, suppressed = false
      const identity = () => ({ owner: owners.has(options.owner) ? options.owner : 'unknown', task_ref: opaque('task', options.taskId),
        ...(options.projectId ? { project_ref: opaque('project', options.projectId) } : {}), ...(options.modelId ? { model_ref: opaque('model', options.modelId) } : {}) })
      const safely = (work: () => void) => { try { work() } catch { state.failed++ } }
      return {
        dispatch(value) { safely(() => {
          if (finished || suppressed) return
          const source = record(value), key = opaque('request', source.request_id)
          if (!key || children.has(key)) return
          if (children.size >= 256 || state.pending >= valid.maxPending) { state.dropped++; suppressed = true; return }
          const at = clock()
          if (!root) { root = { id: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), startedAt: at, metadata: identity() }; state.lastTraceId = root.id; state.lastRootSpanId = root.spanId }
          const id = randomBytes(8).toString('hex'), metadata = { ...safeMetadata(source), request_ref: key }
          const purpose = stages.has(String(source.trace_stage)) ? String(source.trace_stage) : purposes.has(String(source.request_purpose)) ? String(source.request_purpose) : 'text'
          const transport = transports.has(String(source.transport_kind)) ? String(source.transport_kind) : 'text', generation = transport === 'text'
          children.set(key, { id, name: purpose + ':' + transport, generation, startedAt: at, metadata, settled: false, incomplete: false })
        }) },
        metrics(value) { safely(() => {
          const source = record(value), key = opaque('request', source.request_id), child = key ? children.get(key) : undefined
          if (!child || !root || child.settled) return
          const metadata = { ...child.metadata, ...safeMetadata(source), settlement: 'settled' }, used = usage(source)
          const issue = typeof source.failure_reason === 'string' && failures.has(source.failure_reason) ? source.failure_reason : finite(source.http_status) && source.http_status >= 400 ? 'http_error' : ['unknown', 'accepted', 'output_started'].includes(String(source.delivery)) ? 'unknown_result' : undefined
          const firstEvent = child.generation && finite(source.first_event_ms) && Number.isFinite(child.startedAt + source.first_event_ms) && child.startedAt + source.first_event_ms <= clock() ? child.startedAt + source.first_event_ms : undefined
          const complete = span({ traceId: root.id, id: child.id, parentId: root.spanId, name: child.name, startedAt: child.startedAt, generation: child.generation,
            metadata, issue, ...(child.generation && used ? { usage: used } : {}), firstEvent })
          if (enqueue([complete])) { child.settled = true; if (child.incomplete) { child.incomplete = false; state.incomplete-- } }
        }) },
        finish(next) { safely(() => {
          if (finished) return; finished = true
          if (!root) return
          let incomplete = 0
          for (const child of children.values()) if (!child.settled) { child.incomplete = true; state.incomplete++; incomplete++ }
          // v4 observations are immutable: never export a premature child end.
          // A late settlement exports its original child once; unfinished work
          // remains visible as root metadata and a diagnostic counter only.
          enqueue([span({ traceId: root.id, id: root.spanId, name: 'ai_operation', startedAt: root.startedAt, generation: false, root: true,
            metadata: { ...root.metadata, state: next, incomplete_children: incomplete, duration_ms: Math.max(0, clock() - root.startedAt) }, issue: next === 'succeeded' ? undefined : next })])
        }) },
      }
    },
  }
}
let singleton: ConfiguredLangfuseTracer | undefined
export function getLangfuseTracer(): LangfuseTracer { return singleton ||= createLangfuseTracer(readLangfuseConfig()) }
export async function flushLangfuseTraces(timeoutMs?: number): Promise<void> { await singleton?.flush(timeoutMs) }
