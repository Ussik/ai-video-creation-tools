import { loadEnvFile } from 'node:process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot } from '../src/infrastructure/paths.js'
import { createLangfuseTracer, readLangfuseConfig, type LangfuseConfig } from '../src/infrastructure/observability/langfuse-tracing.js'

const maxReadbackBytes = 256 * 1024
const noop = () => {}
type SavedTrace = { id?: string; rootSpanId?: string; state?: string; owner?: string; observations?: Array<{ id?: string; parentSpanId?: string; endTime?: string; delivery?: string }> }
/** Read back one synthetic trace, retaining only fields needed for acceptance. */
export async function readBackLangfuseTrace(id: string, config: LangfuseConfig): Promise<SavedTrace> {
  const target = new URL(config.baseUrl + '/api/public/v2/observations')
  target.search = new URLSearchParams({ traceId: id, fields: 'basic,metadata', limit: '256' }).toString()
  const response = await fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
    headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64') } })
  if (!response.ok) {
    void response.body?.cancel().catch(noop)
    throw Object.assign(new Error('trace_readback_failed'), { status: response.status })
  }
  const reader = response.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []; let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.byteLength; if (bytes > maxReadbackBytes) throw new Error('trace_readback_invalid')
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(noop); reader.releaseLock() }
  const raw = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const observations = Array.isArray(raw.data) ? raw.data.slice(0, 256).map(object).filter(value => value.traceId === id) : []
  const root = observations.find(value => value.isRootObservation === true && !value.parentObservationId && typeof value.endTime === 'string' && value.endTime)
  const metadata = object(root?.metadata)
  return { id: root ? id : undefined, rootSpanId: typeof root?.id === 'string' ? root.id : undefined,
    state: metadata.state === 'succeeded' ? 'succeeded' : undefined, owner: metadata.owner === 'diagnostic' ? 'diagnostic' : undefined,
    observations: observations.filter(value => value !== root).map(observation => {
      const meta = object(observation.metadata)
      return { id: typeof observation.id === 'string' ? observation.id : undefined,
        parentSpanId: typeof observation.parentObservationId === 'string' ? observation.parentObservationId : undefined,
        endTime: typeof observation.endTime === 'string' ? observation.endTime : undefined,
        delivery: meta.delivery === 'completed' ? 'completed' : undefined }
    }) }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
type Dependencies = { tracerFactory?: typeof createLangfuseTracer; readTrace?: typeof readBackLangfuseTrace; pause?: () => Promise<void> }
function configSummary(env: NodeJS.ProcessEnv, config: LangfuseConfig) {
  let local = false
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname) } catch { /* masked configuration state only */ }
  return { enabled: config.enabled, reason: config.reason || 'ready', has_public_key: !!env.LANGFUSE_PUBLIC_KEY?.trim(),
    has_secret_key: !!env.LANGFUSE_SECRET_KEY?.trim(), destination: local ? 'local' : 'remote',
    sample_rate: config.sampleRate, timeout_ms: config.timeoutMs, max_pending: config.maxPending }
}
/** No database, model provider or formal-project state is opened by this tool. */
export async function diagnoseLangfuse(mode: 'check' | 'smoke', env: NodeJS.ProcessEnv = process.env, dependencies: Dependencies = {}) {
  const config = readLangfuseConfig(env), summary = configSummary(env, config)
  if (mode === 'check') return { ok: config.enabled || config.reason === 'disabled', mode, ...summary, network_used: false }
  if (!config.enabled) return { ok: false, mode, ...summary, network_used: false, verification: 'configuration_required' }
  // Explicit diagnostics are always sampled, and contain no model content or fabricated token usage.
  const tracer = (dependencies.tracerFactory || createLangfuseTracer)({ ...config, sampleRate: 1 })
  const operation = tracer.observation({ taskId: randomUUID(), owner: 'diagnostic' }), requestId = randomUUID()
  operation.dispatch({ request_id: requestId, request_purpose: 'classification', kind: 'transport' })
  operation.metrics({ request_id: requestId, request_purpose: 'classification', delivery: 'completed', http_status: 200 })
  operation.finish('succeeded')
  await tracer.flush(Math.min(10_000, config.timeoutMs * 3))
  const status = tracer.status(), id = status.lastTraceId
  if (!id || !status.lastRootSpanId || status.failed || status.dropped || status.pending) return { ok: false, mode, ...summary, network_used: !!id,
    verification: 'export_incomplete', trace_id: id, failed_batches: status.failed, dropped_batches: status.dropped, pending_batches: status.pending }
  const read = dependencies.readTrace || readBackLangfuseTrace
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const trace = await read(id, config)
      if (trace.id === id && trace.rootSpanId === status.lastRootSpanId && trace.state === 'succeeded' && trace.owner === 'diagnostic' && trace.observations?.some(value => value.id && value.parentSpanId === trace.rootSpanId && value.endTime && value.delivery === 'completed')) {
        return { ok: true, mode, ...summary, network_used: true, verification: 'readback_verified', trace_id: id }
      }
    } catch (issue) {
      const status = (issue as { status?: unknown })?.status
      if (status === 401 || status === 403) return { ok: false, mode, ...summary, network_used: true, trace_id: id, verification: 'read_permission_required' }
      if (status !== 404) return { ok: false, mode, ...summary, network_used: true, trace_id: id, verification: 'readback_failed' }
    }
    if (attempt < 19) await (dependencies.pause || (() => delay(500)))()
  }
  return { ok: false, mode, ...summary, network_used: true, trace_id: id, verification: 'not_visible_yet' }
}
async function main() {
  const [mode, ...flags] = process.argv.slice(2)
  if ((mode !== 'check' && mode !== 'smoke') || flags.length > 1 || flags.some(flag => !flag.startsWith('--config=') || !flag.slice('--config='.length).trim())) {
    console.error('Usage: langfuse check|smoke [--config=PATH]'); process.exitCode = 2; return
  }
  try {
    if (flags[0]) loadEnvFile(resolve(projectRoot, flags[0].slice('--config='.length)))
    const result = await diagnoseLangfuse(mode)
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 2
  } catch {
    console.error('Langfuse 检查未完成。请核对本机配置、网络与账号权限；未输出敏感错误。'); process.exitCode = 2
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
