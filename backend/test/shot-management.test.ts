import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { CanvasDeletionPreview, ShotManagementSnapshot } from '@video-studio/shared/storyboard/shot-management'

const directory = await mkdtemp(join(tmpdir(),'studio-shot-management-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, one, initDb, now } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory,{recursive:true,force:true}) })
async function call<T>(method: 'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown):Promise<T> {
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})})
  assert.equal(response.statusCode,200,response.body)
  return response.json<T>()
}
const graphNode=(id:string,extra:Record<string,unknown>={})=>({id,type:'generation',x:0,y:0,width:320,height:240,title:id,prompt:'画面',settings:{modality:'image'},...extra})
async function project() {
  const p=await call<{id:string}>('POST','/api/projects',{name:'分镜管理验收'})
  await call('GET',`/api/projects/${p.id}/canvases`)
  return p.id
}
async function shot(projectId:string,title='镜头') { return call<{id:string}>('POST',`/api/projects/${projectId}/shots`,{title,prompt:'旧描述',image_prompt:'旧首帧',video_prompt:'旧运镜'}) }
const management=(id:string)=>`/api/projects/${id}/shot-management`
async function action(projectId:string,input:Record<string,unknown>) {
  const state=await call<ShotManagementSnapshot>('GET',management(projectId))
  return call<ShotManagementSnapshot>('POST',management(projectId)+'/actions',{revision:state.revision,...input})
}
async function asset(projectId:string,shotId:string|null,name:string,source='generated') {
  const path=join(directory,name+'.png')
  await writeFile(path,'untouched-media')
  run('INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,created_at) VALUES (?,?,?,?,?,?,?,?)',name,projectId,shotId,'image',name+'.png',path,source,now())
  return {id:name,path}
}

test('viewport-only writes do not invalidate a resource cleanup preview',async()=>{
  const p=await project(),s=await shot(p)
  const c=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{})
  const url=`/api/projects/${p}/canvases/${c.id}`
  const graph=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',url)
  await call('PUT',url,{...graph,nodes:[graphNode('viewport-cleanup',{shot_id:s.id})]})
  const before=await call<CanvasDeletionPreview>('GET',url+'/deletion-preview')
  const patched=await app.inject({method:'PATCH',url,payload:{viewport:{x:20,y:30,zoom:0.8}}})
  assert.equal(patched.statusCode,200,patched.body)
  const after=await call<CanvasDeletionPreview>('GET',url+'/deletion-preview')
  assert.equal(after.cleanup_revision,before.cleanup_revision)
  await call('DELETE',url,{revision:before.revision,cleanup_revision:before.cleanup_revision,cleanup_shots:true})
  assert.ok(one<{deleted_at:string}>('SELECT deleted_at FROM shots WHERE id=?',s.id)!.deleted_at)
})

test('management edits invalidate media once; copies preserve text/bindings without selections; move stays inside scene scope',async()=>{
  const p=await project(),a=await shot(p,'甲'),b=await shot(p,'乙')
  const state=await action(p,{action:'update',shot_id:a.id,patch:{prompt:'新的分镜描述',duration:8}})
  assert.equal(state.shots.find(item=>item.shot.id===a.id)!.shot.prompt,'新的分镜描述')
  assert.equal(state.shots.find(item=>item.shot.id===a.id)!.shot.storyboard_revision,1)
  const duplicate=await action(p,{action:'duplicate',shot_id:a.id})
  const copy=duplicate.shots.find(item=>item.shot.title==='甲（副本）')!.shot
  assert.equal(copy.prompt,'新的分镜描述');assert.equal(copy.selected_asset_id,null)
  const moved=await action(p,{action:'move',shot_id:copy.id,direction:'up'})
  assert.ok(moved.shots.find(item=>item.shot.id===copy.id)!.shot.position<moved.shots.find(item=>item.shot.id===a.id)!.shot.position)
  assert.ok(moved.shots.some(item=>item.shot.id===b.id))
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'trash',shot_id:a.id}})
  assert.equal(stale.statusCode,409)
})

