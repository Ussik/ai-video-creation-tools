import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const directory = await mkdtemp(join(tmpdir(), 'shot-derived-purge-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, one, now, mediaDir } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive:true, force:true }) })
async function setup() {
  const id=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'派生资源删除回归'}})).json().id
  const sid=(await app.inject({method:'POST',url:`/api/projects/${id}/shots`,payload:{title:'派生分镜'}})).json().id
  run('UPDATE shots SET deleted_at=? WHERE id=?',now(),sid)
  return {id,sid}
}
test('purge recovers detached media ownership from the original generation request',async()=>{
  const {id,sid}=await setup();await mkdir(mediaDir,{recursive:true})
  const path=join(mediaDir,'detached.png');await writeFile(path,'fixture')
  run("INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,created_at) VALUES('detached-media',?,NULL,'image','detached.png',?,'generated',?)",id,path,now())
  run("INSERT INTO jobs(id,project_id,shot_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES('detached-job',?,NULL,'generation',?,'succeeded','detached-media',?,?)",id,JSON.stringify({shot_id:sid}),now(),now())
  const p=await app.inject({method:'POST',url:`/api/projects/${id}/shot-management/purge-preview`,payload:{shot_ids:[sid]}})
  assert.equal(p.statusCode,200,p.body)
  assert.ok(p.json().delete.some((r:any)=>r.kind==='jobs'),'original request proves ownership even when ON DELETE SET NULL erased the FK')
  const done=await app.inject({method:'POST',url:`/api/projects/${id}/shot-management/purge`,payload:{shot_ids:[sid],revision:p.json().revision}})
  assert.equal(done.statusCode,200,done.body)
  assert.equal(one('SELECT 1 FROM jobs WHERE id=?','detached-job'),undefined)
  assert.equal(one('SELECT 1 FROM assets WHERE id=?','detached-media'),undefined)
  await assert.rejects(stat(path),{code:'ENOENT'})
})
test('legacy shot DELETE cannot bypass preview and erase ownership before derived cleanup',async()=>{
  const {id,sid}=await setup()
  run('UPDATE shots SET deleted_at=NULL WHERE id=?',sid)
  const response=await app.inject({method:'DELETE',url:`/api/shots/${sid}`})
  assert.equal(response.statusCode,409,response.body)
  assert.ok(one('SELECT 1 FROM shots WHERE id=? AND project_id=?',sid,id))
})

