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
    assert.deepEqual(results.map((event: any) => [event.phase, event.status, event.stage]), [['structure', expected, 'prompt_optimization'], ['structure', 'valid', expected === 'invalid_business' ? 'content_repair' : 'format_correction']])
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

test('business evidence failure remains visible and blocks later quality approval', async () => {
  const f = fixture('outline-evidence-invalid')
  f.observation.run(() => {
    reportModelResult({ phase: 'structure', stage: 'outline_review', status: 'invalid_business', failure_code: 'storyboard_review_invalid',
      evidence_ref_ids: ['evidence_0123456789abcdef'], evidence_fields: ['scene:1:start_state'], evidence_validation: 'failed' })
    reportModelResult({ phase: 'quality', stage: 'outline_review', status: 'passed' })
  })
  f.observation.finish('succeeded'); await f.tracer.flush()
  const spans = f.spans(), root = spans.find(span => !span.parentSpanId)!
  assert.equal(metadata(root).latest_structure_status, 'invalid_business')
  assert.equal(metadata(root).latest_quality_status, 'needs_work')
  const result = spans.find(span => span.name === '大纲校验:结构校验')!
  assert.equal(metadata(result).failure_code, 'storyboard_review_invalid')
  assert.deepEqual(metadata(result).evidence_ref_ids, ['evidence_0123456789abcdef'])
  assert.deepEqual(metadata(result).evidence_fields, ['scene:1:start_state'])
  assert.equal(metadata(result).evidence_validation, 'failed')
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

test('dialogue recovery exports request, validator and final failure under the locally persisted trace ID', async () => {
  const f = fixture('storyboard:dialogue-linked')
  await f.observation.run(() => withModelOperationStage('dialogue_source_correction', async () => {
    const context = currentModelRequestContext()!
    context.onDispatch?.({ request_id: 'local-fix', request_purpose: 'generation', structured_enforcement: 'native_json_schema_unverified' })
    context.onMetrics?.({ request_id: 'local-fix', http_status: 200, delivery: 'completed', structured_enforcement: 'native_json_schema_unverified' })
    reportModelResult({ phase: 'structure', status: 'invalid_business', failure_code: 'dialogue_ref_wrong_scene',
      repair_strategy: 'local_speech_item_correction', repair_count: 1, evidence_validation: 'failed', evidence_ref_ids: ['ds_abc123'], repaired_units: ['scenes.0.shots.1.audio_plan.speech.0'] })
  }, { scene_id: 'scene-a', shot_id: 'shot-b', field_path: 'scenes.0.shots.1.audio_plan.speech.0' }))
  f.observation.finish('failed'); await f.tracer.flush()
  const row = db.prepare('SELECT trace_context,results FROM model_request_tasks WHERE id=?').get(f.observation.id) as any
  const correlation = JSON.parse(row.trace_context), root = f.spans().find(span => !span.parentSpanId)!
  assert.equal(correlation.trace_id, root.traceId); assert.equal(correlation.root_span_id, root.spanId)
  assert.equal(correlation.enabled, true); assert.equal(correlation.sampled, true)
  assert.equal(metadata(root).state, 'failed')
  const validation = f.spans().find(span => metadata(span).failure_code === 'dialogue_ref_wrong_scene')!
  assert.equal(validation.traceId, root.traceId); assert.equal(validation.parentSpanId, root.spanId)
  assert.equal(metadata(validation).scene_id, 'scene-a'); assert.equal(metadata(validation).field_path, 'scenes.0.shots.1.audio_plan.speech.0')
  assert.equal(metadata(validation).repair_count, 1); assert.equal(metadata(validation).repair_strategy, 'local_speech_item_correction')
  assert.equal(JSON.parse(row.results)[0].failure_code, 'dialogue_ref_wrong_scene')
  const transport = f.spans().find(span => metadata(span).request_purpose === 'generation')!
  assert.equal(metadata(transport).structured_enforcement, 'native_json_schema_unverified')
  assert.equal(transport.status.code, 1, 'HTTP completion must not be relabeled as a disconnect')
})


test('source terminal and first-text diagnostics survive local observation before Langfuse export', async () => {
  const f = fixture('source-diagnostic-propagation')
  f.observation.run(() => withModelOperationStage('source_synthesis', () => {
    const context = currentModelRequestContext()!
    context.onDispatch?.({ request_id: 'source-diagnostic-request', request_purpose: 'generation' })
    context.onMetrics?.({ request_id: 'source-diagnostic-request', first_event_ms: 0, first_text_ms: 0,
      response_terminated: true, delivery: 'output_started', failure_reason: 'disconnected', raw_reason: 'stream_read_error',
      request_bytes: 100, response_chars: 10, input_tokens: 20, output_tokens: 0, output_started: true })
  }))
  f.observation.finish('failed'); await f.tracer.flush()
  const stored = db.prepare('SELECT metrics FROM model_request_attempts WHERE task_id=?').get(f.observation.id) as { metrics: string }
  const metrics = JSON.parse(stored.metrics)
  assert.equal(metrics.first_text_ms, 0); assert.equal(metrics.response_terminated, true)
  const child = f.spans().find(span => span.parentSpanId)!, data = metadata(child)
  assert.equal(child.name, '全剧整合:text')
  assert.equal(data.first_text_ms, 0); assert.equal(data.response_terminated, true)
  assert.equal(data.upstream_error_code, 'stream_read_error'); assert.equal(data.output_tokens, undefined)
})


test('successful generation with timed-out review remains explicitly inconclusive in local and Langfuse results', async () => {
  const f = fixture('generated-review-timeout')
  await f.observation.run(async () => {
    reportModelResult({ phase: 'structure', status: 'invalid_contract', stage: 'shot_expansion', issue_count: 1, field_paths: ['$.shots[0].expansion.directing'], schema_issue_codes: ['invalid_type'] })
    reportModelResult({ phase: 'structure', status: 'valid', stage: 'format_correction', first_pass_status: 'invalid_contract', repaired: true })
    reportModelResult({ phase: 'quality', status: 'inconclusive', stage: 'director_review', business_result: 'generated', review_status: 'review_inconclusive_no_action', failure_code: 'storyboard_review_timeout' })
  })
  f.observation.finish('succeeded'); await f.tracer.flush()
  const row = db.prepare('SELECT state,results FROM model_request_tasks WHERE id=?').get(f.observation.id) as any
  const events = JSON.parse(row.results)
  assert.equal(row.state, 'succeeded'); assert.equal(events.length, 3)
  assert.equal(events[0].field_paths[0], '$.shots[0].expansion.directing')
  assert.deepEqual(events[0].schema_issue_codes, ['invalid_type'])
  assert.deepEqual(metadata(f.spans().find(span => metadata(span).result_status === 'invalid_contract')!).schema_issue_codes, ['invalid_type'])
  assert.equal(events[1].first_pass_status, 'invalid_contract')
  assert.equal(events[2].review_status, 'review_inconclusive_no_action')
  const root = metadata(f.spans().find(span => !span.parentSpanId)!)
  assert.equal(root.business_result, 'generated'); assert.equal(root.review_status, 'review_inconclusive_no_action')
  assert.equal(root.latest_quality_status, 'inconclusive')
})


test('structural repair differences export phase paths and hashes without creative values', async () => {
  const f = fixture('structural-change-audit')
  const change = { source: 'schema_normalization' as const, field_path: '$.scenes[0].title', before_hash: 'a'.repeat(64), after_hash: 'b'.repeat(64) }
  await f.observation.run(async () => reportModelResult({ phase: 'structure', status: 'invalid_business', failure_code: 'structural_validator_outside_targets',
    structural_changes: [{ ...change, secret: 'never-export', before_value: 'private creative text' } as any] }))
  f.observation.finish('failed'); await f.tracer.flush()
  const row = db.prepare('SELECT results FROM model_request_tasks WHERE id=?').get(f.observation.id) as any
  assert.deepEqual(JSON.parse(row.results)[0].structural_changes, [change])
  const span = f.spans().find(span => metadata(span).failure_code === 'structural_validator_outside_targets')!
  assert.deepEqual(metadata(span).structural_changes, [change])
  assert.ok(!JSON.stringify(f.spans()).includes('private creative text'))
  assert.ok(!JSON.stringify(f.spans()).includes('never-export'))
})

test('visual input scope counts and hashes survive local and Langfuse observation without creative text or credentials', async () => {
  const f = fixture('visual-input-scope'), event = { phase: 'structure' as const, status: 'invalid_business' as const, stage: 'visual_organization' as const,
    input_scope_stage: 'catalog' as const, input_scope_hash: 'a'.repeat(64), input_scene_count: 1, input_shot_count: 5,
    input_scope_chars: 4200, input_rules_chars: 900, input_facts_chars: 1800, input_profiles_chars: 40, input_original_chars: 207000,
    input_boundary: 'transport' as const, input_scope_present: false, failure_code: 'visual_input_transport_missing' }
  f.observation.run(() => {
    currentModelRequestContext()!.onDispatch?.({ request_id: 'visual-scope', ...event, evidence: 'secret story bytes', api_key: 'never-export-key' })
    currentModelRequestContext()!.onMetrics?.({ request_id: 'visual-scope', delivery: 'completed', ...event })
    reportModelResult({ ...event, evidence: 'secret story bytes', api_key: 'never-export-key' } as any)
  })
  f.observation.finish('failed'); await f.tracer.flush()
  const row = db.prepare('SELECT results FROM model_request_tasks WHERE id=?').get('visual-input-scope') as any
  const result = JSON.parse(row.results)[0]
  assert.equal(result.input_shot_count, 5)
  assert.equal(result.input_scope_hash, event.input_scope_hash)
  const metas = f.spans().map(metadata)
  assert.ok(metas.some(meta => meta.input_boundary === 'transport' && meta.input_scope_hash === event.input_scope_hash && meta.input_scope_present === false))
  assert.ok(!JSON.stringify([row, metas]).includes('secret story bytes'))
  assert.ok(!JSON.stringify([row, metas]).includes('never-export-key'))
})


test('appearance results export separate local-validation and model-request counts without prose evidence', async () => {
  const f = fixture('coverage-request-counters')
  f.observation.run(() => reportModelResult({ phase: 'structure', status: 'invalid_contract', stage: 'visual_organization',
    unit_key: '@appearance:offline-shot', attempt: 1, model_request_count: 1, local_validation_count: 4,
    checkpoint_source: 'original_raw', is_new_model_call: false, failure_code: 'visual_coverage_conflict', request_category: 'local_reuse',
    evidence: 'private evidence must not export' } as any))
  f.observation.finish('succeeded'); await f.tracer.flush()
  const event = metadata(f.spans().find(span => span.parentSpanId)!)
  assert.equal(event.unit_key, '@appearance:offline-shot')
  assert.equal(event.model_request_count, 1); assert.equal(event.local_validation_count, 4)
  assert.equal(event.is_new_model_call, false); assert.equal(event.attempt, 1)
  assert.equal(event.failure_code, 'visual_coverage_conflict')
  assert.equal(JSON.stringify(f.spans()).includes('private evidence'), false)
})