test('recycled shots are absent from active project and cannot be attached or edited; restore keeps history',async()=>{
  const p=await project(),s=await shot(p)
  const history=await asset(p,s.id,'trash-history')
  let state=await action(p,{action:'trash',shot_id:s.id})
  assert.ok(state.shots[0]!.deleted_at)
  const detail=await call<{shots:Array<{id:string}>;historical_shots:Array<{id:string}>}>('GET',`/api/projects/${p}`)
  assert.equal(detail.shots.length,0);assert.equal(detail.historical_shots.length,0)
  assert.equal((await app.inject({method:'PATCH',url:'/api/shots/'+s.id,payload:{title:'误复活'}})).statusCode,404)
  const graph=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',`/api/projects/${p}/canvases/${p}`)
  assert.equal((await app.inject({method:'PUT',url:`/api/projects/${p}/canvases/${p}`,payload:{...graph,nodes:[graphNode('stale-shot',{shot_id:s.id})]}})).statusCode,422)
  state=await action(p,{action:'restore',shot_id:s.id})
  assert.equal(state.shots[0]!.deleted_at,null)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?',history.id));assert.ok((await stat(history.path)).isFile())
  initDb();assert.deepEqual(db.pragma('foreign_key_check'),[])
})

test('canvas preview protects saved/shared/cut media and live tasks; optional recycling keeps files/jobs and rejects stale protection changes',async()=>{
  const p=await project(),s=await shot(p),sharedShot=await shot(p,'共享镜头')
  const canvas=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{name:'可清理方案'})
  const local=await asset(p,s.id,'cleanup-exclusive'),saved=await asset(p,null,'cleanup-saved'),shared=await asset(p,null,'cleanup-shared'),cut=await asset(p,null,'cleanup-cut')
  run('INSERT INTO saved_assets VALUES (?,?,?)',saved.id,p,now())
  const cutId='protect-cut'
  run('INSERT INTO editing_cuts (id,project_id,name,revision,document,created_at,updated_at) VALUES (?,?,?,1,?,?,?)',cutId,p,'受保护剪辑',JSON.stringify({clips:[{asset_id:cut.id}]}),now(),now())
  const targetUrl=`/api/projects/${p}/canvases/${canvas.id}`
  const target=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',targetUrl)
  const savedGraph=await call<typeof target>('PUT',targetUrl,{...target,nodes:[graphNode('exclusive-node',{shot_id:s.id,asset_id:local.id}),graphNode('saved-node',{asset_id:saved.id}),graphNode('shared-node',{asset_id:shared.id}),graphNode('cut-node',{asset_id:cut.id})]})
  const base=await call<typeof target>('GET',`/api/projects/${p}/canvases/${p}`)
  await call('PUT',`/api/projects/${p}/canvases/${p}`,{...base,nodes:[graphNode('other-shared-node',{shot_id:sharedShot.id,asset_id:shared.id})]})
  let preview=await call<CanvasDeletionPreview>('GET',targetUrl+'/deletion-preview')
  assert.deepEqual(preview.exclusive_shots.map(item=>item.id),[s.id]);assert.deepEqual(preview.exclusive_assets.map(item=>item.id),[local.id]);assert.equal(preview.protected_asset_count,3)
  run('INSERT INTO saved_assets VALUES (?,?,?)',local.id,p,now())
  let response=await app.inject({method:'DELETE',url:targetUrl,payload:{revision:savedGraph.revision,cleanup_revision:preview.cleanup_revision,cleanup_shots:true,cleanup_assets:true}})
  assert.equal(response.statusCode,409);assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',s.id)!.deleted_at,null)
  run('DELETE FROM saved_assets WHERE asset_id=?',local.id)
  preview=await call('GET',targetUrl+'/deletion-preview')
  await call('DELETE',targetUrl,{revision:preview.revision,cleanup_revision:preview.cleanup_revision,cleanup_shots:true,cleanup_assets:true})
  assert.ok(one<{deleted_at:string}>('SELECT deleted_at FROM shots WHERE id=?',s.id)!.deleted_at)
  assert.ok(one<{deleted_at:string}>('SELECT deleted_at FROM assets WHERE id=?',local.id)!.deleted_at)
  assert.ok((await stat(local.path)).isFile())
  const detail=await call<{assets:Array<{id:string}>}>('GET',`/api/projects/${p}`)
  assert.equal(detail.assets.some(item=>item.id===local.id),false)
  assert.equal((await app.inject({method:'GET',url:'/api/assets/'+local.id+'/file'})).statusCode,404)
  await action(p,{action:'restore_asset',asset_id:local.id})
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM assets WHERE id=?',local.id)!.deleted_at,null)
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

test('canvas deletion defaults preserve resources; shared shot and selected/range/live-job shots cannot be recycled',async()=>{
  const p=await project(),s=await shot(p)
  const c=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{})
  const url=`/api/projects/${p}/canvases/${c.id}`
  const base=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',url)
  await call('PUT',url,{...base,nodes:[graphNode('preserve-node',{shot_id:s.id})]})
  const m=await call<ShotManagementSnapshot>('GET',management(p))
  assert.ok(m.shots[0]!.delete_blockers.length)
  assert.equal((await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:m.revision,action:'trash',shot_id:s.id}})).statusCode,422)
  const preview=await call<CanvasDeletionPreview>('GET',url+'/deletion-preview')
  await call('DELETE',url,{revision:preview.revision})
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',s.id)!.deleted_at,null)
  run("INSERT INTO jobs (id,project_id,shot_id,job_type,request,status,created_at,updated_at) VALUES (?,?,?,'generation','{}','queued',?,?)",'ongoing',p,s.id,now(),now())
  const live=await call<ShotManagementSnapshot>('GET',management(p))
  assert.ok(live.shots[0]!.delete_blockers.some(reason=>reason.includes('进行中')))
})

