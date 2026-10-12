import assert from 'node:assert/strict'
import { test } from 'node:test'
import { synchronizeVideoReferencePrompt, visualGenerationPrompt, type PromptVisualBinding } from '@video-studio/shared/visuals/visual-prompt'
import type { VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'

const reference = (asset_id: string, view: VisualReferenceSnapshot['view'], purpose: VisualReferenceSnapshot['purpose'], label: string): VisualReferenceSnapshot => ({
  id: `${asset_id}-${view}`, asset_id, view, purpose, label, revision: 1, style_version: 'anime',
})
const binding = (profile_id: string, reference_assets: VisualReferenceSnapshot[], overrides: Partial<PromptVisualBinding> = {}): PromptVisualBinding => ({
  profile_id, kind: 'character', name: '林晚', variant: '雨衣', revision: 1, definition: '深绿雨衣，短发', view_requirements: '正侧背',
  board_asset_id: 'legacy-board', required: true, reference_assets, ...overrides,
})
const hero = binding('hero', [reference('face', 'face', 'identity', '锁定面部'), reference('side', 'side', 'costume', '侧面服装')])
const station = binding('station', [reference('reverse', 'reverse', 'space', '窗边反打')], {
  kind: 'location', name: '站台', variant: '夜间', definition: '候车区在右侧', view_requirements: '正反打与布局', board_asset_id: null,
})
const options = { mode: 'reference', storyboard_reference_asset_id: 'shot' }

test('video prompt assigns the actual angle and use of every frozen independent reference', () => {
  const prompt = visualGenerationPrompt('林晚转身，镜头缓慢推近', [station, hero], ['shot', 'side', 'face', 'reverse'], 'profiles', options)
  const mapping = prompt.split('【视频参考图用途】')[1]!
  const lines = mapping.split('\n').filter(line => /^图片\d+：/.test(line))
  assert.equal(lines.length, 4)
  assert.match(lines[0]!, /图片1：分镜构图.*不指定动作起点/)
  assert.match(lines[1]!, /图片2：林晚（雨衣）.*侧面.*侧面服装.*服装款式/)
  assert.doesNotMatch(lines[1]!, /五官/)
  assert.match(lines[2]!, /图片3：林晚（雨衣）.*面部特写.*锁定面部.*五官/)
  assert.match(lines[3]!, /图片4：站台（夜间）.*窗边反打.*位置关系/)
  assert.match(mapping, /空间参考保持位置与视线关系/)
  assert.doesNotMatch(mapping, /legacy-board|图片5/)
})

test('mapping never adds omitted selected images or reverts an independent binding to its unused legacy board', () => {
  const prompt = synchronizeVideoReferencePrompt('只做一次回头', [hero], ['side', 'legacy-board'], 'profiles', { mode: 'reference' })
  const lines = prompt.split('\n').filter(line => /^图片\d+：/.test(line))
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /图片1：林晚.*侧面服装/)
  assert.match(lines[1]!, /图片2：手动参考/)
  assert.doesNotMatch(prompt, /锁定面部|图片3/)
})

test('shared image mapping preserves different selected uses and strips only excluded ownership', () => {
  const optional = binding('optional', [reference('face', 'detail', 'structure', '钥匙齿纹')], {
    kind: 'prop', name: '铜钥匙', variant: '旧铜', required: false, definition: '弯曲铜钥匙',
  })
  const both = visualGenerationPrompt('林晚转身', [optional, hero], ['face'], 'profiles', { mode: 'reference' })
  const mapping = both.split('【视频参考图用途】')[1]!
  assert.match(mapping, /林晚（雨衣）：面部特写.*五官.*铜钥匙（旧铜）：局部细节.*结构/)
  assert.equal((mapping.match(/图片1：/g) || []).length, 1)
  const excluded = visualGenerationPrompt('林晚转身', [optional, hero], ['face'], 'profiles', { mode: 'reference', excluded_visual_profile_ids: ['optional'] })
  assert.doesNotMatch(excluded.split('【视频参考图用途】')[1]!, /铜钥匙|钥匙齿纹|旧铜/)
  assert.match(excluded.split('【视频参考图用途】')[0]!, /弯曲铜钥匙/)
})

