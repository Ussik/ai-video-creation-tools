import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rebasePromptDraft, videoPreferencePrompt } from '../src/canvas-prompt-draft'
import { visualGenerationPrompt } from '../../backend/src/visual-prompt'
import { shotImagePrompt, shotVideoPrompt } from '../../backend/src/shot-prompts'

test('legacy shots get distinct static and temporal prompts, while explicit shot prompts remain intact', () => {
  const shot = { prompt: '角色坐起', start_state: '躺在床上', end_state: '站到窗前', cut_note: '接窗外夜景' }
  assert.match(shotImagePrompt(shot), /单幅首帧/)
  assert.match(shotImagePrompt(shot), /躺在床上/)
  assert.doesNotMatch(shotImagePrompt(shot), /站到窗前|接窗外/)
  assert.match(shotVideoPrompt(shot), /连续视频镜头/)
  assert.match(shotVideoPrompt(shot), /站到窗前/)
  assert.match(shotVideoPrompt(shot), /接窗外夜景/)
  assert.equal(shotImagePrompt({ ...shot, image_prompt: '自定义静态构图' }), '自定义静态构图')
  assert.equal(shotVideoPrompt({ ...shot, video_prompt: '自定义动作节奏' }), '自定义动作节奏')
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
  const full = visualGenerationPrompt(base, [binding], ['frame'], 'keyframe')
  assert.match(full, /视频时长：6 秒/)
  assert.match(full, /首帧要求/)
  assert.match(full, /深蓝外套/)
  assert.doesNotMatch(full, /参考图 0|参考图 1/)
  assert.match(visualGenerationPrompt('画面', [binding], ['frame', 'board'], 'profiles'), /参考图 2/)
})
