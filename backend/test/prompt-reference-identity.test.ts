import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePromptReferences, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'

test('legacy numbered descriptions keep their original images after removal and deduplication', () => {
  const input = { prompt: '人物参考图 2，纹理参考图片3。', referenceAssetIds: ['unused', 'hero', 'texture'],
    overrides: { unused: null } }
  const result = resolvePromptReferences(input)
  assert.deepEqual(result.referenceAssetIds, ['hero', 'texture'])
  assert.equal(result.prompt, '人物参考图 1，纹理参考参考图 2。')
  assert.deepEqual(resolvePromptReferences({ ...input, prompt: result.prompt, referenceAssetIds: result.referenceAssetIds }), result)

  const merged = resolvePromptReferences({ prompt: '身份参考图1，服装参考图2，构图参考图3。',
    referenceAssetIds: ['face', 'costume', 'layout'], overrides: { face: 'costume' } })
  assert.deepEqual(merged.referenceAssetIds, ['costume', 'layout'])
  assert.equal(merged.prompt, '身份参考图 1，服装参考图 1，构图参考图 2。')
})

test('stable tokens compile against final order without changing the stored identity', () => {
  const prompt = '人物[[ref:hero]]，构图[[ref:layout]]。'
  assert.equal(resolvePromptReferences({ prompt, referenceAssetIds: ['layout', 'hero'] }).prompt, '人物参考图 2，构图参考图 1。')
  assert.equal(resolvePromptReferences({ prompt, referenceAssetIds: ['hero', 'layout'] }).prompt, '人物参考图 1，构图参考图 2。')
  assert.equal(prompt, '人物[[ref:hero]]，构图[[ref:layout]]。')
})

test('number migration preserves unresolved labels and does not mistake image resolution for a reference', () => {
  assert.equal(tokenizePromptReferenceNumbers('参考图1、99，图片4K，图片1080p', ['hero']),
    '[[ref:hero]]、参考图 99，图片4K，图片1080p')
})

test('bare image labels migrate without matching narrative compounds or partial numbers', () => {
  assert.equal(tokenizePromptReferenceNumbers('图1、2，图 2/图1；按图2的人物。', ['hero', 'layout']),
    '[[ref:hero]]、[[ref:layout]]，[[ref:layout]]/[[ref:hero]]；按[[ref:layout]]的人物。')
  const untouched = '图12 图4K 图1080p 图1.5 地图1 构图1 绘图1 插图1 示意图1 A图1'
  assert.equal(tokenizePromptReferenceNumbers(untouched, ['hero']), untouched)
  assert.equal(tokenizePromptReferenceNumbers('图1、99', ['hero']), '[[ref:hero]]、图 99')
  assert.equal(resolvePromptReferences({ prompt: '图2保持身份，图3作构图', referenceAssetIds: ['unused', 'hero', 'layout'], overrides: { unused: null } }).prompt,
    '参考图 1保持身份，参考图 2作构图')
})

test('missing required identities and malformed IDs are rejected instead of silently omitted', () => {
  assert.throws(() => resolvePromptReferences({ prompt: '', referenceAssetIds: [], requiredAssetIds: ['base'] }), /参考图缺失/)
  assert.throws(() => resolvePromptReferences({ prompt: '', referenceAssetIds: ['invalid id'] }), /标识无效/)
  assert.throws(() => resolvePromptReferences({ prompt: '[[ref:missing', referenceAssetIds: ['hero'] }), /无效/)
})

test('asset IDs matching object property names retain exact replacement identity', () => {
  const overrides = JSON.parse('{"__proto__":"replacement"}')
  const result = resolvePromptReferences({ prompt: '[[ref:__proto__]]', referenceAssetIds: ['__proto__'], overrides })
  assert.deepEqual(result.referenceAssetIds, ['replacement'])
  assert.equal(result.prompt, '参考图 1')
  assert.equal(Object.hasOwn(result.replacements, '__proto__'), true)
  assert.equal(result.replacements.__proto__, 'replacement')
})
