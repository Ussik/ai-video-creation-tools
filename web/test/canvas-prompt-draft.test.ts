import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebasePromptDraft, videoPreferencePrompt } from '../src/features/canvas/canvas-prompt-draft'
import { visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'

test('video editing source duration does not turn a positive planning duration into a new video length instruction', () => {
  const prompt = videoPreferencePrompt('保留动作节奏，只修改衣服', 'edit', 5,
    { ratio: 'adaptive', resolution: '720p', durationFollowsSource: true })
  assert.match(prompt, /视频时长：跟随原视频/)
  assert.doesNotMatch(prompt, /5 秒|-1 秒/)
  assert.match(prompt, /保留动作节奏，只修改衣服/)
})

test('changing project style replaces stale final-prompt constraints while preserving manual creative edits and new parameters', () => {
  const oldStyle = { version: 'old', label: '日漫二维', source: 'settings' as const, details: { rendering: '赛璐璐' } }
  const nextStyle = { version: 'new', label: '水彩动画', source: 'settings' as const, details: { rendering: '水彩笔触' } }
  const previous = withProjectStyle('怀表特写\n画面比例：9:16', oldStyle)
  const edited = previous.replace('怀表特写', '手掌握紧怀表，镜头缓慢推进').replace('画风：日漫二维', '画风：用户试改的旧画风')
  const next = withProjectStyle('怀表特写\n画面比例：16:9', nextStyle)
  const current = withProjectStyle(rebasePromptDraft(previous, edited, next), nextStyle)
  assert.match(current, /手掌握紧怀表，镜头缓慢推进/)
  assert.match(current, /画面比例：16:9/)
  assert.match(current, /水彩动画|水彩笔触/)
  assert.doesNotMatch(current, /日漫二维|用户试改的旧画风|赛璐璐/)
  assert.equal(current.split('【项目画风约束】').length, 2)
  assert.equal(withProjectStyle(current, nextStyle), current)
})

test('legacy shots get distinct static and temporal prompts, while explicit shot prompts remain intact', () => {
  const shot = { prompt: '角色坐起', start_state: '躺在床上', end_state: '站到窗前', cut_note: '接窗外夜景' }
  assert.match(shotImagePrompt(shot), /单幅首帧/)
  assert.match(shotImagePrompt(shot), /躺在床上/)
  assert.doesNotMatch(shotImagePrompt(shot), /站到窗前|接窗外/)
  assert.match(shotVideoPrompt(shot), /连续视频镜头/)
  assert.match(shotVideoPrompt(shot), /站到窗前/)
  assert.match(shotVideoPrompt(shot), /接窗外夜景/)
  assert.equal(shotImagePrompt({ ...shot, image_prompt: '自定义静态构图' }), '自定义静态构图')
  const temporal = shotVideoPrompt({ ...shot, video_prompt: '自定义动作节奏' })
  assert.ok(temporal.startsWith('自定义动作节奏\n\n'))
  assert.match(temporal, /开镜状态：躺在床上/)
  assert.match(temporal, /收镜状态：站到窗前/)
  assert.match(temporal, /接镜要求：接窗外夜景/)
  assert.equal(shotVideoPrompt({ prompt: '', video_prompt: '自定义动作节奏' }), '自定义动作节奏')
})

test('authored video prose keeps one current boundary block across imports and state edits', () => {
  const shot = { prompt: '走向门口', video_prompt: '手持跟拍，从人物身后停在门槛。',
    start_state: '人物左手持灯站在桌边', end_state: '右脚踏至门槛，左手仍持灯', cut_note: '右脚落地时切门外侧面，保持向右运动' }
  const composed = shotVideoPrompt(shot)
  assert.ok(composed.startsWith(shot.video_prompt))
  assert.equal(shotVideoPrompt({ ...shot, video_prompt: composed }), composed)
  const updated = shotVideoPrompt({ ...shot, video_prompt: composed, end_state: '停在门内，不跨门槛' })
  assert.ok(updated.startsWith(shot.video_prompt), 'authored camera prose remains available for review')
  assert.match(updated, /正文中旧状态与此冲突时以本区块为准/)
  assert.match(updated, /收镜状态：停在门内，不跨门槛/)
  assert.doesNotMatch(updated, /右脚踏至门槛，左手仍持灯/)
  assert.equal(updated.split('【镜头起止与接镜约束】').length, 2)
  assert.equal(shotVideoPrompt({ ...shot, video_prompt: updated, start_state: '', end_state: '', cut_note: '' }), shot.video_prompt)
})

test('editing the full prompt survives reload and independent parameter and reference changes', () => {
  const old = '近景\n\n【图片生成要求】\n画面比例：9:16\n画质要求：标准\n\n【镜头视觉设定】\n人物：林晚\n蓝色衣服'
  const draft = old.replace('近景', '特写，保留眼神细节').replace('蓝色衣服', '深蓝外套')
  assert.equal(rebasePromptDraft(old, draft, old), draft)
  const next = old.replace('9:16', '16:9').replace('标准', '高画质') + '\n\n道具：旧钥匙'
  const merged = rebasePromptDraft(old, draft, next)
  assert.match(merged, /特写，保留眼神细节/)
  assert.match(merged, /深蓝外套/)
  assert.match(merged, /画面比例：16:9/)
  assert.match(merged, /画质要求：高画质/)
  assert.match(merged, /道具：旧钥匙/)
  assert.equal(merged.split('【图片生成要求】').length - 1, 1)
  assert.equal(merged.split('【镜头视觉设定】').length - 1, 1)
  assert.equal(rebasePromptDraft(next, merged, next), merged)
})

test('simultaneous manual and automatic additions survive and a broad rewrite keeps its prose when controls change', () => {
  const previous = '镜头\n画面比例：9:16'
  const manual = previous + '\n暖色逆光'
  assert.equal(rebasePromptDraft(previous, manual, previous + '\n人物：林晚'), previous + '\n暖色逆光\n人物：林晚')
  assert.equal(rebasePromptDraft(previous, manual, manual), manual)
  const rewritten = '全新的动作描述\n画面比例：自定义\n强调手部表情'
  const next = previous.replace('9:16', '16:9')
  assert.equal(rebasePromptDraft(previous, rewritten, next), '全新的动作描述\n画面比例：16:9\n强调手部表情')
})

test('video requirements and visual context are explicit and keyframe mode does not number unused information boards', () => {
  const base = videoPreferencePrompt('缓慢坐起，镜头推近', 'first_frame', 6)
  const binding = { kind: 'character' as const, name: '林晚', variant: '常服', revision: 2, definition: '深蓝外套', view_requirements: '侧面', board_asset_id: 'board' }
  const full = visualGenerationPrompt(base, [binding], ['frame'], 'keyframe', { mode: 'first_frame' })
  assert.match(full, /视频时长：6 秒/)
  assert.match(full, /首帧要求/)
  assert.match(full, /深蓝外套/)
  assert.doesNotMatch(full, /参考图 0|参考图 1/)
  assert.match(visualGenerationPrompt('画面', [binding], ['frame', 'board'], 'profiles'), /参考图 2/)
})

test('video ratio and clarity selections update final requirements without discarding manual prose', () => {
  const previous = videoPreferencePrompt('缓慢坐起，镜头推近', 'first_frame', 6, { ratio: 'adaptive', resolution: '480p' })
  const next = videoPreferencePrompt('缓慢坐起，镜头推近', 'first_frame', 6, { ratio: '16:9', resolution: '4k' })
  const edited = previous.replace('缓慢坐起，镜头推近', '保留我修改的动作，先抬手再坐起')
  const merged = rebasePromptDraft(previous, edited, next)
  assert.match(merged, /保留我修改的动作/)
  assert.match(merged, /画面比例：16:9/)
  assert.match(merged, /清晰度要求：4K/)
  assert.match(merged, /在所选画幅下安排构图/)
  assert.doesNotMatch(merged, /画面比例：自适应|清晰度要求：480p/)
  assert.match(videoPreferencePrompt('运镜', 'text', 5, { ratio: '9:16', resolution: '1080p' }), /画面比例：9:16/)
})

test('video reference mapping is rebuilt from submitted images after a broad manual edit or strategy change', async () => {
  const { synchronizeVideoReferencePrompt } = await import('@video-studio/shared/visuals/visual-prompt')
  const bindings = [
    { kind: 'character' as const, profile_id: 'person', name: '林晚', variant: '校服', revision: 1, definition: '短发', view_requirements: '三视图', board_asset_id: 'person-board', required: true },
    { kind: 'prop' as const, profile_id: 'prop', name: '书包', variant: '蓝色', revision: 1, definition: '蓝色书包', view_requirements: '细节', board_asset_id: 'prop-board', required: false },
  ]
  const options = { mode: 'reference', storyboard_reference_asset_id: 'shot-picture' }
  const old = visualGenerationPrompt('林晚缓慢转身', bindings, ['shot-picture', 'person-board', 'prop-board'], 'profiles', options)
  const edited = `只做一次回头，保持固定机位。\n${old}`
  const next = visualGenerationPrompt('林晚缓慢转身', bindings, ['shot-picture', 'person-board'], 'profiles', options)
  const rebased = rebasePromptDraft(old, edited, next)
  const final = synchronizeVideoReferencePrompt(rebased, bindings, ['shot-picture', 'person-board'], 'profiles', options)
  assert.match(final, /只做一次回头，保持固定机位/)
  assert.match(final, /图片1：分镜构图/)
  assert.match(final, /图片2：林晚/)
  assert.doesNotMatch(final, /图片3：/)
  assert.equal((final.match(/【视频参考图用途】/g) || []).length, 1)
  const firstFrame = synchronizeVideoReferencePrompt(final, bindings, ['shot-picture'], 'keyframe', { mode: 'first_frame' })
  assert.match(firstFrame, /只做一次回头/)
  assert.doesNotMatch(firstFrame, /【视频参考图用途】/)
})
