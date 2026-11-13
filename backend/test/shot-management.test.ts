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
const { markChangedShotAdjacency } = await import('../src/modules/storyboard/storyboard-continuity-state.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory,{recursive:true,force:true}) })
async function call<T>(method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown):Promise<T> {
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
const directingPlan = { version: 1, status: 'accepted', scene: { anchors: '车窗', blocking: '同排座位', axis: '车厢通道', dramatic_progression: '从迟疑到接纸' },
  shot: { purpose: '接过纸条', camera: { movement: '固定', start_frame: '右手伸向纸条', trigger: '伸手', path: '无', end_frame: '右手夹住纸条', motivation: '看清交接' },
    cut: { type: 'action_match', cut_moment: '纸条交接完成', carry_over: '右手夹住纸条', reason: '接下一镜反应' } } }
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

test('generic shot edits retain directing decisions as history while title and no-op edits keep acceptance', async () => {
  const p = await project(), s = await shot(p)
  run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  for (const payload of [{ title: '改显示标题' }, { image_prompt: '旧首帧' }]) {
    const response = await app.inject({ method: 'PATCH', url: '/api/shots/' + s.id, payload })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().continuity_plan.status, 'accepted')
  }
  const response = await app.inject({ method: 'PATCH', url: '/api/shots/' + s.id, payload: { image_prompt: '新首帧，左手已拿到纸条', start_state: '左手持纸' } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().continuity_plan, { ...directingPlan, status: 'edited' })
  assert.equal(response.json().start_state, '左手持纸')
  const legacy = await shot(p, '旧数据')
  const edited = await app.inject({ method: 'PATCH', url: '/api/shots/' + legacy.id, payload: { end_state: '离开车厢' } })
  assert.equal(edited.statusCode, 200, edited.body)
  assert.equal(edited.json().continuity_plan, null)
})

test('shot-manager narrative edits and reordering retire the affected accepted directing snapshots', async () => {
  const p = await project(), a = await shot(p, '接纸'), b = await shot(p, '反应')
  for (const s of [a, b]) run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  const noOp = await action(p, { action: 'update', shot_id: a.id, patch: { end_state: '' } })
  assert.equal(noOp.shots.find(item => item.shot.id === a.id)!.shot.continuity_plan!.status, 'accepted')
  const edited = await action(p, { action: 'update', shot_id: a.id, patch: { cut_note: '此处明确省略换手过程' } })
  assert.equal(edited.shots.find(item => item.shot.id === a.id)!.shot.continuity_plan!.status, 'edited')
  const moved = await action(p, { action: 'move', shot_id: b.id, direction: 'up' })
  assert.equal(moved.shots.find(item => item.shot.id === b.id)!.shot.continuity_plan!.status, 'edited')
})

test('visual prompt edits keep confirmed dialogue and common sound until an explicit audio revision', async () => {
  const p = await project(), s = await shot(p)
  const audio = { version: 1, speech: [{ speaker: '林晚', text: '别回头！', delivery: '急促', mode: 'dialogue', source_text: '林晚说：别回头！' }],
    sound_effects: ['衣料摩擦'], music: '', silent: false, scene_sound: { ambience: ['持续车厢底噪'], acoustics: '封闭车厢', music_policy: 'timeline' } }
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify(audio), s.id)
  const response = await app.inject({ method: 'PATCH', url: '/api/shots/' + s.id, payload: { video_prompt: '镜头转向车窗，林晚保持站位' } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().audio_plan, audio)
  const edited = await action(p, { action: 'update', shot_id: s.id, patch: { prompt: '改为车窗前的近景' } })
  assert.deepEqual(edited.shots.find(item => item.shot.id === s.id)!.shot.audio_plan, audio)
  const revised = await app.inject({ method: 'PATCH', url: '/api/shots/' + s.id, payload: { audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: true } } })
  assert.equal(revised.statusCode, 200, revised.body)
  assert.equal(revised.json().audio_plan.silent, true)
})

test('generic reordering retires only snapshots with changed neighbors, including unmoved boundary shots', async () => {
  const p = await project(), shots = []
  for (const title of ['甲', '乙', '丙', '丁', '戊', '己']) shots.push(await shot(p, title))
  for (const s of shots) run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  await call('PATCH', '/api/shots/' + shots[0]!.id, { position: 0 })
  await call('PATCH', '/api/shots/' + shots[5]!.id, { position: 999 })
  for (const s of shots) assert.deepEqual(one<{ continuity_plan: unknown }>('SELECT continuity_plan FROM shots WHERE id=?', s.id)!.continuity_plan, directingPlan)
  await call('PATCH', '/api/shots/' + shots[1]!.id, { position: 3 })
  for (const [index, s] of shots.entries()) {
    assert.deepEqual(one<{ continuity_plan: unknown }>('SELECT continuity_plan FROM shots WHERE id=?', s.id)!.continuity_plan,
      index === 5 ? directingPlan : { ...directingPlan, status: 'edited' })
  }
})

test('historical shots do not mask an active predecessor or successor change', async () => {
  const p = await project(), created = []
  for (const title of ['甲', '历史镜头', '乙', '丙']) created.push(await shot(p, title))
  for (const s of created) run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  const replacementDesign = p + '-replacement'
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)', replacementDesign, p, '替代方案', '[]', '', now())
  run('UPDATE shots SET superseded_by=? WHERE id=?', replacementDesign, created[1]!.id)
  const before = created.map(s => one<any>('SELECT * FROM shots WHERE id=?', s.id)!)
  const after = before.map((s, index) => ({ ...s, position: index === 2 ? 3 : index === 3 ? 2 : s.position }))
  markChangedShotAdjacency(before, after)
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', created[0]!.id).continuity_plan.status, 'edited')
  assert.equal(one<any>('SELECT * FROM shots WHERE id=?', created[1]!.id).continuity_plan.status, 'accepted')
})

