import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAutomaticShotVideoPrompt, shotVideoPrompt } from '../../packages/shared/src/storyboard/shot-prompts.js'
import type { VideoAudioPlan } from '../../packages/shared/src/media/video-prompt-audio.js'

const speech = '下一站还有多久？'
const plan = (): VideoAudioPlan => ({ version: 1, speech: [{ speaker: '乘客', text: speech, delivery: '平静询问',
  mode: 'dialogue', source_text: `乘客问：“${speech}”` }], sound_effects: ['右手将纸条压在桌面时轻响'], music: '战鼓渐强', silent: false,
  scene_sound: { ambience: ['列车持续运行'], acoustics: '封闭车厢，窗外雨声隔着玻璃', music_policy: 'timeline' } })
const shot = () => ({ prompt: '乘客抬眼问话', video_prompt: '乘客抬眼，宏大战歌骤然炸响。',
  start_state: '右手持纸条', end_state: '右手将纸条压在桌面', cut_note: '落纸后切对方反应', audio_plan: plan() })

test('ordinary video prompts execute confirmed speech and shared sound through one authoritative block', () => {
  const source = shot(), prompt = shotVideoPrompt(source)
  assert.ok(prompt.startsWith(source.video_prompt), 'authored prose stays intact as original intent')
  assert.ok(prompt.includes(speech))
  assert.match(prompt, /口型自然同步/)
  assert.match(prompt, /共同环境底声（跨镜延续）：列车持续运行/)
  assert.match(prompt, /空间声学：封闭车厢/)
  assert.match(prompt, /声音执行仅依据本结构化计划/)
  assert.match(prompt, /原始创作意图，不得据此额外生成或覆盖本计划/)
  assert.match(prompt, /本镜不生成背景配乐/)
  assert.match(prompt, /正文中的音乐进入、增强或切换只表示成片配乐意图/)
  assert.match(prompt, /时间线配乐意图.*战鼓渐强/)
  assert.equal(prompt.split('【镜头声音执行约束】').length, 2)
  assert.equal(shotVideoPrompt({ ...source, video_prompt: prompt }), prompt)
})

test('only complete managed sound blocks are replaced when the current saved plan changes', () => {
  const source = shot(), previous = shotVideoPrompt(source), audio = plan()
  audio.scene_sound!.ambience = ['列车停稳，保留车厢低鸣']
  audio.ambience_change = '运行声在刹停后退出'
  const next = shotVideoPrompt({ ...source, video_prompt: previous, audio_plan: audio })
  assert.match(next, /列车停稳，保留车厢低鸣/)
  assert.doesNotMatch(next, /列车持续运行/)
  assert.equal(next.split('【镜头声音执行约束】').length, 2)
  assert.ok(next.startsWith(source.video_prompt))
  assert.equal(shotVideoPrompt({ ...source, video_prompt: next, audio_plan: undefined }),
    shotVideoPrompt({ ...source, audio_plan: undefined }), 'unavailable current sound never revives an old managed plan')

  const incomplete = '作者待完善的段落\n【镜头声音执行约束】\n这里暂未闭合，保留这段创作说明。'
  const composed = shotVideoPrompt({ ...source, video_prompt: `${incomplete}\n\n${previous}` })
  assert.ok(composed.startsWith(incomplete))
  assert.ok(composed.includes(source.video_prompt))
  assert.equal(shotVideoPrompt({ ...source, video_prompt: composed }), composed)
})

test('legacy automatic prompts remain recognizable while whole-prompt manual changes stay protected', () => {
  const source = shot()
  for (const automatic of [source.video_prompt, shotVideoPrompt({ ...source, audio_plan: undefined }), shotVideoPrompt(source)]) {
    assert.equal(isAutomaticShotVideoPrompt(automatic, source), true)
    assert.equal(isAutomaticShotVideoPrompt(`${automatic}\n我增加的摄影要求：保留桌面倒影。`, source), false)
  }
  assert.equal(isAutomaticShotVideoPrompt(shotVideoPrompt(source).replace('平静询问', '低声警告'), source), false,
    'a manual edit inside the generated sound block is still a manual draft')
  assert.equal(isAutomaticShotVideoPrompt('我重新设计的动作与运镜。', source), false)

  const oldFallbackShot = { prompt: '乘客抬眼', start_state: '望向车窗', end_state: '望向对方', cut_note: '接对方反应', audio_plan: plan() }
  const oldFallback = ['生成当前分镜的一个连续视频镜头。描述动作先后、表情变化、镜头运动与节奏，保持人物、服装、道具、场景和光线连续；不要拼接无关镜头。',
    oldFallbackShot.prompt, '开镜状态：望向车窗', '收镜状态：望向对方', '接镜要求：接对方反应',
    '仅在首帧或首尾帧生成模式下，从指定首帧的构图、人物位置、姿态和物体状态开始延续动作；多图参考的开场状态按正文设计。不添加画面文字、字幕或水印。'].join('\n\n')
  assert.equal(isAutomaticShotVideoPrompt(oldFallback, oldFallbackShot), true)
})

test('unknown or partial legacy audio never becomes an inferred sound plan', () => {
  const source = shot(), noAudio = shotVideoPrompt({ ...source, audio_plan: undefined })
  for (const audio_plan of [undefined, null, {}, { speech: [{ text: speech }] }]) {
    assert.equal(shotVideoPrompt({ ...source, audio_plan }), noAudio)
  }
  const silent: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const prompt = shotVideoPrompt({ ...source, audio_plan: silent })
  assert.match(prompt, /声音执行仅依据本结构化计划/)
  assert.match(prompt, /全程静音/)
  assert.ok(prompt.startsWith(source.video_prompt))
  assert.doesNotMatch(prompt, /必须逐字生成可听见的人声|共同环境底声/)
})
