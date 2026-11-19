import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const directory = await mkdtemp(join(tmpdir(), 'shot-exclusive-purge-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, one, now, mediaDir } = await import('../src/infrastructure/database/db.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function setup() {
  const result = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '独占删除副本' } })
  const id = result.json().id
  const shot = await app.inject({ method: 'POST', url: `/api/projects/${id}/shots`, payload: { title: '独占分镜' } })
  const sid = shot.json().id
  run('UPDATE shots SET deleted_at=? WHERE id=?', now(), sid)
  return { id, sid }
}
async function asset(projectId: string, shotId: string | null, id: string, path?: string) {
  await mkdir(mediaDir, { recursive: true })
  const file = path || join(mediaDir, id + '.png')
  if (!path) await writeFile(file, 'private fixture media')
  run("INSERT INTO assets(id,project_id,shot_id,kind,filename,path,source,created_at) VALUES(?,?,?,'image',?,?,'generated',?)", id, projectId, shotId, id + '.png', file, now())
  return file
}
async function preview(id: string, shotIds: string[]) {
  const response = await app.inject({ method: 'POST', url: `/api/projects/${id}/shot-management/purge-preview`, payload: { shot_ids: shotIds } })
  assert.equal(response.statusCode, 200, response.body); return response.json()
}
const execute = (id: string, shotIds: string[], revision: string) => app.inject({ method: 'POST', url: `/api/projects/${id}/shot-management/purge`, payload: { shot_ids: shotIds, revision } })
test('exclusive deletion removes owned files, jobs, recovery/history and checkpoint while preserving other scene runs', async () => {
  const { id, sid } = await setup(), file = await asset(id, sid, 'exclusive')
  run("INSERT INTO jobs(id,project_id,shot_id,job_type,request,status,result_asset_id,created_at,updated_at) VALUES('owned-job',?,?,'generation','{}','succeeded','exclusive',?,?)", id, sid, now(), now())
  run("INSERT INTO resource_submissions VALUES(?,'generation','submission','hash','owned-job',?)", id, now())
  generationUnitStore(id, 'only-shot', {}).save({ steps: { content: { input_hash: 'a'.repeat(64), value: { shot_id: sid, answer: 'private answer' } } } })
  generationUnitStore(id, 'scene-shared-no-shot-ownership', {}).save({ steps: { content: { input_hash: 'b'.repeat(64), value: { scene_id: 'shared-scene', answer: 'shared data' } } } })
  const p = await preview(id, [sid]); assert.deepEqual(p.blockers, []); assert.equal(p.files.length, 1)
  const result = await execute(id, [sid], p.revision); assert.equal(result.statusCode, 200, result.body)
  for (const [table, key, value] of [['shots','id',sid], ['assets','id','exclusive'], ['jobs','id','owned-job'], ['model_unit_checkpoints','namespace','only-shot']])
    assert.equal(one(`SELECT 1 FROM ${table} WHERE ${key}=?`, value), undefined)
  assert.ok(one(`SELECT 1 FROM resource_submissions WHERE resource_id=?`, 'owned-job'), 'accepted key is retained as a replay tombstone')
  await assert.rejects(stat(file), { code: 'ENOENT' })
  assert.ok(one('SELECT 1 FROM model_unit_checkpoints WHERE namespace=?','scene-shared-no-shot-ownership'))
  assert.equal(result.json().remote_cancelled, false)
})
test('same-path files and shared profiles/media survive with exact preview explanations', async () => {
  const { id, sid } = await setup(), file = await asset(id, sid, 'path-owner')
  await asset(id, null, 'shared-path', file)
  run("INSERT INTO visual_profiles(id,project_id,kind,name,definition,view_requirements,created_at,updated_at) VALUES('shared-base',?,'character','共享人物','设定','正面',?,?)", id, now(), now())
  run("INSERT INTO shot_visual_bindings(shot_id,profile_id,revision,kind,name,variant,definition,view_requirements) VALUES(?,'shared-base',1,'character','共享人物','默认','设定','正面')", sid)
  const p = await preview(id, [sid]); assert.deepEqual(p.blockers, [])
  assert.ok(p.protected.some((item: any) => item.kind === 'file' && item.reasons.some((reason: string) => reason.includes('共享相同文件'))))
  assert.ok(p.protected.some((item: any) => item.id === 'shared-base'))
  const result = await execute(id, [sid], p.revision); assert.equal(result.statusCode, 200, result.body)
  assert.ok(one('SELECT 1 FROM visual_profiles WHERE id=?','shared-base')); assert.ok(one('SELECT 1 FROM assets WHERE id=?','shared-path')); await stat(file)
})
test('exclusive reference variants and cards are purged while their shared base is untouched', async () => {
  const { id, sid } = await setup(); const file = await asset(id, null, 'variant-card')
  for (const [pid, base] of [['variant-base',null], ['exclusive-variant','variant-base']]) run("INSERT INTO visual_profiles(id,project_id,kind,name,variant,definition,view_requirements,base_profile_id,created_at,updated_at) VALUES(?,?,'character',?,?, '定义','正面',?,?,?)", pid, id, '人物', pid, base, now(), now())
  run("INSERT INTO shot_visual_bindings(shot_id,profile_id,revision,kind,name,variant,definition,view_requirements) VALUES(?,'exclusive-variant',1,'character','人物','独占','定义','正面')", sid)
  run("INSERT INTO visual_profile_candidates(profile_id,asset_id,updated_at) VALUES('exclusive-variant','variant-card',?)", now())
  run('UPDATE visual_profiles SET source_draft_key=? WHERE id=?','exclusive-variant-draft','exclusive-variant')
  const oldCache=generationUnitStore(id,'visual-profile-content-cache',{policy:1,input_hash:'cached-exclusive-draft'})
  oldCache.save({steps:{content:{input_hash:'d'.repeat(64),value:{profiles:[{draft_key:'exclusive-variant-draft',definition:'仅属于已删变体的缓存'}]}}}})
  const p = await preview(id, [sid]); assert.deepEqual(p.blockers, [])
  const response = await execute(id, [sid], p.revision); assert.equal(response.statusCode, 200, response.body)
  assert.throws(()=>oldCache.read(),{code:'generation_scope_purged'})
  assert.throws(()=>oldCache.save({steps:{content:{input_hash:'d'.repeat(64),value:{profiles:[{draft_key:'exclusive-variant-draft'}]}}}}),{code:'generation_scope_purged'})
  assert.equal(generationUnitStore(id,'visual-profile-content-cache',{policy:1,input_hash:'cached-exclusive-draft'}).read().steps.content,undefined)
  assert.ok(one('SELECT 1 FROM visual_profiles WHERE id=?','variant-base')); assert.equal(one('SELECT 1 FROM visual_profiles WHERE id=?','exclusive-variant'), undefined)
  await assert.rejects(stat(file), { code: 'ENOENT' })
})
test('other canvas/media references are protected and a preview expires when references change', async () => {
  const { id, sid } = await setup(), file = await asset(id, sid, 'protected-media')
  const p = await preview(id, [sid])
  run('INSERT INTO saved_assets VALUES(?,?,?)','protected-media',id,now())
  const stale = await execute(id, [sid], p.revision); assert.equal(stale.statusCode, 409)
  assert.ok(one('SELECT 1 FROM shots WHERE id=?',sid),'stale preview leaves the shot intact')
  assert.ok(one('SELECT 1 FROM assets WHERE id=?','protected-media'),'stale preview leaves asset rows intact')
  await stat(file)
  assert.equal(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purged_operation_ids'") && one('SELECT 1 FROM purged_operation_ids WHERE project_id=?',id),undefined)
  const updated = await preview(id, [sid]); assert.ok(updated.protected.some((item: any) => item.id === 'protected-media'))
  const ok = await execute(id, [sid], updated.revision); assert.equal(ok.statusCode, 200, ok.body)
  assert.ok(one('SELECT 1 FROM assets WHERE id=?','protected-media')); await stat(file)
})
test('mixed recovery and unknown/running requests stop all deletion without dropping shared history', async () => {
  const { id, sid } = await setup(), other = await app.inject({ method:'POST',url:`/api/projects/${id}/shots`,payload:{title:'其他镜头'} })
  generationUnitStore(id,'mixed-run',{}).save({ steps: { content: { input_hash:'c'.repeat(64),value:{shot_ids:[sid,other.json().id],state:'unknown'} } } })
  const p = await preview(id,[sid]); assert.match(p.blockers.join(' '), /混合恢复记录/)
  assert.equal((await execute(id,[sid],p.revision)).statusCode,422)
  assert.ok(one('SELECT 1 FROM shots WHERE id=?',sid)); assert.ok(one('SELECT 1 FROM model_unit_checkpoints WHERE namespace=?','mixed-run'))
  generationUnitStore(id,'mixed-run',{}).clear()
  run("INSERT INTO jobs(id,project_id,shot_id,job_type,request,status,external_id,created_at,updated_at) VALUES('unknown-job',?,?,'generation','{}','failed','remote-unsettled',?,?)",id,sid,now(),now())
  const pending=await preview(id,[sid]); assert.match(pending.blockers.join(' '),/交付|恢复结果尚未确认/)
  assert.equal((await execute(id,[sid],pending.revision)).statusCode,422)
})
test('out-of-root and symlink files are blocked and database failure restores staged files', async () => {
  const { id,sid }=await setup(), outside=join(directory,'outside.png');await writeFile(outside,'keep')
  await asset(id,sid,'outside',outside)
  let p=await preview(id,[sid]);assert.match(p.blockers.join(' '),/路径不安全|受管媒体目录/)
  assert.equal((await execute(id,[sid],p.revision)).statusCode,422);await stat(outside)
  run('DELETE FROM assets WHERE id=?','outside')
  const link=join(mediaDir,'link.png');await symlink(outside,link);await asset(id,sid,'link',link)
  p=await preview(id,[sid]);assert.match(p.blockers.join(' '),/路径不安全/);run('DELETE FROM assets WHERE id=?','link')
  const file=await asset(id,sid,'rollback');
  db.exec(`CREATE TRIGGER prevent_fixture_delete BEFORE DELETE ON shots WHEN OLD.id='${sid}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`)
  p=await preview(id,[sid]);assert.deepEqual(p.blockers,[])
  assert.equal((await execute(id,[sid],p.revision)).statusCode,500)
  await stat(file);assert.ok(one('SELECT 1 FROM assets WHERE id=?','rollback'));assert.ok(one('SELECT 1 FROM shots WHERE id=?',sid))
  db.exec('DROP TRIGGER prevent_fixture_delete')
})
