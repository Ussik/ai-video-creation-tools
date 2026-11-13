import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { z } from 'zod'
import { createLangfuseTracer, readLangfuseConfig, type LangfuseBatch, type LangfuseSpan } from '../src/infrastructure/observability/langfuse-tracing.js'
import { reportModelResult, safeModelResult, withModelOperationStage } from '../src/modules/generation/model-result-observation.js'
import { currentModelRequestContext, modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { generateStructuredOutput } from '../src/modules/generation/model-output.js'
import { beginProviderDispatch } from '../src/infrastructure/providers/text-request-usage.js'

const directory = await mkdtemp(join(tmpdir(), 'model-results-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db } = await import('../src/infrastructure/database/db.js')
const { initModelRequestObservation, createModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
initDb(); initModelRequestObservation()
db.prepare('INSERT INTO projects(id,name,brief,ratio,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p', 'test', '', '16:9', 'now', 'now')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const config = readLangfuseConfig({ LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'http://localhost:3035' })
function fixture(id: string) {
  const batches: LangfuseBatch[] = []
  const tracer = createLangfuseTracer(config, { clientFactory: () => ({ async send(batch) { batches.push(batch) } }) })
  const observation = createModelRequestObservation({ taskId: id, projectId: 'p', label: 'private prompt', owner: 'request' }, tracer)
  return { tracer, observation, spans: () => batches.flatMap(batch => batch.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))) }
}
const metadata = (span: LangfuseSpan) => Object.fromEntries(span.attributes.filter(item => item.key.startsWith('langfuse.observation.metadata.')).map(item => [item.key.slice('langfuse.observation.metadata.'.length), JSON.parse(item.value.stringValue!)]))

test('transport and execution success remain separate from invalid structure and failed quality with safe readable stages', async () => {
  const f = fixture('separate-outcomes')
  await f.observation.run(() => withModelOperationStage('shot_expansion', async () => {
    const context = currentModelRequestContext()!
    context.onDispatch?.({ request_id: 'paid-1', request_purpose: 'generation' })
    context.onMetrics?.({ request_id: 'paid-1', delivery: 'completed', input_tokens: 5, output_tokens: 3 })
    reportModelResult({ phase: 'structure', status: 'invalid_contract', issue_count: 2 })
    reportModelResult({ phase: 'quality', status: 'needs_work', issue_count: 1, repaired: true, repair_effect: 'unchanged', secret: 'never-export' } as any)
  }, { unit_index: 1, unit_count: 2 }))
  f.observation.finish('succeeded'); await f.tracer.flush()
  const row = db.prepare('SELECT state,results FROM model_request_tasks WHERE id=?').get(f.observation.id) as any
  assert.equal(row.state, 'succeeded')
  const results = JSON.parse(row.results)
  assert.deepEqual(results.map((event: any) => event.status), ['invalid_contract', 'needs_work'])
  const spans = f.spans(), root = spans.find(span => !span.parentSpanId)!
  assert.equal(metadata(root).state, 'succeeded')
  assert.equal(metadata(spans.find(span => span.name === '镜头扩写 2:text')!).delivery, 'completed')
  assert.equal(metadata(spans.find(span => span.name === '镜头扩写:质量结果')!).result_status, 'needs_work')
  assert.ok(spans.filter(span => span.parentSpanId).every(span => span.traceId === root.traceId && span.parentSpanId === root.spanId))
  assert.equal(JSON.stringify(spans).includes('never-export'), false)
  assert.equal(JSON.stringify(spans).includes('private prompt'), false)
  assert.ok(!JSON.stringify(spans).includes('"cost"'))
})

test('format correction records syntax, field and business failures independently and never grants quality approval', async () => {
  for (const [id, initial, validation, expected] of [
    ['syntax', '{"value":', undefined, 'invalid_json'],
    ['field', '{"value":3}', undefined, 'invalid_contract'],
    ['business', '{"value":"bad"}', (value: { value: string }) => { if (value.value === 'bad') throw Object.assign(new Error('wrong source'), { statusCode: 422 }) }, 'invalid_business'],
  ] as const) {
    const f = fixture(id), stages: unknown[] = []
    let calls = 0
    await f.observation.run(() => withModelOperationStage('prompt_optimization', () => generateStructuredOutput('renamed_result', z.object({ value: z.string() }), async (_prompt, _contract, context) => {
      stages.push([context?.operationStage, currentModelRequestContext()?.operationStage])
      return ++calls === 1 ? initial : '{"value":"good"}'
    }, 'source', { validate: validation })))
    f.observation.finish('succeeded')
    const results = JSON.parse((db.prepare('SELECT results FROM model_request_tasks WHERE id=?').get(id) as any).results)
    assert.deepEqual(results.map((event: any) => [event.phase, event.status, event.stage]), [['structure', expected, 'prompt_optimization'], ['structure', 'valid', 'format_correction']])
    assert.deepEqual(stages, [['prompt_optimization', 'prompt_optimization'], ['format_correction', 'format_correction']])
    assert.equal(calls, 2)
    await f.tracer.flush()
  }
})

test('invalid diagnostic values and throwing sinks cannot change a model result, approval or context', async () => {
  assert.equal(safeModelResult({ phase: 'structure', status: 'passed' }), undefined)
  assert.equal(safeModelResult({ phase: 'quality', status: 'valid' }), undefined)
  assert.deepEqual(safeModelResult({ phase: 'quality', status: 'passed', stage: 'private', issue_count: -1, prompt: 'secret', repair_effect: 'invented' }), { phase: 'quality', status: 'passed' })
  const original = { policy: modelTaskPolicies.generation, taskId: 'original', onResult() { throw new Error('diagnostic sink failed') } }
  const value = await withModelRequestContext(original, () => withModelOperationStage('source_analysis', async () => {
    assert.equal(currentModelRequestContext()?.policy, modelTaskPolicies.generation)
    reportModelResult({ phase: 'quality', status: 'inconclusive' }); return 'retained'
  }))
  assert.equal(value, 'retained'); assert.equal(currentModelRequestContext(), undefined)
})

test('a closed observation cannot overwrite a resumed quality record or append late validation results', async () => {
  const old = fixture('reused-quality')
  old.observation.run(() => reportModelResult({ phase: 'quality', status: 'needs_work' }))
  old.observation.finish('cancelled')
  const resumed = fixture('reused-quality')
  resumed.observation.run(() => reportModelResult({ phase: 'quality', status: 'passed' }))
  resumed.observation.finish('succeeded')
  const before = db.prepare('SELECT state,results FROM model_request_tasks WHERE id=?').get('reused-quality')
  old.observation.run(() => reportModelResult({ phase: 'quality', status: 'needs_work' }))
  old.observation.finish('failed')
  assert.deepEqual(db.prepare('SELECT state,results FROM model_request_tasks WHERE id=?').get('reused-quality'), before)
  await old.tracer.flush(); await resumed.tracer.flush()
})

test('auxiliary admitted generation and transport counts are recorded once without fake tokens', async () => {
  const f = fixture('auxiliary-admission')
  f.observation.run(() => {
    for (const [id, kind, transport] of [['create', 'generation', 'media_create'], ['count', 'transport', 'input_count']] as const) {
      const admission = beginProviderDispatch({ kind, request_bytes: 12 })
      currentModelRequestContext()!.onDispatch?.({ request_id: id, kind, transport_kind: transport, usage_admitted: admission.admitted, request_bytes: 12 })
      admission.complete()
      currentModelRequestContext()!.onMetrics?.({ request_id: id, kind, transport_kind: transport, delivery: 'completed' })
    }
  })
  f.observation.finish('succeeded')
  const usage = JSON.parse((db.prepare('SELECT usage FROM model_request_tasks WHERE id=?').get('auxiliary-admission') as any).usage)
  assert.equal(usage.requests, 1); assert.equal(usage.transport_requests, 1)
  assert.equal(usage.input_tokens, 0); assert.equal(usage.estimated_output_tokens, 0)
  assert.deepEqual(usage.pending_requests, [])
  await f.tracer.flush()
})


test('bounded result spans retain the final quality state on long workflows', async () => {
  const f = fixture('many-results')
  f.observation.run(() => {
    for (let index = 0; index < 140; index++) reportModelResult({ phase: 'structure', status: 'valid', stage: 'shot_expansion' })
    reportModelResult({ phase: 'quality', status: 'needs_work', stage: 'recheck', issue_count: 1 })
  })
  f.observation.finish('succeeded'); await f.tracer.flush()
  const root = f.spans().find(span => !span.parentSpanId)!
  assert.equal(metadata(root).latest_quality_status, 'needs_work')
  assert.equal(metadata(root).latest_quality_stage, 'recheck')
  assert.equal(metadata(root).omitted_result_count, 13)
  assert.equal(f.spans().filter(span => span.parentSpanId).length, 128)
  const results = JSON.parse((db.prepare('SELECT results FROM model_request_tasks WHERE id=?').get('many-results') as any).results)
  assert.equal(results.length, 128); assert.equal(results.at(-1).status, 'needs_work')
})

test('recheck dispatch keeps its fine stage even with an explicit review policy', async () => {
  const f = fixture('fine-recheck')
  const observed: unknown[] = []
  await f.observation.run(() => withModelOperationStage('recheck', () => generateStructuredOutput('storyboard_directing_review', z.object({ ok: z.boolean() }),
    async (_text, _contract, context) => { observed.push(context?.operationStage, currentModelRequestContext()?.operationStage); return '{"ok":true}' },
    'source', { context: { policy: modelTaskPolicies.review } })))
  f.observation.finish('succeeded'); await f.tracer.flush()
  assert.deepEqual(observed, ['recheck', 'recheck'])
})
