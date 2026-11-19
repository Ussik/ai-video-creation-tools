import { safeModelResult, modelOperationStages, modelOperationStageLabels, type ModelOperationStage } from './model-results.js'
import { createHmac, randomBytes } from 'node:crypto'

export type LangfuseTracer = { observation(options: { taskId: string; projectId?: string; modelId?: string; owner: string; label?: string }): {
  dispatch(value: unknown): void; metrics(value: unknown): void; result?(value: unknown): void; finish(state: 'succeeded' | 'failed' | 'cancelled'): void
  correlation?(): { enabled: boolean; sampled: boolean; trace_id?: string; root_span_id?: string; reason?: string }
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
export type LangfuseStatus = { enabled: boolean; pending: number; dropped: number; failed: number; sent: number; lastTraceId?: string; lastRootSpanId?: string; incomplete: number;
  reason?: string; last_failure?: string; last_failure_at?: string; last_http_status?: number }
export type ConfiguredLangfuseTracer = LangfuseTracer & { status(): LangfuseStatus; flush(timeoutMs?: number): Promise<void> }
const noop = () => {}
const emptyObservation = { dispatch: noop, metrics: noop, result: noop, finish: noop }
const numbers = ['request_bytes', 'response_chars', 'first_event_ms', 'first_text_ms', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'output_limit', 'cache_read_tokens',
  'cache_write_tokens', 'estimated_input_tokens', 'context_window_tokens', 'reserved_output_tokens', 'http_status', 'framing_reserve_tokens', 'unit_index', 'unit_count', 'encoded_image_bytes', 'duplicate_image_occurrences'] as const
const protocolCounts = ['request_tool_count', 'response_text_blocks', 'response_thinking_blocks', 'response_tool_use_blocks', 'response_other_blocks'] as const
const nativeStopReasons = new Set(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'refusal', 'pause_turn'])
const purposes = new Set(['generation', 'review', 'classification', 'prompt', 'tool_decision', 'text', 'media_generation', 'image_analysis'])
const stages = new Set(['generation', 'review', 'repair', 'classification', 'prompt', 'tool', 'text', 'media_generation'])
const transports = new Set(['text', 'input_count', 'model_catalog', 'background_create', 'background_poll', 'background_cancel', 'media_create', 'media_poll', 'media_download', 'speech_create'])
const failures = new Set(['output_limit', 'context_overflow', 'disconnected', 'refusal', 'invalid_tool', 'invalid_response', 'upstream_error', 'cancelled'])
const upstreamErrors = new Set(['stream_read_error', 'stream_disconnected', 'connection_error', 'headers_timeout', 'first_event_timeout', 'event_idle_timeout', 'overloaded_error', 'rate_limit_error', 'api_error', 'timeout_error'])
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
    work.then(value => { clearTimeout(timer); resolve(value) }, issue => { clearTimeout(timer); reject(issue) })
  })
}
async function confirmation(response: Response, signal?: AbortSignal) {
  if (response.status !== 200) { void response.body?.cancel().catch(noop); throw Object.assign(new Error('trace_export_http_error'), { httpStatus: response.status }) }
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
  const state: LangfuseStatus = { enabled: valid.enabled, pending: 0, dropped: 0, failed: 0, sent: 0, incomplete: 0, reason: valid.reason }
  const clock = dependencies.now || Date.now, random = dependencies.random || Math.random, salt = dependencies.salt || randomBytes(32)
  const jobTraceId = (id: string) => createHmac('sha256', dependencies.salt || config.secretKey || salt).update('job-trace\0').update(id).digest('hex').slice(0, 32)
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
        catch (issue) {
          state.failed++; state.last_failure_at = new Date(clock()).toISOString()
          const known = ['trace_timeout', 'trace_export_http_error', 'trace_confirmation_missing', 'trace_confirmation_invalid', 'trace_export_partially_rejected']
          state.last_failure = issue instanceof Error && known.includes(issue.message) ? issue.message : 'trace_export_failed'
          state.last_http_status = typeof (issue as { httpStatus?: unknown })?.httpStatus === 'number' ? (issue as { httpStatus: number }).httpStatus : undefined
        }
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
    for (const key of protocolCounts) if (finite(source[key]) && Number.isSafeInteger(source[key])) result[key] = source[key]
    for (const [key, values] of [['trace_stage', stages], ['request_purpose', purposes], ['transport_kind', transports], ['failure_reason', failures], ['delivery', deliveries]] as const) if (typeof source[key] === 'string' && values.has(source[key])) result[key] = source[key]
    if (modelOperationStages.includes(source.operation_stage as ModelOperationStage)) result.operation_stage = source.operation_stage
    if (typeof source.output_started === 'boolean') result.output_started = source.output_started
    for (const key of ['request_tool_names', 'response_block_types'] as const) if (Array.isArray(source[key])) {
      const values = source[key].filter(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)).slice(0, 64)
      if (values.length) result[key] = [...new Set(values)]
    }
    for (const key of ['request_tool_choice', 'finish_reason'] as const) if (typeof source[key] === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(source[key])) result[key] = source[key]
    for (const key of ['scene_id', 'shot_id', 'field_path'] as const) if (typeof source[key] === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(source[key])) result[key] = source[key]
    if (source.checkpoint_reused === true) result.checkpoint_reused = true
    if (['native_json_schema_unverified', 'prompt_only', 'unverified'].includes(String(source.structured_enforcement))) result.structured_enforcement = source.structured_enforcement
    if (typeof source.response_terminated === 'boolean') result.response_terminated = source.response_terminated
    for (const key of ['request_has_tools', 'response_complete', 'response_blocks_closed', 'response_protocol_terminal', 'response_json_valid']) if (typeof source[key] === 'boolean') result[key] = source[key]
    for (const key of ['request_prompt_hash', 'request_body_hash', 'response_body_hash', 'response_text_hash']) if (typeof source[key] === 'string' && /^[a-f0-9]{64}$/.test(source[key])) result[key] = source[key]
    if (typeof source.request_structured_mode === 'string' && ['none', 'prompt', 'json_schema', 'json_object', 'tool_call'].includes(source.request_structured_mode)) result.request_structured_mode = source.request_structured_mode
    const detail = safeModelResult({ ...source, phase: 'structure', status: 'valid' }); if (detail) { const { phase, status, ...fields } = detail; Object.assign(result, fields) }
    if (['configured', 'declared', 'default'].includes(String(source.structured_strategy_source))) result.structured_strategy_source = source.structured_strategy_source
    if (source.structured_enforcement === 'unverified') result.structured_enforcement = 'unverified'
    if (typeof source.raw_reason === 'string' && nativeStopReasons.has(source.raw_reason)) result.raw_reason = source.raw_reason
    if (upstreamErrors.has(String(source.raw_reason))) result.upstream_error_code = source.raw_reason
    if (typeof source.delivery === 'string') result.output_usage_complete = source.delivery === 'completed' && finite(source.output_tokens)
    if (['accepted', 'output_started', 'unknown'].includes(String(source.delivery)) && source.output_tokens === 0) delete result.output_tokens
    const model = opaque('model', source.model_id); if (model) result.model_ref = model
    return result
  }
  const usage = (source: Record<string, unknown>) => {
    const value: Record<string, number> = {}
    if (finite(source.input_tokens)) value.input = source.input_tokens
    const outputKnown = finite(source.output_tokens) && !(['accepted', 'output_started', 'unknown'].includes(String(source.delivery)) && source.output_tokens === 0)
    if (outputKnown) value.output = source.output_tokens as number
    if (finite(source.input_tokens) && outputKnown) { const total = source.input_tokens + (source.output_tokens as number); if (Number.isFinite(total)) value.total = total }
    return Object.keys(value).length ? value : undefined
  }
  return {
    status: () => ({ ...state }),
    async flush(timeoutMs = valid.timeoutMs) { if (!draining) return; try { await bounded(draining, Math.max(1, Math.min(timeoutMs, 10_000))) } catch { /* Shutdown cannot affect business execution. */ } },
    observation(options) {
      if (!valid.enabled) return { ...emptyObservation, correlation: () => ({ enabled: false, sampled: false, reason: valid.reason }) }
      let sampled = false
      try { sampled = (options.owner === 'job' ? parseInt(jobTraceId(options.taskId).slice(0, 8), 16) / 0x100000000 : random()) < valid.sampleRate } catch { return emptyObservation }
      if (!sampled) return { ...emptyObservation, correlation: () => ({ enabled: true, sampled: false, reason: 'not_sampled' }) }
      const children = new Map<string, { id: string; name: string; generation: boolean; startedAt: number; metadata: Record<string, unknown>; settled: boolean; incomplete: boolean }>()
      let resultCount = 0
      let root: { id: string; spanId: string; startedAt: number; metadata: Record<string, unknown> } | undefined, finished = false, suppressed = false
      const identity = () => ({ owner: owners.has(options.owner) ? options.owner : 'unknown', task_ref: opaque('task', options.taskId),
        ...(options.projectId ? { project_ref: opaque('project', options.projectId) } : {}), ...(options.modelId ? { model_ref: opaque('model', options.modelId) } : {}) })
      const safely = (work: () => void) => { try { work() } catch { state.failed++ } }
      return {
        correlation: () => ({ enabled: true, sampled: true, ...(root ? { trace_id: root.id, root_span_id: root.spanId } : {}),
          ...(suppressed ? { reason: 'queue_saturated' } : {}) }),
        dispatch(value) { safely(() => {
          if (finished || suppressed) return
          const source = record(value), key = opaque('request', source.request_id)
          if (!key || children.has(key)) return
          if (children.size >= 256 || state.pending >= valid.maxPending) { state.dropped++; suppressed = true; return }
          const at = clock()
          if (!root) { root = { id: options.owner === 'job' ? jobTraceId(options.taskId) : randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), startedAt: at, metadata: identity() }; state.lastTraceId = root.id; state.lastRootSpanId = root.spanId }
          const id = randomBytes(8).toString('hex'), metadata = { ...safeMetadata(source), request_ref: key }
          const purpose = stages.has(String(source.trace_stage)) ? String(source.trace_stage) : purposes.has(String(source.request_purpose)) ? String(source.request_purpose) : 'text'
          const transport = transports.has(String(source.transport_kind)) ? String(source.transport_kind) : 'text', generation = transport === 'text'
          children.set(key, { id, name: (modelOperationStages.includes(source.operation_stage as ModelOperationStage)
            ? modelOperationStageLabels[source.operation_stage as ModelOperationStage] + (finite(source.unit_index) ? ` ${source.unit_index + 1}` : '') : purpose) + ':' + transport, generation, startedAt: at, metadata, settled: false, incomplete: false })
        }) },
        metrics(value) { safely(() => {
          const source = record(value), key = opaque('request', source.request_id), child = key ? children.get(key) : undefined
          if (!child || !root || child.settled) return
          const metadata = { ...child.metadata, ...safeMetadata(source), settlement: 'settled' }, used = usage(source)
          const issue = typeof source.failure_reason === 'string' && failures.has(source.failure_reason) ? source.failure_reason : finite(source.http_status) && source.http_status >= 400 ? 'http_error' : ['unknown', 'accepted', 'output_started'].includes(String(source.delivery)) ? 'unknown_result' : undefined
          const firstEvent = child.generation && finite(source.first_text_ms) && Number.isFinite(child.startedAt + source.first_text_ms) && child.startedAt + source.first_text_ms <= clock() ? child.startedAt + source.first_text_ms : undefined
          const complete = span({ traceId: root.id, id: child.id, parentId: root.spanId, name: child.name, startedAt: child.startedAt, generation: child.generation,
            metadata, issue, ...(child.generation && used ? { usage: used } : {}), firstEvent })
          if (enqueue([complete])) { child.settled = true; if (child.incomplete) { child.incomplete = false; state.incomplete-- } }
        }) },
        result(value) { safely(() => {
          if (finished || suppressed) return
          const event = safeModelResult(value); if (!event) return
          const at = clock()
          if (!root) { root = { id: options.owner === 'job' ? jobTraceId(options.taskId) : randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), startedAt: at, metadata: identity() }; state.lastTraceId = root.id; state.lastRootSpanId = root.spanId }
          root.startedAt = Math.min(root.startedAt, Math.max(0, at - (event.duration_ms || 0)))
          if (event.business_result) root.metadata.business_result = event.business_result
          if (event.review_status) root.metadata.review_status = event.review_status
          if (event.phase === 'quality') {
            const blockedByBusinessFailure = root.metadata.latest_structure_status === 'invalid_business'
            root.metadata.latest_quality_status = blockedByBusinessFailure && event.status === 'passed' ? 'needs_work' : event.status
            if (event.stage) root.metadata.latest_quality_stage = event.stage
          } else {
            root.metadata.latest_structure_status = event.status
            if (event.status === 'invalid_business' && root.metadata.latest_quality_status === 'passed') root.metadata.latest_quality_status = 'needs_work'
          }
          // Long executions remain bounded without freezing their root at an
          // early passed substep when the final review later needs work.
          if (resultCount >= 128) { root.metadata.omitted_result_count = Number(root.metadata.omitted_result_count || 0) + 1; return }
          resultCount++
          if (event.final_state) root.metadata.final_state = event.final_state
          if (event.cache_hit !== undefined) root.metadata.cache_hit = event.cache_hit
          if (event.local_reuse !== undefined) root.metadata.local_reuse = event.local_reuse
          if (event.model_request_count !== undefined) root.metadata.model_request_count = event.model_request_count
          const operation = event.stage ? modelOperationStageLabels[event.stage] : '模型结果'
          const metadata: Record<string, unknown> = { result_phase: event.phase, result_status: event.status,
            ...(event.stage ? { operation_stage: event.stage } : {}),
            ...(event.scene_id ? { scene_id: event.scene_id } : {}), ...(event.shot_id ? { shot_id: event.shot_id } : {}),
            ...(event.field_path ? { field_path: event.field_path } : {}),
            ...Object.fromEntries(['input_transport_chars', 'input_transport_estimated_tokens', 'input_schema_hash', 'input_schema_present', 'input_scene_count', 'input_shot_count', 'input_scope_chars', 'input_rules_chars', 'input_facts_chars', 'input_profiles_chars', 'input_original_chars', 'input_scope_hash', 'input_scope_stage', 'input_boundary', 'input_scope_present', 'business_result', 'review_status', 'recovery_action', 'recovery_error_type', 'recovery_attempts', 'recovery_input_chars', 'recovery_output_chars', 'task_key', 'task_id', 'unit_key', 'checkpoint_source', 'is_new_model_call', 'recovery_type', 'attempt', 'model_request_count', 'local_validation_count', 'section_ids', 'failure_code', 'field_paths', 'structural_changes', 'schema_issue_codes', 'correction_items', 'reused_items', 'request_category', 'input_source_chars', 'input_index_chars', 'evidence_expanded', 'repair_type', 'started_at_ms', 'ended_at_ms'].flatMap(key => event[key as keyof typeof event] === undefined ? [] : [[key, event[key as keyof typeof event]]])),
            ...(event.issue_count === undefined ? {} : { issue_count: event.issue_count }),
            ...(event.repaired === undefined ? {} : { repaired: event.repaired }),
            ...(event.repair_effect === undefined ? {} : { repair_effect: event.repair_effect }),
            ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
            ...(event.unit_index === undefined ? {} : { unit_index: event.unit_index }),
            ...(event.unit_count === undefined ? {} : { unit_count: event.unit_count }),
            ...(event.failure_code === undefined ? {} : { failure_code: event.failure_code }),
            ...(event.evidence_ref_ids === undefined ? {} : { evidence_ref_ids: event.evidence_ref_ids }),
            ...(event.evidence_fields === undefined ? {} : { evidence_fields: event.evidence_fields }),
            ...(event.evidence_validation === undefined ? {} : { evidence_validation: event.evidence_validation }),
            ...(event.first_pass_status === undefined ? {} : { first_pass_status: event.first_pass_status }),
            ...(event.repair_count === undefined ? {} : { repair_count: event.repair_count }),
            ...(event.repaired_units === undefined ? {} : { repaired_units: event.repaired_units }),
            ...(event.validation_latency_ms === undefined ? {} : { validation_latency_ms: event.validation_latency_ms }),
            ...(event.repair_latency_ms === undefined ? {} : { repair_latency_ms: event.repair_latency_ms }),
            ...(event.structured_enforcement === undefined ? {} : { structured_enforcement: event.structured_enforcement }),
            ...(event.json_error_position === undefined ? {} : { json_error_position: event.json_error_position }),
            ...(event.json_error_line === undefined ? {} : { json_error_line: event.json_error_line }),
            ...(event.json_error_column === undefined ? {} : { json_error_column: event.json_error_column }),
            ...(event.cache_hit === undefined ? {} : { cache_hit: event.cache_hit }),
            ...(event.local_reuse === undefined ? {} : { local_reuse: event.local_reuse }),
            ...(event.final_state === undefined ? {} : { final_state: event.final_state }),
            ...(event.model_request_count === undefined ? {} : { model_request_count: event.model_request_count }),
            ...(event.repair_strategy === undefined ? {} : { repair_strategy: event.repair_strategy }),
            ...(event.repair_applied === undefined ? {} : { repair_applied: event.repair_applied }),
            ...(event.root_object_detected === undefined ? {} : { root_object_detected: event.root_object_detected }),
            ...(event.input_tokens_before_repair === undefined ? {} : { input_tokens_before_repair: event.input_tokens_before_repair }),
            ...(event.input_tokens_after_repair === undefined ? {} : { input_tokens_after_repair: event.input_tokens_after_repair }) }
          // Transport completion and execution state do not grant this quality
          // result. This immutable application span records the validator.
          enqueue([span({ traceId: root.id, id: randomBytes(8).toString('hex'), parentId: root.spanId,
            name: operation + (event.phase === 'structure' ? ':结构校验' : ':质量结果'), startedAt: event.started_at_ms === undefined ? Math.max(0, at - (event.duration_ms || 0)) : Math.min(at, event.started_at_ms),
            generation: false, metadata, issue: event.status.startsWith('invalid_') ? event.status : undefined })])
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
            metadata: { ...root.metadata, state: next, final_state: root.metadata.final_state || next, incomplete_children: incomplete, duration_ms: Math.max(0, clock() - root.startedAt) }, issue: next === 'succeeded' ? undefined : next })])
        }) },
      }
    },
  }
}
let singleton: ConfiguredLangfuseTracer | undefined
export function getLangfuseTracer(): LangfuseTracer { return singleton ||= createLangfuseTracer(readLangfuseConfig()) }
export async function flushLangfuseTraces(timeoutMs?: number): Promise<void> { await singleton?.flush(timeoutMs) }