const {generationUnitStore}=await import('../src/modules/generation/generation-unit-store.js')
const {recordShotProfileOrigin}=await import('../src/modules/storyboard/shot-resource-origins.js')
const {assetPreviewPaths,createAssetPreviewCache}=await import('../src/modules/assets/asset-previews.js')
const {saveStoryboardPlanningPreview}=await import('../src/modules/storyboard/storyboard-planning-preview.js')
const {generationCheckpointStore}=await import('../src/modules/script/script-generation-checkpoints.js')
async function scene(project:string,sid:string) {
  const id='scene-'+sid
  run('INSERT INTO script_scenes(id,project_id,position,heading,created_at,updated_at) VALUES(?,?,0,?,?,?)',id,project,'原文场次',now(),now())
  run('UPDATE shots SET source_scene_id=? WHERE id=?',id,sid)
  run('INSERT INTO storyboard_scene_plans VALUES(?,?,?,?)',id,project,'source-fingerprint',now())
  return id
}
test('residual purge replays the SET NULL incident, removes generated base references and preserves upstream scenes',async()=>{
  const {id,sid}=await setup(),sceneId=await scene(id,sid),pid='profile-'+sid
  run("INSERT INTO visual_profiles(id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES(?,?,'character','生成参考','完整生成定义','正面',?,?)",pid,id,now(),now())
  run('INSERT INTO scene_visual_bindings VALUES(?,?,1)',sceneId,pid)
  run('INSERT INTO script_canvas_preparations VALUES(?,?,?)',sceneId,'prepared',JSON.stringify([pid]))
  recordShotProfileOrigin(id,pid,[sid],[sceneId])
  const store=generationUnitStore(id,'canvas-reference-commits',{fixture:sid})
  store.save({steps:{committed:{input_hash:'e'.repeat(64),value:{result:{scene_ids:[sceneId],visual_profiles:[{id:pid}]}}}}})
  run("INSERT INTO jobs(id,project_id,shot_id,job_type,request,status,created_at,updated_at) VALUES(?,?,?,'generation',?,'succeeded',?,?)",'job-'+sid,id,sid,JSON.stringify({shot_id:sid}),now(),now())
  run('DELETE FROM shots WHERE id=?',sid) // Reproduce the historical FK detachment without changing production data.
  assert.equal(one<{shot_id:null}>('SELECT shot_id FROM jobs WHERE id=?','job-'+sid)?.shot_id,null)
  const root=`/api/projects/${id}/shot-management`
  const scope=(await app.inject({url:root+'/residual-scope'})).json()
  assert.deepEqual(scope.shots.map((s:any)=>s.id),[sid])
  const payload={shot_ids:[sid],scene_ids:[sceneId]}
  const p=(await app.inject({method:'POST',url:root+'/residual-purge-preview',payload})).json()
  assert.deepEqual(p.blockers,[]);assert.ok(p.delete.some((x:any)=>x.kind==='visual_profiles'))
  const result=await app.inject({method:'POST',url:root+'/residual-purge',payload:{...payload,revision:p.revision}})
  assert.equal(result.statusCode,200,result.body)
  assert.ok(one('SELECT 1 FROM script_scenes WHERE id=?',sceneId))
  for(const table of ['visual_profiles','jobs','storyboard_scene_plans'])assert.equal(one(`SELECT 1 FROM ${table} WHERE project_id=?`,id),undefined)
  assert.equal(one('SELECT 1 FROM script_canvas_preparations WHERE scene_id=?',sceneId),undefined)
  assert.throws(()=>store.save({steps:{}}),{code:'generation_scope_purged'})
  assert.equal(generationUnitStore(id,'canvas-reference-commits',{fixture:sid}).read().steps.committed,undefined)
})
test('unproved historical roots and scenes with surviving shots cannot expand residual cleanup',async()=>{
  const {id,sid}=await setup(),sceneId=await scene(id,sid),root=`/api/projects/${id}/shot-management`
  const invalid=await app.inject({method:'POST',url:root+'/residual-purge-preview',payload:{shot_ids:['made-up-deleted-shot'],scene_ids:[sceneId]}})
  assert.equal(invalid.statusCode,422)
  assert.ok(one('SELECT 1 FROM shots WHERE id=?',sid))
  assert.ok(one('SELECT 1 FROM script_scenes WHERE id=?',sceneId))
})
test('purge removes exact thumbnail derivatives and refuses late checkpoint, preview and operation replay',async()=>{
  const {id,sid}=await setup(),sceneId=await scene(id,sid)
  await mkdir(mediaDir,{recursive:true});const path=join(mediaDir,sid+'.png')
  await writeFile(path,'fixture media')
  const aid='thumb-'+sid
  run("INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,created_at) VALUES(?,?,?,'image','thumb.png',?,'generated',?)",aid,id,sid,path,now())
  const cache=assetPreviewPaths({id:aid,path,kind:'image'},join(mediaDir,id,'.previews'))[0]!
  await mkdir(join(mediaDir,id,'.previews'),{recursive:true});await writeFile(cache,'fixture cache')
  const op='operation-'+sid
  run("INSERT INTO ai_operations(id,project_id,route,fingerprint,state,status_code,result,owner,lease_until,created_at,updated_at) VALUES(?,?,?,'fixture','completed',200,?,'fixture',0,?,?)",op,id,`/api/projects/${id}/generate`,JSON.stringify({shot_id:sid}),now(),now())
  saveStoryboardPlanningPreview(id,'old-preview',{scenes:[{scene_id:sceneId}]})
  const history=generationCheckpointStore(id,{fixture:sid},'candidate-scope')
  history.save({steps:{draft:{input_hash:'f'.repeat(64),value:{shot_id:sid}}}})
  const root=`/api/projects/${id}/shot-management`,payload={shot_ids:[sid]}
  const p=(await app.inject({method:'POST',url:root+'/purge-preview',payload})).json()
  assert.equal(p.files.length,2)
  assert.equal((await app.inject({method:'POST',url:root+'/purge',payload:{...payload,revision:p.revision}})).statusCode,200)
  for(const file of [path,cache])await assert.rejects(stat(file),{code:'ENOENT'})
  assert.throws(()=>history.save({steps:{}}),{code:'generation_scope_purged'})
  assert.throws(()=>saveStoryboardPlanningPreview(id,'old-preview',{scenes:[]},0),{code:'generation_scope_purged'})
  assert.equal((await app.inject({method:'POST',url:`/api/projects/${id}/generate`,headers:{'x-ai-operation-id':op},payload:{}})).statusCode,410)
})
test('a queued video thumbnail cannot publish after its source is purged',async()=>{
  const {id,sid}=await setup();await mkdir(mediaDir,{recursive:true})
  const path=join(mediaDir,sid+'.mp4'),aid='video-'+sid;await writeFile(path,'fixture video')
  run("INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,created_at) VALUES(?,?,?,'video','video.mp4',?,'generated',?)",aid,id,sid,path,now())
  let release!:(buffer:Buffer)=>void
  const get=createAssetPreviewCache(()=>new Promise<Buffer>(resolve=>{release=resolve}))
  const pending=get({id:aid,path,kind:'video'},320,join(mediaDir,id,'.previews'))
  // Wait for actual extraction admission; this promises a deterministic write race.
  while(!release)await new Promise(resolve=>setImmediate(resolve))
  const root=`/api/projects/${id}/shot-management`,payload={shot_ids:[sid]}
  const p=(await app.inject({method:'POST',url:root+'/purge-preview',payload})).json()
  assert.equal((await app.inject({method:'POST',url:root+'/purge',payload:{...payload,revision:p.revision}})).statusCode,200)
  const rejection=assert.rejects(pending,{code:'ENOENT'})
  release(Buffer.from('<svg width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'))
  await rejection
  const {readdir}=await import('node:fs/promises')
  assert.deepEqual(await readdir(join(mediaDir,id,'.previews')),[])
})