test('unplaced design shots can be recycled manually; canvas cleanup protects other designs and considers every owned design',async()=>{
  const p=await project(),a=await shot(p,'方案甲'),b=await shot(p,'方案乙'),foreign=await shot(p,'其他画布方案')
  const own=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{name:'方案画布'})
  const other=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{name:'其他方案'})
  for (const [designId,canvasId,shotId] of [['design-a',own.id,a.id],['design-b',own.id,b.id],['design-other',other.id,foreign.id]]) {
    run('INSERT INTO storyboard_designs (id,project_id,canvas_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?,?)',designId,p,canvasId,designId,'[]','',now())
    run('UPDATE shots SET design_id=? WHERE id=?',designId,shotId)
  }
  const base=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',`/api/projects/${p}/canvases/${own.id}`)
  await call('PUT',`/api/projects/${p}/canvases/${own.id}`,{...base,nodes:[graphNode('borrowed-shot',{shot_id:foreign.id})]})
  const preview=await call<CanvasDeletionPreview>('GET',`/api/projects/${p}/canvases/${own.id}/deletion-preview`)
  assert.deepEqual(new Set(preview.exclusive_shots.map(item=>item.id)),new Set([a.id,b.id]))
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  assert.deepEqual(state.shots.find(item=>item.shot.id===a.id)!.canvas_refs,[])
  assert.deepEqual(state.shots.find(item=>item.shot.id===a.id)!.delete_blockers,[])
  const trashed=await action(p,{action:'trash',shot_id:a.id})
  assert.ok(trashed.shots.find(item=>item.shot.id===a.id)!.deleted_at)
  const restored=await action(p,{action:'restore',shot_id:a.id})
  assert.equal(restored.shots.find(item=>item.shot.id===a.id)!.deleted_at,null)
  assert.deepEqual(restored.shots.find(item=>item.shot.id===a.id)!.canvas_refs,[])
  const borrowedAsset=await asset(p,foreign.id,'foreign-design-media')
  const current=await call<typeof base>('GET',`/api/projects/${p}/canvases/${own.id}`)
  await call('PUT',`/api/projects/${p}/canvases/${own.id}`,{...current,nodes:[graphNode('borrowed-shot',{shot_id:foreign.id,asset_id:borrowedAsset.id})]})
  const finalPreview=await call<CanvasDeletionPreview>('GET',`/api/projects/${p}/canvases/${own.id}/deletion-preview`)
  assert.equal(finalPreview.exclusive_shots.some(item=>item.id===foreign.id),false)
  assert.equal(finalPreview.exclusive_assets.some(item=>item.id===borrowedAsset.id),false)
  assert.equal(finalPreview.protected_asset_count,1)
})

