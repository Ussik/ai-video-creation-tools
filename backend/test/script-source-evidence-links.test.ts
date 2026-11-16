import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'node:test'
import {outputContract,type StructuredOutputCheckpoint} from '../src/modules/generation/model-output.js'
import {sourceMapLocalRepairPlanner,remainingSourceMapLocalRepair} from '../src/modules/script/script-source-map-local-repair.js'
import {legacySourceMapSchema,sourceMapSchema,scriptSourcePassages,resolveSourceSections,validateSourceCoverage} from '../src/modules/script/script-source-map.js'
import {generateSourceMapOutput} from '../src/modules/script/script-source-map-output.js'
import {linkSourceEvidence} from '../src/modules/script/script-source-evidence-links.js'
import {sourceAnalysisFailureDetails} from '../src/modules/script/script-source-recovery.js'
function fixture(){
 const content='# 身份资料\n沈国栋是第七科科长。\n# 第二章\n沈国栋亲自敬礼。\n沈国栋交还黑卡。\n'
 const passages=scriptSourcePassages(content),units=passages.flatMap(p=>p.units),identity=units.find(u=>u.text.includes('是第七科'))!,presence=units.find(u=>u.text.includes('亲自敬礼'))!,another=units.find(u=>u.text.includes('交还黑卡'))!,start=units.find(u=>u.text.includes('# 第二章'))!
 const section=(start_unit:number)=>({start_unit,title:'章节',episode_number:null,summary:'原文索引',characters:[],events:[],continues_previous:false,open_threads:[]})
 const map:any={sections:[section(units[0]!.id),section(start.id)]}
 map.sections[1].characters=[{name:'沈国栋',description:'第七科科长（原有描述）',evidence:{unit_id:identity.id,occurrence_unit_id:presence.id,supporting_unit_ids:[another.id]}}]
 return {content,passages,units,identity,presence,another,map}
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const signal=()=>new AbortController().signal

test('identity and local occurrence resolve separately; all support quotes survive and exact coverage rejects forgery',()=>{
 const f=fixture(),r=resolveSourceSections(sourceMapSchema.parse(f.map),f.passages)
 assert.equal(r.problems.length,0);validateSourceCoverage(f.content,r.sections)
 const e=r.sections[1]!.characters[0]!.evidence
 assert.equal(e.quote,f.identity.text);assert.equal(e.occurrence!.quote,f.presence.text);assert.equal(e.supporting![0]!.quote,f.another.text)
 const forged=structuredClone(r.sections);forged[1]!.characters[0]!.evidence.supporting![0]!.quote='伪造事实'
 assert.throws(()=>validateSourceCoverage(f.content,forged),/证据校验失败/)
 delete f.map.sections[1].characters[0].evidence.occurrence_unit_id
 assert.match(resolveSourceSections(f.map,f.passages).problems[0]!.message,/本章出场/)
})

test('a remote event cannot be excused by character occurrence; duplicate or invented supports fail',()=>{
 const f=fixture();f.map.sections[1].events=[{summary:'敬礼',evidence:structuredClone(f.map.sections[1].characters[0].evidence)}]
 const problems=resolveSourceSections(f.map,f.passages).problems
 assert.ok(problems.some(p=>p.message.includes('跨章背景')))
 for(const ids of [[f.another.id,f.another.id],[99999]]){
  const candidate=fixture();candidate.map.sections[1].characters[0].evidence.supporting_unit_ids=ids
  assert.ok(resolveSourceSections(candidate.map,candidate.passages).problems.length)
 }
})

test('legacy migration needs one reviewed exact-name presence; it never swaps primary or guesses aliases',()=>{
 const f=fixture(),base={kind:'characters' as const,name:'沈国栋',evidence:{unit_id:f.identity.id},references:[f.identity.id,f.presence.id],used:new Set([f.identity.id]),allowed:new Set([f.presence.id,f.another.id]),units:new Map(f.units.map(u=>[u.id,u])),legacy:true,
 review:[{unit_id:f.identity.id,disposition:'primary' as const,reason:'身份'},{unit_id:f.presence.id,disposition:'supporting_context' as const,reason:'本章'}]}
 assert.deepEqual(linkSourceEvidence(base),{unit_id:f.identity.id,occurrence_unit_id:f.presence.id,supporting_unit_ids:[f.presence.id]})
 assert.throws(()=>linkSourceEvidence({...base,name:'别名猜测'}),/本章出场/)
 assert.throws(()=>linkSourceEvidence({...base,legacy:false}),/本章出场/)
 assert.throws(()=>linkSourceEvidence({...base,references:[...base.references,f.another.id],review:[...base.review,{unit_id:f.another.id,disposition:'supporting_context',reason:'第二处'}]}),/本章出场/)
})

test('exact old paid correction recovers locally, ignores copied valid text and preserves response/intent identity',async()=>{
 const f=fixture(),initial=structuredClone(f.map),prompt='historical source'
 initial.sections[1].characters[0].evidence={unit_id:[f.identity.id,f.presence.id]}
 const invalid=sourceMapSchema.safeParse(initial);if(invalid.success)assert.fail()
 const old=sourceMapLocalRepairPlanner(f.passages,false,true)(initial,{issues:invalid.error.issues})!,contract=outputContract('script_source_map_local_repair',old.schema)
 const request=hash([`\n【本次局部纠正契约】\n仅返回固定目标补丁；其余完整提案由程序保留。\n${JSON.stringify(contract.schema)}\n`+old.prompt,contract])
 const patch={repairs:{item_0:{replacements:[{name:'无权修改',description:'第七科科长(不同括号)',evidence:{unit_id:f.identity.id}}],evidence_review:[{unit_id:f.identity.id,disposition:'primary',reason:'身份'},{unit_id:f.presence.id,disposition:'supporting_context',reason:'出场'}]}}}
 const raw=JSON.stringify(initial),reply='以下是完整结果。\n```json\n'+JSON.stringify(patch)+'\n```\n结束。'
 const cp:StructuredOutputCheckpoint={input_hash:hash(['script_source_map',outputContract('script_source_map',legacySourceMapSchema).schema,prompt]),raw,original_raw:raw,correction_started:{input_hash:request},correction:{input_hash:request,raw:reply}}
 const result=await generateSourceMapOutput(prompt,f.passages,async()=>assert.fail('already paid'),{signal:signal(),checkpoint:cp,persist:()=>{}})
 assert.equal(cp.original_raw,raw);assert.equal(cp.correction!.raw,reply);assert.equal(cp.correction_started!.input_hash,request)
 const c=result.sections[1]!.characters[0]!
 assert.equal(c.name,'沈国栋');assert.equal(c.description,initial.sections[1].characters[0].description)
 assert.equal(c.evidence.unit_id,f.identity.id);assert.equal(c.evidence.occurrence_unit_id,f.presence.id)
 validateSourceCoverage(f.content,resolveSourceSections(result,f.passages).sections)
})

test('schema upgrades cannot dispatch an unknown or identity-mismatched historical request',async()=>{
 const f=fixture(),prompt='bound input',old=hash(['script_source_map',outputContract('script_source_map',legacySourceMapSchema).schema,prompt])
 for(const cp of [{input_hash:old,initial_started:{input_hash:old}},{input_hash:old,raw:JSON.stringify(f.map),correction_started:{input_hash:'unknown'}}]){
  const before=JSON.stringify(cp)
  await assert.rejects(generateSourceMapOutput(prompt+' changed',f.passages,async()=>assert.fail('forbidden dispatch'),{signal:signal(),checkpoint:cp,persist:()=>{}}),/身份不匹配/)
  assert.equal(JSON.stringify(cp),before)
 }
})

test('partial operations survive serialization and remaining planning cannot refresh a paid correction',async()=>{
 const f=fixture(),initial=structuredClone(f.map),cp:StructuredOutputCheckpoint={};let calls=0
 initial.sections[0].events=[{summary:'身份事实',evidence:{unit_id:[f.identity.id]}}]
 initial.sections[1].characters[0].evidence={unit_id:[f.identity.id,f.presence.id]}
 await assert.rejects(generateSourceMapOutput('partial',f.passages,async(prompt)=>{
  if(++calls===1)return JSON.stringify(initial)
  const input=JSON.parse(prompt.split('【冻结失败项与原文（资料）】\n')[1]!)
  return JSON.stringify({repairs:Object.fromEntries(input.targets.map((t:any)=>[t.key,{replacements:[{evidence:{unit_id:f.identity.id}}],evidence_review:t.original_unit_ids.map((id:number)=>({unit_id:id,disposition:id===f.identity.id?'primary':'supporting_context',reason:'逐项处置'}))}]))})
 },{signal:signal(),checkpoint:cp,persist:()=>{}}),error=>{assert.equal(sourceAnalysisFailureDetails(error).stage,'evidence');return true})
 assert.equal(calls,2);assert.equal(cp.local_repair!.retained_target_keys.length,1);assert.equal(cp.local_repair!.remaining_target_keys.length,1)
 const restored=JSON.parse(JSON.stringify(cp)) as StructuredOutputCheckpoint,plan=remainingSourceMapLocalRepair(restored,f.passages)!
 assert.equal(JSON.parse(plan.prompt.split('【冻结失败项与原文（资料）】\n')[1]!).targets.length,1)
 await assert.rejects(generateSourceMapOutput('partial',f.passages,async()=>assert.fail('no refreshed allowance'),{signal:signal(),checkpoint:restored,persist:()=>{}}))
 assert.deepEqual(restored.correction,cp.correction);assert.deepEqual(restored.correction_started,cp.correction_started)
 restored.local_repair!.candidate_hash='tampered';assert.throws(()=>remainingSourceMapLocalRepair(restored,f.passages),/身份不一致/)
})


test('historical pagination checkpoints fail closed on changed contracts without touching completed state',async()=>{
 const f=fixture(),checkpoint:any={pages:{steps:{'source-map:pages':{input_hash:'historical-page-input',value:{items:[],complete:false,page_size:8}}}}}
 const before=JSON.stringify(checkpoint)
 await assert.rejects(generateSourceMapOutput('old paged input',f.passages,async()=>assert.fail('no upgraded paid request'),{signal:signal(),checkpoint,persist:()=>{}}),/分页契约已变化/)
 assert.equal(JSON.stringify(checkpoint),before)
})