test('manager moves retire old and new neighbors while title edits and boundary moves preserve accepted snapshots', async () => {
  const p = await project(), shots = []
  for (const title of ['甲', '乙', '丙', '丁', '戊']) shots.push(await shot(p, title))
  for (const s of shots) run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  await action(p, { action: 'update', shot_id: shots[0]!.id, patch: { title: '新显示标题' } })
  const noOp = await action(p, { action: 'move', shot_id: shots[0]!.id, direction: 'up' })
  assert.ok(noOp.shots.every(item => item.shot.continuity_plan?.status === 'accepted'))
  const rejected = await app.inject({ method: 'POST', url: management(p) + '/actions',
    payload: { revision: noOp.revision, action: 'move', shot_id: shots[0]!.id } })
  assert.equal(rejected.statusCode, 422, rejected.body)
  for (const s of shots) assert.deepEqual(one<{ continuity_plan: unknown }>('SELECT continuity_plan FROM shots WHERE id=?', s.id)!.continuity_plan, directingPlan)
  const moved = await action(p, { action: 'move', shot_id: shots[2]!.id, direction: 'up' })
  for (const [index, s] of shots.entries()) {
    assert.deepEqual(moved.shots.find(item => item.shot.id === s.id)!.shot.continuity_plan,
      index === 4 ? directingPlan : { ...directingPlan, status: 'edited' })
  }
})

