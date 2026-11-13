import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { projectRoot } from '../src/infrastructure/paths.js'
import { diagnoseLangfuse, readBackLangfuseTrace } from '../scripts/langfuse.js'
import { readLangfuseConfig } from '../src/infrastructure/observability/langfuse-tracing.js'
import type { ConfiguredLangfuseTracer } from '../src/infrastructure/observability/langfuse-tracing.js'

const enabled = { LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: 'public-must-not-appear', LANGFUSE_SECRET_KEY: 'secret-must-not-appear',
  LANGFUSE_BASE_URL: 'http://127.0.0.1:3035' }
const traceId = '5e906017e6be4c7f802a25c802b559ab'
const rootSpanId = 'aa906017e6be4c7f'
function fakeTracer(options: { failed?: number; dropped?: number; pending?: number } = {}) {
  const events: Array<{ kind: string; value: unknown }> = []
  const tracer: ConfiguredLangfuseTracer = {
    observation(value) { events.push({ kind: 'observation', value }); return {
      dispatch(value) { events.push({ kind: 'dispatch', value }) }, metrics(value) { events.push({ kind: 'metrics', value }) },
      finish(value) { events.push({ kind: 'finish', value }) },
    } },
    status: () => ({ enabled: true, pending: options.pending || 0, dropped: options.dropped || 0, failed: options.failed || 0, sent: 3, lastTraceId: traceId, lastRootSpanId: rootSpanId, incomplete: 0 }),
    async flush() { events.push({ kind: 'flush', value: null }) },
  }
  return { tracer, events }
}
test('configuration check makes no network calls and never prints keys or endpoint values', async () => {
  const result = await diagnoseLangfuse('check', enabled, { tracerFactory() { assert.fail('local check must not initialize a sender') } })
  assert.equal(result.ok, true); assert.equal(result.network_used, false)
  for (const secret of Object.values(enabled).filter(value => value !== 'true')) assert.ok(!JSON.stringify(result).includes(secret))
  const disabled = await diagnoseLangfuse('check', {})
  assert.equal(disabled.ok, true); assert.equal(disabled.reason, 'disabled')
  const missing = await diagnoseLangfuse('smoke', { LANGFUSE_TRACING: 'true' }, { tracerFactory() { assert.fail('missing config cannot upload') } })
  assert.equal(missing.ok, false); assert.equal(missing.network_used, false)
})
test('smoke uses synthetic metadata with forced sampling and verifies the same finished root by reading it back', async () => {
  const { tracer, events } = fakeTracer(); let reads = 0
  const result = await diagnoseLangfuse('smoke', { ...enabled, LANGFUSE_TRACING_SAMPLING_RATE: '0' }, {
    tracerFactory(config) { assert.equal(config.sampleRate, 1); return tracer }, pause: async () => {},
    async readTrace(id) { reads++; assert.equal(id, traceId); if (reads === 1) throw { status: 404 }; return { id, rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, endTime: '2026-11-13T00:00:00Z', delivery: 'completed' }] } },
  })
  assert.equal(result.ok, true); assert.equal(result.verification, 'readback_verified'); assert.equal(reads, 2)
  assert.deepEqual(events.map(event => event.kind), ['observation', 'dispatch', 'metrics', 'finish', 'flush'])
  assert.equal((events[0]!.value as { owner: string }).owner, 'diagnostic')
  const metadata = JSON.stringify(events)
  assert.ok(!metadata.includes('input_tokens')); assert.ok(!metadata.includes('output_tokens'))
  for (const secret of Object.values(enabled).filter(value => value !== 'true')) assert.ok(!metadata.includes(secret))
})
test('smoke cannot claim backend acceptance from flush, incomplete export, wrong root or read denial', async () => {
  for (const options of [{ failed: 1 }, { dropped: 1 }, { pending: 1 }]) {
    const { tracer } = fakeTracer(options)
    const result = await diagnoseLangfuse('smoke', enabled, { tracerFactory: () => tracer, readTrace: async () => assert.fail('incomplete export has no verified stored trace') })
    assert.equal(result.ok, false); assert.equal(result.verification, 'export_incomplete')
  }
  const { tracer } = fakeTracer()
  const wrong = await diagnoseLangfuse('smoke', enabled, { tracerFactory: () => tracer, pause: async () => {}, readTrace: async () => ({ id: 'other', rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, endTime: 'done', delivery: 'completed' }] }) })
  assert.equal(wrong.ok, false); assert.equal(wrong.verification, 'not_visible_yet')
  const denied = await diagnoseLangfuse('smoke', enabled, { tracerFactory: () => tracer, readTrace: async () => { throw { status: 403, message: 'key-must-not-appear' } } })
  assert.equal(denied.ok, false); assert.equal(denied.verification, 'read_permission_required')
  assert.ok(!JSON.stringify(denied).includes('key-must-not-appear'))
})