test('reference synchronization preserves edited action and context while replacing angle numbering exactly once', () => {
  const prompt = visualGenerationPrompt('林晚转身，镜头推近', [hero], ['face', 'side'], 'profiles', { mode: 'reference' })
  const edited = prompt.replace('镜头推近', '固定机位').replace('深绿雨衣，短发', '湿润的雨衣，保留短发')
  const updated = synchronizeVideoReferencePrompt(edited, [hero], ['side', 'face'], 'profiles', { mode: 'reference' })
  assert.match(updated, /固定机位/)
  assert.match(updated, /湿润的雨衣，保留短发/)
  assert.match(updated, /图片1：林晚.*侧面服装/)
  assert.match(updated, /图片2：林晚.*锁定面部/)
  assert.equal((updated.match(/【视频参考图用途】/g) || []).length, 1)
  assert.equal(synchronizeVideoReferencePrompt(updated, [hero], ['side', 'face'], 'profiles', { mode: 'reference' }), updated)
  for (const mode of ['first_frame', 'first_last_frame']) {
    assert.doesNotMatch(synchronizeVideoReferencePrompt(updated, [hero], ['face'], 'keyframe', { mode }), /【视频参考图用途】/)
  }
})

test('an independent reference shared with a legacy board retains both objects and their distinct uses', () => {
  const legacy = binding('key', [], { kind: 'prop', name: '铜钥匙', variant: '旧铜', board_asset_id: 'face', required: false })
  const prompt = synchronizeVideoReferencePrompt('转身', [hero, legacy], ['face'], 'profiles', { mode: 'reference' })
  const line = prompt.split('\n').find(line => /^图片1：/.test(line))!
  assert.match(line, /林晚（雨衣）：面部特写.*五官/)
  assert.match(line, /铜钥匙（旧铜）：道具外形、尺度、材质与持握细节/)
})

test('image visual context numbers all submitted independent references while keyframe context keeps only text', () => {
  const prompt = visualGenerationPrompt('一幅完整画面', [hero], ['manual', 'face', 'side'], 'profiles')
  assert.match(prompt, /参考图 2、3/)
  assert.doesNotMatch(prompt, /参考图 0/)
  const keyframe = visualGenerationPrompt('连续动作', [hero], ['face', 'side'], 'keyframe', { mode: 'first_last_frame' })
  assert.match(keyframe, /深绿雨衣/)
  assert.doesNotMatch(keyframe, /参考图 \d|【视频参考图用途】/)
})


test('ending and scale overrides replace only managed image uses without rewriting creator actions', () => {
  const draft = '开场林晚站在右侧。随后走向站台，最后坐下。固定机位。'
  const original = visualGenerationPrompt(draft, [hero], ['shot', 'face'], 'profiles', options)
  const updated = synchronizeVideoReferencePrompt(original, [hero], ['shot', 'face'], 'profiles', {
    ...options, video_reference_usages: [{ asset_id: 'shot', usage: 'ending' }, { asset_id: 'face', usage: 'scale' }],
  })
  assert.ok(updated.startsWith(draft))
  const lines = updated.split('\n').filter(line => /^图片\d+：/.test(line))
  assert.match(lines[0]!, /结尾构图.*不提前作为开场.*不是严格尾帧/)
  assert.match(lines[1]!, /只参考.*相对大小.*不继承人物五官/)
  assert.doesNotMatch(lines[1]!, /用于对应对象的身份|锁定面部/)
  assert.match(updated, /图片顺序不代表动作时间顺序/)
  assert.equal((updated.match(/【视频参考图用途】/g) || []).length, 1)
  assert.doesNotMatch(updated, /按此起始状态连续演绎|分镜图用于开镜构图与动作起点/)
})