test('speech placement and direct cut shot references protect recycling even with no selected shot media',async()=>{
  const p=await project(),s=await shot(p)
  const audio=await asset(p,null,'speech-protected')
  const line=await call<{id:string}>('POST',`/api/projects/${p}/speech/lines`,{text:'保持这条配音位置'})
  run('INSERT INTO speech_placements (id,project_id,line_id,shot_id,asset_id,out_ms,updated_at) VALUES (?,?,?,?,?,?,?)','speech-placement',p,line.id,s.id,audio.id,1000,now())
  let state=await call<ShotManagementSnapshot>('GET',management(p))
  assert.ok(state.shots[0]!.delete_blockers.some(reason=>reason.includes('配音')))
  run('DELETE FROM speech_placements WHERE id=?','speech-placement')
  run('INSERT INTO editing_cuts (id,project_id,name,revision,document,created_at,updated_at) VALUES (?,?,?,1,?,?,?)','direct-shot-cut',p,'直接镜头引用',JSON.stringify({source_shot_id:s.id}),now(),now())
  state=await call('GET',management(p))
  assert.ok(state.shots[0]!.delete_blockers.some(reason=>reason.includes('剪辑稿')))
})

test('editing a used shot invalidates its canvas output and selection while preserving candidate media and binding copies',async()=>{
  const p=await project(),s=await shot(p,'有历史画面的镜头'),a=await asset(p,s.id,'retained-edit-media')
  run('UPDATE shots SET selected_asset_id=? WHERE id=?',a.id,s.id)
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,out_ms) VALUES (?,?,?,?,?)','edit-old-selection',p,s.id,a.id,5000)
  run('INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)','copy-profile',p,'character','角色','角色既有设定','正面',now(),now())
  run('INSERT INTO shot_visual_bindings (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements) VALUES (?,?,1,1,?,?,?,?,?)',s.id,'copy-profile','character','角色','默认','冻结角色设定','正面')
  const graph=await call<{revision:string;nodes:Array<{id:string;asset_id:string|null;settings:Record<string,unknown>}>;edges:unknown[]}>('GET',`/api/projects/${p}/canvases/${p}`)
  await call('PUT',`/api/projects/${p}/canvases/${p}`,{...graph,nodes:[graphNode('editing-used-node',{shot_id:s.id,asset_id:a.id})]})
  await action(p,{action:'update',shot_id:s.id,patch:{video_prompt:'更新后的连续动作'}})
  const updated=await call<typeof graph>('GET',`/api/projects/${p}/canvases/${p}`)
  assert.equal(updated.nodes[0]!.asset_id,null);assert.equal(updated.nodes[0]!.settings.storyboard_revision,1)
  assert.equal(one<{selected_asset_id:string|null}>('SELECT selected_asset_id FROM shots WHERE id=?',s.id)!.selected_asset_id,null)
  assert.equal(one('SELECT 1 FROM timeline_clips WHERE shot_id=?',s.id),undefined)
  assert.ok(one('SELECT 1 FROM assets WHERE id=? AND deleted_at IS NULL',a.id));assert.ok((await stat(a.path)).isFile())
  const result=await action(p,{action:'duplicate',shot_id:s.id})
  const copy=result.shots.find(item=>item.shot.id!==s.id)!.shot
  const originalBinding=one<Record<string,unknown>>('SELECT * FROM shot_visual_bindings WHERE shot_id=?',s.id)!
  assert.deepEqual(one('SELECT * FROM shot_visual_bindings WHERE shot_id=?',copy.id),{...originalBinding,shot_id:copy.id})
})


