import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {root,style,api} from './production-plan.mjs';

export async function collect(page){
 const state=JSON.parse(await fs.readFile(root+'/state.json','utf8'));
 const r=await page.fetch('/api/projects/'+state.projectId);if(!r.ok)throw new Error(r.body);const p=JSON.parse(r.body);
 await fs.mkdir(root+'/media',{recursive:true});
 for(const item of [...state.boards,...(state.clips||[]),...(state.speech?.lines||[])]){
  if(!item.job)continue;const j=p.jobs.find(j=>j.id===item.job.id);item.jobStatus=j?.status;item.jobError=j?.error;
  if(j?.result_asset_id){item.assetId=j.result_asset_id;const a=p.assets.find(a=>a.id===item.assetId);const local=root+'/media/'+item.key+'-'+a.filename;
   if(!item.localPath){await page.fetch(a.url,{saveAs:local});item.localPath=local;}
  }
 }
 await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));
 return state;
}
export async function submitReady(page){
 const state=await collect(page);const base='/api/projects/'+state.projectId;
 for(const c of state.clips){if(c.job)continue;
  const refs=c.refs.map(r=>state.boards.find(b=>b.key===r)?.assetId||(/^[a-f0-9]{32}$/.test(r)?r:null));
  if(refs.some(r=>!r)){console.log({clip:c.key,waitingFor:c.refs.filter(r=>state.boards.some(b=>b.key===r&&!b.assetId))});continue;}
  const prompt=style+'\n'+c.prompt+'\n参考图的身份说明：'+c.refs.map((r,i)=>`图片${i+1}：${r==='hero'?'许小满与岳沉戈的角色外形；少年不戴面时移除脸上的面具、放回腰袋':r==='rival'?'沈照夜、腰鼓和玄震的形象；神相只取正文所述局部':r==='team'?'陆承钧、林听澜与各自契神的形象，绝不换兵器':r==='d5b396899ff74896934ff7265b4d7086'?'藏面阁空间与3D材质，只取本次镜头对应角度':'白底赤纹旧面的唯一外观，背景服从最新藏面阁空间'}`).join('。');
  const body={shot_id:c.shot.id,model_id:'fee0cb460a6a4c57bad09a6e6b81c398',prompt,mode:'reference',reference_asset_ids:refs,explicit_reference_asset_ids:refs,visual_reference_mode:'profiles',duration:15,ratio:'16:9',resolution:'720p',generate_audio:true,draft:false};
  const preview=await api(page,base+'/generate/preview',body);await fs.writeFile(root+`/reference/clip-${c.key}-preview.json`,JSON.stringify(preview,null,2));
  c.body=body;c.job=await api(page,base+'/generate',body);await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));console.log({clip:c.key,jobId:c.job.id,status:c.job.status});
 }
 await saveCanvas(page,state);
}
export async function saveCanvas(page,state){
 const path='/api/projects/'+state.projectId+'/canvases/'+state.canvas.id;
 const get=await page.fetch(path);if(!get.ok)throw new Error(get.body);const old=JSON.parse(get.body);
 function node(id,type,x,y,title,extra={}){return{id,type,x,y,width:460,height:320,title,text:'',asset_id:null,shot_id:null,model_id:null,job_id:null,prompt:'',settings:{},...extra};}
 const notes='90秒横版预告｜鼓起人间\n00–15 旧面初鸣\n15–30 少年与将军\n30–45 六十年一会\n45–60 温柔与雷威\n60–75 每个愿望都有归处\n75–90 追上最想留住的人\n\n根据项目现有第一集正文、分集、人物及创作禁区制作，人物及后续剧情取最新已保存资料。神降为早期右臂玄甲与枪影，不展示终局。新增预告镜头与素材，仅本画布使用。原画布、原镜头、旧素材、原选片均保留。\n配音：六句预告独立旁白。\n音乐：独立原创90秒仪式鼓点与拨弦主题。\n最后6秒片名与悬念收束，后期添加字幕，不要求视频模型写字。';
 const nodes=[...old.nodes.filter(n=>n.type==='project_script_ref'),node('nuowang-trailer-notes','text',0,-460,'《傩王》90秒预告 · 制作说明',{width:650,height:420,text:notes,settings:{text_mode:'write'}})];
 const edges=[];
 state.boards.forEach((b,i)=>nodes.push(node('nuowang-board-'+b.key,'generation',i*520,0,b.title,{asset_id:b.assetId||null,job_id:b.job.id,model_id:b.body.model_id,prompt:b.prompt,settings:{modality:'image',mode:'reference',ratio:'16:9',duration:5,generate_audio:false,generation_completed_job_id:b.assetId?b.job.id:undefined}})));
 state.clips.forEach((c,i)=>{
  const id='nuowang-clip-'+c.key;
  nodes.push(node(id,'generation',(i%3)*520,450+Math.floor(i/3)*430,c.title+' · '+(i*15)+'–'+((i+1)*15)+'s',{height:360,asset_id:c.assetId||null,shot_id:c.shot.id,job_id:c.job?.id||null,model_id:'fee0cb460a6a4c57bad09a6e6b81c398',prompt:c.body?.prompt||style+'\n'+c.prompt,settings:{modality:'video',mode:'reference',duration:15,ratio:'16:9',resolution:'720p',generate_audio:true,visual_reference_mode:'profiles',generation_completed_job_id:c.assetId?c.job?.id:undefined}}));
  c.refs.forEach(r=>{const b=state.boards.find(b=>b.key===r);if(b?.assetId)edges.push({id:'nw-ref-'+c.key+'-'+b.key,source:'nuowang-board-'+b.key,target:id,reference_asset_id:b.assetId});});
 });
 if(state.finalAssetId)nodes.push(node('nuowang-final-90s','video',1780,-440,'傩王｜90秒预告·鼓起人间 · 成片',{width:1000,height:640,asset_id:state.finalAssetId,text:'完整90秒｜16:9｜中文字幕、独立旁白、原创配乐。'}));
 await api(page,path,{nodes,edges,revision:old.revision},'PUT');
 console.log({canvasSaved:state.canvas.id,nodes:nodes.length,edges:edges.length});
}
