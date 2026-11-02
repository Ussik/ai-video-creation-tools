import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const root = '/Users/caoyanzu/workspace/ai-video-creation-tools/production/2026-11-01-nuowang-trailer';
const projectId = 'fd9cde8183ef4fa7a678d19168d899a8';
const style = '无畏契约风格化3D动画，美式卡通渲染，半写实人物，硬表面块面清晰，手绘笔触与细微颗粒，锐利轮廓光，低饱和青灰环境与高饱和赤红、雷金、水青点睛，精致电影游戏宣传片品质。架空当代中国，不是古代仙侠，不用照片真人，不用日漫平面。';
const boards = [
  { key: 'hero', title: '预告专用｜许小满与岳沉戈', refs: ['d5b396899ff74896934ff7265b4d7086'], prompt: `${style} 制作一张横版16:9角色一致性参考图，新创作两个明确独立角色的设定，互不融合。左侧许小满：十六岁中国少年，偏瘦，黑色短碎发，灵动真诚的眼睛，深炭灰现代短夹克与短衣，红束带打着不正的结，深色长裤、轻便布靴；腰间布袋露出旧牙白底朱红纹傩面的一角；手握长枪裂关。面具是覆盖上半脸和鼻梁的木胎旧漆傩面，窄长眼孔，无嘴孔，赤纹从眉心分向两颊；此时完整未开长裂。右侧岳沉戈：形象三十余岁的中国古代战将灵，沉稳严肃，玄黑甲、赤缨，硬表面大甲片，身后残破将旗，长枪裂关，留短须，厚重而守护的气质，身躯可略高于少年。一个是活人少年，一个是七百年战将之灵，两人并肩的搭档感，绝非同一个角色换装。中性深灰背景，主体占画面80%，左半少年全身及脸部近景，右半将军全身及脸部近景，下方小幅表现面具正面与长枪细节。仅角色参考，不画故事场景，不加入其他人物，不画标题、注释、字幕、水印。参考图仅用于既定渲染画风与傩面物件气质，不复制场景板版式。` },
  { key: 'rival', title: '预告专用｜沈照夜与玄震', refs: ['d5b396899ff74896934ff7265b4d7086'], prompt: `${style} 一张16:9横版双角色一致性参考图。左半是沈照夜，二十四岁中国青年，高而松的修长身形，乌黑长发束成低马尾，温和从容干净面容，白色现代改良长衣配玄黑纹样、深色长裤与靴子，腰侧悬小型青铜雷鼓惊蛰，手指可以叩击鼓面，深赤傩面收在腰侧；表情温柔，不邪笑不疯癫，白衣不沾灰。他是实力压倒性的师兄，但不用怒吼表现。右半是他的契神玄震，青铜巨面与角冠，准确四条手臂，巨大身体由黑云和金色雷络构成，背后一个清楚完整的环形金色雷轮；远古雷神的沉默压迫感。青年在前、雷神远在其身后，有巨大尺度差异，绝不把人脸画成青铜。小幅细节展示腰侧小铜鼓、青年面部、深赤傩面，保持角色可辨认。深灰中性背景，设定图无剧情胜负，绝不出现王冠、王座、伤亡或被附身状态。不画任何字、字幕、水印。参考只取统一3D材质与色彩。` },
  { key: 'team', title: '预告专用｜陆承钧与林听澜', refs: ['d5b396899ff74896934ff7265b4d7086'], prompt: `${style} 横版16:9双人角色参考图。左半陆承钧：十七岁中国少年，肩背厚实、站姿端正、黑色短发，骄傲但不恶毒，黑金兽面，长戟，厚重块面山铠，黑金点睛；身后伏岳只是淡淡轮廓，青铜甲巨人、关节嵌岩、脚下带土。右半林听澜：十六岁中国少女，黑发高束马尾，明亮直率有主动性，青白水纹半面，轻便青灰与水青现代改良战斗短衣、长裤、结实短靴，双短刃握法清楚，水青点睛；她旁边一条细长优雅的年轻赤螭龙灵，水流构成身体，额有暗红细纹，不是西方龙，不长翅膀。两个少年是平等竞争伙伴，各自明确独立，两个角色大小接近，正面全身与面部小近景各一个，武器细节小样。不加入主角许小满，不要角色融合，武器不能互换，无文字、水印、标志，不性感化。中性深灰背景。` }
];

export async function createProduction(page) {
  async function api(path, body, method='POST') {
    const response = await page.fetch(path,{method,headers:{'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body),timeout:30000});
    if(!response.ok) throw new Error(`${path}: ${response.status} ${response.body}`);
    return JSON.parse(response.body);
  }
  const old = JSON.parse(await fs.readFile(root+'/reference/canvases-before.json','utf8'));
  for(const c of old){const response=await page.fetch(`/api/projects/${projectId}/canvases/${c.id}`);await fs.writeFile(root+`/reference/canvas-${c.id}-before.json`,response.body);}
  const canvas=await api(`/api/projects/${projectId}/canvases`,{name:'傩王｜90秒预告·鼓起人间'});
  const state={projectId,canvas,boards:[],createdAt:new Date().toISOString()};
  await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));
  for(const b of boards){
    const body={model_id:'95dd1fbd5aa544c0befebcfdef8497cc',shot_id:null,source_artifact_type:'character',prompt:b.prompt,mode:'reference',reference_asset_ids:b.refs,explicit_reference_asset_ids:b.refs,ratio:'16:9',generate_audio:false};
    const preview=await api(`/api/projects/${projectId}/generate/preview`,body);
    await fs.writeFile(root+`/reference/${b.key}-image-preview.json`,JSON.stringify(preview,null,2));
    const job=await api(`/api/projects/${projectId}/generate`,body);
    state.boards.push({...b,body,job});await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));
    console.log(JSON.stringify({stage:'reference',key:b.key,job}));
  }
  console.log(JSON.stringify({canvas}));
}
