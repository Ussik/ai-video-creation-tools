import { createHash } from 'node:crypto'
export type PurgeRow = Record<string, any> & { __rowid: number }
export type PurgeSnapshot = Record<string, PurgeRow[]>
export function parsed(value: unknown): any {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return undefined }
}
export function objects(value: unknown): Record<string, any>[] {
  const entry=parsed(value)
  if (!entry || typeof entry!=='object') return []
  return [entry,...Object.values(entry).flatMap(objects)]
}
const familyHash=(design: string|null, scenes: string[])=>createHash('sha256').update(JSON.stringify([design,scenes])).digest('hex')
/** Old SET NULL relationships are recovered only from explicit request IDs and saved per-shot usage. */
export function derivedShotScope(projectId:string, snapshot:PurgeSnapshot, selected?:string[], historicalScenes:string[]=[]) {
  const rows=(name:string)=>snapshot[name]||[], current=rows('shots'), hints=new Map<string,{id:string;title:string;source_scene_id:string|null;evidence:string[]}>()
  const hint=(id:unknown,scene:unknown,evidence:string)=>{
    if(typeof id!=='string'||!id||current.some(s=>s.id===id))return
    const old=hints.get(id)
    hints.set(id,{id,title:old?.title||`已删除分镜 ${id}`,source_scene_id:typeof scene==='string'?scene:old?.source_scene_id||null,evidence:[...new Set([...(old?.evidence||[]),evidence])]})
  }
  for(const job of rows('jobs').filter(r=>r.project_id===projectId))hint(parsed(job.request)?.shot_id,null,`jobs:${job.id}:request.shot_id`)
  const plans:Array<{plan:any;namespace:string;owner?:string}>=[]
  for(const row of rows('model_unit_checkpoints').filter(r=>r.project_id===projectId&&r.namespace.startsWith('canvas-preparation-runs:'))) {
    const manifest=parsed(row.payload)?.steps?.manifest?.value
    for(const run of manifest?.runs||[])if(run.plan) {
      plans.push({plan:run.plan,namespace:row.namespace,owner:run.owner})
      for(const profile of run.plan.profiles||[])for(const usage of profile.shot_usage||[])
        hint(usage.shot_id,profile.scene_ids?.length===1?profile.scene_ids[0]:null,`${row.namespace}:profiles.shot_usage`)
      for(const entry of objects(run.plan.visual_coverage))if(entry.shot_id)hint(entry.shot_id,entry.scene_id,`${row.namespace}:visual_coverage`)
    }
  }
  const alreadyPurged=new Set(rows('purged_resource_ids').filter(r=>r.project_id===projectId&&r.kind==='shot').map(r=>r.id))
  const ids=new Set(selected||[...hints.keys()]), ownShots=current.filter(r=>r.project_id===projectId&&ids.has(r.id))
  const scenes=new Set<string>([...ownShots.map(s=>s.source_scene_id),...historicalScenes].filter(Boolean))
  for(const scene of [...scenes])if(current.some(s=>s.source_scene_id===scene&&!ids.has(s.id)))scenes.delete(scene)
  const profileProofs=new Map<string,string[]>(), profileKeys=new Set<string>(), namespaces=new Set<string>(), operationIds=new Set<string>()
  for(const origin of rows('shot_resource_origins').filter(r=>r.project_id===projectId&&r.kind==='profile')) {
    const owners=parsed(origin.shot_ids), ownerScenes=parsed(origin.scene_ids)
    if(Array.isArray(owners)&&owners.length&&owners.every((id:string)=>ids.has(id)||alreadyPurged.has(id))&&Array.isArray(ownerScenes)&&ownerScenes.every((id:string)=>scenes.has(id)||!current.some(s=>s.project_id===projectId&&s.source_scene_id===id)))profileProofs.set(origin.resource_id,['persistent canvas adoption ownership'])
  }
  for(const {plan,namespace,owner} of plans) {
    const usages=objects(plan).filter(e=>typeof e.shot_id==='string').map(e=>e.shot_id)
    if(!plan.scene_ids?.length||!plan.scene_ids.every((id:string)=>scenes.has(id))||!usages.length||!usages.every((id:string)=>ids.has(id)))continue
    namespaces.add(namespace)
    const suffix=namespace.slice('canvas-preparation-runs:'.length)
    for(const row of rows('model_unit_checkpoints'))if(row.project_id===projectId&&(row.namespace===`visual-profiles:${suffix}`||row.namespace.startsWith(`visual-profiles:${suffix}:run:`)))namespaces.add(row.namespace)
    if(owner)operationIds.add(owner)
    for(const draft of plan.profiles||[]) {
      if(draft.draft_key)profileKeys.add(draft.draft_key)
      if(!draft.shot_usage?.length||!draft.shot_usage.every((u:any)=>ids.has(u.shot_id)))continue
      for(const profile of rows('visual_profiles').filter(r=>r.project_id===projectId&&r.kind===draft.kind&&r.name===draft.name&&r.variant===draft.variant
        &&r.definition===draft.definition&&r.view_requirements===draft.view_requirements))profileProofs.set(profile.id,[`${namespace}: exact generated definition and per-shot usage`])
    }
  }
  // Hash-only family identities are reproducible; no time or project-wide namespace guessing.
  const designs=new Set<string|null>([null,...ownShots.map(s=>s.design_id||null)])
  for(const design of designs)for(const scene of scenes) {
    const hash=familyHash(design,[scene])
    for(const row of rows('model_unit_checkpoints').filter(r=>r.project_id===projectId))if(row.namespace===`canvas-preparation-runs:${hash}`||row.namespace===`visual-profiles:${hash}`||row.namespace.startsWith(`visual-profiles:${hash}:run:`))namespaces.add(row.namespace)
  }
  for(const row of rows('model_unit_checkpoints').filter(r=>r.project_id===projectId))for(const namespace of [...namespaces])if(row.namespace===`visual-preparation:${createHash('sha256').update(JSON.stringify(namespace)).digest('hex')}`)namespaces.add(row.namespace)
  return {ids,scenes,profileProofs,profileKeys,namespaces,operationIds,hints,ownShots}
}