test('duplicating a shot retires its adjacent cut snapshots while pure renumbering and other designs stay accepted', async () => {
  const p = await project(), shots = []
  for (const title of ['甲', '乙', '丙', '丁', '其他方案甲', '其他方案乙']) shots.push(await shot(p, title))
  const designId = p + '-other'
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)', designId, p, '其他方案', '[]', '', now())
  for (const s of shots.slice(4)) run('UPDATE shots SET design_id=? WHERE id=?', designId, s.id)
  for (const s of shots) run('UPDATE shots SET continuity_plan=? WHERE id=?', JSON.stringify(directingPlan), s.id)
  const duplicated = await action(p, { action: 'duplicate', shot_id: shots[1]!.id })
  for (const [index, s] of shots.entries()) {
    assert.deepEqual(duplicated.shots.find(item => item.shot.id === s.id)!.shot.continuity_plan,
      index === 1 || index === 2 ? { ...directingPlan, status: 'edited' } : directingPlan)
  }
  assert.equal(duplicated.shots.find(item => item.shot.title === '乙（副本）')!.shot.continuity_plan, null)
})

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

test('batch recycling is atomic and a whole plan can be restored without affecting other designs',async()=>{
  const p=await project(),a=await shot(p,'方案甲一'),b=await shot(p,'方案甲二'),other=await shot(p,'方案乙')
  const canvas=await call<{id:string}>('POST',`/api/projects/${p}/canvases`,{name:'方案甲'})
  run('INSERT INTO storyboard_designs (id,project_id,canvas_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?,?)','batch-design-a',p,canvas.id,'方案甲','[]','',now())
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,instructions,created_at) VALUES (?,?,?,?,?,?)','batch-design-b',p,'方案乙','[]','',now())
  run('UPDATE shots SET design_id=? WHERE id IN (?,?)','batch-design-a',a.id,b.id)
  run('UPDATE shots SET design_id=? WHERE id=?','batch-design-b',other.id)
  const graph=await call<{revision:string;nodes:unknown[];edges:unknown[]}>('GET',`/api/projects/${p}/canvases/${canvas.id}`)
  await call('PUT',`/api/projects/${p}/canvases/${canvas.id}`,{...graph,nodes:[graphNode('blocked-shot',{shot_id:a.id})]})

  const before=await call<ShotManagementSnapshot>('GET',management(p))
  const rejected=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:before.revision,action:'trash_many',shot_ids:[a.id,b.id]}})
  assert.equal(rejected.statusCode,422)
  assert.match(rejected.body,/方案甲一/)
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',a.id)!.deleted_at,null)
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',b.id)!.deleted_at,null)

  const currentGraph=await call<typeof graph>('GET',`/api/projects/${p}/canvases/${canvas.id}`)
  await call('PUT',`/api/projects/${p}/canvases/${canvas.id}`,{...currentGraph,nodes:[]})
  const unblocked=await action(p,{action:'trash_many',shot_ids:[b.id]})
  assert.ok(unblocked.shots.find(item=>item.shot.id===b.id)!.deleted_at)
  const plan=await action(p,{action:'trash_design',design_id:'batch-design-a'})
  assert.ok(plan.shots.find(item=>item.shot.id===a.id)!.deleted_at)
  assert.ok(plan.shots.find(item=>item.shot.id===b.id)!.deleted_at)
  assert.equal(plan.shots.find(item=>item.shot.id===other.id)!.deleted_at,null)

  const restored=await action(p,{action:'restore_design',design_id:'batch-design-a'})
  assert.equal(restored.shots.find(item=>item.shot.id===a.id)!.deleted_at,null)
  assert.equal(restored.shots.find(item=>item.shot.id===b.id)!.deleted_at,null)
  assert.equal(restored.shots.find(item=>item.shot.id===other.id)!.deleted_at,null)
  assert.ok(one('SELECT 1 FROM storyboard_designs WHERE id=?','batch-design-a'))
})

test('batch recycling rejects stale revisions and duplicate shot IDs',async()=>{
  const p=await project(),a=await shot(p,'甲'),b=await shot(p,'乙')
  const before=await call<ShotManagementSnapshot>('GET',management(p))
  await action(p,{action:'update',shot_id:b.id,patch:{title:'乙已更新'}})
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:before.revision,action:'trash_many',shot_ids:[a.id,b.id]}})
  assert.equal(stale.statusCode,409)
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',a.id)!.deleted_at,null)
  const current=await call<ShotManagementSnapshot>('GET',management(p))
  const duplicate=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:current.revision,action:'trash_many',shot_ids:[a.id,a.id]}})
  assert.equal(duplicate.statusCode,422)
  assert.equal(one<{deleted_at:string|null}>('SELECT deleted_at FROM shots WHERE id=?',a.id)!.deleted_at,null)
})

