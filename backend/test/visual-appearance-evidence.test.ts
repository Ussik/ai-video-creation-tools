import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appearanceArbitration } from '../src/modules/visuals/visual-appearance-arbitration.js'
const before = '画面中心是一扇生锈的旧地铁口铁栅，铁栅缠绕着锈迹斑驳的链条,链条暗沉无光泽。铁栅后方是向下的台阶,台阶末端有发青的荧光灯管,灯管尚未完全亮起,呈暗淡的灰白色。'
const skipped = '画面右前景是许知夜的右手,手臂抬起,手指伸向锁链,尚未接触。许知夜身穿深色风衣,左手拎着白色塑料袋装的炒粉。'
const after = '窄巷石板地面湿润,倒映微弱光线。巷墙斑驳,远处可见褪色的黄色警示牌。小雨细密,空气中有薄雾。'
export const shot = { id: 'e465480894bf45e88b2206bdb6379921', source_scene_id: 'scene', image_prompt: before+skipped+after,
  start_state: '许知夜站在地铁口铁栅前，右手尚未碰到锁链。', video_prompt: '许知夜伸手触摸锁链，地铁口铁栅始终可见，随后退后。', end_state: '许知夜退到巷口，地铁口铁栅与锁链仍可见。' } as any
export const scene = { id: 'scene', action: shot.video_prompt } as any
export const profiles = [{draft_key:'loc_old_subway_gate_night_rain',kind:'location',name:'旧地铁口',variant:'夜雨',scene_ids:['scene']},
  {draft_key:'prop_chain',kind:'prop',name:'锁链',variant:'默认',scene_ids:['scene']}] as any[]
export const answer = () => ({ decisions:Object.fromEntries(profiles.map(p=>[p.draft_key,{relation_to_base:'independent',
  image:{visible:true,evidence:{field:'image_prompt',quote:p.kind==='location'?before+after:before}},
  video:{visible:true,phase:'throughout',evidence:{field:'video_prompt',quote:shot.video_prompt}},reason:'镜头明确包含该对象且持续可见，保留本镜真实可见性。'}])) })
test('2131 discontinuous image quote reports exact evidence failure and fixes evidence only',()=>{
  const plan=appearanceArbitration(shot,scene,profiles),raw=answer();let failure:any
  try{plan.validate(raw)}catch(error){failure=error}
  assert.equal(failure?.code,'visual_coverage_evidence_noncontiguous')
  assert.deepEqual(failure.differences[0].path,['decisions',profiles[0].draft_key,'image','evidence'])
  assert.doesNotMatch(failure.message,/不能用收镜/)
  const patch=plan.planLocalRepair(raw,{issues:[],error:failure})!
  const json=JSON.stringify(patch.schema)
  assert.ok(patch)
  assert.doesNotMatch(patch.prompt,/仅需仲裁的对象家族|prop_chain|video_prompt/)
  assert.ok(!json.includes('visible')&&!json.includes('relation_to_base'))
})

test('same-stage refs resolve exact source; wrong-stage, fabricated and previous-source IDs are rejected',async()=>{
  const {appearanceEvidence}=await import('../src/modules/visuals/visual-appearance-evidence.js')
  const refs=appearanceEvidence(shot), plan=appearanceArbitration(shot,scene,profiles)
  const raw=answer(); raw.decisions[profiles[0].draft_key].image.evidence.quote=before
  const image=refs.forMode('image').find(item=>item.field==='image_prompt')!
  const wire:any=structuredClone(raw);wire.decisions[profiles[0].draft_key].image.evidence={ref_id:image.ref_id}
  assert.deepEqual(plan.validate(wire).decisions[profiles[0].draft_key].image.evidence,{field:image.field,quote:image.quote})
  const current=JSON.stringify(wire)
  const old=appearanceEvidence({...shot,image_prompt:shot.image_prompt+'来源修订。'}).forMode('image')[0]!
  for(const ref_id of [old.ref_id,'ae1_fabricated',refs.candidates.find(item=>item.field==='end_state')!.ref_id]){
    wire.decisions[profiles[0].draft_key].image.evidence={ref_id}
    assert.throws(()=>plan.validate(wire),(error:any)=>/visual_coverage_evidence_(reference|stage)/.test(error.code))
  }
  assert.equal(JSON.stringify(JSON.parse(current).decisions[profiles[1].draft_key]),JSON.stringify(raw.decisions[profiles[1].draft_key]))
  const json=await import('zod').then(({z})=>z.toJSONSchema(plan.dispatchSchema)) as any
  const imageIds=json.properties.decisions.properties[profiles[0].draft_key].properties.image.properties.evidence.properties.ref_id.enum
  assert.ok(imageIds.every((id:string)=>refs.forMode('image').some(item=>item.ref_id===id)))
  assert.ok(!imageIds.some((id:string)=>id.includes('end_state')||id.includes('video_prompt')))
})

