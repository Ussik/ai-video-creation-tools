import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import Fastify from 'fastify'
const directory=await mkdtemp(join(tmpdir(),'business-task-history-'))
process.env.VIDEO_STUDIO_DATA_DIR=directory
const { db,initDb,run,one,now }=await import('../src/infrastructure/database/db.js');initDb()
const { registerAiOperations }=await import('../src/modules/generation/ai-operations.js')
const { registerBusinessTaskHistory,projectBusinessTasks,businessTaskDetails }=await import('../src/modules/jobs/business-task-history.js')
const { initModelRequestObservation }=await import('../src/modules/generation/model-request-observation.js');initModelRequestObservation()
const app=Fastify();registerAiOperations(app);registerBusinessTaskHistory(app)
app.post('/api/projects/:id/canvas/video-audio-plan',async (_request,reply)=>{reply.header('x-model-task-id','exact-model-task');return{status:'complete'}})
app.post('/api/projects/:id/script/replies/classify',async()=>({intent:'continue'}))
app.post('/api/projects/:id/skills/refine-prompt',async()=>({prompt:'结果'}))
app.post('/api/projects/:id/new-unknown-route',async()=>({result:'unknown'}))
app.post('/api/projects/:id/script/canvas/prepare',async()=>({preparation:{run_id:'exact-run',state:'partial'}}))
after(async()=>{await app.close();db.close();await rm(directory,{recursive:true,force:true})})
function project(){const id=randomUUID();run('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)',id,'夜巡人',now(),now());return id}
function shot(p:string){const id=randomUUID();run('INSERT INTO shots(id,project_id,position,title,created_at) VALUES(?,?,0,?,?)',id,p,'雨夜站台',now());return id}

test('one explicit user action becomes one named task and exact operation/model IDs own its details',async()=>{
 const p=project(),sid=shot(p),op=randomUUID()
 const request={method:'POST' as const,url:`/api/projects/${p}/canvas/video-audio-plan`,headers:{'x-ai-operation-id':op},payload:{shot_id:sid}}
 assert.equal((await app.inject(request)).statusCode,200)
 assert.equal((await app.inject(request)).statusCode,200)
 let history=projectBusinessTasks(p);assert.equal(history.tasks.length,1);assert.equal(history.tasks[0]!.title,'雨夜站台镜头声音设计')
 assert.deepEqual(history.tasks[0]!.scope.shot_ids,[sid]);assert.deepEqual(history.tasks[0]!.operation_ids,[op])
 run("INSERT INTO model_request_tasks(id,project_id,label,owner,state,usage,created_at,updated_at,results) VALUES('exact-model-task',?,'内部复核','request','succeeded',?,?,?,?)",p,JSON.stringify({requests:3,uncertain_requests:0}),now(),now(),JSON.stringify([{stage:'format_correction'},{stage:'recheck'},{stage:'local_reuse'}]))
 run("INSERT INTO model_request_tasks(id,project_id,label,owner,state,usage,created_at,updated_at) VALUES('same-time-unrelated',?,'无父内部操作','request','succeeded','{}',?,?)",p,now(),now())
 const details=businessTaskDetails(p,history.tasks[0]!.id)!
 assert.deepEqual(details.details!.models.map(row=>row.id),['exact-model-task']);assert.equal(details.details!.models[0]!.requests,3)
 assert.equal(details.details!.operations.length,1);assert.equal(projectBusinessTasks(p).tasks.length,1)
 assert.equal(projectBusinessTasks(p).legacy_unlinked_count,1)
 assert.ok(one('SELECT 1 FROM ai_operations WHERE id=?',op));assert.ok(one('SELECT 1 FROM model_request_tasks WHERE id=?','same-time-unrelated'))
})

test('unknown routes and parentless historical technical data never create generic main-list tasks',async()=>{
 const p=project()
 for(const path of ['script/replies/classify','new-unknown-route'])assert.equal((await app.inject({method:'POST',url:`/api/projects/${p}/${path}`,payload:{}})).statusCode,200)
 const legacy=randomUUID();run("INSERT INTO ai_operations(id,project_id,route,fingerprint,state,owner,lease_until,created_at,updated_at) VALUES(?,?,?,'hash','completed','old',0,?,?)",legacy,p,`/api/projects/${p}/visual-profiles/analyze`,now(),now())
 const before=one('SELECT * FROM ai_operations WHERE id=?',legacy)
 const history=projectBusinessTasks(p);assert.equal(history.tasks.length,0);assert.equal(history.legacy_unlinked_count,2)
 assert.deepEqual(one('SELECT * FROM ai_operations WHERE id=?',legacy),before)
})

test('planning history is grouped only by its durable task ID and names the episode scope',()=>{
 const p=project(),scene=randomUUID(),task=randomUUID()
 run("INSERT INTO script_scenes(id,project_id,position,heading,action,dialogue,narration,episode_number,created_at,updated_at) VALUES(?,?,0,'站台','','','',1,?,?)",scene,p,now(),now())
 const state={input:{scene_ids:[scene]},snapshot:{id:task,project_id:p,status:'failed',stage:'rechecking',started_at:Date.now(),updated_at:Date.now(),error:{message:'复核未完成'}}}
 run('INSERT INTO script_step_checkpoints VALUES(?,?,?,?,?)',p,`storyboard-planning-task:${task}`,'hash',JSON.stringify(state),now())
 const history=projectBusinessTasks(p);assert.equal(history.tasks.length,1);assert.equal(history.tasks[0]!.title,'第1集分镜规划')
 assert.deepEqual(history.tasks[0]!.model_task_ids,[`storyboard:${task}`]);assert.equal(history.tasks[0]!.domain_task_id,task)
 assert.equal(businessTaskDetails(project(),`planning:${task}`),undefined)
})

test('separate explicit actions stay separate and partial/unknown preparation is never labelled complete',async()=>{
 const p=project(),sid=shot(p)
 for(let i=0;i<2;i++)await app.inject({method:'POST',url:`/api/projects/${p}/script/canvas/prepare`,headers:{'x-ai-operation-id':randomUUID()},payload:{shot_ids:[sid]}})
 const history=projectBusinessTasks(p);assert.equal(history.tasks.length,2)
 assert.ok(history.tasks.every(task=>task.status==='interrupted'))
 assert.ok(history.tasks.every(task=>task.domain_task_id==='exact-run'))
})