test('the base plan with a null design ID can be recycled and restored as a group',async()=>{
  const p=await project(),first=await shot(p,'默认方案一'),second=await shot(p,'默认方案二'),other=await shot(p,'其他方案')
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)','non-base-design',p,'具名方案','[]',now())
  run('UPDATE shots SET design_id=? WHERE id=?','non-base-design',other.id)

  const recycled=await action(p,{action:'trash_design',design_id:null})
  assert.ok(recycled.shots.find(entry=>entry.shot.id===first.id)!.deleted_at)
  assert.ok(recycled.shots.find(entry=>entry.shot.id===second.id)!.deleted_at)
  assert.equal(recycled.shots.find(entry=>entry.shot.id===other.id)!.deleted_at,null)

  const restored=await action(p,{action:'restore_design',design_id:null})
  assert.equal(restored.shots.find(entry=>entry.shot.id===first.id)!.deleted_at,null)
  assert.equal(restored.shots.find(entry=>entry.shot.id===second.id)!.deleted_at,null)
  assert.equal(restored.shots.find(entry=>entry.shot.id===other.id)!.deleted_at,null)
})

test('restoring a recycled plan reopens its original positions before newer shots',async()=>{
  const p=await project(),a=await shot(p,'旧方案一'),b=await shot(p,'旧方案二')
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)','restore-order-design',p,'旧方案','[]',now())
  run('UPDATE shots SET design_id=? WHERE id IN (?,?)','restore-order-design',a.id,b.id)
  await action(p,{action:'trash_design',design_id:'restore-order-design'})
  const newer=await shot(p,'回收后新增镜头')
  run('UPDATE shots SET design_id=?,position=0 WHERE id=?','restore-order-design',newer.id)

  const restored=await action(p,{action:'restore_design',design_id:'restore-order-design'})
  const order=restored.shots.filter(entry=>!entry.deleted_at && entry.shot.design_id==='restore-order-design')
    .sort((left,right)=>left.shot.position-right.shot.position).map(entry=>[entry.shot.id,entry.shot.position])
  assert.deepEqual(order,[[a.id,0],[b.id,1],[newer.id,2]])
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

test('permanent shot deletion preserves scene, plan, media files and historical jobs while detaching their shot',async()=>{
  const p=await project(),s=await shot(p,'彻底删除的镜头'),media=await asset(p,s.id,'purge-shot-history')
  const scene=await call<{id:string}>('POST',`/api/projects/${p}/script/scenes`,{heading:'保留的剧本场次'})
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)','purge-retained-plan',p,'保留的方案',JSON.stringify([scene.id]),now())
  run('UPDATE shots SET source_scene_id=?,design_id=? WHERE id=?',scene.id,'purge-retained-plan',s.id)
  run("INSERT INTO jobs (id,project_id,shot_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,?,'generation','{}','succeeded',?,?,?)",'purge-retained-job',p,s.id,media.id,now(),now())
  await action(p,{action:'trash',shot_id:s.id})
  const result=await action(p,{action:'purge',shot_id:s.id})
  assert.equal(result.shots.some(entry=>entry.shot.id===s.id),false)
  assert.equal(one('SELECT 1 FROM shots WHERE id=?',s.id),undefined)
  assert.equal(one<{shot_id:string|null}>('SELECT shot_id FROM assets WHERE id=?',media.id)!.shot_id,null)
  assert.deepEqual(one('SELECT shot_id,result_asset_id,status FROM jobs WHERE id=?','purge-retained-job'),{shot_id:null,result_asset_id:media.id,status:'succeeded'})
  assert.ok(one('SELECT 1 FROM script_scenes WHERE id=?',scene.id));assert.ok(one('SELECT 1 FROM storyboard_designs WHERE id=?','purge-retained-plan'))
  assert.ok((await stat(media.path)).isFile());assert.deepEqual(db.pragma('foreign_key_check'),[])
})