test('readback strips content and uses only explicit Basic auth without redirects', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  globalThis.fetch = async (input, options) => {
    calls++
    assert.equal(String(input), enabled.LANGFUSE_BASE_URL + '/api/public/v2/observations?traceId=' + traceId + '&fields=basic%2Cmetadata&limit=256')
    assert.equal(options?.redirect, 'error')
    assert.ok(options?.signal)
    const headers = new Headers(options?.headers)
    assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from(enabled.LANGFUSE_PUBLIC_KEY + ':' + enabled.LANGFUSE_SECRET_KEY).toString('base64'))
    assert.deepEqual([...headers.keys()].sort(), ['accept', 'authorization'])
    return Response.json({ data: [
      { id: rootSpanId, traceId, parentObservationId: null, isRootObservation: true, endTime: 'done', metadata: { state: 'succeeded', owner: 'diagnostic', secret: 'DO_NOT_RETURN' }, input: 'DO_NOT_RETURN' },
      { id: 'child', traceId, parentObservationId: rootSpanId, endTime: 'done', metadata: { delivery: 'completed', secret: 'DO_NOT_RETURN' }, output: 'DO_NOT_RETURN' },
      { id: 'other', traceId: 'another', metadata: { secret: 'DO_NOT_RETURN' } },
    ], meta: {} })
  }
  const result = await readBackLangfuseTrace(traceId, readLangfuseConfig(enabled))
  assert.deepEqual(result, { id: traceId, rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, endTime: 'done', delivery: 'completed' }] }); assert.equal(calls, 1)
})
test('smoke requires a completed child and successful root, not merely a visible trace', async () => {
  const { tracer } = fakeTracer()
  for (const trace of [
    { id: traceId, rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [] },
    { id: traceId, rootSpanId: 'another-root', state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, endTime: 'done', delivery: 'completed' }] },
    { id: traceId, rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: 'another-root', endTime: 'done', delivery: 'completed' }] },
    { id: traceId, rootSpanId, state: 'succeeded', owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, delivery: 'completed' }] },
    { id: traceId, rootSpanId, owner: 'diagnostic', observations: [{ id: 'child', parentSpanId: rootSpanId, endTime: 'done', delivery: 'completed' }] },
  ]) {
    const result = await diagnoseLangfuse('smoke', enabled, { tracerFactory: () => tracer, pause: async () => {}, readTrace: async () => trace })
    assert.equal(result.ok, false); assert.equal(result.verification, 'not_visible_yet')
  }
})

function isolatedCliEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LANGFUSE_') && !key.startsWith('VIDEO_STUDIO_LANGFUSE_')))
}
test('real npm CLI loads --config relative to the repository root despite the backend workspace cwd', async () => {
  const directory = await mkdtemp(join(projectRoot, '.langfuse-cli-test-'))
  try {
    const file = join(directory, 'synthetic config.env')
    await writeFile(file, 'LANGFUSE_TRACING=true\nLANGFUSE_PUBLIC_KEY=SYNTHETIC_CLI_PUBLIC_DO_NOT_PRINT\nLANGFUSE_SECRET_KEY=SYNTHETIC_CLI_SECRET_DO_NOT_PRINT\nLANGFUSE_BASE_URL=http://127.0.0.1:3035\n')
    const result = spawnSync('npm', ['run', 'langfuse:check', '--', `--config=${relative(projectRoot, file)}`], {
      cwd: projectRoot, env: isolatedCliEnvironment(), encoding: 'utf8', timeout: 20_000,
    })
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /"enabled": true/); assert.match(result.stdout, /"reason": "ready"/)
    assert.match(result.stdout, /"network_used": false/)
    assert.ok(!result.stdout.includes('SYNTHETIC_CLI_SECRET_DO_NOT_PRINT'))
    assert.ok(!result.stdout.includes('SYNTHETIC_CLI_PUBLIC_DO_NOT_PRINT'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('real CLI rejects empty configuration flags and masks a missing configuration file', () => {
  const options = { cwd: join(projectRoot, 'backend'), env: isolatedCliEnvironment(), encoding: 'utf8' as const, timeout: 20_000 }
  const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/langfuse.ts', 'check', '--config='], options)
  assert.equal(invalid.error, undefined); assert.equal(invalid.status, 2)
  assert.equal(invalid.stderr.trim(), 'Usage: langfuse check|smoke [--config=PATH]')
  const missing = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/langfuse.ts', 'check', '--config=.langfuse-test-definitely-missing.env'], options)
  assert.equal(missing.error, undefined); assert.equal(missing.status, 2)
  assert.match(missing.stderr, /Langfuse 检查未完成/)
  assert.ok(!missing.stderr.includes('ENOENT')); assert.ok(!missing.stderr.includes('definitely-missing'))
})


test('readback masks HTTP errors and bounds response size', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const config = readLangfuseConfig(enabled)
  globalThis.fetch = async () => new Response('PRIVATE_SERVER_ERROR', { status: 401 })
  await assert.rejects(readBackLangfuseTrace(traceId, config), (issue: unknown) => {
    assert.equal((issue as { status: number }).status, 401)
    assert.ok(!String(issue).includes('PRIVATE_SERVER_ERROR')); return true
  })
  globalThis.fetch = async () => new Response('x'.repeat(256 * 1024 + 1))
  await assert.rejects(readBackLangfuseTrace(traceId, config), /trace_readback_invalid/)
})
