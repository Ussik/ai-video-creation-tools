import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import type { LangfuseTracer } from '../src/infrastructure/observability/langfuse-tracing.js'
const dataDir = await mkdtemp(join(tmpdir(),'model-observation-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { initDb, db } = await import('../src/infrastructure/database/db.js')
const { registerModelRequestObservation, createModelRequestObservation, observeModelTask, safeModelMetrics, activeModelRequestUsesModel } = await import('../src/modules/generation/model-request-observation.js')
const { currentModelRequestContext, reportModelUnitProgress } = await import('../src/modules/generation/model-task-policy.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
const { observeProviderFetch } = await import('../src/infrastructure/providers/text-request-plan.js')
initDb()
db.prepare('INSERT INTO projects(id,name,brief,ratio,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','test','','16:9','now','now')
const app=Fastify()
registerModelRequestObservation(app)
app.post('/api/projects/:id/read',async()=>{
 const context=currentModelRequestContext()!
 const reservation=beginTextRequest({request_bytes:100,estimated_input_tokens:50,reserved_output_tokens:1000})
 reportModelUnitProgress({ phase_id: 'shots', label: '逐场分镜', completed_units: 2, total_units: 5 })
 reportModelUnitProgress({ phase_id: 'review', label: '审读分页', completed_units: 3, total_units: null })
 context.onDispatch?.({request_id:'r1',request_bytes:100,endpoint:'https://example.com/api?key=secret',prompt:'secret'})
 reservation.complete({input_tokens:40})
 context.onMetrics?.({request_id:'r1',request_bytes:100,input_tokens:40,delivery:'unknown'})
 return {id:context.taskId}
})
let runningId='', started!:()=>void
const dispatched=new Promise<void>(resolve=>{started=resolve})
app.post('/api/projects/:id/slow',async()=>{
 const context=currentModelRequestContext()!; runningId=context.taskId!
 beginTextRequest({request_bytes:10,estimated_input_tokens:2,reserved_output_tokens:100})
 context.onDispatch?.({request_id:'slow1',model_id:'aux-model',request_bytes:10}); started()
 await new Promise<void>((_resolve,reject)=>context.signal!.addEventListener('abort',()=>reject(context.signal!.reason),{once:true}))
 throw new Error('unreachable')
})
test('request hooks keep one scope across handler and persist unknown usage, excluding secrets',async()=>{
 const response=await app.inject({method:'POST',url:'/api/projects/p/read',payload:{}})
 assert.equal(response.statusCode,200)
 const rows=(await app.inject('/api/projects/p/model-requests')).json()
 const row=rows.find((item:{id:string})=>item.id===response.json().id)
 assert.equal(row.state,'succeeded'); assert.equal(row.usage.requests,1); assert.equal(row.usage.input_tokens,40)
 assert.equal(row.usage.uncertain_requests,1); assert.equal(row.usage.estimated_output_tokens,1000)
 assert.deepEqual(row.progress, [{ phase_id: 'shots', label: '逐场分镜', completed_units: 2, total_units: 5 }, { phase_id: 'review', label: '审读分页', completed_units: 3, total_units: null }])
 assert.equal(row.attempts.length,1); assert.ok(!JSON.stringify(row).includes('secret'))
 assert.deepEqual(safeModelMetrics({endpoint:'https://host/path?api_key=secret',prompt:'secret',input_tokens:3}),{endpoint:'https://host/path',input_tokens:3})
})
test('stopping a request reaches its backend signal and does not report provider cancellation',async()=>{
 const pending=app.inject({method:'POST',url:'/api/projects/p/slow',payload:{}})
 await dispatched
 assert.equal(activeModelRequestUsesModel('aux-model'),true)
 const result=await app.inject({method:'POST',url:`/api/projects/p/model-requests/${runningId}/stop`,payload:{}})
 assert.deepEqual(result.json(),{stopped:true,remote_cancelled:false})
 await pending
 assert.equal(activeModelRequestUsesModel('aux-model'),false)
 const rows=(await app.inject('/api/projects/p/model-requests')).json()
 assert.equal(rows.find((row:{id:string})=>row.id===runningId).state,'cancelled')
})
test('background retries retain cumulative usage; independent tasks do not mix ledgers',async()=>{
 for(let index=0;index<2;index++) await observeModelTask({taskId:'job:test',projectId:'p',owner:'job',label:'text'},async()=>{
 const reservation=beginTextRequest({request_bytes:10,estimated_input_tokens:2,reserved_output_tokens:100})
 reservation.complete({input_tokens:2,output_tokens:3})
 })
 const rows=(await app.inject('/api/projects/p/model-requests')).json()
 const row=rows.find((row:{id:string})=>row.id==='job:test')
 assert.equal(row.usage.requests,2);assert.equal(row.usage.output_tokens,6);assert.equal(row.usage.uncertain_requests,0)
})
test.after(async()=>{await app.close();db.close();await rm(dataDir,{recursive:true,force:true})})


test('injected tracing follows the request observation without receiving creative content', async () => {
 const traces: Array<{ options: Parameters<LangfuseTracer['observation']>[0]; events: Array<{ phase: string; value: unknown }> }> = []
 const tracer: LangfuseTracer = { observation(options) {
  const trace = { options, events: [] as Array<{ phase: string; value: unknown }> }; traces.push(trace)
  return { dispatch: value => trace.events.push({ phase: 'dispatch', value }), metrics: value => trace.events.push({ phase: 'metrics', value }),
   finish: value => trace.events.push({ phase: 'finish', value }) }
 } }
 const server = Fastify(); registerModelRequestObservation(server, tracer)
 server.post('/api/projects/:id/traced', async () => {
  const context = currentModelRequestContext()!
  context.onDispatch?.({ request_id: 'trace-request', request_bytes: 25, request_purpose: 'review', prompt: 'private manuscript', headers: { Authorization: 'private key' } })
  context.onMetrics?.({ request_id: 'trace-request', input_tokens: 3, output_tokens: 2, delivery: 'completed', raw_output: 'private candidate', reasoning: 'private reasoning' })
  return { candidate: 'private completed result' }
 })
 try {
  const response = await server.inject({ method: 'POST', url: '/api/projects/p/traced', payload: { instructions: 'private instructions' } })
  assert.equal(response.statusCode, 200); assert.equal(response.json().candidate, 'private completed result')
  assert.equal(traces.length, 1); assert.equal(traces[0]!.options.taskId, response.headers['x-model-task-id'])
  assert.equal(traces[0]!.options.projectId, 'p'); assert.equal(traces[0]!.options.owner, 'request')
  assert.deepEqual(traces[0]!.events, [
   { phase: 'dispatch', value: { request_bytes: 25, request_id: 'trace-request', request_purpose: 'review' } },
   { phase: 'metrics', value: { input_tokens: 3, output_tokens: 2, request_id: 'trace-request', delivery: 'completed' } },
   { phase: 'finish', value: 'succeeded' },
  ])
  assert.ok(!JSON.stringify(traces).includes('private'))
 } finally { await server.close() }
})

test('tracing still receives dispatch and settlement when local diagnostic writes fail', () => {
 const events: Array<{ phase: string; value: unknown }> = []
 const tracer: LangfuseTracer = { observation: () => ({ dispatch: value => events.push({ phase: 'dispatch', value }),
  metrics: value => events.push({ phase: 'metrics', value }), finish: value => events.push({ phase: 'finish', value }) }) }
 const observation = createModelRequestObservation({ taskId: 'trace-local-write-failure', projectId: 'p', owner: 'request', label: 'test' }, tracer)
 db.exec("CREATE TEMP TRIGGER fail_trace_local_attempt BEFORE INSERT ON model_request_attempts WHEN NEW.task_id='trace-local-write-failure' BEGIN SELECT RAISE(FAIL,'local attempt storage unavailable'); END")
 const original = console.error; console.error = () => {}
 try {
  const result = observation.run(() => {
   const context = currentModelRequestContext()!
   context.onDispatch?.({ request_id: 'local-failed', request_bytes: 20 })
   context.onMetrics?.({ request_id: 'local-failed', input_tokens: 2, delivery: 'completed' })
   return 'original result'
  })
  observation.finish('succeeded')
  assert.equal(result, 'original result')
  assert.deepEqual(events.map(event => event.phase), ['dispatch', 'metrics', 'finish'])
 } finally { console.error = original; db.exec('DROP TRIGGER fail_trace_local_attempt') }
})

test('tracing creation and event failures never change the domain result or dispatch count', () => {
 let dispatches = 0
 const fail = () => { throw new Error('tracing unavailable') }
 for (const tracer of [{ observation: fail }, { observation: () => ({ dispatch: fail, metrics: fail, finish: fail }) }] satisfies LangfuseTracer[]) {
  const observation = createModelRequestObservation({ projectId: 'p', owner: 'request', label: 'test' }, tracer)
  const result = observation.run(() => {
   const context = currentModelRequestContext()!
   dispatches++
   context.onDispatch?.({ request_id: `trace-failure-${dispatches}`, request_bytes: 3 })
   context.onMetrics?.({ request_id: `trace-failure-${dispatches}`, delivery: 'completed' })
   return 'one result'
  })
  observation.finish('succeeded'); assert.equal(result, 'one result')
 }
 assert.equal(dispatches, 2, 'each domain execution is called once with no observability retry')
})


test('trace-only stage reaches the external observer without extending strict local/public metrics', async () => {
  const { createModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
  const { modelContextFor, withModelRequestContext } = await import('../src/modules/generation/model-task-policy.js')
  const events: Record<string, unknown>[] = []
  const observed = createModelRequestObservation({ taskId: 'trace-stage-isolation', projectId: 'p', owner: 'request', label: 'local label' }, {
    observation() { return { dispatch(value) { events.push(value as Record<string, unknown>) }, metrics() {}, finish() {} } },
  })
  observed.run(() => {
    const context = modelContextFor('storyboard_targeted_repair')
    withModelRequestContext(context, () => currentModelRequestContext()?.onDispatch?.({ request_id: 'stage-only' }))
  })
  observed.finish('succeeded')
  assert.equal(events[0]?.trace_stage, 'repair')
  const row = db.prepare('SELECT metrics FROM model_request_attempts WHERE task_id=?').get(observed.id) as { metrics: string }
  assert.ok(!('trace_stage' in JSON.parse(row.metrics)))
})


test('media creation, speech and result transports count actual dispatches without reserving text tokens', async () => {
  const taskId = 'job:media-counts', bodies = ['{"prompt":"image"}', '{"text":"speech"}']
  await observeModelTask({ taskId, projectId: 'p', owner: 'job', label: 'media' }, async () => {
    for (const [transport, body] of [['media_create', bodies[0]], ['speech_create', bodies[1]],
      ['media_poll', undefined], ['media_download', undefined]] as const) {
      const response = await observeProviderFetch('https://offline.invalid/request', { method: body ? 'POST' : 'GET', body }, transport,
        async () => new Response(transport === 'media_download' ? 'media bytes' : '{}'))
      await response.text()
    }
  })
  const row = db.prepare('SELECT usage FROM model_request_tasks WHERE id=?').get(taskId) as { usage: string }
  const usage = JSON.parse(row.usage)
  assert.equal(usage.requests, 2)
  assert.equal(usage.request_bytes, bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0))
  assert.equal(usage.transport_requests, 2); assert.equal(usage.transport_request_bytes, 0)
  assert.equal(usage.uncertain_requests, 0); assert.deepEqual(usage.pending_requests, [])
  assert.equal(usage.estimated_input_tokens, 0); assert.equal(usage.estimated_output_tokens, 0)
  const attempts = db.prepare('SELECT state FROM model_request_attempts WHERE task_id=?').all(taskId) as Array<{ state: string }>
  assert.equal(attempts.length, 4); assert.ok(attempts.every(attempt => attempt.state === 'settled'))
})

test('resuming a mixed task counts new media dispatches once and preserves pending text usage', async () => {
  const taskId = 'job:mixed-counts', request = { request_id: 'media-once', kind: 'generation', transport_kind: 'media_create', request_bytes: 21 }
  await observeModelTask({ taskId, projectId: 'p', owner: 'job', label: 'mixed' }, async () => {
    const context = currentModelRequestContext()!
    const text = beginTextRequest({ request_bytes: 12, estimated_input_tokens: 10, reserved_output_tokens: 30 })
    text.identify('text-once')
    context.onDispatch?.({ request_id: 'text-once', request_bytes: 12, kind: 'generation', transport_kind: 'text' })
    text.complete({ input_tokens: 8 })
    context.onMetrics?.({ request_id: 'text-once', input_tokens: 8, delivery: 'unknown' })
    context.onDispatch?.(request)
    context.onDispatch?.(request)
    context.onMetrics?.({ ...request, delivery: 'completed' })
    context.onMetrics?.({ ...request, delivery: 'completed' })
  })
  await observeModelTask({ taskId, projectId: 'p', owner: 'job', label: 'mixed' }, async () => {
    const context = currentModelRequestContext()!
    context.onDispatch?.(request)
    context.onMetrics?.({ ...request, delivery: 'completed' })
    const poll = { request_id: 'new-poll', kind: 'transport', transport_kind: 'media_poll', request_bytes: 7 }
    context.onDispatch?.(poll); context.onMetrics?.({ ...poll, delivery: 'completed' })
  })
  const row = db.prepare('SELECT usage FROM model_request_tasks WHERE id=?').get(taskId) as { usage: string }
  const usage = JSON.parse(row.usage)
  assert.equal(usage.requests, 2); assert.equal(usage.request_bytes, 33)
  assert.equal(usage.transport_requests, 1); assert.equal(usage.transport_request_bytes, 7)
  assert.equal(usage.input_tokens, 8); assert.equal(usage.output_tokens, 0)
  assert.equal(usage.uncertain_requests, 1); assert.equal(usage.pending_requests.length, 1)
  assert.equal(usage.pending_requests[0].id, 'text-once')
  assert.equal(usage.pending_requests[0].input_settled, true); assert.equal(usage.pending_requests[0].output_settled, false)
  assert.equal(usage.estimated_input_tokens, 0); assert.equal(usage.estimated_output_tokens, 30)
})


test('a media request whose connection fails is still counted once without inventing text usage', async () => {
  const taskId = 'job:media-unknown'
  await assert.rejects(observeModelTask({ taskId, projectId: 'p', owner: 'job', label: 'media' }, async () => {
    await observeProviderFetch('https://offline.invalid/create', { method: 'POST', body: '{}' }, 'media_create',
      async () => { throw new TypeError('offline connection reset') })
  }), /offline connection reset/)
  const row = db.prepare('SELECT state,usage FROM model_request_tasks WHERE id=?').get(taskId) as { state: string; usage: string }
  const usage = JSON.parse(row.usage)
  assert.equal(row.state, 'failed'); assert.equal(usage.requests, 1); assert.equal(usage.request_bytes, 2)
  assert.equal(usage.transport_requests, 0)
  assert.equal(usage.uncertain_requests, 0); assert.deepEqual(usage.pending_requests, [])
  assert.equal(usage.estimated_input_tokens, 0); assert.equal(usage.estimated_output_tokens, 0)
  const attempt = db.prepare('SELECT state,metrics FROM model_request_attempts WHERE task_id=?').get(taskId) as { state: string; metrics: string }
  assert.equal(attempt.state, 'settled'); assert.equal(JSON.parse(attempt.metrics).delivery, 'unknown')
  assert.equal(JSON.parse(attempt.metrics).failure_reason, 'disconnected')
})