test('permanent deletion rejects active and foreign-project records, duplicates and stale revisions',async()=>{
  const p=await project(),other=await project(),active=await shot(p,'活动镜头'),recycled=await shot(p,'回收镜头'),foreign=await shot(other,'外项目镜头')
  const activeMedia=await asset(p,null,'purge-active-media'),foreignMedia=await asset(other,null,'purge-foreign-media')
  run('UPDATE assets SET deleted_at=? WHERE id=?',now(),foreignMedia.id)
  await action(p,{action:'trash',shot_id:recycled.id});await action(other,{action:'trash',shot_id:foreign.id})
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  for(const input of [
    {action:'purge',shot_id:active.id},{action:'purge',shot_id:foreign.id},
    {action:'purge_many',shot_ids:[recycled.id,active.id]},
    {action:'purge_many',shot_ids:[recycled.id,foreign.id]},
    {action:'purge_many',shot_ids:[recycled.id,recycled.id]},
    {action:'purge_asset',asset_id:activeMedia.id},{action:'purge_asset',asset_id:foreignMedia.id},
  ]) {
    const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,...input}})
    assert.ok([404,409,422].includes(response.statusCode),response.body)
    assert.ok(one('SELECT 1 FROM shots WHERE id=?',recycled.id));assert.ok(one('SELECT 1 FROM assets WHERE id=?',activeMedia.id))
  }
  await action(p,{action:'update',shot_id:active.id,patch:{title:'活动镜头已变更'}})
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'purge',shot_id:recycled.id}})
  assert.equal(stale.statusCode,409);assert.ok(one('SELECT 1 FROM shots WHERE id=?',recycled.id))
})

test('references added after recycling block permanent shot batches and project-wide empty trash atomically',async()=>{
  const p=await project(),first=await shot(p,'可删除镜头'),blocked=await shot(p,'回收后被引用的镜头'),media=await asset(p,null,'atomic-trash-media')
  await action(p,{action:'trash_many',shot_ids:[first.id,blocked.id]})
  run('UPDATE assets SET deleted_at=? WHERE id=?',now(),media.id)
  // Simulate a reference restored by another workflow after the shots were recycled.
  run('INSERT INTO editing_cuts (id,project_id,name,revision,document,created_at,updated_at) VALUES (?,?,?,1,?,?,?)','purge-late-reference',p,'后加的剪辑',JSON.stringify({shot_id:blocked.id}),now(),now())
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  assert.ok(state.shots.find(entry=>entry.shot.id===blocked.id)!.purge_blockers?.some(reason=>reason.includes('剪辑')))
  for(const input of [{action:'purge_many',shot_ids:[first.id,blocked.id]},{action:'empty_trash'}]) {
    const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,...input}})
    assert.equal(response.statusCode,422,response.body);assert.match(response.body,/回收后被引用的镜头/)
    assert.ok(one('SELECT 1 FROM shots WHERE id=?',first.id));assert.ok(one('SELECT 1 FROM assets WHERE id=?',media.id))
  }
  run('DELETE FROM editing_cuts WHERE id=?','purge-late-reference')
  const result=await action(p,{action:'empty_trash'})
  assert.deepEqual(result.shots,[]);assert.deepEqual(result.trashed_assets,[]);assert.ok((await stat(media.path)).isFile())
})

