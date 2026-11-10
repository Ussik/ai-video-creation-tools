import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
const dataDir = await mkdtemp(join(tmpdir(),'model-observation-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { initDb, db } = await import('../src/infrastructure/database/db.js')
const { registerModelRequestObservation, observeModelTask, safeModelMetrics, activeModelRequestUsesModel } = await import('../src/modules/generation/model-request-observation.js')
const { currentModelRequestContext, reportModelUnitProgress } = await import('../src/modules/generation/model-task-policy.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
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
