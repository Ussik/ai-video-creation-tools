import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPromptParameterConflicts, synchronizePromptParameters } from '@video-studio/shared/visuals/prompt-parameter-conflicts'

test('only explicit known parameter declarations conflict with actual request fields', () => {
  const prompt = '人物看着16:9海报，谈到8秒前的事。\n画面比例：9:16（宽:高，竖版）。保留我的构图说明。\n视频时长：8 秒，动作完整。\n清晰度要求：720p\n生成模式：reference。'
  const actual = { modality: 'video' as const, ratio: '16:9', duration: 5, resolution: '1080p', mode: 'first_frame' }
  const conflicts = findPromptParameterConflicts(prompt, actual)
  assert.deepEqual(conflicts.map(issue => [issue.field, issue.line]), [['ratio', 2], ['duration', 3], ['clarity', 4], ['mode', 5]])
  const synchronized = synchronizePromptParameters(prompt, actual)
  assert.match(synchronized, /^人物看着16:9海报，谈到8秒前的事。/)
  assert.match(synchronized, /画面比例：16:9（宽:高，横版）。保留我的构图说明。/)
  assert.match(synchronized, /视频时长：5 秒，动作完整。/)
  assert.match(synchronized, /清晰度要求：1080p/)
  assert.match(synchronized, /生成模式：first_frame。/)
  assert.deepEqual(findPromptParameterConflicts(synchronized, actual), [])
})

test('numeric equivalents and native pixel dimensions match selected clarity without guessing unknown prose', () => {
  const prompt = '画面比例：32：18。\n清晰度要求：4K\n输出分辨率：3840×2160\n画质要求：高画质，精细纹理与光影\n背景要求：自动选择适合画面的背景'
  assert.deepEqual(findPromptParameterConflicts(prompt, { modality: 'image', ratio: '16:9', resolution: '3840x2160', quality: 'high', background: 'auto' }), [])
  assert.deepEqual(findPromptParameterConflicts('清晰度要求：4K\n画质要求：精美细腻\n背景要求：海边雾气', { modality: 'image', resolution: 'auto', quality: 'low', background: 'transparent' }), [])
  assert.deepEqual(findPromptParameterConflicts('视频时长：8 秒\n清晰度要求：4K', { modality: 'image', duration: 5 }), [])
})

test('repair preserves markers, references and arbitrary user prose while synchronizing supported values', () => {
  const prompt = '保留[[ref:hero]]的姿态。\n【图片生成要求】\n- 画面比例：9:16\n清晰度要求：2K\n画质要求：低画质，简化细节。\n背景要求：透明背景，仅保留主体，不要绘制棋盘格或实色背景\n自定义参数：不要动\n【图片生成要求结束】'
  const actual = { modality: 'image' as const, ratio: '16:9', clarity: '4K', quality: 'high', background: 'auto' }
  const synchronized = synchronizePromptParameters(prompt, actual)
  assert.match(synchronized, /保留\[\[ref:hero\]\]的姿态/)
  assert.match(synchronized, /【图片生成要求】/)
  assert.match(synchronized, /【图片生成要求结束】/)
  assert.match(synchronized, /自定义参数：不要动/)
  assert.match(synchronized, /画质要求：high。/)
  assert.match(synchronized, /背景要求：auto/)
  assert.deepEqual(findPromptParameterConflicts(synchronized, actual), [])
})

test('an explicit orientation annotation cannot contradict the selected numeric ratio', () => {
  const prompt = '画面比例：16:9（宽:高，竖版）。保留其他说明。'
  const actual = { modality: 'image' as const, ratio: '16:9' }
  assert.equal(findPromptParameterConflicts(prompt, actual).length, 1)
  assert.equal(synchronizePromptParameters(prompt, actual), '画面比例：16:9（宽:高，横版）。保留其他说明。')
})