test('one evidence-ID patch preserves all successful objects, visibility, relation and video phase',async()=>{
  const {appearanceEvidence}=await import('../src/modules/visuals/visual-appearance-evidence.js')
  const plan=appearanceArbitration(shot,scene,profiles),raw=answer();let error:any
  try{plan.validate(raw)}catch(e){error=e}
  const patch=plan.planLocalRepair(raw,{issues:[],error})!
  const ref=appearanceEvidence(shot).forMode('image').find(item=>item.quote.includes('铁栅'))!
  const repaired:any=patch.apply({repairs:{[profiles[0].draft_key+'__image__evidence']:{ref_id:ref.ref_id}}})
  const expected=structuredClone(raw);expected.decisions[profiles[0].draft_key].image.evidence={field:ref.field,quote:ref.quote}
  assert.deepEqual(repaired,expected)
  assert.notDeepEqual(repaired,raw)
  assert.throws(()=>patch.apply({repairs:{[profiles[0].draft_key+'__image__evidence']:{ref_id:'old-version-ref'}}}))
})

test('four real requests remain exhausted across contract upgrade and reopen; original invalid quote is never silently replaced',async()=>{
  const {visualCoverageUnit}=await import('../src/modules/visuals/visual-coverage-unit.js')
  const {createGenerationSteps}=await import('../src/modules/script/script-generation-steps.js')
  let checkpoint:any={steps:{}},calls=0,upgraded=false
  const plan=appearanceArbitration(shot,scene,profiles)
  const {dispatchPrompt,dispatchSchema,...legacyPlan}=plan
  const execute=(retryToken?:string)=>visualCoverageUnit({...(upgraded?plan:legacyPlan),key:'@appearance:'+shot.id,name:'锁链无声用途仲裁',sceneIds:['scene'],shotIds:[shot.id],retryToken,
    steps:createGenerationSteps({checkpoint,save:value=>{checkpoint=structuredClone(value)}}),
    generate:async(_prompt,contract)=>{calls++;return JSON.stringify(contract?.name.endsWith('_local_repair')?{repairs:{[profiles[0].draft_key+'__image__evidence']:{ref_id:'fabricated'}}}:answer())}})
  let result=await execute();assert.ok('failure'in result)
  while(result.failure.recovery?.action==='retry'){
    result=await execute(result.failure.recovery.token);assert.ok('failure'in result)
    assert.ok(calls<=4)
  }
  assert.equal(calls,4);assert.equal(result.failure.model_request_count,4)
  assert.equal(result.failure.recovery?.action,'none')
  const original=structuredClone(checkpoint)
  upgraded=true
  for(let i=0;i<3;i++)await execute()
  assert.equal(calls,4)
  for(const [key,value]of Object.entries(original.steps))if(key.startsWith('response:'))assert.deepEqual(checkpoint.steps[key],value)
  assert.ok(Object.values(checkpoint.steps).some((entry:any)=>entry.value?.raw===JSON.stringify(answer())))
})


test('fresh evidence-ID response uses the wire contract and reopens exact completed bytes without a new request',async()=>{
  const {visualCoverageUnit}=await import('../src/modules/visuals/visual-coverage-unit.js')
  const {createGenerationSteps}=await import('../src/modules/script/script-generation-steps.js')
  const {appearanceEvidence}=await import('../src/modules/visuals/visual-appearance-evidence.js')
  let checkpoint:any={steps:{}},calls=0
  const refs=appearanceEvidence(shot),wire:any=answer()
  for(const row of Object.values(wire.decisions)as any[])for(const mode of ['image','video']as const)row[mode].evidence={ref_id:refs.forMode(mode)[0]!.ref_id}
  const execute=()=>{
    const plan=appearanceArbitration(shot,scene,profiles)
    return visualCoverageUnit({...plan,key:'@appearance:'+shot.id,name:'离线引用ID仲裁',sceneIds:['scene'],shotIds:[shot.id],
      steps:createGenerationSteps({checkpoint,save:value=>{checkpoint=structuredClone(value)}}),generate:async(prompt,contract)=>{
        calls++;const schema=JSON.stringify(contract!.schema)
        assert.match(schema,/ref_id/);assert.doesNotMatch(schema,/"quote"/)
        assert.ok(prompt.includes(refs.source_version))
        return JSON.stringify(wire)
      }})
  }
  const value=await execute();assert.ok('value'in value)
  assert.deepEqual(value.value,appearanceArbitration(shot,scene,profiles).validate(wire))
  assert.equal(calls,1)
  const original=structuredClone(checkpoint)
  assert.deepEqual(await execute(),value);assert.equal(calls,1)
  for(const[key,entry]of Object.entries(original.steps))if(key.startsWith('response:'))assert.deepEqual(checkpoint.steps[key],entry)
})

test('a scalar visibility correction does not overwrite its already valid evidence or siblings',()=>{
  const plan=appearanceArbitration(shot,scene,profiles),raw:any=answer()
  raw.decisions[profiles[0].draft_key].image.evidence.quote=before
  raw.decisions[profiles[0].draft_key].image.visible='wrong-type'
  const issues=plan.schema.safeParse(raw).error!.issues
  const patch=plan.planLocalRepair(raw,{issues})!
  const expected=structuredClone(raw);expected.decisions[profiles[0].draft_key].image.visible=true
  assert.deepEqual(patch.apply({repairs:{[profiles[0].draft_key+'__image__visible']:true}}),expected)
})
