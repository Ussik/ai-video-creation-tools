import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const root='/Users/caoyanzu/workspace/ai-video-creation-tools/production/2026-11-01-nuowang-trailer';
export const style='横版16:9，保持项目既定的无畏契约风格化3D动画，清晰硬表面块面、半写实角色、美式卡通渲染、手绘颗粒、锐利轮廓光。低饱和青灰与旧木褐环境，赤红、水青、雷金是控制得当的点睛色。架空当代中国，保留现代旧镇、路灯与工地，不要把全片变成古代仙侠。每一镜必须是一幅完整电影画面，不要复制参考图的拼版、设定图版式、标签或重复人物。无字幕、无片名、无水印，无可读文字。角色只按对应参考图身份取用，不交叉融合。音轨只要自然环境、清晰动作音和克制的氛围声，不要对白、不唱歌，不生成音乐。运镜有惯性、人物动作有重量，避免静态幻灯片。';
export const clips=[
 {key:'01',title:'01｜旧面初鸣',refs:['hero','d5b396899ff74896934ff7265b4d7086','81ed45bc64324b908ddd8f73c64b4c88'],prompt:'15秒悬念开场，三次有逻辑的剪切。0-5秒：夜间许门祠堂藏面阁，极近景是旧铜香炉中满到边的灰、旁边木盘恰好三个果子两新一瘪，镜头低位沿三面供架推向北墙最深处，普通面具前都有香灰。空间近方形约4米、能容两人通过，低木门的微弱暖光是唯一可见入光，不增加窗户、月亮或吊灯。5-10秒：切旧牙白底赤纹旧面特写，只有它的供格台面空净、没有香灰没有供果；旧面自行轻震，薄尘落下，暗红纹像浸水一样逐段亮起，红色反光克制。10-15秒：匹配切到柏岭镇现代旧街的少年许小满，深色短衣、红束带，手里拿着一个供果，原本松散地朝空无一人的门口轻轻点头，突然听见地下鼓音，转头望向祠堂，脸上由轻松转为好奇；面具不戴、没有神降。环境细节有电线、路灯和暖色住户窗口。声音从夜虫、尘埃细响渐入地下的三声低鼓。'},
 {key:'02',title:'02｜少年与将军',refs:['hero','81ed45bc64324b908ddd8f73c64b4c88'],prompt:'15秒人灵相识与后续结契的预告蒙太奇，清楚的三段。0-5秒：现代镇北修路工地，远处挖掘机与黄色作业灯，湿土中半面残破旧旗，许小满蹲下，抬眼看见一列淡灰古代士卒朝祠堂方向无声行礼，不出现血腥尸骨；少年没有戴面，也不率领士卒行军。5-9秒：另一个时间段，暖色祠堂门口，玄甲赤缨的岳沉戈以人形灵体站在少年旁，少年仰脸听他说完，庄重而温暖，将军的破旗在风里轻摆。9-15秒：切到野外训练场，少年将完整白底赤纹面戴到脸上，系紧红束带，右臂才显出局部玄甲；他试探着向前刺出长枪，巨大半透明枪影短暂在其身后显现，将军在身后做一个短促的指引手势。神降严格只到右臂与半虚枪影，不能全身合相、不变成将军本人。结尾少年一个稳住脚步的低角度近景。声音旗帜、枪杆金属长音、呼吸与一步踏地。'},
 {key:'03',title:'03｜六十年一会',refs:['hero','team'],prompt:'15秒大会和伙伴的热血蒙太奇，五个明确短镜头，节奏逐渐加快。0-3秒：白日祭坛镇建立镜头，现代旧镇的庙会人潮、普通人摊位和远方巨大的石祭坛同时可见，宽阔空间、衣着混合现代日常和各地傩师，不要古代皇城。3-6秒：许小满戴白底赤纹面、右臂玄甲、完整长枪，贴地旋身突进一次，枪尖拉出赤色锋线。6-9秒：陆承钧黑金兽面、厚重山铠、长戟钝重落地，岩土抬起一条平台，伏岳的青铜巨躯轮廓在身后显出，动作慢而强。9-12秒：林听澜青白水纹面，主动双刃跃击，水流从脚下改变落点，细长无翼水龙赤螭绕过她的身侧。12-15秒：三人站在同一场地的三个方向，互相打量，少年挑战和竞争的气质；以一条快速环绕运镜收束，表现三个人都想赢，不给出比赛胜负。每次只表演一个主动作，兵器不能换人。声音枪风、石台轰声、双刃划水、远处人群的欢呼。'},
 {key:'04',title:'04｜温柔与雷威',refs:['hero','rival'],prompt:'15秒师兄的温柔与绝对实力对照。0-5秒：祭坛镇场边的静处，许小满没戴面；白衣玄纹的沈照夜温和地把一颗糖放到少年掌心，近景交代两双手与糖；切小满望着师兄的安心微笑，沈照夜腰侧深赤面与青铜小雷鼓可辨。5-8秒：师兄把完整未破的旧面递回给他，低头淡淡一笑，不说话，白衣没有被污损；温暖柔和的反光。8-11秒：切沈照夜指节在腰侧小青铜鼓惊蛰上只叩一下，镜头轻快拉远，天上先出现一角巨大金色雷轮。11-15秒：一道精准金色落雷击中远处无人的失控能量柱，地面裂纹瞬间停住，没有误伤观众；师兄几乎不移动，黑云雷光中仅露玄震的青铜角冠巨面与四臂局部，不能全程张牙舞爪。最后半秒回到小满抬头，笑意收住、认识到差距。仅保留糖纸、衣袖、一声铜鼓、先静后雷的巨大动态。'},
 {key:'05',title:'05｜每个愿望都有归处',refs:['hero','team','rival'],prompt:'15秒预告概念蒙太奇，表达保护普通人和队伍磨合，不对应一场新编完整比赛，不给出胜负或谜底。0-4秒：现代祭坛镇夜市，普通父母把小孩从人潮里抱起，暖灯下有人收拾摊位，许小满停下来望向他们，手里攥着那颗糖，镜头让普通人有温暖具体面孔。4-8秒：切到早期训练场三人磨合，林听澜先挥刃打开一道青白水路，陆承钧以长戟抬起岩台，许小满沿水路踏上岩台，右臂玄甲持完整长枪跃起，动作路线连续且只有一次协作，不生成超出早期阶段的完整神相。8-11秒：旧街门口空着的一双鞋，门扇轻动，暖灯还亮着；不出现人物消散、死亡或复活，不揭秘机制。11-15秒：清浅石渠边的远距离双人构图，许小满一岸，沈照夜另一岸，师兄仍然温和，少年想开口又止住，水流从中间穿过。声音从夜市温暖环境到训练动作、再到鞋边的空风和渠水；不说对白。'},
 {key:'06',title:'06｜追上最想留住的人',refs:['hero','team','rival'],prompt:'15秒高燃预告高潮，悬停在选择之前，绝不展示终局、王冠、成王、师兄败北或任何死亡。0-4秒：许小满戴完整白底赤纹面，深色短衣红束带，只右臂玄甲，双手握完整长枪奔向远处雷光，镜头贴地高速跟随。4-7秒：陆承钧长戟撑起岩台、林听澜主动跃出，水龙绕过岩台打开上升的水路，三人配合互相支撑，保留伙伴独立面孔。7-11秒：天空巨大的环形金色雷轮张开，雷神玄震只在黑云中显出巨大的青铜面、角冠和准确四条手臂轮廓，白衣玄纹沈照夜静静站在远方中央，动作极少，小满和枪在这尺度面前仍显得渺小。11-14秒：低角度跟随少年从岩台起跳，巨大的半透明枪影从背后伸向天空，只有借形与枪影而非完整合相；最后反打沈照夜温和却坚定的一眼。14-15秒：枪尖与雷光即将相接前突然切入纯黑，让雷声长尾自然延伸。全程不出现输赢和新能力，不要让主角轻易击穿雷神。不生字幕片名，末尾的黑留给后期。'}
];

