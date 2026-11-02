import fs from 'node:fs/promises';
import {root,api} from './production-plan.mjs';
import {collect,saveCanvas} from './generate-clips.mjs';

export async function deliver(page){
 const state=await collect(page);
 const manifest=JSON.parse(await fs.readFile(root+'/edit/render-manifest.json','utf8'));
 if(manifest.duration_seconds!==90||!manifest.full_decode_passed)throw new Error('Final render has not passed delivery checks');
 for(const item of [...state.boards,...state.clips,...state.speech.lines]){
  if(!item.assetId)throw new Error('Missing production asset '+item.key);
  await api(page,'/api/assets/'+item.assetId+'/save',{});
 }
 async function upload(filePath,filename,type){
  const form=new FormData();form.append('file',new Blob([await fs.readFile(filePath)],{type}),filename);
  const result=await fetch('http://localhost:8888/api/projects/'+state.projectId+'/assets',{method:'POST',body:form});
  if(!result.ok)throw new Error(await result.text());return await result.json();
 }
 if(!state.finalAssetId){const a=await upload(manifest.file,'傩王_90秒预告_鼓起人间.mp4','video/mp4');state.finalAssetId=a.id;state.finalAsset=a;state.finalPath=manifest.file;await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));}
 if(!state.musicAssetId){const a=await upload(root+'/audio/nuowang_original_ritual_cue_90s.wav','傩王_鼓起人间_原创90秒配乐.wav','audio/wav');state.musicAssetId=a.id;state.musicAsset=a;await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));}
 await saveCanvas(page,state);
 await api(page,'/api/projects/'+state.projectId+'/canvases/'+state.canvas.id,{viewport:{x:-1320,y:530,zoom:0.8}},'PATCH');
 const meta=await page.fetch('/api/assets/'+state.finalAssetId+'/metadata');
 await fs.writeFile(root+'/reference/final-asset-metadata.json',meta.body);
 console.log({canvasId:state.canvas.id,finalAssetId:state.finalAssetId,finalUrl:'http://localhost:8888'+state.finalAsset.url,musicAssetId:state.musicAssetId,metadataStatus:meta.status,metadata:meta.body});
 return state;
}
