import { assetPreviewPaths } from '../assets/asset-previews.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { all, db, dataDir, mediaDir, one, type Shot } from '../../infrastructure/database/db.js'
import { derivedShotScope, parsed, objects } from './shot-derived-scope.js'
import { invalidateGenerationScopes } from '../generation/generation-scope-lifecycle.js'
import { shotDeleteBlockers } from './shot-management.js'
import type { ShotPurgePreview } from '@video-studio/shared/storyboard/shot-management'

type Row = Record<string, any> & { __rowid: number }
type Removal = { table: string; rowid: number; label: string }
const fail = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }) }
const exists = (table: string) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
const rows = (table: string): Row[] => exists(table) ? all<Row>(`SELECT rowid AS __rowid,* FROM ${table}`) : []
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function mentions(value: unknown, ids: ReadonlySet<string>): boolean {
  if (!ids.size || value === undefined || value === null) return false
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return [...ids].some(id => text.includes(id))
}
function nestedPending(value: unknown): boolean {
  if (typeof value === 'string') { try { return nestedPending(JSON.parse(value)) } catch { return false } }
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (['running', 'generating', 'unknown'].includes(String(row.state || row.status))) return true
  if (typeof row.uncertain_requests === 'number' && row.uncertain_requests > 0) return true
  if (row.initial_started && row.raw === undefined || row.correction_started && !row.correction) return true
  return Object.values(row).some(nestedPending)
}
const ledgerTables = ['script_step_checkpoints', 'model_unit_checkpoints', 'ai_operations', 'model_request_tasks', 'candidate_review_evidence',
  'business_tasks', 'shot_plan_requests', 'script_generation_checkpoints']
const domainTables = ['projects', 'shots', 'canvas_nodes', 'canvas_edges', 'timeline_clips', 'editing_cuts', 'production_ranges', 'canvas_production_ranges',
  'speech_lines', 'speech_takes', 'speech_placements', 'project_audio_settings', 'visual_profiles', 'scene_visual_bindings', 'script_canvas_preparations',
  'shot_visual_bindings', 'visual_profile_candidates', 'visual_profile_reference_assets', 'asset_reviews', 'shot_candidate_archives', 'saved_assets',
  'video_reviews', 'video_comparisons', 'cut_reviews', 'asset_tasks', 'jobs', 'resource_submissions', 'assets', 'asset_task_events',
  'job_image_recovery', 'job_video_recovery', 'job_generation_attempts', 'model_request_attempts', 'storyboard_designs', 'storyboard_clip_plans', 'storyboard_scene_plans', 'script_scenes', 'script_artifacts', 'script_checkpoint_versions', 'shot_resource_origins', 'purged_resource_ids', ...ledgerTables]

/** Exclusive ownership is proven by explicit foreign keys or exact resource IDs.
 * Scene/design equality alone never authorizes deleting a mixed checkpoint. */