export async function api(page,path,body,method='POST'){
 const r=await page.fetch(path,{method,headers:{'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify(body),timeout:30000});
 if(!r.ok)throw new Error(`${r.status} ${path}: ${r.body}`);return JSON.parse(r.body);
}
export async function setupShotsAndSpeech(page){
 const state=JSON.parse(await fs.readFile(root+'/state.json','utf8'));const base='/api/projects/'+state.projectId;
 state.clips ||= [];
 for(const c of clips){if(state.clips.some(x=>x.key===c.key))continue;
  const shot=await api(page,base+'/shots',{title:'傩王90秒预告·'+c.title,prompt:c.prompt,image_prompt:'',video_prompt:style+'\n'+c.prompt,duration:15,source_scene_id:null,start_state:'独立预告新镜头，不修改原剧本场次。',end_state:'预告式悬念，胜负不揭晓。',cut_note:'仅供本次新画布90秒预告。'});
  state.clips.push({...c,shot});await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));console.log({shot:c.key,id:shot.id});
 }
 await api(page,base+'/production-range?canvas_id='+state.canvas.id,{start_shot_id:state.clips[0].shot.id,end_shot_id:state.clips.at(-1).shot.id},'PUT');
 if(!state.speech){
  const voice=await api(page,base+'/speech/voices',{name:'预告·鼓起人间·旁白',speaker:'zh_male_cixingjieshuonan_uranus_bigtts',instructions:'克制、温暖、有故事感的电影旁白，清晰普通话，短句间自然停顿，不能喊广告腔。',speech_rate:-5});
  state.speech={voice,lines:[]};await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));
 }
 const lines=[
  {key:'v1',at:2.0,text:'有些人，看得见另一个人间。'},
  {key:'v2',at:16.2,text:'一个少年。一位七百年前的将军。'},
  {key:'v3',at:31.5,text:'六十年一会。每个人，都想赢回自己的愿望。'},
  {key:'v4',at:46.0,text:'他最信任的人，也是他必须追上的人。'},
  {key:'v5',at:61.0,text:'若要守住人间，就不能放弃任何一个回家的愿望。'},
  {key:'v6',at:77.5,text:'师兄，我想带你回家。'}
 ];
 for(const l of lines){if(state.speech.lines.some(x=>x.key===l.key))continue;
  const line=await api(page,base+'/speech/lines',{voice_id:state.speech.voice.id,scene_id:null,text:l.text,instructions:l.key==='v6'?'情感真诚、压低音量，像向最亲近的人说一句郑重的请求。':'故事叙述，克制、短句、留有呼吸。',context_text:'《傩王》90秒预告独立旁白，不改变原剧本台词。少年人灵搭档、天下大会、对师兄的牵挂。'});
  const result=await api(page,base+'/speech/lines/'+line.id+'/generate',{});
  state.speech.lines.push({...l,line,job:result.job||result});await fs.writeFile(root+'/state.json',JSON.stringify(state,null,2));console.log({voice:l.key,id:line.id,jobId:(result.job||result).id});
 }
}
