import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isVideoAudioPlan, recoverVideoAudioPlanSourceText, renderVideoAudioPlan, videoAudioPlanSourceIssue, type VideoAudioPlan } from '../../packages/shared/src/media/video-prompt-audio.js'

const line = '刘叔，这两天自来水管没洗吧？煮出来的汤底，隐隐带着股烂鱼死水腥泥味。'
const passage = `嘴唇微动沉声开口，声音平稳而带着洞察感：“${line}”`
const plan = (): VideoAudioPlan => ({ version: 1, speech: [{ speaker: '许知夜', text: line, delivery: '平稳而带着洞察感',
  mode: 'dialogue', source_text: passage }], sound_effects: ['雨声与锅内沸水声'], music: '', silent: false })

test('structured dialogue renders every exact line without parsing the source wording', () => {
  const audio = plan(), rendered = renderVideoAudioPlan(audio)
  assert.ok(isVideoAudioPlan(audio))
  assert.match(rendered, /声音执行仅依据本结构化计划/)
  assert.ok(rendered.includes(line))
  assert.match(rendered, /说话者：许知夜/)
  assert.match(rendered, /口型自然同步/)
  assert.match(rendered, /雨声与锅内沸水声/)
  assert.doesNotMatch(rendered, /嘴唇微动|沉声开口/)
  assert.equal(videoAudioPlanSourceIssue(audio, [`许知夜用纸巾擦嘴。${passage}眼眸变冷。`]), null)
})

test('offscreen voice and unconventional unquoted wording use the same explicit contract', () => {
  const audio = plan()
  audio.speech = [{ speaker: '许知夜', text: '八块，放桌上了。', delivery: '低沉平淡', mode: 'voiceover',
    source_text: '他的声线留在雨棚下：八块，放桌上了。' }]
  assert.equal(videoAudioPlanSourceIssue(audio, [audio.speech[0]!.source_text]), null)
  const rendered = renderVideoAudioPlan(audio)
  assert.match(rendered, /画外人声/)
  assert.match(rendered, /八块，放桌上了。/)
  assert.doesNotMatch(rendered, /口型自然同步/)
})

test('unknown legacy data cannot become a silent plan and contradictory silence is invalid', () => {
  for (const value of [undefined, null, {}, { ...plan(), version: 2 }, { ...plan(), silent: true },
    { ...plan(), speech: [{ ...plan().speech[0], source_text: '' }] }]) assert.equal(isVideoAudioPlan(value), false)
  const silent: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  assert.ok(isVideoAudioPlan(silent))
  assert.match(renderVideoAudioPlan(silent), /全程静音/)
  const ambience = { ...silent, silent: false, sound_effects: ['雨声'] }
  assert.ok(isVideoAudioPlan(ambience))
  assert.match(renderVideoAudioPlan(ambience), /没有人物对白或旁白/)
  assert.match(renderVideoAudioPlan(ambience), /雨声/)
})

test('source evidence rejects invented or rewritten dialogue by exact containment', () => {
  const audio = plan()
  assert.match(videoAudioPlanSourceIssue(audio, ['本镜没有这一句话。']) || '', /来源摘录不在/)
  audio.speech[0]!.text = '模型自行补写的新台词。'
  assert.match(videoAudioPlanSourceIssue(audio, [passage]) || '', /必须逐字包含/)
})

test('source recovery restores the reported punctuation copy error before strict validation without mutating the candidate', () => {
  const original = '先生，签下名字……这辈子就别想搬走。'
  const source = `房东太太（阴笑）：${original}`
  const audio = plan()
  audio.speech = [{ ...audio.speech[0]!, speaker: '房东太太', text: original.replace('，', ','), source_text: source }]
  const before = structuredClone(audio)
  const recovered = recoverVideoAudioPlanSourceText(audio, [`灯泡摇晃。${source}租约向前推。`])
  assert.notEqual(recovered, audio)
  assert.notEqual(recovered.speech, audio.speech)
  assert.equal(recovered.speech[0]!.text, original)
  assert.equal(recovered.speech[0]!.source_text, source)
  assert.equal(videoAudioPlanSourceIssue(recovered, [source]), null)
  assert.deepEqual(audio, before)
})

test('source recovery only equates the supported punctuation widths in either direction', () => {
  for (const [original, candidate] of [
    ['甲，乙：丙；丁？戊！', '甲,乙:丙;丁?戊!'],
    ['甲,乙:丙;丁?戊!', '甲，乙：丙；丁？戊！'],
  ]) {
    const audio = plan(), source = `人物：${original}`
    audio.speech = [{ ...audio.speech[0]!, text: candidate!, source_text: source }]
    const recovered = recoverVideoAudioPlanSourceText(audio, [source])
    assert.equal(recovered.speech[0]!.text, original)
    assert.equal(videoAudioPlanSourceIssue(recovered, [source]), null)
  }
})