test('batch purge and empty trash cover every project plan while preserving active and foreign-project records',async()=>{
  const p=await project(),other=await project(),first=await shot(p,'第一方案'),second=await shot(p,'第二方案'),active=await shot(p,'活动镜头'),foreign=await shot(other,'外项目回收镜头')
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)','purge-second-plan',p,'第二方案','[]',now())
  run('UPDATE shots SET design_id=? WHERE id=?','purge-second-plan',second.id)
  await action(p,{action:'trash_many',shot_ids:[first.id,second.id]});await action(other,{action:'trash',shot_id:foreign.id})
  const batch=await action(p,{action:'purge_many',shot_ids:[first.id,second.id]})
  assert.deepEqual(batch.shots.map(entry=>entry.shot.id),[active.id]);assert.ok(one('SELECT 1 FROM shots WHERE id=?',foreign.id))
  const next=await shot(p,'新回收镜头'),media=await asset(p,null,'purge-all-plans-media'),foreignMedia=await asset(other,null,'purge-other-project-media')
  run('UPDATE shots SET design_id=? WHERE id=?','purge-second-plan',next.id)
  await action(p,{action:'trash',shot_id:next.id})
  for(const item of [media,foreignMedia]) run('UPDATE assets SET deleted_at=? WHERE id=?',now(),item.id)
  const emptied=await action(p,{action:'empty_trash'})
  assert.deepEqual(emptied.shots.map(entry=>entry.shot.id),[active.id]);assert.deepEqual(emptied.trashed_assets,[])
  assert.ok(one('SELECT 1 FROM shots WHERE id=?',foreign.id));assert.ok(one('SELECT 1 FROM assets WHERE id=?',foreignMedia.id))
  assert.ok(one('SELECT 1 FROM storyboard_designs WHERE id=?','purge-second-plan'));assert.ok((await stat(media.path)).isFile())
})

test('permanent asset deletion allows recycled uploads, clears historical output pointers and protects saved media or new references',async()=>{
  const p=await project(),upload=await asset(p,null,'purge-upload-history','uploaded')
  run('UPDATE assets SET deleted_at=? WHERE id=?',now(),upload.id)
  run("INSERT INTO jobs (id,project_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,'generation','{}','succeeded',?,?,?)",'purge-upload-output-job',p,upload.id,now(),now())
  await action(p,{action:'purge_asset',asset_id:upload.id})
  assert.equal(one('SELECT 1 FROM assets WHERE id=?',upload.id),undefined)
  assert.deepEqual(one('SELECT result_asset_id,status FROM jobs WHERE id=?','purge-upload-output-job'),{result_asset_id:null,status:'succeeded'})
  assert.ok((await stat(upload.path)).isFile())

  const saved=await asset(p,null,'purge-saved-media'),live=await asset(p,null,'purge-live-media'),input=await asset(p,null,'purge-input-media')
  for(const item of [saved,live,input]) run('UPDATE assets SET deleted_at=? WHERE id=?',now(),item.id)
  run('INSERT INTO saved_assets VALUES (?,?,?)',saved.id,p,now())
  run("INSERT INTO jobs (id,project_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,'generation','{}','running',?,?,?)",'purge-live-output-job',p,live.id,now(),now())
  run("INSERT INTO jobs (id,project_id,job_type,request,status,created_at,updated_at) VALUES (?,?,'generation',?,'succeeded',?,?)",'purge-history-input-job',p,JSON.stringify({reference_asset_id:input.id}),now(),now())
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  for(const item of [saved,live,input]) {
    assert.ok(state.trashed_assets.find(entry=>entry.id===item.id)!.purge_blockers?.length)
    const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'purge_asset',asset_id:item.id}})
    assert.equal(response.statusCode,422,response.body);assert.match(response.body,new RegExp(item.id))
    assert.ok(one('SELECT 1 FROM assets WHERE id=?',item.id))
  }
  const empty=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'empty_trash'}})
  assert.equal(empty.statusCode,422);assert.ok(one('SELECT 1 FROM assets WHERE id=?',saved.id))
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