function plan(projectId: string, shotIds: string[], historicalScenes?: string[]) {
  const ids = new Set(shotIds), snapshot = Object.fromEntries(domainTables.map(table => [table, rows(table)]))
  const table = (name: string) => snapshot[name] || []
  const scope=derivedShotScope(projectId,snapshot,shotIds,historicalScenes)
  const shots = [...scope.ownShots]
  if(historicalScenes) {
    for(const id of ids)if(!shots.some(row=>row.id===id)) {
      const recovered=scope.hints.get(id)
      if(!recovered)fail('无法证明旧分镜来源，未扩大清理范围',422)
      shots.push({...recovered,project_id:projectId,deleted_at:'historical',__rowid:-1})
    }
    if(historicalScenes.some(id=>!table('storyboard_scene_plans').some(row=>row.project_id===projectId&&row.scene_id===id)
      ||table('shots').some(row=>row.project_id===projectId&&row.source_scene_id===id&&!ids.has(row.id))))fail('历史场次仍有其他分镜或缺少已保存规划来源，未扩大清理',422)
  }
  if (!ids.size || ids.size !== shotIds.length || shots.length !== ids.size) fail('镜头不存在、重复或不属于当前项目', 404)
  const blockers: string[] = [], protectedItems: ShotPurgePreview['protected'] = [], removals: Removal[] = []
  const removed = (name: string, row: Row) => removals.some(item => item.table === name && item.rowid === row.__rowid)
  const add = (name: string, row: Row, label: string) => { if (!removals.some(item => item.table === name && item.rowid === row.__rowid)) removals.push({ table: name, rowid: row.__rowid, label }) }
  for (const shot of shots) {
    if (!shot.deleted_at) blockers.push(`${shot.title}：请先移入回收站`)
    blockers.push(...shotDeleteBlockers(shot as unknown as Shot).map(reason => `${shot.title}：${reason}`))
    if(shot.__rowid>=0)add('shots', shot, shot.title)
  }
  for(const row of table('canvas_nodes'))if(row.project_id===projectId&&row.type!=='script'&&(ids.has(row.shot_id)||ids.has(parsed(row.settings)?.shot_id)))add('canvas_nodes',row,'分镜画布节点')
  const bindings = table('shot_visual_bindings').filter(row => ids.has(row.shot_id))
  const profileIds = new Set<string>()
  const candidates=table('visual_profiles').filter(row=>row.project_id===projectId&&(scope.profileProofs.has(row.id)||bindings.some(binding=>binding.profile_id===row.id)))
  // A generated base is not automatically shared. Source evidence and surviving consumers decide.
  for(const profile of candidates)profileIds.add(profile.id)
  let changed=true
  while(changed) {
    changed=false
    for(const profile of candidates.filter(row=>profileIds.has(row.id))) {
      const shared=(!scope.profileProofs.has(profile.id)&&!profile.base_profile_id)
        ||table('shot_visual_bindings').some(row=>row.profile_id===profile.id&&!ids.has(row.shot_id))
        ||table('scene_visual_bindings').some(row=>row.profile_id===profile.id&&!scope.scenes.has(row.scene_id))
        ||table('visual_profiles').some(row=>row.base_profile_id===profile.id&&!profileIds.has(row.id))
        ||['script_artifacts','script_scenes'].some(name=>table(name).some(row=>mentions(row,new Set([profile.id]))))
        ||['canvas_nodes','canvas_edges'].some(name=>table(name).some(row=>!removed(name,row)&&mentions(row,new Set([profile.id]))))
      if(shared){profileIds.delete(profile.id);changed=true}
    }
  }
  for(const profile of candidates) {
    if(profileIds.has(profile.id))add('visual_profiles',profile,`${profile.name} · ${profile.variant}`)
    else protectedItems.push({kind:'profile',id:profile.id,label:`${profile.name} · ${profile.variant}`,reasons:[scope.profileProofs.has(profile.id)?'仍有未删除镜头、场次、画布或派生档案引用':'未证明为本次分镜专属生成的基础档案']})
  }
  // A scene binding belongs to the scene being removed even when its profile is
  // shared by a surviving shot. Remove that dead scene edge, while retaining
  // the shared profile and its surviving scene bindings for the next purge.
  for(const row of table('scene_visual_bindings'))if(scope.scenes.has(row.scene_id) && (profileIds.has(row.profile_id) || table('shot_resource_origins').some(origin=>origin.project_id===projectId && origin.kind==='profile' && origin.resource_id===row.profile_id && parsed(origin.scene_ids)?.includes(row.scene_id) && parsed(origin.shot_ids)?.some((id:string)=>ids.has(id)))))add('scene_visual_bindings',row,'已删除场次的派生参考关联')
  for(const row of table('script_canvas_preparations'))if(scope.scenes.has(row.scene_id))add('script_canvas_preparations',row,'已删除分镜的画布准备状态')
  for(const row of table('storyboard_scene_plans'))if(row.project_id===projectId&&scope.scenes.has(row.scene_id))add('storyboard_scene_plans',row,'分镜规划状态')
  const designIds=new Set(shots.map(row=>row.design_id).filter(Boolean))
  for(const row of table('storyboard_designs'))if(row.project_id===projectId&&designIds.has(row.id)&&!table('shots').some(shot=>shot.design_id===row.id&&!ids.has(shot.id))) {
    add('storyboard_designs',row,'已清空的分镜方案')
    for(const clip of table('storyboard_clip_plans'))if(clip.design_id===row.id)add('storyboard_clip_plans',clip,'方案片段规划')
  }
  for (const row of bindings) add('shot_visual_bindings', row, '镜头参考关联')
  const taskIds = new Set(table('visual_profiles').filter(row => profileIds.has(row.id)).map(row => row.asset_task_id).filter(Boolean))
  for (const id of [...taskIds]) if (table('visual_profiles').some(row => row.asset_task_id === id && !profileIds.has(row.id))) taskIds.delete(id)
  const candidateAssetIds = new Set<string>(table('assets').filter(row => row.project_id === projectId && ids.has(row.shot_id)).map(row => row.id))
  for (const name of ['visual_profile_reference_assets', 'visual_profile_candidates']) for (const row of table(name)) if (profileIds.has(row.profile_id)) {
    candidateAssetIds.add(row.asset_id); add(name, row, '专属参考候选')
  }
  for (const row of table('visual_profiles')) if (profileIds.has(row.id) && row.board_asset_id) candidateAssetIds.add(row.board_asset_id)
  for (const name of ['asset_reviews', 'shot_candidate_archives']) for (const row of table(name)) if (ids.has(row.shot_id)) add(name, row, '镜头素材历史')
  const jobs = table('jobs').filter(row => row.project_id === projectId && (ids.has(row.shot_id) || ids.has(parsed(row.request)?.shot_id) || profileIds.has(parsed(row.request)?.visual_profile_id) || taskIds.has(parsed(row.request)?.asset_task_id)))
  const jobIds = new Set<string>(jobs.map(row => row.id))
  for (const job of jobs) {
    if (['queued', 'running'].includes(job.status)) blockers.push(`${job.id}：生成任务尚未结束`)
    if (job.status === 'failed' && !/InputImageSensitiveContentDetected|content[_ -]policy|上游状态.*(?:400|403)|模型接口返回 400/i.test(job.error||'') && (job.external_id || table('job_generation_attempts').some(row => row.job_id === job.id)
      || table('job_image_recovery').some(row => row.job_id === job.id) || table('job_video_recovery').some(row => row.job_id === job.id))) blockers.push(`${job.id}：远端交付或恢复结果尚未确认`)
    if (job.result_asset_id) candidateAssetIds.add(job.result_asset_id)
    add('jobs', job, job.id)
  }
  for(const row of table('canvas_nodes'))if(row.project_id===projectId&&row.type!=='script'&&jobIds.has(row.job_id))add('canvas_nodes',row,'分镜生成节点')
  const nodeIds=new Set(table('canvas_nodes').filter(row=>removed('canvas_nodes',row)).map(row=>row.id))
  for(const edge of table('canvas_edges'))if(edge.project_id===projectId&&(nodeIds.has(edge.source)||nodeIds.has(edge.target)))add('canvas_edges',edge,'分镜画布连线')
  for (const name of ['job_image_recovery', 'job_video_recovery', 'job_generation_attempts']) for (const row of table(name)) if (jobIds.has(row.job_id)) add(name, row, '生成恢复记录')
  for (const row of table('asset_tasks')) if (taskIds.has(row.id)) { if (row.status === 'generating') blockers.push(`${row.id}：参考生成未结束`); add('asset_tasks', row, '专属参考任务') }
  for (const row of table('asset_task_events')) if (taskIds.has(row.task_id)) add('asset_task_events', row, '参考任务历史')
  const draftKeys = new Set<string>(table('visual_profiles').filter(row => profileIds.has(row.id) && typeof row.source_draft_key === 'string' && row.source_draft_key
    && !table('visual_profiles').some(other => !profileIds.has(other.id) && other.source_draft_key === row.source_draft_key)).map(row => row.source_draft_key))
  const exclusiveIds = new Set([...ids, ...profileIds, ...jobIds, ...taskIds])
  const checkpointAnchors = new Set([...exclusiveIds, ...draftKeys])
  const foreignResources = new Set<string>(['shots', 'visual_profiles', 'jobs', 'assets'].flatMap(name => table(name).filter(row => !exclusiveIds.has(row.id) && !candidateAssetIds.has(row.id)).map(row => row.id)))
  // Related histories can be removed only if every referenced resource belongs to this deletion.
  for (const name of ['video_reviews', 'video_comparisons', 'cut_reviews']) for (const row of table(name)) {
    if (row.project_id !== projectId || !mentions(row, new Set([...exclusiveIds, ...candidateAssetIds]))) continue
    if (mentions(row, foreignResources)) blockers.push(`${name}：包含其他镜头或共享素材的混合历史，未整行删除`)
    else add(name, row, '专属复核历史')
  }
  // Real usage ledger and operation histories require explicit IDs, never route/time guessing.
  const operationIds = new Set<string>(scope.operationIds), modelTaskIds = new Set<string>([...jobIds, ...[...jobIds].map(id => 'job:' + id)])
  for (const name of ['ai_operations', 'business_tasks']) for (const row of table(name)) if (row.project_id === projectId
    && (operationIds.has(row.id) || mentions(row.scope || row.scope_json, exclusiveIds) || mentions(row.route, ids) || mentions(row.result, new Set([...exclusiveIds,...candidateAssetIds])) || mentions(row.candidate, new Set([...exclusiveIds,...candidateAssetIds])))) {
    if (mentions(row, foreignResources)) { blockers.push(`${name}：关联其他对象的混合运行，不能因删除一个镜头而移除`); continue }
    if (row.state === 'running' && (row.lease_until === undefined || row.lease_until > Date.now())) blockers.push(`${name}：运行未结束或交付未知`)
    add(name, row, '独占用户操作历史'); operationIds.add(row.id)
    if (row.model_task_id) modelTaskIds.add(row.model_task_id)
  }
  for (const name of ['script_step_checkpoints', 'script_checkpoint_versions', 'model_unit_checkpoints', 'candidate_review_evidence', 'shot_plan_requests', 'script_generation_checkpoints']) for (const row of table(name)) {
    if (row.project_id !== projectId)continue
    const body=parsed(row.payload)
    const sceneScope=body?.input?.scene_ids||body?.scene_ids||body?.scenes?.map((scene:any)=>scene.scene_id)||body?.steps?.committed?.value?.result?.scene_ids
    const scopedPlanning=(row.namespace==='storyboard-planning-preview'||row.namespace?.startsWith('storyboard-planning-task:'))&&Array.isArray(sceneScope)&&sceneScope.length&&sceneScope.every((id:string)=>scope.scenes.has(id))
    const linked=scope.namespaces.has(row.namespace)||scopedPlanning||mentions(row,new Set([...checkpointAnchors,...candidateAssetIds,...operationIds]))
    if(!linked)continue
    const mixedDrafts = (value: unknown): boolean => {
      if (typeof value === 'string') { try { return mixedDrafts(JSON.parse(value)) } catch { return false } }
      if (!value || typeof value !== 'object') return false
      const entry = value as Record<string, unknown>
      if (Array.isArray(entry.profiles) && entry.profiles.some(profile => profile && typeof profile === 'object'
        && typeof (profile as any).draft_key === 'string' && !draftKeys.has((profile as any).draft_key))) return true
      return Object.values(entry).some(mixedDrafts)
    }
    if (mentions(row, foreignResources) || !scope.namespaces.has(row.namespace) && mixedDrafts(row.payload)) { blockers.push(`${name}：包含其他镜头/档案的混合恢复记录，不能整场删除`); continue }
    if (body?.snapshot?.status==='running' || objects(body?.steps?.manifest?.value?.runs).some(run=>run.state==='running')) blockers.push(`${name}：仍有活跃运行，不能删除恢复保护`)
    add(name, row, '独占恢复检查点')
    if(scopedPlanning&&body?.snapshot?.id)modelTaskIds.add(`storyboard:${body.snapshot.id}`)
    for(const entry of objects(body?.steps?.manifest?.value?.runs)) {
      if(entry.execution?.task_id)modelTaskIds.add(entry.execution.task_id)
      if(entry.owner)operationIds.add(entry.owner)
    }
  }
  const modelTaskActive=(row:Row)=>{
    if(row.state!=='running')return false
    if(row.id.startsWith('storyboard:')) {
      const task=table('script_step_checkpoints').find(task=>task.project_id===projectId&&task.namespace==='storyboard-planning-task:'+row.id.slice('storyboard:'.length))
      const status=parsed(task?.payload)?.snapshot?.status
      if(status&&status!=='running')return false
    }
    if(table('ai_operations').some(op=>op.model_task_id===row.id&&['completed','failed'].includes(op.state)))return false
    return !table('model_unit_checkpoints').some(checkpoint=>objects(parsed(checkpoint.payload)?.steps?.manifest?.value?.runs).some(run=>run.execution?.task_id===row.id&&run.state!=='running'))
  }
  for (const row of table('model_request_tasks')) if (row.project_id === projectId && (modelTaskIds.has(row.id) || operationIds.has(row.id) || mentions(row, exclusiveIds))) {
    if (modelTaskActive(row)) blockers.push(`${row.id}：诊断记录仍有未结算请求`)
    if (mentions(row, foreignResources)) { protectedItems.push({ kind: 'history', id: row.id, label: row.label, reasons: ['共享模型诊断台账'] }); continue }
    modelTaskIds.add(row.id); add('model_request_tasks', row, '独占模型诊断')
  }
  for (const row of table('model_request_attempts')) if (modelTaskIds.has(row.task_id)) add('model_request_attempts', row, '独占请求诊断')
  // Close operation -> model task and checkpoint-owner -> operation links after the checkpoint pass.
  for(const row of table('ai_operations'))if(row.project_id===projectId&&operationIds.has(row.id)&&!removed('ai_operations',row)) {
    if(row.state==='running'&&row.lease_until>Date.now())blockers.push(`${row.id}：操作仍在执行`)
    if(mentions(row,foreignResources))blockers.push(`${row.id}：操作仍关联其他资源`)
    else {add('ai_operations',row,'专属运行历史');if(row.model_task_id)modelTaskIds.add(row.model_task_id)}
  }
  for(const row of table('model_request_tasks'))if(row.project_id===projectId&&modelTaskIds.has(row.id)&&!removed('model_request_tasks',row)) {
    if(modelTaskActive(row))blockers.push(`${row.id}：模型任务仍在执行`)
    if(!mentions(row,foreignResources))add('model_request_tasks',row,'专属模型诊断')
  }
  for(const row of table('model_request_attempts'))if(modelTaskIds.has(row.task_id))add('model_request_attempts',row,'专属请求诊断')
  for(const row of table('shot_resource_origins'))if(row.project_id===projectId&&row.kind==='profile'&&profileIds.has(row.resource_id))add('shot_resource_origins',row,'专属资源来源')
  // Keep accepted submission rows as immutable idempotency tombstones. The
  // referenced shot/job may be gone, and findSubmission will return 409 rather
  // than allowing a lost client response to create a new resource.
  const assets: Row[] = []
  for (const asset of table('assets').filter(row => candidateAssetIds.has(row.id))) {
    const refs: string[] = []
    if (asset.project_id !== projectId) refs.push('属于其他项目')
    if (asset.source !== 'generated' && !ids.has(asset.shot_id)) refs.push('共享上传或成片文件')
    for (const name of domainTables.filter(name => !['assets', ...ledgerTables, 'model_request_attempts'].includes(name))) {
      if (table(name).some(row => !removed(name, row) && mentions(row, new Set([asset.id, ...(asset.remote_url ? [asset.remote_url] : [])])))) refs.push(`${name} 引用`)
    }
    if (refs.length) { protectedItems.push({ kind: 'asset', id: asset.id, label: asset.filename, reasons: [...new Set(refs)] }); continue }
    assets.push(asset); add('assets', asset, asset.filename)
  }
  // A shared asset can survive, detached from the deleted shot. Its exclusive job history is protected by external consumers.
  for (const job of jobs) if (['canvas_nodes', 'visual_profile_reference_assets', 'video_comparisons'].some(name => table(name).some(row => !removed(name, row) && mentions(row, new Set([job.id]))))) blockers.push(`${job.id}：其他画布、参考或成片仍引用此生成任务`)
  const files: Array<{ path: string; size: number; mtime: number; label: string }> = []
  for (const asset of assets) {
    const path = resolve(asset.path)
    const canonicalPath = existsSync(path) ? realpathSync(path) : path
    const shared = table('assets').some(other => !assets.includes(other) && (existsSync(other.path) ? realpathSync(other.path) : resolve(other.path)) === canonicalPath)
    if (shared) { protectedItems.push({ kind: 'file', id: asset.id, label: asset.filename, reasons: ['其他素材记录共享相同文件路径'] }); continue }
    if (!existsSync(path)) continue
    const info = lstatSync(path), rel = relative(resolve(mediaDir), path), canonicalRel = relative(realpathSync(mediaDir), canonicalPath)
    if (info.isSymbolicLink() || !info.isFile() || !rel || rel.startsWith('..') || isAbsolute(rel)
      || !canonicalRel || canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
      blockers.push(`${asset.filename}：文件不在受管媒体目录或路径不安全，未删除`); continue
    }
    if (!files.some(file => file.path === path)) files.push({ path, size: info.size, mtime: info.mtimeMs, label: asset.filename })
  }
  for(const asset of assets)for(const path of assetPreviewPaths(asset as any,resolve(mediaDir,asset.project_id,'.previews'))) {
    if(!existsSync(path))continue
    const info=lstatSync(path), rel=relative(realpathSync(mediaDir),realpathSync(path))
    if(info.isSymbolicLink()||!info.isFile()||!rel||rel.startsWith('..')||isAbsolute(rel)){blockers.push(`${asset.filename}：缩略图路径不安全`);continue}
    if(!files.some(file=>file.path===path))files.push({path,size:info.size,mtime:info.mtimeMs,label:asset.filename+' 的本地预览'})
  }
  const preview: ShotPurgePreview = { revision: '', shots: shots.map(row => ({ id: row.id, title: row.title })),
    delete: removals.map(item => ({ kind: item.table, label: item.label })), files: files.map(file => ({ name: file.label, bytes: file.size })),
    protected: protectedItems, blockers: [...new Set(blockers)], remote_cancelled: false,
    ...(historicalScenes ? {retained_records: ledgerTables.flatMap(name => table(name).filter(row => row.project_id === projectId && !removed(name,row)).map(row => ({kind:name,id:String(row.id || row.request_id || row.namespace),reason:'没有证明独占归属本次已删除分镜，保留原记录'})))} : {}) }
  preview.revision = digest({ projectId, shotIds: [...shotIds].sort(), snapshot, files, preview })
  return { preview, removals, files, snapshot, scope }
}
export function previewShotResidualPurge(projectId:string,shotIds:string[],sceneIds:string[]) { return plan(projectId,shotIds,sceneIds).preview }
export function deletedShotResidualScope(projectId:string) {
  const snapshot=Object.fromEntries(domainTables.map(table=>[table,rows(table)])), scope=derivedShotScope(projectId,snapshot)
  return {shots:[...scope.hints.values()],scene_ids:(snapshot.storyboard_scene_plans||[]).filter(row=>row.project_id===projectId&&!(snapshot.shots||[]).some(shot=>shot.project_id===projectId&&shot.source_scene_id===row.scene_id)).map(row=>row.scene_id)}
}
export const previewShotPurge = (projectId: string, shotIds: string[]): ShotPurgePreview => plan(projectId, shotIds).preview
export function executeShotPurge(projectId: string, shotIds: string[], revision: string, historicalScenes?: string[]) {
  let computed!: ReturnType<typeof plan>
  const staging = resolve(dataDir, '.shot-purge-' + randomUUID()), moved: Array<{ from: string; to: string }> = []
  try {
    db.transaction(() => {
      computed = plan(projectId, shotIds, historicalScenes)
      if (revision !== computed.preview.revision) fail('分镜、共享引用、恢复记录或文件已更新，请重新预览')
      if (computed.preview.blockers.length) fail('未执行彻底删除：' + computed.preview.blockers.join('；'), 422)
      mkdirSync(staging)
    for (const [index, file] of computed.files.entries()) { const to = resolve(staging, String(index)); renameSync(file.path, to); moved.push({ from: file.path, to }) }
      // SQLite mutation is atomic; the preview was recomputed with all global reference rows above.
      const priority = ['model_request_attempts', 'model_request_tasks', 'business_tasks', 'ai_operations', 'resource_submissions', 'job_image_recovery', 'job_video_recovery', 'job_generation_attempts',
        'canvas_edges', 'canvas_nodes', 'scene_visual_bindings', 'script_canvas_preparations', 'visual_profile_reference_assets', 'visual_profile_candidates', 'shot_visual_bindings', 'asset_reviews', 'shot_candidate_archives', 'asset_task_events', 'jobs', 'visual_profiles', 'asset_tasks', 'assets', 'storyboard_scene_plans', 'storyboard_clip_plans', 'shots', 'storyboard_designs']
      const sorted = [...computed.removals].sort((a, b) => (priority.indexOf(a.table) + 1 || 1) - (priority.indexOf(b.table) + 1 || 1))
      db.exec('CREATE TABLE IF NOT EXISTS purged_operation_ids(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE)')
      invalidateGenerationScopes(projectId,computed.removals.filter(item=>['model_unit_checkpoints','script_step_checkpoints','script_checkpoint_versions'].includes(item.table)).map(item=>computed.snapshot[item.table]!.find(row=>row.__rowid===item.rowid)!.namespace))
      db.exec('CREATE TABLE IF NOT EXISTS purged_resource_ids(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(project_id,kind,id))')
      const tombstone=(kind:string,id:string)=>db.prepare('INSERT OR IGNORE INTO purged_resource_ids VALUES(?,?,?)').run(projectId,kind,id)
      for(const id of shotIds)tombstone('shot',id)
      for(const item of computed.removals) {
        const row=computed.snapshot[item.table]!.find(row=>row.__rowid===item.rowid)!
        if(['jobs','assets','visual_profiles','model_request_tasks'].includes(item.table)&&row.id)tombstone(item.table,row.id)
        if(item.table==='shot_plan_requests')tombstone('storyboard_commit',row.request_id)
        if(item.table==='script_step_checkpoints'&&row.namespace.startsWith('storyboard-planning-task:')) {
          for(const id of parsed(row.payload)?.request_ids||[])tombstone('storyboard_request',id)
        }
      }
      for(const table of ['jobs','assets','visual_profiles','model_request_tasks'])if(exists(table))db.exec(`CREATE TRIGGER IF NOT EXISTS prevent_purged_${table}_insert BEFORE INSERT ON ${table}
        WHEN EXISTS(SELECT 1 FROM purged_resource_ids p WHERE p.project_id=NEW.project_id AND p.kind='${table}' AND p.id=NEW.id)
        BEGIN SELECT RAISE(ABORT,'resource_purged'); END`)
      for (const item of sorted) {
        if (item.table === 'ai_operations') {
          const row = one<{id:string}>('SELECT id FROM ai_operations WHERE rowid=?', item.rowid)
          if (row) db.prepare('INSERT OR IGNORE INTO purged_operation_ids VALUES(?,?)').run(row.id, projectId)
        }
        db.prepare(`DELETE FROM ${item.table} WHERE rowid=?`).run(item.rowid)
      }
    }).immediate()
  } catch (error) {
    for (const file of moved.reverse()) renameSync(file.to, file.from)
    if (existsSync(staging)) rmdirSync(staging)
    throw error
  }
  const pending: string[] = []
  for (const file of moved) { try { unlinkSync(file.to) } catch { pending.push(file.to) } }
  if (!pending.length) rmdirSync(staging)
  return { deleted_shots: shotIds.length, protected: computed.preview.protected, retained_records: computed.preview.retained_records, pending_file_count: pending.length, remote_cancelled: false,
    detail: pending.length ? `本地记录已删除，${pending.length} 个暂存文件尚未清理完成。` : `已删除本次预览证明归属的分镜及独占内容；保留共享内容和防重放标识。${computed.preview.retained_records?.length ? `另有 ${computed.preview.retained_records.length} 条未纳入本次范围的记录保留，详见 retained_records。` : ''}远端请求和计费不受本地删除影响。` }
}
