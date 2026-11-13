import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildStoryboardDirectingReviewContext, composeDirectedShot, directingSceneSchema, directingShotSchema,
  storyboardDirectingInstructions, storyboardDirectingReviewPrompt, validateStoryboardDirectingReview,
  type StoryboardDirectingReview,
} from '../src/modules/storyboard/storyboard-directing.js'

const scene = directingSceneSchema.parse({ anchors: '门在北墙，桌在门内两米处', blocking: '甲在桌西侧，乙在桌东侧；甲本镜走到门边',
  axis: '甲乙连线为轴，摄影机始终位于南侧，甲向画面右侧走', dramatic_progression: '先看甲决定离开，再给乙的反应',
  sound: { ambience: [], acoustics: '', music_policy: 'timeline' } })
const directing = directingShotSchema.parse({ purpose: '让观众看清甲选择离开',
  camera: { movement: '横移跟拍', start_frame: '平视中景，甲在画面左侧，门在右后景', trigger: '甲迈步后跟随，在甲停步时停机',
    path: '向右横移两米，保持甲的头肩在画面左侧，匀速跟随', end_frame: '平视中景，甲停在门边，门占右后景', motivation: '保持选择离开的动作与出口关系可读' },
  cut: { type: 'reaction', cut_moment: '甲停在门边，抬眼等待乙回答', carry_over: '切乙近景，乙仍在桌东侧，看向画外甲，甲不重新走一遍', reason: '看见乙如何承受甲离开的决定' } })
function shot() {
  return { shot_id: 'kept-id', title: '甲离开', prompt: '甲从桌边走到门口。', image_prompt: '甲站在桌西侧，平视中景。',
    video_prompt: '甲走向门边，停步等待。', duration: 5, start_state: '甲站在桌西侧', end_state: '甲停在门边', cut_note: '保留乙的画外回应。',
    audio_plan: { version: 1, speech: [{ text: '别走。' }], silent: false }, directing: structuredClone(directing) }
}

test('directing compilation carries motivated camera and exact cut states into existing production fields', () => {
  const source = shot(), original = structuredClone(source)
  const result = composeDirectedShot(source, scene)
  assert.deepEqual(source, original, 'compilation must not edit the generative source object')
  assert.equal('directing' in result, false, 'planning-only metadata must not leak into strict commit contracts')
  assert.equal(result.shot_id, source.shot_id)
  assert.equal(result.start_state, source.start_state); assert.equal(result.end_state, source.end_state)
  assert.deepEqual(result.audio_plan, { ...source.audio_plan, scene_sound: scene.sound })
  assert.deepEqual(result.continuity_plan, { version: 1, status: 'accepted', scene, shot: directing })
  assert.ok(result.prompt.startsWith(source.prompt)); assert.match(result.prompt, /甲乙连线为轴/)
  assert.ok(result.image_prompt.startsWith(source.image_prompt)); assert.match(result.image_prompt, /开|平视中景/)
  assert.match(result.image_prompt, /画外人物.*不得提前进入/)
  assert.doesNotMatch(result.image_prompt, /向右横移两米/, 'motion must not be turned into a frozen-frame instruction')
  for (const value of [directing.camera.movement, directing.camera.trigger, directing.camera.path, directing.camera.end_frame,
    directing.camera.motivation]) {
    assert.ok(result.video_prompt.includes(value), value)
  }
  assert.ok(result.cut_note.startsWith(source.cut_note)); assert.match(result.cut_note, /剪辑类型：反应镜头/)
  for (const value of [directing.cut.cut_moment, directing.cut.carry_over]) assert.ok(result.cut_note.includes(value), value)
  assert.doesNotMatch(result.video_prompt, /本镜时长：|开始状态：|结束状态：|上一镜「|下一镜「/)
  assert.ok(!result.video_prompt.includes(directing.cut.carry_over), 'cut decisions must have one editable canonical field')
  assert.match(result.video_prompt, /切点与交接以当前接镜要求为准/)
  assert.match(result.video_prompt, /只生成本镜.*不补入相邻镜台词/)
})

test('directing composition rejects oversized contracts instead of dropping camera or source facts', () => {
  const source = shot()
  for (const [field, length] of [['prompt', 10000], ['image_prompt', 20000], ['video_prompt', 20000], ['cut_note', 2000]] as const) {
    assert.throws(() => composeDirectedShot({ ...source, [field]: '原'.repeat(length) }, scene), error => {
      assert.equal((error as { statusCode: number }).statusCode, 422)
      assert.match((error as Error).message, /合计超过/)
      return true
    })
  }
})