test('title and cut notes preserve selected media, timeline and custom node titles without advancing generation revision',async()=>{
  const p=await project(),s=await shot(p,'原镜头名'),a=await asset(p,s.id,'metadata-retained')
  run('UPDATE shots SET selected_asset_id=? WHERE id=?',a.id,s.id)
  run('INSERT INTO timeline_clips (id,project_id,shot_id,asset_id,out_ms) VALUES (?,?,?,?,?)','metadata-timeline',p,s.id,a.id,5000)
  const graph=await call<{revision:string;nodes:Array<{id:string;title:string;asset_id:string|null;settings:Record<string,unknown>}>;edges:unknown[]}>('GET',`/api/projects/${p}/canvases/${p}`)
  const settings={modality:'image',prompt_override:true,prompt_is_final:true,prompt_base:'旧首帧',storyboard_revision:0}
  await call('PUT',`/api/projects/${p}/canvases/${p}`,{...graph,nodes:[graphNode('default-title',{title:'原镜头名',shot_id:s.id,asset_id:a.id,settings}),graphNode('custom-title',{title:'自定义构图',shot_id:s.id,asset_id:a.id,settings})]})
  const before=one('SELECT * FROM timeline_clips WHERE shot_id=?',s.id)
  const result=await action(p,{action:'update',shot_id:s.id,patch:{title:'新的标题',cut_note:'这里只改剪辑备注'}})
  const updated=result.shots.find(item=>item.shot.id===s.id)!.shot
  assert.equal(updated.selected_asset_id,a.id);assert.equal(updated.storyboard_revision,0)
  assert.deepEqual(one('SELECT * FROM timeline_clips WHERE shot_id=?',s.id),before)
  const after=await call<typeof graph>('GET',`/api/projects/${p}/canvases/${p}`)
  assert.equal(after.nodes.find(node=>node.id==='default-title')!.title,'新的标题')
  assert.equal(after.nodes.find(node=>node.id==='custom-title')!.title,'自定义构图')
  for(const node of after.nodes) { assert.equal(node.asset_id,a.id);assert.deepEqual(node.settings,settings) }
})


test('restoring a recycled last shot reopens its design slot and preserves usable move order',async()=>{
  const p=await project(),first=await shot(p,'第一镜'),last=await shot(p,'被回收的最后一镜')
  await action(p,{action:'trash',shot_id:last.id})
  const replacement=await shot(p,'回收后新增镜头')
  assert.equal(one<{position:number}>('SELECT position FROM shots WHERE id=?',replacement.id)!.position,1)
  const separate=await shot(p,'另一方案镜头')
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)','restore-other-design',p,'另一方案','[]',now())
  run('UPDATE shots SET design_id=?,position=1 WHERE id=?','restore-other-design',separate.id)
  const restored=await action(p,{action:'restore',shot_id:last.id})
  const active=restored.shots.filter(item=>!item.deleted_at && !item.shot.design_id).map(item=>item.shot)
  assert.deepEqual(active.map(item=>[item.id,item.position]),[[first.id,0],[last.id,1],[replacement.id,2]])
  assert.equal(restored.shots.find(item=>item.shot.id===separate.id)!.shot.position,1)
  const moved=await action(p,{action:'move',shot_id:last.id,direction:'down'})
  assert.deepEqual(moved.shots.filter(item=>!item.deleted_at && !item.shot.design_id).map(item=>item.shot.id),[first.id,replacement.id,last.id])
  assert.equal(moved.shots.find(item=>item.shot.id===separate.id)!.shot.position,1)
})