async function purge(project:string,shot:string) {
  const base=`/api/projects/${project}/shot-management`,payload={shot_ids:[shot]}
  const preview=await app.inject({method:'POST',url:base+'/purge-preview',payload})
  assert.equal(preview.statusCode,200,preview.body)
  const response=await app.inject({method:'POST',url:base+'/purge',payload:{...payload,revision:preview.json().revision}})
  assert.equal(response.statusCode,200,response.body)
  return preview.json()
}
test('purging an accepted shot keeps its submission tombstone so a lost old POST cannot recreate it',async()=>{
  const project=(await app.inject({method:'POST',url:'/api/projects',payload:{name:'防重放'}})).json().id
  const url=`/api/projects/${project}/shots`,payload={title:'已接受的镜头'},headers={'Idempotency-Key':'purged-shot-accepted-key'}
  const accepted=await app.inject({method:'POST',url,payload,headers})
  const sid=accepted.json().id
  run('UPDATE shots SET deleted_at=? WHERE id=?',now(),sid)
  await purge(project,sid)
  const replay=await app.inject({method:'POST',url,payload,headers})
  assert.equal(replay.statusCode,409,replay.body)
  assert.match(replay.body,/已删除/)
  assert.equal(one('SELECT 1 FROM shots WHERE project_id=?',project),undefined)
})
test('a generated profile shared by two scenes survives the first owner and is removed after the last owner',async()=>{
  const {id,sid}=await setup(),first=await scene(id,sid)
  const other=(await app.inject({method:'POST',url:`/api/projects/${id}/shots`,payload:{title:'第二个镜头'}})).json().id
  const second=await scene(id,other),pid='shared-profile-'+sid
  run("INSERT INTO visual_profiles(id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES(?,?,'character','共同生成参考','共同定义','正面',?,?)",pid,id,now(),now())
  recordShotProfileOrigin(id,pid,[sid,other],[first,second])
  for(const sceneId of [first,second])run('INSERT INTO scene_visual_bindings VALUES(?,?,1)',sceneId,pid)
  for(const shotId of [sid,other])run("INSERT INTO shot_visual_bindings(shot_id,profile_id,revision,kind,name,variant,definition,view_requirements) VALUES(?,?,1,'character','共同生成参考','默认','共同定义','正面')",shotId,pid)
  await purge(id,sid)
  assert.ok(one('SELECT 1 FROM visual_profiles WHERE id=?',pid))
  assert.equal(one('SELECT 1 FROM scene_visual_bindings WHERE scene_id=?',first),undefined)
  assert.ok(one('SELECT 1 FROM scene_visual_bindings WHERE scene_id=?',second))
  run('UPDATE shots SET deleted_at=? WHERE id=?',now(),other)
  await purge(id,other)
  assert.equal(one('SELECT 1 FROM visual_profiles WHERE id=?',pid),undefined)
  for(const sceneId of [first,second])assert.ok(one('SELECT 1 FROM script_scenes WHERE id=?',sceneId))
})
