import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPromptReferenceIds } from '@video-studio/shared/visuals/prompt-references'
import { stripVisualProfileBaseReference, withVisualProfileBaseReference } from '../src/features/canvas/canvas-profile-reference-prompt'

test('a confirmed base becomes a visible stable reference without changing the editable body', () => {
  const body = '  右手背增加少量泥点。\n保持衣服原色。\n\n'
  const prompt = withVisualProfileBaseReference(body, 'base-board')
  assert.deepEqual(extractPromptReferenceIds(prompt), ['base-board'])
  assert.equal(stripVisualProfileBaseReference(prompt), body)
  assert.equal(withVisualProfileBaseReference(prompt, 'base-board'), prompt)
  assert.equal(withVisualProfileBaseReference('', 'base-board').startsWith('【基础身份参考】'), true)
})

test('an existing manual base mention is preserved and does not gain a duplicate generated block', () => {
  const body = '沿用[[ref:base-board]]的脸型；结合[[ref:lighting]]的冷光，右手背溅泥。'
  assert.equal(withVisualProfileBaseReference(body, 'base-board'), body)
  const generated = withVisualProfileBaseReference('其他细节参考[[ref:lighting]]。', 'base-board')
  const edited = `沿用[[ref:base-board]]的脸型。\n${generated}`
  const result = withVisualProfileBaseReference(edited, 'base-board')
  assert.equal(result, '沿用[[ref:base-board]]的脸型。\n其他细节参考[[ref:lighting]]。')
  assert.deepEqual(extractPromptReferenceIds(result), ['base-board', 'lighting'])
})

test('changing the confirmed base rebases managed context and known base mentions while keeping other manual references', () => {
  const body = ' 保持[[ref:lighting]]光线。\n'
  const initial = withVisualProfileBaseReference(body, 'old-base')
  const next = withVisualProfileBaseReference(initial, 'new-base')
  assert.deepEqual(extractPromptReferenceIds(next), ['lighting', 'new-base'])
  assert.equal(stripVisualProfileBaseReference(next), body)
  assert.equal(next.includes('old-base'), false)
  assert.equal(withVisualProfileBaseReference(next, 'new-base'), next)

  const manual = '脸型来自[[ref:old-base]]，光线来自[[ref:lighting]]，衣服参考[[ref:costume]]。'
  assert.equal(withVisualProfileBaseReference(manual, 'new-base', 'old-base'),
    '脸型来自[[ref:new-base]]，光线来自[[ref:lighting]]，衣服参考[[ref:costume]]。')
})

test('unconfirmed or removed bases never fabricate an image reference or discard user references', () => {
  const body = '右手背溅泥，光线参考[[ref:lighting]]。'
  assert.equal(withVisualProfileBaseReference(body), body)
  assert.equal(withVisualProfileBaseReference(body, null), body)
  assert.equal(withVisualProfileBaseReference(withVisualProfileBaseReference(body, 'old-base'), null), body)
  assert.equal(withVisualProfileBaseReference('保留[[ref:manual]]', null, 'manual'), '保留[[ref:manual]]')
})

test('only exact generated context is managed; edited text and malformed mentions are retained for editor validation', () => {
  const edited = '【基础身份参考】\n这里是用户自己写的设定，不得清除。\n【基础身份参考结束】\n[[ref:incomplete'
  const result = withVisualProfileBaseReference(edited, 'base')
  assert.equal(stripVisualProfileBaseReference(result), edited)
  assert.throws(() => withVisualProfileBaseReference('正文', 'bad id'), /无效/)
})