test('replanning replaces complete directing blocks while retaining user prose before and after them', () => {
  const original = shot(), first = composeDirectedShot(original, scene)
  const edited = { ...first, directing: structuredClone(original.directing) }
  edited.directing.purpose = '让观众先观察出口已经关闭'
  edited.directing.camera.start_frame = '新开镜构图：甲在前景，关闭的门在后景'
  edited.directing.camera.movement = '固定观察'
  edited.directing.camera.path = '新路径：摄影机不动，留住门与人物的空间关系'
  edited.directing.camera.end_frame = '新收镜构图：甲抬眼，门仍在后景'
  edited.directing.cut.cut_moment = '新切点：甲的视线落到门锁'
  edited.directing.cut.carry_over = '新交接：门锁保持闭合，下一镜给锁舌细节'
  const nextScene = { ...scene, anchors: '新的空间锚点：门在东墙，桌在门西边', axis: '新的摄影工作侧：出口轴线南侧' }
  const headings = { prompt: '场景调度与镜头职责', image_prompt: '本镜首帧构图约束', video_prompt: '本镜摄影设计', cut_note: '本镜剪辑设计' }
  for (const field of Object.keys(headings) as Array<keyof typeof headings>) {
    const heading = headings[field]
    edited[field] = `用户前言：保持克制。\n${edited[field]}\n【${heading}】\n额外重复旧规则\n【${heading}结束】\n用户后记：保留画外声。`
  }
  const result = composeDirectedShot(edited, nextScene)
  for (const field of Object.keys(headings) as Array<keyof typeof headings>) {
    assert.ok(result[field].startsWith('用户前言：保持克制。\n'))
    assert.ok(result[field].endsWith('\n用户后记：保留画外声。'))
    assert.ok(result[field].includes(original[field]), 'original authored text must survive replacement')
    assert.equal(result[field].split(`【${headings[field]}】`).length - 1, 1)
    assert.doesNotMatch(result[field], /额外重复旧规则/)
  }
  assert.ok(result.prompt.includes(nextScene.anchors)); assert.ok(!result.prompt.includes(scene.anchors))
  assert.ok(result.image_prompt.includes(edited.directing.camera.start_frame))
  assert.ok(!result.image_prompt.includes(original.directing.camera.start_frame))
  assert.ok(result.video_prompt.includes(edited.directing.camera.path)); assert.ok(!result.video_prompt.includes(original.directing.camera.path))
  assert.ok(result.cut_note.includes(edited.directing.cut.carry_over)); assert.ok(!result.cut_note.includes(original.directing.cut.carry_over))
  assert.deepEqual(composeDirectedShot({ ...result, directing: edited.directing }, nextScene), result, 'same accepted plan must compile idempotently')
})

test('compilation leaves incomplete own markers and unrelated user sections intact', () => {
  const source = { ...shot(), video_prompt: '用户正文\n【本镜摄影设计】\n尚未闭合的手写段落\n【自定义摄影】保留我的要求【自定义摄影结束】' }
  const first = composeDirectedShot(source, scene)
  const next = composeDirectedShot({ ...first, directing: source.directing }, scene)
  assert.ok(next.video_prompt.startsWith(source.video_prompt))
  assert.deepEqual(next, first)
})

function reviewIssue(patch: Partial<StoryboardDirectingReview['issues'][number]> = {}): StoryboardDirectingReview {
  return { issues: [{ code: 'action_mismatch', scene_id: 'scene-one', shot_index: 1, related_scene_id: 'scene-one', related_shot_index: 0,
    severity: 'error', message: '甲已走到门边，下一镜又从桌旁走向门口。', evidence: '前镜：甲停在门边；后镜：甲站在桌西侧。',
    repair: '后一镜从门边动作状态起，保留新机位。', ...patch }] }
}
function sequence() {
  return [{ scene_id: 'scene-one', scene_direction: scene, shots: [shot(), { ...shot(), title: '乙反应' }, shot()] },
    { scene_id: 'scene-two', scene_direction: { ...scene, dramatic_progression: '次日换场，明确时间省略。' }, shots: [shot()] }]
}

test('review context includes all camera and image designs and exactly adjacent sequence pairs', () => {
  const context = buildStoryboardDirectingReviewContext(sequence())
  assert.equal(context.scenes[0]!.shots[1]!.shot_index, 1)
  assert.equal(context.scenes[0]!.shots[0]!.directing!.camera.path, directing.camera.path)
  assert.equal(context.scenes[0]!.shots[0]!.image_prompt, shot().image_prompt)
  assert.deepEqual(context.pairs, [
    { previous: { scene_id: 'scene-one', shot_index: 0 }, current: { scene_id: 'scene-one', shot_index: 1 } },
    { previous: { scene_id: 'scene-one', shot_index: 1 }, current: { scene_id: 'scene-one', shot_index: 2 } },
    { previous: { scene_id: 'scene-one', shot_index: 2 }, current: { scene_id: 'scene-two', shot_index: 0 } },
  ])
  assert.deepEqual(validateStoryboardDirectingReview(reviewIssue(), sequence()), reviewIssue())
})

test('review rejects fabricated or nonadjacent references and half-specified related shots', () => {
  for (const patch of [
    { scene_id: 'unselected-scene' }, { shot_index: 20 }, { related_scene_id: 'unselected-scene' },
    { shot_index: 2, related_shot_index: 0 }, { related_scene_id: null },
  ]) {
    assert.throws(() => validateStoryboardDirectingReview(reviewIssue(patch), sequence()), error => {
      assert.equal((error as { statusCode: number }).statusCode, 422)
      return true
    })
  }
  assert.deepEqual(validateStoryboardDirectingReview(reviewIssue({ related_scene_id: null, related_shot_index: null }), sequence()),
    reviewIssue({ related_scene_id: null, related_shot_index: null }))
})

test('declared ellipsis and fixed cameras do not trigger mechanical continuity findings', () => {
  const planned = sequence()
  planned[0]!.shots[2]!.directing.cut.type = 'ellipsis'
  planned[1]!.shots[0]!.start_state = '次日清晨，甲已在海边，左手没有昨夜的物件。'
  planned[1]!.shots[0]!.directing.camera.movement = '固定'
  assert.deepEqual(validateStoryboardDirectingReview({ issues: [] }, planned), { issues: [] })
  assert.match(storyboardDirectingInstructions, /固定镜头是有效选择/)
  assert.match(storyboardDirectingInstructions, /video_prompt只执行本镜连续运动/)
  const prompt = storyboardDirectingReviewPrompt(buildStoryboardDirectingReviewContext(planned))
  assert.match(prompt, /明确省略或换场按其允许的变化判断/)
  assert.match(prompt, /不声称观看了未提供的图片或视频/)
  assert.match(prompt, /次日清晨/)
})