test('source recovery retains exact speech even when another width variant exists in the same source', () => {
  const audio = plan(), source = '甲：别走,听我说。乙：别走，听我说。'
  audio.speech = [{ ...audio.speech[0]!, text: '别走,听我说。', source_text: source }]
  assert.deepEqual(recoverVideoAudioPlanSourceText(audio, [source]), audio)
})

test('source recovery refuses absent, fabricated, or ambiguous evidence', () => {
  const audio = plan(), original = '先生，签下名字。', source = `房东太太：${original}`
  audio.speech = [{ ...audio.speech[0]!, text: '先生,签下名字。', source_text: source }]
  for (const sources of [[], ['完全不同的来源'], [source.replace('房东太太', '房东')]]) {
    assert.deepEqual(recoverVideoAudioPlanSourceText(audio, sources), audio)
  }
  audio.speech[0]!.source_text = `${source}她又重复：${original}`
  assert.deepEqual(recoverVideoAudioPlanSourceText(audio, [audio.speech[0]!.source_text]), audio)
})

test('source recovery does not normalize wording, spaces, quotes, full stops, or punctuation meaning', () => {
  const audio = plan(), source = '房东太太：先生，签下名字……这辈子就别想搬走。'
  for (const candidate of [
    '先生,签下名字……这辈子别想搬走。',
    '先生, 签下名字……这辈子就别想搬走。',
    '“先生,签下名字……这辈子就别想搬走。”',
    '先生,签下名字……这辈子就别想搬走.',
    '先生,签下名字......这辈子就别想搬走。',
    '先生?签下名字……这辈子就别想搬走。',
  ]) {
    audio.speech = [{ ...audio.speech[0]!, text: candidate, source_text: source }]
    const recovered = recoverVideoAudioPlanSourceText(audio, [source])
    assert.deepEqual(recovered, audio)
    assert.match(videoAudioPlanSourceIssue(recovered, [source]) || '', /必须逐字包含/)
  }
})

test('scene ambience and timeline music preserve dialogue without requesting generated music', () => {
  const audio = plan()
  audio.scene_sound = { ambience: ['列车车轮持续碾过铁轨', '车窗外的暴雨'], acoustics: '狭窄金属车厢，雨声隔着玻璃', music_policy: 'timeline' }
  audio.ambience_change = '广播在此进入，车轮与雨声继续，不因切为特写而停止'
  audio.sound_effects = ['纸条在双手间摩擦']
  audio.music = '从低音脉冲逐渐进入铜磬'
  assert.ok(isVideoAudioPlan(audio))
  const rendered = renderVideoAudioPlan(audio)
  assert.ok(rendered.includes(line))
  assert.match(rendered, /口型自然同步/)
  assert.match(rendered, /共同环境底声（跨镜延续）：列车车轮/)
  assert.match(rendered, /本场空间声学：狭窄金属车厢/)
  assert.match(rendered, /本镜环境变化.*广播在此进入/)
  assert.match(rendered, /本镜事件音效：纸条/)
  assert.match(rendered, /本镜不生成背景配乐，保留对白、旁白、环境底声与事件音效/)
  assert.match(rendered, /时间线配乐意图.*从低音脉冲逐渐进入铜磬/)
  assert.match(rendered, /正文中的音乐进入、增强或切换只表示成片配乐意图/)
  assert.doesNotMatch(rendered, /^配乐：/m)
})

test('explicit source music and legacy plans retain their accepted behavior', () => {
  const sourceMusic = { ...plan(), music: '车厢收音机里传来的旧歌', scene_sound: { ambience: ['列车运行'], acoustics: '', music_policy: 'source' as const } }
  assert.match(renderVideoAudioPlan(sourceMusic), /^配乐：车厢收音机/m)
  assert.doesNotMatch(renderVideoAudioPlan(sourceMusic), /本镜不生成背景配乐/)
  const legacy = { ...plan(), music: '已接受的原声配乐' }
  assert.match(renderVideoAudioPlan(legacy), /^配乐：已接受的原声配乐/m)
  assert.match(renderVideoAudioPlan(legacy), /音效与环境声：雨声与锅内沸水声/)
})

test('scene sound contracts reject corrupt data and silence overrides contextual ambience', () => {
  for (const sound of [null, {}, { ambience: [''], acoustics: '', music_policy: 'timeline' },
    { ambience: [], acoustics: '', music_policy: 'guess' }, { ambience: [], acoustics: '', music_policy: 'timeline', speech: [] }]) {
    assert.equal(isVideoAudioPlan({ ...plan(), scene_sound: sound }), false)
  }
  assert.equal(isVideoAudioPlan({ ...plan(), ambience_change: 1 }), false)
  const silent: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true,
    scene_sound: { ambience: ['列车运行'], acoustics: '', music_policy: 'timeline' } }
  assert.ok(isVideoAudioPlan(silent))
  assert.match(renderVideoAudioPlan(silent), /全程静音/)
  assert.doesNotMatch(renderVideoAudioPlan(silent), /列车运行/)
})