test('comparison, video review and cut review history added after recycling protects records and advances revision',async()=>{
  const p=await project(),first=await shot(p,'对照历史镜头'),second=await shot(p,'复核历史镜头')
  const baseline=await asset(p,null,'purge-comparison-baseline'),candidate=await asset(p,null,'purge-comparison-candidate'),reference=await asset(p,null,'purge-comparison-reference')
  const reviewed=await asset(p,null,'purge-reviewed-video'),cut=await asset(p,null,'purge-cut-review-media')
  await action(p,{action:'trash_many',shot_ids:[first.id,second.id]})
  for(const item of [baseline,candidate,reference,reviewed,cut]) run('UPDATE assets SET deleted_at=? WHERE id=?',now(),item.id)
  for(const [id,output] of [['purge-baseline-job',baseline.id],['purge-candidate-job',candidate.id]]) {
    run("INSERT INTO jobs (id,project_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,'generation','{}','succeeded',?,?,?)",id,p,output,now(),now())
  }
  const before=await call<ShotManagementSnapshot>('GET',management(p))
  run(`INSERT INTO video_comparisons (id,project_id,shot_id,label,baseline_job_id,baseline_asset_id,frozen_request,candidate_prompt,snapshot,model_name,model_id,shot_title,edit_duration,candidate_job_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,'purge-protected-comparison',p,first.id,'保留的对照','purge-baseline-job',baseline.id,JSON.stringify({reference_asset_ids:[reference.id]}),'候选','{}','模型','model',first.id,5,'purge-candidate-job',now())
  run('INSERT INTO video_reviews (id,project_id,asset_id,shot_id,signature,report,created_at) VALUES (?,?,?,?,?,?,?)','purge-protected-video-review',p,reviewed.id,second.id,'signature','{}',now())
  run("INSERT INTO cut_reviews (project_id,from_shot_id,to_shot_id,status,signature,from_selected_asset_id,updated_at) VALUES (?,?,?,'approved',?,?,?)",p,first.id,second.id,'signature',cut.id,now())
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  assert.notEqual(state.revision,before.revision)
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:before.revision,action:'empty_trash'}})
  assert.equal(stale.statusCode,409)
  for(const item of [baseline,candidate,reference,reviewed,cut]) {
    assert.ok(state.trashed_assets.find(entry=>entry.id===item.id)!.purge_blockers?.length,`${item.id} should remain protected`)
    const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'purge_asset',asset_id:item.id}})
    assert.equal(response.statusCode,422,response.body)
  }
  for(const item of [first,second]) {
    assert.ok(state.shots.find(entry=>entry.shot.id===item.id)!.purge_blockers?.length)
    const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'purge',shot_id:item.id}})
    assert.equal(response.statusCode,422,response.body)
  }
  assert.ok(one('SELECT 1 FROM video_comparisons WHERE id=?','purge-protected-comparison'))
  assert.ok(one('SELECT 1 FROM video_reviews WHERE id=?','purge-protected-video-review'));assert.deepEqual(db.pragma('foreign_key_check'),[])
})

test('empty trash removes reviews and bindings owned by the same deleted shots while single asset purge remains protected',async()=>{
  const p=await project(),s=await shot(p,'同批回收镜头'),media=await asset(p,s.id,'purge-joint-media')
  run('INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)','purge-joint-profile',p,'character','角色','设定','正面',now(),now())
  run('INSERT INTO shot_visual_bindings (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements,board_asset_id) VALUES (?,?,1,1,?,?,?,?,?,?)',s.id,'purge-joint-profile','character','角色','默认','镜头设定','正面',media.id)
  run("INSERT INTO asset_reviews (shot_id,asset_id,status,updated_at) VALUES (?,?,'approved',?)",s.id,media.id,now())
  await action(p,{action:'trash',shot_id:s.id});run('UPDATE assets SET deleted_at=? WHERE id=?',now(),media.id)
  const state=await call<ShotManagementSnapshot>('GET',management(p))
  assert.ok(state.trashed_assets[0]!.purge_blockers?.length)
  assert.deepEqual(state.empty_trash_blockers,[])
  const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:state.revision,action:'purge_asset',asset_id:media.id}})
  assert.equal(response.statusCode,422)
  const emptied=await action(p,{action:'empty_trash'})
  assert.deepEqual(emptied.shots,[]);assert.deepEqual(emptied.trashed_assets,[])
  assert.equal(one('SELECT 1 FROM asset_reviews WHERE asset_id=?',media.id),undefined)
  assert.equal(one('SELECT 1 FROM shot_visual_bindings WHERE shot_id=?',s.id),undefined)
  assert.ok(one('SELECT 1 FROM visual_profiles WHERE id=?','purge-joint-profile'));assert.ok((await stat(media.path)).isFile())
})

test('empty trash keeps independent visual profiles and references owned by active shots; late references advance revision',async()=>{
  const p=await project(),recycled=await shot(p,'同批镜头'),active=await shot(p,'未删除镜头'),media=await asset(p,recycled.id,'purge-external-binding-media')
  await action(p,{action:'trash',shot_id:recycled.id});run('UPDATE assets SET deleted_at=? WHERE id=?',now(),media.id)
  const before=await call<ShotManagementSnapshot>('GET',management(p))
  assert.deepEqual(before.empty_trash_blockers,[])
  run('INSERT INTO visual_profiles (id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)','purge-external-profile',p,'character','角色','设定','正面',now(),now())
  run('INSERT INTO shot_visual_bindings (shot_id,profile_id,required,revision,kind,name,variant,definition,view_requirements,board_asset_id) VALUES (?,?,1,1,?,?,?,?,?,?)',active.id,'purge-external-profile','character','角色','默认','镜头设定','正面',media.id)
  let current=await call<ShotManagementSnapshot>('GET',management(p))
  assert.notEqual(current.revision,before.revision);assert.ok(current.empty_trash_blockers?.some(reason=>reason.includes(media.id)))
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:before.revision,action:'empty_trash'}})
  assert.equal(stale.statusCode,409)
  let response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:current.revision,action:'empty_trash'}})
  assert.equal(response.statusCode,422);assert.ok(one('SELECT 1 FROM shots WHERE id=?',recycled.id))
  run('DELETE FROM shot_visual_bindings WHERE shot_id=?',active.id)
  run('UPDATE visual_profiles SET board_asset_id=? WHERE id=?',media.id,'purge-external-profile')
  current=await call('GET',management(p));assert.ok(current.empty_trash_blockers?.length)
  response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:current.revision,action:'empty_trash'}})
  assert.equal(response.statusCode,422);assert.ok(one('SELECT 1 FROM assets WHERE id=?',media.id))
})

test('foreign-project output pointers prevent asset purge without modifying foreign task history',async()=>{
  const p=await project(),other=await project(),media=await asset(p,null,'purge-foreign-output-media')
  run('UPDATE assets SET deleted_at=? WHERE id=?',now(),media.id)
  const before=await call<ShotManagementSnapshot>('GET',management(p))
  run("INSERT INTO jobs (id,project_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES (?,?,'generation','{}','succeeded',?,?,?)",'purge-foreign-output-job',other,media.id,now(),now())
  const current=await call<ShotManagementSnapshot>('GET',management(p))
  assert.notEqual(current.revision,before.revision);assert.ok(current.trashed_assets[0]!.purge_blockers?.length)
  const stale=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:before.revision,action:'purge_asset',asset_id:media.id}})
  assert.equal(stale.statusCode,409)
  const response=await app.inject({method:'POST',url:management(p)+'/actions',payload:{revision:current.revision,action:'purge_asset',asset_id:media.id}})
  assert.equal(response.statusCode,422);assert.equal(one<{result_asset_id:string}>('SELECT result_asset_id FROM jobs WHERE id=?','purge-foreign-output-job')!.result_asset_id,media.id)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?',media.id))
})
